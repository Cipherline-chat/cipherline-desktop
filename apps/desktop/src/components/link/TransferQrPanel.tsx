import React, { useEffect, useRef } from 'react';
import axios from 'axios';
import QRCode from 'qrcode';
import { QrCode as QrCodeIcon, Loader2, AlertTriangle, ShieldCheck } from 'lucide-react';
import { API_BASE } from '../../constants';
import { useAuth } from '../../contexts/AuthContext';
import { buildXferQr } from '../../utils/linkQr';
import { recordOpenedTransfer } from '../../utils/recentTransfers';
import { formatCountdown } from '../../utils/formatCountdown';
import { ClButton } from '../ClButton';
import {
    TransferQrController, type TransferQrDeps, type XferSnapshot, type CreateTransferResult,
} from '../../utils/transferQrController';
import { useLinkController } from './useLinkController';

/**
 * QR transfer authorisation — the SENDER's half of docs/QR-LINKING.md §3
 * (`xfer`): "already signed in on desktop, install mobile, scan a QR with the
 * phone, transfer data desktop → phone." Settings → Storage → "Transfer data".
 *
 * Unlike `QrSignInPanel`, this QR carries only a random nonce — no key, no
 * token — because both devices are already authenticated on the account
 * (§3.1). Scanning it does not, by itself, send anything: it fires the
 * EXISTING `device:history_request` event, which opens THIS device's
 * `HistoryRequestModal` (the same one manual history-sync already uses) for
 * an explicit confirm. This panel never listens for that event itself — it
 * has nothing further to do once the QR is up besides count down.
 *
 * State machinery lives in `../../utils/transferQrController.ts`, a plain
 * dependency-injected module — see that file and `QrSignInPanel.tsx`'s header
 * for why the split exists (this app's vitest suite has no DOM).
 */

const COUNTDOWN_TICK_MS = 250;

/**
 * `getAuth` is a live getter, not a snapshot — this panel's controller is
 * built ONCE per mount (`useLinkController`, shared with `QrSignInPanel.tsx`),
 * but Settings can
 * plausibly stay open long enough to cross a token refresh, unlike the
 * sign-in screen. Capturing `token`/`deviceId` by value at construction time
 * would freeze the header on whatever was current the moment the pane first
 * mounted; reading them through a ref that every render refreshes keeps
 * `createTransfer` using whatever is current when the user actually clicks.
 */
function realDeps(getAuth: () => { token: string | null; deviceId: string | null }): TransferQrDeps {
    return {
        createTransfer: async (): Promise<CreateTransferResult> => {
            const { token, deviceId } = getAuth();
            const res = await axios.post<CreateTransferResult>(
                `${API_BASE}/link/transfers`, {},
                { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId ?? '' } },
            );
            return res.data;
        },
        renderQr: (text: string) => QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width: 256 }),
        // No key material in this QR (docs/QR-LINKING.md §3.2/§3.5) — the
        // transfer id alone, exactly as the server issued it.
        buildQrText: buildXferQr,
        // QR-6 — see recentTransfers.ts's header for why this exists.
        recordOpenedTransfer,
        countdownTickMs: COUNTDOWN_TICK_MS,
    };
}

const emptySnapshot: XferSnapshot = { phase: 'idle', qrDataUrl: null, remainingS: 0, error: null };

export const TransferQrPanel: React.FC = () => {
    const { token, deviceId } = useAuth();
    const authRef = useRef({ token, deviceId });
    useEffect(() => { authRef.current = { token, deviceId }; });
    // One controller per MOUNT — see useLinkController for why building it
    // during render left every dev build (React StrictMode) with a dead
    // "Show a code" button.
    const { snapshot: snap, controllerRef } = useLinkController<XferSnapshot, TransferQrController>(
        () => new TransferQrController(realDeps(() => authRef.current)),
        emptySnapshot,
    );

    const { phase } = snap;

    return (
        <div className="sd-card overflow-hidden" style={{ padding: 0 }}>
            {/* Header — matches BackupSection.tsx's pattern (CLAUDE.md: match
                the surrounding settings style, don't invent visual language). */}
            <div className="flex items-start gap-3.5 p-5 pb-4">
                <span className="sd-tile"><QrCodeIcon size={17} /></span>
                <div className="min-w-0">
                    <h3 className="text-[16px] leading-tight" style={{ color: 'var(--cl-text)', fontFamily: 'var(--cl-font-display)', fontWeight: 500, margin: 0 }}>
                        Transfer data
                    </h3>
                    <p className="text-[12.5px] leading-relaxed mt-1" style={{ color: 'var(--cl-faint)' }}>
                        Show a code and scan it with Cipherline on another signed-in device to send
                        your message history to it. Scanning alone sends nothing — you'll be asked
                        here to confirm exactly what gets sent before anything moves.
                    </p>
                </div>
            </div>

            <div className="px-5 pb-5">
                {phase === 'idle' && (
                    <ClButton onClick={() => void controllerRef.current?.begin()}>Show a code</ClButton>
                )}

                {phase === 'starting' && (
                    <div className="flex items-center gap-2.5 py-2">
                        <Loader2 className="animate-spin" size={18} style={{ color: 'var(--cl-lume)' }} />
                        <span className="text-[13px]" style={{ color: 'var(--cl-faint)' }}>Preparing your code…</span>
                    </div>
                )}

                {(phase === 'expired' || phase === 'error') && (
                    <div className="flex flex-col items-start gap-2.5 py-1">
                        <div className="flex items-center gap-2">
                            <AlertTriangle size={16} style={{ color: phase === 'error' ? 'var(--cl-flash)' : 'var(--cl-faint)' }} />
                            <span className="text-[13px] font-medium" style={{ color: 'var(--cl-text)' }}>
                                {phase === 'expired' ? 'This code expired' : 'Could not create a code'}
                            </span>
                        </div>
                        {phase === 'error' && snap.error && (
                            <p className="text-[12px] m-0" style={{ color: 'var(--cl-faint)' }}>{snap.error}</p>
                        )}
                        <ClButton onClick={() => void controllerRef.current?.begin()}>Show a new code</ClButton>
                    </div>
                )}

                {phase === 'active' && snap.qrDataUrl && (
                    <div className="flex flex-col items-start gap-3">
                        <div
                            className="flex items-center justify-center rounded-2xl overflow-hidden"
                            style={{ width: 180, height: 180, background: '#FFFFFF' }}
                        >
                            <img src={snap.qrDataUrl} alt="Scan with Cipherline on your other device to receive your data" width={180} height={180} />
                        </div>
                        <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--cl-faint)' }} role="status" aria-live="polite">
                            <ShieldCheck size={13} />
                            <span>Code expires in {formatCountdown(snap.remainingS)}</span>
                        </div>
                        <button
                            type="button"
                            onClick={() => controllerRef.current?.cancel()}
                            className="text-[13px] transition-colors"
                            style={{ color: 'var(--cl-faint)' }}
                        >
                            Cancel
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default TransferQrPanel;
