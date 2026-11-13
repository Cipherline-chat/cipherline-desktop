// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AnimatePresence } from 'framer-motion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { PresenceRoster, PresenceMotion, PresenceEnter } from './presenceMotion';
import { createPresenceTracker, PRESENCE_LEAVE_MS } from '../../utils/callPresenceLifecycle';

/**
 * The join / leave components against a real React tree: the ghost row is
 * really rendered (and really removed), a rejoin keeps the SAME DOM node, a
 * remount never replays a join, and reduced motion renders no ghosts / joins.
 * Frame-level motion is proven in harness/call-anims (real Chromium).
 */
let root: Root | null = null;
let host: HTMLDivElement;
let reduce = false;

beforeEach(() => {
    reduce = false;
    window.matchMedia = ((q: string) => ({
        matches: q.includes('reduce') ? reduce : false,
        media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    vi.useRealTimers();
    document.body.innerHTML = '';
});

const roster = (ids: string[]) => React.createElement(PresenceRoster, {
    ids,
    renderRow: (id: string) => React.createElement('span', { 'data-who': id }, id),
});
const render = (el: React.ReactElement) => act(() => { root!.render(el); });
const row = (id: string) => host.querySelector(`[data-who="${id}"]`)?.parentElement as HTMLElement | undefined;

describe('PresenceRoster (server sidebar rows)', () => {
    it('the first roster is the baseline: no row animates in', () => {
        render(roster(['a', 'b']));
        expect(row('a')?.getAttribute('data-presence-join')).toBeNull();
        expect(row('b')?.getAttribute('data-presence')).toBe('present');
    });

    it('a mid-call join animates in; the rows already there do not', () => {
        render(roster(['a']));
        act(() => { vi.advanceTimersByTime(1000); });
        render(roster(['a', 'b']));
        expect(row('b')?.getAttribute('data-presence-join')).toBe('true');
        expect(row('b')?.getAttribute('data-presence')).toBe('entering');
        expect(row('a')?.getAttribute('data-presence-join')).toBeNull();
    });

    it('a leaver stays rendered as a non-interactive ghost, then is removed after PRESENCE_LEAVE_MS', () => {
        render(roster(['a', 'b', 'c']));
        render(roster(['a', 'c']));
        const ghost = row('b')!;
        expect(ghost.getAttribute('data-presence')).toBe('leaving');
        expect(ghost.getAttribute('aria-hidden')).toBe('true');
        expect(ghost.style.pointerEvents).toBe('none');
        // kept in place (between a and c), not appended
        expect([...host.querySelectorAll('[data-who]')].map(e => e.getAttribute('data-who'))).toEqual(['a', 'b', 'c']);
        act(() => { vi.advanceTimersByTime(PRESENCE_LEAVE_MS + 20); });
        expect(row('b')).toBeUndefined();
    });

    it('the LAST person leaving is a ghost too (the row collapses, it does not vanish)', () => {
        render(roster(['a']));
        render(roster([]));
        expect(row('a')?.getAttribute('data-presence')).toBe('leaving');
        act(() => { vi.advanceTimersByTime(PRESENCE_LEAVE_MS + 20); });
        expect(row('a')).toBeUndefined();
    });

    it('rejoining during the leave animation cancels the ghost and keeps the SAME node (it animates back)', () => {
        render(roster(['a', 'b']));
        render(roster(['a']));
        const ghost = row('b')!;
        act(() => { vi.advanceTimersByTime(100); });
        render(roster(['a', 'b']));
        expect(row('b')).toBe(ghost);
        expect(ghost.getAttribute('data-presence')).toBe('entering');
        act(() => { vi.advanceTimersByTime(PRESENCE_LEAVE_MS + 50); });
        expect(row('b')).toBe(ghost);
    });

    it('reduced motion: no ghost, no join animation', () => {
        reduce = true;
        render(roster(['a', 'b']));
        render(roster(['a', 'b', 'c']));
        expect(row('c')?.getAttribute('data-presence-join')).toBeNull();
        render(roster(['a', 'c']));
        expect(row('b')).toBeUndefined();
    });
});

describe('PresenceMotion / PresenceEnter (in-call tiles) — join is per lifecycle, not per mount', () => {
    const tile = (tracker: ReturnType<typeof createPresenceTracker>, ids: string[], surface = 'audio') =>
        React.createElement(AnimatePresence, null, ids.map(id =>
            React.createElement(PresenceMotion, {
                key: id, pid: id, surface, tracker,
                variants: { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } },
            }, React.createElement('span', { 'data-who': id }, id))));

    it('a joiner\'s tile plays the join once; a remount (layout switch / portal-root move) does not replay it', () => {
        const t = createPresenceTracker();
        t.observe(['me'], performance.now());
        act(() => { vi.advanceTimersByTime(1000); });
        t.observe(['me', 'x'], performance.now());
        render(tile(t, ['me', 'x']));
        expect(row('x')?.getAttribute('data-presence-join')).toBe('true');
        expect(row('me')?.getAttribute('data-presence-join')).toBeNull();
        // Layout switch: the whole surface unmounts and mounts again 200 ms later.
        render(React.createElement('div'));
        act(() => { vi.advanceTimersByTime(200); });
        render(tile(t, ['me', 'x']));
        expect(row('x')?.getAttribute('data-presence-join')).toBeNull();
    });

    it('fullscreen (PresenceEnter) opening after the join plays nothing; a join while it is open does', () => {
        const t = createPresenceTracker();
        t.observe(['me', 'x'], performance.now());
        act(() => { vi.advanceTimersByTime(2000); });
        const fs = (ids: string[]) => React.createElement('div', null, ids.map(id =>
            React.createElement(PresenceEnter, { key: id, pid: id, surface: 'fs', tracker: t },
                React.createElement('span', { 'data-who': id }, id))));
        render(fs(['me', 'x']));
        expect(host.querySelectorAll('[data-presence-join]').length).toBe(0);
        t.observe(['me', 'x', 'y'], performance.now());
        render(fs(['me', 'x', 'y']));
        expect(row('y')?.getAttribute('data-presence-join')).toBe('true');
    });

    it('reduced motion: never a join', () => {
        reduce = true;
        const t = createPresenceTracker();
        t.observe(['me'], performance.now());
        act(() => { vi.advanceTimersByTime(1000); });
        t.observe(['me', 'x'], performance.now());
        render(tile(t, ['me', 'x']));
        expect(row('x')?.getAttribute('data-presence-join')).toBeNull();
    });
});
