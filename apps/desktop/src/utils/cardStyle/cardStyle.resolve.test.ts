/**
 * Message card style: render resolution (shared resolveCardStyle) — the
 * readability rule (sender colour floor 3:1 with a nudge; the app's own text
 * at AA 4.5:1), the three render modes, and how the reader / server /
 * show-plain / reduced-motion switches combine (effectiveCardRenderMode).
 */
import { describe, it, expect } from 'vitest';
import {
    resolveCardStyle, effectiveCardRenderMode, contrastRatio, normalizeCardStyle, CARD_MIN_CONTRAST, CARD_TEXT_FLOOR, CARD_THEMES,
    CARD_SHADOW_REACH_MAX, shadowReach,
    type CardStyle, type UserCardStyleMode, type ServerMessageStyles,
} from '@cipherline/shared';

const THEME = CARD_THEMES.dark;
const s = (o: object) => normalizeCardStyle({ v: 1, ...o }) as CardStyle;
const rgb = (css: string): [number, number, number] => css.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number) as [number, number, number];

describe('readability', () => {
    it('the ratio itself', () => {
        expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 5);
        expect(contrastRatio([119, 119, 119], [255, 255, 255])).toBeCloseTo(4.48, 1);
    });

    it('a readable sender colour is used exactly as chosen', () => {
        const r = resolveCardStyle(s({ background: { type: 'solid', color: '#fff4d6' }, text: '#2b2112' }), 'full', THEME)!;
        expect(r.textColor).toBe('rgb(43, 33, 18)');
        expect(r.notes.textAdjusted).toBeUndefined();
    });

    it(`a sender colour between ${CARD_TEXT_FLOOR}:1 and AA is the author's call: used as is`, () => {
        // #5e6b8f (cl-faint) on abyss is ~3.6:1.
        const r = resolveCardStyle(s({ text: '#5e6b8f' }), 'full', THEME)!;
        expect(r.textColor).toBe('rgb(94, 107, 143)');
        expect(r.notes.textAdjusted).toBeUndefined();
    });

    it(`below ${CARD_TEXT_FLOOR}:1 the colour is NUDGED toward legibility (not dropped), and the note says so`, () => {
        const r = resolveCardStyle(s({ background: { type: 'solid', color: '#131a30' }, text: '#1c2542' }), 'full', THEME)!;
        expect(r.notes.textAdjusted!.ratio).toBeLessThan(CARD_TEXT_FLOOR);
        expect(r.textColor).toBe(r.notes.textAdjusted!.to);
        expect(contrastRatio(rgb(r.textColor!), [19, 26, 48])).toBeGreaterThanOrEqual(CARD_TEXT_FLOOR);
        // Still the sender's hue family: lighter, not swapped for white.
        expect(r.textColor).not.toBe('rgb(255, 255, 255)');
    });

    it('a dark text on a dark card is nudged lighter; a pale text on a pale card is nudged darker', () => {
        const dark = resolveCardStyle(s({ text: '#0b0f1e' }), 'full', THEME)!;
        expect(rgb(dark.textColor!)[0]).toBeGreaterThan(11);
        const pale = resolveCardStyle(s({ background: { type: 'solid', color: '#fff4d6' }, text: '#fff8e0' }), 'full', THEME)!;
        expect(rgb(pale.textColor!)[0]).toBeLessThan(255);
        expect(pale.notes.textAdjusted).toBeDefined();
    });

    it('a translucent background is composited over the theme before measuring', () => {
        const bg = { type: 'solid', color: '#ffffff1a' };
        expect(resolveCardStyle(s({ background: bg, text: '#ffffff' }), 'full', THEME)!.notes.textAdjusted).toBeUndefined();
        expect(resolveCardStyle(s({ background: bg, text: '#000000' }), 'full', THEME)!.notes.textAdjusted).toBeDefined();
    });

    it('background opacity is applied before measuring', () => {
        const full = resolveCardStyle(s({ background: { type: 'solid', color: '#ffffff' } }), 'full', THEME)!;
        expect(full.notes.autoText).toBe(true); // white card: the app picks dark text
        const faint = resolveCardStyle(s({ background: { type: 'solid', color: '#ffffff' }, backgroundOpacity: 5 }), 'full', THEME)!;
        expect(faint.notes.autoText).toBeUndefined(); // 5% white over abyss: the app's text is fine
        expect(faint.backgroundColor).toBe('rgba(255, 255, 255, 0.05)');
    });

    it('every part of a gradient counts, including between the stops', () => {
        // Dark text passes AA on neither the middle blend nor needs to: it is
        // nudged until it clears the floor across the WHOLE gradient.
        const dip = { type: 'linear', angle: 90, stops: [{ color: '#ff4337' }, { color: '#1c9110' }] };
        const r = resolveCardStyle(s({ background: dip, text: '#0b0f1e' }), 'full', THEME)!;
        expect(r.textColor).toBeDefined();
        for (const bg of [[255, 67, 55], [28, 145, 16], [142, 106, 36]] as [number, number, number][]) {
            expect(contrastRatio(rgb(r.textColor!), bg)).toBeGreaterThanOrEqual(CARD_TEXT_FLOOR - 0.05);
        }
    });

    it('with no sender colour, the app text must reach AA, else the app picks one (autoText)', () => {
        const r = resolveCardStyle(s({ background: { type: 'solid', color: '#ffffff' } }), 'full', THEME)!;
        expect(r.textColor).toBe('rgb(11, 15, 30)');
        expect(r.notes.autoText).toBe(true);
        expect(r.backgroundColor).toBe('rgb(255, 255, 255)');
        expect(resolveCardStyle(s({ background: { type: 'solid', color: '#131a30' } }), 'full', THEME)!.textColor).toBeUndefined();
        expect(contrastRatio([244, 247, 255], [19, 26, 48])).toBeGreaterThanOrEqual(CARD_MIN_CONTRAST);
    });

    it('a background no text colour can read on is dropped', () => {
        const r = resolveCardStyle(s({ background: { type: 'linear', stops: [{ color: '#000000' }, { color: '#ffffff' }] } }), 'full', THEME)!;
        expect(r.backgroundImage).toBeUndefined();
        expect(r.notes.backgroundDropped).toBe(true);
    });
});

describe('render modes', () => {
    const animated = s({
        background: { type: 'linear', angle: 135, stops: [{ color: '#1b2a5a' }, { color: '#0f3b3a' }] },
        shadows: [{ color: '#25e0c866', blur: 12 }],
        animation: { name: 'drift', seconds: 9 },
    });
    it('full keeps the animation, static drops only the animation, plain draws nothing', () => {
        const full = resolveCardStyle(animated, 'full', THEME)!;
        const stat = resolveCardStyle(animated, 'static', THEME)!;
        expect(full.animation).toEqual({ name: 'drift', seconds: 9 });
        expect(stat.animation).toBeUndefined();
        expect(stat.backgroundImage).toBe(full.backgroundImage);
        expect(stat.boxShadow).toBe(full.boxShadow);
        expect(resolveCardStyle(animated, 'plain', THEME)).toBeNull();
    });
    it('defaults: radius 10, cozy padding', () => {
        const r = resolveCardStyle(s({ text: '#ffffff' }), 'full', THEME)!;
        expect(r.radius).toEqual([10, 10, 10, 10]);
        expect(r.padding).toEqual([8, 12]);
    });
    it('shadows are always OUTER (no inset keyword can be produced)', () => {
        expect(resolveCardStyle(animated, 'full', THEME)!.boxShadow).toBe('0px 0px 12px 0px rgba(37, 224, 200, 0.4)');
        expect(resolveCardStyle(animated, 'full', THEME)!.boxShadow).not.toMatch(/inset/);
    });
    it('a gradient border is drawn with transparent borders and layered backgrounds', () => {
        const r = resolveCardStyle(s({ background: { type: 'solid', color: '#131a30' }, border: { width: 2, gradient: { angle: 90, stops: [{ color: '#25e0c8' }, { color: '#a78bfa' }] } } }), 'full', THEME)!;
        expect(r.borderColor).toEqual(['transparent', 'transparent', 'transparent', 'transparent']);
        expect(r.borderWidth).toEqual([2, 2, 2, 2]);
        expect(r.backgroundClip).toBe('padding-box, padding-box, border-box');
        expect(r.backgroundImage).toMatch(/^linear-gradient\(rgb\(19, 26, 48\), rgb\(19, 26, 48\)\), linear-gradient\(rgb\(11, 15, 30\), rgb\(11, 15, 30\)\), linear-gradient\(90deg/);
        expect(r.edge).toBe(false);
    });
    it('no style, or an invalid one, draws nothing', () => {
        expect(resolveCardStyle(null, 'full', THEME)).toBeNull();
        expect(resolveCardStyle({ v: 2 } as unknown as CardStyle, 'full', THEME)).toBeNull();
    });
});

describe('effectiveCardRenderMode: the strictest switch wins', () => {
    const users: UserCardStyleMode[] = ['all', 'static', 'plain'];
    const servers: (ServerMessageStyles | null)[] = [null, 'on', 'no_animation', 'off'];
    for (const user of users) for (const server of servers) for (const showPlain of [false, true]) for (const reducedMotion of [false, true]) {
        const want = showPlain || user === 'plain' || server === 'off' ? 'plain'
            : reducedMotion || user === 'static' || server === 'no_animation' ? 'static' : 'full';
        it(`user=${user} server=${server ?? 'DM'} showPlain=${showPlain} reducedMotion=${reducedMotion} -> ${want}`, () => {
            expect(effectiveCardRenderMode({ user, server, showPlain, reducedMotion })).toBe(want);
        });
    }
    it('unknown values fall back to the defaults (all / on)', () => {
        expect(effectiveCardRenderMode({ user: 'weird' as UserCardStyleMode, server: 'loud' as ServerMessageStyles })).toBe('full');
    });
});

describe('shadow reach (what the renderer reserves and clips)', () => {
    it('is blur + spread shifted by the offset, per side, capped at CARD_SHADOW_REACH_MAX', () => {
        expect(shadowReach([{ x: 0, y: 4, blur: 6, spread: 0, color: '#000' }])).toEqual({ top: 2, right: 6, bottom: 10, left: 6 });
        expect(shadowReach([{ x: -8, y: 8, blur: 16, spread: 4, color: '#000' }])).toEqual({ top: 12, right: 12, bottom: CARD_SHADOW_REACH_MAX, left: CARD_SHADOW_REACH_MAX });
        expect(shadowReach([{ x: 8, y: 8, blur: 0, spread: 0, color: '#000' }])).toEqual({ top: 0, right: 8, bottom: 8, left: 0 });
    });
    it('every resolved style with shadows carries its reach; without shadows, none', () => {
        expect(resolveCardStyle(s({ shadows: [{ color: '#fff', blur: 10 }] }), 'full', THEME)!.shadowReach).toEqual({ top: 10, right: 10, bottom: 10, left: 10 });
        expect(resolveCardStyle(s({ text: '#fff' }), 'full', THEME)!.shadowReach).toBeUndefined();
    });
});
