import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMessageTextSize } from '../../hooks/useMessageTextSize';
import { applyMessageTextSize } from '../../utils/a11y/messageTextSize';
import { toUiScaleState, uiScaleLabel, type UiScaleState } from '../../utils/a11y/uiScale';
import { useReadability } from '../../hooks/useReadability';
import { applyReadability } from '../../utils/a11y/readability';
import { setTimeFormatPref } from '../../utils/a11y/timeFormat';
import '../../styles/a11y.css';
import '../../styles/readability.css';

/**
 * App-wide accessibility runtime, mounted once in App (above the auth screen,
 * so it works signed out too):
 *  - applies Message text size to <html> (the CSS vars every message surface
 *    reads; utils/a11y/messageTextSize.ts) whenever it changes / hydrates;
 *  - shows the "Interface size 110%" pill when Ctrl/Cmd + = / - / 0 step the
 *    interface size (the host sends ui-scale:changed with source 'shortcut').
 * Renders nothing else.
 */
const PILL_MS = 1600;

export const A11yRuntime: React.FC = () => {
    const [textPx] = useMessageTextSize();
    useEffect(() => { applyMessageTextSize(textPx); }, [textPx]);

    // Readability (density, font, spacing, focus, links) -> <html> data attributes; time format -> the shared formatter.
    const { prefs } = useReadability();
    useEffect(() => { applyReadability(prefs); }, [prefs]);
    useEffect(() => { setTimeFormatPref(prefs.time); }, [prefs.time]);

    const [pill, setPill] = useState<UiScaleState | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        const off = window.electronAPI?.onUiScaleChanged?.(raw => {
            const s = toUiScaleState(raw);
            if (!s || s.source !== 'shortcut') return;
            setPill(s);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setPill(null), PILL_MS);
        });
        return () => { off?.(); if (timer.current) clearTimeout(timer.current); };
    }, []);

    if (!pill || typeof document === 'undefined') return null;
    const atLimit = pill.effective >= pill.max && pill.max < 200;
    return createPortal(
        <div className="a11y-zoom-pill" role="status" aria-live="polite">
            <span>Interface size</span>
            <b>{uiScaleLabel(pill.effective)}</b>
            {pill.effective < pill.percent || atLimit ? <small>· largest that fits this display</small> : null}
        </div>,
        document.body,
    );
};
