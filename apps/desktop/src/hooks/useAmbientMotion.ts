import { useCallback, useEffect, useState } from 'react';
import { secureLocalStore } from '../utils/secureLocalStore';
import { useMotionSnapshot } from '../utils/a11y/motionPrefs';

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

/**
 * Whether the ambient motes should move right now: the Home ambience switch is
 * on, Settings -> Accessibility -> Celebrations and effects is on (the master
 * that Home ambience sits under), and motion is not reduced (Reduce motion:
 * Follow my system / Always reduce / Allow full motion, the EFFECTIVE value).
 * Live: re-renders when any of the three changes, so a canvas can stop and
 * clear itself the moment the user flips a switch in the Settings it sits
 * behind. The home deck, Settings' water column and Server Settings' dock all
 * read this one answer.
 */
export function useAmbientActive(): boolean {
    const [ambient] = useAmbientMotion();
    const m = useMotionSnapshot();
    return ambient && m.effects && !m.reduced;
}
