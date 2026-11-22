import { useCallback, useEffect, useState } from 'react';
import { toUiScaleState, isUiScaleStep, type UiScaleState } from '../utils/a11y/uiScale';

/**
 * Accessibility → Interface size. The value is owned by the host (Electron
 * main: electron/ui-scale.ts; the Tauri host implements the same three
 * calls). null = not read yet, or no host support (web / older main): the
 * control renders disabled rather than pretending.
 */
export function useUiScale(): { state: UiScaleState | null; supported: boolean; set: (percent: number) => void } {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    const supported = !!(api?.getUiScale && api?.setUiScale);
    const [state, setState] = useState<UiScaleState | null>(null);

    useEffect(() => {
        if (!api?.getUiScale) return;
        let alive = true;
        api.getUiScale().then(raw => { if (alive) setState(toUiScaleState(raw)); }).catch(() => { /* stays null */ });
        const off = api.onUiScaleChanged?.(raw => { if (!alive) return; const s = toUiScaleState(raw); if (s) setState(s); });
        return () => { alive = false; off?.(); };
    }, [api]);

    const set = useCallback((percent: number) => {
        if (!isUiScaleStep(percent) || !api?.setUiScale) return;
        // Optimistic: the slider moves now; the host's reply (with the clamp) wins.
        setState(s => (s ? { ...s, percent, effective: Math.min(percent, s.max), source: 'set' } : s));
        api.setUiScale(percent).then(raw => { const s = toUiScaleState(raw); if (s) setState(s); }).catch(() => { /* next event re-syncs */ });
    }, [api]);

    return { state, supported, set };
}
