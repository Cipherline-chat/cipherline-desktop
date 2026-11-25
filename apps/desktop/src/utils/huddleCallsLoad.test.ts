import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    applyHuddleCallsLoadFailure,
    huddleCallsLoadFailureClears,
    huddleCallsLoadFailureReason,
    huddleChannelKey,
    participantEventNeedsReload,
} from './huddleCallsLoad';
import type { HuddleCallInfo } from '../hooks/useServers';

const call = (id: string): HuddleCallInfo => ({
    call_id: id, huddle_id: 'h', name: 'n', spawner_user_id: 'u', spawned_at: '2026-11-23T00:00:00Z', participants: ['u'],
});
const err = (status?: number, code?: string) => ({ response: status === undefined ? undefined : { status }, code });

describe('huddleCallsLoadFailureClears', () => {
    it.each([403, 404])('clears on %i', s => expect(huddleCallsLoadFailureClears(err(s))).toBe(true));
    it.each([400, 401, 408, 429, 500, 502, 503, 504])('keeps on %i', s => expect(huddleCallsLoadFailureClears(err(s))).toBe(false));
    it('keeps on a network error / timeout / non-axios throw', () => {
        expect(huddleCallsLoadFailureClears(err(undefined, 'ERR_NETWORK'))).toBe(false);
        expect(huddleCallsLoadFailureClears(err(undefined, 'ECONNABORTED'))).toBe(false);
        expect(huddleCallsLoadFailureClears(new Error('boom'))).toBe(false);
        expect(huddleCallsLoadFailureClears(null)).toBe(false);
        expect(huddleCallsLoadFailureClears(undefined)).toBe(false);
    });
});

describe('applyHuddleCallsLoadFailure', () => {
    const prev = { h: [call('c1')], other: [call('c2')] };
    it('returns the same object on a transient failure (no re-render)', () => {
        expect(applyHuddleCallsLoadFailure(prev, 'h', err(429))).toBe(prev);
    });
    it('empties only that channel on 403', () => {
        expect(applyHuddleCallsLoadFailure(prev, 'h', err(403))).toEqual({ h: [], other: [call('c2')] });
    });
});

describe('huddleCallsLoadFailureReason', () => {
    it('names the status, the error code, or network', () => {
        expect(huddleCallsLoadFailureReason(err(429))).toBe('HTTP 429');
        expect(huddleCallsLoadFailureReason(err(undefined, 'ECONNABORTED'))).toBe('ECONNABORTED');
        expect(huddleCallsLoadFailureReason(new Error('x'))).toBe('network');
    });
});

describe('participantEventNeedsReload', () => {
    const calls = { h: [call('c1')] };
    it('a join for an unknown call in a known channel', () => expect(participantEventNeedsReload(calls, 'h', 'c9', 'join')).toBe(true));
    it('a join for a call in a channel with no bucket', () => expect(participantEventNeedsReload(calls, 'h2', 'c9', 'join')).toBe(true));
    it('a join for a known call', () => expect(participantEventNeedsReload(calls, 'h', 'c1', 'join')).toBe(false));
    it('never for a leave', () => expect(participantEventNeedsReload(calls, 'h', 'c9', 'leave')).toBe(false));
});

describe('huddleChannelKey', () => {
    it('is the Calls-channel ids only, in order, and equal for an equal copy', () => {
        const list = [
            { channel_id: 'a', kind: 'text' }, { channel_id: 'b', kind: 'huddle' }, { channel_id: 'c', kind: 'huddle' },
        ];
        expect(huddleChannelKey(list)).toBe('b,c');
        expect(huddleChannelKey(list.map(c => ({ ...c })))).toBe(huddleChannelKey(list));
        expect(huddleChannelKey(undefined)).toBe('');
        expect(huddleChannelKey([{ channel_id: 'a', kind: 'text' }])).toBe('');
    });
});

describe('Dashboard wiring', () => {
    const dash = readFileSync(resolve(__dirname, '../components/Dashboard.tsx'), 'utf8');
    it('the active-server auto-load is keyed on its Calls-channel ids, not on the whole serverChannels map', () => {
        expect(dash).toMatch(/\}, \[activeServerView\?\.serverId, activeServerHuddleKey, loadHuddleCalls\]\);/);
        expect(dash).not.toMatch(/\}, \[activeServerView\?\.serverId, serverChannels, loadHuddleCalls\]\);/);
    });
});
