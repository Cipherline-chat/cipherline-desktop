// @vitest-environment jsdom
/**
 * MomentClock: offers the clock moments at start and every minute; only the
 * clock and your own account's creation date go in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let created: string | null = '2025-10-20T09:00:00';
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { user_id: 'me', created_at: created } }) }));
const { MomentClock } = await import('./MomentClock');
const { MOMENT_EVENT, COFFEE_AFTER_MS } = await import('../../utils/moments');
const { setHasActiveCall } = await import('../../utils/activeCallRegistry');

let root: Root;
const asked: string[] = [];
const onMoment = (e: Event) => asked.push((e as CustomEvent<{ id: string }>).detail.id);

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    asked.length = 0;
    window.addEventListener(MOMENT_EVENT, onMoment);
    root = createRoot(document.createElement('div'));
});
afterEach(() => { window.removeEventListener(MOMENT_EVENT, onMoment); act(() => root.unmount()); vi.useRealTimers(); setHasActiveCall(false); });

describe('MomentClock', () => {
    it('on your account anniversary: asks at once', () => {
        vi.setSystemTime(new Date('2026-10-20T12:00:00'));
        act(() => root.render(React.createElement(MomentClock, { openSince: Date.now() })));
        expect(asked).toEqual(['anniversary']);
    });
    it('an ordinary day: nothing until 12 hours open, then the coffee', () => {
        created = '2025-05-01T09:00:00';
        vi.setSystemTime(new Date('2026-10-20T08:00:00'));
        act(() => root.render(React.createElement(MomentClock, { openSince: Date.now() })));
        expect(asked).toEqual([]);
        act(() => { vi.advanceTimersByTime(COFFEE_AFTER_MS - 60_000); });
        expect(asked).toEqual([]);
        act(() => { vi.advanceTimersByTime(60_000); });
        expect(asked).toEqual(['coffee']);
    });
    it('New Year\'s Day: asks', () => {
        created = null;
        vi.setSystemTime(new Date('2027-01-01T00:30:00'));
        act(() => root.render(React.createElement(MomentClock, { openSince: Date.now() })));
        expect(asked).toEqual(['new-year']);
    });
    it('Pi Day around 1:59 p.m. and the leap day: asks', () => {
        created = null;
        vi.setSystemTime(new Date('2027-03-14T13:59:10'));
        act(() => root.render(React.createElement(MomentClock, { openSince: Date.now() })));
        expect(asked).toEqual(['pi-day']);
    });
    it('Feb 29: asks at once', () => {
        created = null;
        vi.setSystemTime(new Date('2028-02-29T08:00:00'));
        act(() => root.render(React.createElement(MomentClock, { openSince: Date.now() })));
        expect(asked).toEqual(['leap-day']);
    });
    describe('New Year\'s midnight in a call', () => {
        it('arms a timer for the second itself and asks for the fireworks at midnight — only if still in a call', () => {
            created = null;
            vi.setSystemTime(new Date('2026-12-31T23:59:30'));
            setHasActiveCall(true);
            act(() => root.render(React.createElement(MomentClock, { openSince: Date.now() })));
            expect(asked).toEqual([]);
            act(() => { vi.advanceTimersByTime(29_000); });
            expect(asked).toEqual([]);
            act(() => { vi.advanceTimersByTime(1_200); });
            expect(asked).toEqual(['nye-call']);
        });
        it('not in a call at midnight: nothing from the call path (the ordinary New Year moment takes over)', () => {
            created = null;
            vi.setSystemTime(new Date('2026-12-31T23:59:30'));
            setHasActiveCall(false);
            act(() => root.render(React.createElement(MomentClock, { openSince: Date.now() })));
            act(() => { vi.advanceTimersByTime(31_000); });
            expect(asked).not.toContain('nye-call');
        });
        it('a throttled timer is caught by the minute tick inside the first minute of the year', () => {
            created = null;
            vi.setSystemTime(new Date('2027-01-01T00:00:20'));
            setHasActiveCall(true);
            act(() => root.render(React.createElement(MomentClock, { openSince: Date.now() })));
            expect(asked).toContain('nye-call');
        });
        it('far from midnight: no timer is armed and nothing is asked', () => {
            created = null;
            vi.setSystemTime(new Date('2026-06-01T12:00:00'));
            setHasActiveCall(true);
            act(() => root.render(React.createElement(MomentClock, { openSince: Date.now() })));
            expect(vi.getTimerCount()).toBe(1);                 // just the minute interval
            expect(asked).toEqual([]);
        });
        it('unmounting clears the armed timer', () => {
            created = null;
            vi.setSystemTime(new Date('2026-12-31T23:59:30'));
            act(() => root.render(React.createElement(MomentClock, { openSince: Date.now() })));
            expect(vi.getTimerCount()).toBe(2);
            act(() => root.unmount());
            expect(vi.getTimerCount()).toBe(0);
            root = createRoot(document.createElement('div'));
        });
    });
});
