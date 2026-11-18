/**
 * Message card style, the three bot-friendly parts (owner, 2026-11-17):
 *  1. theme colours (`theme(success)`): resolved per viewer theme, never a var();
 *  2. the accent stripe (`stripe` in CSS and JSON);
 *  3. "can't fake the app": reserved looks are neutralised, and every
 *     styled card keeps an app-drawn edge.
 * Contract: docs/message-card-style.md.
 */
import { describe, it, expect } from 'vitest';
import {
    parseCardStyleCss, normalizeCardStyle, parseCardColor, cardStyleToCss, resolveCardStyle, contrastRatio,
    resolveCardColor, CARD_THEMES, CARD_THEME_TOKENS, CARD_MIN_CONTRAST, CARD_RESERVED_REASONS, type CardStyle,
} from '@cipherline/shared';
import { CARD_STYLE_TEMPLATES as CARD_STYLE_PRESETS } from './cardStyleTemplates';

const style = (t: string) => parseCardStyleCss(t).style;

describe('theme colours', () => {
    it.each(CARD_THEME_TOKENS)('theme(%s) is a colour everywhere a colour is accepted', (tok) => {
        expect(parseCardColor(`theme(${tok})`)).toBe(`theme(${tok})`);
        expect(parseCardColor(tok)).toBe(`theme(${tok})`); // JSON convenience: the bare name
        expect(parseCardColor(`theme(${tok} / 20%)`)).toBe(`theme(${tok} / 20%)`);
        expect(parseCardColor(`theme(${tok} / 0.5)`)).toBe(`theme(${tok} / 50%)`);
        expect(parseCardColor(`theme(${tok} / 100%)`)).toBe(`theme(${tok})`);
    });

    it('works in every colour slot, from CSS and JSON identically', () => {
        const fromCss = style('background: linear-gradient(90deg, theme(success / 15%), theme(info / 10%)); border: 1px solid theme(success / 40%); box-shadow: 0 0 10px theme(success / 30%); color: theme(success); stripe: 4px solid theme(success)');
        const fromJson = normalizeCardStyle({
            v: 1,
            background: { type: 'linear', angle: 90, stops: [{ color: 'theme(success / 0.15)' }, { color: 'theme(info / 10%)' }] },
            border: { color: 'theme(success / 40%)' },
            shadows: [{ color: 'theme(success / 30%)', blur: 10 }],
            text: 'success',
            stripe: { color: 'success', width: 4 },
        });
        expect(fromCss).not.toBeNull();
        expect(fromJson).toEqual(fromCss);
        expect(parseCardStyleCss(cardStyleToCss(fromCss)).style).toEqual(fromCss);
    });

    it('rejects unknown tokens, nesting and anything var()-shaped', () => {
        for (const bad of ['theme(brand)', 'theme(--cl-lume)', 'theme(success, success)', 'theme(rgb(1,2,3))', 'theme()', 'theme(success / x)', 'var(--success)', 'theme(success) !important', 'SuccessK']) {
            expect(parseCardColor(bad), bad).toBeNull();
        }
        const r = parseCardStyleCss('color: theme(brand)');
        expect(r.declarations[0].status).toBe('ignored');
        expect(r.declarations[0].reason).toMatch(/theme\(\) takes one of accent, success/);
    });

    it('resolves per theme to a CONCRETE colour (never var())', () => {
        const s = normalizeCardStyle({ v: 1, background: { type: 'solid', color: 'theme(danger / 12%)' }, stripe: { color: 'danger' }, text: 'theme(danger)' })!;
        const dark = resolveCardStyle(s, 'full', CARD_THEMES.dark)!;
        const light = resolveCardStyle(s, 'full', CARD_THEMES.light)!;
        expect(dark.stripe!.color).toBe('rgb(255, 107, 94)');
        expect(light.stripe!.color).toBe('rgb(180, 35, 24)');
        expect(dark.backgroundColor).toBe('rgba(255, 107, 94, 0.12)');
        for (const r of [dark, light]) expect(JSON.stringify(r)).not.toMatch(/var\(|theme\(/);
    });

    it.each(Object.keys(CARD_THEMES))('every token is readable as text on the %s theme background', (name) => {
        const theme = CARD_THEMES[name as keyof typeof CARD_THEMES];
        const bg = resolveCardColor(theme.background, theme)!;
        for (const tok of CARD_THEME_TOKENS) {
            const c = resolveCardColor(`theme(${tok})`, theme)!;
            expect(contrastRatio([c[0], c[1], c[2]], [bg[0], bg[1], bg[2]]), `${name} ${tok}`).toBeGreaterThanOrEqual(CARD_MIN_CONTRAST);
        }
    });

    it('the contrast rule holds on the resolved values in EVERY theme', () => {
        // A bot style with theme text on a theme tint: readable in both themes.
        const s = normalizeCardStyle({ v: 1, background: { type: 'solid', color: 'theme(success / 12%)' }, text: 'success', stripe: { color: 'success' } })!;
        for (const theme of Object.values(CARD_THEMES)) {
            const r = resolveCardStyle(s, 'full', theme)!;
            expect(r.textColor, theme.background).toBeDefined();
        }
        // A literal pale text that only works on dark is used on dark and
        // NUDGED darker on light (never left unreadable).
        const pale = normalizeCardStyle({ v: 1, text: '#e8ecf8' })!;
        expect(resolveCardStyle(pale, 'full', CARD_THEMES.dark)!.notes.textAdjusted).toBeUndefined();
        const onLight = resolveCardStyle(pale, 'full', CARD_THEMES.light)!;
        expect(onLight.notes.textAdjusted).toBeDefined();
        expect(onLight.textColor).not.toBe('rgb(232, 236, 248)');
    });
});

describe('accent stripe', () => {
    it('stripe in CSS and JSON: width 2..6 (default 3), solid only', () => {
        expect(style('stripe: 4px solid #ff6b5e')).toEqual({ v: 1, stripe: { color: '#ff6b5e', width: 4 } });
        expect(style('stripe: theme(danger)')).toEqual({ v: 1, stripe: { color: 'theme(danger)', width: 3 } });
        expect(style('stripe: 40px #fff')!.stripe!.width).toBe(6);
        expect(style('stripe: 1px #fff')!.stripe!.width).toBe(2);
        expect(parseCardStyleCss('stripe: 4px dashed #fff').declarations[0]).toMatchObject({ status: 'ignored', reason: expect.stringMatching(/always solid/) });
        // border-left is a real per-side border, not the stripe.
        expect(style('border-left: 4px solid #ff6b5e')).toEqual({ v: 1, border: { width: [0, 0, 0, 4], style: 'solid', color: '#ff6b5e' } });
        expect(normalizeCardStyle({ v: 1, stripe: { color: 'warning', width: 99 } })).toEqual({ v: 1, stripe: { color: 'theme(warning)', width: 6 } });
        expect(normalizeCardStyle({ v: 1, stripe: { color: 'url(x)' } })).toBeNull();
        expect(normalizeCardStyle({ v: 1, stripe: { color: '#fff', width: NaN } })).toBeNull();
    });
    it('resolves with a concrete colour; the renderer draws it inside the card', () => {
        const r = resolveCardStyle(style('stripe: 5px theme(info)'), 'full', CARD_THEMES.dark)!;
        expect(r.stripe).toEqual({ width: 5, color: 'rgb(94, 142, 224)' });
    });
});

describe("can't fake the app: reserved looks", () => {
    it('a dashed / dotted accent or muted border (the private-reply look) is drawn solid, with the reason', () => {
        for (const c of ['theme(accent)', 'theme(muted / 50%)', '#25e0c8', '#2ad9c2', '#0a6b60', '#a7b3d4']) {
            for (const st of ['dashed', 'dotted']) {
                const r = parseCardStyleCss(`border: 1px ${st} ${c}`);
                expect(r.style!.border!.style, `${st} ${c}`).toBe('solid');
                expect(r.declarations[0]).toMatchObject({ status: 'adjusted' });
                expect(r.declarations[0].reason).toContain(CARD_RESERVED_REASONS.private_reply);
            }
        }
        // Dashed in a non-reserved colour stays dashed.
        expect(style('border: 1px dashed #ff6b5e')!.border!.style).toBe('dashed');
        expect(normalizeCardStyle({ v: 1, border: { style: 'dotted', color: 'accent' } })!.border!.style).toBe('solid');
    });

    it('a fully rounded card with tight padding (the system / notice pill) gets 12px corners', () => {
        const r = parseCardStyleCss('border-radius: 24px; padding: 4px 8px; background: theme(info / 10%)');
        expect(r.style!.radius).toBe(12);
        const rad = r.declarations.find(d => d.property === 'border-radius')!;
        expect(rad.status).toBe('adjusted');
        expect(rad.reason).toContain(CARD_RESERVED_REASONS.notice_pill);
        // Round with roomier padding, or tight with one square corner: fine.
        expect(style('border-radius: 24px; padding: 8px 12px')!.radius).toBe(24);
        expect(style('border-radius: 24px 24px 24px 4px; padding: 4px 8px')!.radius).toEqual([24, 24, 24, 4]);
        expect(normalizeCardStyle({ v: 1, radius: [20, 30, 20, 30], padding: 'tight' })!.radius).toBe(12);
    });

    it('neutralising is idempotent (a reader re-normalising changes nothing)', () => {
        const s = normalizeCardStyle({ v: 1, border: { style: 'dashed', color: 'accent' }, radius: 24, padding: 'tight' })!;
        expect(normalizeCardStyle(s)).toEqual(s);
    });

    it('every styled card keeps a visible edge: the app draws a hairline unless the sender border is visible', () => {
        const dark = CARD_THEMES.dark;
        expect(resolveCardStyle(style('background: #0b0f1e')!, 'full', dark)!.edge).toBe(true); // camouflaged as the row
        expect(resolveCardStyle(style('border: 1px solid #0b0f1e; color: #fff')!, 'full', dark)!.edge).toBe(true); // invisible border
        expect(resolveCardStyle(style('border: 1px solid #25e0c80d; color: #fff')!, 'full', dark)!.edge).toBe(true); // 5% alpha border
        expect(resolveCardStyle(style('border: 1px solid #25e0c8; color: #fff')!, 'full', dark)!.edge).toBe(false);
    });

    it('every preset passes the contrast rule and avoids the reserved looks in both themes', () => {
        for (const p of CARD_STYLE_PRESETS) {
            expect(normalizeCardStyle(p.style), p.id).toEqual(p.style); // already canonical: nothing neutralised
            for (const theme of Object.values(CARD_THEMES)) {
                const r = resolveCardStyle(p.style, 'full', theme)!;
                expect(r.notes.backgroundDropped, `${p.id} on ${theme.background}`).toBeUndefined();
            }
        }
    });

    it('hostile bot looks from the doc normalise as documented', () => {
        const fakeEphemeral = parseCardStyleCss('border: 1px dashed theme(accent / 60%); background: theme(accent / 6%); border-radius: 8px');
        expect(fakeEphemeral.style!.border!.style).toBe('solid');
        const fakeSystemRow = parseCardStyleCss('background: rgba(59, 130, 246, 0.07); border: 1px solid rgba(59, 130, 246, 0.2); border-radius: 9999px; padding: 4px 12px; color: #60a5fa');
        expect(fakeSystemRow.style!.radius).toBe(12);
        const s: CardStyle = fakeSystemRow.style!;
        expect(normalizeCardStyle(s)).toEqual(s);
    });
});
