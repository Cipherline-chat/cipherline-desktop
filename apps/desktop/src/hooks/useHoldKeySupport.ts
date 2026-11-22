import { useEffect, useState } from 'react';
import { parseHoldKeySupport, primeKeyboardLayoutLabels, type HoldKeySupport } from '../utils/holdKeys';

/**
 * Would this hold key (push-to-talk / push-to-mute) work while another app has
 * focus on this system? Asks main for a dry run (electron/global-ptt.ts
 * holdKeySupport: backend + whether the watcher can read the key); null while
 * unknown, when no key is set, or outside the desktop app.
 */
export function useHoldKeySupport(combo: string | null | undefined): HoldKeySupport | null {
    // Keyed by the combo it answers, so a changed key never shows the previous key's answer.
    const [answer, setAnswer] = useState<{ combo: string; support: HoldKeySupport | null } | null>(null);
    useEffect(() => { primeKeyboardLayoutLabels(); }, []);
    useEffect(() => {
        const check = typeof window !== 'undefined' ? window.electronAPI?.checkGlobalHoldKey : undefined;
        if (!combo || !check) return;
        let live = true;
        check(combo)
            .then((raw) => { if (live) setAnswer({ combo, support: parseHoldKeySupport(raw) }); })
            .catch(() => { if (live) setAnswer({ combo, support: null }); });
        return () => { live = false; };
    }, [combo]);
    return combo && answer?.combo === combo ? answer.support : null;
}
