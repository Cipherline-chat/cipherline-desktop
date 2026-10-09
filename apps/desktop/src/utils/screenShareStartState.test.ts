import { describe, it, expect, vi } from 'vitest';
import {
    shareStartReducer, ShareStartTracker, describeShareStartError, SHARE_START_IDLE,
    type ShareStartState,
} from './screenShareStartState';

const starting = (attempt: number): ShareStartState => ({ phase: 'starting', attempt });

describe('shareStartReducer', () => {
    it('idle → starting → live', () => {
        const s1 = shareStartReducer(SHARE_START_IDLE, { type: 'begin' });
        expect(s1).toEqual(starting(1));
        expect(shareStartReducer(s1, { type: 'settle', attempt: 1, outcome: 'published', stillLive: true }))
            .toEqual({ phase: 'live', attempt: 1 });
    });
    it('starting → idle on cancel and on failure (nothing was live)', () => {
        for (const outcome of ['cancelled', 'failed'] as const) {
            expect(shareStartReducer(starting(1), { type: 'settle', attempt: 1, outcome, stillLive: false }))
                .toEqual({ phase: 'idle', attempt: 1 });
        }
    });
    it('a failed change-source on a running share goes back to live, not idle', () => {
        expect(shareStartReducer(starting(2), { type: 'settle', attempt: 2, outcome: 'cancelled', stillLive: true }))
            .toEqual({ phase: 'live', attempt: 2 });
    });
    it('no re-entry: begin while starting changes nothing', () => {
        const s = starting(3);
        expect(shareStartReducer(s, { type: 'begin' })).toBe(s);
    });
    it('control: begin from idle and from live IS accepted', () => {
        expect(shareStartReducer(SHARE_START_IDLE, { type: 'begin' }).phase).toBe('starting');
        expect(shareStartReducer({ phase: 'live', attempt: 4 }, { type: 'begin' })).toEqual(starting(5));
    });
    it('a stale attempt cannot settle a newer one', () => {
        const s = starting(2);
        expect(shareStartReducer(s, { type: 'settle', attempt: 1, outcome: 'published', stillLive: true })).toBe(s);
    });
    it('a share stopping mid-start (the old track of a republish) keeps the indicator', () => {
        const s = starting(2);
        expect(shareStartReducer(s, { type: 'stopped' })).toBe(s);
        expect(shareStartReducer({ phase: 'live', attempt: 2 }, { type: 'stopped' })).toEqual({ phase: 'idle', attempt: 2 });
    });
    it('settling when not starting is a no-op', () => {
        expect(shareStartReducer(SHARE_START_IDLE, { type: 'settle', attempt: 0, outcome: 'published', stillLive: true })).toBe(SHARE_START_IDLE);
    });
});

describe('ShareStartTracker', () => {
    it('refuses a second start synchronously and reports each change once', () => {
        const seen: string[] = [];
        const t = new ShareStartTracker(s => seen.push(s.phase));
        const a = t.begin();
        expect(a).toBe(1);
        expect(t.begin()).toBeNull();          // double click in the same frame
        expect(t.starting).toBe(true);
        t.settle(a!, 'published', true);
        expect(t.starting).toBe(false);
        expect(seen).toEqual(['starting', 'live']);
    });
    it('cancel and error both release the button', () => {
        const t = new ShareStartTracker();
        const a = t.begin()!;
        t.settle(a, 'cancelled', false);
        expect(t.state.phase).toBe('idle');
        const b = t.begin()!;
        expect(b).toBe(2);
        t.settle(b, 'failed', false);
        expect(t.state.phase).toBe('idle');
        expect(t.begin()).toBe(3);             // usable again
    });
    it('control: without settling, the tracker stays busy', () => {
        const onChange = vi.fn();
        const t = new ShareStartTracker(onChange);
        t.begin();
        t.stopped();
        expect(t.starting).toBe(true);
        expect(onChange).toHaveBeenCalledTimes(1);
    });
});

describe('describeShareStartError', () => {
    const err = (name: string) => Object.assign(new Error('x'), { name });
    it('a dismissed Linux portal chooser is a cancel, not an error', () => {
        expect(describeShareStartError(err('NotAllowedError'), 'linux')).toEqual({ kind: 'cancelled' });
    });
    it('macOS NotAllowedError explains Screen Recording', () => {
        const v = describeShareStartError(err('NotAllowedError'), 'mac');
        expect(v.kind).toBe('failed');
        expect(v.kind === 'failed' && v.text).toMatch(/Screen Recording/);
    });
    it('control: the same error on Windows is a failure with its own text', () => {
        const v = describeShareStartError(err('NotAllowedError'), 'windows');
        expect(v.kind).toBe('failed');
        expect(v.kind === 'failed' && v.text).not.toMatch(/macOS/);
    });
    it('capture and unknown errors are failures', () => {
        expect(describeShareStartError(err('NotReadableError'), 'windows').kind).toBe('failed');
        expect(describeShareStartError(new Error('publish timed out'), 'windows').kind).toBe('failed');
        expect(describeShareStartError(null, undefined).kind).toBe('failed');
    });
});
