// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RailKeys } from './RailKeys';
import { RAIL_COOLDOWN_MS } from '../../utils/railKeysEgg';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Call { target: Element; frames: Keyframe[]; cancelled: boolean }
let calls: Call[] = [];
let now = 0;
let root: Root | null = null;
let host: HTMLDivElement;
let reduced = false;
let homes = 0;

beforeEach(() => {
    calls = []; now = 1000; homes = 0; reduced = false;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const animate = function (this: Element, frames: Keyframe[]) {
        const c: Call = { target: this, frames, cancelled: false };
        calls.push(c);
        const a = { cancel: () => { c.cancelled = true; }, onfinish: null as unknown, oncancel: null as unknown };
        return a as unknown as Animation;
    };
    (Element.prototype as unknown as { animate: unknown }).animate = animate;
    window.matchMedia = ((q: string) => ({ matches: reduced && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(React.createElement(RailKeys, { onClick: () => { homes++; } })); });
});
afterEach(() => { act(() => { root?.unmount(); }); host.remove(); vi.restoreAllMocks(); });

const btn = () => host.querySelector('button') as HTMLButtonElement;
const click = (gap = 100) => { act(() => { btn().click(); }); now += gap; };
const imgAnims = () => calls.filter(c => c.target.tagName === 'IMG');

describe('RailKeys', () => {
    it('is the Home button: every click navigates, spam or not', () => {
        for (let i = 0; i < 40; i++) click(60);
        expect(homes).toBe(40);
    });

    it('is a little bigger but keeps its 30x24 layout footprint (negative margin, not size)', () => {
        const img = host.querySelector('img')!;
        expect(img.style.width).toBe('38px');
        expect(img.style.height).toBe('30px');
        expect(img.style.margin).toBe('-3px -4px');
    });

    it('slow clicks animate nothing; a spam climbs the ladder and the finale adds sparkles, no text', () => {
        for (let i = 0; i < 10; i++) click(1500);
        expect(calls).toHaveLength(0);
        for (let i = 0; i < 24; i++) click(100);
        expect(imgAnims()).toHaveLength(6); // wiggle, hop, spin, squash, jelly, dizzy
        expect(host.querySelectorAll('svg')).toHaveLength(6); // the sparkles
        expect(host.textContent).toBe(''); // no words, ever
        expect(imgAnims().slice(0, -1).every(c => c.cancelled)).toBe(true); // one at a time
    });

    it('rests after the finale: more spam inside the cooldown animates nothing', () => {
        for (let i = 0; i < 24; i++) click(100);
        const n = calls.length;
        for (let i = 0; i < 30; i++) click(100);
        expect(calls).toHaveLength(n);
        now += RAIL_COOLDOWN_MS;
        for (let i = 0; i < 3; i++) click(100);
        expect(calls.length).toBe(n + 1); // a fresh streak's wiggle
    });

    it('reduced motion: only opacity pulses, never a transform, never sparkles', () => {
        reduced = true;
        for (let i = 0; i < 24; i++) click(100);
        expect(imgAnims().length).toBe(6);
        const props = new Set(imgAnims().flatMap(c => c.frames.flatMap(f => Object.keys(f))));
        expect(props.has('transform')).toBe(false);
        expect(props.has('opacity')).toBe(true);
        expect(host.querySelectorAll('svg')).toHaveLength(0);
    });

    it('never sets a drag region or swallows the event', () => {
        const b = btn();
        expect(b.className).toContain('no-drag');
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
        act(() => { b.dispatchEvent(ev); });
        expect(ev.defaultPrevented).toBe(false);
    });
});
