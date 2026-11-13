import { useEffect } from 'react';
import { pushEscapeLayer } from '../utils/escapeStack';

/**
 * The skip contract of a PASSIVE egg (the same one MomentHost gives its
 * passive moments): Escape ends it through the shared escape stack (so the
 * press never ALSO closes the dialog underneath), and a pointer press anywhere
 * ends it while still reaching the app (the layer is pointer-events: none, so
 * nobody is ever trapped behind a dimmed app waiting for it to finish).
 * Ordinary typing is left alone.
 */
export function useEggSkip(onDone: () => void): void {
    useEffect(() => {
        const pop = pushEscapeLayer(() => onDone());
        const onPointer = () => onDone();
        window.addEventListener('pointerdown', onPointer, true);
        return () => {
            pop();
            window.removeEventListener('pointerdown', onPointer, true);
        };
    }, [onDone]);
}
