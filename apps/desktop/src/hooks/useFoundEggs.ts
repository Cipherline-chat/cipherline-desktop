import { useEffect, useState } from 'react';
import { EGG_FOUND_EVENT, eggsFound } from '../utils/eggProgress';

/** The easter eggs found on this device/account, live (re-reads when one is found). */
export function useFoundEggs(): ReadonlySet<string> {
    const [found, setFound] = useState<ReadonlySet<string>>(() => new Set(eggsFound()));
    useEffect(() => {
        const on = () => setFound(new Set(eggsFound()));
        window.addEventListener(EGG_FOUND_EVENT, on);
        on();
        return () => window.removeEventListener(EGG_FOUND_EVENT, on);
    }, []);
    return found;
}
