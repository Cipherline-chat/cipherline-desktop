import { useCallback, useEffect, useState } from 'react';
import { secureLocalStore } from '../utils/secureLocalStore';

/**
 * On/off switch for seasonal ambient decoration.
 *
 * A device display preference, not account data, so it uses a global key
 * rather than a per-account one — switching accounts shouldn't bring the
 * flakes back for someone who turned them off.
 *
 * Defaults ON: the effect is subtle, date-windowed to a few weeks, and
 * already declines to render under reduced motion. This exists because it
 * sits on screen continuously for that whole window, and anything continuous
 * needs an off switch (rule 5 — an egg may never cost the user anything, and
 * "mildly distracting for five weeks" is a cost).
 *
 * A window event keeps the settings toggle and the live layer in sync without
 * threading state through App — they're in unrelated parts of the tree.
 */

const KEY = 'cipherline_seasonal_effects';
const CHANGED = 'cipherline:seasonal-effects-changed';

function read(): boolean {
    try {
        return secureLocalStore.getItem(KEY) !== '0';
    } catch {
        return true;
    }
}

export function useSeasonalEffects(): [boolean, (v: boolean) => void] {
    const [enabled, setEnabled] = useState(read);

    useEffect(() => {
        const onChange = () => setEnabled(read());
        window.addEventListener(CHANGED, onChange);
        return () => window.removeEventListener(CHANGED, onChange);
    }, []);

    const set = useCallback((v: boolean) => {
        try { secureLocalStore.setItem(KEY, v ? '1' : '0'); } catch { /* non-fatal */ }
        setEnabled(v);
        window.dispatchEvent(new CustomEvent(CHANGED));
    }, []);

    return [enabled, set];
}
