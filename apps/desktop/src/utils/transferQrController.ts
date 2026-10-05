/**
 * QR transfer authorisation — the "SENDER shows a QR" half of
 * docs/QR-LINKING.md §3 (`xfer`), factored out the same way
 * `qrSignInController.ts` is: a plain, dependency-injected state machine that
 * `TransferQrPanel.tsx` is a thin view over, testable without mounting React
 * (see that file's header for why — `apps/desktop`'s vitest has no DOM).
 *
 * Much simpler than `link`'s controller because `xfer` genuinely is simpler:
 * the QR carries only a random nonce (no ephemeral key, no main-process IPC,
 * no fingerprint), and the SENDER side never polls — claiming the transfer
 * fires the EXISTING `device:history_request` WS event, which the app's
 * always-on listener (`useRealtime.ts`) turns into `HistoryRequestModal`
 * regardless of whether this panel is still open. So this controller's whole
 * job is: create the session, render the QR, count down, and stop cleanly at
 * either expiry or a manual cancel. docs/QR-LINKING.md §3.5: the id alone is
 * worthless to anyone not already signed into the same account, which is why
 * — unlike `link` — there is no "must be sourced from an IPC-local key"
 * constraint on the QR text here.
 */

export type XferPhase = 'idle' | 'starting' | 'active' | 'expired' | 'error';

export interface XferSnapshot {
    phase: XferPhase;
    qrDataUrl: string | null;
    remainingS: number;
    error: string | null;
}

export interface CreateTransferResult {
    transfer_id: string;
    expires_at: string;
    ttl_s: number;
}

export interface TransferQrDeps {
    /** `POST /v1/link/transfers`, authenticated with the caller's JWT + `x-device-id`. */
    createTransfer: () => Promise<CreateTransferResult>;
    /** Renders a QR data URL LOCALLY — never ask the server for one
     *  (docs/QR-LINKING.md §2.5's reasoning applies to both primitives). */
    renderQr: (text: string) => Promise<string>;
    /** Builds the QR payload string from the transfer id alone. */
    buildQrText: (transferId: string) => string;
    /** QR-6 (adversarial review) — called the moment a QR for this transfer
     *  id actually renders on THIS screen, so `HistoryRequestModal` can later
     *  locally verify a `via: 'qr'` claim instead of trusting it bare. See
     *  `src/utils/recentTransfers.ts`'s header for the full finding. */
    recordOpenedTransfer: (transferId: string) => void;
    countdownTickMs: number;
}

const emptySnapshot: XferSnapshot = { phase: 'idle', qrDataUrl: null, remainingS: 0, error: null };

function describeError(err: unknown): string {
    if (err && typeof err === 'object' && 'isAxiosError' in err) {
        const axErr = err as { response?: { data?: { message?: unknown } } };
        if (!axErr.response) return "Can't reach Cipherline — check your connection and try again.";
        const msg = axErr.response?.data?.message;
        if (typeof msg === 'string' && msg) return msg;
    }
    if (err instanceof Error && err.message) return err.message;
    return 'Something went wrong. Please try again.';
}

export class TransferQrController {
    private snapshot: XferSnapshot = emptySnapshot;
    private listeners = new Set<(s: XferSnapshot) => void>();
    private countdownTimer: ReturnType<typeof setInterval> | null = null;
    private expiresAtMs = 0;
    private disposed = false;
    private readonly deps: TransferQrDeps;

    constructor(deps: TransferQrDeps) {
        this.deps = deps;
    }

    getSnapshot(): XferSnapshot {
        return this.snapshot;
    }

    subscribe(listener: (s: XferSnapshot) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    private set(patch: Partial<XferSnapshot>): void {
        if (this.disposed) return;
        this.snapshot = { ...this.snapshot, ...patch };
        for (const l of this.listeners) l(this.snapshot);
    }

    private clearTimer(): void {
        if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
    }

    /** "Show a code" / "Show a new code" — always starts a fresh transfer id. */
    async begin(): Promise<void> {
        this.clearTimer();
        this.set({ phase: 'starting', error: null, qrDataUrl: null });
        try {
            const created = await this.deps.createTransfer();
            if (this.disposed) return;

            // QR-6: record that THIS device just opened this transfer id,
            // before anything else — this is the local fact
            // `HistoryRequestModal` binds a `via: 'qr'` claim to later.
            this.deps.recordOpenedTransfer(created.transfer_id);

            const qrText = this.deps.buildQrText(created.transfer_id);
            const qrDataUrl = await this.deps.renderQr(qrText);
            if (this.disposed) return;

            this.expiresAtMs = Date.parse(created.expires_at);
            this.set({
                phase: 'active',
                qrDataUrl,
                remainingS: Math.max(0, Math.round((this.expiresAtMs - Date.now()) / 1000)),
                error: null,
            });

            this.countdownTimer = setInterval(() => {
                const remaining = Math.max(0, Math.round((this.expiresAtMs - Date.now()) / 1000));
                this.set({ remainingS: remaining });
                if (remaining <= 0) {
                    // No auto-refresh, same reasoning as the sign-in QR: an
                    // indefinitely-refreshing code on an unattended screen is
                    // a standing invitation to a shoulder-surfer, and it
                    // hides expiry from the user.
                    this.clearTimer();
                    if (!this.disposed) this.set({ phase: 'expired' });
                }
            }, this.deps.countdownTickMs);
        } catch (err) {
            this.clearTimer();
            if (!this.disposed) this.set({ phase: 'error', error: describeError(err), qrDataUrl: null });
        }
    }

    /** Back to idle without starting a new transfer. */
    cancel(): void {
        this.clearTimer();
        if (!this.disposed) this.set({ ...emptySnapshot, phase: 'idle' });
    }

    dispose(): void {
        if (this.disposed) return;
        this.clearTimer();
        this.disposed = true;
    }
}
