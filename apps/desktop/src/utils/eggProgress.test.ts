import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    EGG_FOUND_EVENT, EGG_ID_RE, EGG_IDS, EGG_TIER_COLORS, EGG_TIER_EVENT, EGG_TIERS, MAX_EGG_IDS,
    SYNC_DEBOUNCE_MS, SYNC_RETRY_MS, BOOT_SYNC_DELAY_MS,
    costumeEggFor, createEggProgress, creditLedgerFinds, eggProgressKey, eggTierByNumber, eggTierFor,
    legacyEggsFoundKey, parseEggTierIcon, parseLegacyFound, parseProgress,
    type EggProgressController, type EggSender, type EggSyncResult,
} from './eggProgress';
import { EGG_LEDGER_KEY } from './easterEggs';
import { MOMENTS, ledgerId } from './moments';
import { classifyKvKey } from '../services/backupRegistry';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const UID = 'user-1';

// ── harness: fake store, fake timers owned by the test, captured events ──────

function harness() {
    const kv = new Map<string, string>();
    const h = { lockedKey: null as string | null };
    const events: Array<{ name: string; detail: any }> = [];
    let nextHandle = 1;
    const timers = new Map<number, { fn: () => void; ms: number }>();
    const ctl: EggProgressController = createEggProgress({
        store: { getItem: (k) => { if (h.lockedKey === k) throw new Error('locked'); return kv.get(k) ?? null; }, setItem: (k, v) => { kv.set(k, v); } },
        emit: (name, detail) => events.push({ name, detail }),
        setTimer: (fn, ms) => { const h = nextHandle++; timers.set(h, { fn, ms }); return h; },
        clearTimer: (h) => { timers.delete(h as number); },
    });
    const firePending = async () => {
        const due = [...timers.entries()];
        timers.clear();
        for (const [, t] of due) t.fn();
        await ctl.flush();
    };
    const state = () => parseProgress(kv.get(eggProgressKey(UID)) ?? null);
    return { kv, events, timers, ctl, firePending, state, h };
}

const reply = (count: number, tier: number): EggSyncResult => ({ tier, tier_name: eggTierByNumber(tier)?.name ?? null, count });

describe('registry and tiers', () => {
    it('ids are unique, well-formed and fit one request', () => {
        expect(new Set(EGG_IDS).size).toBe(EGG_IDS.length);
        for (const id of EGG_IDS) expect(id).toMatch(EGG_ID_RE);
        expect(EGG_IDS.length).toBeLessThanOrEqual(MAX_EGG_IDS);
    });

    it('4 ascending count-based tiers in the ocean voice; the top one stays reachable', () => {
        expect(EGG_TIERS.map(t => t.name)).toEqual(['Tide Pooler', 'Reef Explorer', 'Deep Diver', 'Abyss Legend']);
        expect(EGG_TIERS.map(t => t.min)).toEqual([3, 8, 15, 25]);
        expect(EGG_IDS.length).toBeGreaterThan(EGG_TIERS[3].min);
    });

    it('the top tier is reachable without the calendar or a giant friend/server list', () => {
        // Date-gated (a specific day, or a year of account age) and big-number
        // eggs cannot be hunted on demand; Abyss Legend must not depend on them.
        const waitOnly = new Set(['costume-halloween', 'costume-new-year', 'costume-birthday', 'new-year', 'anniversary', 'friends-100', 'servers-10']);
        const huntable = EGG_IDS.filter(id => !waitOnly.has(id));
        expect(huntable.length).toBeGreaterThanOrEqual(EGG_TIERS[3].min + 3);
    });

    it.each([[0, null], [2, null], [3, 'Tide Pooler'], [7, 'Tide Pooler'], [8, 'Reef Explorer'], [14, 'Reef Explorer'], [15, 'Deep Diver'], [24, 'Deep Diver'], [25, 'Abyss Legend'], [99, 'Abyss Legend']])(
        'count %i -> %s', (n, name) => { expect(eggTierFor(n)?.name ?? null).toBe(name); });

    it('every tier has a colour name the badge palette knows', () => {
        for (const t of EGG_TIERS) expect(EGG_TIER_COLORS[t.tier]).toBeTruthy();
    });

    it('parseEggTierIcon accepts only egg-tier-1..4', () => {
        expect(parseEggTierIcon('egg-tier-3')).toBe(3);
        for (const bad of ['egg-tier-0', 'egg-tier-5', 'egg-tier-12', 'egg-tier-', 'star', '', null, undefined]) {
            expect(parseEggTierIcon(bad as string | null | undefined)).toBeNull();
        }
    });
});

describe('server mirror (apps/api/src/profile-eggs/egg-registry.ts)', () => {
    // The desktop repo is exported without apps/api; skip there rather than fail.
    const api = join(SRC, '..', '..', 'api', 'src', 'profile-eggs', 'egg-registry.ts');
    const it2 = existsSync(api) ? it : it.skip;

    it2('lists exactly the same egg ids', () => {
        const src = readFileSync(api, 'utf8');
        const block = /export const EGG_IDS = \[([\s\S]*?)\] as const;/.exec(src)![1];
        const ids = [...block.matchAll(/'([a-z0-9-]+)'/g)].map(m => m[1]);
        expect(ids).toEqual([...EGG_IDS]);
    });

    it2('has the same tier thresholds and names', () => {
        const src = readFileSync(api, 'utf8');
        const block = /export const EGG_TIERS[^=]*= \[([\s\S]*?)\];/.exec(src)![1];
        const rows = [...block.matchAll(/tier:\s*(\d+),\s*min:\s*(\d+),\s*name:\s*'([^']+)'/g)]
            .map(m => ({ tier: Number(m[1]), min: Number(m[2]), name: m[3] }));
        expect(rows).toEqual(EGG_TIERS.map(t => ({ ...t })));
    });

    it2('has the same tier colours', () => {
        const src = readFileSync(api, 'utf8');
        const block = /export const EGG_TIER_COLORS[^=]*= \{([\s\S]*?)\};/.exec(src)![1];
        const colors = Object.fromEntries([...block.matchAll(/(\d):\s*'([a-z]+)'/g)].map(m => [Number(m[1]), m[2]]));
        expect(colors).toEqual(EGG_TIER_COLORS);
    });
});

describe('every registered egg is actually wired', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
        for (const f of readdirSync(dir)) {
            const p = join(dir, f);
            if (statSync(p).isDirectory()) walk(p, out);
            else if (/\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(p);
        }
        return out;
    };
    const code = walk(SRC).filter(f => !f.endsWith('utils/eggProgress.ts'))
        .map(f => readFileSync(f, 'utf8')).join('\n');

    const momentIds = Object.keys(MOMENTS);

    it.each([...EGG_IDS])('%s has a call site', (id) => {
        // Direct calls, the EggSeen helper, or the settings-search `egg:` verdict.
        // The three holiday ids resolve through costumeEggFor(), and the moment
        // ids through MomentHost — both asserted below.
        if (id.startsWith('costume-') || momentIds.includes(id)) return;
        // Keys' spam finales record `keys-finale-<state>` through finaleEggId();
        // asserted below that the call exists and every finale state is registered.
        if (id.startsWith('keys-finale-')) return;
        const direct = new RegExp(`recordEggFound\\(\\s*'${id}'\\s*\\)|<EggSeen id="${id}"|egg: [^\\n]*'${id}'`);
        expect(direct.test(code)).toBe(true);        // boolean, not toMatch: a miss must not dump the whole source tree
    });

    it('the holiday eggs are recorded where Keys wears the hat, via costumeEggFor', () => {
        const hook = readFileSync(join(SRC, 'hooks', 'useEasterEggs.ts'), 'utf8');
        expect(hook).toMatch(/costumeEggFor\(new Date\(\)\)/);
        expect(hook).toMatch(/recordEggFound\(id\)/);
    });

    it('every full-screen moment is a registry egg, and the registry lists no phantom moment', () => {
        for (const id of momentIds) expect(EGG_IDS).toContain(id as (typeof EGG_IDS)[number]);
        // The moment block of EGG_IDS is exactly MOMENTS (same ids, same order).
        expect(EGG_IDS.slice(EGG_IDS.length - momentIds.length)).toEqual(momentIds);
    });

    it('MomentHost records the moment under its BARE id when (and only where) it plays', () => {
        const host = readFileSync(join(SRC, 'components', 'moments', 'MomentHost.tsx'), 'utf8');
        expect(host.match(/recordEggFound\(/g)).toHaveLength(1);
        expect(host).toMatch(/recordEggFound\(id\);/);
        expect(host).not.toMatch(/recordEggFound\(ledgerId/);
        // ...right after the ledger claim succeeded (not when merely requested).
        const claim = host.indexOf('if (!claimMoment(store, id, Date.now())) return');
        expect(claim).toBeGreaterThan(-1);
        expect(host.indexOf('recordEggFound(id)')).toBeGreaterThan(claim);
    });

    it('claimEggNow only rate-limits: each egg records itself, once, at its payoff', () => {
        const hook = readFileSync(join(SRC, 'hooks', 'useEasterEggs.ts'), 'utf8');
        const body = hook.slice(hook.indexOf('export function claimEggNow'), hook.indexOf('export function eggCountNow'));
        expect(body).not.toMatch(/recordEggFound/);
        // CreateGroupModal (group-of-two) and VersionTapEgg (dev mode): exactly one call each.
        for (const [f, id] of [['components/CreateGroupModal.tsx', 'group-of-two'], ['components/settings/VersionTapEgg.tsx', 'dev-mode']] as const) {
            const src = readFileSync(join(SRC, f), 'utf8');
            expect(src.match(/recordEggFound\(/g), f).toHaveLength(1);
            expect(src).toMatch(new RegExp(`recordEggFound\\('${id}'\\)`));
        }
    });

    it('no call site uses an id that is not in the registry', () => {
        const used = [...code.matchAll(/recordEggFound\(\s*'([^']+)'\s*\)/g)].map(m => m[1]);
        expect(used.length).toBeGreaterThan(10);
        for (const id of used) expect(EGG_IDS).toContain(id as (typeof EGG_IDS)[number]);
    });
});

describe('persistence', () => {
    it('parseProgress is defensive: corrupt blobs are "nothing found"', () => {
        for (const raw of [null, '', 'not json', '[]', '"x"', 'null', '{"found":"nope"}']) {
            expect(parseProgress(raw)).toEqual({ found: [], synced: [], tier: 0, serverCount: 0 });
        }
    });

    it('parseProgress drops malformed ids, dedupes, and caps the list', () => {
        const raw = JSON.stringify({ found: ['konami', 'konami', 'Bad Id', 7, '', 'x'.repeat(41)], synced: ['konami'], tier: 2, serverCount: 9 });
        expect(parseProgress(raw)).toEqual({ found: ['konami'], synced: ['konami'], tier: 2, serverCount: 9 });
        const many = JSON.stringify({ found: Array.from({ length: 200 }, (_, i) => `egg-${i}`) });
        expect(parseProgress(many).found).toHaveLength(MAX_EGG_IDS);
    });

    it('the per-account key is backed up (progress travels) and the ledger is not', () => {
        expect(classifyKvKey(eggProgressKey('abc'), 'abc')).toBe('include');
        expect(classifyKvKey(EGG_LEDGER_KEY, 'abc')).toBe('exclude');
    });

    it('the legacy local-only tally key is classified the same way (a restored one still migrates)', () => {
        expect(legacyEggsFoundKey('abc')).toBe('cipherline_eggs_found_abc');
        expect(classifyKvKey(legacyEggsFoundKey('abc'), 'abc')).toBe('include');
    });

    it('nothing writes the legacy key any more (read-only, for the migration)', () => {
        const walk = (dir: string, out: string[] = []): string[] => {
            for (const f of readdirSync(dir)) {
                const p = join(dir, f);
                if (statSync(p).isDirectory()) walk(p, out);
                else if (/\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(p);
            }
            return out;
        };
        const writers = walk(SRC).filter(f => /setItem\([^)]*(legacyEggsFoundKey|cipherline_eggs_found_|EGGS_FOUND_PREFIX)/.test(readFileSync(f, 'utf8')));
        expect(writers).toEqual([]);
    });
});

describe('recording', () => {
    let h: ReturnType<typeof harness>;
    beforeEach(() => { h = harness(); });

    it('appends once, dispatches egg-found with { id }, and persists', () => {
        h.ctl.bind(UID, async () => null);
        h.ctl.record('konami');
        h.ctl.record('konami');
        expect(h.state().found).toEqual(['konami']);
        expect(h.events.filter(e => e.name === EGG_FOUND_EVENT)).toEqual([{ name: EGG_FOUND_EVENT, detail: { id: 'konami' } }]);
    });

    it('ignores malformed ids and never throws', () => {
        h.ctl.bind(UID, async () => null);
        for (const bad of ['', 'Konami', 'a b', 'x'.repeat(41), '../etc', 123 as unknown as string, null as unknown as string]) {
            expect(() => h.ctl.record(bad)).not.toThrow();
        }
        expect(h.state().found).toEqual([]);
    });

    it('buffers finds made before sign-in and credits them to whoever binds', () => {
        h.ctl.record('konami');
        h.ctl.record('alone-echo');
        expect(h.kv.size).toBe(0);
        h.ctl.bind(UID, async () => null);
        expect(h.state().found).toEqual(['konami', 'alone-echo']);
        expect(h.events.filter(e => e.name === EGG_FOUND_EVENT)).toHaveLength(2);
    });

    it('a re-fired egg is a pure in-memory no-op (caps-lock-on-every-keystroke)', () => {
        h.ctl.bind(UID, async () => null);
        h.ctl.record('caps-inflate');
        const writes = vi.fn();
        const orig = h.kv.set.bind(h.kv);
        h.kv.set = (k: string, v: string) => { writes(); return orig(k, v); };
        for (let i = 0; i < 500; i++) h.ctl.record('caps-inflate');
        expect(writes).not.toHaveBeenCalled();
    });

    it('progress is per account: another account starts from zero', () => {
        h.ctl.bind(UID, async () => null);
        h.ctl.record('konami');
        h.ctl.bind('user-2', async () => null);
        expect(h.ctl.snapshot()?.found).toEqual([]);
    });

    it('finds made after unbind are buffered, not written to the old account', () => {
        h.ctl.bind(UID, async () => null);
        h.ctl.unbind();
        h.ctl.record('konami');
        expect(h.state().found).toEqual([]);
    });
});

describe('migrating the legacy local-only tally (cipherline_eggs_found_{uid})', () => {
    it('parseLegacyFound strips the moment: prefix, keeps registry ids only, dedupes, never throws', () => {
        const raw = JSON.stringify(['konami', 'moment:self-friend', 'keys-coffee', 'moment:nope', 'self-friend', 7, null, 'group-of-two']);
        expect(parseLegacyFound(raw)).toEqual(['konami', 'self-friend', 'group-of-two']);
        for (const junk of [null, '', 'nope', '{}', '"konami"', 'null']) expect(parseLegacyFound(junk)).toEqual([]);
    });

    it('bind folds the legacy ids into the one progress key, announces them, and syncs them', async () => {
        const h = harness();
        h.kv.set(legacyEggsFoundKey(UID), JSON.stringify(['konami', 'moment:wish', 'dev-mode']));
        const send = vi.fn<EggSender>(async (ids) => reply(ids.length, 1));
        h.ctl.bind(UID, send);
        expect(h.state().found).toEqual(['konami', 'wish', 'dev-mode']);
        expect(h.events.filter(e => e.name === EGG_FOUND_EVENT).map(e => e.detail.id)).toEqual(['konami', 'wish', 'dev-mode']);
        await h.firePending();
        expect(send).toHaveBeenCalledWith(['konami', 'wish', 'dev-mode']);
        expect(h.kv.get(legacyEggsFoundKey(UID))).toBe(JSON.stringify(['konami', 'moment:wish', 'dev-mode'])); // read-only
    });

    it('re-binding is a no-op (the old key is then effectively ignored)', () => {
        const h = harness();
        h.kv.set(legacyEggsFoundKey(UID), JSON.stringify(['konami']));
        h.ctl.bind(UID, async () => null);
        h.ctl.unbind();
        const before = h.events.length;
        h.ctl.bind(UID, async () => null);
        expect(h.events.length).toBe(before);
        expect(h.state().found).toEqual(['konami']);
    });

    it('merges with finds already in the progress key, without duplicates', () => {
        const h = harness();
        h.kv.set(eggProgressKey(UID), JSON.stringify({ found: ['konami'], synced: ['konami'], tier: 0, serverCount: 1 }));
        h.kv.set(legacyEggsFoundKey(UID), JSON.stringify(['konami', 'moment:coffee']));
        h.ctl.bind(UID, async () => null);
        expect(h.state().found).toEqual(['konami', 'coffee']);
    });

    it('only the bound account\'s legacy key is read', () => {
        const h = harness();
        h.kv.set(legacyEggsFoundKey('someone-else'), JSON.stringify(['konami']));
        h.kv.set(legacyEggsFoundKey('device'), JSON.stringify(['cuttlefish']));
        h.ctl.bind(UID, async () => null);
        expect(h.state().found).toEqual([]);
    });

    it('a locked legacy read is "nothing to migrate", never a failed bind', () => {
        const h = harness();
        h.h.lockedKey = legacyEggsFoundKey(UID);
        expect(() => h.ctl.bind(UID, async () => null)).not.toThrow();
        h.ctl.record('konami');
        expect(h.state().found).toEqual(['konami']);
    });
});

describe('syncing', () => {
    it('debounces: a burst of finds is ONE request carrying everything', async () => {
        const h = harness();
        const send = vi.fn<EggSender>(async (ids) => reply(ids.length, 0));
        h.ctl.bind(UID, send);
        h.ctl.record('konami'); h.ctl.record('cuttlefish'); h.ctl.record('self-search');
        expect(h.timers.size).toBe(1);                                   // one pending timer, re-armed
        expect([...h.timers.values()][0].ms).toBe(SYNC_DEBOUNCE_MS);
        await h.firePending();
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0][0]).toEqual(['konami', 'cuttlefish', 'self-search']);
        expect(h.state().synced).toEqual(['konami', 'cuttlefish', 'self-search']);
    });

    it('sends nothing but ids, and nothing at all when there is nothing new', async () => {
        const h = harness();
        const send = vi.fn<EggSender>(async (ids) => reply(ids.length, 0));
        h.ctl.bind(UID, send);
        await h.ctl.flush();
        expect(send).not.toHaveBeenCalled();
        h.ctl.record('konami');
        await h.firePending();
        await h.ctl.flush();
        expect(send).toHaveBeenCalledTimes(1);
        for (const arg of send.mock.calls[0]) expect(Array.isArray(arg)).toBe(true);
    });

    it('a failed sync keeps the ids unsynced and retries on the documented back-off, then gives up', async () => {
        const h = harness();
        const send = vi.fn<EggSender>(async () => null);
        h.ctl.bind(UID, send);
        h.ctl.record('konami');
        await h.firePending();                                           // attempt 1 fails
        expect(h.state().synced).toEqual([]);
        expect([...h.timers.values()].map(t => t.ms)).toEqual([SYNC_RETRY_MS[0]]);
        await h.firePending();                                           // attempt 2
        await h.firePending();                                           // attempt 3
        await h.firePending();                                           // attempt 4 (last retry)
        expect(send).toHaveBeenCalledTimes(1 + SYNC_RETRY_MS.length);
        expect(h.timers.size).toBe(0);                                   // gave up until the next find / boot
    });

    it('a throwing sender is treated as a failure, never an unhandled rejection', async () => {
        const h = harness();
        h.ctl.bind(UID, async () => { throw new Error('offline'); });
        h.ctl.record('konami');
        await expect(h.firePending()).resolves.toBeUndefined();
        expect(h.state().synced).toEqual([]);
    });

    it('boot: unsynced finds from a previous session are re-sent after a short delay', async () => {
        const h = harness();
        h.ctl.bind(UID, async () => null);
        h.ctl.record('konami');
        h.ctl.unbind();
        const send = vi.fn<EggSender>(async (ids) => reply(ids.length, 0));
        h.ctl.bind(UID, send);
        expect([...h.timers.values()].map(t => t.ms)).toEqual([BOOT_SYNC_DELAY_MS]);
        await h.firePending();
        expect(send).toHaveBeenCalledWith(['konami']);
    });

    it('boot with everything already synced is silent (no request)', async () => {
        const h = harness();
        h.ctl.bind(UID, async (ids) => reply(ids.length, 0));
        h.ctl.record('konami');
        await h.firePending();
        h.ctl.unbind();
        h.ctl.bind(UID, async () => { throw new Error('should not be called'); });
        expect(h.timers.size).toBe(0);
    });

    it('a find that lands while a sync is in flight is sent by a follow-up sync', async () => {
        const h = harness();
        let release!: (r: EggSyncResult) => void;
        const send = vi.fn<EggSender>((ids) => ids.length === 1
            ? new Promise<EggSyncResult | null>((res) => { release = res; })
            : Promise.resolve(reply(ids.length, 0)));
        h.ctl.bind(UID, send);
        h.ctl.record('konami');
        const first = h.firePending();
        h.ctl.record('cuttlefish');                                      // arrives mid-flight
        release(reply(1, 0));
        await first;
        await h.firePending();
        expect(send.mock.calls.map(c => c[0])).toEqual([['konami'], ['konami', 'cuttlefish']]);
    });

    it('a sync that resolves after sign-out is dropped (no cross-account write)', async () => {
        const h = harness();
        let release!: (r: EggSyncResult) => void;
        h.ctl.bind(UID, () => new Promise<EggSyncResult | null>((res) => { release = res; }));
        h.ctl.record('konami');
        const p = h.firePending();
        h.ctl.unbind();
        release(reply(5, 1));
        await p;
        expect(h.events.some(e => e.name === EGG_TIER_EVENT)).toBe(false);
        expect(h.state().tier).toBe(0);
    });
});

describe('new-tier moment', () => {
    const tierEvents = (h: ReturnType<typeof harness>) => h.events.filter(e => e.name === EGG_TIER_EVENT).map(e => e.detail);

    it('fires when this device’s own finds cross a threshold, once', async () => {
        const h = harness();
        let count = 0;
        h.ctl.bind(UID, async (ids) => { count = ids.length; return reply(count, eggTierFor(count)?.tier ?? 0); });
        h.ctl.record('konami'); h.ctl.record('cuttlefish');
        await h.firePending();
        expect(tierEvents(h)).toEqual([]);                               // 2 eggs: no badge yet
        h.ctl.record('self-search');
        await h.firePending();
        expect(tierEvents(h)).toEqual([{ tier: 1, name: 'Tide Pooler', count: 3 }]);
        h.ctl.record('late-night');
        await h.firePending();
        expect(tierEvents(h)).toHaveLength(1);                           // 4 eggs: same tier, no repeat
    });

    it('walks every tier as the count climbs (the 4 toasts the owner asked for)', async () => {
        const h = harness();
        h.ctl.bind(UID, async (ids) => reply(ids.length, eggTierFor(ids.length)?.tier ?? 0));
        for (let i = 0; i < 25; i++) {
            h.ctl.record(EGG_IDS[i]);
            await h.firePending();
        }
        expect(tierEvents(h).map(d => d.name)).toEqual(['Tide Pooler', 'Reef Explorer', 'Deep Diver', 'Abyss Legend']);
        expect(tierEvents(h).map(d => d.count)).toEqual([3, 8, 15, 25]);
    });

    it('is SILENT when the server already knew more than this device sent (new install, second device)', async () => {
        const h = harness();
        h.ctl.bind(UID, async () => reply(15, 3));                       // account already holds Deep Diver
        h.ctl.record('konami');
        await h.firePending();
        expect(tierEvents(h)).toEqual([]);
        expect(h.state().tier).toBe(3);                                  // adopted quietly...
        expect(h.state().serverCount).toBe(15);
        h.ctl.record('cuttlefish');                                      // ...and 16 later is still Deep Diver: no toast
        await h.firePending();
        expect(tierEvents(h)).toEqual([]);
    });

    it('reduced-motion is a render concern: the event carries no animation data', async () => {
        const h = harness();
        h.ctl.bind(UID, async (ids) => reply(ids.length, 1));
        h.ctl.record('a-1'); h.ctl.record('a-2'); h.ctl.record('a-3');
        await h.firePending();
        expect(Object.keys(tierEvents(h)[0]).sort()).toEqual(['count', 'name', 'tier']);
    });
});

describe('holiday eggs count once per holiday, not per year', () => {
    it('costumeEggFor maps the calendar to stable year-free ids', () => {
        expect(costumeEggFor(new Date(2026, 9, 31))).toBe('costume-halloween');
        expect(costumeEggFor(new Date(2027, 9, 31))).toBe('costume-halloween');
        expect(costumeEggFor(new Date(2026, 11, 31))).toBe('costume-new-year');
        expect(costumeEggFor(new Date(2027, 0, 1))).toBe('costume-new-year');
        expect(costumeEggFor(new Date(2027, 3, 30))).toBe('costume-birthday');   // first anniversary
        expect(costumeEggFor(new Date(2026, 3, 30))).toBeNull();                 // launch day is not a birthday
        expect(costumeEggFor(new Date(2026, 5, 15))).toBeNull();
    });
});

describe('credit for eggs found before this feature', () => {
    it('turns seen-ledger entries with matching ids into finds', () => {
        const recorded: string[] = [];
        const ledger = JSON.stringify({
            konami: { count: 3, last: 1 }, 'dev-mode': { count: 1, last: 1 }, 'group-of-two-anyway': { count: 2, last: 1 },
            'status-flap': { count: 0, last: 1 },
        });
        creditLedgerFinds({ getItem: () => ledger, setItem: () => undefined }, (id) => recorded.push(id));
        expect(recorded.sort()).toEqual(['dev-mode', 'konami']);          // zero-count and non-egg ids ignored
    });

    it('credits full-screen moments that already played (ledger key moment:<id>) under their bare id', () => {
        const recorded: string[] = [];
        const ledger = JSON.stringify({
            [ledgerId('self-friend')]: { count: 1, last: 1 }, [ledgerId('wish')]: { count: 0, last: 1 },
            'keys-coffee': { count: 4, last: 1 },                       // a ledger id, not a registry egg
        });
        creditLedgerFinds({ getItem: () => ledger, setItem: () => undefined }, (id) => recorded.push(id));
        expect(recorded).toEqual(['self-friend']);
    });

    it('survives a broken store', () => {
        expect(() => creditLedgerFinds({ getItem: () => { throw new Error('locked'); }, setItem: () => undefined }, () => undefined)).not.toThrow();
    });
});

describe('privacy', () => {
    const code = readFileSync(join(SRC, 'utils', 'eggProgress.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    it('the state machine itself has no network, IPC or telemetry (the host injects the one sender)', () => {
        expect(code).not.toMatch(/\baxios\b|\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|electronAPI|betaDiagnostics|reportEvent|telemetry|analytics/i);
    });
    it('never touches message content', () => {
        expect(code).not.toMatch(/messageStore|channelMessages|decrypt|inputText|plaintext|\.content\b|ClientContent/);
    });
    it('the host posts to exactly one endpoint, with ids only', () => {
        const host = readFileSync(join(SRC, 'components', 'EggProgressHost.tsx'), 'utf8');
        const posts = [...host.matchAll(/axios\.\w+[<(][^`]*`([^`]+)`/g)].map(m => m[1]);
        expect(posts).toEqual(['${API_BASE}/profile/eggs']);
        expect(host).toMatch(/\{ ids \}/);
    });
});

describe('Keys finale eggs', () => {
    it('HomeKeys records finales through finaleEggId and every finale id is registered', async () => {
        const { readFileSync } = await import('fs');
        const { resolve } = await import('path');
        const { PLAY_STATES, finaleEggId } = await import('./keysPlay');
        const src = readFileSync(resolve(__dirname, '../components/mascot/HomeKeys.tsx'), 'utf8');
        expect(/recordEggFound\(\s*finaleEggId\(/.test(src)).toBe(true);
        expect(PLAY_STATES.length).toBeGreaterThan(0);
        for (const st of PLAY_STATES) {
            expect((EGG_IDS as readonly string[]).includes(finaleEggId(st as never))).toBe(true);
        }
    });
});
