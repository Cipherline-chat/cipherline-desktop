import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * History transfer §1 (mobile handoff, 2026-09-24) — DATA LOSS.
 *
 * `importLocalHistory` used to decide the payload's shape with
 * `isWrapped = !!(vault.history && vault.topics)` and treat EVERYTHING else
 * as the ancient pre-wrapper bare dump: `messageStore.clearAll('dm', userId)`,
 * then the raw JSON written into the legacy `cipherline_msgs_<uid>` slot. A
 * mobile vault (`{ v: 5, userId, tables, history, channelHistory, kv }`, no
 * `topics`) took that branch, so a phone → computer transfer or restore
 * CLEARED the desktop's DM history and imported nothing. The bare branch also
 * skipped the account-binding check.
 *
 * The rule these tests pin: the payload is classified and validated
 * COMPLETELY before the first write. Anything refused leaves every byte of
 * local state exactly as it was.
 *
 * Same in-memory secureLocalStore stand-in as backupBinding.test.ts, with the
 * readiness hooks messageStore's reads need.
 */
const mem = new Map<string, string>();
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    keysWithPrefix: (p: string) => [...mem.keys()].filter(k => k.startsWith(p)),
    hydrateMessages: async () => {},
    whenAccountReady: async () => {},
    isAccountReady: () => true,
};
vi.mock('./secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

const { importLocalHistory } = await import('./crypto');

const UID = 'user-A';
const blob = (v: unknown) => new Blob([typeof v === 'string' ? v : JSON.stringify(v)], { type: 'application/json' });

/** What this desktop already has on disk: two DM threads, a conversation list,
 *  and an unrelated setting. None of it may move when an import is refused. */
function seedExistingDesktop(): Map<string, string> {
    mem.set(`cipherline_msgs_${UID}_conv-1`, JSON.stringify([{ id: 'm1', content: { type: 'text', text: 'keep me' } }]));
    mem.set(`cipherline_msgs_${UID}_conv-2`, JSON.stringify([{ id: 'm2', content: { type: 'text', text: 'me too' } }]));
    mem.set(`cipherline_convs_${UID}`, JSON.stringify([{ conversation_id: 'conv-1', type: 'dm' }]));
    mem.set(`cipherline_channel_msgs_${UID}_ch-1`, JSON.stringify([{ id: 'c1' }]));
    mem.set('cipherline_voice_settings', JSON.stringify({ inputGain: 3 }));
    return new Map(mem);
}

/** The shape mobile's backups/transfers produce (cipherline-mobile
 *  src/features/backups/types.ts, VAULT_VERSION = 5). */
const MOBILE_VAULT = {
    v: 5,
    userId: UID,
    createdAt: '2026-09-24T00:00:00.000Z',
    kv: {},
    tables: { conversations: [{ conversation_id: 'conv-9', type: 'dm' }], messages: [] },
    history: { 'conv-9': [{ message_id: 'x', conversation_id: 'conv-9', content_json: '{"type":"text","text":"hi"}' }] },
    channelHistory: {},
};

beforeEach(() => { mem.clear(); });

describe('importLocalHistory — a refused payload changes nothing', () => {
    it('refuses a MOBILE vault with a clear message and leaves existing DM history untouched', async () => {
        const before = seedExistingDesktop();
        await expect(importLocalHistory(UID, blob(MOBILE_VAULT))).rejects.toThrow(/mobile app/i);
        expect(new Map(mem)).toEqual(before);
        // The specific failure: the legacy slot the bare-dump path used to write.
        expect(mem.has(`cipherline_msgs_${UID}`)).toBe(false);
    });

    it('refuses a mobile vault from ANOTHER account without touching anything either', async () => {
        const before = seedExistingDesktop();
        await expect(importLocalHistory(UID, blob({ ...MOBILE_VAULT, userId: 'user-B' }))).rejects.toThrow();
        expect(new Map(mem)).toEqual(before);
    });

    it.each([
        ['invalid JSON', '{"history": {'],
        ['a JSON array', [[{ id: 'm' }]]],
        ['a bare string', 'just text'],
        ['null', null],
        ['an empty object', {}],
        ['history without topics', { userId: UID, history: { a: [] } }],
        ['topics without history', { userId: UID, topics: [] }],
        ['history that is an array', { userId: UID, topics: [], history: [] }],
        ['topics that is not an array', { userId: UID, topics: { a: 1 }, history: {} }],
        ['a history thread that is not an array', { userId: UID, topics: [], history: { 'conv-1': 'nope' } }],
        ['channelHistory that is not an object of arrays', { userId: UID, topics: [], history: {}, channelHistory: { ch: 5 } }],
        ['an object mixing bare-dump arrays with other fields', { 'conv-1': [{ id: 'm' }], note: 'hello' }],
        ['a bare dump with a non-object message', { 'conv-1': ['not a message'] }],
    ])('refuses %s before any write', async (_label, payload) => {
        const before = seedExistingDesktop();
        await expect(importLocalHistory(UID, blob(payload as unknown))).rejects.toThrow();
        expect(new Map(mem)).toEqual(before);
    });

    it('applies the account binding to a wrapped vault BEFORE anything is cleared', async () => {
        const before = seedExistingDesktop();
        await expect(importLocalHistory(UID, blob({ userId: 'user-B', topics: [], history: {} })))
            .rejects.toThrow(/different account/i);
        expect(new Map(mem)).toEqual(before);
    });
});

describe('importLocalHistory — the formats it does accept still import', () => {
    it('a desktop vault replaces DM history authoritatively', async () => {
        seedExistingDesktop();
        await importLocalHistory(UID, blob({
            version: 4, userId: UID,
            topics: [{ conversation_id: 'conv-3', type: 'dm' }],
            history: { 'conv-3': [{ id: 'm3', content: { type: 'text', text: 'restored' } }] },
        }));
        expect(JSON.parse(mem.get(`cipherline_msgs_${UID}_conv-3`)!)).toHaveLength(1);
        // A restore is a replace: a thread absent from the vault does not survive.
        expect(mem.has(`cipherline_msgs_${UID}_conv-1`)).toBe(false);
    });

    it('a genuine pre-wrapper bare dump still restores into the legacy slot', async () => {
        const bareDump = { 'conv-7': [{ id: 'm7', text: 'old' }] };
        await importLocalHistory(UID, blob(bareDump));
        expect(mem.get(`cipherline_msgs_${UID}`)).toBe(JSON.stringify(bareDump));
    });
});

describe('the requesting device says WHY, instead of a generic failure', () => {
    it('the mobile decline reason matches the string the mobile app sends', async () => {
        const { HISTORY_REFUSED_MOBILE_TO_DESKTOP } = await import('./historyRequestProof');
        // cipherline-mobile src/features/history-sync/requesterPlatform.ts,
        // HISTORY_REFUSED_UNSUPPORTED_REQUESTER. A rename on either side must fail here.
        expect(HISTORY_REFUSED_MOBILE_TO_DESKTOP).toBe('requester_cannot_import_mobile_history');
    });

    it('HistorySyncBanner routes a refused payload and the mobile decline to the explained state', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const src = readFileSync(join(__dirname, '..', 'components', 'HistorySyncBanner.tsx'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
        expect(src.length).toBeGreaterThan(1000);
        expect(src).toContain('err instanceof HistoryPayloadRefusedError');
        expect(src).toContain('historyDeclined.reason === HISTORY_REFUSED_MOBILE_TO_DESKTOP');
    });
});
