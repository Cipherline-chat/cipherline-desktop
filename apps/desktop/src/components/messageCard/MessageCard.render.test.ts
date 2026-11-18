// @vitest-environment jsdom
/**
 * The card renderer (MessageCard + utils/cardStyle/cardStyleReact.ts +
 * styles/message-card.css) in a real DOM:
 *  - plain messages are byte-for-byte unchanged (no wrapper);
 *  - containment: the card's computed style can't move, resize past its
 *    column or cover the app, and its inline style only ever names allowed
 *    properties, even for a hostile style;
 *  - the readability rule reaches the DOM; the three reader modes, the
 *    server settings, "Show plain" and reduced motion;
 *  - the server-checked `styled` flag: a channel row without it renders
 *    plain (positive control: the same payload with the flag renders a card);
 *  - every formatting feature renders INSIDE a card, with the card's text
 *    colour, including long messages and big code blocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateCardStyleByFlag, normalizeCardStyle, parseCardStyleCss, type CardStyle } from '@cipherline/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { MessageCard } = await import('./MessageCard');
const { resolveMessageCard, cardModeFor, cardTextColor } = await import('../../utils/cardStyle/cardStyleReact');
const { renderFormatted } = await import('../formatting/FormattedText');
const { LongMessageBody } = await import('../LongMessage');
const { CARD_STYLE_TEMPLATES } = await import('../../utils/cardStyle/cardStyleTemplates');

const CSS = readFileSync(join(__dirname, '..', '..', 'styles', 'message-card.css'), 'utf8');
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    host = document.createElement('div');
    host.style.width = '320px';
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    document.head.innerHTML = '';
});

const ALL = { user: 'all' as const, server: 'on' as const, reducedMotion: false };
const style = (css: string) => parseCardStyleCss(css).style as CardStyle;

/** The body exactly as ChatPane draws it (MessageCard around the formatted body). */
function Body({ content, ctx = ALL, plain = false }: { content: Record<string, unknown>; ctx?: Parameters<typeof cardModeFor>[0]; plain?: boolean }) {
    const card = resolveMessageCard(content, cardModeFor(ctx, plain));
    const color = cardTextColor(card);
    return React.createElement(MessageCard, { resolved: card },
        React.createElement('div', { className: 'text-white/90 body', 'data-body': '', style: color ? { color } : undefined },
            renderFormatted(String(content.text ?? ''), { renderLeaf: (leaf: string) => leaf })));
}
const mount = (el: React.ReactElement) => act(() => root.render(el));
const card = () => host.querySelector('[data-card-style]') as HTMLElement | null;

describe('plain and styled', () => {
    it('a message without a style renders exactly as before: no wrapper at all', () => {
        mount(React.createElement(Body, { content: { type: 'text', text: 'hello' } }));
        expect(card()).toBeNull();
        expect(host.firstElementChild!.hasAttribute('data-body')).toBe(true);
    });
    it('a styled message gets the app-owned card element', () => {
        mount(React.createElement(Body, { content: { type: 'text', text: 'hi', card_style: CARD_STYLE_TEMPLATES[0].style } }));
        expect(card()).not.toBeNull();
        expect(card()!.className).toBe('cl-msg-card');
        expect(card()!.querySelector('[data-body]')).not.toBeNull();
    });
});

describe('containment', () => {
    const SAFE_INLINE = new Set([
        'border-radius', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
        'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
        'background-color', 'background-image', 'background-clip', 'background-origin',
        'border-width', 'border-style', 'border-color',
        'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
        'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
        'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
        'box-shadow', 'color', 'text-shadow', 'text-align', 'letter-spacing',
        '--cl-card-glow', '--cl-card-glow-dim', '--cl-card-stripe', '--cl-card-stripe-w', '--cl-card-anim-dur',
    ]);
    const hostile = 'position: fixed; z-index: 99999; inset: 0; transform: scale(9); margin: -500px; width: 100vw; ' +
        'background: url(https://evil.example/p.gif); filter: blur(30px); content: x; color: #fff !important; ' +
        'border: 4px solid #ff6b5e; box-shadow: 0 400px 999px 99px #ff6b5e; letter-spacing: 999px; border-radius: 999px';

    it('the class rules contain the card (paint containment, isolation, overflow hidden, max-width 100%, border-box)', () => {
        mount(React.createElement(Body, { content: { type: 'text', text: 'x', card_style: style('background: #131a30') } }));
        const cs = getComputedStyle(card()!);
        expect(cs.contain).toBe('paint');
        expect(cs.isolation).toBe('isolate');
        expect(cs.overflow).toBe('hidden');
        expect(cs.maxWidth).toBe('100%');
        expect(cs.boxSizing).toBe('border-box');
        expect(cs.position).toBe('relative');
    });

    it('a hostile style reaches the DOM only as allowed, bounded inline properties', () => {
        const s = style(hostile);
        mount(React.createElement(Body, { content: { type: 'text', text: 'pwn', card_style: s } }));
        const el = card()!;
        const props = Array.from({ length: el.style.length }, (_, i) => el.style.item(i));
        for (const p of props) expect(SAFE_INLINE.has(p), p).toBe(true);
        expect(el.getAttribute('style')).not.toMatch(/url|position|z-index|inset|transform|margin|(^|;\s*)width:|filter|content|!important|var\(--cl-(?!card)/);
        const cs = getComputedStyle(el);
        expect(cs.position).toBe('relative');
        expect(cs.zIndex === 'auto' || cs.zIndex === '').toBe(true);
        expect(cs.transform === 'none' || cs.transform === '').toBe(true);
        expect(el.style.boxShadow).toBe('0px 8px 16px 4px rgb(255, 107, 94)');
        expect(el.style.letterSpacing).toBe('2px');
        expect(el.style.borderRadius).toBe('24px 24px 24px 24px');
    });

    it('the stripe and the edge are app-drawn chrome, configured only through the app\'s own custom properties', () => {
        mount(React.createElement(Body, { content: { type: 'text', text: 'x', card_style: style('stripe: 5px theme(danger); background: #0b0f1e') } }));
        expect(card()!.hasAttribute('data-card-stripe')).toBe(true);
        expect(card()!.hasAttribute('data-card-edge')).toBe(true);
        expect(card()!.style.getPropertyValue('--cl-card-stripe')).toBe('rgb(255, 107, 94)');
        // The stripe width is added to the left padding so it never covers text.
        expect(card()!.style.paddingLeft).toBe('17px');
    });

    it('shadows paint inside an app frame that reserves their reach in the row and clips there (no bleed onto the next row)', () => {
        const s = style('background: #1d2b64; box-shadow: 0 8px 16px 4px #ff6b5e, 0 -8px 16px 4px #25e0c8');
        mount(React.createElement(Body, { content: { type: 'text', text: 'x', card_style: s } }));
        const frame = host.querySelector('[data-card-frame]') as HTMLElement;
        expect(frame).not.toBeNull();
        expect(frame.contains(card())).toBe(true);
        expect(getComputedStyle(frame).overflow).toBe('clip');
        // Reach = blur + spread +/- offset (28 here, the legal maximum): the frame reserves it
        // above and below, so the clipped paint stays inside this row.
        expect(frame.style.paddingTop).toBe('28px');
        expect(frame.style.paddingBottom).toBe('28px');
        // Sideways it borrows only the row's gutters and gives them back.
        expect(frame.style.marginLeft).toBe('-12px');
        expect(frame.style.paddingLeft).toBe('12px');
        expect(frame.style.marginRight).toBe('-8px');
        expect(frame.style.paddingRight).toBe('8px');
    });

    it('a card without shadows has no frame (nothing to reserve)', () => {
        mount(React.createElement(Body, { content: { type: 'text', text: 'x', card_style: style('background: #1d2b64') } }));
        expect(host.querySelector('[data-card-frame]')).toBeNull();
    });

    it('the hover toolbar outranks the card: the card makes no z-index, the toolbar is z-index 30', () => {
        const index = readFileSync(join(__dirname, '..', '..', 'index.css'), 'utf8');
        expect(index).toMatch(/\.msgbar\.msgbar-inline \{[^}]*z-index: 30/);
        expect(CSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/z-index/);
    });
});

describe('readability reaches the DOM', () => {
    it('a too-faint text colour is nudged, and links/code/mentions derive from it (data-card-fg)', () => {
        mount(React.createElement(Body, { content: { type: 'text', text: 'see [docs](https://cipherline.chat) and `code`', card_style: style('background: #131a30; color: #1c2542') } }));
        const body = host.querySelector('[data-body]') as HTMLElement;
        expect(card()!.hasAttribute('data-card-fg')).toBe(true);
        expect(body.style.color).not.toBe('rgb(28, 37, 66)');
        expect(body.style.color).toMatch(/^rgb/);
        expect(CSS).toMatch(/\[data-card-fg\] \.cl-fmt-link/);
        expect(CSS).toMatch(/\[data-card-fg\] \.cl-fmt-code/);
        expect(CSS).toMatch(/\[data-card-fg\] \[data-mention\]/);
    });
});

describe('modes', () => {
    const animated = { type: 'text', text: 'x', card_style: CARD_STYLE_TEMPLATES.find(t => t.id === 'announcement')!.style };
    it('Show all: animated', () => {
        mount(React.createElement(Body, { content: animated }));
        expect(card()!.getAttribute('data-card-anim')).toBe('drift');
    });
    it.each([
        ['the reader chose "Without animation"', { ...ALL, user: 'static' as const }],
        ['the server chose "No animation"', { ...ALL, server: 'no_animation' as const }],
        ['the OS asks for reduced motion', { ...ALL, reducedMotion: true }],
    ])('static when %s: the card stays, the animation goes', (_n, ctx) => {
        mount(React.createElement(Body, { content: animated, ctx }));
        expect(card()).not.toBeNull();
        expect(card()!.hasAttribute('data-card-anim')).toBe(false);
    });
    it.each([
        ['the reader chose "Plain"', { ...ALL, user: 'plain' as const }, false],
        ['the server turned styles off', { ...ALL, server: 'off' as const }, false],
        ['"Show plain" on this message', ALL, true],
    ])('plain when %s', (_n, ctx, plain) => {
        mount(React.createElement(Body, { content: animated, ctx, plain }));
        expect(card()).toBeNull();
    });
    it('DMs ignore server settings (server: null)', () => {
        mount(React.createElement(Body, { content: animated, ctx: { ...ALL, server: null } }));
        expect(card()).not.toBeNull();
    });
    it('the CSS removes every card animation under prefers-reduced-motion', () => {
        expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^}]*\.cl-msg-card,\s*\.cl-msg-card::after \{ animation: none !important; \}/);
    });
});

describe('the server-checked styled flag (channel rows)', () => {
    const payload = { type: 'text', text: 'rules', card_style: CARD_STYLE_TEMPLATES[0].style };
    it('flag false: the style is dropped at ingest and the row renders plain', () => {
        mount(React.createElement(Body, { content: gateCardStyleByFlag(payload, { isServerChannel: true, styledFlag: false }) }));
        expect(card()).toBeNull();
    });
    it('positive control: the SAME payload with the flag renders the card', () => {
        mount(React.createElement(Body, { content: gateCardStyleByFlag(payload, { isServerChannel: true, styledFlag: true }) }));
        expect(card()).not.toBeNull();
    });
    it('DMs carry no flag and keep the style', () => {
        mount(React.createElement(Body, { content: gateCardStyleByFlag(payload, { isServerChannel: false, styledFlag: undefined }) }));
        expect(card()).not.toBeNull();
    });
});

describe('every formatting feature renders inside a card', () => {
    const TEXT = [
        '# Server rules',
        '## Section',
        '**bold** *italic* __underline__ ~~strike~~ `inline code` ||spoiler|| [masked link](https://cipherline.chat)',
        '> a quote',
        '1. first',
        '2. second',
        '- bullet',
        '[large]Big words[/large] and [small]small print[/small]',
        '```ts',
        'const veryLongLineThatWouldOverflowTheCardIfItWereNotScrollingInsideItsOwnBlock = 1;',
        '```',
    ].join('\n');
    it('headings, lists, quotes, spoilers, links, code, code blocks and size spans are all inside the card, coloured by it', () => {
        const s = normalizeCardStyle({ ...CARD_STYLE_TEMPLATES.find(t => t.id === 'rules')!.style, text: '#ffefd2' })!;
        mount(React.createElement(Body, { content: { type: 'text', text: TEXT, card_style: s } }));
        const c = card()!;
        for (const sel of ['.cl-fmt-h', '.cl-fmt-b', '.cl-fmt-i', '.cl-fmt-u', '.cl-fmt-s', '.cl-fmt-code', '.cl-fmt-spoiler', '.cl-fmt-link', '.cl-fmt-quote', 'ol.cl-fmt-list', 'ul.cl-fmt-list', '.cl-fmt-pre', '.cl-fmt-size']) {
            expect(c.querySelector(sel), sel).not.toBeNull();
        }
        expect((host.querySelector('[data-body]') as HTMLElement).style.color).toBe('rgb(255, 239, 210)');
        expect(c.getAttribute('data-card-heading-align')).toBe('center');
        expect(CSS).toMatch(/\[data-card-heading-align="center"\] \.cl-fmt-h \{ text-align: center; \}/);
    });
    it('a long message keeps its collapse / expand footer inside the card', () => {
        const long = 'word '.repeat(1300);
        const s = CARD_STYLE_TEMPLATES[0].style;
        const card2 = resolveMessageCard({ type: 'text', text: long, card_style: s }, 'full');
        mount(React.createElement(MessageCard, { resolved: card2 },
            React.createElement(LongMessageBody, {
                id: 'm1', text: long, renderText: (t: string) => t, renderDeps: [], senderName: 'dawson', timestamp: 'now', edited: false,
            } as unknown as React.ComponentProps<typeof LongMessageBody>)));
        const c = card()!;
        expect(c.textContent).toMatch(/Long message/i);
        expect(c.querySelector('button')).not.toBeNull();
    });
});
