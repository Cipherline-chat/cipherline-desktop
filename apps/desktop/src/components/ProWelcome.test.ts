// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const playSound = vi.fn();
vi.mock('../utils/notificationSounds', () => ({ playSound: (...a: unknown[]) => playSound(...a) }));
vi.mock('../contexts/NotificationContext', () => ({ useNotificationPrefsSafe: () => undefined }));

import { ProWelcome, PRO_WELCOME_INTRO_MS, PRO_WELCOME_EXIT_MS, PRO_WELCOME_EXIT_REDUCED_MS } from './ProWelcome';

let root: Root | null = null;
let reduced = false;
const onClose = vi.fn();

const mount = (name: string | null = 'Dawson') => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(React.createElement(ProWelcome, { onClose, name })); });
};
const dialog = () => document.querySelector<HTMLElement>('.pcel');
const phase = () => dialog()?.dataset.phase;
const skip = () => document.querySelector<HTMLButtonElement>('.pcel-skip');
const cta = () => document.querySelector<HTMLButtonElement>('.pcel-cta')!;
const key = (k: string, target: EventTarget = document.activeElement ?? document.body) =>
    act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });

beforeEach(() => {
    vi.useFakeTimers();
    reduced = false;
    onClose.mockReset();
    playSound.mockReset();
    window.matchMedia = ((q: string) => ({ matches: reduced && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
});

describe('ProWelcome — the celebration layer', () => {
    it('is a labelled modal dialog of its own, portaled to <body>, with the user on the card and in the greeting', () => {
        mount();
        const d = dialog()!;
        expect(d.parentElement).toBe(document.body);
        expect(d.getAttribute('role')).toBe('dialog');
        expect(d.getAttribute('aria-modal')).toBe('true');
        expect(document.getElementById(d.getAttribute('aria-labelledby')!)!.textContent).toBe('Welcome to Pro, Dawson.');
        expect(document.querySelector('[data-testid="pcel-member"]')!.textContent).toBe('Dawson');
        expect(document.activeElement).toBe(d);
        expect(playSound).toHaveBeenCalledTimes(1);
        expect(playSound.mock.calls[0][0]).toBe('celebration');
    });

    it('lists only what Pro actually adds (video, screen share, the upload cap, storage)', () => {
        mount();
        const titles = Array.from(document.querySelectorAll('.pcel-perk-t')).map(e => e.textContent);
        expect(titles).toEqual(['HD video', 'Screen share', '2 GB uploads', 'More storage']);
        expect(document.querySelector('.pcel-perks')!.textContent).toContain('Up from 100 MB');
    });

    it('falls back to a nameless greeting for a pending (empty) username', () => {
        mount('  ');
        expect(document.getElementById('pcel-title')!.textContent).toBe('Welcome to Pro.');
        expect(document.querySelector('[data-testid="pcel-member"]')!.textContent).toBe('You');
    });

    it('plays the intro, then settles at rest on its own and hands focus to "Let’s go"', () => {
        mount();
        expect(phase()).toBe('intro');
        expect(skip()).not.toBeNull();
        expect(cta().tabIndex).toBe(-1); // invisible during the intro: not tabbable
        act(() => { vi.advanceTimersByTime(PRO_WELCOME_INTRO_MS - 1); });
        expect(phase()).toBe('intro');
        act(() => { vi.advanceTimersByTime(1); });
        expect(phase()).toBe('rest');
        expect(skip()).toBeNull();
        expect(cta().tabIndex).toBe(0);
        expect(document.activeElement).toBe(cta());
        expect(onClose).not.toHaveBeenCalled();
    });

    it('Esc closes at any moment, after the exit fade, exactly once', () => {
        mount();
        key('Escape', document.body); // even with focus outside the dialog
        expect(phase()).toBe('closing');
        key('Escape', document.body);
        act(() => { vi.advanceTimersByTime(PRO_WELCOME_EXIT_MS - 1); });
        expect(onClose).not.toHaveBeenCalled();
        act(() => { vi.advanceTimersByTime(1); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('Skip closes mid-intro', () => {
        mount();
        act(() => { skip()!.click(); });
        act(() => { vi.advanceTimersByTime(PRO_WELCOME_EXIT_MS); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('a click during the intro fast-forwards instead of closing; a backdrop click at rest closes', () => {
        mount();
        act(() => { dialog()!.click(); });
        expect(phase()).toBe('rest');
        expect(document.activeElement).toBe(cta());
        // the card is for reading, not a dismiss target
        act(() => { (document.querySelector('.pcel-card') as HTMLElement).click(); });
        act(() => { vi.advanceTimersByTime(1000); });
        expect(onClose).not.toHaveBeenCalled();
        act(() => { (document.querySelector('.pcel-veil') as HTMLElement).click(); });
        act(() => { vi.advanceTimersByTime(PRO_WELCOME_EXIT_MS); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('Enter on the dialog fast-forwards during the intro; "Let’s go" closes', () => {
        mount();
        key('Enter', dialog()!);
        expect(phase()).toBe('rest');
        act(() => { cta().click(); });
        act(() => { vi.advanceTimersByTime(PRO_WELCOME_EXIT_MS); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('traps Tab inside the dialog', () => {
        mount();
        act(() => { vi.advanceTimersByTime(PRO_WELCOME_INTRO_MS); });
        key('Tab');
        expect(document.activeElement).toBe(cta());
        key('Tab');
        expect(document.activeElement).toBe(cta());
    });

    it('returns focus to where it was when it closes', () => {
        const before = document.createElement('button');
        document.body.appendChild(before);
        before.focus();
        mount();
        expect(document.activeElement).not.toBe(before);
        act(() => { root!.unmount(); });
        root = null;
        expect(document.activeElement).toBe(before);
    });

    it('reduced motion: the finished frame at once — no intro, no Skip, CTA focused, short exit', () => {
        reduced = true;
        mount();
        expect(phase()).toBe('rest');
        expect(dialog()!.hasAttribute('data-reduced')).toBe(true);
        expect(skip()).toBeNull();
        expect(cta().tabIndex).toBe(0);
        expect(document.activeElement).toBe(cta());
        act(() => { cta().click(); });
        act(() => { vi.advanceTimersByTime(PRO_WELCOME_EXIT_REDUCED_MS); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
