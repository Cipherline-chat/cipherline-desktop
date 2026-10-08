import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Message integrity §2 and §3 (mobile handoff, 2026-09-24) — the DM pull loop.
 *
 * §3: the loop ACKed (a hard DELETE of the server's copy) BEFORE the message
 *     was on disk — setMessagesState, then a 600 ms coalesced persist, then a
 *     300 ms secureLocalStore flush. A crash in that window lost the message.
 * §2: a permanently undecryptable message was ACKed with no trace the user
 *     could see.
 *
 * Same in-memory secureLocalStore stand-in as the backup tests, plus a
 * flushDurable spy that records WHEN the durable flush happened.
 */
const mem = new Map<string, string>();
const events: string[] = [];
let accountReady = true;
let flushShouldFail = false;
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); events.push(`set:${k}`); },
    removeItem: (k: string) => { mem.delete(k); },
    keysWithPrefix: (p: string) => [...mem.keys()].filter(k => k.startsWith(p)),
    hydrateMessages: async () => {},
    whenAccountReady: async () => {},
    isAccountReady: () => accountReady,
    flushDurable: vi.fn(async (keys: string[]) => {
        events.push(`flushDurable:${keys.join(',')}`);
        if (flushShouldFail) throw new Error('1 record(s) were not written to disk — not durable');
    }),
};
vi.mock('./secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

const {
    applyIncomingDmMessages, commitPulledBatch, decryptFailureOutcome, deletedDmTargets, persistIncomingDms,
    undecryptablePlaceholder, UNDECRYPTABLE_KIND, TRANSIENT_STRIKE_LIMIT, isSameAuthor,
} = await import('./dmInbound');
const messageStore = await import('./messageStore');

const UID = 'dm-inbound-user';
const KEY = (cid: string) => `cipherline_msgs_${UID}_${cid}`;
const msg = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, content: { type: 'text', text: id }, sender_device_id: 'dev-B', sender_user_id: 'bob', conversation_id: 'c1', ...extra });
const env = (id: string) => ({ envelope_id: id, conversation_id: 'c1', sent_at_client: '2026-09-24T10:00:00.000Z', sender_device_id: 'dev-B' });

beforeEach(() => {
    mem.clear();
    events.length = 0;
    accountReady = true;
    flushShouldFail = false;
    fakeStore.flushDurable.mockClear();
    messageStore._resetForTest();
});

describe('commitPulledBatch — store, THEN ack', () => {
    const item = (id: string) => ({ envelopeId: id, conversationId: 'c1', message: msg(id) });

    it('acks the stored envelopes only after persist has resolved', async () => {
        const order: string[] = [];
        const r = await commitPulledBatch({
            toStore: [item('e1'), item('e2')],
            ackOnly: ['legacy-1'],
            persist: async () => { order.push('persist:start'); await Promise.resolve(); order.push('persist:done'); },
            ack: async ids => { order.push(`ack:${ids.join(',')}`); return { ok: true }; },
        });
        expect(order).toEqual(['persist:start', 'persist:done', 'ack:legacy-1,e1,e2']);
        expect(r.stored.map(s => s.envelopeId)).toEqual(['e1', 'e2']);
        expect(r.carry).toEqual([]);
    });

    it('a failed persist acks NOTHING it was meant to store, and hands it back to carry', async () => {
        const acked: string[][] = [];
        const r = await commitPulledBatch({
            toStore: [item('e1')],
            ackOnly: ['replay-1'],
            persist: async () => { throw new Error('disk full'); },
            ack: async ids => { acked.push(ids); return { ok: true }; },
        });
        expect(acked).toEqual([['replay-1']]);           // only what needed no storage
        expect(r.carry.map(c => c.envelopeId)).toEqual(['e1']);
        expect(r.stored).toEqual([]);
        expect(String(r.persistError)).toMatch(/disk full/);
    });

    it('does not call ack at all when a failed persist leaves nothing ackable', async () => {
        const ack = vi.fn(async () => ({ ok: true }));
        await commitPulledBatch({ toStore: [item('e1')], ackOnly: [], persist: async () => { throw new Error('x'); }, ack });
        expect(ack).not.toHaveBeenCalled();
    });

    it('reports a failed ack without un-storing anything (the envelopes simply come back)', async () => {
        const r = await commitPulledBatch({
            toStore: [item('e1')], ackOnly: [],
            persist: async () => {},
            ack: async () => ({ ok: false, error: new Error('503') }),
        });
        expect(r.stored.map(s => s.envelopeId)).toEqual(['e1']);
        expect(String(r.ackError)).toMatch(/503/);
    });

    // The received message is shown without first waiting a network round
    // trip for the ACK — but the ACK itself is still never sent before the
    // store has resolved.
    it('awaitAck: false returns once STORED, with the ACK still in flight (and still after the store)', async () => {
        const order: string[] = [];
        let releaseAck!: () => void;
        const ackGate = new Promise<void>(r => { releaseAck = r; });
        const r = await commitPulledBatch({
            toStore: [item('e1')], ackOnly: [],
            persist: async () => { order.push('persist'); },
            ack: async ids => { order.push(`ack:start:${ids.join(',')}`); await ackGate; order.push('ack:done'); return { ok: true }; },
        }, { awaitAck: false });
        expect(order).toEqual(['persist', 'ack:start:e1']);   // returned before the ACK finished
        expect(r.stored.map(s => s.envelopeId)).toEqual(['e1']);
        expect('ackError' in r).toBe(false);
        releaseAck();
        await expect(r.ackDone).resolves.toBeUndefined();
        expect(order).toEqual(['persist', 'ack:start:e1', 'ack:done']);
    });

    it('awaitAck: false still never ACKs what failed to store, and reports a failed ACK via ackDone', async () => {
        const acked: string[][] = [];
        const r = await commitPulledBatch({
            toStore: [item('e1')], ackOnly: ['legacy-1'],
            persist: async () => { throw new Error('disk full'); },
            ack: async ids => { acked.push(ids); return { ok: false, error: new Error('503') }; },
        }, { awaitAck: false });
        expect(String(await r.ackDone)).toMatch(/503/);
        expect(acked).toEqual([['legacy-1']]);
        expect(r.carry.map(c => c.envelopeId)).toEqual(['e1']);
    });
});

describe('persistIncomingDms — merged into the ON-DISK thread and flushed durably', () => {
    it('merges onto what is stored and flushes those records before resolving', async () => {
        mem.set(KEY('c1'), JSON.stringify([msg('old-1'), msg('old-2')]));
        await persistIncomingDms(UID, { c1: [msg('new-1')] });
        expect(JSON.parse(mem.get(KEY('c1'))!).map((m: { id: string }) => m.id)).toEqual(['old-1', 'old-2', 'new-1']);
        // The durable flush covered the thread it wrote, after the write.
        expect(events).toEqual([`set:${KEY('c1')}`, `flushDurable:${KEY('c1')}`]);
    });

    it('rejects when the flush is not durable — the caller must not ack', async () => {
        flushShouldFail = true;
        await expect(persistIncomingDms(UID, { c1: [msg('new-1')] })).rejects.toThrow(/not durable/);
    });

    it('refuses (writes nothing) while the account namespace is not readable', async () => {
        // Merging onto a cold view would write a thread holding ONLY the new
        // message over the real, not-yet-loaded one.
        accountReady = false;
        mem.set(KEY('c1'), JSON.stringify([msg('old-1')]));
        await expect(persistIncomingDms(UID, { c1: [msg('new-1')] })).rejects.toThrow(/not readable/);
        expect(JSON.parse(mem.get(KEY('c1'))!)).toHaveLength(1);
        expect(fakeStore.flushDurable).not.toHaveBeenCalled();
    });

    it('end to end: an undurable persist means the stored envelope is not acked', async () => {
        flushShouldFail = true;
        const ack = vi.fn(async () => ({ ok: true }));
        const r = await commitPulledBatch({
            toStore: [{ envelopeId: 'e1', conversationId: 'c1', message: msg('new-1') }],
            ackOnly: [],
            persist: byConv => persistIncomingDms(UID, byConv),
            ack,
        });
        expect(ack).not.toHaveBeenCalled();
        expect(r.carry.map(c => c.envelopeId)).toEqual(['e1']);
    });
});

describe('decryptFailureOutcome — give up VISIBLY', () => {
    const e = (code: string) => new Error(`Error invoking remote method 'crypto:decrypt-message': Error: [E2EE:${code}] boom`);

    it.each(['NO_RECIPIENT_ENTRY', 'WRAP_AUTH_FAILED', 'CONTENT_AUTH_FAILED', 'SIG_INVALID'])(
        'a permanent %s becomes a placeholder at once', code => {
            expect(decryptFailureOutcome(e(code), 0)).toEqual({ action: 'placeholder', reason: code });
        });

    it('a transient failure is retried, then becomes a placeholder on the last strike', () => {
        expect(decryptFailureOutcome(e('NO_SPK'), 0)).toEqual({ action: 'retry', strikes: 1 });
        expect(decryptFailureOutcome(e('NO_SPK'), TRANSIENT_STRIKE_LIMIT - 2)).toEqual({ action: 'retry', strikes: TRANSIENT_STRIKE_LIMIT - 1 });
        expect(decryptFailureOutcome(e('NO_SPK'), TRANSIENT_STRIKE_LIMIT - 1)).toEqual({ action: 'placeholder', reason: 'NO_SPK' });
        expect(decryptFailureOutcome(new Error('ipc gone'), TRANSIENT_STRIKE_LIMIT - 1))
            .toEqual({ action: 'placeholder', reason: 'retries_exhausted' });
    });

    it('drops only a pre-E2EE LEGACY envelope and a REPLAY', () => {
        expect(decryptFailureOutcome(new Error('LEGACY'), 0)).toEqual({ action: 'drop', why: 'legacy' });
        expect(decryptFailureOutcome(new Error("Error invoking remote method 'x': LEGACY"), 0)).toEqual({ action: 'drop', why: 'legacy' });
        expect(decryptFailureOutcome(e('REPLAY'), 0)).toEqual({ action: 'drop', why: 'replay' });
    });
});

describe('undecryptablePlaceholder', () => {
    it('is a visible system row keyed by the envelope id (a UUID, stable across re-pulls)', () => {
        const p = undecryptablePlaceholder(env('8f0c7a8e-1111-4222-8333-444455556666'), 'SIG_INVALID');
        expect(p).toEqual({
            id: '8f0c7a8e-1111-4222-8333-444455556666',
            content: { type: 'system', kind: UNDECRYPTABLE_KIND, data: { reason: 'SIG_INVALID' } },
            sender_user_id: null,
            sender_device_id: 'dev-B',
            timestamp: '2026-09-24T10:00:00.000Z',
            conversation_id: 'c1',
        });
    });

    it('re-storing it (a retried ack) does not add a second row', () => {
        const p = undecryptablePlaceholder(env('e-1'), 'SIG_INVALID');
        const once = applyIncomingDmMessages({}, { c1: [p] });
        expect(applyIncomingDmMessages(once, { c1: [p] }).c1).toHaveLength(1);
    });
});

describe('applyIncomingDmMessages — one pure merge for disk and state', () => {
    const base = { c1: [msg('m1', { reactions: {} }), msg('m2')] };
    const batch = {
        c1: [
            msg('m3'),
            { id: 'x1', content: { type: 'edit', target_id: 'm1', text: 'edited' }, sender_device_id: 'dev-B' },
            { id: 'x2', content: { type: 'edit', target_id: 'm2', text: 'hijack' }, sender_device_id: 'dev-EVIL' },
            { id: 'x3', content: { type: 'reaction', target_id: 'm1', emoji: '👍', action: 'add' }, sender_device_id: 'dev-C' },
            { id: 'x4', content: { type: 'delete', target_id: 'm2' }, sender_device_id: 'dev-B' },
            { id: 'x5', content: { type: 'pin', target_id: 'm1', action: 'add' } },
            { id: 'x6', content: { type: 'profile_update', avatar_attachment_id: 'a' } },
        ],
    };

    it('applies edits (own device only), reactions, deletes; pins/profile updates add no row', () => {
        const out = applyIncomingDmMessages(base, batch);
        expect(out.c1.map(m => m.id)).toEqual(['m1', 'm3']);
        expect(out.c1[0].content.text).toBe('edited');
        expect(out.c1[0].reactions).toEqual({ '👍': ['dev-C'] });
    });

    it('is idempotent — a carried batch can be merged again safely', () => {
        const once = applyIncomingDmMessages(base, batch);
        expect(applyIncomingDmMessages(once, batch)).toEqual(once);
    });

    it('never mutates its inputs', () => {
        const snapshot = JSON.stringify(base);
        applyIncomingDmMessages(base, batch);
        expect(JSON.stringify(base)).toBe(snapshot);
    });

    // utils/messageOrder.ts: a row carrying the server's timestamp goes where
    // the server put it, not at the end of whatever happened to arrive first.
    it('places a server-stamped row in server order, below the sender\'s own still-sending row', () => {
        const ts = (s: number) => `2026-10-07T12:00:0${s}.000Z`;
        const threads = { c1: [
            msg('a', { server_ts: ts(1) }),
            msg('c', { server_ts: ts(3) }),
            msg('mine', { send_state: 'sending' }),
        ] };
        const out = applyIncomingDmMessages(threads, { c1: [msg('b', { server_ts: ts(2) })] });
        expect(out.c1.map(m => m.id)).toEqual(['a', 'b', 'c', 'mine']);
    });

    it('a row with no server stamp (an older sender path) still appends, as before', () => {
        const out = applyIncomingDmMessages({ c1: [msg('a', { server_ts: '2026-10-07T12:00:05.000Z' })] }, { c1: [msg('z')] });
        expect(out.c1.map(m => m.id)).toEqual(['a', 'z']);
    });
});

/**
 * Multi-device audit (2026-10-03): since sealed sender the pull response has
 * no sender device, so every OTHER member's row was stored with
 * `sender_device_id: ''` — and the old `a.sender_device_id === b.sender_device_id`
 * let any group member edit or delete any other member's message. These use
 * the real stored shapes.
 */
describe('isSameAuthor / edits and deletes in a GROUP', () => {
    const bobRow = { id: 'b1', content: { type: 'text', text: 'bob said' }, sender_device_id: '', sender_user_id: 'bob', conversation_id: 'g1' };
    const carolEdit = { id: 'e1', content: { type: 'edit', target_id: 'b1', text: 'carol rewrote it' }, sender_device_id: '', sender_user_id: 'carol', conversation_id: 'g1' };
    const carolDelete = { id: 'e2', content: { type: 'delete', target_id: 'b1' }, sender_device_id: '', sender_user_id: 'carol', conversation_id: 'g1' };
    const bobEdit = { id: 'e3', content: { type: 'edit', target_id: 'b1', text: 'bob fixed a typo' }, sender_device_id: 'bob-phone', sender_user_id: 'bob', conversation_id: 'g1' };

    it('another member can NOT edit or delete someone else\'s message (the \'\' === \'\' hole)', () => {
        const out = applyIncomingDmMessages({ g1: [bobRow] }, { g1: [carolEdit, carolDelete] });
        expect(out.g1).toHaveLength(1);
        expect(out.g1[0].content.text).toBe('bob said');
        expect(deletedDmTargets({ g1: [bobRow] }, { g1: [carolDelete] })).toEqual([]);
    });

    it('positive control: the old device-only rule let Carol through', () => {
        const oldRule = (t: { sender_device_id: string }, a: { sender_device_id: string }) => t.sender_device_id === a.sender_device_id;
        expect(oldRule(bobRow, carolEdit)).toBe(true);
        expect(isSameAuthor(bobRow, carolEdit)).toBe(false);
    });

    it('the author still can, from any of their devices', () => {
        const out = applyIncomingDmMessages({ g1: [bobRow] }, { g1: [bobEdit] });
        expect(out.g1[0].content.text).toBe('bob fixed a typo');
    });

    it('MY message sent from this desktop can be edited from my phone (both carry this device\'s id here)', () => {
        const mine = { id: 'm1', content: { type: 'text', text: 'hi' }, sender_device_id: 'this-desktop', conversation_id: 'g1' };
        const fromMyPhone = { id: 'e4', content: { type: 'edit', target_id: 'm1', text: 'hi!' }, sender_device_id: 'this-desktop', sender_user_id: 'me', conversation_id: 'g1' };
        expect(applyIncomingDmMessages({ g1: [mine] }, { g1: [fromMyPhone] }).g1[0].content.text).toBe('hi!');
    });

    it('a legacy row with no user ids still needs a NON-EMPTY device match', () => {
        expect(isSameAuthor({ sender_device_id: '' }, { sender_device_id: '' })).toBe(false);
        expect(isSameAuthor({ sender_device_id: 'd1' }, { sender_device_id: 'd1' })).toBe(true);
    });
});

/**
 * deletedDmTargets — the "which pinned-eligible ids will this batch delete"
 * side-channel used to unpin a personally-pinned DM/group message a delete
 * just removed. Must mirror applyIncomingDmMessages's own delete
 * authorization (own-device only) exactly, since it answers "what will that
 * merge do" without duplicating it destructively.
 */
describe('deletedDmTargets', () => {
    const base = { c1: [msg('m1'), msg('m2')] };

    it('reports a delete from the ORIGINAL sender\'s own device', () => {
        const incoming = { c1: [
            { id: 'x1', content: { type: 'delete', target_id: 'm1' }, sender_device_id: 'dev-B' },
        ] };
        expect(deletedDmTargets(base, incoming)).toEqual([{ conversationId: 'c1', targetId: 'm1' }]);
    });

    it('agrees with applyIncomingDmMessages on which id actually gets removed', () => {
        const incoming = { c1: [
            { id: 'x1', content: { type: 'delete', target_id: 'm1' }, sender_device_id: 'dev-B' },
        ] };
        const merged = applyIncomingDmMessages(base, incoming);
        expect(merged.c1.map(m => m.id)).not.toContain('m1');
        expect(deletedDmTargets(base, incoming)).toEqual([{ conversationId: 'c1', targetId: 'm1' }]);
    });

    it('does NOT report a delete forged from a different device than the original sender (hijack attempt)', () => {
        const incoming = { c1: [
            { id: 'x1', content: { type: 'delete', target_id: 'm1' }, sender_device_id: 'dev-EVIL' },
        ] };
        expect(deletedDmTargets(base, incoming)).toEqual([]);
    });

    it('is empty when the delete targets a message that is not cached', () => {
        const incoming = { c1: [
            { id: 'x1', content: { type: 'delete', target_id: 'nonexistent' }, sender_device_id: 'dev-B' },
        ] };
        expect(deletedDmTargets(base, incoming)).toEqual([]);
    });

    it('ignores edits, reactions, pins and plain messages — only deletes are reported', () => {
        const incoming = { c1: [
            msg('m3'),
            { id: 'x1', content: { type: 'edit', target_id: 'm1', text: 'edited' }, sender_device_id: 'dev-B' },
            { id: 'x2', content: { type: 'reaction', target_id: 'm1', emoji: '👍', action: 'add' }, sender_device_id: 'dev-C' },
            { id: 'x3', content: { type: 'pin', target_id: 'm1', action: 'add' } },
        ] };
        expect(deletedDmTargets(base, incoming)).toEqual([]);
    });

    it('handles multiple deletes across conversations in one batch', () => {
        const twoConvBase = { c1: [msg('m1')], c2: [msg('m2', { conversation_id: 'c2' })] };
        const incoming = {
            c1: [{ id: 'x1', content: { type: 'delete', target_id: 'm1' }, sender_device_id: 'dev-B' }],
            c2: [{ id: 'x2', content: { type: 'delete', target_id: 'm2' }, sender_device_id: 'dev-B' }],
        };
        expect(deletedDmTargets(twoConvBase, incoming)).toEqual(
            expect.arrayContaining([
                { conversationId: 'c1', targetId: 'm1' },
                { conversationId: 'c2', targetId: 'm2' },
            ]),
        );
    });

    it('never mutates its inputs', () => {
        const incoming = { c1: [
            { id: 'x1', content: { type: 'delete', target_id: 'm1' }, sender_device_id: 'dev-B' },
        ] };
        const baseSnapshot = JSON.stringify(base);
        const incomingSnapshot = JSON.stringify(incoming);
        deletedDmTargets(base, incoming);
        expect(JSON.stringify(base)).toBe(baseSnapshot);
        expect(JSON.stringify(incoming)).toBe(incomingSnapshot);
    });
});

describe('Dashboard\'s DM pull loop is wired to these rules', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'Dashboard.tsx'), 'utf8');
    const start = src.indexOf('const pullMessagesOnce = React.useCallback');
    const end = src.indexOf('const pullMessages = React.useCallback', start);
    const loop = src.slice(start, end)
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

    it('meta: found the loop', () => {
        expect(start).toBeGreaterThan(0);
        expect(loop).toContain("axios.get(`${API_BASE}/messages/pull`");
    });

    it('ACKs only through commitPulledBatch, with the durable persist', () => {
        expect(loop).toContain('await commitPulledBatch(');
        expect(loop).toContain('persistIncomingDms(userId, byConversation)');
        // The only ackMessageEnvelopes call is the commit's `ack` callback.
        expect(loop.match(/ackMessageEnvelopes\(/g)).toHaveLength(1);
        expect(loop).toMatch(/ack: ids => ackMessageEnvelopes\(/);
        expect(loop).not.toContain('ackIds.push(');
    });

    it('updates UI state AFTER the commit, with the same merge the persist used', () => {
        const commitAt = loop.indexOf('await commitPulledBatch(');
        const stateAt = loop.indexOf('setMessagesState(prev => applyIncomingDmMessages(prev, newMsgsByConv))');
        expect(stateAt).toBeGreaterThan(commitAt);
    });

    it('shows the batch once STORED, then finishes the ACK before the pull returns', () => {
        expect(loop).toContain('}, { awaitAck: false });');
        const stateAt = loop.indexOf('setMessagesState(prev => applyIncomingDmMessages(prev, newMsgsByConv))');
        const ackAt = loop.indexOf('await commit.ackDone');
        expect(ackAt).toBeGreaterThan(stateAt);
        // ...and inside the same pull, so the latch keeps the next pull behind it
        expect(ackAt).toBeLessThan(loop.indexOf("console.error('Polling error:'"));
    });

    it('orders by the server timestamp the pull returns', () => {
        expect(loop).toContain('timestamp: clampFutureTimestamp(env.received_at_server ?? env.sent_at_client),');
        expect(loop).toContain('server_ts: String(env.received_at_server)');
    });

    it('gives up on a decrypt visibly (placeholder), and never re-decrypts a carried envelope', () => {
        expect(loop).toContain('decryptFailureOutcome(');
        expect(loop).toContain('keepPlaceholder(env, outcome.reason)');
        expect(loop).toContain('unpersistedDmRef.current.get(env.envelope_id)');
    });

    it('does not pull before the stored history is in state', () => {
        expect(loop).toContain('if (!dmHistoryLoadedRef.current) return;');
        expect(src).toContain('dmHistoryLoadedRef.current = true;');
    });

    it('unpins a personally-pinned message a delete in this batch just removed, BEFORE the state merge, via the ref (not a direct call)', () => {
        const unpinAt = loop.indexOf('deletedDmTargets(messagesStateRef.current, newMsgsByConv)');
        const stateAt = loop.indexOf('setMessagesState(prev => applyIncomingDmMessages(prev, newMsgsByConv))');
        expect(unpinAt).toBeGreaterThan(0);
        expect(unpinAt).toBeLessThan(stateAt);
        // Must go through the ref, not the function directly — handleUnpinMessage
        // is declared far below this callback and isn't in its deps array.
        expect(loop).toContain('handleUnpinMessageRef.current(conversationId, targetId)');
    });
});

describe('handleOptimisticMessage unpins a sender\'s own deleted pinned message', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'Dashboard.tsx'), 'utf8');
    const start = src.indexOf('const handleOptimisticMessage = React.useCallback');
    const end = src.indexOf('}, [handleUnpinMessage]);', start);
    const fn = src.slice(start, end);

    it('meta: found the function', () => {
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
    });

    it('computes the deleted target id via deletedDmTargets against messagesStateRef, BEFORE setMessagesState — not inside the (pure) updater', () => {
        // A value assigned INSIDE a setState updater and read right after the
        // setState call is not reliable: React does not guarantee the
        // updater runs synchronously during that call (React 19 in
        // particular), so the outer variable can still be null when read.
        // This must be computed up front from the ref, the same technique
        // the sibling pull loop above already uses.
        const computeAt = fn.indexOf('deletedDmTargets(');
        const setStateAt = fn.indexOf('setMessagesState(prev => {');
        expect(computeAt).toBeGreaterThan(0);
        expect(computeAt).toBeLessThan(setStateAt);
        expect(fn).toContain('messagesStateRef.current');
        // The updater itself must stay pure — it may still splice the
        // deleted row out of the thread, but it must never assign to the
        // outer deletedTargetId variable.
        const updaterBody = fn.slice(setStateAt);
        expect(updaterBody).not.toContain('deletedTargetId =');
    });

    it('calls handleUnpinMessage directly (declared above this point) only when the deleted message was pinned, AFTER setMessagesState', () => {
        const setStateAt = fn.lastIndexOf('setMessagesState(prev => {');
        const unpinAt = fn.indexOf('handleUnpinMessage(m.conversation_id, deletedTargetId)');
        expect(unpinAt).toBeGreaterThan(setStateAt);
        expect(fn).toContain('pinnedMessagesStateRef.current[m.conversation_id]?.includes(deletedTargetId)');
    });
});
