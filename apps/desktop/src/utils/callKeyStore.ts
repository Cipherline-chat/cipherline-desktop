/**
 * The DM / group call media-key store (F11 / R-06, reworked for key sharing).
 *
 * A call's E2EE media key arrives in a `call_key` message — from the call's
 * initiator at call start, from ANY participant that holds the key when a
 * joiner asks for it (`call_key_request`, utils/callKeyShare.ts), and again at
 * a higher `epoch` each time the key is rotated. The store used to be a plain
 * `call_id → key` map, last writer wins: any accepted `call_key` from anyone,
 * for any `call_id`, replaced the key — so a member of one conversation could
 * set the key a later joiner of a call in ANOTHER conversation would use, and
 * any member could overwrite the key of a call in progress (an older epoch
 * included) to deafen or desynchronise it.
 *
 * Rules, per (conversation, call):
 *   • keyed by the conversation the envelope was routed in, so a key sent in
 *     conversation A can never be the key for a call in conversation B;
 *   • NO key held yet (or only the unowned epoch-0 local adoption — a rejoin's
 *     persisted copy that nobody has confirmed): accept from ANY sender that
 *     passed the sender-trust gate and is not a known non-member. That is what
 *     lets whoever holds the key hand it to a joiner;
 *   • same epoch, same key → 'duplicate'; same epoch, DIFFERENT key → refused
 *     (first writer wins); older epoch → refused;
 *   • a strictly higher epoch replaces the key when it comes from ANY member —
 *     not only the first sender — so rotation continues after the initiator
 *     has left (utils/callKeyShare.ts decides who rotates);
 *   • a sender the caller knows is NOT a member of the conversation is refused.
 * Keys this device generated itself (it started the call, rotated it, or — as
 * the only one present — minted a fresh one) are recorded at their epoch by
 * `recordLocal(generated)`.
 *
 * Lookups return the current (highest-epoch) key, so everyone follows a
 * rotation instead of staying on the initial key.
 *
 * Sender IDENTITY (is this envelope really from that user's device?) is
 * decided before this, by the sender-trust gate (`actionFor(..., 'key_material')`).
 */

export interface CallKeyEntry {
    keyB64: string;
    /** 0 = an unowned local adoption (see recordLocal); accepted keys are >= 1. */
    epoch: number;
    /** Who supplied it. '' = an unowned local adoption. Informational: it
     *  grants no authority over later keys. */
    senderUserId: string;
    /** When this epoch's key is due to be replaced (ms epoch), or null if unknown. */
    rotatesAtMs: number | null;
}

export type CallKeyDecision =
    | 'stored'
    | 'duplicate'
    | 'refused_invalid'
    | 'refused_member'
    | 'refused_epoch'
    | 'refused_held';

/** 32-byte AES key, standard base64 (pad optional). */
const KEY32_B64_RE = /^[A-Za-z0-9+/]{43}=?$/;

/** A key lives this long before the rotator replaces it. */
export const CALL_KEY_ROTATION_MS = 10 * 60_000;

/** The `key_id` the initiator's first broadcast carries. */
export const CALL_KEY_ID_INITIAL = 'initial';

const slot = (conversationId: string, callId: string) => `${conversationId}\u0000${callId}`;

/** A `rotates_at` we will believe: a parseable time no more than an hour out. */
function parseRotatesAt(v: unknown, nowMs: number): number | null {
    if (typeof v !== 'string') return null;
    const t = Date.parse(v);
    if (!Number.isFinite(t)) return null;
    return Math.min(t, nowMs + 60 * 60_000);
}

export class CallKeyStore {
    private readonly entries = new Map<string, CallKeyEntry>();
    /** Highest epoch seen in ANY well-formed key for the call, accepted or not. */
    private readonly seenEpoch = new Map<string, number>();
    /** Who started the call, when we learned it from an `initial` broadcast. */
    private readonly initiators = new Map<string, string>();

    /** A key received in a `call_key` message, after the sender-trust gate. */
    recordRemote(input: {
        conversationId: string | null | undefined;
        callId: string;
        keyB64: unknown;
        epoch?: unknown;
        senderUserId: string;
        /** false = known non-member, true = known member, undefined = unknown. */
        senderIsMember?: boolean;
        /** The message's `key_id`; 'initial' marks the initiator's own broadcast. */
        keyId?: unknown;
        /** The message's `rotates_at` (ISO string). */
        rotatesAt?: unknown;
        /** Injected clock for tests. */
        nowMs?: number;
    }): CallKeyDecision {
        const { conversationId, callId, keyB64, senderUserId } = input;
        if (!conversationId || !callId || !senderUserId || typeof keyB64 !== 'string' || !KEY32_B64_RE.test(keyB64)) return 'refused_invalid';
        const epoch = input.epoch === undefined || input.epoch === null ? 1 : input.epoch;
        if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) return 'refused_invalid';
        if (input.senderIsMember === false) return 'refused_member';

        const nowMs = input.nowMs ?? Date.now();
        const k = slot(conversationId, callId);
        if (epoch > (this.seenEpoch.get(k) ?? 0)) this.seenEpoch.set(k, epoch);
        // The initiator is whoever sent the call's first broadcast. Learned
        // once, and only from a key that was accepted; a later `initial` from
        // someone else does not displace it.
        const learnInitiator = () => {
            if (input.keyId === CALL_KEY_ID_INITIAL && epoch === 1 && !this.initiators.has(k)) this.initiators.set(k, senderUserId);
        };

        const rotatesAtMs = parseRotatesAt(input.rotatesAt, nowMs) ?? nowMs + CALL_KEY_ROTATION_MS;
        const existing = this.entries.get(k);
        // Nothing yet, or only an unowned local adoption (epoch 0): accept
        // from any trusted member.
        if (!existing || existing.epoch < 1) {
            const same = existing?.keyB64 === keyB64;
            this.entries.set(k, { keyB64, epoch, senderUserId, rotatesAtMs });
            learnInitiator();
            return same ? 'duplicate' : 'stored';
        }
        if (epoch < existing.epoch) return 'refused_epoch';
        if (epoch === existing.epoch) {
            if (existing.keyB64 !== keyB64) return 'refused_epoch';
            learnInitiator();
            return 'duplicate';
        }
        // Strictly higher: any member may advance the key (the rotator may not
        // be the one who started the call any more).
        this.entries.set(k, { keyB64, epoch, senderUserId, rotatesAtMs });
        learnInitiator();
        return 'stored';
    }

    /**
     * A key known locally. `generated`: this device created it — it started
     * the call, rotated it, or minted a fresh one while alone in the call — so
     * it is recorded at its epoch (`epoch`, else one past the held key, else 1)
     * and replaces a held key only if that epoch is strictly higher.
     * Otherwise it is ADOPTED (crash-recovery rejoin, a join path re-recording
     * what it read): kept only if nothing is recorded yet, unowned at epoch 0,
     * so the first accepted key from a member replaces it. An adoption never
     * displaces a held key.
     */
    recordLocal(input: {
        conversationId: string | null | undefined;
        callId: string;
        keyB64: string;
        selfUserId: string;
        generated: boolean;
        /** generated only: the epoch to record (must beat the held epoch). */
        epoch?: number;
        nowMs?: number;
    }): CallKeyDecision {
        const { conversationId, callId, keyB64, selfUserId, generated } = input;
        if (!conversationId || !callId || !keyB64 || !selfUserId) return 'refused_invalid';
        if (input.epoch !== undefined && (!Number.isSafeInteger(input.epoch) || input.epoch < 1)) return 'refused_invalid';
        const nowMs = input.nowMs ?? Date.now();
        const k = slot(conversationId, callId);
        const existing = this.entries.get(k);
        if (existing?.keyB64 === keyB64) return 'duplicate';
        if (!generated) {
            if (existing) return 'refused_held';
            this.entries.set(k, { keyB64, epoch: 0, senderUserId: '', rotatesAtMs: null });
            return 'stored';
        }
        const next = input.epoch ?? (existing ? existing.epoch + 1 : 1);
        // A generated epoch must beat what is held (an unowned epoch-0
        // adoption always loses to epoch >= 1).
        if (existing && next <= existing.epoch) return 'refused_epoch';
        if (next > (this.seenEpoch.get(k) ?? 0)) this.seenEpoch.set(k, next);
        // The first key a device generates for a call it did not hear about is
        // the call's own start: this user is the initiator.
        if (!existing && next === 1 && !this.initiators.has(k)) this.initiators.set(k, selfUserId);
        this.entries.set(k, { keyB64, epoch: next, senderUserId: selfUserId, rotatesAtMs: nowMs + CALL_KEY_ROTATION_MS });
        return 'stored';
    }

    /**
     * The current key for a call, or ''. Without a conversation id the call
     * id must be unambiguous across conversations, else nothing is returned.
     */
    get(conversationId: string | null | undefined, callId: string | null | undefined): string {
        if (!callId) return '';
        if (conversationId) return this.entries.get(slot(conversationId, callId))?.keyB64 ?? '';
        let found: CallKeyEntry | null = null;
        for (const [k, e] of this.entries) {
            if (!k.endsWith(`\u0000${callId}`)) continue;
            if (found && found.keyB64 !== e.keyB64) return '';
            found = e;
        }
        return found?.keyB64 ?? '';
    }

    /**
     * The held key as something a member may be handed: only an ACCEPTED key
     * (epoch >= 1). An epoch-0 adoption is this device's unconfirmed copy of
     * what an earlier run persisted — not something to vouch for to others.
     */
    accepted(conversationId: string | null | undefined, callId: string | null | undefined): CallKeyEntry | null {
        if (!conversationId || !callId) return null;
        const e = this.entries.get(slot(conversationId, callId));
        return e && e.epoch >= 1 ? { ...e } : null;
    }

    /** The user who started the call, if this device learned it. */
    initiatorOf(conversationId: string | null | undefined, callId: string | null | undefined): string | null {
        if (!conversationId || !callId) return null;
        return this.initiators.get(slot(conversationId, callId)) ?? null;
    }

    /** The highest epoch seen for the call in any well-formed key (0 = none). */
    highestEpoch(conversationId: string | null | undefined, callId: string | null | undefined): number {
        if (!conversationId || !callId) return 0;
        const k = slot(conversationId, callId);
        return Math.max(this.seenEpoch.get(k) ?? 0, this.entries.get(k)?.epoch ?? 0);
    }

    /** @internal tests */
    entry(conversationId: string, callId: string): CallKeyEntry | undefined {
        return this.entries.get(slot(conversationId, callId));
    }
}
