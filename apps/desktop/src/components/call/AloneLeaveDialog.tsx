import React from 'react';
import ReactDOM from 'react-dom';
import { ClButton } from '../cl';
import { useEscape } from '../../hooks/useEscape';

/**
 * "You've been the only one here" - the countdown before the alone-in-call auto-leave (utils/aloneLeave.ts).
 * Says what it is (nobody else is in the call, not "you were quiet"), offers "Stay in call" as the primary
 * answer (focused on open; Esc does the same) and keeps "Leave now". Portal-rendered over the call chrome.
 * Distinct from SoloKickDialog (the after-the-fact notice of a server-side removal).
 */
export const AloneLeaveDialog: React.FC<{
    minutes: number | null;
    secondsLeft: number;
    onStay: () => void;
    onLeaveNow: () => void;
    /** Render in place instead of a portal (visual harness only). */
    inline?: boolean;
}> = ({ minutes, secondsLeft, onStay, onLeaveNow, inline }) => {
    // Esc = Stay in call, through the shared Escape stack (topmost surface wins; utils/escapeStack.ts).
    useEscape(() => { onStay(); });
    const body = (
        <div className={`${inline ? 'absolute' : 'fixed'} inset-0 z-[99999] flex items-center justify-center bg-cl-abyss/60 backdrop-blur-sm`}>
            <div role="alertdialog" aria-modal="true" aria-labelledby="alone-leave-title" aria-describedby="alone-leave-desc"
                className="bg-cl-deep border border-cl-border rounded-2xl shadow-2xl p-6 flex flex-col items-center gap-4 max-w-xs w-full mx-4">
                <div className="w-12 h-12 rounded-full bg-cl-glow/15 flex items-center justify-center">
                    <svg className="w-6 h-6 text-cl-glow-text" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3m0 3h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                    </svg>
                </div>
                <div className="text-center">
                    <p id="alone-leave-title" className="text-cl-text font-semibold text-sm">
                        You've been the only one here{minutes ? ` for ${minutes >= 120 && minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes} minutes`}` : ''}
                    </p>
                    <p id="alone-leave-desc" className="text-cl-faint text-xs mt-1 leading-relaxed">
                        Nobody else is in this call. Leaving the call in <span className="text-cl-text font-semibold tabular-nums">{secondsLeft}s</span>.
                    </p>
                </div>
                <div className="flex flex-col gap-2 w-full">
                    <ClButton variant="primary" fullWidth autoFocus onClick={onStay}>Stay in call</ClButton>
                    <ClButton variant="ghost" fullWidth onClick={onLeaveNow}>Leave now</ClButton>
                </div>
            </div>
        </div>
    );
    return inline ? body : ReactDOM.createPortal(body, document.body);
};
