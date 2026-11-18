/**
 * Message card style: the HOSTILE corpus. Everything here must be rejected
 * or neutralised by the shared parser/normaliser (packages/shared/card-style.ts)
 * — the sender is untrusted, and the receiver re-validates whatever arrives.
 *
 * The invariant checked on every case: whatever comes out is a canonical
 * style (normalising it again changes nothing), it is under the byte cap, and
 * the CSS the app would render for it contains none of the dangerous tokens.
 */
import { describe, it, expect } from 'vitest';
import {
    parseCardStyleCss, normalizeCardStyle, cardStyleToCss, resolveCardStyle, cardStyleByteSize,
    CARD_STYLE_MAX_BYTES, CARD_STYLE_CSS_MAX_CHARS, type CardStyle,
} from '@cipherline/shared';

import { CARD_THEMES } from '@cipherline/shared';
const THEME = CARD_THEMES.dark;
const FORBIDDEN = /url|var\(|expression|@import|@|\\|attr\(|image-set|element\(|position|fixed|z-index|inset|transform|content|filter|mask|calc\(|!important|javascript|behavior|-moz-binding|<|>|"|'/i;

/** Everything the renderer could ever emit for a style, flattened to one string. */
function renderedSurface(s: CardStyle | null): string {
    if (!s) return '';
    const r = resolveCardStyle(s, 'full', THEME);
    const values = r ? [r.backgroundColor, r.backgroundImage, r.backgroundClip, r.boxShadow, r.boxShadowDim, r.textColor, r.textShadow, ...(r.borderColor ?? []), r.borderStyle, r.stripe?.color, r.align, r.headingAlign, r.animation?.name] : [];
    return [cardStyleToCss(s), ...values.filter(Boolean)].join('\n');
}

function assertSafe(s: CardStyle | null) {
    if (s === null) return;
    expect(normalizeCardStyle(s)).toEqual(s);
    expect(cardStyleByteSize(s)).toBeLessThanOrEqual(CARD_STYLE_MAX_BYTES);
    // `inset` may appear in no output; `fixed` neither (it is only a word in reasons).
    expect(renderedSurface(s)).not.toMatch(FORBIDDEN);
}

/** [description, css, expected reason fragment for the dangerous declaration] */
const HOSTILE_CSS: [string, string, RegExp][] = [
    ['url() background', 'background: url(https://evil.example/pixel.gif)', /url\(\) is never allowed/],
    ['url() inside a gradient', 'background: linear-gradient(url(x), #fff)', /url\(\)/],
    ['url() as a border image', 'border-image: url(x) 30 round', /url\(\) is never allowed/],
    ['@import', '@import url(https://evil.example/x.css)', /at-rules/],
    ['@import mid-text', 'color: #fff; @import "x"', /at-rules|quoted/],
    ['@font-face', '@font-face { font-family: x; src: url(x) }', /at-rules/],
    ['IE expression', 'background: expression(alert(1))', /expression\(\) is not allowed/],
    ['escaped url (\\75 rl)', 'background: \\75 rl(x)', /escapes/],
    ['escaped property name', 'po\\73 ition: fixed', /escapes/],
    ['comment hiding a token', 'back/**/ground: url(x)', /comments/],
    ['comment splitting the declaration list', 'color: #fff /* ; position: fixed */', /comments/],
    ['!important', 'color: #fff !important', /!important/],
    ['position: fixed', 'position: fixed', /move the card or let it cover the app/],
    ['position: absolute', 'position: absolute; top: 0; left: 0', /move the card/],
    ['z-index', 'z-index: 2147483647', /move the card/],
    ['transform', 'transform: translate(-9999px, 0) scale(40)', /move the card|translate\(\) is not allowed/],
    ['inset', 'inset: 0', /move the card/],
    ['negative margin', 'margin: -40px', /size or the row layout/],
    ['negative margin longhand', 'margin-top: -999px', /size or the row layout/],
    ['width', 'width: 100vw', /size or the row layout/],
    ['content', 'content: x', /generated content/],
    ['filter', 'filter: blur(20px)', /effects like this/],
    ['backdrop-filter', 'backdrop-filter: blur(20px)', /effects like this/],
    ['mask', 'mask: linear-gradient(#000, #fff)', /effects like this/],
    ['clip-path', 'clip-path: circle(50%)', /effects like this/],
    ['opacity', 'opacity: 0', /effects like this/],
    ['pointer-events', 'pointer-events: none', /effects like this/],
    ['var() into app tokens', 'background: var(--cl-lume)', /var\(\) is not allowed/],
    ['custom property', '--cl-lume: #f00', /custom properties|not a property name/],
    ['attr()', 'color: attr(data-x)', /attr\(\) is not allowed/],
    ['image-set()', 'background: image-set(x 1x)', /image-set\(\) is not allowed/],
    ['element()', 'background: element(#app)', /element\(\) is not allowed/],
    ['calc()', 'border-radius: calc(100% - 1px)', /calc\(\) is not allowed/],
    ['env()', 'color: env(safe-area-inset-top)', /env\(\) is not allowed/],
    ['huge blur', 'box-shadow: 0 0 99999px 9999px #fff', /became 16px|became 4px|not a length/],
    ['inset shadow covering the card', 'box-shadow: inset 0 0 0 999px #000', /inset shadows are not allowed/],
    ['far offset shadow (reaching another row)', 'box-shadow: 0 400px 0 #000', /y 400px became 8px/],
    ['text glow offset (fake bold / double text)', 'text-shadow: 30px 0 0 #fff', /centred/],
    ['negative spread', 'box-shadow: 0 0 10px -5px #000', /negative/],
    ['three shadows', 'box-shadow: 0 0 2px #000, 0 0 40px #fff, 0 0 9px #f00', /at most 2 shadows/],
    ['two text shadows', 'text-shadow: 0 0 2px #000, 0 0 4px #fff', /one text shadow/],
    ['100 stops', `background: linear-gradient(${Array.from({ length: 100 }, (_, i) => `#${(i % 10).toString().repeat(6)}`).join(', ')})`, /at most 6 colour stops/],
    ['NaN width', 'border: nanpx solid #fff', /not a length|only px|not an allowed colour/],
    ['Infinity radius', 'border-radius: infinitypx', /not a length/],
    ['exponent', 'border-radius: 1e9px', /only px lengths/],
    ['viewport units', 'border-radius: 50vw', /only px lengths/],
    ['nested function', 'color: rgb(rgb(1,2,3), 2, 3)', /nested functions/],
    ['gradient in gradient', 'background: linear-gradient(linear-gradient(#000, #fff), #fff)', /nested functions/],
    ['gradient as a colour', 'color: linear-gradient(#000, #fff)', /not a colour function/],
    ['moire repeating gradient', 'background: repeating-linear-gradient(#000 0%, #fff 0.5%)', /finer than 4%/],
    ['repeating gradient without a period', 'background: repeating-radial-gradient(#000, #fff)', /pattern size/],
    ['border-image url', 'border-image: url(x) 30', /url\(\) is never allowed/],
    ['border-image slices', 'border-image: linear-gradient(#000, #fff) 30 / 20px / 400px', /"\/"|no slices/],
    ['gradient border dashed', 'border-image: linear-gradient(#000, #fff) 1; border-style: dashed', /always solid/],
    ['letter-spacing huge (text escaping the card)', 'letter-spacing: 999px', /became 2px/],
    ['letter-spacing em', 'letter-spacing: 5em', /only px/],
    ['text-align justify-all trick', 'text-align: -webkit-center', /not allowed/],
    ['conic gradient', 'background: conic-gradient(#000, #fff)', /conic/],
    ['radial with a position (could aim outside)', 'background: radial-gradient(circle at 900% 900%, #fff, #000)', /centred/],
    ['multiple backgrounds', 'background: linear-gradient(#000, #fff), #f00', /one background layer/],
    ['named colour', 'color: red', /named colours/],
    ['selector block', '.row { position: fixed }', /no selectors/],
    ['html smuggling', 'color: #fff</style><script>', /markup|the character/],
    ['quoted font', 'font-family: "x"', /quoted/],
    ['font size', 'font-size: 400px', /fonts, sizes/],
    ['unicode lookalike colon (U+FF1A)', 'color：#fff', /plain ASCII/],
    ['fullwidth letters', 'ｐosition: fixed', /plain ASCII/],
    ['Kelvin sign that lower-cases to k', 'bacKground: #fff', /plain ASCII/],
    ['zero-width joiner inside url', 'background: u‍rl(x)', /plain ASCII/],
    ['RTL override', 'color: ‮#fff', /plain ASCII/],
    ['NUL byte', 'color: #fff\u0000', /plain ASCII/],
    ['animation with a custom keyframes name', 'animation: my-evil-frames 1s', /not allowed: animation is one of/],
    ['animation timing function', 'animation: drift 6s cubic-bezier(0, 9, 1, -9)', /cubic-bezier\(\) is not allowed/],
    ['too-fast animation', 'animation: shimmer 10ms', /became 4s/],
    ['transition', 'transition: all 0s', /animation shorthand/],
    ['javascript: scheme', 'background: javascript:alert(1)', /one colon/],
    ['behavior (IE HTC)', 'behavior: url(x.htc)', /not in the allowed set|url/],
    ['-moz-binding', '-moz-binding: url(x)', /url|not in the allowed set|not a property/],
];

describe('hostile CSS is rejected or neutralised, with a reason', () => {
    it.each(HOSTILE_CSS)('%s', (_name, text, reason) => {
        const r = parseCardStyleCss(text);
        assertSafe(r.style);
        const nonAccepted = r.declarations.filter(d => d.status !== 'accepted');
        expect(nonAccepted.length, JSON.stringify(r.declarations)).toBeGreaterThan(0);
        expect(nonAccepted.map(d => d.reason).join(' | ')).toMatch(reason);
    });

    it('a hostile declaration never takes a safe neighbour with it, and never gets through', () => {
        const r = parseCardStyleCss('color: #ffffff; position: fixed; z-index: 99; background: url(x); border: 1px solid #25e0c8');
        expect(r.style).toEqual({ v: 1, border: { width: 1, style: 'solid', color: '#25e0c8' }, text: '#ffffff' });
        expect(r.declarations.map(d => d.status)).toEqual(['accepted', 'ignored', 'ignored', 'ignored', 'accepted']);
    });

    it(`text longer than ${CARD_STYLE_CSS_MAX_CHARS} chars is refused whole`, () => {
        const r = parseCardStyleCss('color: #fff;'.repeat(400));
        expect(r.style).toBeNull();
        expect(r.error).toMatch(/too long/);
    });

    it('only the first 32 declarations are read', () => {
        const r = parseCardStyleCss('color: #fff;'.repeat(38));
        expect(r.declarations.filter(d => d.status === 'ignored' && /at most 32/.test(d.reason ?? ''))).toHaveLength(6);
    });
});

describe('hostile JSON is rejected or neutralised', () => {
    const big = { v: 1, text: '#fff', pad: 'x'.repeat(CARD_STYLE_MAX_BYTES) };
    const cases: [string, unknown, CardStyle | null][] = [
        ['oversized payload (unknown padding field pushes it past the cap)', big, null],
        ['unknown version', { v: 2, text: '#fff' }, null],
        ['version as string', { v: '1', text: '#fff' }, null],
        ['array', [{ v: 1 }], null],
        ['string', 'background: red', null],
        ['number', 1, null],
        ['null', null, null],
        ['raw css string in a field', { v: 1, background: 'url(x)' }, null],
        ['url as colour', { v: 1, text: 'url(x)' }, null],
        ['var as colour', { v: 1, text: 'var(--cl-lume)' }, null],
        ['expression as colour', { v: 1, text: 'expression(alert(1))' }, null],
        ['escaped colour', { v: 1, text: '\\23 fff' }, null],
        ['colour with !important', { v: 1, text: '#fff !important' }, null],
        ['colour with a semicolon (declaration smuggling)', { v: 1, text: '#fff; position: fixed' }, null],
        ['NaN / Infinity numbers', { v: 1, border: { width: NaN, color: '#fff' }, radius: Infinity, shadows: [{ color: '#fff', blur: -Infinity }], letterSpacing: NaN, backgroundOpacity: Infinity }, null],
        ['numbers as strings', { v: 1, radius: '12px', border: { width: '2', color: '#fff' } }, null],
        ['100 stops', { v: 1, background: { type: 'linear', stops: Array.from({ length: 100 }, () => ({ color: '#fff' })) } }, null],
        ['unknown background type', { v: 1, background: { type: 'image', url: 'x' } }, null],
        ['unknown animation', { v: 1, animation: { name: 'spin', seconds: 1 } }, null],
        ['position / z-index fields', { v: 1, position: 'fixed', zIndex: 9999, transform: 'scale(9)', text: '#fff' }, { v: 1, text: '#ffffff' }],
        ['negative values clamp to 0', { v: 1, radius: -50, shadows: [{ color: '#fff', blur: -20, spread: -20 }] }, { v: 1, radius: 0 }],
        ['huge values clamp', { v: 1, radius: 1e9, border: { width: 1e9, color: '#fff' }, shadows: [{ color: '#fff', x: 1e9, y: -1e9, blur: 1e9, spread: 1e9 }], letterSpacing: 1e9, textGlow: { color: '#fff', blur: 1e9 }, animation: { name: 'pulse', seconds: 0.001 } },
            { v: 1, border: { width: 4, style: 'solid', color: '#ffffff' }, radius: 24, shadows: [{ x: 8, y: -8, blur: 16, spread: 4, color: '#ffffff' }], textGlow: { color: '#ffffff', blur: 8 }, letterSpacing: 2, animation: { name: 'pulse', seconds: 4 } }],
        ['three shadows', { v: 1, shadows: [{ color: '#fff' }, { color: '#fff' }, { color: '#fff' }], text: '#fff' }, { v: 1, text: '#ffffff' }],
        ['inset smuggled as a shadow field', { v: 1, shadows: [{ color: '#fff', inset: true, blur: 4 }] }, { v: 1, shadows: [{ x: 0, y: 0, blur: 4, spread: 0, color: '#ffffff' }] }],
        ['align values outside the set', { v: 1, align: 'justify', headingAlign: 'start', text: '#fff' }, { v: 1, text: '#ffffff' }],
        ['gradient border with dashed style', { v: 1, border: { width: 2, style: 'dashed', gradient: { stops: [{ color: '#fff' }, { color: '#000' }] } } }, null],
        ['gradient border with per-side widths', { v: 1, border: { width: [1, 2, 3, 4], gradient: { stops: [{ color: '#fff' }, { color: '#000' }] } } }, null],
        ['per-side arrays of the wrong length', { v: 1, border: { width: [1, 2], color: ['#fff', '#000', '#fff'] } }, null],
        ['__proto__ pollution attempt', JSON.parse('{"v":1,"__proto__":{"polluted":true},"text":"#fff"}'), { v: 1, text: '#ffffff' }],
        ['unicode lookalike hex', { v: 1, text: '#ｆｆｆ' }, null],
        ['lookalike that lower-cases to ASCII', { v: 1, text: 'rgb(1,2,3)K' }, null],
    ];
    it.each(cases)('%s', (_n, input, want) => {
        const out = normalizeCardStyle(input);
        expect(out).toEqual(want);
        assertSafe(out);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('a cyclic object is refused, not crashed on', () => {
        const a: Record<string, unknown> = { v: 1, text: '#fff' };
        a.self = a;
        expect(normalizeCardStyle(a)).toBeNull();
    });

    it('a class instance (not a plain object) is refused', () => {
        class Evil { v = 1; text = '#fff'; }
        expect(normalizeCardStyle(new Evil())).toBeNull();
    });
});
