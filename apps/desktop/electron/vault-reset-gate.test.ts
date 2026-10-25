import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createVaultGate, VAULT_GATE_DECLINE_COOLDOWN_MS, type VaultGateDeps } from './vault-reset-gate';

function harness(over: Partial<VaultGateDeps> & { state?: 'ok' | 'locked'; corrupt?: boolean; empty?: boolean; approve?: boolean } = {}) {
    let t = 1_000;
    const calls = { reset: 0, recover: [] as string[], confirms: [] as string[] };
    const deps: VaultGateDeps = {
        status: () => over.state ?? 'ok',
        isCorrupt: () => over.corrupt ?? false,
        isEmpty: () => over.empty ?? false,
        confirm: async (kind) => { calls.confirms.push(kind); return over.approve ?? true; },
        factoryReset: () => { calls.reset++; },
        recoverWithKey: (k) => { calls.recover.push(k); return k === 'GOOD'; },
        now: () => t,
        ...over,
    };
    return { gate: createVaultGate(deps), calls, advance: (ms: number) => { t += ms; } };
}

describe('vault-reset-gate — exploit paths refused (E-3)', () => {
    it('factory reset of a HEALTHY keystore is refused without even asking', async () => {
        const h = harness({ state: 'ok' });
        expect(await h.gate.factoryReset()).toEqual({ ok: false, reason: 'healthy' });
        expect(h.calls.reset).toBe(0);
        expect(h.calls.confirms).toEqual([]);
    });

    it('a working master key can never be replaced from the renderer', async () => {
        const h = harness({ state: 'ok', empty: true });
        expect(await h.gate.recoverWithKey('ATTACKER')).toEqual({ ok: false, reason: 'healthy' });
        expect(h.calls.recover).toEqual([]);
    });

    it('factory reset is not performed when the native dialog is declined, and declines cool down', async () => {
        const h = harness({ state: 'locked', approve: false });
        expect(await h.gate.factoryReset()).toEqual({ ok: false, reason: 'declined' });
        expect(h.calls.reset).toBe(0);
        // A scripted retry inside the cooldown does not even reach the dialog.
        expect(await h.gate.factoryReset()).toEqual({ ok: false, reason: 'declined' });
        expect(h.calls.confirms).toHaveLength(1);
        h.advance(VAULT_GATE_DECLINE_COOLDOWN_MS + 1);
        await h.gate.factoryReset();
        expect(h.calls.confirms).toHaveLength(2);
    });

    it('an unverifiable key (empty vault) is not adopted without native confirmation', async () => {
        const h = harness({ corrupt: true, empty: true, approve: false });
        expect(await h.gate.recoverWithKey('ATTACKER')).toEqual({ ok: false, reason: 'declined' });
        expect(h.calls.recover).toEqual([]);
        expect(h.calls.confirms).toEqual(['adopt-unverified-key']);
    });

    it('a dialog that throws is not consent', async () => {
        const h = harness({ state: 'locked', confirm: vi.fn(async () => { throw new Error('no window'); }) });
        expect(await h.gate.factoryReset()).toEqual({ ok: false, reason: 'declined' });
        expect(h.calls.reset).toBe(0);
    });

    it('concurrent requests do not stack dialogs', async () => {
        let release!: (v: boolean) => void;
        const h = harness({ state: 'locked', confirm: () => new Promise<boolean>(r => { release = r; }) });
        const first = h.gate.factoryReset();
        expect(await h.gate.factoryReset()).toEqual({ ok: false, reason: 'busy' });
        release(true);
        expect(await first).toEqual({ ok: true });
    });

    it('rejects malformed keys outright', async () => {
        const h = harness({ state: 'locked' });
        for (const bad of [undefined, 3, '', '   ', 'x'.repeat(300)]) {
            expect(await h.gate.recoverWithKey(bad)).toEqual({ ok: false, reason: 'invalid' });
        }
    });
});

describe('vault-reset-gate — legitimate recovery flows still work', () => {
    it('locked screen: "Start fresh" + confirm resets', async () => {
        const h = harness({ state: 'locked' });
        expect(await h.gate.factoryReset()).toEqual({ ok: true });
        expect(h.calls.reset).toBe(1);
        expect(h.calls.confirms).toEqual(['factory-reset']);
    });

    it('corrupted screen: "Start fresh" + confirm resets', async () => {
        const h = harness({ state: 'ok', corrupt: true, empty: true });
        expect(await h.gate.factoryReset()).toEqual({ ok: true });
    });

    it('locked screen: a key that validates against existing entries unlocks with no extra dialog', async () => {
        const h = harness({ state: 'locked', empty: false });
        expect(await h.gate.recoverWithKey('  GOOD  ')).toEqual({ ok: true });
        expect(h.calls.recover).toEqual(['GOOD']);
        expect(h.calls.confirms).toEqual([]);
    });

    it('locked screen: a wrong key is reported as wrong', async () => {
        const h = harness({ state: 'locked', empty: false });
        expect(await h.gate.recoverWithKey('BAD')).toEqual({ ok: false, reason: 'wrong-key' });
    });

    it('corrupted screen: an unverifiable key is adopted after the user confirms', async () => {
        const h = harness({ state: 'ok', corrupt: true, empty: true });
        expect(await h.gate.recoverWithKey('GOOD')).toEqual({ ok: true });
        expect(h.calls.confirms).toEqual(['adopt-unverified-key']);
    });
});

describe('wiring', () => {
    it('main.ts routes both channels through the gate; the screens stop when main refuses', () => {
        const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
        const body = (ch: string) => main.slice(main.indexOf(`ipcMain.handle('${ch}'`), main.indexOf(`ipcMain.handle('${ch}'`) + 500);
        expect(body('secure:recover-with-key')).toContain('vaultGate.recoverWithKey(');
        expect(body('secure:recover-with-key')).not.toContain('secureStore.recoverWithKey(');
        expect(body('secure:factory-reset')).toContain('vaultGate.factoryReset()');
        expect(body('secure:factory-reset')).not.toContain('secureStore.factoryReset()');
        for (const f of ['StorageLockedScreen.tsx', 'StorageCorruptedScreen.tsx']) {
            const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', f), 'utf8');
            expect(src, f).toMatch(/const reset = await window\.electronAPI\?\.factoryResetSecureStore\?\.\(\);\s*\n\s*if \(reset === false\)/);
        }
    });
});
