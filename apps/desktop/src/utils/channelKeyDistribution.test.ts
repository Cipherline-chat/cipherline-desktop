import { describe, it, expect } from 'vitest';
import {
    computeMissingKeyChannels,
    computeUnmintedChannels,
    decideChannelEntryAction,
    shouldMintAfterKeyRequest,
    chunkEnvelopes,
    buildChannelKeyContent,
    pickJitterMs,
    resolveEpochClaim,
    resolveEpochDivergence,
    computeMissingEpochsForChannel,
    coalesceKeyRequestEvents,
    coalesceEnvelopesReadyEvents,
    channelEpochKey,
    shouldGiveUpOnChannelKey,
    computeCoolOffUntil,
    isCoolingOff,
    CHANNEL_KEY_RETRY_LIMIT,
    CHANNEL_KEY_COOL_OFF_MS,
    computeEpochsToDistribute,
    decideEnvelopesReadyAction,
    ROTATION_REASONS,
    normalizeRotationReason,
    coalesceRotationEvents,
    decideRotationAction,
    decideRotationScheduling,
    computeRotationEpoch,
    resolveRotationClaim,
} from './channelKeyDistribution';

describe('computeMissingKeyChannels', () => {
    const channels = [
        { channel_id: 'text-no-local', kind: 'text', latest_epoch: 3 },
        { channel_id: 'text-stale-local', kind: 'text', latest_epoch: 3 },
        { channel_id: 'text-current', kind: 'text', latest_epoch: 3 },
        { channel_id: 'text-unbootstrapped', kind: 'text', latest_epoch: 0 },
        { channel_id: 'text-missing-field', kind: 'text' },
        // Calls channels carry Sender Keys too — their LiveKit room key is
        // DERIVED from one, so they belong in the backfill sweep. They used to
        // be excluded here, which is exactly why server calls were unencrypted.
        { channel_id: 'huddle-1', kind: 'huddle', latest_epoch: 3 },
        { channel_id: 'voice-1', kind: 'voice', latest_epoch: 3 },
        { channel_id: 'forum-1', kind: 'forum', latest_epoch: 3 },
    ];

    it('flags keyed channels with no local key or a stale local epoch', () => {
        const out = computeMissingKeyChannels(channels, {
            'text-stale-local': 2,
            'text-current': 3,
            'huddle-1': 3,
            'voice-1': 3,
        });
        expect(out).toEqual(['text-no-local', 'text-stale-local']);
    });

    it('flags a Calls channel whose key this device does not hold', () => {
        const out = computeMissingKeyChannels(channels, {
            'text-no-local': 3, 'text-stale-local': 3, 'text-current': 3,
        });
        expect(out).toContain('huddle-1');
        expect(out).toContain('voice-1');
    });

    it('ignores unbootstrapped channels (epoch 0 / absent) and unkeyed kinds', () => {
        const out = computeMissingKeyChannels(channels, {});
        expect(out).not.toContain('text-unbootstrapped');
        expect(out).not.toContain('text-missing-field');
        expect(out).not.toContain('forum-1');
    });

    it('treats explicit null local epoch as missing', () => {
        const out = computeMissingKeyChannels(
            [{ channel_id: 'c', kind: 'text', latest_epoch: 1 }],
            { c: null },
        );
        expect(out).toEqual(['c']);
    });
});

describe('computeUnmintedChannels', () => {
    it('flags a text channel with latest_epoch 0 and no local key', () => {
        const out = computeUnmintedChannels(
            [{ channel_id: 'fresh', kind: 'text', latest_epoch: 0 }],
            {},
        );
        expect(out).toEqual(['fresh']);
    });

    it('does NOT flag a channel with unknown (absent) latest_epoch — unknown must never be treated as unminted', () => {
        const out = computeUnmintedChannels(
            [{ channel_id: 'unknown', kind: 'text' }],
            {},
        );
        expect(out).toEqual([]);
    });

    it('does NOT flag a channel this device already holds a local key for, even if server latest_epoch reads 0', () => {
        const out = computeUnmintedChannels(
            [{ channel_id: 'c', kind: 'text', latest_epoch: 0 }],
            { c: 1 },
        );
        expect(out).toEqual([]);
    });

    it('flags a never-minted Calls channel — it needs epoch 1 like any keyed channel', () => {
        const out = computeUnmintedChannels(
            [
                { channel_id: 'h', kind: 'huddle', latest_epoch: 0 },
                { channel_id: 'v', kind: 'voice', latest_epoch: 0 },
            ],
            {},
        );
        expect(out).toEqual(['h', 'v']);
    });

    it('ignores kinds that carry no Sender Keys at all', () => {
        const out = computeUnmintedChannels(
            [{ channel_id: 'f', kind: 'forum', latest_epoch: 0 }],
            {},
        );
        expect(out).toEqual([]);
    });
});

describe('decideChannelEntryAction', () => {
    it('clears the gate when a local key is already held, regardless of server state', () => {
        expect(decideChannelEntryAction({ localEpoch: 3, latestEpoch: 0 })).toBe('clear_gate');
        expect(decideChannelEntryAction({ localEpoch: 1, latestEpoch: undefined })).toBe('clear_gate');
    });

    it('mints when no local key is held and the server confirms latest_epoch is 0', () => {
        expect(decideChannelEntryAction({ localEpoch: null, latestEpoch: 0 })).toBe('mint');
    });

    it('waits when no local key is held and the server has a registered epoch', () => {
        expect(decideChannelEntryAction({ localEpoch: null, latestEpoch: 5 })).toBe('wait');
    });

    it('waits (never blind-mints) when the server state is unknown', () => {
        expect(decideChannelEntryAction({ localEpoch: null, latestEpoch: undefined })).toBe('wait');
    });
});

describe('shouldMintAfterKeyRequest', () => {
    it('mints when the key-request response confirms latest_epoch is 0 — an unanswerable request', () => {
        expect(shouldMintAfterKeyRequest(0)).toBe(true);
    });

    it('keeps waiting when a real epoch exists — a real holder can answer', () => {
        expect(shouldMintAfterKeyRequest(4)).toBe(false);
    });

    it('keeps waiting (conservative default) when talking to an older API that omits the field', () => {
        expect(shouldMintAfterKeyRequest(undefined)).toBe(false);
    });
});

describe('chunkEnvelopes', () => {
    it('splits into 20-sized chunks by default', () => {
        const chunks = chunkEnvelopes(Array.from({ length: 45 }, (_, i) => i));
        expect(chunks.map(c => c.length)).toEqual([20, 20, 5]);
    });

    it('returns [] for empty input and rejects size < 1', () => {
        expect(chunkEnvelopes([])).toEqual([]);
        expect(() => chunkEnvelopes([1], 0)).toThrow();
    });
});

describe('buildChannelKeyContent', () => {
    it('builds a channel_key content with a deterministic client_msg_id', () => {
        const c = buildChannelKeyContent({
            channelId: 'chan', epoch: 2, keyB64: 'a2V5', deviceId: 'dev',
            rotationReason: 'member_join',
        });
        expect(c.type).toBe('channel_key');
        expect(c.client_msg_id).toBe('ck-chan-2-dev');
        expect(c.epoch).toBe(2);
        expect(c.key_b64).toBe('a2V5');
        expect(Date.parse(c.rotates_at)).toBeGreaterThan(Date.now());
    });
});

describe('pickJitterMs', () => {
    it('stays within [500, 3500)', () => {
        for (let i = 0; i < 200; i++) {
            const j = pickJitterMs();
            expect(j).toBeGreaterThanOrEqual(500);
            expect(j).toBeLessThan(3500);
        }
    });
});

describe('resolveEpochClaim', () => {
    const FP_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const FP_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';

    it('wins on a fresh insert (created:true)', () => {
        expect(resolveEpochClaim({ localFingerprintB64: FP_A, created: true, serverFingerprintB64: FP_A }))
            .toBe('won');
    });

    it('wins on a conflict where the server fingerprint matches ours (retry / duplicate POST)', () => {
        expect(resolveEpochClaim({ localFingerprintB64: FP_A, created: false, serverFingerprintB64: FP_A }))
            .toBe('won');
    });

    it('loses on a conflict where another device already claimed a different fingerprint', () => {
        expect(resolveEpochClaim({ localFingerprintB64: FP_B, created: false, serverFingerprintB64: FP_A }))
            .toBe('lost');
    });
});

describe('resolveEpochDivergence', () => {
    const FP_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    const FP_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
    const CREATED = '2026-01-01T00:00:00.000Z';

    it('claims an epoch the server has never seen', () => {
        expect(resolveEpochDivergence(FP_A, undefined)).toBe('claim');
    });

    it('claims an epoch with a null server fingerprint (pre-fingerprint client registered it)', () => {
        expect(resolveEpochDivergence(FP_A, { epoch: 1, fingerprint_b64: null, created_at: CREATED }))
            .toBe('claim');
    });

    it('keeps a locally held key that matches the arbitrated server fingerprint', () => {
        expect(resolveEpochDivergence(FP_A, { epoch: 1, fingerprint_b64: FP_A, created_at: CREATED }))
            .toBe('keep');
    });

    it('discards and re-requests when the server fingerprint diverges from the local key', () => {
        expect(resolveEpochDivergence(FP_B, { epoch: 1, fingerprint_b64: FP_A, created_at: CREATED }))
            .toBe('discard_and_request');
    });
});

describe('computeMissingEpochsForChannel', () => {
    const NOW = Date.parse('2026-07-27T00:00:00.000Z');
    const RECENT = '2026-07-20T00:00:00.000Z'; // 7 days before NOW
    const STALE = '2026-06-01T00:00:00.000Z'; // 56 days before NOW — past the 30-day horizon
    const fp = (n: number) => `epoch-${n}-fingerprint`;
    const epoch = (n: number, created_at = RECENT) => ({ epoch: n, fingerprint_b64: fp(n), created_at });

    it('flags a missing intermediate epoch WITHOUT marking the latest as missing', () => {
        // Holds epoch 5 (latest) but not 1-4 — history is locked, but sending must still work.
        const out = computeMissingEpochsForChannel([epoch(1), epoch(5)], [5], NOW);
        expect(out.missingEpochs).toEqual([1]);
        expect(out.missingLatest).toBe(false);
    });

    it('marks missingLatest when the highest server epoch is absent locally', () => {
        const out = computeMissingEpochsForChannel([epoch(1), epoch(2)], [1], NOW);
        expect(out.missingEpochs).toEqual([2]);
        expect(out.missingLatest).toBe(true);
    });

    it('excludes epochs past the 30-day prune horizon — nobody holds them anymore either', () => {
        const out = computeMissingEpochsForChannel([epoch(1, STALE), epoch(2)], [2], NOW);
        expect(out.missingEpochs).toEqual([]);
        expect(out.missingLatest).toBe(false);
    });

    it('reports nothing missing when every server epoch is held locally', () => {
        const out = computeMissingEpochsForChannel([epoch(1), epoch(2)], [1, 2], NOW);
        expect(out.missingEpochs).toEqual([]);
        expect(out.missingLatest).toBe(false);
    });

    it('handles a channel the server has no epoch rows for at all', () => {
        const out = computeMissingEpochsForChannel([], [], NOW);
        expect(out.missingEpochs).toEqual([]);
        expect(out.missingLatest).toBe(false);
    });
});

describe('coalesceKeyRequestEvents', () => {
    const DEV_SELF = 'dev-self';
    const DEV_OTHER = 'dev-other';

    it('collapses a burst across two servers into two distinct server ids, order-independent', () => {
        const out = coalesceKeyRequestEvents([
            { server_id: 'srv-A', requester_device_id: DEV_OTHER },
            { server_id: 'srv-B', requester_device_id: DEV_OTHER },
            { server_id: 'srv-A', requester_device_id: DEV_OTHER }, // duplicate for srv-A
        ], DEV_SELF);
        expect(new Set(out)).toEqual(new Set(['srv-A', 'srv-B']));
        expect(out).toHaveLength(2);
    });

    it('excludes the caller\'s own device asking for its own key', () => {
        const out = coalesceKeyRequestEvents([
            { server_id: 'srv-A', requester_device_id: DEV_SELF },
        ], DEV_SELF);
        expect(out).toEqual([]);
    });

    it('returns [] for an empty batch', () => {
        expect(coalesceKeyRequestEvents([], DEV_SELF)).toEqual([]);
    });
});

describe('coalesceEnvelopesReadyEvents', () => {
    it('extracts every distinct channel in the batch, not just the last one', () => {
        // Regression case: a single-nullable-slot version would have kept
        // only chan-C (the last event), losing chan-A and chan-B entirely.
        const out = coalesceEnvelopesReadyEvents([
            { server_id: 'srv-A', channel_id: 'chan-A' },
            { server_id: 'srv-A', channel_id: 'chan-B' },
            { server_id: 'srv-B', channel_id: 'chan-C' },
        ]);
        expect(new Set(out.channelIds)).toEqual(new Set(['chan-A', 'chan-B', 'chan-C']));
        expect(new Set(out.serverIds)).toEqual(new Set(['srv-A', 'srv-B']));
    });

    it('dedupes repeated channel/server ids within the batch', () => {
        const out = coalesceEnvelopesReadyEvents([
            { server_id: 'srv-A', channel_id: 'chan-A' },
            { server_id: 'srv-A', channel_id: 'chan-A' },
        ]);
        expect(out.channelIds).toEqual(['chan-A']);
        expect(out.serverIds).toEqual(['srv-A']);
    });

    it('returns empty arrays for an empty batch', () => {
        const out = coalesceEnvelopesReadyEvents([]);
        expect(out).toEqual({ serverIds: [], channelIds: [] });
    });
});

describe('channelEpochKey', () => {
    it('builds a stable natural key from channel_id and epoch', () => {
        expect(channelEpochKey('chan-A', 3)).toBe('chan-A:3');
    });

    it('distinguishes different epochs of the same channel', () => {
        expect(channelEpochKey('chan-A', 1)).not.toBe(channelEpochKey('chan-A', 2));
    });
});

describe('shouldGiveUpOnChannelKey', () => {
    it('does not give up below the retry limit', () => {
        expect(shouldGiveUpOnChannelKey(CHANNEL_KEY_RETRY_LIMIT - 1)).toBe(false);
    });

    it('gives up at exactly the retry limit', () => {
        expect(shouldGiveUpOnChannelKey(CHANNEL_KEY_RETRY_LIMIT)).toBe(true);
    });

    it('gives up beyond the retry limit', () => {
        expect(shouldGiveUpOnChannelKey(CHANNEL_KEY_RETRY_LIMIT + 5)).toBe(true);
    });
});

describe('computeCoolOffUntil / isCoolingOff', () => {
    it('computes a cool-off deadline CHANNEL_KEY_COOL_OFF_MS in the future', () => {
        expect(computeCoolOffUntil(1000)).toBe(1000 + CHANNEL_KEY_COOL_OFF_MS);
    });

    it('is cooling off strictly before the deadline', () => {
        const until = computeCoolOffUntil(1000);
        expect(isCoolingOff(until, until - 1)).toBe(true);
    });

    it('is not cooling off at or after the deadline', () => {
        const until = computeCoolOffUntil(1000);
        expect(isCoolingOff(until, until)).toBe(false);
        expect(isCoolingOff(until, until + 1)).toBe(false);
    });

    it('is not cooling off when no deadline is set', () => {
        expect(isCoolingOff(undefined, Date.now())).toBe(false);
    });
});

describe('computeEpochsToDistribute (RC-10)', () => {
    it('distributes everything held; nothing unservable when held covers pinned + latest', () => {
        const plan = computeEpochsToDistribute([1, 2, 3], [1], 3);
        expect(plan.toDistribute).toEqual([1, 2, 3]);
        expect(plan.unservable).toEqual([]);
    });

    it('flags a pinned epoch not held as unservable', () => {
        const plan = computeEpochsToDistribute([2, 3], [1], 3);
        expect(plan.toDistribute).toEqual([2, 3]);
        expect(plan.unservable).toEqual([1]);
    });

    it('flags a missing latest epoch as unservable, same as a missing pinned one', () => {
        const plan = computeEpochsToDistribute([1, 2], [1], 5);
        expect(plan.unservable).toEqual([5]);
    });

    it('latest is optional — omitting it never manufactures a spurious unservable entry', () => {
        const plan = computeEpochsToDistribute([1, 2], [1], undefined);
        expect(plan.unservable).toEqual([]);
    });

    it('dedupes and sorts unservable when pinned and latest overlap or are unsorted', () => {
        const plan = computeEpochsToDistribute([], [5, 1, 5, 3], 1);
        expect(plan.unservable).toEqual([1, 3, 5]);
    });

    it('toDistribute is sorted ascending regardless of held input order', () => {
        const plan = computeEpochsToDistribute([3, 1, 2], [], undefined);
        expect(plan.toDistribute).toEqual([1, 2, 3]);
    });

    it('empty held with no pins/latest is a no-op', () => {
        const plan = computeEpochsToDistribute([], [], undefined);
        expect(plan).toEqual({ toDistribute: [], unservable: [] });
    });
});

describe('decideEnvelopesReadyAction (server-channel flicker regression)', () => {
    // Regression for the "server text channel repeatedly flashes empty then
    // repopulates" bug.
    //
    // The server addresses key envelopes to specific DEVICES but notifies the
    // recipient USER — channel-key-handshakes.service.ts calls
    // gateway.notifyChannelKeyEnvelopesReady(dto.recipient_user_id), which
    // fans out via broadcastToUsers to every socket that user has open.
    // Confirmed live against the dev API: with three devices on one account, a
    // handshake POST carrying an envelope for device C alone delivered
    // `server:channel_key_envelopes_ready` to devices A and B as well.
    //
    // Dashboard's handler used to react by unconditionally deleting
    // channelMessages[channel_id] for every channel in the batch and then
    // re-running the channel-entry path to refetch. On a device that was not
    // the envelope recipient that meant: fully-decrypted thread -> [] (with no
    // spinner, since the loading flag is only armed on a channel's FIRST
    // visit) -> refetch -> repopulated. And because a served key request stays
    // `fulfilled_at IS NULL` until the recipient ACKs, holders re-serve it on
    // every retry tick and every reconnect, so it repeated rather than firing
    // once.
    //
    // The guard below is what stops that: an event that changes nothing for
    // THIS device must be a no-op.

    it('ignores the push when this device already held the key and has no placeholders', () => {
        // The exact bystander case that produced the flicker.
        expect(decideEnvelopesReadyAction({
            heldKeyBefore: true,
            heldKeyAfter: true,
            hasUndecryptableCached: false,
        })).toBe('ignore');
    });

    it('refetches when this device gained a key it did not have', () => {
        expect(decideEnvelopesReadyAction({
            heldKeyBefore: false,
            heldKeyAfter: true,
            hasUndecryptableCached: false,
        })).toBe('refetch');
    });

    it('refetches when cached history still holds undecryptable placeholders', () => {
        // A re-serve may have delivered a missing OLDER epoch, which does not
        // change "do I hold a key at all" but can still heal history.
        expect(decideEnvelopesReadyAction({
            heldKeyBefore: true,
            heldKeyAfter: true,
            hasUndecryptableCached: true,
        })).toBe('refetch');
    });

    it('gaining a key wins even with placeholders also present', () => {
        expect(decideEnvelopesReadyAction({
            heldKeyBefore: false,
            heldKeyAfter: true,
            hasUndecryptableCached: true,
        })).toBe('refetch');
    });

    it('ignores a push that left us still keyless with nothing cached to heal', () => {
        // Envelopes were for a sibling device; the pull installed nothing for
        // us. Refetching would only re-render the same empty thread.
        expect(decideEnvelopesReadyAction({
            heldKeyBefore: false,
            heldKeyAfter: false,
            hasUndecryptableCached: false,
        })).toBe('ignore');
    });

    it('still refetches while keyless if placeholders are cached', () => {
        expect(decideEnvelopesReadyAction({
            heldKeyBefore: false,
            heldKeyAfter: false,
            hasUndecryptableCached: true,
        })).toBe('refetch');
    });

    it('is stable under repeated identical pushes — the loop cannot restart itself', () => {
        // The bug was self-sustaining: each push cleared + refetched, and the
        // refetch path re-filed a key request, which drew fresh envelopes,
        // which pushed again. A settled device must return 'ignore' every
        // time, no matter how many times holders re-serve.
        const settled = {
            heldKeyBefore: true,
            heldKeyAfter: true,
            hasUndecryptableCached: false,
        };
        const results = Array.from({ length: 25 }, () => decideEnvelopesReadyAction(settled));
        expect(results.every(r => r === 'ignore')).toBe(true);
    });

    it('never asks the caller to discard cached messages', () => {
        // 'ignore' | 'refetch' only — there is deliberately no action that
        // drops the local thread. Dropping lost anything older than the API's
        // 50-row window, which a refetch cannot bring back, and healing a
        // placeholder never needed it (the catch-up merge upgrades in place).
        const all = [true, false].flatMap(a => [true, false].flatMap(b => [true, false].map(c =>
            decideEnvelopesReadyAction({ heldKeyBefore: a, heldKeyAfter: b, hasUndecryptableCached: c }),
        )));
        expect(new Set(all)).toEqual(new Set(['ignore', 'refetch']));
    });
});

// ── Calls-channel rotation (server:channel_key_rotation_needed) ────────────

describe('normalizeRotationReason', () => {
    it('passes through every reason the API actually emits', () => {
        for (const r of ROTATION_REASONS) expect(normalizeRotationReason(r)).toBe(r);
    });

    it('folds an unknown/missing reason to permission_change rather than propagating it', () => {
        // rotation_reason lands in a DB column; a newer or malformed server
        // build must not be able to write an arbitrary string through us.
        expect(normalizeRotationReason('something_new')).toBe('permission_change');
        expect(normalizeRotationReason('')).toBe('permission_change');
        expect(normalizeRotationReason(undefined)).toBe('permission_change');
        expect(normalizeRotationReason(null)).toBe('permission_change');
    });
});

describe('coalesceRotationEvents', () => {
    it('collapses a storm for one channel to a single rotation', () => {
        // An admin editing five roles in a row: five events, one rotation.
        const events = Array.from({ length: 5 }, () => ({
            server_id: 's1', channel_id: 'calls-1', reason: 'permission_change',
        }));
        expect(coalesceRotationEvents(events)).toHaveLength(1);
    });

    it('keeps one entry per channel when a burst spans several channels', () => {
        const out = coalesceRotationEvents([
            { server_id: 's1', channel_id: 'c1', reason: 'permission_change' },
            { server_id: 's1', channel_id: 'c2', reason: 'permission_change' },
            { server_id: 's1', channel_id: 'c1', reason: 'permission_change' },
            { server_id: 's2', channel_id: 'c3', reason: 'member_removed' },
        ]);
        expect(out.map(e => e.channel_id).sort()).toEqual(['c1', 'c2', 'c3']);
    });

    it('keeps the LAST reason for a channel — the most current cause', () => {
        const out = coalesceRotationEvents([
            { server_id: 's1', channel_id: 'c1', reason: 'permission_change' },
            { server_id: 's1', channel_id: 'c1', reason: 'member_removed' },
        ]);
        expect(out).toEqual([{ server_id: 's1', channel_id: 'c1', reason: 'member_removed' }]);
    });

    it('is a no-op on an empty batch', () => {
        expect(coalesceRotationEvents([])).toEqual([]);
    });
});

describe('decideRotationAction', () => {
    it('rotates a Calls channel we hold a key for', () => {
        for (const kind of ['huddle', 'voice']) {
            expect(decideRotationAction({ channelKind: kind, holdsLocalKey: true })).toBe('rotate');
        }
    });

    it('skips a channel that is not in our loaded list', () => {
        // Either we cannot see it (access was removed from US) or the list is
        // still loading — another remaining holder covers it either way.
        expect(decideRotationAction({ channelKind: null, holdsLocalKey: true })).toBe('skip_unknown_channel');
        expect(decideRotationAction({ channelKind: undefined, holdsLocalKey: true })).toBe('skip_unknown_channel');
    });

    // C6: these two assertions previously pinned the OPPOSITE behaviour
    // ('skip_not_calls_channel'). That refusal was half the reason text
    // channels never rotated — a removed member's key stayed the live key
    // indefinitely, leaving future text confidentiality resting on API
    // authorization rather than cryptography.
    it('rotates a text channel — text carries a Sender Key like Calls channels do', () => {
        expect(decideRotationAction({ channelKind: 'text', holdsLocalKey: true }))
            .toBe('rotate');
    });

    it('refuses a kind that carries no Sender Key at all', () => {
        expect(decideRotationAction({ channelKind: 'forum', holdsLocalKey: true }))
            .toBe('skip_not_keyed_channel');
    });

    it('skips when we hold no key — nothing to rotate from', () => {
        expect(decideRotationAction({ channelKind: 'huddle', holdsLocalKey: false }))
            .toBe('skip_no_local_key');
    });

    it('checks kind before key possession, so an unkeyed kind never reports skip_no_local_key', () => {
        expect(decideRotationAction({ channelKind: 'forum', holdsLocalKey: false }))
            .toBe('skip_not_keyed_channel');
    });

    it('a text channel with no local key reports skip_no_local_key, not a kind refusal', () => {
        // Regression guard for the C6 change: text must fall through the kind
        // gate and be judged on key possession like any other keyed channel.
        expect(decideRotationAction({ channelKind: 'text', holdsLocalKey: false }))
            .toBe('skip_no_local_key');
    });
});

describe('decideRotationScheduling', () => {
    it('arms a timer when nothing is pending', () => {
        expect(decideRotationScheduling({ armed: false, inFlight: false })).toBe('arm');
    });

    it('rides an already-armed timer instead of arming a second one', () => {
        expect(decideRotationScheduling({ armed: true, inFlight: false })).toBe('ride');
    });

    it('queues a follow-up when a rotation is mid-flight', () => {
        // The in-flight rotation snapshotted its recipient list BEFORE this
        // event's demotion, so it may have just handed the new epoch to the
        // member this event demotes. Dropping the event would leave the
        // last-demoted member holding a live key.
        expect(decideRotationScheduling({ armed: false, inFlight: true })).toBe('queue_followup');
    });

    it('prefers the follow-up over riding when both a timer and a flight exist', () => {
        expect(decideRotationScheduling({ armed: true, inFlight: true })).toBe('queue_followup');
    });
});

describe('computeRotationEpoch', () => {
    it('mints one past the server latest when we are level with it', () => {
        expect(computeRotationEpoch(4, 4)).toBe(5);
    });

    it('mints past the SERVER latest when the server is ahead of us', () => {
        // A rotation already landed server-side whose envelopes have not
        // reached us; (local + 1) would collide with an epoch that exists.
        expect(computeRotationEpoch(7, 3)).toBe(8);
    });

    it('mints past OUR latest when we are ahead of the server', () => {
        expect(computeRotationEpoch(2, 6)).toBe(7);
    });

    it('stands down when we hold no key at all', () => {
        expect(computeRotationEpoch(3, null)).toBeNull();
    });

    it('stands down when the channel has never been bootstrapped anywhere', () => {
        // Inconsistent state (we hold a key the server has no record of) —
        // owned by the bootstrap/repair sweep, not by rotation.
        expect(computeRotationEpoch(0, 2)).toBeNull();
    });

    it('never returns an epoch at or below either input', () => {
        for (const server of [1, 2, 5, 9]) {
            for (const local of [1, 2, 5, 9]) {
                const next = computeRotationEpoch(server, local)!;
                expect(next).toBeGreaterThan(server);
                expect(next).toBeGreaterThan(local);
            }
        }
    });
});

describe('resolveRotationClaim', () => {
    it('distributes when this device created the epoch row', () => {
        expect(resolveRotationClaim({
            claim: { created: true, fingerprint_b64: 'ours' },
            localFingerprintB64: 'ours',
        })).toBe('distribute');
    });

    it('distributes when a retry replayed our own already-recorded claim', () => {
        // The retry ladder can land the same POST twice; created:false with OUR
        // fingerprint means we still won.
        expect(resolveRotationClaim({
            claim: { created: false, fingerprint_b64: 'ours' },
            localFingerprintB64: 'ours',
        })).toBe('distribute');
    });

    it('discards and re-requests when another holder won the race', () => {
        // Two remaining holders mint concurrently; recordEpoch's
        // INSERT ... ON CONFLICT makes exactly one the winner. The loser must
        // not keep or distribute its key — it asks for the winner's instead.
        expect(resolveRotationClaim({
            claim: { created: false, fingerprint_b64: 'theirs' },
            localFingerprintB64: 'ours',
        })).toBe('discard_and_request');
    });

    it('discards without requesting when the epoch could not be registered', () => {
        // Unlike the bootstrap mint, an unregisterable ROTATION must be thrown
        // away: the previous epoch is still valid and in use, so keeping a
        // higher one nobody can obtain would make us undecryptable to the call.
        expect(resolveRotationClaim({ claim: null, localFingerprintB64: 'ours' }))
            .toBe('discard_only');
    });

    it('never tells the caller to keep an unwon key', () => {
        const outcomes = [
            resolveRotationClaim({ claim: null, localFingerprintB64: 'a' }),
            resolveRotationClaim({ claim: { created: false, fingerprint_b64: 'b' }, localFingerprintB64: 'a' }),
            resolveRotationClaim({ claim: { created: false, fingerprint_b64: null }, localFingerprintB64: 'a' }),
        ];
        expect(outcomes.every(o => o !== 'distribute')).toBe(true);
    });
});

describe('concurrent rotation convergence (two holders, one winner)', () => {
    it('converges N holders on ONE epoch with no second arbitration mechanism', () => {
        // Both remaining holders receive the same signal, jitter, and mint the
        // same NUMBER (max(server, local) + 1) with different key material.
        const serverLatest = 4;
        const holderA = { local: 4, fp: 'fp-A' };
        const holderB = { local: 4, fp: 'fp-B' };

        const epochA = computeRotationEpoch(serverLatest, holderA.local);
        const epochB = computeRotationEpoch(serverLatest, holderB.local);
        expect(epochA).toBe(5);
        expect(epochB).toBe(epochA); // same epoch NUMBER, different key bytes

        // A's POST reaches Postgres first: created:true. B's hits the conflict
        // and gets A's fingerprint back.
        expect(resolveRotationClaim({
            claim: { created: true, fingerprint_b64: holderA.fp },
            localFingerprintB64: holderA.fp,
        })).toBe('distribute');
        expect(resolveRotationClaim({
            claim: { created: false, fingerprint_b64: holderA.fp },
            localFingerprintB64: holderB.fp,
        })).toBe('discard_and_request');
    });

    it('the loser re-requesting cannot itself trigger another rotation', () => {
        // After discarding, the loser still holds the PREVIOUS epoch, so a
        // repeat signal finds holdsLocalKey true and would rotate again — but
        // only from a NEW event, never from the discard path itself. Guard the
        // property that matters: the discarded epoch is never distributed.
        const loser = resolveRotationClaim({
            claim: { created: false, fingerprint_b64: 'winner' },
            localFingerprintB64: 'loser',
        });
        expect(loser).not.toBe('distribute');
    });
});

describe('rotation jitter (pickJitterMs, shared with the key-request path)', () => {
    it('spreads simultaneous holders across a window rather than firing together', () => {
        // Every remaining holder gets the rotation event in the same instant.
        // Without jitter they would all mint at once and all but one would
        // lose arbitration and immediately re-request.
        const samples = Array.from({ length: 200 }, () => pickJitterMs());
        expect(Math.min(...samples)).toBeGreaterThanOrEqual(500);
        expect(Math.max(...samples)).toBeLessThan(3500);
        expect(new Set(samples).size).toBeGreaterThan(20);
    });
});
