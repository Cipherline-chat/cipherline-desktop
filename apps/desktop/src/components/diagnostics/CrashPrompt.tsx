import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bug } from 'lucide-react';
import { ClButton } from '../cl';
import { useEscape } from '../../hooks/useEscape';
import './reportProblem.css';

/**
 * "Cipherline closed unexpectedly. Send a crash report?" — a floating card,
 * not a modal: it must never stand between someone and the chat they just
 * reopened the app for. Keyboard-reachable (focus moves to it once, Escape =
 * Not now via the shared escape stack) and announced as an alert dialog.
 */
export const CrashPrompt: React.FC<{
    count: number;
    onReview: () => void;
    onNotNow: () => void;
}> = ({ count, onReview, onNotNow }) => {
    const [leaving, setLeaving] = useState<null | 'review' | 'later'>(null);
    const primaryRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const t = setTimeout(() => primaryRef.current?.querySelector<HTMLButtonElement>('button')?.focus(), 350);
        return () => clearTimeout(t);
    }, []);

    useEffect(() => {
        if (!leaving) return;
        const t = setTimeout(() => (leaving === 'review' ? onReview() : onNotNow()), 170);
        return () => clearTimeout(t);
    }, [leaving, onReview, onNotNow]);

    // Escape = "Not now", through the shared stack: any surface opened after
    // the prompt (a dialog, a menu) still gets Escape first.
    useEscape(() => setLeaving('later'), !leaving);

    return createPortal(
        <div className="cl-kit" style={{ display: 'contents' }}>
            <div
                className={`rp-prompt${leaving ? ' rp-out' : ''}`}
                role="alertdialog"
                aria-labelledby="rp-crash-title"
                aria-describedby="rp-crash-desc"
            >
                <div className="rp-prompt-head">
                    <div className="rp-tile rp-tile--flash" style={{ width: 38, height: 38, borderRadius: 12 }} aria-hidden><Bug size={18} /></div>
                    <div style={{ minWidth: 0 }}>
                        <h3 id="rp-crash-title">Cipherline closed unexpectedly</h3>
                        <p id="rp-crash-desc">
                            Send a crash report so we can fix it? You’ll see exactly what’s in it first — no messages, files or names.
                            {count > 1 ? ` This has happened ${count} times.` : ''}
                        </p>
                    </div>
                </div>
                <div className="rp-prompt-actions">
                    <ClButton variant="ghost" onClick={() => setLeaving('later')} disabled={!!leaving}>Not now</ClButton>
                    <div ref={primaryRef} style={{ display: 'contents' }}>
                        <ClButton onClick={() => setLeaving('review')} disabled={!!leaving}>Review &amp; send</ClButton>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default CrashPrompt;
