/**
 * Client-side check that a channel-key distributor could legitimately hold
 * the key it is handing us: a current member of the server who can VIEW the
 * channel.
 *
 * ── What this is (and is not) ───────────────────────────────────────────────
 * DEFENCE IN DEPTH. The API already refuses a key-handshake whose sender is
 * not a member with VIEW_CHANNEL (VIEW|CONNECT for a Calls channel) — see
 * `submitHandshakeAuthorized` in the API's channel-key-handshakes service.
 * This catches what that cannot: an envelope still pending from a distributor
 * who has since been removed or lost access, and a server-side authorization
 * regression. It does NOT protect against a malicious server: the roster and
 * viewer sets it consults come from that same server.
 *
 * ── Data it uses ────────────────────────────────────────────────────────────
 * Only what the client already caches: the server roster
 * (`serverRosterCache`) and, for channels the server marks
 * `view_scope: 'restricted'`, the viewer set (`channelViewerCache`). No fetch
 * on the normal path.
 *
 * ── Reliability rules (the channel-key path must never strand a key) ───────
 *   - Data absent (never loaded, evicted, fetch failed): 'unverified' →
 *     install. The server already authorized the sender; refusing here would
 *     turn a cold cache into "Waiting for channel keys".
 *   - A negative answer from data that may be stale: 'refresh' → the caller
 *     leaves the envelope un-ACKed WITHOUT counting a failure, refreshes the
 *     data, and pulls again. Bounded by the caller (MAX_DISTRIBUTOR_REFRESHES);
 *     past the bound it installs as 'unverified'.
 *   - Only a negative from FRESH data is 'reject'. The caller routes that
 *     through the ordinary bounded-failure path, which re-asks the channel's
 *     key holders, so a legitimate holder still answers.
 *
 *   - A HISTORICAL epoch (older than the channel's latest) is never rejected,
 *     only reported 'unverified'. Its key is used to READ old messages, never
 *     to send, and the common way to meet an unauthorized distributor there
 *     is benign: a holder who distributed while authorized and has since left
 *     or lost access (their pending envelope is still the only copy). The
 *     security value of this check is the key we would SEND with — a key
 *     chosen by a non-viewer would expose what we post — so the reject is
 *     scoped to that.
 *
 * Calls channels: the cached viewer set is VIEW_CHANNEL only, so CONNECT is
 * not checked here (the server still checks it).
 */
import type { ChannelViewers } from './channelViewerCache';

export type DistributorVerdict = 'accept' | 'unverified' | 'refresh' | 'reject';

/** Refresh-and-retry rounds per (channel, epoch, distributor) before installing as unverified. */
export const MAX_DISTRIBUTOR_REFRESHES = 2;

export interface DistributorCheckInput {
    distributorUserId: string | null | undefined;
    selfUserId: string | null | undefined;
    /** The channel as listed by `GET /servers/:sid/channels`; null when unknown. */
    channel: { view_scope?: 'all' | 'restricted' } | null | undefined;
    /** Member ids from the cached roster, or null when no roster is cached. */
    roster: { memberIds: ReadonlySet<string>; fresh: boolean } | null;
    /** The cached viewer entry for a restricted channel, or null when none is cached. */
    viewers: { viewers: ChannelViewers | null; fresh: boolean } | null;
    /** True when the envelope's epoch is older than the channel's known latest epoch. */
    historicalEpoch?: boolean;
}

const RANK: Record<DistributorVerdict, number> = { accept: 0, unverified: 1, refresh: 2, reject: 3 };
const worst = (a: DistributorVerdict, b: DistributorVerdict): DistributorVerdict => (RANK[a] >= RANK[b] ? a : b);

export function judgeKeyDistributor(input: DistributorCheckInput): DistributorVerdict {
    const who = input.distributorUserId;
    // No claimed distributor: nothing to authorize against. (The engine
    // already refuses envelopes without a sender user id.)
    if (!who) return 'reject';
    // Our own account: this is a MEMBERSHIP check, and the receiver is a
    // member by construction. That the envelope really is from one of our
    // own devices is NOT decided here — the caller's sender-identity gate
    // judges self claims against the own-device ledger (selfSenderTrust.ts)
    // before this runs.
    if (who === input.selfUserId) return 'accept';
    if (!input.channel) return 'unverified';

    let membership: DistributorVerdict;
    if (!input.roster) membership = 'unverified';
    else if (input.roster.memberIds.has(who)) membership = 'accept';
    else membership = input.roster.fresh ? 'reject' : 'refresh';

    let viewing: DistributorVerdict;
    if (input.channel.view_scope !== 'restricted') {
        // 'all' = every member can see it, so membership is the whole check.
        // An absent view_scope is an API without the marker: no viewer data.
        viewing = input.channel.view_scope === 'all' ? 'accept' : 'unverified';
    } else if (!input.viewers || !input.viewers.viewers) {
        viewing = 'unverified';
    } else if (input.viewers.viewers.all || input.viewers.viewers.ids.has(who)) {
        viewing = 'accept';
    } else {
        viewing = input.viewers.fresh ? 'reject' : 'refresh';
    }

    const verdict = worst(membership, viewing);
    if (input.historicalEpoch && (verdict === 'reject' || verdict === 'refresh')) return 'unverified';
    return verdict;
}

/**
 * Whether an envelope's epoch is historical for the channel: strictly older
 * than the latest epoch the channel list reported. Unknown latest → false
 * (treated as a potential send epoch, i.e. the strict side).
 */
export function isHistoricalEpoch(epoch: number, latestEpoch: number | undefined): boolean {
    return typeof latestEpoch === 'number' && epoch < latestEpoch;
}

/** Key for the per-(channel, epoch, distributor) refresh counter. */
export function distributorRefreshKey(channelId: string, epoch: number, distributorUserId: string): string {
    return `${channelId}:${epoch}:${distributorUserId}`;
}

/**
 * What to do with a 'refresh' verdict given how many refresh rounds this
 * (channel, epoch, distributor) has already had.
 */
export function resolveRefreshVerdict(refreshesSoFar: number): 'refresh' | 'unverified' {
    return refreshesSoFar < MAX_DISTRIBUTOR_REFRESHES ? 'refresh' : 'unverified';
}
