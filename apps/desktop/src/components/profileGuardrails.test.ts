// @vitest-environment jsdom
/**
 * Guardrails that keep a profile good-looking whatever is switched on:
 *  - an effect animates CONTINUOUSLY while the app is focused and visible,
 *    pauses when it is blurred / hidden, and is one still frame under reduced
 *    motion (owner, 2026-10-24: "always animate while the app is focused");
 *  - decorations / effects take the theme tint by default ("Match theme");
 *  - the About tab opens at most four blocks and folds the rest under "Show more".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AvatarDecoration, ProfileEffect, EFFECT_PLAY_MS } from './ProfileCosmetics';
import { ProfileCardBlocks } from './ProfileCardParts';
import { ABOUT_BLOCKS_EXPANDED_MAX } from '../utils/profileExtras';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement as (...a: any[]) => React.ReactElement;
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
});

/** jsdom has no canvas: a recording 2D context (every call a no-op; style writes kept). */
function fakeCanvas() {
    const styles: string[] = [];
    let draws = 0;
    const grad = { addColorStop() {} };
    const ctx = new Proxy({} as Record<string | symbol, unknown>, {
        get(t, p) {
            if (p in t) return t[p];
            if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => grad;
            if (p === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
            if (p === 'createImageData') return (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
            if (p === 'canvas') return { width: 122, height: 166 };
            return () => { draws++; };
        },
        set(t, p, v) { t[p] = v; if ((p === 'strokeStyle' || p === 'fillStyle') && typeof v === 'string') styles.push(v); return true; },
    });
    const restore = [
        vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ctx) as any),
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(340),
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(460),
    ];
    let next = 1;
    const frames = new Map<number, FrameRequestCallback>();
    const raf = vi.fn((cb: FrameRequestCallback) => { const id = next++; frames.set(id, cb); return id; });
    const caf = vi.fn((id: number) => { frames.delete(id); });
    (window as any).requestAnimationFrame = raf;
    (window as any).cancelAnimationFrame = caf;
    let now = 0;
    const tick = (n: number) => { for (let i = 0; i < n; i++) { now += 16.7; const pending = [...frames.values()]; frames.clear(); pending.forEach((cb) => cb(now)); } };
    return { styles, draws: () => draws, raf, caf, tick, pending: () => frames.size, restore: () => restore.forEach((r) => r.mockRestore()) };
}

describe('effects animate continuously while focused, pause when idle, are still under reduced motion', () => {
    const card = (effect = 'bubbles', tint?: string, loop = true) => act(() => root.render(h('div', { id: 'card' }, h(ProfileEffect, { effect, tint, loop }))));

    it('draws into one inert canvas and keeps requesting frames - it never settles', () => {
        const fc = fakeCanvas();
        try {
            card();
            const fx = host.querySelector('.pc-fx') as HTMLElement;
            expect(fx.getAttribute('aria-hidden')).toBe('true');
            expect(fx.querySelectorAll('canvas').length).toBe(1);
            expect([fx.dataset.phase, fx.dataset.loop]).toEqual(['play', 'true']);
            fc.tick(60 * 12); // twelve seconds
            expect(fc.pending()).toBe(1);
            expect(fc.draws()).toBeGreaterThan(500);
        } finally { fc.restore(); }
    });
    it('only the WINDOW pauses it (data-cl-window=inactive), never input idleness; focus resumes it', async () => {
        const fc = fakeCanvas();
        try {
            card();
            expect(fc.pending()).toBe(1);
            document.documentElement.setAttribute('data-cl-motion', 'idle');
            await act(async () => { await Promise.resolve(); });
            expect(fc.pending()).toBe(1); // input-idle: still playing
            document.documentElement.setAttribute('data-cl-window', 'inactive');
            await act(async () => { await Promise.resolve(); });
            expect(fc.pending()).toBe(0);
            const before = fc.draws();
            fc.tick(30);
            expect(fc.draws()).toBe(before);
            document.documentElement.setAttribute('data-cl-window', 'active');
            await act(async () => { await Promise.resolve(); });
            expect(fc.pending()).toBe(1);
        } finally { document.documentElement.removeAttribute('data-cl-motion'); document.documentElement.removeAttribute('data-cl-window'); fc.restore(); }
    });
    it('without `loop` (a picker thumbnail at rest): plays for EFFECT_PLAY_MS, then rests as a still', () => {
        const fc = fakeCanvas();
        try {
            card('bubbles', undefined, false);
            const fx = () => host.querySelector('.pc-fx') as HTMLElement;
            expect([fx().dataset.phase, fx().dataset.loop]).toEqual(['play', undefined]);
            expect(fc.pending()).toBe(1);
            act(() => { vi.advanceTimersByTime(EFFECT_PLAY_MS + 10); });
            expect(fx().dataset.phase).toBe('rest');
            expect(fc.pending()).toBe(0);
            // Turning loop on (the tile is hovered) wakes it.
            card('bubbles', undefined, true);
            expect([fx().dataset.phase, fx().dataset.loop]).toEqual(['play', 'true']);
            expect(fc.pending()).toBe(1);
        } finally { fc.restore(); }
    });
    it('reduced motion: one still frame is drawn and no frame is ever requested', () => {
        const fc = fakeCanvas();
        (window as any).matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} });
        try {
            card('aurora');
            expect(fc.raf).not.toHaveBeenCalled();
            expect(fc.draws()).toBeGreaterThan(0);
        } finally { delete (window as any).matchMedia; fc.restore(); }
    });
    it('a program that throws fails closed: the card survives, the loop stops, nothing is drawn after', async () => {
        const fc = fakeCanvas();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { EFFECT_PROGRAMS } = await import('./cosmetics/effects/programs');
        const prog = EFFECT_PROGRAMS.bubbles;
        const orig = prog.frame;
        let calls = 0;
        prog.frame = (...a: Parameters<typeof orig>) => { if (++calls > 3) throw new Error('boom'); return orig(...a); };
        try {
            card('bubbles');
            fc.tick(10);
            expect(host.querySelector('#card')).not.toBeNull();
            expect(fc.pending()).toBe(0);
            expect(warn).toHaveBeenCalled();
        } finally { prog.frame = orig; warn.mockRestore(); fc.restore(); }
    });
    it('the theme tint colours the effect and the decoration (#ffc94d is hue 42)', () => {
        const fc = fakeCanvas();
        try {
            card('bubbles', '#ffc94d');
            expect(fc.styles.some((s) => s.startsWith('hsl(41.8 '))).toBe(true);
        } finally { fc.restore(); }
        act(() => root.render(h(AvatarDecoration, { decoration: 'lume-ring', tint: '#ffc94d' }, 'x')));
        expect(host.innerHTML).toMatch(/hsl\(41\.8 /);
    });
    it('legacy colour variants keep their own hue and ignore the theme tint', () => {
        act(() => root.render(h(AvatarDecoration, { decoration: 'lume-ring-ember', tint: '#ffc94d' }, 'x')));
        expect(host.innerHTML).toMatch(/hsl\(22\.0/);
        expect(host.innerHTML).not.toMatch(/hsl\(41\.8 /);
    });
});

describe('About blocks: at most four open, the rest under "Show more"', () => {
    const blocks = (n: number) => Array.from({ length: n }, (_, i) => h('section', { key: i, 'data-b': i }, `block ${i}`));
    const text = () => host.textContent ?? '';

    it('shows everything when there are four or fewer, with no button', () => {
        act(() => root.render(h(ProfileCardBlocks, { blocks: blocks(ABOUT_BLOCKS_EXPANDED_MAX) })));
        expect(host.querySelectorAll('[data-b]').length).toBe(ABOUT_BLOCKS_EXPANDED_MAX);
        expect(host.querySelector('[data-testid="profile-blocks-more"]')).toBeNull();
    });
    it('folds the fifth and sixth under a button that says how many', () => {
        act(() => root.render(h(ProfileCardBlocks, { blocks: blocks(6) })));
        expect(host.querySelectorAll('[data-b]').length).toBe(4);
        expect(text()).not.toContain('block 5');
        const btn = host.querySelector('[data-testid="profile-blocks-more"]') as HTMLButtonElement;
        expect(btn.textContent).toBe('Show 2 more');
        act(() => btn.click());
        expect(host.querySelectorAll('[data-b]').length).toBe(6);
        expect(host.querySelector('[data-testid="profile-blocks-more"]')).toBeNull();
    });
    it('ignores empty blocks and renders nothing for none', () => {
        act(() => root.render(h(ProfileCardBlocks, { blocks: [null, false, undefined] as any })));
        expect(host.innerHTML).toBe('');
    });
});

describe('CSS guardrails', () => {
    const cosmetics = read('../styles/profile-cosmetics.css');
    it('the effect layer adds light (screen) under the avatar and never takes the pointer', () => {
        expect(cosmetics).toMatch(/\.pc-fx\s*\{[^}]*z-index:\s*1;[^}]*pointer-events:\s*none/);
        expect(cosmetics).toMatch(/\.pc-fx > canvas\s*\{[^}]*mix-blend-mode:\s*screen/);
    });
});
