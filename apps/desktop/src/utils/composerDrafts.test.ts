import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    createDraftStore, draftKey, draftStorageKey, parseDrafts, serializeDrafts, putDraft, enforceCaps,
    pruneToKnown, MAX_DRAFTS, MAX_DRAFT_CHARS, MAX_TOTAL_CHARS, DRAFT_TTL_MS,
    type DraftBackingStore, type DraftMap,
} from './composerDrafts';
import { classifyKvKey } from '../services/backupRegistry';

/** A stand-in for secureLocalStore: one persistent map ("disk") that outlives
 *  a draft store instance, plus per-account readiness (cold right after sign-in). */
function fakeSecureStore(ready: string[] = []) {
    const disk = new Map<string, string>();
    const readyUsers = new Set(ready);
    const calls = { set: [] as string[], remove: [] as string[] };
    let gate: () => void = () => {};
    let gatePromise: Promise<void> = Promise.resolve();
    const store: DraftBackingStore = {
        getItem: k => disk.get(k) ?? null,
        setItem: (k, v) => { calls.set.push(k); disk.set(k, v); },
        removeItem: k => { calls.remove.push(k); disk.delete(k); },
        isAccountReady: u => readyUsers.has(u),
        whenAccountReady: () => gatePromise,
    };
    return {
        store, disk, calls,
        makeReady: (u: string) => readyUsers.add(u),
        holdReady: () => { gatePromise = new Promise<void>(r => { gate = r; }); },
        releaseReady: () => gate(),
    };
}

const U = 'user-a';
const DM = draftKey('dm', 'conv-1');
const CH = draftKey('ch', 'chan-1');

describe('composer drafts — save / restore per conversation', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('keeps a separate draft per conversation (DM, group, channel) and returns it on re-entry', () => {
        const f = fakeSecureStore([U]);
        const d = createDraftStore({ secureLocalStore: f.store });
        d.set(U, DM, 'hello dm');
        d.set(U, draftKey('dm', 'group-9'), 'hello group');
        d.set(U, CH, 'hello channel', 'srv-1');
        expect(d.get(U, DM)).toBe('hello dm');
        expect(d.get(U, draftKey('dm', 'group-9'))).toBe('hello group');
        expect(d.get(U, CH)).toBe('hello channel');
        // control: a conversation with no draft restores nothing
        expect(d.get(U, draftKey('dm', 'never-typed'))).toBe('');
    });

    it('a DM and a channel that happen to share an id do not collide', () => {
        const f = fakeSecureStore([U]);
        const d = createDraftStore({ secureLocalStore: f.store });
        d.set(U, draftKey('dm', 'same'), 'in the dm');
        d.set(U, draftKey('ch', 'same'), 'in the channel');
        expect(d.get(U, draftKey('dm', 'same'))).toBe('in the dm');
        expect(d.get(U, draftKey('ch', 'same'))).toBe('in the channel');
    });

    it('is cleared when the text is emptied, and when it is whitespace only', () => {
        const f = fakeSecureStore([U]);
        const d = createDraftStore({ secureLocalStore: f.store });
        d.set(U, DM, 'abc');
        d.set(U, DM, '');
        expect(d.get(U, DM)).toBe('');
        d.set(U, DM, 'abc');
        d.set(U, DM, '  \n ');
        expect(d.get(U, DM)).toBe('');
    });

    it('is cleared on send (clear), leaving other conversations alone', () => {
        const f = fakeSecureStore([U]);
        const d = createDraftStore({ secureLocalStore: f.store });
        d.set(U, DM, 'sent now');
        d.set(U, CH, 'keep me', 'srv-1');
        d.clear(U, DM);
        expect(d.get(U, DM)).toBe('');
        expect(d.get(U, CH)).toBe('keep me');
        d.flush();
        expect(parseDrafts(f.disk.get(draftStorageKey(U)))[DM]).toBeUndefined();
        expect(parseDrafts(f.disk.get(draftStorageKey(U)))[CH]?.t).toBe('keep me');
    });

    it('removes the stored record entirely when the last draft goes', () => {
        const f = fakeSecureStore([U]);
        const d = createDraftStore({ secureLocalStore: f.store });
        d.set(U, DM, 'x'); d.flush();
        expect(f.disk.has(draftStorageKey(U))).toBe(true);
        d.set(U, DM, ''); d.flush();
        expect(f.disk.has(draftStorageKey(U))).toBe(false);
    });
});

describe('composer drafts — persistence across restarts', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('a draft written by one session is restored by a brand-new store over the same disk', () => {
        const f = fakeSecureStore([U]);
        const session1 = createDraftStore({ secureLocalStore: f.store });
        session1.set(U, DM, 'half-typed thought');
        session1.set(U, CH, 'channel thought', 'srv-1');
        session1.flush();

        const session2 = createDraftStore({ secureLocalStore: f.store });   // app restart: cold in-memory state
        expect(session2.get(U, DM)).toBe('half-typed thought');
        expect(session2.get(U, CH)).toBe('channel thought');
    });

    it('control: nothing is restored if the first session never flushed to disk', () => {
        const f = fakeSecureStore([U]);
        const session1 = createDraftStore({ secureLocalStore: f.store, debounceMs: 10_000 });
        session1.set(U, DM, 'never reached disk');
        const session2 = createDraftStore({ secureLocalStore: f.store });
        expect(session2.get(U, DM)).toBe('');
    });

    it('the stored record is plaintext-free of anything but the draft map, under the per-account key', () => {
        const f = fakeSecureStore([U]);
        const d = createDraftStore({ secureLocalStore: f.store });
        d.set(U, DM, 'hi'); d.flush();
        expect([...f.disk.keys()]).toEqual([`cipherline_composer_drafts_${U}`]);
    });

    it('tolerates a corrupt record', () => {
        const f = fakeSecureStore([U]);
        f.disk.set(draftStorageKey(U), '{not json');
        const d = createDraftStore({ secureLocalStore: f.store });
        expect(d.get(U, DM)).toBe('');
        d.set(U, DM, 'fresh'); d.flush();
        expect(createDraftStore({ secureLocalStore: f.store }).get(U, DM)).toBe('fresh');
    });

    it('re-reads when the stored record changes underneath the cache (wipe / restore), never writes a stale copy back', () => {
        const f = fakeSecureStore([U]);
        const d = createDraftStore({ secureLocalStore: f.store });
        d.set(U, DM, 'old'); d.flush();
        expect(d.get(U, DM)).toBe('old');
        f.disk.delete(draftStorageKey(U));             // e.g. wipeLocalData
        expect(d.get(U, DM)).toBe('');
        d.set(U, CH, 'new', 'srv-1'); d.flush();
        expect(parseDrafts(f.disk.get(draftStorageKey(U)))[DM]).toBeUndefined();
    });
});

describe('composer drafts — writes are debounced', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('a burst of keystrokes is ONE write, after the quiet period', () => {
        const f = fakeSecureStore([U]);
        const d = createDraftStore({ secureLocalStore: f.store, debounceMs: 400 });
        for (const t of ['h', 'he', 'hel', 'hell', 'hello']) { d.set(U, DM, t); vi.advanceTimersByTime(50); }
        expect(f.calls.set).toHaveLength(0);
        vi.advanceTimersByTime(400);
        expect(f.calls.set).toHaveLength(1);
        expect(parseDrafts(f.disk.get(draftStorageKey(U)))[DM]?.t).toBe('hello');
    });

    it('flush() writes immediately (unmount / window hide)', () => {
        const f = fakeSecureStore([U]);
        const d = createDraftStore({ secureLocalStore: f.store, debounceMs: 400 });
        d.set(U, DM, 'leaving');
        d.flush();
        expect(f.calls.set).toHaveLength(1);
        vi.advanceTimersByTime(1000);
        expect(f.calls.set).toHaveLength(1);           // the timer was cancelled, not a second write
    });

    it('setting the text that is already stored writes nothing (a restored draft is not written back on mount)', () => {
        const f = fakeSecureStore([U]);
        const first = createDraftStore({ secureLocalStore: f.store });
        first.set(U, DM, 'saved'); first.flush();
        f.calls.set.length = 0;

        const second = createDraftStore({ secureLocalStore: f.store });
        const restored = second.get(U, DM);
        second.set(U, DM, restored);                   // what ChatPane's persist effect does on mount
        second.set(U, draftKey('dm', 'other'), '');    // and for an empty conversation
        vi.advanceTimersByTime(5000);
        expect(f.calls.set).toHaveLength(0);
        expect(f.calls.remove).toHaveLength(0);
    });
});

describe('composer drafts — account isolation and the cold-account rule', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('two accounts on one device never see each other’s drafts', () => {
        const f = fakeSecureStore(['user-a', 'user-b']);
        const d = createDraftStore({ secureLocalStore: f.store });
        d.set('user-a', DM, 'a secret');
        d.set('user-b', DM, 'b secret');
        d.flush();
        expect(d.get('user-a', DM)).toBe('a secret');
        expect(d.get('user-b', DM)).toBe('b secret');
        expect([...f.disk.keys()].sort()).toEqual(['cipherline_composer_drafts_user-a', 'cipherline_composer_drafts_user-b']);
        // restart
        const d2 = createDraftStore({ secureLocalStore: f.store });
        expect(d2.get('user-a', DM)).toBe('a secret');
        expect(d2.get('user-b', DM)).toBe('b secret');
        expect(d2.get('user-c', DM)).toBe('');
    });

    it('a COLD account (records still decrypting) reads empty and writes NOTHING — never clobbers real drafts', () => {
        const f = fakeSecureStore([]);                       // not ready
        const real = serializeDrafts({ [DM]: { t: 'real draft', at: Date.now() } });
        f.disk.set(draftStorageKey(U), real);

        const d = createDraftStore({ secureLocalStore: f.store });
        expect(d.get(U, DM)).toBe('');                       // cold read: nothing
        d.set(U, DM, '');                                    // the mount-time persist effect
        d.set(U, CH, 'typed while cold', 'srv-1');
        d.prune(U, { dmIds: new Set(), serverIds: null, channelIdsByServer: {} });
        d.flush();
        vi.advanceTimersByTime(5000);
        expect(f.calls.set).toHaveLength(0);
        expect(f.calls.remove).toHaveLength(0);
        expect(f.disk.get(draftStorageKey(U))).toBe(real);   // untouched

        // …and once the account IS ready, the real draft is there (the cold read was not cached)
        f.makeReady(U);
        expect(d.get(U, DM)).toBe('real draft');
    });

    it('a live rebind: pending writes for an account that is no longer ready are dropped, not written into the new one', () => {
        const f = fakeSecureStore([U]);
        const d = createDraftStore({ secureLocalStore: f.store });
        d.set(U, DM, 'typed just before switching');
        // account switch: U is no longer the ready account
        (f.store as { isAccountReady: (u: string) => boolean }).isAccountReady = (u: string) => u === 'user-b';
        d.flush();
        expect(f.calls.set).toHaveLength(0);
    });
});

describe('composer drafts — bounds and pruning', () => {
    const NOW = 1_800_000_000_000;

    it('caps a single draft', () => {
        const m = putDraft({}, DM, 'x'.repeat(MAX_DRAFT_CHARS + 500), NOW);
        expect(m[DM].t).toHaveLength(MAX_DRAFT_CHARS);
    });

    it('caps the number of drafts, evicting the OLDEST', () => {
        let m: DraftMap = {};
        for (let i = 0; i < MAX_DRAFTS + 10; i++) m = putDraft(m, draftKey('dm', `c${i}`), `t${i}`, NOW + i);
        expect(Object.keys(m)).toHaveLength(MAX_DRAFTS);
        expect(m[draftKey('dm', 'c0')]).toBeUndefined();               // oldest gone
        expect(m[draftKey('dm', `c${MAX_DRAFTS + 9}`)]).toBeDefined(); // newest kept
        // control: under the cap nothing is evicted
        let few: DraftMap = {};
        for (let i = 0; i < 5; i++) few = putDraft(few, draftKey('dm', `c${i}`), `t${i}`, NOW + i);
        expect(Object.keys(few)).toHaveLength(5);
    });

    it('caps the total size of the record', () => {
        let m: DraftMap = {};
        const chunk = 'y'.repeat(MAX_DRAFT_CHARS);
        for (let i = 0; i < 20; i++) m = putDraft(m, draftKey('dm', `big${i}`), chunk, NOW + i);
        const total = Object.values(m).reduce((n, e) => n + e.t.length, 0);
        expect(total).toBeLessThanOrEqual(MAX_TOTAL_CHARS);
        expect(m[draftKey('dm', 'big19')]).toBeDefined();              // the most recent survives
    });

    it('drops drafts nobody came back to (TTL)', () => {
        const m: DraftMap = {
            [DM]: { t: 'ancient', at: NOW - DRAFT_TTL_MS - 1 },
            [CH]: { t: 'recent', at: NOW - 1000, s: 'srv-1' },
        };
        const out = enforceCaps(m, NOW);
        expect(out[DM]).toBeUndefined();
        expect(out[CH]).toBeDefined();
    });

    it('parse drops malformed entries and foreign keys, keeps good ones', () => {
        const raw = JSON.stringify({ v: 1, d: {
            [DM]: { t: 'ok', at: 5 },
            'dm:blank': { t: '   ', at: 5 },
            'dm:nots': { t: 'x' },
            'zz:other': { t: 'x', at: 1 },
            [CH]: 'not an object',
        } });
        expect(Object.keys(parseDrafts(raw))).toEqual([DM]);
        expect(parseDrafts(null)).toEqual({});
        expect(parseDrafts('[]')).toEqual({});
    });

    describe('pruneToKnown — conversations the account no longer has', () => {
        const drafts: DraftMap = {
            [draftKey('dm', 'kept-dm')]: { t: 'a', at: 1 },
            [draftKey('dm', 'removed-dm')]: { t: 'b', at: 1 },
            [draftKey('ch', 'kept-ch')]: { t: 'c', at: 1, s: 'srv-1' },
            [draftKey('ch', 'deleted-ch')]: { t: 'd', at: 1, s: 'srv-1' },
            [draftKey('ch', 'left-srv-ch')]: { t: 'e', at: 1, s: 'srv-gone' },
            [draftKey('ch', 'unloaded-srv-ch')]: { t: 'f', at: 1, s: 'srv-2' },
        };
        const known = {
            dmIds: new Set(['kept-dm']),
            serverIds: new Set(['srv-1', 'srv-2']),
            channelIdsByServer: { 'srv-1': new Set(['kept-ch']), 'srv-2': null },
        };

        it('removes removed DMs, deleted channels and channels of left servers; keeps the rest', () => {
            expect(Object.keys(pruneToKnown(drafts, known)).sort()).toEqual([
                draftKey('ch', 'kept-ch'), draftKey('ch', 'unloaded-srv-ch'), draftKey('dm', 'kept-dm'),
            ].sort());
        });

        it('control: when nothing is loaded yet NOTHING is pruned', () => {
            const none = pruneToKnown(drafts, { dmIds: null, serverIds: null, channelIdsByServer: {} });
            expect(Object.keys(none)).toHaveLength(Object.keys(drafts).length);
        });

        it('a channel list that is not loaded keeps that server’s drafts', () => {
            const out = pruneToKnown(drafts, { ...known, channelIdsByServer: { 'srv-1': undefined, 'srv-2': null } });
            expect(out[draftKey('ch', 'deleted-ch')]).toBeDefined();
        });
    });

    it('store.prune persists the pruned set', () => {
        vi.useFakeTimers();
        try {
            const f = fakeSecureStore([U]);
            const d = createDraftStore({ secureLocalStore: f.store });
            d.set(U, draftKey('dm', 'gone'), 'x');
            d.set(U, draftKey('dm', 'here'), 'y');
            d.flush();
            d.prune(U, { dmIds: new Set(['here']), serverIds: null, channelIdsByServer: {} });
            d.flush();
            const restarted = createDraftStore({ secureLocalStore: f.store });
            expect(restarted.get(U, draftKey('dm', 'gone'))).toBe('');
            expect(restarted.get(U, draftKey('dm', 'here'))).toBe('y');
        } finally { vi.useRealTimers(); }
    });
});

describe('composer drafts — backup classification', () => {
    it('the draft record is EXCLUDED from backups (device-local plaintext convenience)', () => {
        expect(classifyKvKey(draftStorageKey(U), U)).toBe('exclude');
    });
});

describe('ChatPane wiring', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'ChatPane.tsx'), 'utf8');
    const dash = readFileSync(join(__dirname, '..', 'components', 'Dashboard.tsx'), 'utf8');

    it('seeds the composer from the saved draft for THIS conversation, synchronously', () => {
        expect(src).toContain('composerDrafts.get(draftUserId, draftConvKey)');
        expect(src).toMatch(/const \[inputText, setInputText\] = useState\(\(\) =>/);
        expect(src).toContain("draftKey('ch', activeChannel.channel_id)");
        expect(src).toContain("draftKey('dm', activeChat.id)");
    });

    it('persists on change, but NOT while an edit is open (that text is not a draft)', () => {
        const eff = src.slice(src.indexOf('// ── Draft persistence'), src.indexOf('// Leaving the conversation (unmount)'));
        expect(eff).toContain('if (!draftUserId || !draftConvKey || editingId) return;');
        expect(eff).toContain('composerDrafts.set(draftUserId, draftConvKey, inputText');
    });

    it('flushes on unmount and picks a draft up after a cold sign-in', () => {
        expect(src).toContain('useEffect(() => () => composerDrafts.flush(), []);');
        expect(src).toContain('composerDrafts.whenReady()');
        expect(src).toContain('setInputText(prev => (prev === \'\' ? saved : prev));');
    });

    it('Reply no longer blanks the composer (it used to silently eat the draft)', () => {
        const reply = src.slice(src.indexOf('const beginReply = (id: string) =>'), src.indexOf('/** Abandon the in-progress edit'));
        expect(reply).not.toContain("setInputText('')");
        expect(src).not.toMatch(/onClick=\{\(\) => \{ setEditingId\(null\); setInputText\(''\); setReplyingId/);
        expect(src).toContain('onSelect: () => beginReply(msg.id),');
        expect(src).toContain('onClick={() => beginReply(msg.id)}');
    });

    it('a finished edit hands the box back to the pre-edit draft instead of clearing it', () => {
        expect(src).toContain('const resumeDraft = editingId ? preEditDraftRef.current : \'\';');
        expect(src).toContain('setInputText(resumeDraft);');
    });

    it('memoized rows reach beginReply through the live-callback stand-ins (no stale editingId)', () => {
        expect(src.match(/requestDelete, startEdit, beginReply,/g)).toHaveLength(2);
    });

    it('Dashboard prunes drafts against the loaded conversation / server lists', () => {
        expect(dash).toContain('useComposerDraftPrune(userId, {');
    });
});

describe('composer drafts — DM / group lifecycle through the prune (regression)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('type in a DM and a group, switch quickly, list loads (prune), restart: both drafts are still there', async () => {
        const { buildKnownConversations } = await import('../hooks/useComposerDraftPrune');
        const f = fakeSecureStore([U]);
        const d = createDraftStore({ secureLocalStore: f.store });
        // Dashboard's rows are keyed `conversation_id`.
        const rows = [{ conversation_id: 'conv-1', type: 'dm' }, { conversation_id: 'group-9', type: 'group' }];
        d.set(U, draftKey('dm', 'conv-1'), 'half a thought');
        d.flush();                                                  // leave conv-1 (unmount)
        d.set(U, draftKey('dm', 'group-9'), 'group draft');
        d.flush();                                                  // leave the group within 400 ms
        d.prune(U, buildKnownConversations({ conversations: rows, servers: [], serverChannels: {}, serversLoaded: false }));
        d.flush();
        expect(d.get(U, draftKey('dm', 'conv-1'))).toBe('half a thought');
        expect(d.get(U, draftKey('dm', 'group-9'))).toBe('group draft');
        const restarted = createDraftStore({ secureLocalStore: f.store });
        expect(restarted.get(U, draftKey('dm', 'conv-1'))).toBe('half a thought');
        expect(restarted.get(U, draftKey('dm', 'group-9'))).toBe('group draft');
        expect(restarted.keys(U).sort()).toEqual([draftKey('dm', 'conv-1'), draftKey('dm', 'group-9')]);
    });

    it('typing notifies subscribers (the list preview) and sending/clearing removes the draft', () => {
        const f = fakeSecureStore([U]);
        const d = createDraftStore({ secureLocalStore: f.store });
        const seen: string[] = [];
        d.subscribe(() => seen.push(d.get(U, DM)));
        d.set(U, DM, 'typing');
        d.set(U, DM, '');
        expect(seen).toEqual(['typing', '']);
        expect(d.keys(U)).toEqual([]);
    });

    it('Dashboard feeds the prune with its real row shape (conversation_id)', () => {
        const dash = readFileSync(join(__dirname, '..', 'components', 'Dashboard.tsx'), 'utf8');
        const hook = readFileSync(join(__dirname, '..', 'hooks', 'useComposerDraftPrune.ts'), 'utf8');
        expect(dash).toContain('c.conversation_id === ');
        expect(hook).toContain('c.conversation_id');
        expect(hook).not.toMatch(/map\(c => c\.id\)/);
    });
});
