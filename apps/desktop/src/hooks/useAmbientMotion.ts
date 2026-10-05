import { useCallback, useEffect, useState } from 'react';
import { secureLocalStore } from '../utils/secureLocalStore';

/**
 * On/off switch for the home deck's ambient motion (rising motes + the small
 * decorative micro-loops gated by [data-ambient]). Same shape and rationale
 * as useSeasonalEffects: a device display preference under a global key,
 * default ON, with a window event keeping the Appearance toggle and the live
 * layer in sync across unrelated parts of the tree. Its own toggle rather
 * than piggybacking seasonal — seasonal is date-windowed decoration, this is
 * year-round, and rule 11 says anything continuous needs a real off switch.
 */

const KEY = 'cipherline_ambient_motion';
const CHANGED = 'cipherline:ambient-motion-changed';

function read(): boolean {
    try {
        return secureLocalStore.getItem(KEY) !== '0';
    } catch {
        return true;
    }
}

export function useAmbientMotion(): [boolean, (v: boolean) => void] {
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
