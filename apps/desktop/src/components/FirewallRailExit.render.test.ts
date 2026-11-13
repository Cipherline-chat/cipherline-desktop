// @vitest-environment jsdom
/**
 * Playing Firewall and clicking the server rail: the click closes the game AND
 * does the tile's normal action, on that same click. One capture-phase handler
 * on the rail <nav> (hooks/useFirewallGame.ts railExitProps), not an edit to
 * every tile.
 *
 * Real pieces: useFirewallGame, FirewallOverlay (with a fake worker), RailTile,
 * RailKeys, and the button shapes of the server / folder tiles. Not mounted:
 * Dashboard's 14k lines; a source check below proves its <nav> spreads
 * `firewall.railProps`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
    };
    return { default: api, secureLocalStore: api };
});

import { FirewallOverlay } from './FirewallOverlay';
import { RailTile } from './rail/RailTile';
import { RailKeys } from './rail/RailKeys';
import { useFirewallGame } from '../hooks/useFirewallGame';
import { __resetLoadingWorkerHost, __setLoadingWorkerFactory, type WorkerLike } from './loadingWorkerHost';
import { __resetEscapeStackForTests } from '../utils/escapeStack';
import { __resetKeyClaims } from '../utils/keyClaims';
import { applyMotionState } from '../utils/idleMotion';
import { firewallBestKey } from '../utils/firewallBest';
import { __resetFlappyBest } from '../utils/flappyBest';
import type { FromWorker, ToWorker } from '../workers/loadingScreenProtocol';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

class FakeWorker implements WorkerLike {
    sent: ToWorker[] = [];
    terminated = false;
    onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
    onerror: ((e: ErrorEvent) => void) | null = null;
    postMessage(m: ToWorker) { this.sent.push(m); }
    terminate() { this.terminated = true; }
    types() { return this.sent.map(m => m.type); }
    emit(m: FromWorker) { act(() => { this.onmessage?.({ data: m } as MessageEvent<FromWorker>); }); }
}

const UID = 'acct-1';
let root: Root | null = null;
let host: HTMLDivElement;
let workers: FakeWorker[] = [];
let actions: string[] = [];
let ctl: { open: () => void };
const proto = HTMLCanvasElement.prototype as unknown as { transferControlToOffscreen?: () => unknown };

/** Dashboard's shape: one hook, a <nav> with the rail's control kinds, the overlay next to it. */
const Shell: React.FC = () => {
    const fw = useFirewallGame(false);
    React.useEffect(() => { ctl = { open: fw.openGame }; });
    return h(React.Fragment, null,
        h('nav', { id: 'rail', ...fw.railProps },
            h(RailKeys, { onClick: () => actions.push('home'), onGameSpam: () => { actions.push('spam-open'); fw.openGame(); } }),
            h(RailTile, { title: 'Direct messages', onClick: () => actions.push('dms'), onContextMenu: (e) => { e.preventDefault(); actions.push('dms-menu'); } }),
            h(RailTile, { title: 'Group chats', onClick: () => actions.push('groups') }),
            // a server tile: the sortable wrapper div around a real button, icon inside
            h('div', { 'data-rail-id': 'srv:1' }, h('button', { type: 'button', 'data-testid': 'server', onClick: () => actions.push('server') }, h('img', { alt: 'icon' }))),
            h('button', { type: 'button', 'aria-haspopup': 'dialog', 'data-folder-id': 'f1', onClick: () => actions.push('folder') }, h('span', null, 'box')),
            h(RailTile, { title: 'Create or Join Server', accent: true, onClick: () => actions.push('add') }),
            h('button', { type: 'button', disabled: true, 'data-testid': 'inert', onClick: () => actions.push('inert') }),
            h(RailTile, { title: 'Friends', onClick: () => actions.push('friends') }),
            h(RailTile, { title: 'Settings', onClick: () => actions.push('settings') }),
            h('button', { type: 'button', 'data-testid': 'avatar', onClick: () => actions.push('avatar') }, 'me'),
            h('div', { id: 'rail-gap', 'data-testid': 'rail-gap' }),
        ),
        h('button', { id: 'content-btn', onClick: () => actions.push('content') }, 'content'),
        fw.open && h(FirewallOverlay, { key: UID, userId: UID, placement: 'shell', onClose: fw.closeGame }),
    );
};

const overlay = () => host.querySelector('.fw-root');
const w = () => workers[workers.length - 1];
const byTitle = (t: string) => host.querySelector(`button[title="${t}"]`) as HTMLButtonElement;
const byId = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const logo = () => host.querySelector('button[data-ob-anchor="rail-logo"]') as HTMLElement;
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
const openGame = () => { act(() => { ctl.open(); }); w().emit({ type: 'ok' }); };
const key = (type: 'keydown' | 'keyup', target: EventTarget, k = ' ') => {
    const ev = new KeyboardEvent(type, { key: k, code: k === ' ' ? 'Space' : k, bubbles: true, cancelable: true });
    act(() => { target.dispatchEvent(ev); });
    return ev;
};

beforeEach(() => {
    store.clear();
    __resetLoadingWorkerHost(); __resetEscapeStackForTests(); __resetKeyClaims();
    workers = []; actions = [];
    proto.transferControlToOffscreen = function () { return { fake: 'offscreen' }; };
    __setLoadingWorkerFactory(() => { const x = new FakeWorker(); workers.push(x); return x; });
    window.requestAnimationFrame = vi.fn(() => 0);
    window.cancelAnimationFrame = vi.fn();
    (Element.prototype as unknown as { animate: unknown }).animate = function () { return { cancel() {}, onfinish: null, oncancel: null } as unknown as Animation; };
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    applyMotionState(true);
    host = document.createElement('div'); document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(h(Shell)); });
});
afterEach(() => {
    act(() => { root?.unmount(); }); root = null; host.remove();
    __resetLoadingWorkerHost(); __setLoadingWorkerFactory('default'); delete proto.transferControlToOffscreen;
    __resetEscapeStackForTests(); __resetKeyClaims(); __resetFlappyBest();
    vi.restoreAllMocks();
});

describe('Firewall: a click on the rail leaves the game and goes where it was pointed', () => {
    it.each([
        ['Direct messages', () => byTitle('Direct messages'), 'dms'],
        ['Group chats', () => byTitle('Group chats'), 'groups'],
        ['a server tile', () => byId('server'), 'server'],
        ['the icon inside a server tile', () => byId('server').querySelector('img')!, 'server'],
        ['a folder', () => host.querySelector('[data-folder-id]')!, 'folder'],
        ['add server', () => byTitle('Create or Join Server'), 'add'],
        ['Friends', () => byTitle('Friends'), 'friends'],
        ['Settings', () => byTitle('Settings'), 'settings'],
        ['the avatar', () => byId('avatar'), 'avatar'],
        ['the Keys logo (Home)', () => logo(), 'home'],
    ])('%s: ONE click closes the game and runs the tile\'s action', (_n, target, action) => {
        openGame();
        expect(overlay()).not.toBeNull();
        click(target());
        expect(overlay()).toBeNull();      // closed on that click
        expect(actions).toEqual([action]); // and the tile's own action ran, once
        expect(w().terminated).toBe(true);
    });

    it('closing is the ordinary close: the run\'s score is kept and the worker released, as on Esc', () => {
        openGame();
        w().emit({ type: 'game', mode: 'playing', score: 7, best: 7, runMs: 21_000 });
        click(byTitle('Settings'));
        expect(overlay()).toBeNull();
        expect(store.get(firewallBestKey(UID))).toBe('7');
        expect(w().types()).toContain('detach');
    });
});

describe('Firewall: only a real click on a rail control counts', () => {
    it('pointer play inside the game does not close it', () => {
        openGame();
        const stage = host.querySelector('.fw-stage') as HTMLElement;
        act(() => { stage.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })); });
        click(stage);
        click(host.querySelector('.fw-hud')!);
        expect(overlay()).not.toBeNull();
        expect(w().sent.filter(m => m.type === 'act').length).toBeGreaterThan(0);
    });

    it('a click on the rail\'s empty space, or on a disabled tile, neither closes it nor acts', () => {
        openGame();
        click(byId('rail-gap'));
        click(host.querySelector('#rail')!);
        click(byId('inert'));
        expect(overlay()).not.toBeNull();
        expect(actions).toEqual([]);
    });

    it('a click outside the rail does not close it', () => {
        openGame();
        click(host.querySelector('#content-btn')!);
        expect(overlay()).not.toBeNull();
        expect(actions).toEqual(['content']);
    });

    it('right-click on a tile opens ITS menu and leaves the game running', () => {
        openGame();
        const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        act(() => { byTitle('Direct messages').dispatchEvent(ev); });
        expect(actions).toEqual(['dms-menu']);
        expect(overlay()).not.toBeNull();
    });

    it('right-click spam on Keys still opens the game', () => {
        let t = 1000;
        for (let i = 0; i < 6; i++) {
            const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'timeStamp', { value: t });
            act(() => { logo().dispatchEvent(ev); });
            t += 100;
        }
        expect(actions).toEqual(['spam-open']);
        expect(overlay()).not.toBeNull();
    });

    it('Space with focus on a rail tile swims instead of pressing the tile', () => {
        openGame();
        const tile = byTitle('Friends');
        tile.focus();
        const down = key('keydown', tile);
        const up = key('keyup', tile);
        expect(down.defaultPrevented).toBe(true); // a prevented keyup is what stops the native button click
        expect(up.defaultPrevented).toBe(true);
        expect(w().sent.filter(m => m.type === 'act')).toHaveLength(1);
        expect(overlay()).not.toBeNull();
        expect(actions).toEqual([]);
    });

    it('Space with focus on content outside the rail is left alone', () => {
        openGame();
        const btn = host.querySelector('#content-btn') as HTMLElement;
        btn.focus();
        expect(key('keydown', btn).defaultPrevented).toBe(false);
    });

    it('Esc still closes it', () => {
        openGame();
        act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        expect(overlay()).toBeNull();
        expect(actions).toEqual([]);
    });

    it('Tab order is unchanged: nothing gets a tabindex, and rail tiles stay tabbable', () => {
        const before = [...host.querySelectorAll('#rail [tabindex]')].map(e => e.getAttribute('tabindex'));
        openGame();
        const after = [...host.querySelectorAll('#rail [tabindex]')].map(e => e.getAttribute('tabindex'));
        expect(after).toEqual(before);
        expect(byTitle('Friends').tabIndex).toBe(0);
    });
});

describe('Firewall: Dashboard wiring', () => {
    it('the app-rail <nav> spreads firewall.railProps (the mechanism has nothing to act on otherwise)', () => {
        const src = readFileSync(resolve(__dirname, 'Dashboard.tsx'), 'utf8');
        const nav = /<nav\b[^>]*className="shrink-0 app-rail"[\s\S]*?>/.exec(src);
        expect(nav).not.toBeNull();
        expect(nav![0]).toContain('{...firewall.railProps}');
    });
});
