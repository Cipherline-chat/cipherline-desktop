import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as crypto from 'crypto';
import {
    HISTORY_PAGE_SIZE, aroundSplit, rangeForPage, addCoveredRange, historyGaps, proofWindow, reachesHistoryStart,
    type ChannelCoverage, type CoveredSegment, type HistoryGap, type PageRequest,
} from './channelHistoryCoverage';
import { foldChannelHistory, isUndecryptablePlaceholder, type ChannelRow } from './channelHistoryMerge';
import { splitReusableChannelRows } from './channelRowReuse';
import { findOrphanActions, addOrphans, readyOrphans, applyOrphans } from './channelOrphanActions';
import { classifyChannelDecryptFailure, channelPlaceholderContent, isChannelTombstone, placeholderReason, placeholderWantsKey } from './channelDecryptFailure';
import { pageNeedsKeyRequest } from './channelHistoryRetention';

/**
 * Channel history paging, end to end through the REAL crypto: rows are
 * encrypted by electron/e2ee-engine.ts with real Sender Keys across three
 * epochs and decrypted by the same engine (Ed25519 verify + AES-256-GCM +
 * binding + replay ledger), exactly as `channel:decrypt-message` does. Only
 * SecureStore is stubbed (it imports `electron`) — the channelKeys smoke-test
 * pattern.
 *
 * The server is a faithful in-memory model of GET /v1/channels/:cid/messages
 * (apps/api ChannelMessagesService.listMessages: (created_at, id) order, the
 * newest / before_id / after_id / around / ids modes, the 49/50 around split).
 * The client composes the same pure pieces Dashboard's ingestChannelRows does
 * — row reuse, decrypt, fold, orphan replay, coverage — so what is asserted
 * here is the paging behaviour, with the decrypt COUNT measured for real.
 *
 * Set CL_BENCH=1 to also run the 5,000-message / 3-epoch timing benchmark
 * (it prints a table; the default run uses 600 messages).
 */

const store = new Map<string, string>();
vi.mock('../../electron/storage', () => ({
    secureStore: {
        get: (k: string) => store.get(k) ?? null,
        set: (k: string, v: string) => { store.set(k, v); },
        setDeferred: (k: string, v: string) => { store.set(k, v); },
        setMany: (entries: Record<string, string>) => { for (const [k, v] of Object.entries(entries)) store.set(k, v); },
        delete: (k: string) => { store.delete(k); },
        deleteDeferred: (k: string) => { store.delete(k); },
        batch: <T>(fn: () => T): T => fn(),
        keys: () => [...store.keys()],
    },
}));

type Engine = typeof import('../../electron/e2ee-engine');
type Keys = typeof import('../../electron/channel-keys');

const CH = 'cccccccc-0000-4000-8000-000000000001';
const ALICE_USER = 'aaaaaaaa-0000-4000-8000-000000000001';
const ALICE_DEV = 'aaaaaaaa-0000-4000-8000-0000000000d1';
const ROTATES = new Date(Date.now() + 7 * 24 * 3600 * 1000);
const T0 = Date.parse('2026-09-01T00:00:00.000Z');

interface ServerRow {
    id: string; channel_id: string; epoch: number; nonce_b64: string; ciphertext_b64: string; signature_b64: string;
    sender_identity_pub_b64: string; sender_device_id: string; sender_user_id: string; created_at: string;
}

interface Fixture {
    rows: ServerRow[];          // oldest first
    epochKeys: Record<number, string>;
    pinnedIds: string[];
    /** id of an old message and of the edit (in the newest page) that rewrites it */
    editedTarget: string;
}

const uuidOf = (n: number) => `11111111-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Encrypt `n` messages across 3 epochs with the real engine (Alice sends). */
async function buildChannel(n: number): Promise<Fixture> {
    vi.resetModules();
    store.clear();
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    store.set('identity_priv', Buffer.from((privateKey.export({ format: 'jwk' }) as { d: string }).d, 'base64url').toString('hex'));
    const pub = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('base64');
    store.set('identity_pub', pub);
    const keys: Keys = await import('../../electron/channel-keys');
    const engine: Engine = await import('../../electron/e2ee-engine');

    const epochKeys: Record<number, string> = {};
    const rows: ServerRow[] = [];
    const third = Math.ceil(n / 3);
    // Message 10 is edited by the LAST message: the edit is in the newest page,
    // its target several pages up.
    const editedTarget = uuidOf(10);
    for (let i = 0; i < n; i++) {
        const epoch = 1 + Math.floor(i / third);
        if (!epochKeys[epoch]) {
            epochKeys[epoch] = crypto.randomBytes(32).toString('base64');
            keys.setChannelKey(CH, epoch, epochKeys[epoch], ROTATES);
        }
        const content = i === n - 1
            ? { type: 'edit', target_id: editedTarget, text: 'edited text' }
            : { type: 'text', text: `message ${i}`, client_msg_id: `c-${i}` };
        const enc = engine.encryptChannelMessage(JSON.stringify(content), CH, { user_id: ALICE_USER, device_id: ALICE_DEV });
        rows.push({
            id: uuidOf(i), channel_id: CH, ...enc,
            sender_identity_pub_b64: pub, sender_device_id: ALICE_DEV, sender_user_id: ALICE_USER,
            created_at: new Date(T0 + i * 1000).toISOString(),
        });
    }
    // Pins: one in each epoch, all far older than the newest page.
    const pinnedIds = [uuidOf(3), uuidOf(third + 5), uuidOf(2 * third + 5)];
    return { rows, epochKeys, pinnedIds, editedTarget };
}

/** In-memory GET /v1/channels/:cid/messages. Returns newest-first. */
class FakeApi {
    requests: Array<Record<string, string | number>> = [];
    private readonly rows: ServerRow[];
    private readonly legacy: boolean;
    constructor(rows: ServerRow[], legacy = false) { this.rows = rows; this.legacy = legacy; }
    list(params: Record<string, string | number>): ServerRow[] {
        this.requests.push(params);
        const limit = Math.max(1, Math.min(Number(params.limit ?? 50), 100));
        const all = this.rows; // oldest first == (created_at, id) ascending
        const desc = (xs: ServerRow[]) => [...xs].reverse();
        if (this.legacy) {
            // An API that predates the new modes: honours limit + legacy `before` only.
            const before = params.before ? Date.parse(String(params.before)) : Infinity;
            return desc(all.filter(r => Date.parse(r.created_at) < before)).slice(0, limit);
        }
        if (params.ids) {
            const want = new Set(String(params.ids).split(','));
            return desc(all.filter(r => want.has(r.id)));
        }
        const idx = (id: string) => all.findIndex(r => r.id === id);
        if (params.around) {
            const i = idx(String(params.around));
            if (i === -1) throw Object.assign(new Error('404'), { response: { status: 404 } });
            const s = aroundSplit(limit);
            return desc(all.slice(Math.max(0, i - s.older), i + 1 + s.newer));
        }
        if (params.before_id) {
            const i = idx(String(params.before_id));
            return desc(all.slice(Math.max(0, i - limit), i));
        }
        if (params.after_id) {
            const i = idx(String(params.after_id));
            return desc(all.slice(i + 1, i + 1 + limit));
        }
        return desc(all).slice(0, limit);
    }
}

type Row = ChannelRow & { conversation_id?: string };

/** The client side: Dashboard.ingestChannelRows' pipeline, minus React. */
class Client {
    cache: Row[] = [];
    cov: ChannelCoverage = [];
    orphans: ChannelRow[] = [];
    decrypts = 0;
    private readonly api: FakeApi;
    private readonly engine: Engine;
    constructor(api: FakeApi, engine: Engine) { this.api = api; this.engine = engine; }

    private decrypt(m: ServerRow): Row {
        this.decrypts++;
        try {
            const json = this.engine.decryptChannelMessage({
                channel_id: this.channelId, epoch: m.epoch, nonce_b64: m.nonce_b64, ciphertext_b64: m.ciphertext_b64,
                signature_b64: m.signature_b64, sender_identity_pub_b64: m.sender_identity_pub_b64,
                message_id: m.id, sender_user_id: m.sender_user_id, sender_device_id: m.sender_device_id,
            });
            return { id: m.id, content: JSON.parse(json), sender_user_id: m.sender_user_id, sender_device_id: m.sender_device_id, timestamp: m.created_at };
        } catch (err) {
            // Same classification as Dashboard.decryptChannelRow.
            const reason = classifyChannelDecryptFailure(err, { epoch: m.epoch, latestKnownEpoch: this.latestKnownEpoch, canReadHistory: this.canReadHistory });
            return { id: m.id, content: channelPlaceholderContent(reason, m.epoch), sender_user_id: m.sender_user_id, sender_device_id: m.sender_device_id, timestamp: m.created_at };
        }
    }
    channelId = CH;
    latestKnownEpoch?: number;
    canReadHistory?: boolean;
    /** Off = the pre-fix client (no tombstone handling), for controls. */
    handleTombstones = true;

    ingest(raw: ServerRow[], range?: CoveredSegment | null, requestedAt = Date.now()) {
        // Dashboard.ingestChannelRows: tombstones leave the thread, undecrypted.
        const tombstoned = new Set(this.handleTombstones ? raw.filter(isChannelTombstone).map(r => r.id) : []);
        raw = raw.filter(r => !tombstoned.has(r.id));
        const { reused, toDecrypt } = splitReusableChannelRows(raw, this.cache);
        const sorted = [...reused, ...toDecrypt.map(r => this.decrypt(r))]
            .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
        const pending = addOrphans(this.orphans, findOrphanActions(this.cache, sorted));
        const { ready, waiting } = readyOrphans(pending, [...this.cache, ...sorted]);
        this.orphans = waiting;
        this.cache = applyOrphans(foldChannelHistory(this.cache, sorted, new Set(), proofWindow(range ?? null, requestedAt)), ready)
            .filter(m => !tombstoned.has(m.id));
        if (range) this.cov = addCoveredRange(this.cov, range);
    }

    /** Channel open: ONE newest page, then server-saved rows by id. */
    open(savedIds: string[] = []) {
        const req: PageRequest = { kind: 'newest', limit: HISTORY_PAGE_SIZE };
        const raw = this.api.list({ limit: HISTORY_PAGE_SIZE });
        this.ingest(raw, rangeForPage(req, raw));
        const have = new Set(this.cache.filter(m => !isUndecryptablePlaceholder(m)).map(m => m.id));
        const missing = savedIds.filter(id => !have.has(id));
        if (missing.length) this.ingest(this.api.list({ ids: missing.join(','), limit: 100 }));
    }

    gaps(): HistoryGap[] { return historyGaps(this.cov, this.cache); }

    /** What ChatPane does when a gap scrolls into view. */
    fill(gap: HistoryGap, direction: 'before' | 'after') {
        if (direction === 'before') {
            const cursor = gap.newer!;
            const req: PageRequest = { kind: 'before', limit: HISTORY_PAGE_SIZE, cursor };
            const raw = this.api.list({ limit: HISTORY_PAGE_SIZE, before_id: cursor.id, before: new Date(cursor.ts).toISOString() });
            this.ingest(raw, rangeForPage(req, raw));
        } else {
            const cursor = gap.older!;
            const req: PageRequest = { kind: 'after', limit: HISTORY_PAGE_SIZE, cursor };
            const raw = this.api.list({ limit: HISTORY_PAGE_SIZE, after_id: cursor.id, after: new Date(cursor.ts).toISOString() });
            this.ingest(raw, rangeForPage(req, raw));
        }
    }

    /** Scroll up: fill the older-history gap (the one with no older bound). */
    scrollUp(): boolean {
        const g = this.gaps().find(x => x.older === null);
        if (!g) return false;
        this.fill(g, 'before');
        return true;
    }

    jumpTo(id: string): boolean {
        const req: PageRequest = { kind: 'around', limit: HISTORY_PAGE_SIZE, targetId: id };
        const raw = this.api.list({ around: id, limit: HISTORY_PAGE_SIZE });
        const range = rangeForPage(req, raw);
        if (!range) return false;
        this.ingest(raw, range);
        return true;
    }

    text(id: string): string | undefined {
        return this.cache.find(m => m.id === id)?.content?.text;
    }
}

/** A member that holds the given epochs only (fresh engine state = a restart). */
async function memberEngine(fx: Fixture, epochs: number[]): Promise<{ engine: Engine; keys: Keys }> {
    vi.resetModules();
    for (const k of [...store.keys()]) if (!k.startsWith('identity_')) store.delete(k);
    const keys: Keys = await import('../../electron/channel-keys');
    const engine: Engine = await import('../../electron/e2ee-engine');
    for (const e of epochs) keys.setChannelKey(CH, e, fx.epochKeys[e], ROTATES);
    return { engine, keys };
}

const N = 600;
let fx: Fixture;
beforeAll(async () => { fx = await buildChannel(N); }, 120_000);

describe('channel open decrypts one page, not the history', () => {
    it('open = 1 request, 100 decrypts (+ the saved rows, by id)', async () => {
        const { engine } = await memberEngine(fx, [1, 2, 3]);
        const api = new FakeApi(fx.rows);
        const c = new Client(api, engine);
        c.open(fx.pinnedIds);
        expect(api.requests).toHaveLength(2); // newest page + one ids request
        expect(c.decrypts).toBe(HISTORY_PAGE_SIZE + fx.pinnedIds.length);
        // the newest 100, plus the three pins from far up
        for (const id of fx.pinnedIds) expect(c.text(id)).toMatch(/^message /);
        expect(c.cache.length).toBe(HISTORY_PAGE_SIZE - 1 /* the edit envelope is applied, not stored */ + fx.pinnedIds.length);
        expect(reachesHistoryStart(c.cov)).toBe(false);
    });

    it('control — the pre-paging client (limit=50, no saved-row load) never had the pins', async () => {
        const { engine } = await memberEngine(fx, [1, 2, 3]);
        const api = new FakeApi(fx.rows);
        const old = new Client(api, engine);
        old.ingest(api.list({ limit: 50 }));
        expect(old.decrypts).toBe(50);
        for (const id of fx.pinnedIds) expect(old.text(id)).toBeUndefined();
    });

    it('re-opening reuses cached rows: the second open decrypts only what is new', async () => {
        const { engine } = await memberEngine(fx, [1, 2, 3]);
        const c = new Client(new FakeApi(fx.rows), engine);
        c.open(fx.pinnedIds);
        const first = c.decrypts;
        c.open(fx.pinnedIds);
        // the edit envelope is never cached (applied + dropped), so it is the
        // one row that is decrypted again
        expect(c.decrypts - first).toBe(1);
    });
});

describe('scrolling up pages 100 at a time to the start', () => {
    it('each fill fetches the next older page; ends at the start with every row exactly once', async () => {
        const { engine } = await memberEngine(fx, [1, 2, 3]);
        const api = new FakeApi(fx.rows);
        const c = new Client(api, engine);
        c.open();
        let fills = 0;
        while (c.scrollUp()) fills++;
        // 5 full pages of 100, then — 600 being an exact multiple — one empty
        // page is what proves the start (a FULL page never does).
        expect(fills).toBe((N - HISTORY_PAGE_SIZE) / HISTORY_PAGE_SIZE + 1);
        expect(reachesHistoryStart(c.cov)).toBe(true);
        expect(c.cov).toEqual([{ lo: null, hi: null }]);
        expect(c.gaps()).toEqual([]);
        const ids = c.cache.map(m => m.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.length).toBe(N - 1);
        // every page request was a keyset request from the previous page's oldest row
        for (const r of api.requests.slice(1)) {
            expect(r.limit).toBe(100);
            expect(typeof r.before_id).toBe('string');
        }
        // nothing was decrypted twice
        expect(c.decrypts).toBe(N);
    });

    it('an edit that arrived in the newest page is applied when its target page loads (orphan replay)', async () => {
        const { engine } = await memberEngine(fx, [1, 2, 3]);
        const c = new Client(new FakeApi(fx.rows), engine);
        c.open();
        expect(c.text(fx.editedTarget)).toBeUndefined();
        expect(c.orphans.map(o => (o.content as { target_id: string }).target_id)).toEqual([fx.editedTarget]);
        while (c.scrollUp()) { /* page to the start */ }
        expect(c.text(fx.editedTarget)).toBe('edited text');
        expect(c.cache.find(m => m.id === fx.editedTarget)?.edited).toBe(true);
        expect(c.orphans).toEqual([]);
    });

    it('control — without the orphan store the same edit is lost (the pre-fix behaviour)', async () => {
        const { engine } = await memberEngine(fx, [1, 2, 3]);
        const c = new Client(new FakeApi(fx.rows), engine);
        c.open();
        c.orphans = [];                       // what the old fold did: drop it
        const realIngest = c.ingest.bind(c);
        c.ingest = (raw, range) => { realIngest(raw, range); c.orphans = []; };
        while (c.scrollUp()) { /* page to the start */ }
        expect(c.text(fx.editedTarget)).toBe('message 10');
    });
});

describe('jump to a message far outside the loaded pages', () => {
    it('loads the page around it, leaves a fillable gap, and the gap closes from below', async () => {
        const { engine } = await memberEngine(fx, [1, 2, 3]);
        const api = new FakeApi(fx.rows);
        const c = new Client(api, engine);
        c.open();
        const target = uuidOf(150);
        expect(c.jumpTo(target)).toBe(true);
        expect(c.text(target)).toBe('message 150');
        // two segments now: [101..200] and [500..top]
        expect(c.cov).toHaveLength(2);
        const between = c.gaps().find(g => g.older && g.newer)!;
        expect(between).toBeDefined();
        expect(between.older!.id).toBe(uuidOf(200));
        expect(between.beforeRowId).toBe(uuidOf(N - HISTORY_PAGE_SIZE));
        // scrolling DOWN from the jumped-to page fills with after_id until it merges
        let guard = 0;
        while (c.gaps().some(g => g.older && g.newer) && guard++ < 10) {
            c.fill(c.gaps().find(g => g.older && g.newer)!, 'after');
        }
        expect(c.cov).toHaveLength(1);
        expect(c.cov[0].hi).toBeNull();
        const ids = c.cache.map(m => m.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(api.requests.some(r => 'after_id' in r)).toBe(true);
    });

    it('a jump against an API without `around` loads nothing and claims nothing', async () => {
        const { engine } = await memberEngine(fx, [1, 2, 3]);
        const c = new Client(new FakeApi(fx.rows, /* legacy */ true), engine);
        c.open();
        const before = c.cache.length;
        expect(c.jumpTo(uuidOf(150))).toBe(false);
        expect(c.cache.length).toBe(before);
        expect(c.cov).toHaveLength(1);
    });
});

describe('a pinned message whose epoch key is not held yet', () => {
    it('shows as undecryptable without blocking the page, and heals by id once the key lands', async () => {
        const { engine, keys } = await memberEngine(fx, [2, 3]); // joined after epoch 1
        const api = new FakeApi(fx.rows);
        const c = new Client(api, engine);
        c.open(fx.pinnedIds);
        const oldPin = fx.pinnedIds[0]; // epoch 1
        expect(isUndecryptablePlaceholder(c.cache.find(m => m.id === oldPin))).toBe(true);
        expect(c.text(fx.pinnedIds[1])).toMatch(/^message /);       // epoch 2 pin fine
        expect(c.cache.filter(m => !isUndecryptablePlaceholder(m)).length).toBeGreaterThanOrEqual(HISTORY_PAGE_SIZE - 1);

        keys.setChannelKey(CH, 1, fx.epochKeys[1], ROTATES);       // the key arrives
        const placeholders = c.cache.filter(isUndecryptablePlaceholder).map(m => m.id);
        c.ingest(api.list({ ids: placeholders.join(','), limit: 100 }));
        expect(c.text(oldPin)).toBe('message 3');
        expect(c.cache.filter(isUndecryptablePlaceholder)).toEqual([]);
    });
});

const BENCH = process.env.CL_BENCH === '1';
describe.skipIf(!BENCH)('benchmark — 5,000 messages across 3 epochs (CL_BENCH=1)', () => {
    it('time-to-first-render and decrypt count on open: paged vs full history', async () => {
        const big = await buildChannel(5000);
        const ms = (f: () => void) => { const t = performance.now(); f(); return performance.now() - t; };
        const out: Record<string, unknown>[] = [];

        // BEFORE (old client): newest 50, pins not loaded; every older page is a click.
        {
            const { engine } = await memberEngine(big, [1, 2, 3]);
            const api = new FakeApi(big.rows, /* legacy `before` cursor */ true);
            const c = new Client(api, engine);
            const t = ms(() => c.ingest(api.list({ limit: 50 })));
            out.push({ client: 'before: open (limit 50)', ms: +t.toFixed(1), decrypts: c.decrypts, rows: c.cache.length, cacheKB: Math.round(JSON.stringify(c.cache).length / 1024), pinsLoaded: big.pinnedIds.filter(id => c.text(id)).length });
            // reaching the epoch-1 pin (message 3) meant paging the whole channel 50 at a time
            let pages = 0;
            const t2 = ms(() => {
                let cursor = c.cache[0].timestamp;
                for (;;) {
                    const raw = api.list({ limit: 50, before: cursor });
                    pages++;
                    if (!raw.length) break;
                    c.ingest(raw);
                    cursor = c.cache[0].timestamp;
                    if (raw.length < 50) break;
                }
            });
            out.push({ client: 'before: page to the oldest pin', ms: +t2.toFixed(1), decrypts: c.decrypts, requests: pages + 1, rows: c.cache.length, cacheKB: Math.round(JSON.stringify(c.cache).length / 1024) });
        }
        // AFTER: newest 100 + the pins by id.
        {
            const { engine } = await memberEngine(big, [1, 2, 3]);
            const api = new FakeApi(big.rows);
            const c = new Client(api, engine);
            const t = ms(() => c.open(big.pinnedIds));
            out.push({ client: 'after: open (100 + pins by id)', ms: +t.toFixed(1), decrypts: c.decrypts, requests: api.requests.length, rows: c.cache.length, cacheKB: Math.round(JSON.stringify(c.cache).length / 1024), pinsLoaded: big.pinnedIds.filter(id => c.text(id)).length });
            const t2 = ms(() => c.jumpTo(big.pinnedIds[0]));
            out.push({ client: 'after: jump to oldest pin (around)', ms: +t2.toFixed(1), decrypts: c.decrypts, requests: api.requests.length, rows: c.cache.length });
            // open: 100 + 3 pins; jump around message 3: only 3 rows exist
            // older, 50 newer, and the pin itself is reused from the cache.
            expect(c.decrypts).toBe(100 + 3 + 3 + 50);
        }
        // Reference: decrypting the full history on open (what "prefetch everything" would cost).
        {
            const { engine } = await memberEngine(big, [1, 2, 3]);
            const c = new Client(new FakeApi(big.rows), engine);
            const t = ms(() => c.ingest([...big.rows].reverse()));
            out.push({ client: 'reference: decrypt all 5,000', ms: +t.toFixed(1), decrypts: c.decrypts, rows: c.cache.length, cacheKB: Math.round(JSON.stringify(c.cache).length / 1024) });
        }
        // vitest swallows console here; write the table straight out (and to
        // CL_BENCH_OUT when set).
        const text = out.map(r => JSON.stringify(r)).join('\n') + '\n';
        process.stdout.write(`\n[bench]\n${text}`);
        if (process.env.CL_BENCH_OUT) (await import('fs')).writeFileSync(process.env.CL_BENCH_OUT, text);
    }, 600_000);
});

// ── Owner report 2026-10-09: "waiting on channel keys" rows in readable history ──

const CH_MIX = 'cccccccc-0000-4000-8000-0000000000b2';

interface MixFixture { rows: ServerRow[]; keys: Record<number, string>; }

/**
 * 30 messages under epoch 2 — except the rows a device that MISSED the
 * rotation wrote under its old epoch 1 (the prod pattern: one channel
 * alternating epoch 23 with 18/19 for a day):
 *   row 10  a message (later deleted)          epoch 1
 *   row 15  a message                          epoch 1
 *   row 20  a reaction on row 18               epoch 1
 *   row 25  the delete marker for row 10       epoch 1
 *   row 27  a message deleted by row 28        epoch 2 (readable control)
 */
async function buildMixedChannel(): Promise<MixFixture> {
    vi.resetModules();
    store.clear();
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    store.set('identity_priv', Buffer.from((privateKey.export({ format: 'jwk' }) as { d: string }).d, 'base64url').toString('hex'));
    const pub = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('base64');
    store.set('identity_pub', pub);
    const keys: Keys = await import('../../electron/channel-keys');
    const engine: Engine = await import('../../electron/e2ee-engine');
    const ek: Record<number, string> = { 1: crypto.randomBytes(32).toString('base64'), 2: crypto.randomBytes(32).toString('base64') };
    const stale = new Set([10, 15, 20, 25]);
    const rows: ServerRow[] = [];
    const id = (i: number) => `22222222-0000-4000-8000-${String(i).padStart(12, '0')}`;
    for (let i = 0; i < 30; i++) {
        const epoch = stale.has(i) ? 1 : 2;
        // encryptChannelMessage uses the latest epoch held — hold only `epoch`.
        keys.discardChannelKey(CH_MIX, 1); keys.discardChannelKey(CH_MIX, 2);
        keys.setChannelKey(CH_MIX, epoch, ek[epoch], ROTATES);
        const content = i === 20 ? { type: 'reaction', target_id: id(18), emoji: '👍', action: 'add' }
            : i === 25 ? { type: 'delete', target_id: id(10) }
            : i === 28 ? { type: 'delete', target_id: id(27) }
            : { type: 'text', text: `m${i}`, client_msg_id: `c${i}` };
        const enc = engine.encryptChannelMessage(JSON.stringify(content), CH_MIX, { user_id: ALICE_USER, device_id: ALICE_DEV });
        rows.push({ id: id(i), channel_id: CH_MIX, ...enc, sender_identity_pub_b64: pub, sender_device_id: ALICE_DEV, sender_user_id: ALICE_USER, created_at: new Date(T0 + i * 1000).toISOString() });
    }
    return { rows, keys: ek };
}

const tombstone = (r: ServerRow) => ({ ...r, nonce_b64: '', ciphertext_b64: '', signature_b64: '', deleted: true }) as ServerRow;

async function mixedReader(fx: MixFixture, epochs: number[], serverTombstones: boolean): Promise<{ c: Client; keys: Keys }> {
    vi.resetModules();
    for (const k of [...store.keys()]) if (!k.startsWith('identity_')) store.delete(k);
    const keys: Keys = await import('../../electron/channel-keys');
    const engine: Engine = await import('../../electron/e2ee-engine');
    for (const e of epochs) keys.setChannelKey(CH_MIX, e, fx.keys[e], ROTATES);
    // What the server serves: with the tombstone fix, a delete clears its
    // target's ciphertext (apps/api postMessage 5a).
    const deletedTargets = new Set([fx.rows[10].id, fx.rows[27].id]);
    const served = fx.rows.map(r => serverTombstones && deletedTargets.has(r.id) ? tombstone(r) : r);
    const c = new Client(new FakeApi(served), engine);
    c.channelId = CH_MIX;
    c.latestKnownEpoch = 2;
    c.canReadHistory = true;
    return { c, keys };
}

const pills = (c: Client) => c.cache.filter(isUndecryptablePlaceholder).map(m => Number(m.id.slice(-2)));

describe('rows a stale-epoch device wrote, as a reader holding only the current epoch sees them', () => {
    let mfx: MixFixture;
    beforeAll(async () => { mfx = await buildMixedChannel(); }, 60_000);

    it('ROOT CAUSE (pre-fix data, pre-fix client): pills in the middle — the stale message, reaction, delete marker, and the message it deleted', async () => {
        const { c } = await mixedReader(mfx, [2], false);
        c.handleTombstones = false;
        c.open();
        expect(pills(c)).toEqual([10, 15, 20, 25]);
        expect(c.cache.filter(isUndecryptablePlaceholder).every(placeholderWantsKey)).toBe(true);
        expect(pageNeedsKeyRequest(c.cache, new Set())).toBe(true);
    });

    it('control: a reader who also holds epoch 1 sees no pill, the reaction applied and both deleted messages gone', async () => {
        const { c } = await mixedReader(mfx, [1, 2], false);
        c.handleTombstones = false;
        c.open();
        expect(pills(c)).toEqual([]);
        expect(c.cache.find(m => m.id === mfx.rows[18].id)?.reactions).toEqual({ '👍': [ALICE_USER] });
        expect(c.cache.some(m => m.id === mfx.rows[10].id || m.id === mfx.rows[27].id)).toBe(false);
    });

    it('FIXED: a deleted message disappears WITHOUT any key once the server tombstones it (row 10: neither it nor its marker is readable)', async () => {
        const { c } = await mixedReader(mfx, [2], true);
        c.open();
        expect(c.cache.some(m => m.id === mfx.rows[10].id)).toBe(false);
        expect(c.cache.some(m => m.id === mfx.rows[27].id)).toBe(false);
        expect(c.decrypts).toBe(28); // the 2 tombstones are never decrypted
    });

    it('FIXED: a cached copy of a since-deleted message is removed by the tombstone even though its delete marker is unreadable', async () => {
        const { c } = await mixedReader(mfx, [2], false);
        c.cache = [{ id: mfx.rows[10].id, timestamp: mfx.rows[10].created_at, content: { type: 'text', text: 'm10' } }];
        const served = mfx.rows.map(r => (r.id === mfx.rows[10].id ? tombstone(r) : r));
        c.ingest([...served].reverse());
        expect(c.cache.some(m => m.id === mfx.rows[10].id)).toBe(false);
        // control: the pre-fix client keeps it
        const { c: old } = await mixedReader(mfx, [2], false);
        old.handleTombstones = false;
        old.cache = [{ id: mfx.rows[10].id, timestamp: mfx.rows[10].created_at, content: { type: 'text', text: 'm10' } }];
        old.ingest([...served].reverse());
        expect(old.text(mfx.rows[10].id)).toBe('m10');
    });

    it('the remaining stale rows say why: key_missing (heals by request) — history_restricted for a member without Read Message History', async () => {
        const { c: a } = await mixedReader(mfx, [2], true);
        a.open();
        expect(pills(a)).toEqual([15, 20, 25]);
        expect(a.cache.filter(isUndecryptablePlaceholder).map(placeholderReason)).toEqual(['key_missing', 'key_missing', 'key_missing']);

        const { c: b } = await mixedReader(mfx, [2], true);
        b.canReadHistory = false;
        b.open();
        expect(b.cache.filter(isUndecryptablePlaceholder).map(placeholderReason)).toEqual(['history_restricted', 'history_restricted', 'history_restricted']);
        expect(pageNeedsKeyRequest(b.cache, new Set())).toBe(false);
    });

    it('…and heal by id once epoch 1 arrives: the message shows, the reaction and delete marker apply and vanish', async () => {
        const { c, keys } = await mixedReader(mfx, [2], true);
        c.open();
        keys.setChannelKey(CH_MIX, 1, mfx.keys[1], ROTATES);
        const ids = c.cache.filter(isUndecryptablePlaceholder).map(m => m.id);
        c.ingest(mfx.rows.filter(r => ids.includes(r.id)));
        expect(pills(c)).toEqual([]);
        expect(c.text(mfx.rows[15].id)).toBe('m15');
        expect(c.cache.find(m => m.id === mfx.rows[18].id)?.reactions).toEqual({ '👍': [ALICE_USER] });
        expect(c.cache.some(m => m.id === mfx.rows[20].id || m.id === mfx.rows[25].id)).toBe(false);
    });
});
