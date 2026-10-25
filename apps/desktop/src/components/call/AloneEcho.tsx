import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Keys } from '../mascot/Keys';
import { claimEggNow } from '../../hooks/useEasterEggs';
import { recordEggFound } from '../../utils/eggProgress';
import {
    ALONE_ECHO_AFTER_MS, ALONE_ECHO_COOLDOWN_MS, ALONE_ECHO_EGG, ALONE_ECHO_STEP_MS, aloneEchoLine,
} from '../../utils/aloneEcho';

/**
 * Alone in a call for a few minutes → Keys, small, in the call's pill row:
 * "…echo… echo…", then a couple more lines, then silence. Dismissable, once
 * per call, and at most once per six hours (so a long evening of solo calls
 * doesn't become a bit that overstays). Sits where "Reconnecting…" sits, so
 * it takes no new surface and never covers a tile or a control.
 *
 * `alone` must already exclude reconnecting. Leaving the "alone" state — for
 * any reason, including someone joining — cancels everything and removes him.
 */
interface AloneEchoProps {
    alone: boolean;
    /** Resets the once-per-call guard when the call itself changes. */
    sessionId?: string | null;
}

export const AloneEcho: React.FC<AloneEchoProps> = ({ alone, sessionId }) => {
    const [step, setStep] = useState(-1);
    const [dismissed, setDismissed] = useState(false);
    const usedFor = useRef<string | null | undefined>(undefined);
    const timers = useRef<number[]>([]);

    useEffect(() => {
        // Cleanup also resets the step, so the next stretch of solitude starts at the opener.
        const clear = () => { timers.current.forEach(window.clearTimeout); timers.current = []; setStep(-1); };
        if (!alone) return clear;
        // One showing per call: a second stretch of solitude in the same call stays quiet.
        if (usedFor.current === (sessionId ?? null)) return clear;
        timers.current.push(window.setTimeout(() => {
            if (!claimEggNow(ALONE_ECHO_EGG, { cooldownMs: ALONE_ECHO_COOLDOWN_MS })) return;
            usedFor.current = sessionId ?? null;
            recordEggFound('alone-echo');
            setDismissed(false);
            setStep(0);
            // Walk the lines, then go quiet (aloneEchoLine → null).
            for (let i = 1; i <= 4; i++) {
                timers.current.push(window.setTimeout(() => setStep(i), ALONE_ECHO_STEP_MS * i));
            }
        }, ALONE_ECHO_AFTER_MS));
        return clear;
    }, [alone, sessionId]);

    const line = dismissed || !alone ? null : aloneEchoLine(step);
    if (!line) return null;
    return (
        <div
            className="mx-3 mb-1 flex items-center gap-2 pl-2 pr-1.5 py-1.5 bg-cl-deep border border-cl-lume/25 rounded-xl text-[11.5px] text-cl-muted"
            data-testid="alone-echo"
        >
            <span aria-hidden="true" className="shrink-0 flex">
                <Keys size={30} interactive={false} waveOnMount={false} idleSway={false} />
            </span>
            {/* Decorative: the line is aria-hidden so a screen reader isn't read "echo" at. */}
            <span aria-hidden="true" className="flex-1 min-w-0 truncate italic">{line}</span>
            <button
                type="button"
                onClick={() => setDismissed(true)}
                aria-label="Dismiss"
                className="shrink-0 w-6 h-6 inline-flex items-center justify-center rounded-md border-none bg-transparent text-cl-faint hover:text-cl-text cursor-pointer"
            >
                <X size={12} aria-hidden="true" />
            </button>
        </div>
    );
};

export default AloneEcho;
