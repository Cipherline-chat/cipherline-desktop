import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createRecoveryKeyGate, DECLINE_COOLDOWN_MS, type RecoveryKeyGateDeps } from './recovery-key-gate';

/**
 * `secure:reveal-recovery-key` handed the device master key to anyone who
 * asked on the channel. The sender guard proves the caller is our renderer;
 * it cannot prove the renderer is still ours. So attacker code in the window
 * could call it and walk away with the key that unwraps the Signal identity,
 * every prekey, every channel and avatar key, the renderer's whole encrypted
 * IndexedDB store (via HKDF(master, userId)) and every backup container the
 * device has written — a key that never rotates and never expires.
 *
 * The control is a main-process confirmation, because a human choosing a
 * non-default button is the one signal renderer code cannot manufacture.
 * These tests hold that line from both sides: the key must not cross the
 * bridge without an approval, and it must still cross when there is one.
 */

const KEY = 'bWFzdGVyLWtleS1ieXRlcy0zMi1ieXRlcy1sb25nISE=';

/** Note the spread order and what is handed back: the returned spies are the
 *  ones the gate actually received, overrides included. Returning the
 *  defaults instead makes `expect(confirm).not.toHaveBeenCalled()` assert
 *  against a function nothing was ever wired to — a test that passes no
 *  matter what the gate does. */
function gate(over: Partial<RecoveryKeyGateDeps> = {}) {
    const deps: RecoveryKeyGateDeps = {
        isLocked: vi.fn(() => false),
        getMasterKeyB64: vi.fn(() => KEY as string | null),
        confirm: vi.fn(async () => true),
        ...over,
    };
    return {
        reveal: createRecoveryKeyGate(deps),
        getMasterKeyB64: deps.getMasterKeyB64 as ReturnType<typeof vi.fn>,
        confirm: deps.confirm as ReturnType<typeof vi.fn>,
        isLocked: deps.isLocked as ReturnType<typeof vi.fn>,
        deps,
    };
}

describe('recovery-key reveal — the confirmation is load-bearing', () => {
    it('refuses the key when the human declines', async () => {
        const g = gate({ confirm: vi.fn(async () => false) });
        const res = await g.reveal();
        expect(res).toEqual({ ok: false, reason: 'declined' });
        // Not merely withheld from the result — never read out of the
        // keystore at all, so no later bug can leak what was never fetched.
        expect(g.getMasterKeyB64).not.toHaveBeenCalled();
    });

    it('returns the key when the human approves', async () => {
        const g = gate();
        await expect(g.reveal()).resolves.toEqual({ ok: true, keyB64: KEY });
        expect(g.confirm).toHaveBeenCalledTimes(1);
    });

    it('asks every single time — approving once does not buy a second reveal', async () => {
        const g = gate();
        await g.reveal();
        await g.reveal();
        expect(g.confirm).toHaveBeenCalledTimes(2);
    });

    it('fails closed when the dialog itself throws', async () => {
        // A confirmation that could not be shown is not a confirmation.
        const g = gate({ confirm: vi.fn(async () => { throw new Error('no window'); }) });
        await expect(g.reveal()).resolves.toEqual({ ok: false, reason: 'declined' });
        expect(g.getMasterKeyB64).not.toHaveBeenCalled();
    });

    it('does not prompt at all when the keystore is locked', async () => {
        const g = gate({ isLocked: vi.fn(() => true) });
        await expect(g.reveal()).resolves.toEqual({ ok: false, reason: 'locked' });
        expect(g.confirm).not.toHaveBeenCalled();
    });

    it('reports locked, not ok, if the key vanishes after approval', async () => {
        const g = gate({ getMasterKeyB64: vi.fn(() => null) });
        await expect(g.reveal()).resolves.toEqual({ ok: false, reason: 'locked' });
    });
});

describe('recovery-key reveal — dialog fatigue is bounded', () => {
    it('drops concurrent requests instead of stacking dialogs', async () => {
        // Without this, attacker code fires N invokes and the user faces a
        // queue of N identical prompts — the shape that wears people down.
        let release!: (v: boolean) => void;
        const confirm = vi.fn(() => new Promise<boolean>(r => { release = r; }));
        const g = gate({ confirm });

        const first = g.reveal();
        const second = await g.reveal();
        expect(second).toEqual({ ok: false, reason: 'busy' });
        expect(confirm).toHaveBeenCalledTimes(1);

        release(true);
        await expect(first).resolves.toEqual({ ok: true, keyB64: KEY });
    });

    it('a decline silences further prompts for the cooldown, then allows a retry', async () => {
        let t = 1_000;
        const confirm = vi.fn(async () => false);
        const g = gate({ confirm, now: () => t });

        expect(await g.reveal()).toEqual({ ok: false, reason: 'declined' });
        expect(confirm).toHaveBeenCalledTimes(1);

        // Scripted retry during the cooldown: refused without bothering the user.
        t += DECLINE_COOLDOWN_MS - 1;
        expect(await g.reveal()).toEqual({ ok: false, reason: 'declined' });
        expect(confirm).toHaveBeenCalledTimes(1);

        // A user who mis-clicked Cancel is not locked out forever: once the
        // cooldown lapses the prompt is shown again, and approving works.
        t += 2;
        confirm.mockResolvedValue(true);
        expect(await g.reveal()).toEqual({ ok: true, keyB64: KEY });
        expect(confirm).toHaveBeenCalledTimes(2);
    });

    it('the cooldown never blocks a reveal the user approved', async () => {
        let t = 0;
        const g = gate({ now: () => t });
        await expect(g.reveal()).resolves.toEqual({ ok: true, keyB64: KEY });
        t += 1;
        await expect(g.reveal()).resolves.toEqual({ ok: true, keyB64: KEY });
    });
});

describe('recovery-key reveal — the shipped code actually uses the gate', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const mainSrc = readFileSync(path.join(here, 'main.ts'), 'utf8');
    const preloadSrc = readFileSync(path.join(here, 'preload.ts'), 'utf8');
    const srcDir = path.join(here, '..', 'src');

    function handlerBody(channel: string): string | null {
        const at = mainSrc.indexOf(`ipcMain.handle('${channel}'`);
        if (at < 0) return null;
        const end = mainSrc.indexOf('\n  });', at);
        return mainSrc.slice(at, end);
    }

    it('the handler delegates to the gate and never reads the key itself', () => {
        const body = handlerBody('secure:reveal-recovery-key');
        expect(body, 'reveal handler missing').toBeTruthy();
        expect(body).toContain('revealRecoveryKeyGated');
        // The pre-fix body, verbatim. If this ever comes back, the dialog is
        // bypassed and every test above still passes — so assert its absence.
        expect(body).not.toContain('secureStore.getMasterKeyB64()');
        expect(mainSrc).toContain('createRecoveryKeyGate');
    });

    it('the confirmation defaults to Cancel', () => {
        // A dialog whose default button approves is answerable by a stray
        // Enter, which renderer code can arrange around.
        const at = mainSrc.indexOf('createRecoveryKeyGate');
        const wiring = mainSrc.slice(at, mainSrc.indexOf('ipcMain.handle(\'secure:reveal-recovery-key\'', at));
        expect(wiring).toContain('defaultId: 0');
        expect(wiring).toContain('cancelId: 0');
        expect(wiring).toMatch(/buttons:\s*\['Cancel',/);
        expect(wiring).toContain('response === 1');
    });

    it('the master key is read in main in exactly three places, and reaches the renderer from one', () => {
        // Mirrors secureStorePolicy.test.ts. The gate must not have quietly
        // added a third route while closing the second.
        expect(mainSrc.match(/getMasterKeyB64\(\)/g) ?? []).toHaveLength(3);
    });

    it('RecoveryKeyCard.tsx (Settings) does not bypass the gate by reading a bare key off the channel', () => {
        // The channel returns a discriminated result now. A consumer that
        // still treats it as `string | null` would read the {ok:false} object
        // as truthy and print "[object Object]" as the recovery key.
        const src = readFileSync(path.join(srcDir, 'components/RecoveryKeyCard.tsx'), 'utf8');
        expect(src, 'must branch on the result').toMatch(/revealRecoveryKey\?\.\(\)/);
        expect(src, 'must read keyB64').toContain('res.keyB64');
        expect(preloadSrc).toContain('secure:reveal-recovery-key');
    });

    it('there is NO ungated reveal channel any more (the signup carve-out was removed with the wizard step)', () => {
        // 2026-09-20 to 2026-10-05 the registration wizard revealed the key on
        // mount through `secure:reveal-recovery-key-signup`, with no dialog.
        // Onboarding round 6 dropped the wizard's recovery-key step, so the
        // channel was deleted — see the UPDATE notice at the top of
        // recovery-key-gate.ts. Pin that it stays gone: in main, in preload,
        // and in every renderer caller.
        expect(mainSrc).not.toContain('reveal-recovery-key-signup');
        expect(preloadSrc).not.toContain('reveal-recovery-key-signup');
        expect(preloadSrc).not.toContain('revealRecoveryKeySignup');
        // Exactly one reveal handler, and it is the gated one.
        expect(mainSrc.match(/ipcMain\.handle\('secure:reveal-recovery-key/g) ?? []).toHaveLength(1);
        const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
            e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);
        const callers = walk(srcDir).filter(f => readFileSync(f, 'utf8').includes('revealRecoveryKeySignup'));
        expect(callers, 'no renderer code may call the removed ungated channel').toEqual([]);
    });
});
