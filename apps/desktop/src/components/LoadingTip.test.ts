// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LoadingTip } from './LoadingTip';
import { TIP_MS, LOADING_TIPS } from '../utils/loadingTips';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
    vi.useRealTimers();
});

const line = () => host.querySelector('.lo-tip-line')!.textContent ?? '';
const render = (props: { t0?: number; running?: boolean; reduced?: boolean }) =>
    act(() => { root.render(React.createElement(LoadingTip, { t0: props.t0 ?? performance.now(), running: props.running ?? true, reduced: props.reduced ?? false })); });

describe('LoadingTip', () => {
    it('shows one of the lines, aria-hidden, and changes it every ~3 s', () => {
        const t0 = performance.now();
        render({ t0 });
        const first = line();
        expect(LOADING_TIPS).toContain(first);
        expect(host.querySelector('.lo-tip')!.getAttribute('aria-hidden')).toBe('true');
        act(() => { vi.advanceTimersByTime(TIP_MS + 60); });
        const second = line();
        expect(LOADING_TIPS).toContain(second);
        expect(second).not.toBe(first);
        act(() => { vi.advanceTimersByTime(TIP_MS); });
        expect(line()).not.toBe(second);
    });

    it('continues the same line across a remount with the same wait clock', () => {
        const t0 = performance.now();
        render({ t0 });
        act(() => { vi.advanceTimersByTime(TIP_MS + 100); });
        const before = line();
        act(() => { root.unmount(); });
        root = createRoot(host);
        render({ t0 });
        expect(line()).toBe(before);
    });

    it('reduced motion: one static line, no timers at all', () => {
        render({ reduced: true });
        const first = line();
        expect(vi.getTimerCount()).toBe(0);
        act(() => { vi.advanceTimersByTime(TIP_MS * 5); });
        expect(line()).toBe(first);
    });

    it('holds no timer once the app is loaded', () => {
        const t0 = performance.now();
        render({ t0 });
        render({ t0, running: false });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('unmounting clears its timer', () => {
        render({});
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        act(() => { root.unmount(); });
        expect(vi.getTimerCount()).toBe(0);
        root = createRoot(host);
    });
});
