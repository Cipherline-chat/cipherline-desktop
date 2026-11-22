/**
 * AgeGatePane - the full-pane gate shown in place of an age-restricted channel
 * until this ACCOUNT has confirmed it is 18 or older.
 *
 * Like Discord's NSFW gate this is a self-attestation, not a verification, and
 * we store only that it happened (one timestamp on the account, so every device
 * agrees) - never a date of birth. While this is showing, the channel's history
 * is not fetched, decrypted, previewed or notified (Dashboard.getChannelRows /
 * handleChannelMessage), and the API refuses it anyway.
 *
 * Keyboard: focus starts on "Go back" (the safe answer is never the one a stray
 * Enter lands on); Tab reaches "I'm 18 or older"; Escape goes back.
 */
import React, { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { ClButton } from '../cl';
import { useEscape } from '../../hooks/useEscape';

interface Props {
    channelName: string;
    /** Resolves when the account is confirmed; rejects with an Error whose
     *  message is shown (and the button offers a retry). */
    onConfirm: () => Promise<void>;
    onBack: () => void;
}

export const AgeGatePane: React.FC<Props> = ({ channelName, onConfirm, onBack }) => {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEscape(() => { if (!busy) onBack(); });

    const confirm = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            await onConfirm();
        } catch (e) {
            setError(e instanceof Error && e.message ? e.message : "Couldn't save that. Check your connection and try again.");
            setBusy(false);
        }
    };

    return (
        <div
            className="flex-1 min-h-0 flex items-center justify-center px-6 py-8 overflow-y-auto bg-cl-deep"
            role="region"
            aria-labelledby="age-gate-title"
            data-testid="age-gate"
        >
            <div className="w-full max-w-[440px] flex flex-col items-center text-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-cl-glow/10 border border-cl-glow/25 flex items-center justify-center text-cl-glow-text">
                    <ShieldAlert size={26} aria-hidden="true" />
                </div>
                <div>
                    <h2 id="age-gate-title" className="m-0 text-[20px] leading-tight font-display text-[var(--cl-text)]">
                        This channel is age-restricted
                    </h2>
                    <p className="mt-1 mb-0 text-[12px] text-cl-faint truncate" title={`#${channelName}`}>#{channelName}</p>
                </div>
                <p className="m-0 text-[13px] leading-relaxed text-cl-muted">
                    You must be 18 or older to view it. We only remember that you confirmed, on your account, so
                    this is asked once. Messages here stay hidden until you do.
                </p>
                {error && (
                    <div role="alert" className="w-full text-[12px] text-cl-flash-text rounded-lg border border-cl-flash/30 bg-cl-flash/10 px-3 py-2" data-testid="age-gate-error">
                        {error}
                    </div>
                )}
                <div className="flex flex-col sm:flex-row-reverse gap-2 w-full justify-center items-center pt-1">
                    <span data-testid="age-gate-confirm">
                        <ClButton variant="primary" onClick={() => { void confirm(); }} loading={busy}>
                            {busy ? 'Saving…' : error ? 'Try again' : "I'm 18 or older, continue"}
                        </ClButton>
                    </span>
                    <span data-testid="age-gate-back">
                        <ClButton variant="ghost" onClick={onBack} disabled={busy} autoFocus>
                            Go back
                        </ClButton>
                    </span>
                </div>
            </div>
        </div>
    );
};

export default AgeGatePane;
