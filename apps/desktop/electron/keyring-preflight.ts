import {
    createKWallet, decideKeyringPlan, probeWallet, serviceForBackend, waitForConcurrentCollectionCreate,
    type CollectionWaitResult,
    type BusExec, type NoticeMode, type OpenWalletResult, type WalletProbe,
} from './keyring-probe';

/**
 * Everything that happens between "the key store is about to call safeStorage
 * on Linux" and "it does". Orchestration only; the decisions are in
 * keyring-probe.ts and the window is in keyring-notice.ts, both injected here
 * so the ORDER (probe, then notice on screen, then, and only then, the blocking
 * call) is testable with fakes.
 *
 * What the key store gets back:
 *   - `dispose`  take the notice down (called the moment safeStorage returns,
 *                or at once when it is not going to be called);
 *   - `refused`  the person cancelled the wallet-creation wizard KDE showed us.
 *                The key store must NOT call safeStorage and must treat the
 *                wallet as denied: first run = locked with nothing written, an
 *                existing key = locked and left byte-for-byte as it was. Never a
 *                plaintext key.
 *
 * Linux only: SecureStore never calls this on Windows / macOS.
 */

export interface PreflightHandle {
    dispose?: () => void;
    refused?: boolean;
}

export interface PreflightDeps {
    exec: BusExec;
    /** Put the notice up and resolve once it is actually on screen. `delayed` = legacy 400 ms reveal. */
    showNotice: (backend: string, opts: { mode: NoticeMode; delayed: boolean }) => Promise<() => void>;
    /** The legacy gate (keyring-marker.ts): has this boot's wallet already answered? */
    legacyShouldAnnounce: () => boolean;
    /** The appid Chromium uses for the wallet, so KDE sees one application. */
    appId: string;
    /** Test seam: the Secret Service "someone else is creating the keyring" wait (keyring-probe.ts). */
    waitForCollection?: (exec: BusExec) => Promise<CollectionWaitResult>;
    log?: (msg: string) => void;
}

export async function keyringPreflight(backend: string, deps: PreflightDeps): Promise<PreflightHandle | undefined> {
    const log = deps.log ?? (() => { /* quiet */ });
    const svc = serviceForBackend(backend);
    let probe: WalletProbe;
    const t0 = Date.now();
    try {
        probe = await probeWallet(backend, deps.exec);
    } catch {
        probe = { kind: 'unknown' };
    }
    const plan = decideKeyringPlan(svc, probe);
    log(`[keyring] probe=${probe.kind} plan=${plan.action} in ${Date.now() - t0} ms`);

    switch (plan.action) {
        case 'none':
            return undefined;

        case 'legacy': {
            // Could not tell. Previous behaviour: announce once per boot, with
            // the page's own 400 ms reveal; a probe that only timed out (a
            // daemon still starting) shows it at once.
            if (!deps.legacyShouldAnnounce()) return undefined;
            return { dispose: await deps.showNotice(backend, { mode: 'unlock', delayed: !plan.immediate }) };
        }

        case 'notice-first': {
            // A prompt is certain: no delay, and the notice is on screen (the
            // promise resolves only then) before the caller blocks the thread.
            const dispose = await deps.showNotice(backend, { mode: plan.mode, delayed: false });
            if (svc?.service === 'secret-service' && plan.mode === 'create') {
                // No keyring yet: Chromium's own key provider may already be
                // creating it. Let that one prompt finish before safeStorage asks
                // too, or GNOME Keyring strands one of the two and, when it is
                // safeStorage's, the app never gets past this call
                // (waitForConcurrentCollectionCreate explains the measurement).
                const t1 = Date.now();
                let r: CollectionWaitResult;
                try {
                    r = await (deps.waitForCollection ?? ((e) => waitForConcurrentCollectionCreate(e)))(deps.exec);
                } catch {
                    r = 'no-other-prompt';
                }
                log(`[keyring] keyring creation by another client: ${r} after ${Date.now() - t1} ms`);
            }
            return { dispose };
        }

        case 'create-wallet': {
            const dispose = await deps.showNotice(backend, { mode: 'create', delayed: false });
            if (svc?.service !== 'kwallet') return { dispose };
            // Asynchronous for us, so the notice keeps painting under KDE's wizard.
            let result: OpenWalletResult;
            try {
                result = await createKWallet(svc, plan.walletName, deps.appId, deps.exec);
            } catch {
                result = 'failed';
            }
            log(`[keyring] create-wallet result=${result}`);
            // 'cancelled' is the person's answer: refuse, write nothing. 'failed'
            // (an error, not a no) keeps the previous behaviour: let safeStorage
            // run and classify as it always did.
            return result === 'cancelled' ? { dispose, refused: true } : { dispose };
        }
    }
}
