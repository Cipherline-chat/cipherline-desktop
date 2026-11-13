import { describe, it, expect } from 'vitest';
import { startWalletWatcher, shouldWatchWallet, AUTO_RETRY_ARG } from './keyring-autoretry';
import { classifyKeyringOutcome } from './keyring-prompt';
import { relaunchOptions } from './keyring-ipc';
import type { WalletProbe } from './keyring-probe';

function harness(probes: WalletProbe[], opts: { locked?: () => boolean; maxMs?: number } = {}) {
    let t = 0; let pending: (() => void) | null = null; let relaunches = 0; let i = 0;
    const w = startWalletWatcher({
        probe: async () => probes[Math.min(i++, probes.length - 1)],
        onUnlocked: () => { relaunches++; },
        stillLocked: opts.locked ?? (() => true),
        setTimer: (fn) => { pending = fn; return 1; },
        clearTimer: () => { pending = null; },
        now: () => t, pollMs: 3000, maxMs: opts.maxMs ?? 60_000,
    });
    const step = async () => { const fn = pending; pending = null; t += 3000; fn?.(); await new Promise(r => setTimeout(r, 0)); };
    return { w, step, relaunches: () => relaunches, hasTimer: () => pending !== null };
}

describe('wallet watcher', () => {
    it('a 25 s ignored prompt classifies as denied (the case this recovers)', () => {
        expect(classifyKeyringOutcome({ platform: 'linux', backend: 'kwallet6', encryptionAvailable: false, firstCallMs: 25_000 })).toBe('denied');
    });
    it('relaunches exactly once when the wallet becomes unlocked, and stops', async () => {
        const h = harness([{ kind: 'locked' }, { kind: 'locked' }, { kind: 'unlocked' }]);
        await h.step(); await h.step(); expect(h.relaunches()).toBe(0);
        await h.step(); expect(h.relaunches()).toBe(1);
        expect(h.w.active()).toBe(false); expect(h.hasTimer()).toBe(false);
    });
    it('positive control: a wallet that never opens never relaunches', async () => {
        const h = harness([{ kind: 'locked' }]);
        for (let n = 0; n < 5; n++) await h.step();
        expect(h.relaunches()).toBe(0); expect(h.w.active()).toBe(true);
    });
    it('does not relaunch if the store was recovered another way in the meantime', async () => {
        let locked = true;
        const h = harness([{ kind: 'unlocked' }], { locked: () => locked });
        locked = false; await h.step();
        expect(h.relaunches()).toBe(0); expect(h.w.active()).toBe(false);
    });
    it('gives up after maxMs; stop() cancels', async () => {
        const h = harness([{ kind: 'unknown' }], { maxMs: 6000 });
        await h.step(); await h.step(); await h.step();
        expect(h.w.active()).toBe(false);
        const h2 = harness([{ kind: 'locked' }]); h2.w.stop(); expect(h2.hasTimer()).toBe(false);
    });
    it('a probe that throws is just "unknown"', async () => {
        let n = 0; let t = 0; let timer: (() => void) | null = null; let fired = 0;
        startWalletWatcher({
            probe: async () => { if (n++ === 0) throw new Error('boom'); return { kind: 'unlocked' } as WalletProbe; },
            onUnlocked: () => { fired++; }, stillLocked: () => true,
            setTimer: (fn) => { timer = fn; return 1; }, clearTimer: () => undefined, now: () => (t += 1),
        });
        timer!(); await new Promise(r => setTimeout(r, 0)); timer!(); await new Promise(r => setTimeout(r, 0));
        expect(fired).toBe(1);
    });
});

describe('shouldWatchWallet (loop guard + zero-risk scope)', () => {
    const base = { platform: 'linux', keyringState: 'denied', storeStatus: 'locked', argv: ['x'] } as const;
    it('watches a locked, denied Linux store', () => expect(shouldWatchWallet(base)).toBe(true));
    it('also a no-service start (daemon still booting)', () => expect(shouldWatchWallet({ ...base, keyringState: 'no-service' })).toBe(true));
    it('NOT after an automatic relaunch (no restart loop)', () => expect(shouldWatchWallet({ ...base, argv: ['x', AUTO_RETRY_ARG] })).toBe(false));
    it('NOT for a usable (degraded) session, other platforms, or an unlocked wallet', () => {
        expect(shouldWatchWallet({ ...base, storeStatus: 'ok' })).toBe(false);
        expect(shouldWatchWallet({ ...base, platform: 'win32' })).toBe(false);
        expect(shouldWatchWallet({ ...base, keyringState: 'unlocked' })).toBe(false);
    });
    it('relaunchOptions: auto adds the flag, a manual retry strips it', () => {
        expect(relaunchOptions({}, ['n', 'a'], [AUTO_RETRY_ARG]).args).toEqual(['a', AUTO_RETRY_ARG]);
        expect(relaunchOptions({}, ['n', 'a', AUTO_RETRY_ARG]).args).toEqual(['a']);
    });
});
