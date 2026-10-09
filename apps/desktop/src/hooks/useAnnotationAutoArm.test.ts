// @vitest-environment jsdom
/**
 * The React half of the annotation auto-arm: the per-tile hook (arms when the
 * tile is a drawing surface, announces, never touches focus) and the toolbar
 * (the colour picker follows `enabled`; Esc leaves drawing mode). Plain
 * React.createElement so this can stay a .test.ts, as the transport test does.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ toasts: [] as Array<{ message: string }> }));
vi.mock('../contexts/ToastContext', () => ({
    useToast: () => ({ push: (t: { message: string }) => { h.toasts.push(t); }, dismiss: () => {} }),
}));

import { useAnnotationAutoArm } from './useAnnotationAutoArm';
import { AnnotationToolbar } from '../components/call/AnnotationToolbar';
import { annotationStore as store, trackKey, PALETTE } from '../utils/annotationStore';
import { applyRemote } from '../utils/annotationTransport';
import { __resetEscapeStackForTests } from '../utils/escapeStack';

const ME = 'alice';
const BOB_SHARE = trackKey('bob', 'screen_share');

/** A stand-in for a VideoTile: the hook plus the live region the tile renders. */
const Tile: React.FC<{ surfaceActive: boolean; granted: boolean }> = ({ surfaceActive, granted }) => {
    const note = useAnnotationAutoArm({ trackKey: BOB_SHARE, ownerName: 'Bob', isScreenShare: true, surfaceActive, granted });
    return React.createElement('span', { role: 'status', 'aria-live': 'polite', 'data-testid': 'live' }, note);
};

let container: HTMLDivElement;
let root: Root;
const render = (el: React.ReactElement) => act(() => { root.render(el); });
const live = () => container.querySelector('[data-testid="live"]')!.textContent;

/** bob clicks Allow: what reaches us, in wire order. */
const approvedByBob = () => act(() => {
    applyRemote({ t: 'grant.grant', room: 'r', track: BOB_SHARE, identity: ME }, 'bob', ME);
    applyRemote({ t: 'grant.list', room: 'r', track: BOB_SHARE, identities: [ME] }, 'bob', ME);
});

beforeEach(() => {
    store.reset();
    h.toasts.length = 0;
    __resetEscapeStackForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    __resetEscapeStackForTests();
});

describe('useAnnotationAutoArm', () => {
    it('focused tile: approval arms drawing and announces it (toast + live region)', async () => {
        await render(React.createElement(Tile, { surfaceActive: true, granted: true }));
        store.requestAccess(BOB_SHARE);
        approvedByBob();
        expect(store.getState().enabled).toBe(true);
        expect(live()).toBe("Drawing on Bob's screen — Esc to stop");
        expect(h.toasts.map(t => t.message)).toEqual(["Drawing on Bob's screen — Esc to stop"]);
    });

    it('CONTROL: with the hook not mounted (old behaviour) the same approval leaves drawing off and silent', async () => {
        await render(React.createElement('span'));
        store.requestAccess(BOB_SHARE);
        approvedByBob();
        expect(store.getState().enabled).toBe(false);
        expect(h.toasts).toEqual([]);
    });

    it('sidebar-column tile (not a surface): nothing is armed, nothing is announced', async () => {
        await render(React.createElement(Tile, { surfaceActive: false, granted: true }));
        store.requestAccess(BOB_SHARE);
        approvedByBob();
        expect(store.getState().enabled).toBe(false);
        expect(live()).toBe('');
        expect(h.toasts).toEqual([]);
    });

    it('sidebar tile, then focused within the window: arms at that moment', async () => {
        await render(React.createElement(Tile, { surfaceActive: false, granted: true }));
        store.requestAccess(BOB_SHARE);
        approvedByBob();
        expect(store.getState().enabled).toBe(false);
        await render(React.createElement(Tile, { surfaceActive: true, granted: true }));
        expect(store.getState().enabled).toBe(true);
    });

    it('does not move focus out of a text input the user is typing in', async () => {
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();
        expect(document.activeElement).toBe(input);

        await render(React.createElement(Tile, { surfaceActive: true, granted: true }));
        store.requestAccess(BOB_SHARE);
        approvedByBob();

        expect(store.getState().enabled).toBe(true);        // still armed...
        expect(document.activeElement).toBe(input);         // ...focus untouched
        input.remove();
    });

    it('mounting on an already-approved state (no request, e.g. reconnect) does not arm', async () => {
        applyRemote({ t: 'grant.list', room: 'r', track: BOB_SHARE, identities: [ME] }, 'bob', ME);
        await render(React.createElement(Tile, { surfaceActive: true, granted: true }));
        expect(store.getState().enabled).toBe(false);
        expect(h.toasts).toEqual([]);
    });
});

describe('AnnotationToolbar after an auto-arm', () => {
    const swatches = () => container.querySelectorAll('button[aria-label^="Colour "]');
    const press = (key: string, target: EventTarget = window) =>
        act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });

    it('the colour picker is expanded (all swatches) and the stop control is pressed', async () => {
        await render(React.createElement(React.Fragment, null,
            React.createElement(Tile, { surfaceActive: true, granted: true }),
            React.createElement(AnnotationToolbar),
        ));
        expect(swatches()).toHaveLength(0); // collapsed: one pencil
        store.requestAccess(BOB_SHARE);
        approvedByBob();
        expect(swatches()).toHaveLength(PALETTE.length);
        expect(container.querySelector('button[aria-label="Stop drawing"]')?.getAttribute('aria-pressed')).toBe('true');
    });

    it('Escape leaves drawing mode; a second Escape is not swallowed', async () => {
        await render(React.createElement(React.Fragment, null,
            React.createElement(Tile, { surfaceActive: true, granted: true }),
            React.createElement(AnnotationToolbar),
        ));
        store.requestAccess(BOB_SHARE);
        approvedByBob();
        expect(store.getState().enabled).toBe(true);

        const first = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        act(() => { window.dispatchEvent(first); });
        expect(store.getState().enabled).toBe(false);
        expect(first.defaultPrevented).toBe(true);
        expect(swatches()).toHaveLength(0);

        const second = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        act(() => { window.dispatchEvent(second); });
        expect(second.defaultPrevented).toBe(false); // nothing left to back out of: falls through to fullscreen etc.
    });

    it('the existing exit control still works', async () => {
        await render(React.createElement(AnnotationToolbar));
        act(() => { store.setEnabled(true); });
        const stop = container.querySelector('button[aria-label="Stop drawing"]') as HTMLButtonElement;
        act(() => { stop.click(); });
        expect(store.getState().enabled).toBe(false);
    });

    it('CONTROL: with no toolbar mounted (old behaviour) Escape does not leave drawing mode', async () => {
        await render(React.createElement('span'));
        act(() => { store.setEnabled(true); });
        press('Escape');
        expect(store.getState().enabled).toBe(true);
    });
});
