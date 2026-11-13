/**
 * Reopen by itself once the system wallet is unlocked.
 *
 * The case: KWallet's prompt was not answered within Chromium's 25 s D-Bus
 * deadline (or the wallet daemon was still starting), `safeStorage` said no, and
 * Chromium caches that for the life of the process. The wallet dialog is often
 * still on screen, and the person answers it a moment too late. The store stays
 * locked even though the wallet is now open. An in-process retry is impossible
 * (the cached refusal), so the recovery is a relaunch, and this decides when.
 *
 * It only ever LOOKS: the same read-only, non-prompting probe the launch uses
 * (keyring-probe.ts), every `pollMs`. It never opens the wallet, never touches
 * the store, never writes. When the probe first says `unlocked` it calls
 * `onUnlocked` once and stops. Loop guard: the relaunched process carries
 * `AUTO_RETRY_ARG`; a process that has it never auto-retries again, so a wallet
 * that reports open while safeStorage still fails cannot make the app restart
 * forever (the manual "Try again" still works).
 *
 * Pure: the probe, timers and relaunch are injected. No `electron` import.
 */
import type { WalletProbe } from './keyring-probe';

export const AUTO_RETRY_ARG = '--keyring-auto-retry';
export const AUTO_RETRY_POLL_MS = 3_000;
/** Give up watching after this long; a wallet nobody opens in half an hour is not coming. */
export const AUTO_RETRY_MAX_MS = 30 * 60_000;

/** Only a LOCKED store (nothing running, nothing to lose) is auto-relaunched; a degraded session gets the banner. */
export function shouldWatchWallet(input: {
    platform: string;
    keyringState: 'not-applicable' | 'unlocked' | 'denied' | 'no-service';
    storeStatus: 'uninitialized' | 'ok' | 'locked';
    argv: readonly string[];
}): boolean {
    return input.platform === 'linux'
        && (input.keyringState === 'denied' || input.keyringState === 'no-service')
        && input.storeStatus === 'locked'
        && !input.argv.includes(AUTO_RETRY_ARG);
}

export interface WalletWatcherDeps {
    probe: () => Promise<WalletProbe>;
    onUnlocked: () => void;
    /** Re-checked before acting: the person may have recovered some other way meanwhile. */
    stillLocked: () => boolean;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (h: unknown) => void;
    now?: () => number;
    pollMs?: number;
    maxMs?: number;
}

export interface WalletWatcher { stop(): void; active(): boolean }

export function startWalletWatcher(deps: WalletWatcherDeps): WalletWatcher {
    const setT = deps.setTimer ?? ((fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; });
    const clearT = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    const now = deps.now ?? Date.now;
    const pollMs = deps.pollMs ?? AUTO_RETRY_POLL_MS;
    const maxMs = deps.maxMs ?? AUTO_RETRY_MAX_MS;
    const started = now();
    let handle: unknown = null;
    let running = true;

    const tick = async (): Promise<void> => {
        handle = null;
        if (!running) return;
        let p: WalletProbe;
        try { p = await deps.probe(); } catch { p = { kind: 'unknown' }; }
        if (!running) return;
        if (p.kind === 'unlocked' && deps.stillLocked()) {
            running = false;
            deps.onUnlocked();
            return;
        }
        if (now() - started >= maxMs || !deps.stillLocked()) { running = false; return; }
        handle = setT(() => { void tick(); }, pollMs);
    };

    handle = setT(() => { void tick(); }, pollMs);
    return {
        stop() { running = false; if (handle !== null) clearT(handle); handle = null; },
        active: () => running,
    };
}
