import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    judgeKeyDistributor, resolveRefreshVerdict, isHistoricalEpoch, distributorRefreshKey, MAX_DISTRIBUTOR_REFRESHES,
    type DistributorCheckInput,
} from './channelKeyDistributorCheck';

const ME = 'me';
const ALICE = 'alice';   // legit member + viewer
const MALLORY = 'mallory';
const roster = (ids: string[], fresh: boolean) => ({ memberIds: new Set(ids), fresh });
const viewers = (ids: string[] | 'all' | null, fresh: boolean) => ({
    viewers: ids === null ? null : ids === 'all' ? { all: true as const } : { all: false as const, ids: new Set(ids) },
    fresh,
});
const base = (over: Partial<DistributorCheckInput>): DistributorCheckInput => ({
    distributorUserId: ALICE, selfUserId: ME,
    channel: { view_scope: 'all' }, roster: roster([ME, ALICE], true), viewers: null,
    ...over,
});

describe('judgeKeyDistributor', () => {
    type Row = [string, Partial<DistributorCheckInput>, ReturnType<typeof judgeKeyDistributor>];
    const rows: Row[] = [
        // Positive controls — a legitimate member's key still installs.
        ['legit member, public channel', {}, 'accept'],
        ['legit member, restricted channel, in viewer set', { channel: { view_scope: 'restricted' }, viewers: viewers([ME, ALICE], true) }, 'accept'],
        ['legit member, restricted channel, server says all can view', { channel: { view_scope: 'restricted' }, viewers: viewers('all', false) }, 'accept'],
        ['legit member, stale roster still lists them', { roster: roster([ME, ALICE], false) }, 'accept'],
        ['own other device', { distributorUserId: ME, roster: roster([], true) }, 'accept'],
        ['no distributor id — refused (F1: no anonymous key material)', { distributorUserId: null }, 'reject'],

        // Missing data — never refuse, the server already authorized the sender.
        ['no roster cached', { roster: null }, 'unverified'],
        ['channel unknown', { channel: null }, 'unverified'],
        ['older API without view_scope', { channel: {} }, 'unverified'],
        ['restricted, no viewer data cached', { channel: { view_scope: 'restricted' }, viewers: null }, 'unverified'],
        ['restricted, viewer fetch failed', { channel: { view_scope: 'restricted' }, viewers: viewers(null, false) }, 'unverified'],

        // Negative from data that may be stale — refresh first.
        ['not in a stale roster', { distributorUserId: MALLORY, roster: roster([ME, ALICE], false) }, 'refresh'],
        ['not in a stale viewer set', { channel: { view_scope: 'restricted' }, viewers: viewers([ME], false) }, 'refresh'],

        // Negative from fresh data — reject.
        ['not a member (fresh roster)', { distributorUserId: MALLORY }, 'reject'],
        ['member but cannot view the restricted channel (fresh)', { channel: { view_scope: 'restricted' }, viewers: viewers([ME], true) }, 'reject'],
        ['fresh non-member, even when viewer data is missing', { distributorUserId: MALLORY, channel: { view_scope: 'restricted' }, viewers: null }, 'reject'],
        ['fresh non-member, latest (send) epoch', { distributorUserId: MALLORY, historicalEpoch: false }, 'reject'],

        // Historical epochs are read-only keys: never rejected (a departed
        // holder's pending envelope may be the only copy).
        ['fresh non-member, historical epoch', { distributorUserId: MALLORY, historicalEpoch: true }, 'unverified'],
        ['stale negative, historical epoch (no refresh round)', { distributorUserId: MALLORY, roster: roster([ME], false), historicalEpoch: true }, 'unverified'],
        ['legit member, historical epoch', { historicalEpoch: true }, 'accept'],
    ];
    it.each(rows)('%s', (_n, over, expected) => {
        expect(judgeKeyDistributor(base(over))).toBe(expected);
    });
});

describe('isHistoricalEpoch', () => {
    it('only strictly-older epochs with a known latest are historical', () => {
        expect(isHistoricalEpoch(2, 3)).toBe(true);
        expect(isHistoricalEpoch(3, 3)).toBe(false);
        expect(isHistoricalEpoch(4, 3)).toBe(false);
        expect(isHistoricalEpoch(1, undefined)).toBe(false);
    });
});

describe('refresh bound', () => {
    it('refreshes MAX_DISTRIBUTOR_REFRESHES times, then installs as unverified (never strands a key)', () => {
        const seen: string[] = [];
        for (let n = 0; n <= MAX_DISTRIBUTOR_REFRESHES + 2; n++) seen.push(resolveRefreshVerdict(n));
        expect(seen.filter(v => v === 'refresh')).toHaveLength(MAX_DISTRIBUTOR_REFRESHES);
        expect(seen[seen.length - 1]).toBe('unverified');
    });
    it('keys the counter per channel, epoch and distributor', () => {
        expect(distributorRefreshKey('c', 3, 'u')).not.toBe(distributorRefreshKey('c', 4, 'u'));
        expect(distributorRefreshKey('c', 3, 'u')).not.toBe(distributorRefreshKey('c', 3, 'v'));
    });
});

describe('wiring (Dashboard pullChannelKeysOnce)', () => {
    const src = readFileSync(join(__dirname, '../components/Dashboard.tsx'), 'utf8');
    const start = src.indexOf('const pullChannelKeysOnce = useCallback(');
    const body = src.slice(start, src.indexOf('const [keyPullFlight]', start));

    it('judges the distributor before installing a key', () => {
        const judge = body.indexOf('judgeKeyDistributor(');
        expect(judge).toBeGreaterThan(-1);
        expect(judge).toBeLessThan(body.indexOf('setChannelKey('));
    });
    it('a reject goes through the bounded-failure path (throw), not a silent ACK', () => {
        expect(body).toMatch(/verdict === 'reject'[\s\S]{0,200}throw new Error\(/);
    });
    it('a refresh leaves the envelope un-ACKed without counting a failure, then re-pulls', () => {
        const m = body.match(/verdict === 'refresh'[\s\S]*?continue;/);
        expect(m).not.toBeNull();
        expect(m![0]).not.toMatch(/ackIds\.push|envelopeFailureCountRef/);
        expect(body).toMatch(/refreshChannelViewers\([\s\S]{0,400}pullChannelKeys\(serverId\)/);
    });
});
