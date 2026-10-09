import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Every round trip derives a real PBKDF2 key (same cost as backupHomeState.test.ts).
vi.setConfig({ testTimeout: 60_000 });

/**
 * The server rail layout — order AND folders (name, colour, membership,
 * position among servers) — travels in the encrypted backup and comes back
 * exactly.
 *
 * backupRegistry.ts classifies `cipherline_server_rail_layout_{uid}` and the
 * legacy `cipherline_server_rail_order_{uid}` as `include: true`; this proves
 * the classification does something by driving the REAL chain a scheduled
 * backup uses, not a hand-built vault:
 *
 *   buildBackupPlan (buildLocalVault -> collectIncludedKv -> `meta` record)
 *     -> writeBackupRecords -> ContainerWriter (encrypted container)
 *     -> openContainer -> applyBackupContainer -> importLocalHistory
 *     -> applyIncludedKv           [then the rail hook's loader reads it back]
 *
 * and that a rail-only edit moves the plan fingerprint (the "skip when the
 * vault is unchanged" check), or the edit would never reach a new backup.
 *
 * secureLocalStore is an in-memory Map, same pattern as backupHomeState.test.ts.
 */
const mem = new Map<string, string>();
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    keysWithPrefix: (p: string) => [...mem.keys()].filter(k => k.startsWith(p)),
    hydrateMessages: async () => {},
    whenAccountReady: async () => {},
    isAccountReady: (u: string) => u === USER,
};
vi.mock('../utils/secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

const { buildBackupPlan, writeBackupRecords, applyBackupContainer } = await import('./backupRecords');
const { ContainerWriter, openContainer, MemoryContainer, memorySource } = await import('../utils/backupContainer');
const { KV_RULES, dropShadowingRailLayout, applyIncludedKv, collectIncludedKv } = await import('./backupRegistry');
const { loadRailLayout, serverRailLayoutKey, serverRailOrderKey } = await import('../components/rail/useServerRailLayout');
const { reconcileRailLayout, serializeRailLayout, flattenServerIds } =
    await import('../components/rail/serverFolders');
type RailLayout = import('../components/rail/serverFolders').RailLayout;

const USER = 'rail-user';
const PW = 'pw-for-test';

beforeAll(() => {
    Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob, electronAPI: undefined });
});
beforeEach(() => {
    mem.clear();
    Object.assign(window, { electronAPI: undefined });
});

/** A rail with two folders interleaved among plain servers:
 *  s3 · [Games: s1,s5 · glow] · s2 · [Work stuff: s6,s4 · uncoloured] · s7 */
const LAYOUT: RailLayout = {
    items: [
        { kind: 'server', id: 's3' },
        { kind: 'folder', folder: { id: 'fGames', name: 'Games', color: 'glow', serverIds: ['s1', 's5'] } },
        { kind: 'server', id: 's2' },
        { kind: 'folder', folder: { id: 'fWork', name: 'Work stuff', color: null, serverIds: ['s6', 's4'] } },
        { kind: 'server', id: 's7' },
    ],
};
const ALL = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'];

/** Write the layout exactly the way useServerRailLayout's persist effect does. */
function saveLayout(layout: RailLayout, uid = USER): void {
    mem.set(`cipherline_server_rail_layout_${uid}`, serializeRailLayout(layout));
    mem.set(`cipherline_server_rail_order_${uid}`, JSON.stringify(flattenServerIds(layout)));
}

async function backupBytes(): Promise<Uint8Array> {
    const plan = await buildBackupPlan(USER, { includeAttachments: false });
    const container = new MemoryContainer();
    const writer = await ContainerWriter.create(PW, container);
    await writeBackupRecords(plan, { fresh: writer });
    await writer.finish({ userId: USER, fingerprint: plan.fingerprint });
    return container.bytes();
}

/** Back up whatever is in `mem`, wipe it (a fresh device), restore the file. */
async function roundTrip(): Promise<void> {
    const bytes = await backupBytes();
    const opened = await openContainer(memorySource(bytes), PW);
    mem.clear();
    await applyBackupContainer(USER, opened);
}

/** Run `fn` with the two rail rules deleted from the registry — i.e. as if the
 *  keys had never been classified `include` — then put them back. */
async function withoutRailRules<T>(fn: () => Promise<T>): Promise<T> {
    const saved = KV_RULES.slice();
    for (let i = KV_RULES.length - 1; i >= 0; i--) {
        if (/cipherline_server_rail_(layout|order)_/.test(KV_RULES[i].pattern)) KV_RULES.splice(i, 1);
    }
    try { return await fn(); } finally { KV_RULES.splice(0, KV_RULES.length, ...saved); }
}

describe('server rail layout survives a real backup + restore', () => {
    it('order, folder names, colours, membership and position come back exactly', async () => {
        saveLayout(LAYOUT);
        const before = loadRailLayout(USER);

        await roundTrip();

        // Byte-identical records on disk...
        expect(mem.get(serverRailLayoutKey(USER))).toBe(serializeRailLayout(LAYOUT));
        expect(mem.get(serverRailOrderKey(USER))).toBe(JSON.stringify(flattenServerIds(LAYOUT)));
        // ...and the rail the hook renders (loader + render-time reconcile) is the same rail.
        const after = loadRailLayout(USER);
        expect(after).toEqual(before);
        expect(after).toEqual(LAYOUT);
        expect(reconcileRailLayout(after, ALL)).toEqual(LAYOUT);
    });

    it('importLocalHistory announces the restore so a running rail re-reads it (BACKUP_RESTORED_EVENT, for this account)', async () => {
        const { BACKUP_RESTORED_EVENT } = await import('./backupRegistry');
        // The suite's `window` is a bare stub (vitest.setup.ts); give it a real event bus for this test.
        const bus = new EventTarget();
        const w = window as unknown as Record<string, unknown>;
        const prev = { add: w.addEventListener, remove: w.removeEventListener, dispatch: w.dispatchEvent };
        w.addEventListener = bus.addEventListener.bind(bus);
        w.removeEventListener = bus.removeEventListener.bind(bus);
        w.dispatchEvent = bus.dispatchEvent.bind(bus);
        const seen: unknown[] = [];
        bus.addEventListener(BACKUP_RESTORED_EVENT, e => { seen.push((e as CustomEvent).detail); });
        try {
            saveLayout(LAYOUT);
            await roundTrip();
        } finally {
            w.addEventListener = prev.add; w.removeEventListener = prev.remove; w.dispatchEvent = prev.dispatch;
        }
        expect(seen).toEqual([{ userId: USER }]);
    });

    it('is stored under the portable {uid} placeholder, never the raw account id', () => {
        saveLayout(LAYOUT);
        const kv = collectIncludedKv(fakeStore, USER);
        expect(Object.keys(kv)).toEqual(expect.arrayContaining([
            'cipherline_server_rail_layout_{uid}', 'cipherline_server_rail_order_{uid}',
        ]));
        expect(Object.keys(kv).some(k => k.includes(USER))).toBe(false);
    });

    it('CONTROL: with the keys unclassified the layout is NOT restored — the test can fail', async () => {
        saveLayout(LAYOUT);
        await withoutRailRules(roundTrip);
        expect(mem.get(serverRailLayoutKey(USER))).toBeUndefined();
        expect(loadRailLayout(USER)).not.toEqual(LAYOUT);
    });

    it('a server left since the backup drops out (and out of its folder); the rest is kept', async () => {
        saveLayout(LAYOUT);
        await roundTrip();
        const rail = reconcileRailLayout(loadRailLayout(USER), ALL.filter(id => id !== 's5' && id !== 's3'));
        expect(rail.items).toEqual([
            // Games had s1+s5; s5 left, so the one-server folder dissolves in place.
            { kind: 'server', id: 's1' },
            { kind: 'server', id: 's2' },
            LAYOUT.items[3],
            { kind: 'server', id: 's7' },
        ]);
    });

    it('a server joined since the backup is appended at the end, outside every folder', async () => {
        saveLayout(LAYOUT);
        await roundTrip();
        const rail = reconcileRailLayout(loadRailLayout(USER), [...ALL, 's9', 's8']);
        expect(rail.items.slice(0, 5)).toEqual(LAYOUT.items);
        expect(rail.items.slice(5)).toEqual([{ kind: 'server', id: 's9' }, { kind: 'server', id: 's8' }]);
    });
});

describe('pre-folder backups (legacy order key only)', () => {
    const LEGACY = JSON.stringify(['s2', 's1', 's3']);

    it('onto a fresh device the legacy order is applied', async () => {
        mem.set(serverRailOrderKey(USER), LEGACY);
        await roundTrip();
        expect(flattenServerIds(reconcileRailLayout(loadRailLayout(USER), ['s1', 's2', 's3']))).toEqual(['s2', 's1', 's3']);
    });

    it('onto a device that already has a v2 layout, the backup\'s order wins (the local layout must not shadow it)', async () => {
        mem.set(serverRailOrderKey(USER), LEGACY);
        const bytes = await backupBytes();
        const opened = await openContainer(memorySource(bytes), PW);
        mem.clear();
        saveLayout(LAYOUT); // a layout this device already had
        await applyBackupContainer(USER, opened);
        expect(mem.get(serverRailLayoutKey(USER))).toBeUndefined();
        expect(flattenServerIds(reconcileRailLayout(loadRailLayout(USER), ['s1', 's2', 's3']))).toEqual(['s2', 's1', 's3']);
    });

    it('CONTROL: applying the kv map without dropShadowingRailLayout leaves the stale local layout in charge', () => {
        saveLayout(LAYOUT);
        const kv = { 'cipherline_server_rail_order_{uid}': LEGACY };
        applyIncludedKv(fakeStore, kv, USER); // what importLocalHistory did before the fix
        expect(flattenServerIds(loadRailLayout(USER))).toEqual(flattenServerIds(LAYOUT)); // restored order ignored
        expect(dropShadowingRailLayout(fakeStore, kv, USER)).toBe(true);
        expect(flattenServerIds(loadRailLayout(USER))).toEqual(['s2', 's1', 's3']);
    });

    it('a backup that has a layout, or no rail keys at all, never touches the local layout', () => {
        saveLayout(LAYOUT);
        expect(dropShadowingRailLayout(fakeStore, { 'cipherline_server_rail_order_{uid}': LEGACY, 'cipherline_server_rail_layout_{uid}': '{}' }, USER)).toBe(false);
        expect(dropShadowingRailLayout(fakeStore, {}, USER)).toBe(false);
        expect(loadRailLayout(USER)).toEqual(LAYOUT);
    });
});

describe('backup-skip-if-unchanged fingerprint', () => {
    const fp = async () => (await buildBackupPlan(USER, { includeAttachments: false })).fingerprint;

    it('is stable for an unchanged rail and moves when ONLY the rail layout changes', async () => {
        saveLayout(LAYOUT);
        const base = await fp();
        expect(await fp()).toBe(base);

        // Rename one folder — nothing else in the vault changes.
        saveLayout({ items: LAYOUT.items.map((it, i) => i === 1 && it.kind === 'folder' ? { kind: 'folder' as const, folder: { ...it.folder, name: 'Gaming' } } : it) });
        expect(await fp()).not.toBe(base);

        // Recolour only.
        saveLayout({ items: LAYOUT.items.map((it, i) => i === 1 && it.kind === 'folder' ? { kind: 'folder' as const, folder: { ...it.folder, color: 'ok' as const } } : it) });
        expect(await fp()).not.toBe(base);

        // Move a plain server one slot — position among servers only.
        saveLayout({ items: [LAYOUT.items[1], LAYOUT.items[0], ...LAYOUT.items.slice(2)] });
        expect(await fp()).not.toBe(base);
    });

    it('CONTROL: with the keys unclassified a rail-only edit leaves the fingerprint unchanged (so this test would catch the regression)', async () => {
        await withoutRailRules(async () => {
            saveLayout(LAYOUT);
            const base = await fp();
            saveLayout({ items: [...LAYOUT.items].reverse() });
            expect(await fp()).toBe(base);
        });
    });
});
