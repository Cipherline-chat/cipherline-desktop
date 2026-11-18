/**
 * The composer's formatting controls: an "Aa ^" toggle next to the paperclip
 * and the Slack-style bar it opens above the composer.
 *
 * Purely presentational: every button reports a FormatAction and the composer
 * applies it to the WYSIWYG box (components/composer/RichComposer) — the same
 * call the Ctrl/Cmd shortcuts make, so a click and a shortcut can never
 * disagree. Buttons show as pressed (aria-pressed) when their style is on at
 * the caret / across the selection. The font picker reports a MessageFont and
 * the size picker a span size (null = normal) for the selection or what is
 * typed next, and shows the size at the caret or "Mixed"; both are per
 * message (the composer resets them after a send).
 *
 * Keyboard (WAI-ARIA toolbar pattern): Tab enters the bar on its current
 * button, Left/Right/Home/End move between buttons, Escape closes the bar and
 * returns to the text box. Buttons keep the text box's selection on mouse use
 * (mousedown is swallowed), and every button names its shortcut in its
 * tooltip and in aria-keyshortcuts.
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { placeMenu, menuBounds, type MenuPlacement } from './menuPlacement';
import { ChevronUp, ChevronDown, Check, X, SquareDashed } from 'lucide-react';
import { TOOL_GROUPS, TOOL_HINTS, headingIconFor, isActionActive, type ToolDef } from './formatTools';
import { useClTooltip } from '../cl';
import { useEscape } from '../../hooks/useEscape';
import type { MessageFont, MessageSize } from '@cipherline/shared';
import { ariaShortcut, shortcutLabel, type FormatAction } from '../../utils/formatting/composerFormat';
import { FONT_OPTIONS, fontLabelFor, fontStackFor } from '../../utils/formatting/messageFont';
import { SIZE_OPTIONS, sizeLabelFor } from '../../utils/formatting/messageSize';
import type { ActiveFormats } from './RichComposer';
import type { ResolvedCardStyle } from '@cipherline/shared';
import { MessageCard } from '../messageCard/MessageCard';
import '../../styles/formatting.css';

/** A tiny live card (static: no animation) for the bar button and the composer chip. */
function CardSwatch({ resolved }: { resolved: ResolvedCardStyle | null }) {
    return (
        <span className="fmt-card-swatch" aria-hidden="true">
            {resolved
                ? <MessageCard resolved={{ ...resolved, padding: [0, 0], stripe: resolved.stripe ? { ...resolved.stripe, width: Math.min(resolved.stripe.width, 3) } : undefined }} className="cl-msg-card--swatch"><span /></MessageCard>
                : <SquareDashed size={15} strokeWidth={2.2} />}
        </span>
    );
}

const TOGGLES: ReadonlySet<FormatAction> = new Set<FormatAction>(['bold', 'italic', 'underline', 'strike', 'spoiler', 'code', 'bullet', 'number', 'quote', 'heading', 'codeBlock']);

function ToolButton({ tool, index, isMac, tabIndex, pressed, icon, onAction, register, onFocusIndex }: {
    tool: ToolDef;
    /** Overrides tool.icon (the heading button shows the level at the caret). */
    icon?: React.ReactNode;
    index: number;
    isMac: boolean;
    tabIndex: number;
    pressed: boolean;
    onAction: (a: FormatAction, viaKeyboard: boolean) => void;
    /** STABLE (useCallback) — a new ref callback every render would detach and close the tooltip. */
    register: (index: number, el: HTMLButtonElement | null) => void;
    onFocusIndex: (index: number) => void;
}) {
    const keys = shortcutLabel(tool.action, isMac);
    const tipText = [tool.label, keys, TOOL_HINTS[tool.action]].filter(Boolean).join(' · ');
    const tip = useClTooltip(tipText);
    const tipRef = tip.anchorProps.ref;
    const setRef = useCallback((el: HTMLButtonElement | null) => { tipRef(el); register(index, el); }, [tipRef, register, index]);
    return (
        <>
            <button
                {...tip.anchorProps}
                ref={setRef}
                type="button"
                className="fmt-btn"
                data-action={tool.action}
                aria-label={tool.label}
                aria-pressed={TOGGLES.has(tool.action) ? pressed : undefined}
                aria-keyshortcuts={ariaShortcut(tool.action, isMac)}
                aria-describedby={tip.describedBy}
                tabIndex={tabIndex}
                onMouseDown={(e) => e.preventDefault()}
                onFocus={(e) => { tip.anchorProps.onFocus(e); onFocusIndex(index); }}
                onClick={(e) => onAction(tool.action, e.detail === 0)}
            >
                {icon ?? tool.icon}
            </button>
            {tip.tooltip}
        </>
    );
}

interface MenuOption<T> { id: T | null; label: string; hint: string; style?: React.CSSProperties; attrs?: Record<string, string | undefined>; nameAttrs?: Record<string, string | undefined> }

/** A `menuitemradio` menu (the font and size pickers): arrows, Home/End, Escape, Tab. */
function OptionMenu<T extends string>({ label, options, value, onPick, onClose, returnFocus, buttonAttr }: {
    label: string;
    options: readonly MenuOption<T>[];
    /** The checked option; undefined = none (a mixed selection). */
    value: T | null | undefined;
    onPick: (v: T | null) => void;
    onClose: () => void;
    returnFocus: () => void;
    /** The attribute marking this menu's own button (a click on it is not "outside"). */
    buttonAttr: string;
}) {
    const items = useRef<(HTMLButtonElement | null)[]>([]);
    const menuRef = useRef<HTMLDivElement>(null);
    // Keep the menu inside the chat pane (narrow windows wrap the bar and put
    // this button at the left of a row): measured once it has rendered.
    const [place, setPlace] = useState<MenuPlacement | null>(null);
    useLayoutEffect(() => {
        const m = menuRef.current;
        const anchor = m?.parentElement;
        if (!m || !anchor) return;
        const measure = () => {
            const r = m.getBoundingClientRect();
            const a = anchor.getBoundingClientRect();
            setPlace(placeMenu({ width: m.scrollWidth || r.width, height: m.scrollHeight || r.height }, a, menuBounds(anchor)));
        };
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, []);
    const placeStyle: React.CSSProperties | undefined = place ? {
        // `left`, not a transform: the menu's entry animation owns `transform`.
        ...(place.align === 'left' ? { right: 'auto', left: Math.round(place.shiftX) } : {}),
        ...(place.maxWidth != null ? { maxWidth: place.maxWidth, minWidth: 0 } : {}),
        ...(place.maxHeight != null ? { maxHeight: place.maxHeight, overflowY: 'auto' } : {}),
    } : undefined;
    const current = Math.max(0, options.findIndex(o => o.id === value));
    // Escape goes through the app's escape stack (a capture-phase listener), so
    // the menu closes before anything underneath it does.
    useEscape(() => { onClose(); returnFocus(); });
    useEffect(() => { items.current[current]?.focus(); }, [current]);
    useEffect(() => {
        const away = (e: PointerEvent) => {
            const t = e.target as Node | null;
            if (menuRef.current && t && !menuRef.current.contains(t) && !(t instanceof Element && t.closest(`[${buttonAttr}]`))) onClose();
        };
        document.addEventListener('pointerdown', away, true);
        return () => document.removeEventListener('pointerdown', away, true);
    }, [onClose, buttonAttr]);
    const onKeyDown = (e: React.KeyboardEvent) => {
        const at = items.current.findIndex(el => el === document.activeElement);
        const n = options.length;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            items.current[(at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n]?.focus();
        } else if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            items.current[e.key === 'Home' ? 0 : n - 1]?.focus();
        } else if (e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
            returnFocus();
        }
    };
    return (
        <div ref={menuRef} className="fmt-menu" role="menu" aria-label={label} onKeyDown={onKeyDown} style={placeStyle} data-align={place?.align ?? 'right'}>
            <div className="fmt-menu-label" aria-hidden="true">{label}</div>
            {options.map((o, i) => (
                <button
                    key={o.id ?? 'default'}
                    ref={(el) => { items.current[i] = el; }}
                    type="button"
                    role="menuitemradio"
                    aria-checked={o.id === value}
                    className="fmt-menu-item"
                    {...o.attrs}
                    tabIndex={i === current ? 0 : -1}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onPick(o.id)}
                >
                    <span>
                        <span className="fmt-menu-name" {...o.nameAttrs} style={o.style}>{o.label}</span>
                        <span className="fmt-menu-hint">{o.hint}</span>
                    </span>
                    {o.id === value && <Check size={15} strokeWidth={2.6} className="fmt-menu-check" aria-hidden="true" />}
                </button>
            ))}
        </div>
    );
}

const FONT_MENU: readonly MenuOption<MessageFont>[] = FONT_OPTIONS.map(o => ({
    id: o.id, label: o.label, hint: o.hint, style: { fontFamily: o.stack },
    attrs: { 'data-font-id': o.id ?? 'default' },
    nameAttrs: { 'data-msg-font': o.id ?? undefined },
}));
const SIZE_MENU: readonly MenuOption<MessageSize>[] = SIZE_OPTIONS.map(o => ({
    id: o.id, label: o.label, hint: o.hint, style: { fontSize: `${+(15 * o.scale).toFixed(2)}px` },
    attrs: { 'data-size-id': o.id ?? 'normal' },
}));

export interface FormatToolbarProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Apply an action to the text box. `viaKeyboard`: the bar had focus (the composer moves it back). */
    onAction: (action: FormatAction, viaKeyboard: boolean) => void;
    /** What is on at the caret (pressed buttons). */
    active?: ActiveFormats | null;
    font: MessageFont | null;
    onFontChange: (font: MessageFont | null) => void;
    /** Size at the caret / across the selection, or 'mixed'. */
    size?: MessageSize | null | 'mixed';
    onSizeChange?: (size: MessageSize | null) => void;
    /** Where Escape and a finished keyboard action send focus. */
    focusComposer: () => void;
    isMac: boolean;
    disabled?: boolean;
    /**
     * "Style this message" (utils/cardStyle/composerCardStyle.ts): a
     * deliberate, per-message card. `label` / `preview` describe the style the
     * message being written carries (null = none); `onOpen` opens the card
     * editor; `onClear` removes the style. Absent = styling isn't offered here
     * (the composer gate said no). When the message is styled, a chip beside
     * "Aa" says so even with the bar closed.
     */
    card?: { label: string | null; preview: ResolvedCardStyle | null; onOpen: () => void; onClear: () => void };
}

/**
 * The "Aa" toggle plus, when open, the bar. Render it inside the composer
 * <form> (which is `position: relative`): the bar positions itself above it.
 */
export const FormatToolbar: React.FC<FormatToolbarProps> = ({ open, onOpenChange, onAction, active, font, onFontChange, size = null, onSizeChange, focusComposer, isMac, disabled, card }) => {
    const barId = useId();
    const flat = TOOL_GROUPS.flat();
    const btns = useRef<(HTMLButtonElement | null)[]>([]);
    const fontBtn = useRef<HTMLButtonElement | null>(null);
    const sizeBtn = useRef<HTMLButtonElement | null>(null);
    const cardBtn = useRef<HTMLButtonElement | null>(null);
    const [activeIdx, setActiveIdx] = useState(0);
    const [menu, setMenu] = useState<'font' | 'size' | null>(null);
    const hasSize = !!onSizeChange;
    const hasCard = !!card;
    const cardLabel = card?.label ?? null;
    const cardTip = useClTooltip(cardLabel ? `Card style: ${cardLabel} · this message only` : 'Style this message · a card for rules, announcements and posts that should stand out');
    const toggleTip = useClTooltip(open ? 'Hide formatting' : 'Text formatting');
    const fontTip = useClTooltip(menu === 'font' ? null : `Message font: ${fontLabelFor(font)}`);
    const sizeTip = useClTooltip(menu === 'size' ? null : `Text size: ${sizeLabelFor(size)} · the selected text, or what you type next`);
    const fontIdx = flat.length;
    const sizeIdx = flat.length + 1;
    const cardIdx = flat.length + (hasSize ? 2 : 1);
    const count = flat.length + (hasSize ? 2 : 1) + (hasCard ? 1 : 0);

    const focusAt = useCallback((i: number) => {
        const el = i === fontIdx ? fontBtn.current : i === sizeIdx && hasSize ? sizeBtn.current : i === cardIdx && hasCard ? cardBtn.current : btns.current[i];
        el?.focus();
    }, [fontIdx, sizeIdx, cardIdx, hasSize, hasCard]);

    const onBarKeyDown = (e: React.KeyboardEvent) => {
        if (menu) return;
        let next = -1;
        if (e.key === 'ArrowRight') next = (activeIdx + 1) % count;
        else if (e.key === 'ArrowLeft') next = (activeIdx + count - 1) % count;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = count - 1;
        if (next >= 0) {
            e.preventDefault();
            setActiveIdx(next);
            focusAt(next);
        }
    };

    const closeMenu = useCallback(() => setMenu(null), []);
    const register = useCallback((i: number, el: HTMLButtonElement | null) => { btns.current[i] = el; }, []);
    const fontTipRef = fontTip.anchorProps.ref;
    const setFontRef = useCallback((el: HTMLButtonElement | null) => { fontTipRef(el); fontBtn.current = el; }, [fontTipRef]);
    const sizeTipRef = sizeTip.anchorProps.ref;
    const setSizeRef = useCallback((el: HTMLButtonElement | null) => { sizeTipRef(el); sizeBtn.current = el; }, [sizeTipRef]);
    const cardTipRef = cardTip.anchorProps.ref;
    const setCardRef = useCallback((el: HTMLButtonElement | null) => { cardTipRef(el); cardBtn.current = el; }, [cardTipRef]);

    // Escape inside the bar closes it and returns to the text box. Only while
    // focus is IN the bar: with the caret in the text box, Escape keeps its
    // usual meanings (cancel an edit / a reply), and the bar stays put.
    const barRef = useRef<HTMLDivElement>(null);
    useEscape(() => {
        if (!barRef.current?.contains(document.activeElement)) return false;
        onOpenChange(false);
        focusComposer();
        return true;
    }, open && !menu);

    return (
        <>
            <button
                {...toggleTip.anchorProps}
                type="button"
                className="cmp-ico fmt-toggle"
                aria-label="Text formatting"
                aria-expanded={open}
                aria-controls={open ? barId : undefined}
                aria-describedby={toggleTip.describedBy}
                data-font={font ?? undefined}
                disabled={disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { setMenu(null); onOpenChange(!open); }}
            >
                <span className="fmt-toggle-aa" aria-hidden="true">Aa</span>
                <ChevronUp size={12} strokeWidth={2.8} className="fmt-toggle-chev" aria-hidden="true" />
            </button>
            {toggleTip.tooltip}
            {/* This message is styled: say so even with the bar closed. */}
            {card && cardLabel && !open && (
                <span className="cmp-card-chip" data-card-chip="">
                    <button
                        type="button"
                        className="cmp-card-chip-open"
                        aria-label={`Card style: ${cardLabel}. Edit`}
                        disabled={disabled}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={card.onOpen}
                    >
                        <CardSwatch resolved={card.preview} />
                        <span className="cmp-card-chip-label">{cardLabel}</span>
                    </button>
                    <button
                        type="button"
                        className="cmp-card-chip-x"
                        aria-label="Remove the card style from this message"
                        disabled={disabled}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={card.onClear}
                    >
                        <X size={12} strokeWidth={2.6} />
                    </button>
                </span>
            )}

            {open && (
                <div ref={barRef} id={barId} className="fmt-bar" role="toolbar" aria-label="Text formatting" aria-orientation="horizontal" onKeyDown={onBarKeyDown}>
                    {TOOL_GROUPS.map((group, g) => {
                        const offset = TOOL_GROUPS.slice(0, g).reduce((n, gr) => n + gr.length, 0);
                        return (
                            <React.Fragment key={g}>
                                {g > 0 && <span className="fmt-sep" role="separator" aria-orientation="vertical" />}
                                {group.map((tool, j) => {
                                    const idx = offset + j;
                                    return (
                                        <ToolButton
                                            key={tool.action}
                                            tool={tool}
                                            index={idx}
                                            isMac={isMac}
                                            tabIndex={idx === activeIdx ? 0 : -1}
                                            pressed={isActionActive(tool.action, active)}
                                            icon={tool.action === 'heading' ? headingIconFor(active) : undefined}
                                            onFocusIndex={setActiveIdx}
                                            register={register}
                                            onAction={onAction}
                                        />
                                    );
                                })}
                            </React.Fragment>
                        );
                    })}
                    <span className="fmt-sep" role="separator" aria-orientation="vertical" />
                    <span style={{ position: 'relative', display: 'inline-flex' }}>
                        <button
                            {...fontTip.anchorProps}
                            ref={setFontRef}
                            type="button"
                            className="fmt-btn fmt-btn-font"
                            data-font-button=""
                            aria-haspopup="menu"
                            aria-expanded={menu === 'font'}
                            aria-label={`Message font: ${fontLabelFor(font)}`}
                            aria-describedby={fontTip.describedBy}
                            tabIndex={activeIdx === fontIdx ? 0 : -1}
                            onMouseDown={(e) => e.preventDefault()}
                            onFocus={(e) => { fontTip.anchorProps.onFocus(e); setActiveIdx(fontIdx); }}
                            onClick={() => setMenu(m => (m === 'font' ? null : 'font'))}
                            onKeyDown={(e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setMenu('font'); } }}
                            style={{ fontFamily: fontStackFor(font) }}
                        >
                            {fontLabelFor(font)}
                            <ChevronDown size={13} strokeWidth={2.6} aria-hidden="true" />
                        </button>
                        {fontTip.tooltip}
                        {menu === 'font' && (
                            <OptionMenu
                                label="Message font"
                                options={FONT_MENU}
                                value={font}
                                buttonAttr="data-font-button"
                                onClose={closeMenu}
                                returnFocus={() => fontBtn.current?.focus()}
                                onPick={(f) => { onFontChange(f); setMenu(null); focusComposer(); }}
                            />
                        )}
                    </span>
                    {hasSize && (
                        <span style={{ position: 'relative', display: 'inline-flex' }}>
                            <button
                                {...sizeTip.anchorProps}
                                ref={setSizeRef}
                                type="button"
                                className="fmt-btn fmt-btn-font fmt-btn-size"
                                data-size-button=""
                                data-size={size ?? 'normal'}
                                aria-haspopup="menu"
                                aria-expanded={menu === 'size'}
                                aria-label={`Text size: ${sizeLabelFor(size)}`}
                                aria-describedby={sizeTip.describedBy}
                                tabIndex={activeIdx === sizeIdx ? 0 : -1}
                                onMouseDown={(e) => e.preventDefault()}
                                onFocus={(e) => { sizeTip.anchorProps.onFocus(e); setActiveIdx(sizeIdx); }}
                                onClick={() => setMenu(m => (m === 'size' ? null : 'size'))}
                                onKeyDown={(e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setMenu('size'); } }}
                            >
                                <span className="fmt-size-glyph" aria-hidden="true"><small>A</small>A</span>
                                {sizeLabelFor(size)}
                                <ChevronDown size={13} strokeWidth={2.6} aria-hidden="true" />
                            </button>
                            {sizeTip.tooltip}
                            {menu === 'size' && (
                                <OptionMenu
                                    label="Text size"
                                    options={SIZE_MENU}
                                    value={size === 'mixed' ? undefined : size}
                                    buttonAttr="data-size-button"
                                    onClose={closeMenu}
                                    returnFocus={() => sizeBtn.current?.focus()}
                                    onPick={(v) => { onSizeChange?.(v); setMenu(null); focusComposer(); }}
                                />
                            )}
                        </span>
                    )}
                    {card && (
                        <>
                            <span className="fmt-sep" role="separator" aria-orientation="vertical" />
                            <button
                                {...cardTip.anchorProps}
                                ref={setCardRef}
                                type="button"
                                className="fmt-btn fmt-btn-font fmt-btn-card"
                                data-card-button=""
                                data-card-active={cardLabel ? '' : undefined}
                                aria-haspopup="dialog"
                                aria-label={cardLabel ? `Card style: ${cardLabel}. Edit` : 'Style this message'}
                                aria-describedby={cardTip.describedBy}
                                tabIndex={activeIdx === cardIdx ? 0 : -1}
                                onMouseDown={(e) => e.preventDefault()}
                                onFocus={(e) => { cardTip.anchorProps.onFocus(e); setActiveIdx(cardIdx); }}
                                onClick={() => { setMenu(null); card.onOpen(); }}
                            >
                                <CardSwatch resolved={card.preview} />
                                {cardLabel ?? 'Style'}
                            </button>
                            {cardTip.tooltip}
                        </>
                    )}
                </div>
            )}
        </>
    );
};

export default FormatToolbar;
