import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    MUTE_ENTRY_MAX, MUTE_TOMBSTONE_TTL_MS, emptyMuteState, isEmptyMuteState, liveMuteMap, mergeMuteStates, migrateLegacyConvMutes,
    muteStateFor, parseMuteState, parseMutesPayload, pruneMuteState, sameMuteState, serializeMuteState, unmuteState, type MuteState,
} from './muteSync';
import { parseMuteMap, serializeMuteMap } from './channelMute';

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const T = NOW - 10 * H;   // stamps in the recent past (tombstones older than 30 days are pruned)
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const st = (mutes: MuteState['mutes'] = {}, gone: MuteState['gone'] = {}): MuteState => ({ mutes, gone });

describe('muteSync: record format', () => {
    it('v1 blob (written by an older desktop or phone) parses as legacy entries with stamp 0', () => {
        const v1 = serializeMuteMap({ [A]: { until: null }, [B]: { until: NOW + H } });
        const s = parseMuteState(v1, NOW);
        expect(s.mutes[A]).toEqual({ until: null, at: 0 });
        expect(s.mutes[B]).toEqual({ until: NOW + H, at: 0 });
    });
    it('a v2 blob is still readable by the v1 parser (live mutes only, extra fields ignored)', () => {
        let s = muteStateFor(emptyMuteState(), A, 'forever', NOW);
        s = muteStateFor(s, B, '1h', NOW);
        s = unmuteState(s, B, NOW + 5);
        const v1view = parseMuteMap(serializeMuteState(s), NOW);
        expect(Object.keys(v1view)).toEqual([A]);
        expect(v1view[A]).toEqual({ until: null });
    });
    it('canonical serialisation: ids sorted, byte-identical for equal states', () => {
        const x = st({ [C]: { until: null, at: 5 }, [A]: { until: NOW + H, at: 6 } }, { [B]: 7 });
        const y = st({ [A]: { until: NOW + H, at: 6 }, [C]: { until: null, at: 5 } }, { [B]: 7 });
        expect(serializeMuteState(x)).toBe(serializeMuteState(y));
        expect(serializeMuteState(x)).toBe(`{"v":2,"mutes":{"${A}":{"until":${NOW + H},"at":6},"${C}":{"until":null,"at":5}},"gone":{"${B}":7}}`);
    });
    it('garbage, wrong types, unsafe ids and absurd stamps are dropped, never coerced', () => {
        expect(parseMuteState('{nope', NOW)).toEqual(emptyMuteState());
        expect(parseMuteState(null, NOW)).toEqual(emptyMuteState());
        const raw = JSON.stringify({ v: 2, mutes: { [A]: { until: 'x', at: 1 }, '../etc': { until: null, at: 1 }, [B]: { until: null, at: NOW * 10 }, [C]: { until: null, at: 9 } }, gone: { [A]: 'y' } });
        expect(Object.keys(parseMuteState(raw, NOW).mutes)).toEqual([C]);
    });
    it('a lapsed v2 entry is kept as a tombstone (same stamp); a lapsed v1 entry has nothing to keep', () => {
        const raw = JSON.stringify({ v: 2, mutes: { [A]: { until: NOW - 1, at: T + 100 } }, gone: {} });
        expect(parseMuteState(raw, NOW)).toEqual(st({}, { [A]: T + 100 }));
        expect(parseMuteState(JSON.stringify({ v: 1, mutes: { [A]: { until: NOW - 1 } } }), NOW)).toEqual(emptyMuteState());
    });
    it('strict payload parsing rejects a newer version and an oversize payload', () => {
        expect(() => parseMutesPayload(JSON.stringify({ v: 3, mutes: {} }), NOW)).toThrow();
        expect(() => parseMutesPayload('x'.repeat(300 * 1024), NOW)).toThrow();
    });
});

describe('muteSync: local edits', () => {
    it('mute then unmute leaves a tombstone newer than the mute (so the unmute propagates)', () => {
        const m = muteStateFor(emptyMuteState(), A, 'forever', NOW);
        const u = unmuteState(m, A, NOW);              // same clock reading
        expect(u.mutes[A]).toBeUndefined();
        expect(u.gone[A]).toBeGreaterThan(m.mutes[A].at);
        expect(liveMuteMap(u, NOW)).toEqual({});
    });
    it('unmuting what is not muted changes nothing (same object)', () => {
        const s = emptyMuteState();
        expect(unmuteState(s, A, NOW)).toBe(s);
    });
    it('every duration', () => {
        for (const [d, ms] of [['15m', 15 * 60_000], ['1h', H], ['8h', 8 * H], ['24h', 24 * H]] as const) {
            expect(muteStateFor(emptyMuteState(), A, d, NOW).mutes[A].until).toBe(NOW + ms);
        }
        expect(muteStateFor(emptyMuteState(), A, 'forever', NOW).mutes[A].until).toBeNull();
    });
    it('re-muting after an unmute clears the tombstone and out-stamps it', () => {
        let s = muteStateFor(emptyMuteState(), A, 'forever', NOW);
        s = unmuteState(s, A, NOW);
        s = muteStateFor(s, A, '1h', NOW);
        expect(s.gone[A]).toBeUndefined();
        expect(s.mutes[A].at).toBeGreaterThan(0);
    });
});

describe('muteSync: merge (per-id last writer wins, deterministic)', () => {
    it('a newer unmute beats an older mute, in either merge order', () => {
        const a = st({ [A]: { until: null, at: T + 100 } });
        const b = st({}, { [A]: T + 200 });
        expect(mergeMuteStates(a, b, NOW)).toEqual(b);
        expect(mergeMuteStates(b, a, NOW)).toEqual(b);
    });
    it('a newer mute beats an older unmute', () => {
        const a = st({ [A]: { until: null, at: T + 300 } });
        const b = st({}, { [A]: T + 200 });
        expect(mergeMuteStates(a, b, NOW).mutes[A]).toEqual({ until: null, at: T + 300 });
        expect(mergeMuteStates(b, a, NOW).mutes[A]).toEqual({ until: null, at: T + 300 });
    });
    it('concurrent edits with equal stamps tie-break: mute beats unmute; never-ending beats timed; later end beats earlier', () => {
        const t = T + 500;
        expect(mergeMuteStates(st({ [A]: { until: NOW + H, at: t } }), st({}, { [A]: t }), NOW).mutes[A]).toBeDefined();
        expect(mergeMuteStates(st({}, { [A]: t }), st({ [A]: { until: NOW + H, at: t } }), NOW).mutes[A]).toBeDefined();
        expect(mergeMuteStates(st({ [A]: { until: null, at: t } }), st({ [B]: { until: NOW + H, at: T + 1 }, [A]: { until: NOW + H, at: t } }), NOW).mutes[A].until).toBeNull();
        expect(mergeMuteStates(st({ [A]: { until: NOW + H, at: t } }), st({ [A]: { until: NOW + 2 * H, at: t } }), NOW).mutes[A].until).toBe(NOW + 2 * H);
    });
    it('legacy (stamp 0) entries: any stamped change wins; two legacy entries keep the v1 rule', () => {
        expect(mergeMuteStates(st({ [A]: { until: null, at: 0 } }), st({}, { [A]: T + 5 }), NOW).gone[A]).toBe(T + 5);
        expect(mergeMuteStates(st({ [A]: { until: NOW + H, at: 0 } }), st({ [A]: { until: NOW + 2 * H, at: 0 } }), NOW).mutes[A].until).toBe(NOW + 2 * H);
    });
    it('commutative, associative and idempotent over a spread of states', () => {
        const x = st({ [A]: { until: null, at: T + 10 }, [B]: { until: NOW + H, at: T + 20 } }, { [C]: T + 30 });
        const y = st({ [A]: { until: NOW + H, at: T + 10 }, [C]: { until: null, at: T + 31 } }, { [B]: T + 20 });
        const z = st({ [B]: { until: null, at: T + 21 } }, { [A]: T + 9, [C]: T + 31 });
        const m = (p: MuteState, q: MuteState) => mergeMuteStates(p, q, NOW);
        expect(sameMuteState(m(x, y), m(y, x))).toBe(true);
        expect(sameMuteState(m(m(x, y), z), m(x, m(y, z)))).toBe(true);
        expect(sameMuteState(m(x, x), pruneMuteState(x, NOW))).toBe(true);
    });
    it('a lapsed mute becomes a tombstone, so an older LONGER copy on an offline device cannot revive it', () => {
        const offline = st({ [A]: { until: NOW + 10 * H, at: T + 100 } });          // an older, longer mute
        const shortened = st({ [A]: { until: NOW - 1, at: T + 200 } });             // replaced by a shorter one that has lapsed
        const merged = mergeMuteStates(offline, shortened, NOW);
        expect(merged.mutes[A]).toBeUndefined();
        expect(merged.gone[A]).toBe(T + 200);
    });
    it('tombstones older than 30 days are dropped; entries are bounded', () => {
        const old = st({}, { [A]: NOW - MUTE_TOMBSTONE_TTL_MS - 1, [B]: NOW - MUTE_TOMBSTONE_TTL_MS + 1000 });
        expect(Object.keys(pruneMuteState(old, NOW).gone)).toEqual([B]);
        const many: MuteState['mutes'] = {};
        for (let i = 0; i < MUTE_ENTRY_MAX + 50; i++) many[`id-${i}`] = { until: null, at: i + 1 };
        const p = pruneMuteState(st(many), NOW);
        expect(Object.keys(p.mutes)).toHaveLength(MUTE_ENTRY_MAX);
        expect(p.mutes['id-0']).toBeUndefined();                                  // the oldest stamps go first
    });
    it('pruning returns the same object when nothing lapsed', () => {
        const s = st({ [A]: { until: null, at: T + 1 } });
        expect(pruneMuteState(s, NOW)).toBe(s);
        expect(isEmptyMuteState(emptyMuteState())).toBe(true);
    });
});

describe('muteSync: legacy per-conversation mute migration', () => {
    it('folds mode none into an until-forever mute, resets the pref, skips ids that already have a record', () => {
        const prefs = { [A]: 'none', [B]: 'mentions', [C]: 'none' } as const;
        const base = st({}, { [C]: 50 });                                         // C was unmuted elsewhere
        const r = migrateLegacyConvMutes({ ...prefs }, base, NOW)!;
        expect(r.state.mutes[A]).toMatchObject({ until: null });
        expect(r.state.mutes[C]).toBeUndefined();
        expect(r.prefs).toEqual({ [B]: 'mentions' });
        expect(migrateLegacyConvMutes(r.prefs, r.state, NOW)).toBeNull();          // idempotent
    });
});

// ── Cross-implementation fixtures (desktop TypeScript <-> phones' Rust) ─────────────────────────
// The desktop encoder writes __fixtures__/mute-sync-desktop.json (committed; a copy lives in
// cipherline-native core/cl-sync/tests/fixtures/); the Rust encoder wrote mute-sync-rust.json (copied
// here). Both sides parse the other's strings and must reach the same semantic result.
const FIX = join(__dirname, '__fixtures__');
describe('muteSync: cross-implementation fixtures', () => {
    const NOWF = 1_800_000_000_000;
    const cases = () => {
        const s = (m: MuteState['mutes'], g: MuteState['gone'] = {}) => st(m, g);
        const sets: Array<{ name: string; a: MuteState; b: MuteState }> = [
            { name: 'mute-vs-newer-unmute', a: s({ [A]: { until: null, at: T + 100 } }), b: s({}, { [A]: T + 200 }) },
            { name: 'equal-stamp-tie', a: s({ [A]: { until: NOWF + H, at: T + 5 } }), b: s({ [A]: { until: null, at: T + 5 } }, {}) },
            { name: 'disjoint-with-lapsed', a: s({ [A]: { until: NOWF - 1, at: T + 7 }, [B]: { until: NOWF + 2 * H, at: T + 8 } }), b: s({ [C]: { until: null, at: T + 9 } }) },
            { name: 'older-longer-copy-vs-lapsed-shorter', a: s({ [A]: { until: NOWF + 10 * H, at: T + 1 } }), b: s({ [A]: { until: NOWF - 1, at: T + 2 } }) },
            { name: 'legacy-v1-vs-stamped-unmute', a: s({ [A]: { until: null, at: 0 }, [B]: { until: NOWF + H, at: 0 } }), b: s({ [B]: { until: NOWF + 2 * H, at: 0 } }, { [A]: T + 3 }) },
        ];
        return sets.map(c => ({
            name: c.name, now: NOWF, a: serializeMuteState(c.a), b: serializeMuteState(c.b),
            merged: serializeMuteState(mergeMuteStates(c.a, c.b, NOWF)),
        }));
    };
    it('the committed desktop fixture equals what the real code produces now (UPDATE_FIXTURES=1 rewrites it)', () => {
        const out = JSON.stringify({ generatedBy: 'apps/desktop/src/utils/muteSync.test.ts', cases: cases() }, null, 2) + '\n';
        const path = join(FIX, 'mute-sync-desktop.json');
        if (process.env.UPDATE_FIXTURES === '1') writeFileSync(path, out);
        expect(readFileSync(path, 'utf8')).toBe(out);
    });
    // Skipped (loudly: it shows as skipped) only until the Rust-written fixture is copied in from cipherline-native
    // core/cl-sync/tests/fixtures/mute-sync-rust.json.
    it.skipIf(!existsSync(join(FIX, 'mute-sync-rust.json')))("reads the Rust encoder's strings and agrees on every merge", () => {
        const path = join(FIX, 'mute-sync-rust.json');
        const fx = JSON.parse(readFileSync(path, 'utf8')) as { cases: Array<{ name: string; now: number; a: string; b: string; merged: string }> };
        expect(fx.cases.length).toBeGreaterThan(2);
        for (const c of fx.cases) {
            const a = parseMuteState(c.a, c.now), b = parseMuteState(c.b, c.now);
            const merged = mergeMuteStates(a, b, c.now);
            expect(sameMuteState(merged, parseMuteState(c.merged, c.now)), c.name).toBe(true);
            expect(serializeMuteState(merged), `${c.name}: byte-identical canonical form`).toBe(c.merged);
        }
    });
});
