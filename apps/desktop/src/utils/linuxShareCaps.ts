/**
 * Renderer-side glue for linuxShareDefaults.ts: will a Linux share take the native hardware path?
 * Asked once per app run (the answer is a property of this machine and the Settings switch; a failed native
 * start flips nativeFailed in SidebarConference, which this cannot see, so a "yes" is only "likely").
 * Never rejects. null = not known (not Linux, or the probe did not answer).
 */
import { useEffect, useState } from 'react';
import { getNativeShareEnabled } from './nativeSharePrefs';
import { chromiumPathFpsCap } from './linuxShareDefaults';

let cached: { flagOn: boolean; value: Promise<boolean | null> } | null = null;

export function nativeShareLikely(): Promise<boolean | null> {
    if (typeof window === 'undefined' || window.electronAPI?.platform !== 'linux') return Promise.resolve(null);
    const api = window.nativeShare;
    if (!api) return Promise.resolve(false);
    const flagOn = getNativeShareEnabled() || api.envFlag === true;
    if (!flagOn) return Promise.resolve(false);
    if (cached && cached.flagOn === flagOn) return cached.value;
    const value = (async (): Promise<boolean | null> => {
        try {
            if (!(await api.available()).helper) return false;
            const p = await api.probe();
            return !!(p?.vaapi || p?.nvenc);
        } catch { return null; }
    })();
    cached = { flagOn, value };
    return value;
}

/** The Chromium-path fps cap for this machine (60), or null; null until the answer is in. */
export function useChromiumFpsCap(): number | null {
    const [cap, setCap] = useState<number | null>(null);
    useEffect(() => {
        let alive = true;
        void nativeShareLikely().then(n => {
            if (alive) setCap(chromiumPathFpsCap({ platform: window.electronAPI?.platform, nativeLikely: n }));
        });
        return () => { alive = false; };
    }, []);
    return cap;
}
