import { useEffect, useRef, useState } from 'react';
import { hasRecentInput, subscribeInputRecency } from '../utils/inputRecency';

/** How often the passage of time alone (input ageing past the window) is noticed. */
const RECHECK_MS = 5_000;

/**
 * Whether a person has had real input within the auto-read window
 * (utils/inputRecency.ts). Flips true the instant input returns (the store
 * notifies), and false within RECHECK_MS of it ageing out.
 */
export function useRecentInput(): boolean {
    const [recent, setRecent] = useState<boolean>(() => hasRecentInput());
    useEffect(() => {
        const sync = () => setRecent(hasRecentInput());
        sync();
        const unsub = subscribeInputRecency(sync);
        const id = setInterval(sync, RECHECK_MS);
        return () => { unsub(); clearInterval(id); };
    }, []);
    return recent;
}

/** Run `cb` each time input returns after a quiet spell (not-recent -> recent). */
export function useOnInputReturn(cb: () => void): void {
    const ref = useRef(cb);
    useEffect(() => { ref.current = cb; });
    useEffect(() => {
        let was = hasRecentInput();
        const check = () => {
            const now = hasRecentInput();
            if (now && !was) ref.current();
            was = now;
        };
        const unsub = subscribeInputRecency(check);
        const id = setInterval(check, RECHECK_MS);
        return () => { unsub(); clearInterval(id); };
    }, []);
}
