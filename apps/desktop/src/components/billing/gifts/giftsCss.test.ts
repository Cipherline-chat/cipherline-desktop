import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UNWRAP_END_KEYFRAME, UNWRAP_FADE_END_KEYFRAME, UNWRAP_FADE_MS, UNWRAP_MS } from './GiftBox';

/**
 * Layout rules in styles/gifts.css that the window-size check (2026-11-18) found
 * missing. jsdom has no layout, so these pin the rules themselves.
 */
const css = readFileSync(join(__dirname, '../../../styles/gifts.css'), 'utf8');
const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `${selector} rule exists`).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf('}', at));
};

describe('gifts.css', () => {
    it('the celebration wraps a long recipient name instead of running out of the modal', () => {
        // "Sent to <name>" and "We couldn't send the card to <name>." — an unbroken
        // name wider than the 340 px column must break, not overflow.
        expect(rule('.gft-done h2')).toMatch(/overflow-wrap:\s*anywhere/);
        expect(rule('.gft-done .gft-done-sub')).toMatch(/overflow-wrap:\s*anywhere/);
    });
});

/** The CSS the gift card's "welcome after the unwrap" ordering depends on (owner 2026-11-18). */
describe('gifts.css: the unwrap the Pro welcome waits for', () => {
    const keyframes = (name: string) => {
        const at = css.indexOf(`@keyframes ${name} {`);
        expect(at, `@keyframes ${name}`).toBeGreaterThanOrEqual(0);
        // one-line or nested block: read to the matching brace
        let depth = 0, i = css.indexOf('{', at);
        for (; i < css.length; i++) { if (css[i] === '{') depth++; else if (css[i] === '}' && --depth === 0) break; }
        return css.slice(at, i + 1);
    };
    /** [duration, delay] in ms of every `animation:` using `name` in the unwrapping state. */
    const timings = (name: string) => [...css.matchAll(new RegExp(`\\[data-state="unwrapping"\\][^{]*\\{[^}]*animation:\\s*${name}\\s+(\\d+)ms[^;]*?(?:\\s(\\d+)ms)?\\s+both`, 'g'))]
        .map((m) => [Number(m[1]), Number(m[2] ?? 0)]);

    it('the full unwrap ends with UNWRAP_END_KEYFRAME, at UNWRAP_MS, and nothing ends later', () => {
        const end = timings(UNWRAP_END_KEYFRAME);
        expect(end.length).toBe(1);
        expect(end[0][0] + end[0][1]).toBe(UNWRAP_MS);
        const all = [...css.matchAll(/\.gb\[data-state="unwrapping"\][^{]*\{\s*animation:\s*([\w-]+)\s+(\d+)ms[^;]*?(?:\s(\d+)ms)?\s+both/g)]
            .map((m) => Number(m[2]) + Number(m[3] ?? 0));
        expect(all.length).toBeGreaterThan(5);
        expect(Math.max(...all)).toBe(UNWRAP_MS);
    });

    it('reduced motion: the unwrap is an opacity-only cross-fade of UNWRAP_FADE_MS, kept out of the blanket animation:none', () => {
        expect(keyframes('gb-xfade-in')).not.toMatch(/transform|translate|scale|rotate/);
        expect(keyframes('gb-xfade-out')).not.toMatch(/transform|translate|scale|rotate/);
        expect(keyframes(UNWRAP_FADE_END_KEYFRAME)).toMatch(/opacity/);
        const fades = [...css.matchAll(/\.gb\[data-motion="fade"\]\[data-state="unwrapping"\][^{]*\{\s*animation:\s*(gb-xfade-(?:in|out))\s+(\d+)ms[^;]*!important/g)];
        expect(fades.length).toBe(2);
        for (const m of fades) expect(Number(m[2])).toBe(UNWRAP_FADE_MS);
        // The moving parts of the full unwrap stay still in the fade.
        expect(css).toMatch(/\.gb\[data-motion="fade"\]\[data-state="unwrapping"\] \.gb-rig,[\s\S]{0,260}\.gb-sparks circle,[\s\S]{0,200}\{ animation: none !important; \}/);
    });
});
