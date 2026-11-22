// @vitest-environment jsdom
/**
 * The composer's LIVE card preview (ComposerCardSurface + the real
 * RichComposer), owner request 2026-11-18: while a style is set for the next
 * message, the box you type in is drawn inside that card.
 *
 *  - one render path with the chat row: the preview's card element carries
 *    exactly the attributes MessageCard renders for the same resolved style
 *    (both spread cardElementProps), from the same shared resolver;
 *  - applied / removed / reset after a send, without ever remounting the
 *    editor (focus, caret, text survive);
 *  - the readability nudge reaches the editor's text colour; caret and
 *    placeholder follow it (CSS);
 *  - motion: reduced motion, "Without animation", the server's "No
 *    animation" give a static preview; the author's own "Plain" reading mode
 *    doesn't hide their deliberate style;
 *  - only the validated, normalised style reaches the DOM;
 *  - the editor still edits and formats inside the card;
 *  - ChatPane wires it around the box only (toolbar, chip and send outside),
 *    behind the same gate the send uses, and resets it with the send.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCardStyleCss, type CardStyle } from '@cipherline/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { ComposerCardSurface, COMPOSER_SHADOW_BORROW } = await import('./ComposerCardSurface');
const { MESSAGE_BODY_CLASS, MESSAGE_BODY_LINE_HEIGHT } = await import('../../utils/formatting/messageSize');
const { messageBodyFontSize } = await import('../../utils/a11y/messageTextSize');
const { MessageCard } = await import('./MessageCard');
const { RichComposer } = await import('../composer/RichComposer');
type Handle = import('../composer/RichComposer').RichComposerHandle;
const { resolveCard, composerCardMode, cardTextColor, cardElementProps, composerTextStyle } = await import('../../utils/cardStyle/cardStyleReact');
const { CARD_STYLE_TEMPLATES } = await import('../../utils/cardStyle/cardStyleTemplates');

const SRC = join(__dirname, '..', '..');
const CSS = readFileSync(join(SRC, 'styles', 'message-card.css'), 'utf8');
const CSS_NO_COMMENTS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const tpl = (id: string) => CARD_STYLE_TEMPLATES.find(t => t.id === id)!.style;
const style = (css: string) => parseCardStyleCss(css).style as CardStyle;
const ALL = { user: 'all' as const, server: null, reducedMotion: false };

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    host = document.createElement('div');
    host.style.width = '480px';
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    document.head.innerHTML = '';
});

/**
 * The composer exactly as ChatPane wires it: `cardOverride` state (set by
 * "Use for this message", cleared by the chip's x and by a send), resolved
 * with composerCardMode behind the posting gate, the card text colour on the
 * box. `api` drives it like the UI does.
 */
interface Api {
    apply: (s: CardStyle | null) => void;
    send: () => void;
    setCtx: (c: Parameters<typeof composerCardMode>[0]) => void;
    setGate: (allowed: boolean) => void;
    handle: () => Handle;
    sent: { text: string; card_style?: CardStyle }[];
}
function mountComposer(initialStyle: CardStyle | null = null, initialText = ''): Api {
    const ref = React.createRef<Handle>();
    const api: Api = { apply: () => {}, send: () => {}, setCtx: () => {}, setGate: () => {}, handle: () => ref.current!, sent: [] };
    function C() {
        const [value, setValue] = React.useState(initialText);
        const [cardOverride, setCardOverride] = React.useState<{ style: CardStyle } | null>(initialStyle ? { style: initialStyle } : null);
        const [ctx, setCtx] = React.useState<Parameters<typeof composerCardMode>[0]>(ALL);
        const [gate, setGate] = React.useState(true);
        const composerCard = gate && cardOverride ? resolveCard(cardOverride.style, composerCardMode(ctx)) : null;
        api.apply = (s) => act(() => setCardOverride(s ? { style: s } : null));
        api.setCtx = (c) => act(() => setCtx(c));
        api.setGate = (g) => act(() => setGate(g));
        api.send = () => act(() => {
            api.sent.push({ text: value, ...(cardOverride ? { card_style: cardOverride.style } : {}) });
            setValue('');
            setCardOverride(null); // ChatPane: the per-message style resets after the send
        });
        return React.createElement('form', { className: 'cl-composer', style: { display: 'flex' } },
            React.createElement('button', { type: 'button', className: 'cmp-ico', 'data-tb': '' }, 'Aa'),
            React.createElement(ComposerCardSurface, { resolved: composerCard, columnWidth: 336 },
                React.createElement(RichComposer, {
                    ref, value, placeholder: 'Message…', onChange: (v: string) => setValue(v),
                    className: 'flex-1 min-w-0 bg-transparent font-medium text-white/90',
                    style: composerTextStyle(composerCard, { padding: '2px 4px' }),
                })),
            React.createElement('button', { type: 'submit', className: 'cmp-ico cmp-ico--send', 'data-send': '' }, 'Send'));
    }
    act(() => root.render(React.createElement(C)));
    return api;
}
const box = () => host.querySelector('[data-rich-composer]') as HTMLDivElement;
const card = () => host.querySelector('[data-card-style]') as HTMLElement | null;
const frame = () => host.querySelector('.cl-composer-card-frame') as HTMLElement;
const typeText = (t: string) => {
    for (const ch of t) act(() => { box().dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: ch, bubbles: true, cancelable: true })); });
};

/** The card element's own attributes (not its children), in order. */
const attrs = (el: Element) => [...el.attributes].map(a => `${a.name}=${a.value}`);

describe('one render path with the posted card', () => {
    it.each(['rules', 'announcement', 'notice', 'success', 'event'])('%s: the preview card carries exactly what MessageCard renders for the same style', (id) => {
        const r = resolveCard(tpl(id), 'full')!;
        act(() => root.render(React.createElement(MessageCard, { resolved: r, className: 'cl-msg-card--composer' }, 'x')));
        const fromRow = attrs(card()!);
        act(() => root.render(React.createElement(ComposerCardSurface, { resolved: r }, 'x')));
        expect(attrs(card()!)).toEqual(fromRow);
        // ...and both are cardElementProps of the shared resolver's output.
        expect(card()!.className).toBe(cardElementProps(r, 'cl-msg-card--composer').className);
    });

    it('MessageCard is unchanged: plain = no wrapper; styled = the same element as before the refactor', () => {
        act(() => root.render(React.createElement(MessageCard, { resolved: null }, React.createElement('i', { 'data-b': '' }))));
        expect(host.firstElementChild!.hasAttribute('data-b')).toBe(true);
        const r = resolveCard(tpl('rules'), 'full')!;
        act(() => root.render(React.createElement(MessageCard, { resolved: r }, 'x')));
        const el = card()!;
        expect(el.className).toBe('cl-msg-card');
        // Attribute names and order exactly as MessageCard wrote them inline before cardElementProps existed.
        expect([...el.attributes].map(a => a.name)).toEqual(
            ['class', 'data-card-style', ...(r.animation ? ['data-card-anim'] : []), ...(r.stripe ? ['data-card-stripe'] : []),
                ...(r.edge ? ['data-card-edge'] : []), ...(r.textColor ? ['data-card-fg'] : []), ...(r.headingAlign ? ['data-card-heading-align'] : []), 'style']);
    });
});

describe('applied, removed, reset after send', () => {
    it('no style: the composer is exactly as before (plain wrappers, no card, no inline style)', () => {
        mountComposer();
        expect(card()).toBeNull();
        expect(frame().hasAttribute('data-composer-card')).toBe(false);
        expect(frame().getAttribute('style')).toBeNull();
        const inner = frame().firstElementChild as HTMLElement;
        expect(inner.className).toBe('cl-composer-card-plain');
        expect(inner.getAttribute('style')).toBeNull();
        expect(box().style.color).toBe('');
    });

    it('applying a style draws the box inside the card; the toolbar and send stay outside it', () => {
        const api = mountComposer();
        api.apply(tpl('rules'));
        const c = card()!;
        expect(c).not.toBeNull();
        expect(c.classList.contains('cl-msg-card--composer')).toBe(true);
        expect(c.contains(box())).toBe(true);
        expect(c.querySelector('[data-tb]')).toBeNull();
        expect(c.querySelector('[data-send]')).toBeNull();
        expect(c.getAttribute('data-card-heading-align')).toBe('center');
        expect(c.getAttribute('style')).toMatch(/background/);
    });

    it('removing it (chip x / Remove style) returns the box to normal at once, without remounting the editor', () => {
        const api = mountComposer(tpl('rules'), 'hello');
        const before = box();
        act(() => { api.handle().focus(); api.handle().placeCaretAtEnd(); });
        typeText(' world');
        api.apply(null);
        expect(card()).toBeNull();
        expect(box()).toBe(before); // same element: focus, caret and undo history survive
        expect(box().textContent).toBe('hello world');
        expect(document.activeElement).toBe(before);
        expect(box().style.color).toBe('');
        // and back on: still the same element
        api.apply(tpl('notice'));
        expect(card()).not.toBeNull();
        expect(box()).toBe(before);
    });

    it('sending resets the preview with the rest of the per-message style', () => {
        const api = mountComposer(tpl('announcement'), 'Big news');
        expect(card()).not.toBeNull();
        api.send();
        expect(api.sent.at(-1)).toMatchObject({ text: 'Big news', card_style: tpl('announcement') });
        expect(card()).toBeNull();
        expect(box().textContent).toBe('');
    });

    it('no preview when the style would not be sent (posting gate closed)', () => {
        const api = mountComposer(tpl('rules'));
        expect(card()).not.toBeNull();
        api.setGate(false);
        expect(card()).toBeNull();
    });
});

describe('readability in the editor', () => {
    it('a too-faint text colour is nudged in the box too (the same colour the posted body gets)', () => {
        const s = style('background: #131a30; color: #1c2542');
        mountComposer(s, 'readable?');
        const r = resolveCard(s, 'full')!;
        expect(r.notes.textAdjusted).toBeTruthy();
        expect(card()!.hasAttribute('data-card-fg')).toBe(true);
        expect(box().style.color).not.toBe('rgb(28, 37, 66)');
        expect(box().style.color).not.toBe('');
        // Same colour as the posted body: ChatPane's row uses cardTextColor(resolved) the same way.
        const probe = document.createElement('i');
        probe.style.color = cardTextColor(r)!;
        expect(box().style.color).toBe(probe.style.color);
    });

    it('caret and placeholder follow the card text colour; selection keeps the app highlight', () => {
        expect(CSS_NO_COMMENTS).toMatch(/\.cl-msg-card--composer \.rc-root \{ caret-color: currentColor; \}/);
        expect(CSS_NO_COMMENTS).toMatch(/\.cl-msg-card--composer \.rc-root\[data-empty\]::before \{\s*color: color-mix\(in srgb, currentColor 58%, transparent\);/);
        // A card text colour can sit at the 3:1 floor (nudged): the placeholder takes a bigger share of it.
        expect(CSS_NO_COMMENTS).toMatch(/\.cl-msg-card--composer\[data-card-fg\] \.rc-root\[data-empty\]::before \{\s*color: color-mix\(in srgb, currentColor 78%, transparent\);/);
        expect(CSS_NO_COMMENTS).not.toMatch(/::selection/);
    });

    it('formatting inside the composer follows the SAME card rules as the posted card (headings, code, lists, quotes)', () => {
        for (const sel of ['.rc-h1', '.rc-icode', '.rc-code', '.rc-ul::before', '.rc-ol::before', '.rc-q', '.rc-sub']) {
            expect(CSS_NO_COMMENTS, sel).toContain(sel);
        }
        expect(CSS_NO_COMMENTS).toMatch(/\.cl-msg-card\[data-card-fg\] \.cl-fmt-code,\s*\.cl-msg-card\[data-card-fg\] \.rc-icode \{/);
        expect(CSS_NO_COMMENTS).toMatch(/\[data-card-heading-align="center"\] \.rc-h1/);
    });
});

describe('motion', () => {
    const drift = tpl('announcement');
    it('Show all: the preview animates like the posted card', () => {
        mountComposer(drift);
        expect(card()!.getAttribute('data-card-anim')).toBe('drift');
    });
    it.each([
        ['the OS asks for reduced motion', { ...ALL, reducedMotion: true }],
        ['"Without animation"', { ...ALL, user: 'static' as const }],
        ['the server chose "No animation"', { ...ALL, server: 'no_animation' as const }],
        ['the author reads in "Plain" (their own style still shows, still)', { ...ALL, user: 'plain' as const }],
    ])('static when %s: the card stays, the animation goes', (_n, ctx) => {
        const api = mountComposer(drift);
        api.setCtx(ctx);
        expect(card()).not.toBeNull();
        expect(card()!.hasAttribute('data-card-anim')).toBe(false);
    });
    it('the stylesheet also stops every card animation under prefers-reduced-motion', () => {
        expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\.cl-msg-card,\s*\.cl-msg-card::after \{ animation: none !important; \}/);
    });
});

describe('containment in the composer', () => {
    it('shadows get their full reach (as in the feed), in a clipped frame borrowing only a few px of the pill', () => {
        const s = style('background: #1a2240; box-shadow: 0 6px 16px 4px rgba(0,0,0,.6)');
        mountComposer(s);
        const reach = resolveCard(s, 'full')!.shadowReach!;
        const f = frame();
        expect(f.hasAttribute('data-composer-card')).toBe(true);
        expect(f.style.padding).toBe(`${reach.top}px ${reach.right}px ${reach.bottom}px ${reach.left}px`);
        expect(f.style.margin.split(' ').map(parseFloat).every(x => x <= 0 && x >= -COMPOSER_SHADOW_BORROW)).toBe(true);
        expect(CSS_NO_COMMENTS).toMatch(/\.cl-composer-card-frame\[data-composer-card\] \{\s*overflow: clip;/);
    });
    it('the editable box keeps its own height limits and scrolling: the card is AROUND it', () => {
        mountComposer(tpl('rules'));
        expect(box().parentElement).toBe(card());
        // The card itself sets no height and no scrolling; rich-composer.css owns both on .rc-root.
        const composerRule = CSS_NO_COMMENTS.match(/\.cl-msg-card\.cl-msg-card--composer \{[^}]*\}/)![0];
        expect(composerRule).not.toMatch(/height|overflow|width: auto/);
        const rc = readFileSync(join(SRC, 'styles', 'rich-composer.css'), 'utf8');
        expect(rc).toMatch(/min-height:22px;max-height:260px;overflow-y:auto/);
    });
    it('only the validated, normalised style reaches the DOM (a hostile object is cleaned first)', () => {
        const hostile = { v: 1, background: { type: 'solid', color: '#223' }, position: 'fixed', zIndex: 99, padding: 'url(x)', text: 'expression(alert(1))' } as unknown as CardStyle;
        mountComposer(hostile);
        const c = card()!;
        const st = c.getAttribute('style') ?? '';
        expect(st).not.toMatch(/position|z-index|url\(|expression/);
        for (const prop of Array.from({ length: c.style.length }, (_, i) => c.style[i])) {
            expect(prop).toMatch(/^(border-|padding|background|box-shadow|color|text-|letter-spacing|--cl-card-)/);
        }
    });
    it('the editor still edits and formats inside the card', () => {
        const api = mountComposer(tpl('rules'));
        act(() => { api.handle().focus(); api.handle().placeCaretAtEnd(); });
        typeText('Rules');
        act(() => api.handle().applyFormat('heading'));
        expect(card()!.contains(box())).toBe(true);
        expect(box().querySelector('.rc-h1')?.textContent).toBe('Rules');
        act(() => api.handle().newline());
        typeText('- be kind');
        expect(box().querySelector('.rc-ul')?.textContent).toBe('be kind');
        expect(card()!.contains(box().querySelector('.rc-ul'))).toBe(true);
    });
});

describe('ChatPane wiring (structural)', () => {
    const cp = readFileSync(join(SRC, 'components', 'ChatPane.tsx'), 'utf8');
    it('the preview wraps the box only, once; toolbar, chip and send are outside it', () => {
        expect(cp.match(/<ComposerCardSurface /g)).toHaveLength(1);
        const open = cp.indexOf('<ComposerCardSurface ');
        const close = cp.indexOf('</ComposerCardSurface>');
        const inside = cp.slice(open, close);
        expect(inside).toMatch(/<RichComposer\b/);
        expect(inside).not.toMatch(/<FormatToolbar|cmp-ico--send|<CardStyleDialog/);
        expect(cp.indexOf('<FormatToolbar')).toBeLessThan(open);
    });
    it('it shows the style that would really be sent (same gate as the send), in the composer mode', () => {
        expect(cp).toMatch(/const composerCard = cardGate\.allowed && canSend && cardOverride \? resolveCard\(cardOverride\.style, composerCardMode\(cardCtx\)\) : null;/);
        expect(cp).toMatch(/const outgoingCard = cardGate\.allowed \? cardOverride : null;/);
        expect(cp).toMatch(/<ComposerCardSurface resolved=\{composerCard\} columnWidth=\{composerCardColumnW\}>/);
        expect(cp).toMatch(/style=\{composerTextStyle\(cooldownSecs > 0 \? null : composerCard, \{ padding: '2px 4px' \}\)\}/);
    });
    it('the per-message style is cleared by the send, the chip x, and restored after an edit (so is the preview)', () => {
        expect(cp).toMatch(/setCardOverride\(null\);/);
        expect(cp).toMatch(/onClear: \(\) => \{ setCardOverride\(null\);/);
        expect(cp).toMatch(/setCardOverride\(editingId \? preEditCardRef\.current : null\)/);
        // Editing a styled message loads its style into the same state, so the preview shows during the edit.
        expect(cp).toMatch(/setCardOverride\(own \? \{ style: own \} : null\)/);
    });
});

/**
 * WYSIWYG (owner 2026-11-18: "It doesn't match how it would look if I sent it"):
 * the composer preview card and the posted MessageCard, for the same style and
 * text, have the same computed box and text metrics. jsdom sees the inline
 * values (where every sender-controlled value lives); it does not apply the
 * stylesheet cascade faithfully (a deliberately different `!important`
 * padding in message-card.css was NOT caught here), nor layout. So the
 * authoritative comparison is in Chromium: harness/window-sizes-check.mjs
 * --only=wysiwyg compares the computed box / text metrics, widths, heights
 * and the text's position (3 px / 2 px / 1 px), with its own positive
 * control (broken/wysiwyg-control: the old full-width, re-padded card FAILS).
 */
describe('WYSIWYG: the preview card is the posted card', () => {
    /** The row body exactly as ChatPane draws it (MessageCard around the body div, MESSAGE_BODY_* metrics). */
    function Sent({ s, text }: { s: CardStyle; text: string }) {
        const r = resolveCard(s, 'full');
        const color = cardTextColor(r);
        return React.createElement('div', { 'data-sent': '' },
            React.createElement(MessageCard, { resolved: r },
                React.createElement('div', {
                    'data-sent-body': '', className: MESSAGE_BODY_CLASS,
                    style: { fontSize: messageBodyFontSize(), lineHeight: MESSAGE_BODY_LINE_HEIGHT, ...(color ? { color } : {}) },
                }, text)));
    }
    const BOX = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
        'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
        'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
        'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius',
        'boxShadow', 'backgroundColor', 'backgroundImage', 'textAlign', 'letterSpacing', 'textShadow', 'color'] as const;

    it.each(['event', 'rules', 'announcement', 'notice', 'success', 'info', 'welcome', 'failure'])('%s: same padding, border (widths / styles / colours), radius, shadow, background, text metrics', (id) => {
        const s = tpl(id);
        const r = resolveCard(s, 'full');
        act(() => root.render(React.createElement('div', null,
            React.createElement(Sent, { s, text: 'Yo All!' }),
            React.createElement(ComposerCardSurface, { resolved: r, columnWidth: 336 },
                React.createElement(RichComposer, { value: 'Yo All!', onChange: () => {}, className: 'text-white/90', style: composerTextStyle(r, { padding: '2px 4px' }) })))));
        const sent = host.querySelector('[data-sent] .cl-msg-card') as HTMLElement;
        const comp = host.querySelector('.cl-msg-card--composer') as HTMLElement;
        expect(sent).not.toBeNull();
        expect(comp).not.toBeNull();
        const a = getComputedStyle(sent), b = getComputedStyle(comp);
        for (const k of BOX) expect(b[k], `${id} ${k}`).toBe(a[k]);
        // The text: the row body's font-size and line-height, from the same constants.
        const body = host.querySelector('[data-sent-body]') as HTMLElement;
        const box = host.querySelector('[data-rich-composer]') as HTMLElement;
        expect(box.style.fontSize).toBe(body.style.fontSize);
        expect(box.style.lineHeight).toBe(body.style.lineHeight);
        expect(box.style.color).toBe(body.style.color);
        // Accessibility → Message text size: both read the same CSS var (15px when unset). The test
        // DOM drops var() from inline styles, so the shared expression is asserted on the style object.
        expect(composerTextStyle(r, {}).fontSize).toBe('var(--cl-msg-text-px, 15px)');
        // Accessibility > Line spacing: both read --cl-msg-leading (normal when unset).
        expect(composerTextStyle(r, {}).lineHeight).toBe(MESSAGE_BODY_LINE_HEIGHT);
        expect(box.style.lineHeight).toBe(MESSAGE_BODY_LINE_HEIGHT);
    });

    it('the Event card keeps its double gold border in the composer (the owner\'s report)', () => {
        mountComposer(tpl('event'), 'Yo All!');
        const c = card()!;
        const cs = getComputedStyle(c);
        expect(cs.borderTopStyle).toBe('double');
        expect(parseFloat(cs.borderTopWidth)).toBeGreaterThanOrEqual(3);
    });

    it('width: the preview shrink-wraps like the posted card (fit-content, the same rule), capped at the feed\'s message column', () => {
        // `.cl-msg-card` is fit-content; the composer variant must not override it.
        expect(CSS_NO_COMMENTS).toMatch(/\.cl-msg-card \{[^}]*width: fit-content;/);
        const composerRule = CSS_NO_COMMENTS.match(/\.cl-msg-card\.cl-msg-card--composer \{[^}]*\}/)![0];
        expect(composerRule).toMatch(/max-width: min\(100%, var\(--cl-msg-col-w, 100%\)\);/);
        expect(composerRule).not.toMatch(/(^|[^-])width:/);
        mountComposer(tpl('event'), 'Yo All!');
        expect(frame().style.getPropertyValue('--cl-msg-col-w')).toBe('336px');
    });

    it('the text metrics have ONE source: ChatPane\'s row body and the preview both use messageBodyFontSize / MESSAGE_BODY_LINE_HEIGHT', () => {
        const cp = readFileSync(join(SRC, 'components', 'ChatPane.tsx'), 'utf8');
        expect(cp).toMatch(/let fontSize = messageBodyFontSize\(sizeScaleFor\(msgSize\)\);/);
        expect(cp).toMatch(/let lineHeight: string \| number = MESSAGE_BODY_LINE_HEIGHT;/);
        expect(composerTextStyle(resolveCard(tpl('event'), 'full'), {})).toMatchObject({ fontSize: messageBodyFontSize(), lineHeight: MESSAGE_BODY_LINE_HEIGHT });
        expect(composerTextStyle(null, { padding: '2px 4px' })).toEqual({ padding: '2px 4px' });
    });
});

