// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const gate = vi.hoisted(() => ({ canDraw: true }));
vi.mock('../loadingWorkerHost', () => ({ canUseWorker: () => gate.canDraw }));
// The real overlay needs a worker + WebGL; only its mounting matters here.
vi.mock('../FirewallOverlay', () => ({
    FirewallOverlay: (p: { userId: string; placement?: string; onClose: () => void }) =>
        React.createElement('div', { 'data-testid': 'fw', 'data-user': p.userId, 'data-placement': p.placement ?? 'pane', onClick: p.onClose }),
}));

import { RailKeys } from './RailKeys';
import { FirewallOverlay } from '../FirewallOverlay';
import { useFirewallGame } from '../../hooks/useFirewallGame';
import { railGameRefusal, RAIL_GAME_REFUSAL } from '../../utils/railKeysGame';
import { BURST_LINES } from '../mascot/HomeKeys';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let now = 0;
let root: Root | null = null;
let host: HTMLDivElement;
let homes = 0;
let toasts: string[] = [];
let ctl: { setCall: (v: boolean) => void; setView: (v: string) => void };

/** The shape of Dashboard's wiring, minus the 14k lines: one hook, one overlay, the rail Keys + a Home-path opener. */
const Shell: React.FC = () => {
    const [inCall, setCall] = React.useState(false);
    const [view, setView] = React.useState('servers');
    React.useEffect(() => { ctl = { setCall, setView }; });
    const fw = useFirewallGame(inCall);
    const { tryOpen } = fw;
    const onSpam = React.useCallback(() => {
        const msg = railGameRefusal(tryOpen());
        if (msg) toasts.push(msg);
    }, [tryOpen]);
    return React.createElement(React.Fragment, null,
        React.createElement(RailKeys, { onClick: () => { homes++; setView('home'); }, onGameSpam: onSpam }),
        React.createElement('div', { 'data-view': view }),
        // HomePanel's path: HomeKeys asks canPlay() then calls onPlay (= openGame).
        React.createElement('button', {
            id: 'home-path',
            onClick: () => { if (fw.canPlay() === 'ok') fw.openGame(); },
        }),
        fw.open && React.createElement(FirewallOverlay, { key: 'u1', userId: 'u1', placement: 'shell', onClose: fw.closeGame }),
    );
};

beforeEach(() => {
    now = 1000; homes = 0; toasts = []; gate.canDraw = true;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    (Element.prototype as unknown as { animate: unknown }).animate = function () {
        return { cancel() {}, onfinish: null, oncancel: null } as unknown as Animation;
    };
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(React.createElement(Shell)); });
});
afterEach(() => { act(() => { root?.unmount(); }); host.remove(); vi.restoreAllMocks(); });

const rail = () => host.querySelector('button[data-ob-anchor="rail-logo"]') as HTMLButtonElement;
const overlays = () => host.querySelectorAll('[data-testid="fw"]');
/** One right-click; the event's own timestamp is the test clock (inputTime reads it). */
const rightClick = (gap = 100): MouseEvent => {
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'timeStamp', { value: now });
    act(() => { rail().dispatchEvent(ev); });
    now += gap;
    return ev;
};
const spam = (n: number, gap = 100) => { for (let i = 0; i < n; i++) rightClick(gap); };

describe('RailKeys: right-click', () => {
    it('preventDefault on every contextmenu (no OS / Electron menu), and one right-click does nothing visible', () => {
        const ev = rightClick();
        expect(ev.defaultPrevented).toBe(true);
        expect(homes).toBe(0); // not a left click: never navigates
        expect(overlays()).toHaveLength(0);
        expect(toasts).toEqual([]);
        expect(host.textContent).toBe('');
    });

    it('every contextmenu in a spam is prevented, including the 6th that fires', () => {
        const evs = Array.from({ length: 6 }, () => rightClick());
        expect(evs.every(e => e.defaultPrevented)).toBe(true);
    });

    it('left click is unchanged: goes Home, does not count toward the game', () => {
        for (let i = 0; i < 12; i++) { act(() => { rail().click(); }); now += 100; }
        expect(homes).toBe(12);
        expect(overlays()).toHaveLength(0);
    });

    it('a left click neither counts toward the right-click streak nor resets it (the streak is time-based)', () => {
        spam(3);
        act(() => { rail().click(); });
        spam(2); // 5 right-clicks around a left click: not yet
        expect(overlays()).toHaveLength(0);
        rightClick(); // the 6th right-click
        expect(overlays()).toHaveLength(1);
    });
});

describe('RailKeys: the game from the rail', () => {
    it('opens from a non-Home view on the 6th right-click, not the 5th, as ONE shell-placed instance', () => {
        expect(host.querySelector('[data-view]')!.getAttribute('data-view')).toBe('servers');
        spam(5);
        expect(overlays()).toHaveLength(0);
        rightClick();
        expect(overlays()).toHaveLength(1);
        expect(overlays()[0].getAttribute('data-placement')).toBe('shell');
        expect(overlays()[0].getAttribute('data-user')).toBe('u1');
        expect(host.querySelector('[data-view]')!.getAttribute('data-view')).toBe('servers'); // did not navigate
        expect(homes).toBe(0);
        expect(toasts).toEqual([]);
    });

    it('a gap of 601 ms restarts the count; 600 ms does not', () => {
        spam(3);
        now += 501; // last gap = 100 + 501 = 601
        spam(3);
        expect(overlays()).toHaveLength(0);
        host.remove(); // fresh rig for the 600 case
        act(() => { root?.unmount(); });
        host = document.createElement('div'); document.body.appendChild(host);
        root = createRoot(host); act(() => { root!.render(React.createElement(Shell)); });
        spam(3);
        now += 500; // last gap = 600
        spam(3);
        expect(overlays()).toHaveLength(1);
    });

    it('keeps spamming after it opened: still one instance', () => {
        spam(6);
        spam(12);
        expect(overlays()).toHaveLength(1);
    });

    it('closing it (onClose) removes it, and it can be summoned again', () => {
        spam(6);
        act(() => { (overlays()[0] as HTMLElement).click(); });
        expect(overlays()).toHaveLength(0);
        now += 5000;
        spam(6);
        expect(overlays()).toHaveLength(1);
    });

    it('Home\'s path and the rail share ONE instance: opening via Home, then spamming the rail, does not mount a second', () => {
        act(() => { (host.querySelector('#home-path') as HTMLElement).click(); });
        expect(overlays()).toHaveLength(1);
        spam(6);
        expect(overlays()).toHaveLength(1);
        act(() => { (overlays()[0] as HTMLElement).click(); });
        spam(6, 100);
        expect(overlays()).toHaveLength(1); // and the rail can open it after Home closed it
    });

    it('refuses during a call: no game, a quiet line', () => {
        act(() => { ctl.setCall(true); });
        spam(6);
        expect(overlays()).toHaveLength(0);
        expect(toasts).toEqual([RAIL_GAME_REFUSAL.call]);
    });

    it('Home\'s path also refuses during a call (same gate)', () => {
        act(() => { ctl.setCall(true); });
        act(() => { (host.querySelector('#home-path') as HTMLElement).click(); });
        expect(overlays()).toHaveLength(0);
    });

    it('a call starting while it is open closes it', () => {
        spam(6);
        expect(overlays()).toHaveLength(1);
        act(() => { ctl.setCall(true); });
        expect(overlays()).toHaveLength(0);
    });

    it('a machine that cannot draw it: Keys\' own "can\'t draw" line, no game', () => {
        gate.canDraw = false;
        spam(6);
        expect(overlays()).toHaveLength(0);
        expect(toasts).toEqual([BURST_LINES.unavailable]);
    });
});
