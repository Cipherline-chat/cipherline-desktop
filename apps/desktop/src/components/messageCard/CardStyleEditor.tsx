/**
 * The card editor: what "Style this message" opens, and what Settings →
 * Appearance → Message styles uses to create or change a saved style.
 *
 * Crafting a post, not picking a theme: a roomy editor with a LIVE preview of
 * the card at real width (the same MessageCard + shared resolver the chat
 * uses, with the message's own text and formatting), templates and "My
 * styles" to start from, a visual editor, and an "Edit as CSS" box. Both
 * editors produce the same validated object (packages/shared/card-style.ts):
 * the visual one edits the object and shows its CSS; the CSS box parses
 * through the strict allowlist and lists every declaration as accepted,
 * adjusted or ignored, with the reason. Readability notes (a text colour
 * nudged, a background dropped) come from the same resolver the readers run.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Pencil, Trash2, Save, AlertTriangle, CircleSlash, Info } from 'lucide-react';
import {
    CARD_ANIMATIONS, CARD_BORDER_STYLES, CARD_LIMITS, CARD_PADDINGS, CARD_STRIPE_LIMITS,
    cardStyleToCss, normalizeCardStyle, parseCardStyleCss, sameCardStyle,
    type CardAlign, type CardAnimationName, type CardBackground, type CardBorderStyle, type CardColor,
    type CardCssDeclarationReport, type CardGradientStop, type CardPadding, type CardShadow, type CardStyle,
} from '@cipherline/shared';
import { ClButton } from '../ClButton';
import { ClSlider } from '../ClSlider';
import { ClSegment } from '../cl';
import { MessageCard } from './MessageCard';
import { CardColorField } from './CardColorField';
import { renderFormatted } from '../formatting/FormattedText';
import { resolveCard } from '../../utils/cardStyle/cardStyleReact';
import { CARD_STYLE_TEMPLATES } from '../../utils/cardStyle/cardStyleTemplates';
import type { LibraryCardStyle } from '../../hooks/useCardStylePrefs';
import '../../styles/card-style-editor.css';

export interface CardStyleLibraryApi {
    items: LibraryCardStyle[];
    save: (name: string, style: CardStyle) => LibraryCardStyle | null;
    rename: (id: string, name: string) => boolean;
    remove: (id: string) => boolean;
}

export interface CardStyleEditorProps {
    value: CardStyle | null;
    onChange: (s: CardStyle | null) => void;
    /** The message being written (composer syntax), shown in the preview. */
    previewText: string;
    previewName: string;
    /** The message's font stack (formatting bar), so the preview matches. */
    previewFont?: string;
    library?: CardStyleLibraryApi;
    /** Settings: no "start from" column, just design + preview. */
    compact?: boolean;
}


type BgKind = 'none' | 'solid' | 'gradient' | 'pattern';
const bgKindOf = (bg: CardBackground | undefined): BgKind => !bg ? 'none' : bg.type === 'solid' ? 'solid' : bg.type.startsWith('repeating-') ? 'pattern' : 'gradient';

/** Pattern presets: generated from two colours and a size, as repeating gradients. */
const PATTERNS = {
    stripes: (a: CardColor, b: CardColor, size: number): CardBackground => ({ type: 'repeating-linear', angle: 45, stops: [{ color: a, at: 0 }, { color: a, at: size / 2 }, { color: b, at: size / 2 }, { color: b, at: size }] }),
    rings: (a: CardColor, b: CardColor, size: number): CardBackground => ({ type: 'repeating-radial', shape: 'circle', stops: [{ color: a, at: 0 }, { color: a, at: size / 2 }, { color: b, at: size / 2 }, { color: b, at: size }] }),
};

const ANIM_HINT: Record<CardAnimationName, string> = {
    drift: 'Slowly shifts a gradient background',
    pulse: 'The shadow breathes',
    shimmer: 'A faint light sweeps across',
};

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
    return (
        <div className="cse-row">
            <div className="cse-row-label">
                <span>{label}</span>
                {hint && <small>{hint}</small>}
            </div>
            <div className="cse-row-ctl">{children}</div>
        </div>
    );
}

function Chips<T extends string>({ value, options, onChange, label }: { value: T; options: readonly { v: T; label: string; disabled?: boolean; hint?: string }[]; onChange: (v: T) => void; label: string }) {
    return (
        <div className="cse-chips" role="radiogroup" aria-label={label}>
            {options.map(o => (
                <button
                    key={o.v}
                    type="button"
                    role="radio"
                    aria-checked={value === o.v}
                    disabled={o.disabled}
                    title={o.hint}
                    className="cse-chip"
                    data-value={o.v}
                    onClick={() => onChange(o.v)}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

function Slider({ label, value, min, max, step = 1, unit = 'px', onChange, resetValue }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (n: number) => void; resetValue?: number }) {
    return (
        <ClSlider value={value} min={min} max={max} step={step} onChange={onChange} ariaLabel={label} resetValue={resetValue}
            formatLabel={(v) => `${+v.toFixed(step < 1 ? 1 : 0)}${unit}`} className="cse-slider" />
    );
}

/** The live preview: a real chat row with the real card around the real formatted text. */
export function CardPreviewRow({ style, text, name, font, kind }: { style: CardStyle | null; text: string; name: string; font?: string; kind: 'channel' | 'dm' }) {
    const resolved = resolveCard(style, 'full');
    const body = text.trim() ? text : 'Your message';
    return (
        <div className="cse-preview-row" data-kind={kind}>
            <div className="cse-preview-avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</div>
            <div className="cse-preview-main">
                <div className="cse-preview-head">
                    <b>{name}</b>
                    <span>Today at 9:41 PM</span>
                </div>
                <MessageCard resolved={resolved}>
                    <div className="cse-preview-body" style={{ fontFamily: font, ...(resolved?.textColor ? { color: resolved.textColor } : {}) }}>
                        {renderFormatted(body, { renderLeaf: (leaf) => leaf })}
                    </div>
                </MessageCard>
            </div>
        </div>
    );
}

/** Gradient stops: one compact row each (colour, position, remove), plus "Add a colour". */
function StopRows({ stops, label, onChange }: { stops: CardGradientStop[]; label: string; onChange: (s: CardGradientStop[]) => void }) {
    const even = (list: CardGradientStop[]) => list.map((x, j) => ({ ...x, at: Math.round((j / (list.length - 1)) * 100) }));
    return (
        <div className="cse-stops">
            {stops.map((st, i) => (
                <div className="cse-stop" key={i}>
                    <span className="cse-stop-label">{i === 0 ? 'From' : i === stops.length - 1 ? 'To' : `Via ${i}`}</span>
                    <CardColorField label={`${label} ${i + 1}`} value={st.color} noAlpha onChange={(c) => onChange(stops.map((x, j) => (j === i ? { ...x, color: c } : x)))} />
                    <Slider label={`${label} ${i + 1} position`} value={st.at} min={0} max={100} unit="%" onChange={(n) => onChange(stops.map((x, j) => (j === i ? { ...x, at: n } : x)))} />
                    {stops.length > CARD_LIMITS.stops.min
                        ? <button type="button" className="cse-icon-btn" aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} onClick={() => onChange(even(stops.filter((_, j) => j !== i)))}><Trash2 size={14} /></button>
                        : <span />}
                </div>
            ))}
            {stops.length < CARD_LIMITS.stops.max && (
                <button type="button" className="cse-add" onClick={() => onChange(even([...stops, { color: stops[stops.length - 1].color, at: 100 }]))}>+ Add a colour</button>
            )}
        </div>
    );
}

function Report({ items, error }: { items: CardCssDeclarationReport[]; error?: string }) {
    if (error) return <p className="cse-report-error" role="alert"><AlertTriangle size={14} /> {error}</p>;
    if (items.length === 0) return <p className="cse-report-empty">Write declarations like <code>background: linear-gradient(135deg, #1d2b64, #0f3b3a);</code></p>;
    return (
        <ul className="cse-report" aria-label="What was accepted">
            {items.map((d, i) => (
                <li key={i} data-status={d.status}>
                    <span className="cse-report-icon" aria-hidden="true">
                        {d.status === 'accepted' ? <Check size={13} /> : d.status === 'adjusted' ? <Info size={13} /> : <CircleSlash size={13} />}
                    </span>
                    <code>{d.text}</code>
                    <span className="cse-report-status">{d.status === 'accepted' ? 'Accepted' : d.status === 'adjusted' ? 'Adjusted' : d.status === 'overridden' ? 'Replaced later' : 'Ignored'}</span>
                    {d.reason && <span className="cse-report-reason">{d.reason}</span>}
                </li>
            ))}
        </ul>
    );
}

export const CardStyleEditor: React.FC<CardStyleEditorProps> = ({ value, onChange, previewText, previewName, previewFont, library, compact }) => {
    const style = value;
    const [tab, setTab] = useState<'design' | 'css'>('design');
    const [cssText, setCssText] = useState(() => cardStyleToCss(style));
    const cssFocused = useRef(false);
    const [saveName, setSaveName] = useState('');
    const [renaming, setRenaming] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');

    // The CSS box follows the visual editor, except while the user is typing in it.
    useEffect(() => { if (!cssFocused.current) setCssText(cardStyleToCss(style)); }, [style]);
    const parsed = useMemo(() => parseCardStyleCss(cssText), [cssText]);
    const resolved = resolveCard(style, 'full');

    const set = (patch: Partial<CardStyle>, drop: (keyof CardStyle)[] = []) => {
        const base: Record<string, unknown> = { ...(style ?? { v: 1 }), ...patch };
        for (const k of drop) delete base[k];
        onChange(normalizeCardStyle(base));
    };

    const bg = style?.background;
    const bgKind = bgKindOf(bg);
    const border = style?.border;
    const borderKind: 'none' | 'colour' | 'gradient' = !border ? 'none' : 'gradient' in border ? 'gradient' : 'colour';
    const radius = style?.radius;
    const perCorner = Array.isArray(radius);
    const shadows: CardShadow[] = style?.shadows ?? [];
    const hasGradientBg = !!bg && bg.type !== 'solid';

    const design = (
        <div className="cse-design">
            <section className="cse-sec" aria-labelledby="cse-bg-h">
                <h4 id="cse-bg-h">Background</h4>
                <Chips label="Background" value={bgKind} onChange={(k) => {
                    if (k === 'none') return set({}, ['background', 'backgroundOpacity']);
                    if (k === 'solid') return set({ background: { type: 'solid', color: bg?.type === 'solid' ? bg.color : '#131a30' } });
                    if (k === 'gradient') return set({ background: { type: 'linear', angle: 135, stops: [{ color: '#1d2b64', at: 0 }, { color: '#0f3b3a', at: 100 }] } });
                    return set({ background: PATTERNS.stripes('#ffffff0d', '#00000000', 10) });
                }} options={[{ v: 'none', label: 'None' }, { v: 'solid', label: 'Colour' }, { v: 'gradient', label: 'Gradient' }, { v: 'pattern', label: 'Pattern' }]} />
                {bg?.type === 'solid' && (
                    <CardColorField label="Background colour" value={bg.color} onChange={(c) => set({ background: { type: 'solid', color: c } })} />
                )}
                {bg && bg.type !== 'solid' && bgKind === 'gradient' && (
                    <>
                        <Row label="Shape">
                            <Chips label="Gradient shape" value={bg.type as 'linear' | 'radial'} onChange={(t) => set({ background: t === 'linear' ? { type: 'linear', angle: 135, stops: bg.stops } : { type: 'radial', shape: 'ellipse', stops: bg.stops } })}
                                options={[{ v: 'linear', label: 'Linear' }, { v: 'radial', label: 'Radial' }]} />
                        </Row>
                        {'angle' in bg && (
                            <Row label="Angle">
                                <Slider label="Gradient angle" value={bg.angle} min={0} max={359} unit="°" onChange={(a) => set({ background: { ...bg, angle: a } })} />
                            </Row>
                        )}
                        <StopRows
                            stops={bg.stops}
                            label="Gradient colour"
                            onChange={(stops) => set({ background: { ...bg, stops } as CardBackground })}
                        />
                    </>
                )}
                {bg && bgKind === 'pattern' && bg.type !== 'solid' && (
                    <>
                        <Row label="Pattern">
                            <Chips label="Pattern" value={bg.type === 'repeating-radial' ? 'rings' : 'stripes'} onChange={(p) => set({ background: PATTERNS[p](bg.stops[0].color, bg.stops[bg.stops.length - 1].color, bg.stops[bg.stops.length - 1].at) })}
                                options={[{ v: 'stripes', label: 'Stripes' }, { v: 'rings', label: 'Rings' }]} />
                        </Row>
                        <Row label="Colours">
                            <CardColorField label="Pattern colour" value={bg.stops[0].color} onChange={(c) => set({ background: PATTERNS[bg.type === 'repeating-radial' ? 'rings' : 'stripes'](c, bg.stops[bg.stops.length - 1].color, bg.stops[bg.stops.length - 1].at) })} />
                        </Row>
                        <Row label="Between">
                            <CardColorField label="Pattern gap colour" value={bg.stops[bg.stops.length - 1].color} onChange={(c) => set({ background: PATTERNS[bg.type === 'repeating-radial' ? 'rings' : 'stripes'](bg.stops[0].color, c, bg.stops[bg.stops.length - 1].at) })} />
                        </Row>
                        <Row label="Size">
                            <Slider label="Pattern size" value={bg.stops[bg.stops.length - 1].at} min={CARD_LIMITS.repeatPeriodMin} max={30} unit="%" onChange={(n) => set({ background: PATTERNS[bg.type === 'repeating-radial' ? 'rings' : 'stripes'](bg.stops[0].color, bg.stops[bg.stops.length - 1].color, n) })} />
                        </Row>
                    </>
                )}
                {bg && (
                    <Row label="Opacity">
                        <Slider label="Background opacity" value={style?.backgroundOpacity ?? 100} min={0} max={100} unit="%" onChange={(n) => set({ backgroundOpacity: n })} />
                    </Row>
                )}
            </section>

            <section className="cse-sec" aria-labelledby="cse-border-h">
                <h4 id="cse-border-h">Border</h4>
                <Chips label="Border" value={borderKind} onChange={(k) => {
                    if (k === 'none') return set({}, ['border']);
                    if (k === 'colour') return set({ border: { width: 1, style: 'solid', color: 'theme(accent / 40%)' } });
                    return set({ border: { width: 2, style: 'solid', gradient: { angle: 135, stops: [{ color: 'theme(accent)', at: 0 }, { color: '#a78bfa', at: 100 }] } } });
                }} options={[{ v: 'none', label: 'None' }, { v: 'colour', label: 'Colour' }, { v: 'gradient', label: 'Gradient' }]} />
                {border && 'color' in border && (
                    <>
                        <Row label="Width" hint={Array.isArray(border.width) ? 'Top, right, bottom, left' : undefined}>
                            {Array.isArray(border.width)
                                ? (['Top', 'Right', 'Bottom', 'Left'] as const).map((side, i) => (
                                    <Slider key={side} label={`${side} border width`} value={(border.width as number[])[i]} min={0} max={CARD_LIMITS.borderWidth.max}
                                        onChange={(n) => set({ border: { ...border, width: (border.width as number[]).map((x, j) => (j === i ? n : x)) as [number, number, number, number] } })} />
                                ))
                                : <Slider label="Border width" value={border.width} min={1} max={CARD_LIMITS.borderWidth.max} onChange={(n) => set({ border: { ...border, width: n } })} />}
                            <label className="cse-check">
                                <input type="checkbox" checked={Array.isArray(border.width)} onChange={(e) => {
                                    const w = Array.isArray(border.width) ? border.width[0] : border.width;
                                    set({ border: { ...border, width: e.target.checked ? [w, w, w, w] : w } });
                                }} /> Per side
                            </label>
                        </Row>
                        <Row label="Style">
                            <Chips label="Border style" value={border.style} onChange={(st: CardBorderStyle) => set({ border: { ...border, style: st } })}
                                options={CARD_BORDER_STYLES.map(v => ({ v, label: v[0].toUpperCase() + v.slice(1) }))} />
                        </Row>
                        <Row label="Colour">
                            <CardColorField label="Border colour" value={Array.isArray(border.color) ? border.color[0] : border.color} onChange={(c) => set({ border: { ...border, color: c } })} />
                        </Row>
                    </>
                )}
                {border && 'gradient' in border && (
                    <>
                        <Row label="Width"><Slider label="Border width" value={border.width} min={1} max={CARD_LIMITS.borderWidth.max} onChange={(n) => set({ border: { ...border, width: n } })} /></Row>
                        <Row label="Angle"><Slider label="Border gradient angle" value={border.gradient.angle} min={0} max={359} unit="°" onChange={(a) => set({ border: { ...border, gradient: { ...border.gradient, angle: a } } })} /></Row>
                        <StopRows
                            stops={border.gradient.stops}
                            label="Border colour"
                            onChange={(stops) => set({ border: { ...border, gradient: { ...border.gradient, stops } } })}
                        />
                    </>
                )}
            </section>

            <section className="cse-sec" aria-labelledby="cse-shape-h">
                <h4 id="cse-shape-h">Shape</h4>
                <Row label="Corners" hint={perCorner ? 'Top-left, top-right, bottom-right, bottom-left' : undefined}>
                    {perCorner
                        ? (['Top-left', 'Top-right', 'Bottom-right', 'Bottom-left'] as const).map((c, i) => (
                            <Slider key={c} label={`${c} corner`} value={(radius as number[])[i]} min={0} max={CARD_LIMITS.radius.max}
                                onChange={(n) => set({ radius: (radius as number[]).map((x, j) => (j === i ? n : x)) as [number, number, number, number] })} />
                        ))
                        : <Slider label="Corner radius" value={(radius as number | undefined) ?? 10} min={0} max={CARD_LIMITS.radius.max} onChange={(n) => set({ radius: n })} />}
                    <label className="cse-check">
                        <input type="checkbox" checked={perCorner} onChange={(e) => {
                            const r = Array.isArray(radius) ? radius[0] : (radius ?? 10);
                            set({ radius: e.target.checked ? [r, r, r, r] : r });
                        }} /> Per corner
                    </label>
                </Row>
                <Row label="Padding">
                    <Chips label="Padding" value={style?.padding ?? 'cozy'} onChange={(p: CardPadding) => set({ padding: p })}
                        options={CARD_PADDINGS.map(v => ({ v, label: v[0].toUpperCase() + v.slice(1) }))} />
                </Row>
            </section>

            <section className="cse-sec" aria-labelledby="cse-shadow-h">
                <h4 id="cse-shadow-h">Glow &amp; shadow</h4>
                {shadows.map((sh, i) => (
                    <div className="cse-sub" key={i}>
                        <Row label={i === 0 ? 'Shadow 1' : 'Shadow 2'}>
                            <CardColorField label={`Shadow ${i + 1} colour`} value={sh.color} onChange={(c) => set({ shadows: shadows.map((x, j) => (j === i ? { ...x, color: c } : x)) })} />
                            <button type="button" className="cse-icon-btn" aria-label={`Remove shadow ${i + 1}`} onClick={() => set(shadows.length > 1 ? { shadows: shadows.filter((_, j) => j !== i) } : {}, shadows.length > 1 ? [] : ['shadows'])}><Trash2 size={14} /></button>
                        </Row>
                        <Row label="Blur"><Slider label={`Shadow ${i + 1} blur`} value={sh.blur} min={0} max={CARD_LIMITS.shadowBlur.max} onChange={(n) => set({ shadows: shadows.map((x, j) => (j === i ? { ...x, blur: n } : x)) })} /></Row>
                        <Row label="Spread"><Slider label={`Shadow ${i + 1} spread`} value={sh.spread} min={0} max={CARD_LIMITS.shadowSpread.max} onChange={(n) => set({ shadows: shadows.map((x, j) => (j === i ? { ...x, spread: n } : x)) })} /></Row>
                        <Row label="Offset"><Slider label={`Shadow ${i + 1} vertical offset`} value={sh.y} min={CARD_LIMITS.shadowOffset.min} max={CARD_LIMITS.shadowOffset.max} onChange={(n) => set({ shadows: shadows.map((x, j) => (j === i ? { ...x, y: n } : x)) })} /></Row>
                    </div>
                ))}
                {shadows.length < CARD_LIMITS.shadows.max && (
                    <button type="button" className="cse-add" onClick={() => set({ shadows: [...shadows, shadows.length === 0 ? { x: 0, y: 0, blur: 12, spread: 0, color: 'theme(accent / 30%)' } : { x: 0, y: 4, blur: 14, spread: 0, color: '#00000066' }] })}>
                        + {shadows.length === 0 ? 'Add a glow' : 'Add a drop shadow'}
                    </button>
                )}
            </section>

            <section className="cse-sec" aria-labelledby="cse-text-h">
                <h4 id="cse-text-h">Text</h4>
                <Row label="Colour" hint={resolved?.notes.textAdjusted ? `Adjusted for readability (was ${resolved.notes.textAdjusted.ratio}:1)` : 'Readers always see it at 3:1 or better'}>
                    <Chips label="Text colour" value={style?.text ? 'custom' : 'auto'} onChange={(v) => (v === 'auto' ? set({}, ['text']) : set({ text: '#f4f7ff' }))}
                        options={[{ v: 'auto', label: 'Automatic' }, { v: 'custom', label: 'Custom' }]} />
                    {style?.text && <CardColorField label="Text colour" value={style.text} onChange={(c) => set({ text: c })} />}
                </Row>
                <Row label="Glow">
                    <Chips label="Text glow" value={style?.textGlow ? 'on' : 'off'} onChange={(v) => (v === 'off' ? set({}, ['textGlow']) : set({ textGlow: { color: 'theme(accent / 40%)', blur: 6 } }))}
                        options={[{ v: 'off', label: 'Off' }, { v: 'on', label: 'On' }]} />
                    {style?.textGlow && (
                        <>
                            <CardColorField label="Text glow colour" value={style.textGlow.color} onChange={(c) => set({ textGlow: { ...style.textGlow!, color: c } })} />
                            <Slider label="Text glow blur" value={style.textGlow.blur} min={CARD_LIMITS.textGlowBlur.min} max={CARD_LIMITS.textGlowBlur.max} onChange={(n) => set({ textGlow: { ...style.textGlow!, blur: n } })} />
                        </>
                    )}
                </Row>
                <Row label="Align">
                    <Chips label="Text alignment" value={style?.align ?? 'left'} onChange={(a: CardAlign) => set({ align: a })}
                        options={[{ v: 'left', label: 'Left' }, { v: 'center', label: 'Centre' }, { v: 'right', label: 'Right' }]} />
                </Row>
                <Row label="Headings">
                    <Chips label="Heading alignment" value={style?.headingAlign ?? style?.align ?? 'left'} onChange={(a: CardAlign) => set({ headingAlign: a })}
                        options={[{ v: 'left', label: 'Left' }, { v: 'center', label: 'Centre' }, { v: 'right', label: 'Right' }]} />
                </Row>
                <Row label="Spacing">
                    <Slider label="Letter spacing" value={style?.letterSpacing ?? 0} min={CARD_LIMITS.letterSpacing.min} max={CARD_LIMITS.letterSpacing.max} step={0.1} onChange={(n) => set({ letterSpacing: n })} />
                </Row>
            </section>

            <section className="cse-sec" aria-labelledby="cse-stripe-h">
                <h4 id="cse-stripe-h">Accent stripe</h4>
                <Chips label="Accent stripe" value={style?.stripe ? 'on' : 'off'} onChange={(v) => (v === 'off' ? set({}, ['stripe']) : set({ stripe: { color: 'theme(accent)', width: CARD_STRIPE_LIMITS.default } }))}
                    options={[{ v: 'off', label: 'Off' }, { v: 'on', label: 'On' }]} />
                {style?.stripe && (
                    <>
                        <CardColorField label="Stripe colour" value={style.stripe.color} onChange={(c) => set({ stripe: { ...style.stripe!, color: c } })} noAlpha />
                        <Row label="Width"><Slider label="Stripe width" value={style.stripe.width} min={CARD_STRIPE_LIMITS.min} max={CARD_STRIPE_LIMITS.max} onChange={(n) => set({ stripe: { ...style.stripe!, width: n } })} /></Row>
                    </>
                )}
            </section>

            <section className="cse-sec" aria-labelledby="cse-anim-h">
                <h4 id="cse-anim-h">Animation</h4>
                <Chips label="Animation" value={style?.animation?.name ?? 'none'} onChange={(v) => (v === 'none' ? set({}, ['animation']) : set({ animation: { name: v as CardAnimationName, seconds: style?.animation?.seconds ?? 8 } }))}
                    options={[
                        { v: 'none', label: 'None' },
                        ...CARD_ANIMATIONS.map(a => ({
                            v: a as string, label: a[0].toUpperCase() + a.slice(1), hint: ANIM_HINT[a],
                            disabled: (a === 'drift' && !hasGradientBg) || (a === 'pulse' && shadows.length === 0),
                        })),
                    ]} />
                {style?.animation && (
                    <Row label="Speed" hint="Readers who turn motion off, or ask their OS for less, see it still">
                        <Slider label="Animation length" value={style.animation.seconds} min={CARD_LIMITS.animationSeconds.min} max={CARD_LIMITS.animationSeconds.max} unit="s" onChange={(n) => set({ animation: { ...style.animation!, seconds: n } })} />
                    </Row>
                )}
            </section>
        </div>
    );

    const cssBox = (
        <div className="cse-css">
            <label className="cse-css-label" htmlFor="cse-css-input">Edit as CSS <small>A safe subset: everything stays inside the card.</small></label>
            <textarea
                id="cse-css-input"
                className="cse-css-input"
                spellCheck={false}
                value={cssText}
                onFocus={() => { cssFocused.current = true; }}
                onBlur={() => { cssFocused.current = false; setCssText(cardStyleToCss(style)); }}
                onChange={(e) => {
                    setCssText(e.target.value);
                    onChange(parseCardStyleCss(e.target.value).style);
                }}
                aria-describedby="cse-css-report"
            />
            <div id="cse-css-report"><Report items={parsed.declarations} error={parsed.error} /></div>
        </div>
    );

    const notes = resolved?.notes;
    return (
        <div className={`cse${compact ? ' cse--compact' : ''}`} data-testid="card-style-editor">
            {/* The preview is for looking at: its spoilers / links are inert, so focus
                lands on the controls, not on a preview spoiler. */}
            <div className="cse-preview" aria-label="Preview" inert>
                <CardPreviewRow style={style} text={previewText} name={previewName} font={previewFont} kind="channel" />
            </div>
            {(notes?.textAdjusted || notes?.backgroundDropped || notes?.autoText) && (
                <p className="cse-note" role="status">
                    <Info size={13} />
                    {notes.backgroundDropped ? 'No text colour can be read on this background, so readers see it without the background.'
                        : notes.textAdjusted ? `Text colour adjusted for readability: it was ${notes.textAdjusted.ratio}:1 against the card, so readers see it lightened or darkened to at least 3:1.`
                            : 'The text colour is chosen automatically so it stays readable on this background.'}
                </p>
            )}
            <div className="cse-body">
                {!compact && (
                    <aside className="cse-start" aria-label="Start from">
                        <h4>Templates</h4>
                        <div className="cse-tiles">
                            {CARD_STYLE_TEMPLATES.map(t => (
                                <button key={t.id} type="button" className="cse-tile" data-template={t.id} aria-pressed={sameCardStyle(t.style, style)} title={t.hint} onClick={() => onChange(normalizeCardStyle(t.style))}>
                                    <MessageCard resolved={resolveCard(t.style, 'static')} className="cse-tile-card"><span>{t.label}</span></MessageCard>
                                </button>
                            ))}
                        </div>
                        {library && (
                            <>
                                <h4>My styles</h4>
                                {library.items.length === 0 && <p className="cse-empty">Save a style you like to use it again in one click.</p>}
                                <ul className="cse-lib">
                                    {library.items.map(item => (
                                        <li key={item.id} data-active={sameCardStyle(item.style, style) ? '' : undefined}>
                                            {renaming === item.id ? (
                                                <form className="cse-lib-rename" onSubmit={(e) => { e.preventDefault(); if (library.rename(item.id, renameValue)) setRenaming(null); }}>
                                                    <input autoFocus value={renameValue} maxLength={40} aria-label="Style name" onChange={(e) => setRenameValue(e.target.value)} />
                                                    <button type="submit" className="cse-icon-btn" aria-label="Save name"><Check size={14} /></button>
                                                </form>
                                            ) : (
                                                <>
                                                    <button type="button" className="cse-lib-apply" onClick={() => onChange(item.style)} aria-label={`Use ${item.name}`}>
                                                        <MessageCard resolved={resolveCard(item.style, 'static')} className="cl-msg-card--swatch"><span /></MessageCard>
                                                        <span>{item.name}</span>
                                                    </button>
                                                    <button type="button" className="cse-icon-btn" aria-label={`Rename ${item.name}`} onClick={() => { setRenaming(item.id); setRenameValue(item.name); }}><Pencil size={13} /></button>
                                                    <button type="button" className="cse-icon-btn" aria-label={`Delete ${item.name}`} onClick={() => library.remove(item.id)}><Trash2 size={13} /></button>
                                                </>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                                <form className="cse-save" onSubmit={(e) => { e.preventDefault(); if (style && library.save(saveName || 'My style', style)) setSaveName(''); }}>
                                    <input value={saveName} maxLength={40} placeholder="Name this style" aria-label="Name for the saved style" onChange={(e) => setSaveName(e.target.value)} />
                                    <ClButton size="sm" variant="ghost" type="submit" disabled={!style}><Save size={14} /> Save</ClButton>
                                </form>
                            </>
                        )}
                    </aside>
                )}
                <div className="cse-edit">
                    <ClSegment value={tab} onChange={setTab} options={[{ value: 'design', label: 'Design' }, { value: 'css', label: 'CSS' }]} />
                    {tab === 'design' ? design : cssBox}
                </div>
            </div>
        </div>
    );
};

export default CardStyleEditor;
