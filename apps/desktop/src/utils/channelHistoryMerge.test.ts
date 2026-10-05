import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    foldChannelHistory,
    isUndecryptablePlaceholder,
    coveredServerWindow,
    pruneVanishedPlaceholders,
    deletedChannelTargetIds,
    type ChannelRow,
} from './channelHistoryMerge';

/** Build a plain text row. `t` is minutes-since-epoch, so ordering is readable. */
const msg = (id: string, t: number, text = id): ChannelRow => ({
    id,
    timestamp: new Date(t * 60_000).toISOString(),
    sender_user_id: 'u1',
    content: { type: 'text', text },
});

/** Build the "couldn't decrypt" placeholder the history/poll paths cache. */
const placeholder = (id: string, t: number): ChannelRow => ({
    id,
    timestamp: new Date(t * 60_000).toISOString(),
    sender_user_id: 'u1',
    content: { type: 'system', kind: 'encrypted' },
});

const ids = (rows: ChannelRow[]) => rows.map(r => r.id);
const textOf = (rows: ChannelRow[], id: string) =>
    (rows.find(r => r.id === id)?.content as { text?: string } | undefined)?.text;

describe('isUndecryptablePlaceholder', () => {
    it('matches only system/encrypted rows', () => {
        expect(isUndecryptablePlaceholder(placeholder('a', 1))).toBe(true);
        expect(isUndecryptablePlaceholder(msg('a', 1))).toBe(false);
        // A plain system row (joined/left) is NOT a placeholder.
        expect(isUndecryptablePlaceholder({ content: { type: 'system', text: 'joined' } })).toBe(false);
        expect(isUndecryptablePlaceholder(null)).toBe(false);
        expect(isUndecryptablePlaceholder(undefined)).toBe(false);
        expect(isUndecryptablePlaceholder({})).toBe(false);
    });
});

describe('foldChannelHistory', () => {
    it('returns the cache unchanged when the server contributes nothing new', () => {
        const existing = [msg('a', 1), msg('b', 2)];
        expect(ids(foldChannelHistory(existing, [msg('a', 1), msg('b', 2)]))).toEqual(['a', 'b']);
    });

    it('does not mutate its arguments', () => {
        const existing = [msg('a', 1)];
        const incoming = [msg('b', 2)];
        foldChannelHistory(existing, incoming);
        expect(ids(existing)).toEqual(['a']);
        expect(ids(incoming)).toEqual(['b']);
    });

    /**
     * The invariant that makes the envelopes-ready handler safe: the catch-up
     * fetch only ever returns the server's newest 50 rows, so folding it onto a
     * longer local cache must keep every older row. Dropping the cache first
     * (what the handler used to do) destroyed exactly these.
     */
    it('keeps locally-cached history the server no longer returns', () => {
        const existing = Array.from({ length: 120 }, (_, i) => msg(`m${i}`, i));
        const serverNewest50 = existing.slice(70);
        const out = foldChannelHistory(existing, serverNewest50);
        expect(out).toHaveLength(120);
        expect(ids(out)).toEqual(ids(existing));
    });

    it('inserts genuinely new rows and keeps the thread chronological', () => {
        const existing = [msg('a', 1), msg('c', 3)];
        const out = foldChannelHistory(existing, [msg('d', 4), msg('b', 2)]);
        expect(ids(out)).toEqual(['a', 'b', 'c', 'd']);
    });

    /**
     * The heal path. This is why the envelopes-ready handler does not need to
     * empty the cache before re-fetching: once the Sender Key lands, the same
     * ids come back decrypted and replace the placeholders in place.
     */
    it('upgrades a cached placeholder when a decrypted copy of the same id arrives', () => {
        const existing = [msg('a', 1), placeholder('b', 2), placeholder('c', 3)];
        const out = foldChannelHistory(existing, [msg('b', 2, 'hello'), msg('c', 3, 'world')]);

        expect(ids(out)).toEqual(['a', 'b', 'c']);
        expect(out.every(r => !isUndecryptablePlaceholder(r))).toBe(true);
        expect(textOf(out, 'b')).toBe('hello');
        expect(textOf(out, 'c')).toBe('world');
    });

    it('leaves a cached placeholder alone when the incoming copy is also undecryptable', () => {
        const existing = [placeholder('b', 2)];
        const out = foldChannelHistory(existing, [placeholder('b', 2)]);
        expect(out).toHaveLength(1);
        expect(isUndecryptablePlaceholder(out[0])).toBe(true);
    });

    it('never downgrades an already-decrypted row back to a placeholder', () => {
        const existing = [msg('b', 2, 'real')];
        const out = foldChannelHistory(existing, [placeholder('b', 2)]);
        expect(out).toHaveLength(1);
        expect(textOf(out, 'b')).toBe('real');
    });

    it('applies an edit to its target and drops the edit envelope', () => {
        const existing = [msg('a', 1, 'before')];
        const out = foldChannelHistory(existing, [
            { id: 'e1', timestamp: new Date(5 * 60_000).toISOString(), content: { type: 'edit', target_id: 'a', text: 'after' } },
        ]);
        expect(ids(out)).toEqual(['a']);
        expect(textOf(out, 'a')).toBe('after');
        expect(out[0].edited).toBe(true);
    });

    it('applies a delete and drops the delete envelope', () => {
        const existing = [msg('a', 1), msg('b', 2)];
        const out = foldChannelHistory(existing, [
            { id: 'd1', timestamp: new Date(5 * 60_000).toISOString(), content: { type: 'delete', target_id: 'a' } },
        ]);
        expect(ids(out)).toEqual(['b']);
    });

    it('adds and removes reactions, pruning empty emoji buckets', () => {
        const existing = [msg('a', 1)];
        const add = foldChannelHistory(existing, [{
            id: 'r1', timestamp: new Date(5 * 60_000).toISOString(), sender_user_id: 'u2',
            content: { type: 'reaction', target_id: 'a', emoji: '👍', action: 'add' },
        }]);
        expect(add[0].reactions).toEqual({ '👍': ['u2'] });

        const remove = foldChannelHistory(add, [{
            id: 'r2', timestamp: new Date(6 * 60_000).toISOString(), sender_user_id: 'u2',
            content: { type: 'reaction', target_id: 'a', emoji: '👍', action: 'remove' },
        }]);
        expect(remove[0].reactions).toEqual({});
    });

    it('does not double-add the same reactor', () => {
        const existing = [msg('a', 1)];
        const once = foldChannelHistory(existing, [{
            id: 'r1', timestamp: new Date(5 * 60_000).toISOString(), sender_user_id: 'u2',
            content: { type: 'reaction', target_id: 'a', emoji: '🎉', action: 'add' },
        }]);
        const twice = foldChannelHistory(once, [{
            id: 'r2', timestamp: new Date(6 * 60_000).toISOString(), sender_user_id: 'u2',
            content: { type: 'reaction', target_id: 'a', emoji: '🎉', action: 'add' },
        }]);
        expect(twice[0].reactions).toEqual({ '🎉': ['u2'] });
    });

    it('resolves action envelopes that target a client_msg_id', () => {
        const existing: ChannelRow[] = [{
            id: 'server-id-1',
            timestamp: new Date(60_000).toISOString(),
            content: { type: 'text', text: 'before', client_msg_id: 'client-1' },
        }];
        const out = foldChannelHistory(existing, [
            { id: 'e1', timestamp: new Date(5 * 60_000).toISOString(), content: { type: 'edit', target_id: 'client-1', text: 'after' } },
        ]);
        expect(textOf(out, 'server-id-1')).toBe('after');
    });

    it('is idempotent — folding the same batch twice changes nothing', () => {
        const existing = [msg('a', 1), placeholder('b', 2)];
        const incoming = [msg('b', 2, 'hi'), msg('c', 3)];
        const once = foldChannelHistory(existing, incoming);
        const twice = foldChannelHistory(once, incoming);
        expect(twice).toEqual(once);
    });

    /**
     * The end-to-end shape of the bug this fix addresses: an envelopes-ready
     * event used to empty the cache and re-fetch. Folding straight onto the
     * cache reaches the same healed result with no empty intermediate state
     * and without losing the rows outside the server's window.
     */
    it('heals a keyless channel without an empty intermediate state', () => {
        const cached = [msg('old', 1), placeholder('p1', 2), placeholder('p2', 3)];
        // Server returns only what it still holds — the two now-decryptable rows.
        const refetched = [msg('p1', 2, 'decrypted one'), msg('p2', 3, 'decrypted two')];

        const healed = foldChannelHistory(cached, refetched);
        expect(ids(healed)).toEqual(['old', 'p1', 'p2']);
        expect(healed.some(isUndecryptablePlaceholder)).toBe(false);

        // What the old drop-then-refetch did instead: 'old' is gone for good.
        const afterDrop = foldChannelHistory([], refetched);
        expect(ids(afterDrop)).toEqual(['p1', 'p2']);
    });
});

/**
 * The retention-resurrection bug (owner report: "when your message retention
 * deletes any sort of attachment, the server will just say that it doesn't
 * have encryption keys for it rather than it just disappearing from the chat").
 *
 * Absence from `existing` is ambiguous — "never seen" vs "seen and deliberately
 * deleted" — and this reducer could only read it as the first, so a server
 * channel handed every retention-purged message back on the next fetch. Once
 * the epoch's Sender Key had aged out too (channel-keys.ts pruneOldKeys, 30d),
 * it came back as the `system`/`encrypted` placeholder, i.e. "Couldn't decrypt
 * — waiting on this channel's key". `purgedIds` is what disambiguates.
 */
describe('foldChannelHistory — retention purge ledger', () => {
    it('does not re-insert a message the local retention sweep purged', () => {
        const existing = [msg('a', 1), msg('c', 3)];
        // The server still holds 'b' — retention only deleted the local copy.
        const out = foldChannelHistory(existing, [msg('b', 2), msg('c', 3)], new Set(['b']));
        expect(ids(out)).toEqual(['a', 'c']);
    });

    it('does not resurrect a purged attachment message as the key-missing placeholder', () => {
        // Exactly the reported symptom: the attachment message was purged, its
        // epoch key has since been pruned, so the re-fetched row decrypts to
        // the placeholder. Without the ledger this lands in the thread.
        const existing = [msg('a', 1)];
        const refetched = [placeholder('att', 2)];

        expect(ids(foldChannelHistory(existing, refetched))).toEqual(['a', 'att']);
        expect(ids(foldChannelHistory(existing, refetched, new Set(['att'])))).toEqual(['a']);
    });

    it('purge wins over the placeholder-upgrade path', () => {
        // A stale placeholder for a purged id can still sit in the cache (the
        // sweep dropped the decrypted row on one pass; a later fetch cached a
        // placeholder before the ledger was consulted). A decrypted copy must
        // not re-seat it as real content.
        const existing = [msg('a', 1), placeholder('b', 2)];
        const out = foldChannelHistory(existing, [msg('b', 2, 'decrypted')], new Set(['b']));
        expect(isUndecryptablePlaceholder(out.find(r => r.id === 'b'))).toBe(true);
    });

    it('still applies an edit envelope aimed at a NON-purged message', () => {
        const existing = [msg('a', 1, 'before')];
        const out = foldChannelHistory(
            existing,
            [
                { id: 'e1', timestamp: new Date(2 * 60_000).toISOString(), content: { type: 'edit', target_id: 'a', text: 'after' } },
                msg('gone', 3),
            ],
            new Set(['gone']),
        );
        expect(ids(out)).toEqual(['a']);
        expect(textOf(out, 'a')).toBe('after');
    });

    it('an empty ledger behaves exactly like the two-argument call', () => {
        const existing = [msg('a', 1)];
        const incoming = [msg('b', 2), placeholder('c', 3)];
        expect(ids(foldChannelHistory(existing, incoming, new Set())))
            .toEqual(ids(foldChannelHistory(existing, incoming)));
    });
});

/**
 * Server-side deletion vs. "I can't decrypt this" (owner report: "messages that
 * were deleted by the server and when someone joins it says that it couldn't
 * decrypt the message, even though it is not there on the server").
 *
 * These are two genuinely different states and they must not share a rendering:
 *
 *   ciphertext exists, key missing  →  the pill is CORRECT, and asking other
 *                                      members for the epoch key is worth doing.
 *   ciphertext gone server-side     →  there is nothing to decrypt, ever. No
 *                                      pill, no key request.
 *
 * The server has no tombstone for the second case — `cleanup.service.ts`
 * `sweepExpiredChannelMessages` runs `DELETE FROM channel_messages WHERE
 * expires_at < NOW()`, so the row simply stops being returned. Absence inside a
 * window the response fully covers is therefore the ONLY available signal, and
 * `coveredServerWindow` is what makes that absence provable rather than
 * ambiguous: the endpoint is `ORDER BY created_at DESC LIMIT n`, so what comes
 * back is a contiguous run with no interior gaps.
 */
describe('coveredServerWindow', () => {
    it('spans from the oldest returned row up to now for a newest-page fetch', () => {
        expect(coveredServerWindow([msg('b', 20), msg('a', 10), msg('c', 30)]))
            .toEqual({ fromTs: 10 * 60_000, toTs: Infinity });
    });

    it('caps the window at the `before=` cursor for a paginated fetch', () => {
        const before = new Date(50 * 60_000).toISOString();
        expect(coveredServerWindow([msg('a', 10), msg('b', 20)], before))
            .toEqual({ fromTs: 10 * 60_000, toTs: 50 * 60_000 });
    });

    it('treats an EMPTY response as total coverage, not zero coverage', () => {
        // The query asked for the newest rows in the range and got none, so the
        // server holds nothing in it at all — the strongest possible answer.
        expect(coveredServerWindow([])).toEqual({ fromTs: -Infinity, toTs: Infinity });
        expect(coveredServerWindow([], new Date(50 * 60_000).toISOString()))
            .toEqual({ fromTs: -Infinity, toTs: 50 * 60_000 });
    });

    it('ignores an unparseable `before=` rather than collapsing the window', () => {
        expect(coveredServerWindow([msg('a', 10)], 'not-a-date'))
            .toEqual({ fromTs: 10 * 60_000, toTs: Infinity });
        expect(coveredServerWindow([msg('a', 10)], null))
            .toEqual({ fromTs: 10 * 60_000, toTs: Infinity });
    });
});

describe('pruneVanishedPlaceholders — deleted vs. undecryptable', () => {
    const win = (fromMin: number, toMin: number) => ({
        fromTs: fromMin === -Infinity ? -Infinity : fromMin * 60_000,
        toTs: toMin === Infinity ? Infinity : toMin * 60_000,
    });

    it('drops a cached pill the server no longer returns inside the window', () => {
        const rows = [msg('a', 10), placeholder('gone', 20), msg('c', 30)];
        const out = pruneVanishedPlaceholders(rows, new Set(['a', 'c']), win(10, Infinity));
        expect(ids(out)).toEqual(['a', 'c']);
    });

    it('KEEPS a pill the server DID return — that is a live key gap', () => {
        // The whole point of the pill. Weakening this would hide real
        // "waiting on this channel's key" state and stop the key request.
        const rows = [msg('a', 10), placeholder('locked', 20)];
        const out = pruneVanishedPlaceholders(rows, new Set(['a', 'locked']), win(10, Infinity));
        expect(ids(out)).toEqual(['a', 'locked']);
    });

    it('KEEPS a decrypted row the server no longer returns', () => {
        // The local cache is deliberately allowed to outlive the server's
        // 30-day channel retention. Only contentless pills are prunable.
        const rows = [msg('kept', 20), placeholder('gone', 21)];
        const out = pruneVanishedPlaceholders(rows, new Set(), win(10, Infinity));
        expect(ids(out)).toEqual(['kept']);
    });

    it('KEEPS a pill older than the window — the page just did not reach it', () => {
        const rows = [placeholder('older', 5), placeholder('inside', 20)];
        const out = pruneVanishedPlaceholders(rows, new Set(), win(10, Infinity));
        expect(ids(out)).toEqual(['older']);
    });

    it('KEEPS a pill at or past the exclusive upper bound', () => {
        // toTs is the `before=` cursor: rows at/after it were never queried.
        const rows = [placeholder('at-bound', 50), placeholder('above', 60), placeholder('inside', 49)];
        const out = pruneVanishedPlaceholders(rows, new Set(), win(10, 50));
        expect(ids(out)).toEqual(['at-bound', 'above']);
    });

    it('is a no-op without a window', () => {
        const rows = [msg('a', 10), placeholder('p', 20)];
        expect(ids(pruneVanishedPlaceholders(rows, new Set(), null))).toEqual(['a', 'p']);
        expect(ids(pruneVanishedPlaceholders(rows, new Set(), undefined))).toEqual(['a', 'p']);
    });

    it('leaves a row with an unparseable timestamp alone', () => {
        const broken: ChannelRow = {
            id: 'broken',
            timestamp: 'nonsense',
            content: { type: 'system', kind: 'encrypted' },
        };
        expect(ids(pruneVanishedPlaceholders([broken], new Set(), win(-Infinity, Infinity))))
            .toEqual(['broken']);
    });
});

describe('foldChannelHistory — server-deleted placeholders', () => {
    it('evicts the stale pill for a message the retention sweep removed', () => {
        // Day 1: the pill was cached because this device lacked the epoch key.
        // Day 31: the server hard-deleted the row, so it is absent from the
        // newest page. Nothing can ever decrypt it — it must not keep claiming
        // a key problem forever.
        const existing = [msg('a', 10), placeholder('swept', 20), msg('c', 30)];
        const incoming = [msg('a', 10), msg('c', 30)];
        const out = foldChannelHistory(existing, incoming, new Set(), coveredServerWindow(incoming));
        expect(ids(out)).toEqual(['a', 'c']);
    });

    it('still shows the pill for a row the server returned and we cannot decrypt', () => {
        // A joiner's first history fetch: the ciphertext is right there, the
        // epoch key is not. Pill stays; Dashboard still files the key request.
        const incoming = [msg('a', 10), placeholder('locked', 20)];
        const out = foldChannelHistory([msg('a', 10)], incoming, new Set(), coveredServerWindow(incoming));
        expect(ids(out)).toEqual(['a', 'locked']);
        expect(isUndecryptablePlaceholder(out.find(r => r.id === 'locked'))).toBe(true);
    });

    it('a freshly-fetched pill is inserted, not immediately pruned', () => {
        const incoming = [placeholder('new', 20)];
        const out = foldChannelHistory([], incoming, new Set(), coveredServerWindow(incoming));
        expect(ids(out)).toEqual(['new']);
    });

    it('an empty channel clears every cached pill but keeps decrypted history', () => {
        // 200 OK with zero rows: the server holds nothing in this channel.
        const existing = [msg('mine', 10), placeholder('p1', 20), placeholder('p2', 30)];
        const out = foldChannelHistory(existing, [], new Set(), coveredServerWindow([]));
        expect(ids(out)).toEqual(['mine']);
    });

    it('omitting the window preserves the previous three-argument behaviour', () => {
        const existing = [msg('a', 10), placeholder('swept', 20)];
        expect(ids(foldChannelHistory(existing, [msg('a', 10)], new Set())))
            .toEqual(['a', 'swept']);
    });

    it('spares a live placeholder that arrived while the fetch was in flight', () => {
        // handleChannelMessage cached a pill at t=40 for a channel:message_new
        // it could not decrypt. A refresh issued at t=30 lands afterwards and
        // of course does not contain it. Capping the window at request time is
        // what stops that from being read as "the server deleted it".
        const requestedAt = new Date(30 * 60_000).toISOString();
        const incoming = [msg('a', 10), msg('b', 20)];
        const existing = [...incoming, placeholder('live', 40)];
        const out = foldChannelHistory(existing, incoming, new Set(), coveredServerWindow(incoming, requestedAt));
        expect(ids(out)).toEqual(['a', 'b', 'live']);

        // Without the cap the same batch wrongly eats it.
        const uncapped = foldChannelHistory(existing, incoming, new Set(), coveredServerWindow(incoming));
        expect(ids(uncapped)).toEqual(['a', 'b']);
    });

    it('does not disturb the placeholder-upgrade heal path', () => {
        const existing = [placeholder('b', 20)];
        const incoming = [msg('b', 20, 'decrypted at last')];
        const out = foldChannelHistory(existing, incoming, new Set(), coveredServerWindow(incoming));
        expect(textOf(out, 'b')).toBe('decrypted at last');
    });
});

/**
 * deletedChannelTargetIds — the "which cached rows will a delete batch remove"
 * side-channel used to unpin a personally-saved ("Save for me") message a
 * delete just took out from under it. Must agree with foldChannelHistory's own
 * delete handling exactly, since it's meant to answer "what will that call do"
 * without re-running it destructively.
 */
describe('deletedChannelTargetIds', () => {
    it('reports the id of a row a delete envelope actually removes', () => {
        const existing = [msg('a', 1), msg('b', 2)];
        const incoming = [
            { id: 'd1', timestamp: new Date(5 * 60_000).toISOString(), content: { type: 'delete', target_id: 'a' } },
        ];
        expect(deletedChannelTargetIds(existing, incoming)).toEqual(['a']);
    });

    it('agrees with foldChannelHistory on which id actually gets removed', () => {
        const existing = [msg('a', 1), msg('b', 2)];
        const incoming = [
            { id: 'd1', timestamp: new Date(5 * 60_000).toISOString(), content: { type: 'delete', target_id: 'a' } },
        ];
        const removedByFold = existing.filter(m => !foldChannelHistory(existing, incoming).some(r => r.id === m.id));
        expect(deletedChannelTargetIds(existing, incoming)).toEqual(ids(removedByFold));
    });

    it('is empty when the delete targets a message that is not cached', () => {
        const existing = [msg('a', 1)];
        const incoming = [
            { id: 'd1', timestamp: new Date(5 * 60_000).toISOString(), content: { type: 'delete', target_id: 'nonexistent' } },
        ];
        expect(deletedChannelTargetIds(existing, incoming)).toEqual([]);
    });

    it('resolves a delete targeting a client_msg_id to the row\'s real id', () => {
        const existing: ChannelRow[] = [{
            id: 'server-id-1',
            timestamp: new Date(60_000).toISOString(),
            content: { type: 'text', text: 'hi', client_msg_id: 'client-1' },
        }];
        const incoming = [
            { id: 'd1', timestamp: new Date(5 * 60_000).toISOString(), content: { type: 'delete', target_id: 'client-1' } },
        ];
        expect(deletedChannelTargetIds(existing, incoming)).toEqual(['server-id-1']);
    });

    it('ignores edits, reactions and plain messages — only deletes ever remove a row', () => {
        const existing = [msg('a', 1)];
        const incoming = [
            { id: 'e1', timestamp: new Date(2 * 60_000).toISOString(), content: { type: 'edit', target_id: 'a', text: 'edited' } },
            { id: 'r1', timestamp: new Date(3 * 60_000).toISOString(), sender_user_id: 'u2', content: { type: 'reaction', target_id: 'a', emoji: '👍', action: 'add' } },
            msg('b', 4),
        ];
        expect(deletedChannelTargetIds(existing, incoming)).toEqual([]);
    });

    it('skips a delete for a message the local retention sweep already purged', () => {
        const existing = [msg('a', 1)];
        // The delete envelope's own id ('a') is in purgedIds — same skip
        // foldChannelHistory applies before any other branch.
        const incoming = [
            { id: 'a', timestamp: new Date(5 * 60_000).toISOString(), content: { type: 'delete', target_id: 'a' } },
        ];
        expect(deletedChannelTargetIds(existing, incoming, new Set(['a']))).toEqual([]);
    });

    it('never mutates its inputs', () => {
        const existing = [msg('a', 1)];
        const incoming = [
            { id: 'd1', timestamp: new Date(5 * 60_000).toISOString(), content: { type: 'delete', target_id: 'a' } },
        ];
        const existingSnapshot = JSON.stringify(existing);
        const incomingSnapshot = JSON.stringify(incoming);
        deletedChannelTargetIds(existing, incoming);
        expect(JSON.stringify(existing)).toBe(existingSnapshot);
        expect(JSON.stringify(incoming)).toBe(incomingSnapshot);
    });

    it('handles multiple deletes in one batch', () => {
        const existing = [msg('a', 1), msg('b', 2), msg('c', 3)];
        const incoming = [
            { id: 'd1', timestamp: new Date(5 * 60_000).toISOString(), content: { type: 'delete', target_id: 'a' } },
            { id: 'd2', timestamp: new Date(6 * 60_000).toISOString(), content: { type: 'delete', target_id: 'c' } },
        ];
        expect(deletedChannelTargetIds(existing, incoming).sort()).toEqual(['a', 'c']);
    });
});

/**
 * Dashboard-side wiring for the "Save for me" delete-cleanup fix. Same
 * source-scan technique dmInbound.test.ts uses for the DM pull loop: this
 * function is a 7k-line monolith not worth fully rendering just to prove four
 * call sites reach the right helper, in the right order, through the
 * documented forward-reference ref (handlePersonalChannelSave is declared
 * ~2000 lines below these three read paths).
 */
const dashboardSrc = readFileSync(join(__dirname, '..', 'components', 'Dashboard.tsx'), 'utf8');

describe('handleChannelMessage (live WS) unpins a personally-saved deleted message', () => {
    const start = dashboardSrc.indexOf('const handleChannelMessage = useCallback');
    const end = dashboardSrc.indexOf('}, [userId, notify]);', start);
    const fn = dashboardSrc.slice(start, end);

    it('meta: found the function', () => {
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
    });

    it('computes the removed row\'s own id via deletedChannelTargetIds against channelMessagesRef, BEFORE setChannelMessages — not inside the (pure) updater', () => {
        // Same fix as handleOptimisticMessage's (dmInbound.test.ts): a value
        // assigned INSIDE a setState updater and read right after the
        // setState call is not reliable under React 19, so it must be
        // computed up front from the ref instead.
        const computeAt = fn.indexOf('deletedChannelTargetIds(');
        const setStateAt = fn.indexOf('setChannelMessages(prev => {');
        expect(computeAt).toBeGreaterThan(0);
        expect(computeAt).toBeLessThan(setStateAt);
        expect(fn).toContain('channelMessagesRef.current[evt.channel_id]');
        const updaterBody = fn.slice(setStateAt);
        expect(updaterBody).not.toContain('deletedRowId =');
    });

    it('unpins via the ref, AFTER setChannelMessages, only when it was locally saved', () => {
        const setStateAt = fn.indexOf('setChannelMessages(prev => {');
        const unpinAt = fn.indexOf("handlePersonalChannelSaveRef.current(evt.channel_id, deletedRowId, 'remove')");
        expect(unpinAt).toBeGreaterThan(setStateAt);
        expect(fn).toContain('localChannelPinsRef.current[evt.channel_id]?.includes(deletedRowId)');
    });
});

describe('handleChannelMessageSent (sender-side optimistic) unpins its own deleted saved message', () => {
    const start = dashboardSrc.indexOf('const handleChannelMessageSent = useCallback');
    const end = dashboardSrc.indexOf('handleChannelMessageSentRef.current = handleChannelMessageSent', start);
    const fn = dashboardSrc.slice(start, end);

    it('meta: found the function', () => {
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
    });

    it('computes the removed row\'s own id via deletedChannelTargetIds against channelMessagesRef, BEFORE setChannelMessages, and unpins via the ref after the state update', () => {
        const computeAt = fn.indexOf('deletedChannelTargetIds(');
        const setStateAt = fn.indexOf('setChannelMessages(prev => {');
        expect(computeAt).toBeGreaterThan(0);
        expect(computeAt).toBeLessThan(setStateAt);
        expect(fn).toContain('channelMessagesRef.current[cid]');
        const updaterBody = fn.slice(setStateAt);
        expect(updaterBody).not.toContain('deletedRowId =');
        const unpinAt = fn.indexOf("handlePersonalChannelSaveRef.current(cid, deletedRowId, 'remove')");
        expect(unpinAt).toBeGreaterThan(setStateAt);
    });
});

describe('refreshChannelHistory (catch-up fetch) unpins a message deleted while this device was elsewhere', () => {
    const start = dashboardSrc.indexOf('const refreshChannelHistory = useCallback');
    // The body is wrapped in trackActivity('channel:history', …) for the freeze
    // log, so it closes with `}), [deps]` — match the dep list, not the brace.
    const end = dashboardSrc.indexOf(', [token, deviceId, userId, decryptChannelRows, ensureChannelSaves, incomingRetentionFor]);', start);
    const fn = dashboardSrc.slice(start, end);

    it('meta: found the function', () => {
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
    });

    it('computes deletedChannelTargetIds against the pre-merge snapshot, BEFORE folding, and unpins via the ref', () => {
        const unpinAt = fn.indexOf('deletedChannelTargetIds(channelMessagesRef.current[channelId] ?? [], sorted, purgedIds)');
        const foldAt = fn.indexOf('foldChannelHistory(prev[channelId] ?? [], sorted, purgedIds, serverWindow)');
        expect(unpinAt).toBeGreaterThan(0);
        expect(unpinAt).toBeLessThan(foldAt);
        expect(fn).toContain("handlePersonalChannelSaveRef.current(channelId, id, 'remove')");
    });
});

describe('handlePersonalChannelSaveRef / handleUnpinMessageRef are kept live', () => {
    it('handlePersonalChannelSave publishes itself to the ref right after its own declaration', () => {
        const declAt = dashboardSrc.indexOf('const handlePersonalChannelSave = React.useCallback');
        const publishAt = dashboardSrc.indexOf('handlePersonalChannelSaveRef.current = handlePersonalChannelSave', declAt);
        expect(declAt).toBeGreaterThan(0);
        expect(publishAt).toBeGreaterThan(declAt);
    });

    it('both refs default to a no-op so an early call before first render-effect cannot throw', () => {
        const refsAt = dashboardSrc.indexOf('const handleUnpinMessageRef = useRef');
        expect(dashboardSrc.slice(refsAt, refsAt + 400)).toContain('useRef<(convId: string, msgId: string) => void>(() => {})');
        expect(dashboardSrc.slice(refsAt, refsAt + 400)).toContain("useRef<(channelId: string, msgId: string, action: 'add' | 'remove') => void>(() => {})");
    });
});
