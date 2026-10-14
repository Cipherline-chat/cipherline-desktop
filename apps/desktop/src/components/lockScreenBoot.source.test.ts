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
        expect(splash).toMatch(/linear-gradient/);
        expect(splash).toMatch(/aria-hidden="true"/);
        expect(splash).not.toMatch(/<canvas|<progress|<svg|<img|lo-|loading|bar/i);
        // Exactly one element, with no children and no text.
        expect(splash.match(/<[a-z]/gi)).toHaveLength(1);
        expect(splash.replace(/<[^>]*>/g, '').trim()).toBe('');
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

    it('has a fully opaque backdrop in both states (field up / not up): no rgba/alpha, no transparent', () => {
        const bg = rootStyle![2].replace(/\/\/.*$/gm, ''); // code only, not the comments
        expect(bg).toMatch(/background:/);
        // Every colour on the backdrop is an opaque hex or the opaque abyss token.
        expect(bg).not.toMatch(/rgba?\(|hsla?\(|transparent|opacity|backdrop-filter|#[0-9a-fA-F]{8}\b/);
        expect(bg).toMatch(/#131A30[\s\S]*#0F1526[\s\S]*#0B0F1E/);
        expect(bg).toMatch(/var\(--cl-abyss\)/);
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
        expect(css).toMatch(/\.sl-panel\s*{[^}]*rgba\(11, 15, 30, \.66\)/);
        expect(overlay).toContain('<LockScreenField');
    });
});

describe('the lock\'s field is isolated from the boot loading screen', () => {
    it('LockScreenField spawns its own worker and never acquires the parked one', () => {
        const src = read('src/components/LockScreenField.tsx');
        expect(src).toMatch(/spawnWorker\(\)/);
        expect(src).not.toMatch(/acquireWorker\(/);
    });
});
