import { useCallback, useEffect, useState } from 'react';
import { secureLocalStore } from '../utils/secureLocalStore';
import { BACKUP_RESTORED_EVENT } from '../services/backupRegistry';
import {
    GROUP_GAP_KEY, GROUP_GAP_MAX, GROUP_GAP_MIN, READABILITY_CHANGED_EVENT, READABILITY_DEFAULTS, READABILITY_SPECS,
    parseGroupGap, parseReadability, type ReadabilityId, type ReadabilityState, type ReadabilityValue,
} from '../utils/a11y/readability';
import { TIME_FORMAT_CHANGED_EVENT, getTimeFormatPref, parseTimeFormat, type TimeFormatPref } from '../utils/a11y/timeFormat';
import type { ToastDurationPref } from '../utils/a11y/toastDuration';

/**
 * Accessibility readability preferences (utils/a11y/readability.ts): the same
 * shape as useMessageTextSize — a secureLocalStore key per setting, a window
 * event keeping the pane and the applier (components/a11y/A11yRuntime) in
 * sync, a re-read once the account is ready (the store is cold until then)
 * and after a backup restore. The only writes are the user changing a control.
 */
export interface ReadabilityPrefs extends ReadabilityState {
    time: TimeFormatPref;
    toast: ToastDurationPref;
}

function read(): ReadabilityPrefs {
    try {
        const g = (id: ReadabilityId) => secureLocalStore.getItem(READABILITY_SPECS[id].key);
        return {
            density: parseReadability('density', g('density')),
            font: parseReadability('font', g('font')),
            leading: parseReadability('leading', g('leading')),
            tracking: parseReadability('tracking', g('tracking')),
            focus: parseReadability('focus', g('focus')),
            links: parseReadability('links', g('links')),
            time: parseTimeFormat(g('time')),
            toast: parseReadability('toast', g('toast')),
            groupGap: parseGroupGap(secureLocalStore.getItem(GROUP_GAP_KEY)),
        };
    } catch {
        return { ...READABILITY_DEFAULTS, time: 'auto', toast: 'normal' };
    }
}

export function useReadability(): {
    prefs: ReadabilityPrefs;
    set: <K extends ReadabilityId>(id: K, value: ReadabilityValue<K>) => void;
    setGroupGap: (px: number | null) => void;
} {
    const [prefs, setPrefs] = useState<ReadabilityPrefs>(read);

    useEffect(() => {
        let alive = true;
        const sync = () => { if (alive) setPrefs(read()); };
        window.addEventListener(READABILITY_CHANGED_EVENT, sync);
        window.addEventListener(BACKUP_RESTORED_EVENT, sync);
        void Promise.resolve(secureLocalStore.whenAccountReady()).catch(() => undefined).then(sync);
        return () => {
            alive = false;
            window.removeEventListener(READABILITY_CHANGED_EVENT, sync);
            window.removeEventListener(BACKUP_RESTORED_EVENT, sync);
        };
    }, []);

    const set = useCallback(<K extends ReadabilityId>(id: K, value: ReadabilityValue<K>) => {
        const spec = READABILITY_SPECS[id];
        if (!(spec.values as readonly string[]).includes(value)) return;
        try { secureLocalStore.setItem(spec.key, String(value)); } catch { /* applies for this session */ }
        window.dispatchEvent(new CustomEvent(READABILITY_CHANGED_EVENT));
    }, []);

    const setGroupGap = useCallback((px: number | null) => {
        try {
            if (px === null) secureLocalStore.removeItem(GROUP_GAP_KEY);
            else secureLocalStore.setItem(GROUP_GAP_KEY, String(Math.max(GROUP_GAP_MIN, Math.min(GROUP_GAP_MAX, Math.round(px)))));
        } catch { /* applies for this session */ }
        window.dispatchEvent(new CustomEvent(READABILITY_CHANGED_EVENT));
    }, []);

    return { prefs, set, setGroupGap };
}

/** Re-render a component when the 12/24-hour setting changes (timestamps are formatted on render). */
export function useTimeFormatRevision(): TimeFormatPref {
    const [pref, setPref] = useState<TimeFormatPref>(getTimeFormatPref);
    useEffect(() => {
        const on = () => setPref(getTimeFormatPref());
        window.addEventListener(TIME_FORMAT_CHANGED_EVENT, on);
        on();
        return () => window.removeEventListener(TIME_FORMAT_CHANGED_EVENT, on);
    }, []);
    return pref;
}
