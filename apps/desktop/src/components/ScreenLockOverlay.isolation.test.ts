// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * While the Screen Lock is up nothing behind it is reachable: not by Tab, not
 * by click, not by assistive tech, and hotkeys do not fire. Opaque is not the
 * same as unreachable: before this, Tab walked past the PIN field into the
 * composer and typing there worked.
 *
 * The REAL ScreenLockOverlay is mounted in the app's own shape:
 *   body > #root > .app-container > [drag strip, Dashboard root > (composer,
 *   buttons, overlay)]   +   body > portal root (a modal) / later a toast.
 * jsdom has no focus-fixup for `inert`, so "unreachable" is asserted as: every
 * focusable element outside the overlay has an `inert` ancestor (which is
 * exactly what makes a real browser skip it), plus the Tab wrap and focus
 * hand-off are exercised directly. The same flow is driven in real Chromium by
 * harness/lockscreen-boot-shots.mjs (--inert checks).
 */
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ logout: vi.fn() }) }));

// Before the import: the cl-kit physics module reads matchMedia at load.
window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

const { default: ScreenLockOverlay } = await import('./ScreenLockOverlay');

const lockStub = () => ({
    settings: { pinLength: 4, enabled: true, verifier: null, timeoutMinutes: 5, lockOnOsLock: true },
    isLocked: true, attempts: 0, lockedOutUntil: null,
    lockNow: vi.fn(), unlock: vi.fn(async () => true), setPin: vi.fn(), changePin: vi.fn(), disable: vi.fn(),
    forgotPinReset: vi.fn(), setTimeoutMinutes: vi.fn(), setLockOnOsLock: vi.fn(),
}) as unknown as Parameters<typeof ScreenLockOverlay>[0]['screenLock'];

let portalHost: HTMLDivElement;
let rootHost: HTMLDivElement;
let root: Root;

const Fixture: React.FC<{ locked: boolean }> = ({ locked }) => React.createElement(React.Fragment, null,
    React.createElement('div', { className: 'app-container' },
        React.createElement('div', { id: 'drag', 'data-lock-exempt': '' }),
        React.createElement('div', { id: 'dashboard' },
            React.createElement('textarea', { id: 'composer' }),
            React.createElement('button', { id: 'send' }, 'Send'),
            React.createElement('div', { id: 'pre-hidden', 'aria-hidden': 'true' }),
            locked ? React.createElement(ScreenLockOverlay, { screenLock: lockStub() }) : null),
        React.createElement('div', { id: 'curtain' }, React.createElement('button', { id: 'banner-btn' }, 'Update'))),
    createPortal(React.createElement('div', { id: 'modal' }, React.createElement('button', { id: 'modal-ok' }, 'OK')), portalHost));

const render = (locked: boolean) => act(() => { root.render(React.createElement(Fixture, { locked })); });
const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const overlay = () => document.querySelector('[data-screen-lock]') as HTMLElement | null;
const isInert = (el: Element | null): boolean => !!el?.closest('[inert]');

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const reachableOutsideOverlay = () => Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((el) => !overlay()?.contains(el) && !isInert(el));

beforeEach(() => {
    portalHost = document.createElement('div');
    portalHost.id = 'portal-root';
    document.body.appendChild(portalHost);
    rootHost = document.createElement('div');
    rootHost.id = 'root';
    document.body.appendChild(rootHost);
    root = createRoot(rootHost);
});
afterEach(() => {
    act(() => root.unmount());
    rootHost.remove();
    portalHost.remove();
    document.querySelectorAll('#late-toast').forEach((n) => n.remove());
});

describe('Screen Lock isolation', () => {
    it('negative control: with no lock nothing is inert or aria-hidden by us, and the app is reachable', () => {
        render(false);
        expect(document.querySelectorAll('[inert]')).toHaveLength(0);
        expect(reachableOutsideOverlay().map((e) => e.id)).toEqual(expect.arrayContaining(['composer', 'send', 'banner-btn', 'modal-ok']));
        expect($('#dashboard').hasAttribute('aria-hidden')).toBe(false);
    });

    it('locked: the Dashboard content, its siblings and the portal roots are inert + aria-hidden', () => {
        render(true);
        for (const sel of ['#composer', '#send', '#banner-btn', '#curtain', '#portal-root', '#modal', '#modal-ok']) {
            expect(isInert($(sel)), sel).toBe(true);
        }
        // The direct inert roots carry both attributes.
        for (const sel of ['#composer', '#send', '#curtain', '#portal-root']) {
            expect($(sel).hasAttribute('inert'), sel).toBe(true);
            expect($(sel).getAttribute('aria-hidden'), sel).toBe('true');
        }
    });

    it('locked: the overlay and its ancestor chain stay interactive', () => {
        render(true);
        const o = overlay()!;
        expect(o).not.toBeNull();
        expect(isInert(o)).toBe(false);
        for (let el: Element | null = o; el && el !== document.body; el = el.parentElement) {
            expect(el.hasAttribute('inert'), el.id || el.className || el.tagName).toBe(false);
            expect(el.getAttribute('aria-hidden')).not.toBe('true');
        }
        expect(o.querySelector('input')).not.toBeNull();
    });

    it('locked: nothing outside the overlay can take focus (nothing reachable by Tab)', () => {
        render(true);
        expect(reachableOutsideOverlay()).toEqual([]);
    });

    it('the drag strip is exempt (the frameless window stays draggable)', () => {
        render(true);
        expect($('#drag').hasAttribute('inert')).toBe(false);
    });

    it('focus moves into the PIN field on lock, and Tab / Shift+Tab wrap inside the overlay', () => {
        render(true);
        const o = overlay()!;
        expect(o.contains(document.activeElement)).toBe(true);
        expect((document.activeElement as HTMLElement).tagName).toBe('INPUT');

        const items = Array.from(o.querySelectorAll<HTMLElement>(FOCUSABLE));
        const first = items[0], last = items[items.length - 1];
        expect(items.length).toBeGreaterThan(1);
        const press = (shiftKey: boolean) => act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })); });

        last.focus();
        press(false);
        expect(document.activeElement).toBe(first);
        press(true);
        expect(document.activeElement).toBe(last);
        // Never leaves the overlay, however many times Tab is pressed.
        for (let i = 0; i < 12; i++) { press(false); expect(o.contains(document.activeElement)).toBe(true); }

        // Focus that somehow ended up on the app behind (jsdom has no inert
        // focus-fixup; a browser would have dropped it to <body>) comes straight
        // back into the overlay on the next Tab.
        $('#composer').focus();
        expect(o.contains(document.activeElement)).toBe(false);
        press(false);
        expect(o.contains(document.activeElement)).toBe(true);
    });

    it('something that appears while locked (a toast, a modal) is isolated too', async () => {
        render(true);
        const toast = document.createElement('div');
        toast.id = 'late-toast';
        toast.innerHTML = '<button id="late-btn">Reply</button>';
        document.body.appendChild(toast);
        await act(async () => { await Promise.resolve(); });
        expect(isInert($('#late-btn'))).toBe(true);
        expect(reachableOutsideOverlay()).toEqual([]);
        // ...and one that lands inside the Dashboard root, next to the overlay.
        const inner = document.createElement('div');
        inner.innerHTML = '<button id="inner-late">Menu</button>';
        $('#dashboard').appendChild(inner);
        await act(async () => { await Promise.resolve(); });
        expect(isInert($('#inner-late'))).toBe(true);
    });

    it('unlock restores everything: no inert/aria-hidden left behind, pre-existing aria-hidden kept, app reachable again', () => {
        render(true);
        expect(document.querySelectorAll('[inert]').length).toBeGreaterThan(0);
        render(false);
        expect(overlay()).toBeNull();
        expect(document.querySelectorAll('[inert]')).toHaveLength(0);
        expect($('#composer').hasAttribute('aria-hidden')).toBe(false);
        expect($('#portal-root').hasAttribute('aria-hidden')).toBe(false);
        expect($('#pre-hidden').getAttribute('aria-hidden')).toBe('true'); // was hidden before the lock, still is
        expect(reachableOutsideOverlay().map((e) => e.id)).toEqual(expect.arrayContaining(['composer', 'send', 'banner-btn', 'modal-ok']));
    });

    it('unlock returns focus to where it was; if that is gone, to the body', () => {
        render(false);
        $('#composer').focus();
        expect(document.activeElement).toBe($('#composer'));
        render(true);
        expect(overlay()!.contains(document.activeElement)).toBe(true);
        render(false);
        expect(document.activeElement).toBe($('#composer'));

        // The previously focused element is removed while locked → body, not a stale node.
        const doomed = document.createElement('button');
        $('#dashboard').appendChild(doomed);
        doomed.focus();
        render(true);
        doomed.remove();
        render(false);
        expect(document.activeElement).toBe(document.body);
    });

    it('a pre-existing inert element stays inert after unlock (only our own marks are removed)', () => {
        render(false);
        $('#curtain').setAttribute('inert', '');
        render(true);
        render(false);
        expect($('#curtain').hasAttribute('inert')).toBe(true);
    });
});
