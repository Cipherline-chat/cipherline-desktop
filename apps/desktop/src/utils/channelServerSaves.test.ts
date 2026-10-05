import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import {
    saveStateFromRows,
    saveStateFromLegacyPins,
    fetchChannelSaveState,
    withId,
    withoutId,
} from './channelServerSaves';

// Factory mock: importing the real axios in this environment touches
// `location.href` at module load. Same pattern as AuthContext.boot.test.ts.
vi.mock('axios', () => ({ default: { get: vi.fn() } }));
const get = vi.mocked(axios.get);

describe('saveStateFromRows (GET /saves)', () => {
    it('splits saved vs pinned, with pinned ⊆ saved', () => {
        const s = saveStateFromRows([
            { message_id: 'a', is_pinned: true },
            { message_id: 'b', is_pinned: false },
        ]);
        expect(s.saved).toEqual(['a', 'b']);
        expect(s.pinned).toEqual(['a']);
    });

    it('treats a row without is_pinned as pinned (what every row meant before the field)', () => {
        expect(saveStateFromRows([{ message_id: 'a' }])).toEqual({ saved: ['a'], pinned: ['a'] });
    });

    it('drops malformed rows and duplicates, and survives a non-array body', () => {
        expect(saveStateFromRows([{ message_id: 5 }, null, { message_id: 'a', is_pinned: false }, { message_id: 'a', is_pinned: false }]))
            .toEqual({ saved: ['a'], pinned: [] });
        expect(saveStateFromRows({ nope: true })).toEqual({ saved: [], pinned: [] });
    });
});

describe('saveStateFromLegacyPins (API without /saves)', () => {
    it('every legacy pin is both saved and pinned', () => {
        expect(saveStateFromLegacyPins([{ message_id: 'a' }, { message_id: 'b' }]))
            .toEqual({ saved: ['a', 'b'], pinned: ['a', 'b'] });
    });
});

describe('fetchChannelSaveState', () => {
    beforeEach(() => get.mockReset());

    it('reads /saves', async () => {
        get.mockResolvedValueOnce({ data: [{ message_id: 'a', is_pinned: false }] });
        await expect(fetchChannelSaveState('http://api', 'c1', 't')).resolves.toEqual({ saved: ['a'], pinned: [] });
        expect(get).toHaveBeenCalledWith('http://api/channels/c1/saves', { headers: { Authorization: 'Bearer t' } });
    });

    it('falls back to /pins only when /saves does not exist (404 from an older API)', async () => {
        get.mockRejectedValueOnce({ response: { status: 404 } });
        get.mockResolvedValueOnce({ data: [{ message_id: 'a' }] });
        await expect(fetchChannelSaveState('http://api', 'c1', 't')).resolves.toEqual({ saved: ['a'], pinned: ['a'] });
        expect(get).toHaveBeenLastCalledWith('http://api/channels/c1/pins', { headers: { Authorization: 'Bearer t' } });
    });

    it('does NOT fall back on a permission error — that must surface, not show legacy data', async () => {
        get.mockRejectedValueOnce({ response: { status: 403 } });
        await expect(fetchChannelSaveState('http://api', 'c1', 't')).rejects.toEqual({ response: { status: 403 } });
        expect(get).toHaveBeenCalledTimes(1);
    });
});

describe('withId / withoutId', () => {
    it('adds once and removes cleanly, tolerating an absent list', () => {
        expect(withId(undefined, 'a')).toEqual(['a']);
        const l = ['a'];
        expect(withId(l, 'a')).toBe(l);
        expect(withoutId(['a', 'b'], 'a')).toEqual(['b']);
        expect(withoutId(undefined, 'a')).toEqual([]);
    });
});
