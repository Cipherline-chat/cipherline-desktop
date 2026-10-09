import { useCallback, useEffect, useState } from 'react';
import { sendClock, type SendClock } from '../utils/undeliveredSend';
import type { SendMarked } from '../utils/pendingSend';

/**
 * Drives the red "!" on messages that have not been delivered
 * (utils/undeliveredSend.ts). Returns a predicate for a row; it re-renders the
 * caller when the next still-pending message crosses the 10 s line, so the "!"
 * appears on time without any polling.
 */
export function useUndeliveredSends(
    messages: readonly SendMarked[],
    clock: SendClock = sendClock,
): (msg: SendMarked | null | undefined) => boolean {
    const [, setTick] = useState(0);
    // Idempotent bookkeeping on a module-level map: safe to run in render, and it
    // must run BEFORE rows ask, or a fresh 'sending' row would have no start.
    clock.reconcile(messages);
    const dueIn = clock.msUntilNextDue(messages);
    useEffect(() => {
        if (dueIn === null) return;
        const t = setTimeout(() => setTick(n => n + 1), dueIn + 25);
        return () => clearTimeout(t);
    }, [dueIn, messages]);
    return useCallback((msg) => clock.isUndelivered(msg), [clock]);
}
