import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bell, Check, Hash, Plus, Send, ShieldCheck, Volume2 } from 'lucide-react';
import { themeCssVariables, type Theme } from '../../../theme/themes';
import '../../../styles/theme-preview.css';

/**
 * The custom theme editor's live preview: a small, static model of the app
 * (rail, channel list, chat with a mention, a link and code, the composer,
 * the member list with presence and a verified shield, buttons, a toggle and
 * a toast), painted ONLY from the theme being edited: the root carries every
 * `--cl-*` variable of that theme inline, and every rule in
 * styles/theme-preview.css (.ctp-*) reads tokens. So the picture is the real
 * token set, never an approximation, whatever theme the app itself shows.
 *
 * Portable on purpose: React, lucide and the pure theme data only, so the
 * chat's theme-link card and the website's /theme page (apps/website,
 * `@app-theme-preview` alias) render the very same picture.
 */
export const CustomThemePreview: React.FC<{ theme: Theme; label?: string; compact?: boolean }> = ({ theme, label, compact }) => {
    const style = useMemo(() => {
        const vars: Record<string, string> = { ...themeCssVariables(theme), colorScheme: theme.scheme };
        return vars as React.CSSProperties;
    }, [theme]);
    return (
        <div className={`ctp${compact ? ' ctp--compact' : ''}`} style={style} role="img" aria-label={label ?? `Preview of ${theme.name}`}>
            <div className="ctp-rail" aria-hidden="true">
                <span className="ctp-srv ctp-srv--home"><Hash size={12} strokeWidth={3} /></span>
                <i className="ctp-sep" />
                <span className="ctp-srv ctp-srv--on">MC</span>
                <span className="ctp-srv">GN<b className="ctp-badge">3</b></span>
                <span className="ctp-srv">AR</span>
                <span className="ctp-srv ctp-srv--add"><Plus size={12} strokeWidth={3} /></span>
            </div>
            <div className="ctp-list" aria-hidden="true">
                <div className="ctp-list-head">Maker Collective</div>
                <div className="ctp-cat">Text</div>
                <div className="ctp-ch ctp-ch--on"><Hash size={11} />general</div>
                <div className="ctp-ch ctp-ch--unread"><Hash size={11} />design<b className="ctp-pill">2</b></div>
                <div className="ctp-ch"><Hash size={11} />random</div>
                <div className="ctp-cat">Voice</div>
                <div className="ctp-ch"><Volume2 size={11} />Lounge</div>
                <div className="ctp-vc"><i className="ctp-av ctp-av--b" />Rui</div>
                <div className="ctp-leave">Leave server</div>
            </div>
            <div className="ctp-chat" aria-hidden="true">
                <div className="ctp-chat-head">
                    <Hash size={12} /><b>general</b><span className="ctp-topic">Projects and show-and-tell</span>
                    <span className="ctp-head-actions">
                        <span className="ctp-toggle" title="Notifications"><i /></span>
                        <span className="ctp-btn ctp-btn--ghost"><Bell size={10} /></span>
                        <span className="ctp-btn ctp-btn--primary">Invite</span>
                    </span>
                </div>
                <div className="ctp-feed">
                    <div className="ctp-msg">
                        <i className="ctp-av ctp-av--a" />
                        <div className="ctp-body">
                            <div className="ctp-meta"><b className="ctp-name ctp-name--role">Maya</b><span className="ctp-time">Today 9:41</span></div>
                            <p>New colours are live. Notes at <span className="ctp-link">cipherline.chat/themes</span></p>
                        </div>
                    </div>
                    <div className="ctp-msg ctp-msg--mention">
                        <i className="ctp-av ctp-av--b" />
                        <div className="ctp-body">
                            <div className="ctp-meta"><b className="ctp-name">Rui</b><span className="ctp-time">Today 9:43</span></div>
                            <p><span className="ctp-mention">@you</span> can you check the <code className="ctp-code">palette</code> diff?</p>
                            <pre className="ctp-pre"><span className="ctp-kw">const</span> theme = <span className="ctp-fn">derive</span>(<span className="ctp-str">'knobs'</span>);</pre>
                        </div>
                    </div>
                    <div className="ctp-msg">
                        <i className="ctp-av ctp-av--c" />
                        <div className="ctp-body">
                            <div className="ctp-meta"><b className="ctp-name">You</b><span className="ctp-time">Today 9:44</span></div>
                            <p>Looks great. Saving it now.</p>
                        </div>
                    </div>
                </div>
                <div className="ctp-composer"><span>Message #general</span><span className="ctp-send"><Send size={10} /></span></div>
                <div className="ctp-toast"><span className="ctp-toast-ic"><Check size={10} strokeWidth={3} /></span><span><b>Theme saved</b><em>Applied on this device</em></span></div>
            </div>
            <div className="ctp-members" aria-hidden="true">
                <div className="ctp-cat">Online — 3</div>
                <div className="ctp-mem"><i className="ctp-av ctp-av--a"><b className="ctp-dot ctp-dot--ok" /></i><span className="ctp-name--role">Maya</span><ShieldCheck size={11} className="ctp-verified" /></div>
                <div className="ctp-mem"><i className="ctp-av ctp-av--b"><b className="ctp-dot ctp-dot--idle" /></i><span>Rui</span></div>
                <div className="ctp-mem"><i className="ctp-av ctp-av--c"><b className="ctp-dot ctp-dot--dnd" /></i><span>You</span></div>
                <div className="ctp-cat">Offline — 1</div>
                <div className="ctp-mem ctp-mem--off"><i className="ctp-av ctp-av--d"><b className="ctp-dot ctp-dot--off" /></i><span>Ana</span></div>
                <div className="ctp-danger-btn">Delete</div>
            </div>
        </div>
    );
};

/** The natural size the thumbnail lays the preview out at before scaling it. */
export const THEME_THUMB_STAGE = { width: 560, height: 315 } as const;

/**
 * The preview as a fixed 16:9 thumbnail (the theme-link card, the website):
 * laid out at THEME_THUMB_STAGE (so every panel keeps its real proportions —
 * rail, channel list, chat, member list) and scaled down to fit `maxWidth` or
 * the space it is given, whichever is smaller. A CSS transform keeps text and
 * edges vector-sharp at any device pixel ratio.
 */
export const ThemePreviewThumb: React.FC<{ theme: Theme; maxWidth: number; label?: string }> = ({ theme, maxWidth, label }) => {
    const ref = useRef<HTMLDivElement>(null);
    const [avail, setAvail] = useState(maxWidth);
    useLayoutEffect(() => {
        const host = ref.current?.parentElement;
        if (!host || typeof ResizeObserver === 'undefined') return;
        const measure = () => { const w = host.clientWidth; if (w > 0) setAvail(w); };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(host);
        return () => ro.disconnect();
    }, []);
    const width = Math.max(160, Math.min(maxWidth, avail));
    const scale = width / THEME_THUMB_STAGE.width;
    return (
        <div ref={ref} className="ctp-thumb" style={{ width, height: Math.round(THEME_THUMB_STAGE.height * scale) }}>
            <div className="ctp-thumb-stage" style={{ transform: `scale(${scale})` }}>
                <CustomThemePreview theme={theme} label={label} compact />
            </div>
        </div>
    );
};

/** A thumbnail of a theme for the picker tiles (same classes as ThemePicker's `Mini`). */
export const CustomThemeMini: React.FC<{ theme: Theme }> = ({ theme }) => {
    const p = theme.palette;
    const style = {
        '--tp-abyss': p.abyss, '--tp-deep': p.deep, '--tp-surface': p.surface, '--tp-raise': p.raise,
        '--tp-border': p.border, '--tp-text': p.text, '--tp-muted': p.muted, '--tp-faint': p.faint,
        '--tp-lume': p.lume, '--tp-lume-text': p['lume-text'], '--tp-flash': p.flash,
    } as React.CSSProperties;
    return (
        <span className="tp-mini" style={style} aria-hidden="true">
            <span className="tp-rail"><i className="tp-dot tp-dot--on" /><i className="tp-dot" /><i className="tp-dot" /></span>
            <span className="tp-list"><i className="tp-line tp-line--on" /><i className="tp-line" /><i className="tp-line tp-line--short" /></span>
            <span className="tp-chat">
                <i className="tp-msg"><b /><em /></i>
                <i className="tp-msg"><b className="tp-name--lume" /><em className="tp-em--short" /></i>
                <i className="tp-compose" />
            </span>
        </span>
    );
};
