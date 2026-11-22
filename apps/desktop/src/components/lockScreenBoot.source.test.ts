import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Source-level guards for "nothing of the boot screen behind the lock, and
 * nothing of the app readable through it". Behaviour is covered in
 * HydrationGate.lock.test.ts / LockScreenField.test.ts; these pin the pieces a
 * behaviour test in jsdom cannot see (index.html is never executed there, and
 * jsdom has no compositor to say what is "behind" a translucent layer).
 */
const root = resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

describe('index.html splash', () => {
    const html = read('index.html');
    const splash = html.match(/<div id="root">([\s\S]*?)<\/div>\s*<script/)?.[1] ?? '';

    it('is only the loading screen\'s own backdrop: no bar, no text, no canvas, no progress element', () => {
        // The gradient lives in a <style> (#cl-boot, Dark + Light variants), not inline.
        expect(html).toMatch(/<style>[^<]*#cl-boot\{[^}]*linear-gradient/);
        expect(splash).toMatch(/id="cl-boot"/);
        expect(splash).toMatch(/aria-hidden="true"/);
        expect(splash).not.toMatch(/<canvas|<progress|<svg|<img|lo-|loading|bar/i);
        // Exactly one element, with no children and no text.
        expect(splash.match(/<[a-z]/gi)).toHaveLength(1);
        expect(splash.split(/<[^>]*>/).join('').trim()).toBe('');
    });

    it('is removed by React\'s first render, not by app readiness (so a locked app cannot be left holding it)', () => {
        const main = read('src/main.tsx');
        // createRoot(#root).render(...) replaces #root's children on the first render, in every branch.
        expect(main).toMatch(/createRoot\(document\.getElementById\('root'\)!\)/);
        expect(main).not.toMatch(/getElementById\('root'\)[^;]*\.(remove|style)/);
    });
});

describe('ScreenLockOverlay covers the app opaquely', () => {
    const overlay = read('src/components/ScreenLockOverlay.tsx');
    // The outermost element's style block: from `position: 'fixed'` to its `overflow`.
    const rootStyle = overlay.match(/position: 'fixed', inset: 0, zIndex: (\d+),([\s\S]*?)overflow: 'hidden'/);

    it('is a full-viewport fixed layer above every other z-index in the app', () => {
        expect(rootStyle).not.toBeNull();
        expect(Number(rootStyle![1])).toBeGreaterThanOrEqual(999999);
    });

    it('has a fully opaque backdrop in every state and theme: an opaque base colour, images only on top', () => {
        // The backdrop moved from an inline style to `.sl-root` (screen-lock.css)
        // so the light-scheme themes can paint their own. The inline style must
        // not paint (or un-paint) it.
        const inline = rootStyle![2].replace(/\/\/.*$/gm, ''); // code only, not the comments
        expect(inline).not.toMatch(/background|opacity|backdrop-filter/);
        expect(overlay).toMatch(/className=\{`sl-root\$\{fieldLive \? ' is-live' : ''\}`\}/);

        const css = read('src/styles/screen-lock.css').replace(/\/\*[\s\S]*?\*\//g, '');
        const rules = [...css.matchAll(/([^{}]*\.sl-root[^{}]*)\{([^}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }));
        expect(rules.length).toBeGreaterThanOrEqual(3);
        // The base: the opaque abyss token as background-COLOR (image layers sit on it).
        const base = rules.find(r => r.sel === '.sl-root');
        expect(base?.body).toMatch(/background-color:\s*var\(--cl-abyss\)\s*;/);
        for (const r of rules.filter(x => x !== base)) {
            // Nothing re-sets the colour, the shorthand (which would reset it), or makes the layer see-through.
            expect(r.body, r.sel).not.toMatch(/background-color|background:|opacity|backdrop-filter|mix-blend/);
            // Every image layer list ends in an opaque base (a linear-gradient of tokens), or is `none`.
            const img = r.body.match(/background-image:\s*([^;]+);/)?.[1].trim();
            if (img && img !== 'none') {
                const layers = img.split(/,(?![^(]*\))(?=\s*(?:radial|linear)-gradient)/);
                const last = layers[layers.length - 1];
                expect(last, r.sel).toMatch(/^\s*linear-gradient\(/);
                expect(last, r.sel).not.toMatch(/rgba?\(|hsla?\(|transparent|\/\s*\.\d/);
            }
        }
    });

    it('--cl-abyss is itself opaque', () => {
        const css = read('src/index.css') + read('src/styles/cl-kit.css');
        const m = css.match(/--cl-abyss:\s*([^;]+);/);
        expect(m).not.toBeNull();
        expect(m![1].trim()).toMatch(/^#[0-9a-fA-F]{6}$/);
    });

    it('the translucent PIN panel sits on the overlay\'s opaque backdrop, never on app content', () => {
        const css = read('src/styles/screen-lock.css');
        // The panel is translucent by design (rgba .66) — which is exactly why
        // what is BEHIND the overlay's own backdrop (the lock's field) must be
        // dots only: no loading bar, no app.
        expect(css).toMatch(/\.sl-panel\s*{[^}]*rgb\(var\(--cl-abyss-rgb\) \/ \.66\)/);
        expect(overlay).toContain('<LockScreenField');
        // Light-scheme themes: an opaque card (no field behind it there at all).
        expect(css).toMatch(/:root\[data-scheme="light"\] \.sl-panel\s*{[^}]*background:\s*var\(--cl-deep\);/);
    });
});

describe('the lock\'s field is isolated from the boot loading screen', () => {
    it('LockScreenField spawns its own worker and never acquires the parked one', () => {
        const src = read('src/components/LockScreenField.tsx');
        expect(src).toMatch(/spawnWorker\(\)/);
        expect(src).not.toMatch(/acquireWorker\(/);
    });
});
