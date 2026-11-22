import React, { useRef } from 'react';
import { Check } from 'lucide-react';
import { useThemePreference } from '../../../theme/engine';
import { chooseBuiltinTheme } from '../../../theme/activeThemeMirror';
import { useAuth } from '../../../contexts/AuthContext';
import {
    DARK_THEME, LIGHT_THEME, THEMES, THEME_PREFERENCES, THEME_PREFERENCE_LABELS, type Theme, type ThemePreference,
} from '../../../theme/themes';
import '../../../styles/theme-picker.css';
import { CustomThemes } from './CustomThemes';
import { ThemePreviewNotice } from '../../themeShare/ThemePreviewBar';

/**
 * Settings → Appearance → Theme: Dark, Light, Midnight, High contrast dark,
 * High contrast light, Sync with system. Each choice is
 * a small picture of the app in that theme (painted from the theme DATA, so a
 * tile always shows the real colours whatever theme is active), applied the
 * moment it is picked (engine.setThemePreference: no restart, and main
 * repaints the window background and the Windows caption buttons).
 *
 * A radio group: arrow keys move AND select (the WAI-ARIA radio pattern), Tab
 * leaves the group. Picking a tile ends a live preview (activeThemeMirror);
 * while one is up, ThemePreviewNotice says so above the tiles.
 */

const LABEL = THEME_PREFERENCE_LABELS;
const DESC: Record<ThemePreference, string> = {
    dark: 'Glow in the deep.',
    light: 'Cream and white, like cipherline.chat.',
    midnight: 'True black. Easy on OLED screens at night.',
    'hc-dark': 'White on black, strong edges and focus rings.',
    'hc-light': 'Black on white, strong edges and focus rings.',
    system: 'Follows your computer’s light or dark mode, and its high contrast setting.',
};

/** The palette of one theme as the preview's CSS variables. */
function previewVars(t: Theme): React.CSSProperties {
    const p = t.palette;
    return {
        '--tp-abyss': p.abyss, '--tp-deep': p.deep, '--tp-surface': p.surface, '--tp-raise': p.raise,
        '--tp-border': p.border, '--tp-text': p.text, '--tp-muted': p.muted, '--tp-faint': p.faint,
        '--tp-lume': p.lume, '--tp-lume-text': p['lume-text'], '--tp-flash': p.flash,
    } as React.CSSProperties;
}

/** A tiny app: rail, list, chat with two bubbles and a composer. */
const Mini: React.FC<{ theme: Theme; className?: string }> = ({ theme, className }) => (
    <span className={`tp-mini${theme.contrast === 'high' ? ' tp-mini--hc' : ''}${className ? ` ${className}` : ''}`} style={previewVars(theme)} aria-hidden="true">
        <span className="tp-rail"><i className="tp-dot tp-dot--on" /><i className="tp-dot" /><i className="tp-dot" /></span>
        <span className="tp-list"><i className="tp-line tp-line--on" /><i className="tp-line" /><i className="tp-line tp-line--short" /></span>
        <span className="tp-chat">
            <i className="tp-msg"><b /><em /></i>
            <i className="tp-msg"><b className="tp-name--lume" /><em className="tp-em--short" /></i>
            <i className="tp-compose" />
        </span>
    </span>
);

export const ThemePicker: React.FC = () => {
    const pref = useThemePreference();
    const { userId, user } = useAuth();
    const uid = userId ?? user?.user_id ?? null;
    const refs = useRef<Array<HTMLButtonElement | null>>([]);

    const pick = (p: ThemePreference) => { void chooseBuiltinTheme(uid, p); };
    const onKeyDown = (e: React.KeyboardEvent, i: number) => {
        const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const n = THEME_PREFERENCES.length;
        const next = (i + step + n) % n;
        pick(THEME_PREFERENCES[next]);
        refs.current[next]?.focus();
    };

    return (
        <div className="sd-card" data-labels="Theme|Light mode|Dark mode|Midnight|High contrast|Sync with system|Custom theme|Create theme">
            <h3>Theme</h3>
            <p className="sd-sub">How Cipherline looks on this device. Profile cards, celebrations and the call stage stay dark in every theme.</p>
            <ThemePreviewNotice />
            <div className="tp-grid" role="radiogroup" aria-label="Theme">
                {THEME_PREFERENCES.map((p, i) => {
                    const on = pref === p;
                    return (
                        <button
                            key={p}
                            ref={(el) => { refs.current[i] = el; }}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            // A custom theme active (pref 'custom'): the first tile takes the Tab stop.
                            tabIndex={on || (i === 0 && !(THEME_PREFERENCES as readonly string[]).includes(pref)) ? 0 : -1}
                            className={`tp-opt${on ? ' tp-opt--on' : ''}`}
                            data-theme-option={p}
                            onClick={() => pick(p)}
                            onKeyDown={(e) => onKeyDown(e, i)}
                        >
                            <span className="tp-pic">
                                {p === 'system' ? (
                                    <>
                                        <Mini theme={LIGHT_THEME} />
                                        <Mini theme={DARK_THEME} className="tp-mini--half" />
                                    </>
                                ) : <Mini theme={THEMES[p]} />}
                                {on && <span className="tp-check"><Check size={13} strokeWidth={3} /></span>}
                            </span>
                            <span className="tp-label">{LABEL[p]}</span>
                            <span className="tp-desc">{DESC[p]}</span>
                        </button>
                    );
                })}
            </div>
            <CustomThemes />
        </div>
    );
};

export default ThemePicker;
