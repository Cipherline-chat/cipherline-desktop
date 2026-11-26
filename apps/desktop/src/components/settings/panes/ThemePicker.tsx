import React, { useRef } from 'react';
import { Check } from 'lucide-react';
import { startBuiltinThemePreview, stopThemePreview, useThemePreference, useThemePreview } from '../../../theme/engine';
import {
    DARK_THEME, LIGHT_THEME, THEMES, THEME_PREFERENCES, THEME_PREFERENCE_LABELS, type Theme, type ThemePreference,
} from '../../../theme/themes';
import '../../../styles/theme-picker.css';
import { CustomThemes } from './CustomThemes';

/**
 * Settings → Appearance → Theme: Dark, Light, Midnight, High contrast dark,
 * High contrast light, Sync with system. Each choice is
 * a small picture of the app in that theme (painted from the theme DATA, so a
 * tile always shows the real colours whatever theme is active), shown the
 * moment it is picked AS A PREVIEW (engine.startBuiltinThemePreview): the
 * "Previewing <name>" bar (themeShare/ThemePreviewBar.tsx) offers Keep / Revert
 * and puts the real theme back by itself after 15 s, so no theme can strand
 * anyone. Keep stores it (activeThemeMirror.chooseBuiltinTheme: no restart,
 * and main repaints the window background and the Windows caption buttons).
 * Picking another tile while previewing restarts the countdown; picking the
 * theme in use is the same as Revert.
 *
 * Buttons with aria-pressed (the theme on screen). Arrow keys move focus only:
 * a pick opens the preview bar and moves focus to its Keep button, so
 * selection cannot follow focus. Enter / Space / click picks, Tab leaves.
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

/**
 * What picking a built-in tile does: nothing when it is the theme in use and
 * no preview is up; Revert when it is the theme in use and a preview is up;
 * otherwise a Settings preview (restarting the countdown if one is up).
 */
function pickBuiltinTheme(p: ThemePreference, inUse: string, previewing: boolean): void {
    if (p === inUse) { if (previewing) stopThemePreview(); return; }
    startBuiltinThemePreview(p, { source: 'settings' });
}

export const ThemePicker: React.FC = () => {
    const pref = useThemePreference();
    const preview = useThemePreview();
    const refs = useRef<Array<HTMLButtonElement | null>>([]);
    // The tile whose theme is on screen: the previewed one, else the one in use (null: a custom theme).
    const shown: string | null = preview ? preview.builtin : pref;
    const tabStop = Math.max(0, THEME_PREFERENCES.findIndex((p) => p === shown));

    const pick = (p: ThemePreference) => { pickBuiltinTheme(p, pref, !!preview); };
    const onKeyDown = (e: React.KeyboardEvent, i: number) => {
        const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const n = THEME_PREFERENCES.length;
        refs.current[(i + step + n) % n]?.focus();
    };

    return (
        <div className="sd-card" data-labels="Theme|Light mode|Dark mode|Midnight|High contrast|Sync with system|Custom theme|Create theme">
            <h3>Theme</h3>
            <p className="sd-sub">How Cipherline looks on this device. Picking one previews it: press Keep to use it, or it goes back by itself. Profile cards, celebrations and the call stage stay dark in every theme.</p>
            <div className="tp-grid" role="group" aria-label="Theme" data-theme-picker>
                {THEME_PREFERENCES.map((p, i) => {
                    const on = pref === p;
                    const isPreview = preview?.builtin === p;
                    return (
                        <button
                            key={p}
                            ref={(el) => { refs.current[i] = el; }}
                            type="button"
                            aria-pressed={shown === p}
                            // One Tab stop: the tile on screen (a custom theme on screen: the first tile).
                            tabIndex={i === tabStop ? 0 : -1}
                            className={`tp-opt${on ? ' tp-opt--on' : ''}${isPreview ? ' tp-opt--preview' : ''}`}
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
                            <span className="tp-desc">{isPreview ? 'Previewing. Press Keep to use it.' : DESC[p]}</span>
                        </button>
                    );
                })}
            </div>
            <CustomThemes />
        </div>
    );
};

export default ThemePicker;
