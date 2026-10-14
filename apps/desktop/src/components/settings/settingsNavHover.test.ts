/**
 * Settings left nav (the depth gauge): the hover highlight must appear
 * immediately. Root cause of the old lag: DepthGauge set an inline
 * `transition-delay` (0.2s + 35 ms per item) for the entrance stagger, and a
 * transition-delay applies to EVERY transitioned property - so the hover
 * colour/background waited 200-585 ms. The stagger now rides a CSS variable
 * that only transform + opacity read.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(__dirname, '../../styles/settings-descent.css'), 'utf8');
const gauge = readFileSync(resolve(__dirname, 'DepthGauge.tsx'), 'utf8');

/** The base `.sd-nitem{...}` rule body (the one that declares `transition`). */
function nitemTransition(): string {
    const m = css.match(/\.sd-nitem\{[^}]*?transition:([^}]*)\}/);
    expect(m).not.toBeNull();
    return m![1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
}

/** Splits a transition list on top-level commas only (var(), cubic-bezier() contain commas). */
function splitList(v: string): string[] {
    const out: string[] = [];
    let depth = 0, cur = '';
    for (const ch of v) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

describe('settings nav hover is instant', () => {
    it('DepthGauge no longer sets an inline transition-delay on nav items', () => {
        expect(gauge).not.toMatch(/transitionDelay/);
        expect(gauge).toMatch(/--sd-enter-delay/);
    });

    it('hover colour + background transition fast (<= 100 ms) with no delay', () => {
        const parts = splitList(nitemTransition());
        for (const prop of ['color', 'background-color']) {
            const entry = parts.find(p => p.startsWith(prop + ' '));
            expect(entry, `${prop} transition`).toBeDefined();
            const times = entry!.match(/(\d*\.?\d+)(ms|s)\b/g) ?? [];
            // exactly one time value: the duration. A second would be a delay.
            expect(times).toHaveLength(1);
            const t = times[0] ?? '';
            const ms = t.endsWith('ms') ? parseFloat(t) : parseFloat(t) * 1000;
            expect(ms).toBeLessThanOrEqual(100);
        }
    });

    it('only transform + opacity read the entrance delay', () => {
        const parts = splitList(nitemTransition());
        const withDelay = parts.filter(p => p.includes('--sd-enter-delay')).map(p => p.split(' ')[0]);
        expect(withDelay.sort()).toEqual(['opacity', 'transform']);
    });

    it('does not use transition: all, and the hover rules are pure CSS (no JS hover state)', () => {
        expect(nitemTransition()).not.toMatch(/\ball\b/);
        expect(css).toMatch(/\.sd-nitem:hover\{/);
        expect(gauge).not.toMatch(/onMouseEnter|onMouseOver|onPointerEnter/);
    });
});
