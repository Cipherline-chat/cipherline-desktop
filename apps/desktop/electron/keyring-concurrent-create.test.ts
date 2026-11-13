import { describe, it, expect } from 'vitest';
import { parsePendingPrompts, waitForConcurrentCollectionCreate, type BusExec } from './keyring-probe';
import { keyringPreflight, type PreflightDeps } from './keyring-preflight';

/**
 * Two in-process clients each asking GNOME Keyring to create the default keyring
 * (Chromium's async key provider + safeStorage/libsecret): GNOME Keyring completes
 * one prompt and strands the other; when it strands safeStorage's, the app hangs
 * for good (Ubuntu 20.04 / 22.04 / 24.04, staging.213, D-Bus traced 2026-11-09).
 */

// What `busctl --user tree org.freedesktop.secrets` printed on Ubuntu 24.04 with both prompts pending.
const TREE_TWO_PROMPTS = `└─ /org
  └─ /org/freedesktop
    └─ /org/freedesktop/secrets
      ├─ /org/freedesktop/secrets/collection
      │ └─ /org/freedesktop/secrets/collection/session
      ├─ /org/freedesktop/secrets/prompt
      │ ├─ /org/freedesktop/secrets/prompt/p1
      │ └─ /org/freedesktop/secrets/prompt/p2
      └─ /org/freedesktop/secrets/session
`;
const TREE_NONE = `└─ /org/freedesktop/secrets
  ├─ /org/freedesktop/secrets/collection
  │ └─ /org/freedesktop/secrets/collection/session
  └─ /org/freedesktop/secrets/prompt
`;

describe('parsePendingPrompts', () => {
    it('lists the prompt objects (not the /prompt parent)', () => {
        expect(parsePendingPrompts(TREE_TWO_PROMPTS)).toEqual(['/org/freedesktop/secrets/prompt/p1', '/org/freedesktop/secrets/prompt/p2']);
        expect(parsePendingPrompts(TREE_NONE)).toEqual([]);
    });
});

/** A scripted secret service: per poll, whether the default alias exists and which prompts are pending. */
function service(script: Array<{ alias: boolean; prompts: number } | 'down'>) {
    let i = 0;
    const calls: string[] = [];
    const step = () => script[Math.min(i, script.length - 1)];
    const exec: BusExec = async (args) => {
        const s = step();
        calls.push(args.join(' '));
        if (s === 'down') return { ok: false, stdout: '' };
        if (args.includes('ReadAlias')) return { ok: true, stdout: s.alias ? 'o "/org/freedesktop/secrets/collection/Default_5fKeyring"\n' : 'o "/"\n' };
        if (args.includes('tree')) { i++; return { ok: true, stdout: s.prompts ? TREE_TWO_PROMPTS.split('\n').slice(0, 6 + s.prompts).join('\n') : TREE_NONE }; }
        return { ok: false, stdout: '' };
    };
    return { exec, calls };
}
function clock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

describe('waitForConcurrentCollectionCreate', () => {
    it('another prompt is pending, the person answers it: waits, then "created"', async () => {
        const s = service([{ alias: false, prompts: 1 }, { alias: false, prompts: 1 }, { alias: false, prompts: 1 }, { alias: true, prompts: 1 }]);
        expect(await waitForConcurrentCollectionCreate(s.exec, { ...clock(), pollMs: 400 })).toBe('created');
        expect(s.calls.filter((c) => c.includes('ReadAlias')).length).toBe(4);
    });

    it('nobody else is prompting: gives up looking after the grace period (safeStorage then prompts on its own, as before)', async () => {
        const c = clock();
        const s = service([{ alias: false, prompts: 0 }]);
        expect(await waitForConcurrentCollectionCreate(s.exec, { ...c, graceMs: 1500, pollMs: 400 })).toBe('no-other-prompt');
        expect(c.now()).toBeGreaterThanOrEqual(1500);
        expect(c.now()).toBeLessThan(2500);
    });

    it('the other prompt shows up a moment later (async provider still starting): still waited for', async () => {
        const s = service([{ alias: false, prompts: 0 }, { alias: false, prompts: 1 }, { alias: true, prompts: 0 }]);
        expect(await waitForConcurrentCollectionCreate(s.exec, { ...clock(), graceMs: 1500, pollMs: 400 })).toBe('created');
    });

    it('the other prompt is cancelled: "prompt-gone" (safeStorage then asks again itself)', async () => {
        const s = service([{ alias: false, prompts: 1 }, { alias: false, prompts: 0 }]);
        expect(await waitForConcurrentCollectionCreate(s.exec, clock())).toBe('prompt-gone');
    });

    it('the keyring already exists: returns at once, no tree listing', async () => {
        const s = service([{ alias: true, prompts: 0 }]);
        expect(await waitForConcurrentCollectionCreate(s.exec, clock())).toBe('no-other-prompt');
        expect(s.calls.some((c) => c.includes('tree'))).toBe(false);
    });

    it('busctl / the service unavailable: behaves as before (no wait)', async () => {
        const c = clock();
        expect(await waitForConcurrentCollectionCreate(service(['down']).exec, c)).toBe('no-other-prompt');
        expect(c.now()).toBe(0);
    });

    it('a prompt left pending for ever: bounded ("timeout"), the launch goes on', async () => {
        const c = clock();
        const s = service([{ alias: false, prompts: 1 }]);
        expect(await waitForConcurrentCollectionCreate(s.exec, { ...c, maxMs: 10_000, pollMs: 400 })).toBe('timeout');
        expect(c.now()).toBeGreaterThanOrEqual(10_000);
    });
});

describe('keyringPreflight: waits for the other creator only when GNOME Keyring has no keyring', () => {
    const SS_NO_WALLET: BusExec = async (args) => (args.includes('ReadAlias') ? { ok: true, stdout: 'o "/"\n' } : { ok: false, stdout: '' });
    const SS_UNLOCKED: BusExec = async (args) => {
        if (args.includes('ReadAlias')) return { ok: true, stdout: 'o "/org/freedesktop/secrets/collection/login"\n' };
        if (args.includes('get-property')) return { ok: true, stdout: 'b false\n' };
        return { ok: false, stdout: '' };
    };
    function deps(exec: BusExec, order: string[]): PreflightDeps {
        return {
            exec,
            showNotice: async (_b, o) => { order.push(`notice:${o.mode}`); return () => order.push('dispose'); },
            legacyShouldAnnounce: () => false,
            appId: 'Cipherline',
            waitForCollection: async () => { order.push('wait'); return 'created'; },
        };
    }

    it('no keyring (gnome_libsecret): notice ON SCREEN first, then the wait, then return (caller calls safeStorage)', async () => {
        const order: string[] = [];
        const h = await keyringPreflight('gnome_libsecret', deps(SS_NO_WALLET, order));
        expect(order).toEqual(['notice:create', 'wait']);
        h?.dispose?.();
        expect(order.at(-1)).toBe('dispose');
    });

    it('control: an unlocked keyring shows nothing and waits for nothing', async () => {
        const order: string[] = [];
        expect(await keyringPreflight('gnome_libsecret', deps(SS_UNLOCKED, order))).toBeUndefined();
        expect(order).toEqual([]);
    });

    it('control: KWallet never takes the Secret Service wait', async () => {
        const order: string[] = [];
        const kwLocked: BusExec = async (args) => {
            const m = args[5];
            if (m === 'isEnabled') return { ok: true, stdout: 'b true\n' };
            if (m === 'wallets') return { ok: true, stdout: 'as 1 "kdewallet"\n' };
            if (m === 'networkWallet') return { ok: true, stdout: 's "kdewallet"\n' };
            if (m === 'isOpen') return { ok: true, stdout: 'b false\n' };
            return { ok: false, stdout: '' };
        };
        await keyringPreflight('kwallet6', deps(kwLocked, order));
        expect(order).not.toContain('wait');
    });
});
