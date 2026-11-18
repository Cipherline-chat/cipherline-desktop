/**
 * Message card style (packages/shared/card-style.ts): the exhaustive
 * ALLOWLIST. Every property and value form the contract accepts, from both
 * entry points (CSS text and the JSON object), and the exact normalised
 * object each produces. docs/message-card-style.md is the spec.
 */
import { describe, it, expect } from 'vitest';
import {
    parseCardStyleCss, normalizeCardStyle, parseCardColor, cardStyleToCss, withEditCardStyle,
    cardStyleOfContent, gateCardStyleByFlag, cardStyledFlag, CARD_LIMITS, CARD_PADDING_PX, CARD_STYLE_MAX_BYTES,
    cardStyleByteSize, type CardStyle,
} from '@cipherline/shared';

const css = (text: string) => parseCardStyleCss(text);
const style = (text: string) => css(text).style;
const statuses = (text: string) => css(text).declarations.map(d => d.status);

describe('colours', () => {
    it.each([
        ['#abc', '#aabbcc'],
        ['#ABC', '#aabbcc'],
        ['#abcd', '#aabbccdd'],
        ['#25E0C8', '#25e0c8'],
        ['#25e0c880', '#25e0c880'],
        ['#25e0c8ff', '#25e0c8'],
        ['rgb(37, 224, 200)', '#25e0c8'],
        ['rgb(37 224 200)', '#25e0c8'],
        ['rgba(37, 224, 200, 0.5)', '#25e0c880'],
        ['rgb(37 224 200 / 50%)', '#25e0c880'],
        ['rgba(100%, 0%, 0%, .25)', '#ff000040'],
        ['rgb(300, -0, 0)', null], // "-0" is not a plain number
        ['rgb(300, 0, 0)', '#ff0000'], // clamped like CSS
        ['hsl(173, 75%, 51%)', parseCardColor('hsl(173deg 75% 51%)')],
        ['hsla(0, 100%, 50%, 0.5)', '#ff000080'],
        ['hsl(120 100% 25% / 1)', '#008000'],
        ['theme(success)', 'theme(success)'],
        ['theme(danger / 20%)', 'theme(danger / 20%)'],
    ])('%s -> %s', (input, out) => {
        expect(parseCardColor(input)).toBe(out);
    });

    it('rejects every other colour form', () => {
        for (const bad of ['red', 'transparent', 'currentcolor', 'inherit', '#abcde', '#ggg', 'rgb(1,2)', 'rgb(1,2,3,4,5)', 'hwb(0 0% 0%)', 'color(srgb 1 0 0)', 'oklch(0.7 0.1 200)', '', ' ', 'rgb(1e2, 0, 0)']) {
            expect(parseCardColor(bad), bad).toBeNull();
        }
    });
});

describe('background', () => {
    it('solid colour via background, background-color', () => {
        expect(style('background: #131a30')).toEqual({ v: 1, background: { type: 'solid', color: '#131a30' } });
        expect(style('background-color: rgba(19, 26, 48, 0.5)')).toEqual({ v: 1, background: { type: 'solid', color: '#131a3080' } });
    });

    it('linear gradient: angle, "to" sides, default direction, explicit and filled stop positions', () => {
        expect(style('background: linear-gradient(135deg, #25e0c8, #5c6bc0)')).toEqual({
            v: 1, background: { type: 'linear', angle: 135, stops: [{ color: '#25e0c8', at: 0 }, { color: '#5c6bc0', at: 100 }] },
        });
        expect(style('background-image: linear-gradient(to right, #000 10%, #111, #222, #333 90%)')!.background).toEqual({
            type: 'linear', angle: 90,
            stops: [{ color: '#000000', at: 10 }, { color: '#111111', at: 37 }, { color: '#222222', at: 63 }, { color: '#333333', at: 90 }],
        });
        expect(style('background: linear-gradient(#000, #fff)')!.background).toMatchObject({ type: 'linear', angle: 180 });
        expect(style('background: linear-gradient(to top left, #000, #fff)')!.background).toMatchObject({ angle: 315 });
        expect(style('background: linear-gradient(-45deg, #000, #fff)')!.background).toMatchObject({ angle: 315 });
        expect(style('background: linear-gradient(720deg, #000, #fff)')!.background).toMatchObject({ angle: 0 });
    });

    it('stops that go backwards sit on the previous one (CSS rule)', () => {
        expect(style('background: linear-gradient(90deg, #000 60%, #fff 20%)')!.background).toMatchObject({
            stops: [{ color: '#000000', at: 60 }, { color: '#ffffff', at: 60 }],
        });
    });

    it('radial gradient: centred, circle or ellipse', () => {
        expect(style('background: radial-gradient(circle, #243056, #0b0f1e)')!.background).toEqual({
            type: 'radial', shape: 'circle', stops: [{ color: '#243056', at: 0 }, { color: '#0b0f1e', at: 100 }],
        });
        expect(style('background: radial-gradient(#243056 0%, #0b0f1e 80%)')!.background).toMatchObject({ type: 'radial', shape: 'ellipse' });
    });

    it('repeating patterns (stripes, dots): last stop sets the pattern size, at least 4%', () => {
        expect(style('background: repeating-linear-gradient(45deg, #ffffff0d 0%, #ffffff0d 5%, #00000000 5%, #00000000 10%)')!.background)
            .toMatchObject({ type: 'repeating-linear', angle: 45 });
        expect(style('background: repeating-radial-gradient(circle, #ffffff14 0%, #ffffff14 2%, #00000000 2%, #00000000 6%)')!.background)
            .toMatchObject({ type: 'repeating-radial', shape: 'circle' });
        expect(css('background: repeating-linear-gradient(45deg, #000 0%, #fff 1%)').declarations[0]).toMatchObject({ status: 'ignored', reason: expect.stringMatching(/finer than 4%/) });
        expect(css('background: repeating-linear-gradient(45deg, #000, #fff)').declarations[0]).toMatchObject({ status: 'ignored', reason: expect.stringMatching(/pattern size/) });
    });

    it(`2 to ${CARD_LIMITS.stops.max} stops; outside that the background is ignored`, () => {
        expect(style('background: linear-gradient(#000, #111, #222, #333, #444, #555)')!.background).toBeTruthy();
        expect(statuses('background: linear-gradient(#000, #111, #222, #333, #444, #555, #666)')).toEqual(['ignored']);
        expect(statuses('background: linear-gradient(90deg, #000)')).toEqual(['ignored']);
    });

    it('background-opacity (0..1 or %), only with a background; 100% is the default', () => {
        expect(style('background: #ff6b5e; background-opacity: 40%')).toEqual({ v: 1, background: { type: 'solid', color: '#ff6b5e' }, backgroundOpacity: 40 });
        expect(style('background: #ff6b5e; background-opacity: .25')!.backgroundOpacity).toBe(25);
        expect(style('background: #ff6b5e; background-opacity: 100%')).toEqual({ v: 1, background: { type: 'solid', color: '#ff6b5e' } });
        expect(css('background-opacity: 50%; color: #fff').declarations[0].status).toBe('ignored');
    });

    it('background: none clears an earlier background', () => {
        expect(style('background: #000; background: none; color: #ffffff')).toEqual({ v: 1, text: '#ffffff' });
    });
});

describe('border', () => {
    it('shorthand in any order, and the longhands merge', () => {
        const want = { v: 1, border: { width: 2, style: 'dashed', color: '#ff6b5e' } };
        expect(style('border: 2px dashed #ff6b5e')).toEqual(want);
        expect(style('border: #ff6b5e dashed 2px')).toEqual(want);
        expect(style('border-width: 2px; border-style: dashed; border-color: #ff6b5e')).toEqual(want);
    });
    it.each(['solid', 'dashed', 'dotted', 'double'])('style %s', (s) => {
        expect(style(`border: 1px ${s} #fff`)!.border!.style).toBe(s);
    });
    it('width defaults to 1px and style to solid (reported as adjusted); width is clamped to 0..4 whole px', () => {
        const r = css('border: #fff');
        expect(r.style!.border).toEqual({ width: 1, style: 'solid', color: '#ffffff' });
        expect(r.declarations[0].status).toBe('adjusted');
        expect(style('border: 9px solid #fff')!.border).toMatchObject({ width: 4 });
        expect(style('border: 1.6px solid #fff')!.border).toMatchObject({ width: 2 });
    });
    it('per side: border-width / border-color with 1-4 values, and border-top/right/bottom/left', () => {
        expect(style('border-style: solid; border-width: 3px 1px 1px 1px; border-color: #ffc94d #ffc94d59')).toEqual({
            v: 1, border: { width: [3, 1, 1, 1], style: 'solid', color: ['#ffc94d', '#ffc94d59', '#ffc94d', '#ffc94d59'] },
        });
        expect(style('border-bottom: 2px solid #25e0c8')).toEqual({
            v: 1, border: { width: [0, 0, 2, 0], style: 'solid', color: '#25e0c8' },
        });
        expect(style('border: 1px solid #333; border-top: 3px solid #ff6b5e')).toEqual({
            v: 1, border: { width: [3, 1, 1, 1], style: 'solid', color: ['#ff6b5e', '#333333', '#333333', '#333333'] },
        });
        expect(css('border: 1px solid #333; border-top: 3px dashed #fff').declarations[1].reason).toMatch(/one border style/);
    });
    it('gradient border via border-image: linear-gradient(...) 1, uniform width, always solid', () => {
        expect(style('border-width: 2px; border-image: linear-gradient(135deg, theme(accent), #a78bfa) 1')).toEqual({
            v: 1, border: { width: 2, style: 'solid', gradient: { angle: 135, stops: [{ color: 'theme(accent)', at: 0 }, { color: '#a78bfa', at: 100 }] } },
        });
        expect(css('border-image: radial-gradient(#000, #fff) 1').declarations[0].status).toBe('ignored');
        expect(css('border-image: linear-gradient(#000, #fff) 30 round').declarations[0].reason).toMatch(/no slices/);
    });
    it('border: none and 0 width draw no border', () => {
        expect(style('border: none; color: #fff')).toEqual({ v: 1, text: '#ffffff' });
        expect(css('border: 0px solid #fff').declarations[0].status).toBe('ignored');
    });
});

describe('radius and padding', () => {
    it('one to four px values (CSS order TL TR BR BL), clamped 0..24', () => {
        expect(style('border-radius: 14px')!.radius).toBe(14);
        expect(style('border-radius: 4px 18px')!.radius).toEqual([4, 18, 4, 18]);
        expect(style('border-radius: 4px 8px 12px')!.radius).toEqual([4, 8, 12, 8]);
        expect(style('border-radius: 1px 2px 3px 4px')!.radius).toEqual([1, 2, 3, 4]);
        expect(style('border-radius: 99px')!.radius).toBe(24);
        expect(style('border-radius: 0')!.radius).toBe(0);
    });
    it('padding snaps to a preset; the exact preset values are accepted unchanged', () => {
        for (const [name, [v, h]] of Object.entries(CARD_PADDING_PX)) {
            const r = css(`padding: ${v}px ${h}px`);
            expect(r.style!.padding).toBe(name);
            expect(r.declarations[0].status).toBe('accepted');
        }
        expect(css('padding: 40px').declarations[0].status).toBe('adjusted');
        expect(style('padding: 40px')!.padding).toBe('roomy');
    });
});

describe('shadows (box-shadow)', () => {
    it('one or two outer shadows with x, y, blur, spread and colour, clamped', () => {
        expect(style('box-shadow: 0 0 12px #25e0c866')!.shadows).toEqual([{ x: 0, y: 0, blur: 12, spread: 0, color: '#25e0c866' }]);
        expect(style('box-shadow: 0 4px 16px #00000066, 0 0 10px 2px theme(accent / 30%)')!.shadows).toEqual([
            { x: 0, y: 4, blur: 16, spread: 0, color: '#00000066' },
            { x: 0, y: 0, blur: 10, spread: 2, color: 'theme(accent / 30%)' },
        ]);
        expect(style('box-shadow: -40px 40px 999px 99px #fff')!.shadows).toEqual([{ x: -8, y: 8, blur: 16, spread: 4, color: '#ffffff' }]);
        expect(css('box-shadow: 0 0 999px #fff').declarations[0].status).toBe('adjusted');
    });
    it('box-shadow: none clears it', () => {
        expect(style('box-shadow: 0 0 4px #fff; box-shadow: none; color: #fff')).toEqual({ v: 1, text: '#ffffff' });
    });
});

describe('text: colour, glow, alignment, heading alignment, letter-spacing', () => {
    it('color, any colour form incl. theme colours', () => {
        expect(style('color: #f4f7ff')).toEqual({ v: 1, text: '#f4f7ff' });
        expect(style('color: theme(warning)')).toEqual({ v: 1, text: 'theme(warning)' });
    });
    it('text-shadow is one centred glow, blur 1..8', () => {
        expect(style('text-shadow: 0 0 6px theme(accent / 40%)')).toEqual({ v: 1, textGlow: { color: 'theme(accent / 40%)', blur: 6 } });
        expect(style('text-shadow: 0 0 30px #fff')!.textGlow!.blur).toBe(8);
        expect(css('text-shadow: 2px 2px 0 #000').declarations[0].reason).toMatch(/centred/);
    });
    it('text-align and heading-align: left / center / right (start, end accepted)', () => {
        expect(style('text-align: center')).toEqual({ v: 1, align: 'center' });
        expect(style('text-align: end')).toEqual({ v: 1, align: 'right' });
        expect(style('heading-align: center')).toEqual({ v: 1, headingAlign: 'center' });
        expect(style('text-align: center; heading-align: center')).toEqual({ v: 1, align: 'center' });
        expect(css('text-align: justify').declarations[0].status).toBe('ignored');
    });
    it('letter-spacing in px, -0.5..2, one decimal', () => {
        expect(style('letter-spacing: 0.4px')).toEqual({ v: 1, letterSpacing: 0.4 });
        expect(style('letter-spacing: 9px')!.letterSpacing).toBe(2);
        expect(style('letter-spacing: -3px')!.letterSpacing).toBe(-0.5);
        expect(css('letter-spacing: 0.1em').declarations[0].status).toBe('ignored');
    });
});

describe('stripe and animation', () => {
    it('stripe: <width> <colour>, 2..6px, solid', () => {
        expect(style('stripe: 4px theme(danger)')).toEqual({ v: 1, stripe: { color: 'theme(danger)', width: 4 } });
        expect(style('stripe: #ff6b5e')).toEqual({ v: 1, stripe: { color: '#ff6b5e', width: 3 } });
    });
    it('drift (needs a gradient), pulse (needs a shadow), shimmer (any); seconds clamped 4..20; ms accepted; infinite tolerated', () => {
        expect(style('background: linear-gradient(#000, #111); animation: drift 6s')!.animation).toEqual({ name: 'drift', seconds: 6 });
        expect(style('box-shadow: 0 0 8px #fff; animation: pulse 3000ms infinite')!.animation).toEqual({ name: 'pulse', seconds: 4 });
        expect(style('color: #fff; animation: shimmer')!.animation).toEqual({ name: 'shimmer', seconds: 8 });
        expect(style('color: #fff; animation: shimmer 60s')!.animation!.seconds).toBe(20);
        const noGrad = css('background: #000; animation: drift 6s');
        expect(noGrad.style!.animation).toBeUndefined();
        expect(noGrad.declarations[1]).toMatchObject({ status: 'ignored', reason: expect.stringMatching(/gradient/) });
    });
});

describe('the report', () => {
    it('later declarations of the same field override earlier ones', () => {
        const r = css('color: #000; color: #fff');
        expect(r.declarations.map(d => d.status)).toEqual(['overridden', 'accepted']);
        expect(r.style).toEqual({ v: 1, text: '#ffffff' });
    });
    it('properties are case-insensitive; whitespace and empty declarations are fine', () => {
        expect(style('  BACKGROUND : #FFF ;;\n Color:#000 ;')).toEqual({ v: 1, background: { type: 'solid', color: '#ffffff' }, text: '#000000' });
    });
});

describe('JSON input (the primary contract) normalises to the same object as the equivalent CSS', () => {
    const pairs: [string, string, unknown][] = [
        ['solid', 'background: rgb(19 26 48)', { v: 1, background: { type: 'solid', color: '#131A30' } }],
        ['linear, filled stops', 'background: linear-gradient(to right, hsl(0, 0%, 0%), #fff 70%, #888)',
            { v: 1, background: { type: 'linear', angle: 90, stops: [{ color: 'hsl(0 0% 0%)' }, { color: '#FFF', at: 70 }, { color: '#888888' }] } }],
        ['radial', 'background: radial-gradient(circle, #243056, #0b0f1e)', { v: 1, background: { type: 'radial', shape: 'circle', stops: [{ color: '#243056' }, { color: '#0b0f1e', at: 100 }] } }],
        ['repeating', 'background: repeating-linear-gradient(45deg, #fff1 0%, #0000 10%)', { v: 1, background: { type: 'repeating-linear', angle: 45, stops: [{ color: '#ffffff11' }, { color: '#00000000', at: 10 }] } }],
        ['border defaults', 'border: #ff6b5e', { v: 1, border: { color: '#ff6b5e' } }],
        ['border per side', 'border-style: solid; border-width: 3px 1px 1px 1px; border-color: #fff #000', { v: 1, border: { width: [3, 1, 1, 1], color: ['#fff', '#000', '#ffffff', 'rgb(0,0,0)'] } }],
        ['gradient border', 'border-width: 2px; border-image: linear-gradient(90deg, #25e0c8, #a78bfa) 1', { v: 1, border: { width: 2, gradient: { angle: 90, stops: [{ color: '#25e0c8' }, { color: '#a78bfa' }] } } }],
        ['radius 4', 'border-radius: 4px 18px', { v: 1, radius: [4, 18, 4, 18] }],
        ['radius uniform', 'border-radius: 30px', { v: 1, radius: [30, 30, 30, 30] }],
        ['padding', 'padding: 12px 16px', { v: 1, padding: 'roomy' }],
        ['shadow clamped', 'box-shadow: 0 0 40px #25e0c8', { v: 1, shadows: [{ color: 'rgb(37,224,200)', blur: 40 }] }],
        ['text', 'color: rgba(244, 247, 255, 1)', { v: 1, text: '#f4f7ff' }],
        ['text glow + align + spacing', 'text-shadow: 0 0 4px success; text-align: center; heading-align: right; letter-spacing: 0.25px',
            { v: 1, textGlow: { color: 'success' }, align: 'center', headingAlign: 'right', letterSpacing: 0.25 }],
        ['opacity', 'background: #000; background-opacity: 0.5', { v: 1, background: { type: 'solid', color: '#000' }, backgroundOpacity: 50 }],
        ['everything',
            'background: linear-gradient(160deg, #16213d, #0f1a2e); border: 1px solid #25e0c855; border-radius: 14px; padding: 8px 12px; box-shadow: 0 0 14px 0 #25e0c833; color: #f4f7ff; stripe: 4px theme(accent); animation: drift 9s',
            { v: 1, background: { type: 'linear', angle: 160, stops: [{ color: '#16213d', at: 0 }, { color: '#0f1a2e', at: 100 }] }, border: { width: 1, style: 'solid', color: '#25e0c855' }, radius: 14, padding: 'cozy', shadows: [{ x: 0, y: 0, color: '#25e0c833', blur: 14, spread: 0 }], text: '#f4f7ff', stripe: { color: 'accent', width: 4 }, animation: { name: 'drift', seconds: 9 } }],
    ];
    it.each(pairs)('%s', (_n, cssText, json) => {
        const fromCss = parseCardStyleCss(cssText).style;
        const fromJson = normalizeCardStyle(json);
        expect(fromCss).not.toBeNull();
        expect(fromJson).toEqual(fromCss);
        expect(JSON.stringify(fromJson)).toBe(JSON.stringify(fromCss)); // same field order, same bytes
    });
});

describe('normaliser rules', () => {
    it('is idempotent and canonical', () => {
        const s = normalizeCardStyle({ v: 1, radius: [3, 3, 3, 3], text: '#FFF', shadows: [{ color: '#fff', blur: 3.4 }] })!;
        expect(s).toEqual({ v: 1, radius: 3, shadows: [{ x: 0, y: 0, blur: 3, spread: 0, color: '#ffffff' }], text: '#ffffff' });
        expect(normalizeCardStyle(s)).toEqual(s);
    });
    it('drops unknown fields and unknown versions, never guesses', () => {
        expect(normalizeCardStyle({ v: 1, text: '#fff', future: { x: 1 }, onclick: 'x' })).toEqual({ v: 1, text: '#ffffff' });
        expect(normalizeCardStyle({ v: 2, text: '#fff' })).toBeNull();
        expect(normalizeCardStyle({ text: '#fff' })).toBeNull();
        expect(normalizeCardStyle({ v: '1', text: '#fff' })).toBeNull();
        expect(normalizeCardStyle({ v: 1 })).toBeNull();
        expect(normalizeCardStyle({ v: 1, border: { width: 2, style: 'groove', color: '#fff' } })).toBeNull();
        expect(normalizeCardStyle({ v: 1, shadows: [{ color: '#fff' }, { color: '#fff' }, { color: '#fff' }] })).toBeNull();
    });
    it('round-trips through its own CSS, for every field', () => {
        const s = style([
            'background: repeating-radial-gradient(circle, #243056 0%, #0b0f1e 8%)', 'background-opacity: 80%',
            'border-style: double', 'border-width: 3px 1px', 'border-color: #2a3558 #ffc94d', 'border-radius: 6px 12px',
            'padding: 4px 8px', 'box-shadow: 0 2px 6px 1px #ffc94d40, 0 0 3px #000', 'color: #f4f7ff', 'text-shadow: 0 0 3px #000',
            'text-align: right', 'heading-align: center', 'letter-spacing: -0.3px', 'stripe: 5px theme(info)', 'animation: shimmer 10s',
        ].join('; '))!;
        expect(Object.keys(s)).toHaveLength(14); // v + all 13 fields
        expect(parseCardStyleCss(cardStyleToCss(s)).style).toEqual(s);
        expect(parseCardStyleCss(cardStyleToCss(s)).declarations.every(d => d.status === 'accepted')).toBe(true);
        expect(cardStyleByteSize(s)).toBeLessThan(CARD_STYLE_MAX_BYTES);
    });
    it(`the largest legal style is under the ${CARD_STYLE_MAX_BYTES}-byte cap`, () => {
        const six = Array.from({ length: 6 }, (_, i) => ({ color: `theme(danger / ${10 + i}%)`, at: i * 20 }));
        const s = normalizeCardStyle({
            v: 1, background: { type: 'repeating-linear', angle: 359, stops: six }, backgroundOpacity: 55,
            border: { width: 4, gradient: { angle: 359, stops: six } }, radius: [24, 23, 22, 21], padding: 'roomy',
            shadows: [{ x: -8, y: -8, blur: 16, spread: 4, color: 'theme(accent / 99%)' }, { x: 8, y: 8, blur: 16, spread: 4, color: 'theme(accent / 98%)' }],
            text: 'theme(muted / 99%)', textGlow: { color: 'theme(muted / 99%)', blur: 8 }, align: 'center', headingAlign: 'right',
            letterSpacing: -0.5, stripe: { color: 'theme(warning / 99%)', width: 6 }, animation: { name: 'shimmer', seconds: 19.5 },
        })!;
        expect(s).not.toBeNull();
        expect(cardStyleByteSize(s)).toBeLessThan(1500);
    });
});

describe('message content', () => {
    const st = { v: 1, text: '#ffffff' } as CardStyle;
    it('cardStyleOfContent validates whatever the sender kind', () => {
        expect(cardStyleOfContent({ type: 'text', text: 'a', card_style: st })).toEqual(st);
        expect(cardStyleOfContent({ type: 'app_message', text: 'a', card_style: st })).toEqual(st);
        expect(cardStyleOfContent({ type: 'text', text: 'a', card_style: { v: 9 } })).toBeNull();
        expect(cardStyleOfContent(null)).toBeNull();
    });
    it('edits: absent keeps, null clears, valid replaces, invalid keeps', () => {
        const orig = { type: 'text', text: 'a', card_style: st };
        const other = { v: 1, padding: 'roomy' } as CardStyle;
        expect(withEditCardStyle(orig, { type: 'edit', text: 'b' })).toEqual(orig);
        expect(withEditCardStyle(orig, { type: 'edit', text: 'b', card_style: null })).toEqual({ type: 'text', text: 'a' });
        expect(withEditCardStyle(orig, { type: 'edit', text: 'b', card_style: other })).toEqual({ ...orig, card_style: other });
        expect(withEditCardStyle(orig, { type: 'edit', text: 'b', card_style: { v: 7, x: 1 } })).toEqual(orig);
        expect(withEditCardStyle({ type: 'text', text: 'a' }, { card_style: st })).toEqual({ type: 'text', text: 'a', card_style: st });
    });
    it('the server-checked styled flag gates channel rows; DMs need none', () => {
        const c = { type: 'text', text: 'a', card_style: st };
        expect(gateCardStyleByFlag(c, { isServerChannel: true, styledFlag: true })).toEqual(c);
        expect(gateCardStyleByFlag(c, { isServerChannel: true, styledFlag: false })).toEqual({ type: 'text', text: 'a' });
        expect(gateCardStyleByFlag(c, { isServerChannel: true, styledFlag: undefined })).toEqual({ type: 'text', text: 'a' });
        expect(gateCardStyleByFlag(c, { isServerChannel: true, styledFlag: 'true' })).toEqual({ type: 'text', text: 'a' });
        expect(gateCardStyleByFlag(c, { isServerChannel: false, styledFlag: undefined })).toEqual(c);
        // Removing a style needs no permission: an unflagged edit with null survives.
        const rm = { type: 'edit', text: 'a', card_style: null };
        expect(gateCardStyleByFlag(rm, { isServerChannel: true, styledFlag: false })).toEqual(rm);
    });
    it('cardStyledFlag: true only for content that sets a valid style', () => {
        expect(cardStyledFlag({ type: 'text', card_style: st })).toBe(true);
        expect(cardStyledFlag({ type: 'edit', card_style: null })).toBe(false);
        expect(cardStyledFlag({ type: 'text', card_style: { v: 5 } })).toBe(false);
        expect(cardStyledFlag({ type: 'text' })).toBe(false);
    });
});
