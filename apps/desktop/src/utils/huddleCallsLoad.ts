/**
 * How a per-channel `GET /v1/huddles/:hid/calls` answer is folded into the
 * client's `huddleCalls` map (hooks/useServers.loadHuddleCalls).
 *
 * Owner report 2026-11-23 (0.1.4-staging.277): "I was in a call and it
 * completely closed like everyone left even though everyone's still in there
 * and other people could see it. After going out of the server and back in I
 * was able to see it again."
 *
 * What happened: loadHuddleCalls used to reset a channel's calls to `[]` on ANY
 * failed request — a dropped connection, a timeout, a 5xx, a 429. Those are
 * exactly the conditions of a reconnect storm (beta diagnostics: `ws_churn`,
 * 5 reconnects in 10 minutes, on the owner's desktop at the time), and every
 * reconnect fires this GET for every Calls channel the client knows (55 for
 * the owner) plus, through Dashboard's auto-load effect, once per active-server
 * Calls channel for every server whose channel list finished reloading. That
 * is well past the route's 300/min `default` bucket after two reconnects in a
 * minute, so the tail of the burst got 429s, and each 429 emptied the channel:
 * the call vanished. Nothing brought it back on its own either, because
 * `huddle:participant` events only edit a call that is already in the map and
 * the cross-server seed only runs every 5 minutes. Re-opening the server ran
 * the GET once more, now inside the budget, which is why that "fixed" it.
 *
 * The rule now: only an answer that says the calls are really not there for us
 * clears them — 403 (no VIEW_CHANNEL any more) and 404 (the channel is gone).
 * A request that simply failed says nothing about the calls, so the roster we
 * have stays, and the next event / seed / successful load corrects it. That is
 * the same stance as `seedVoicePresence` ("a stale roster is a better outcome
 * than blanking the rail on one failed GET").
 *
 * Privacy is unchanged: we never keep or show anything the server did not
 * already send us, and a 403 still drops the channel's calls at once.
 */
import type { HuddleCallInfo } from '../hooks/useServers';

/** HTTP status of a failed request, when it got an answer at all. */
function statusOf(err: unknown): number | null {
    const status = (err as { response?: { status?: unknown } } | null)?.response?.status;
    return typeof status === 'number' ? status : null;
}

/**
 * Does this failure mean the channel's calls are genuinely not visible to us?
 * True only for 403 / 404. Network errors, timeouts, 429 and 5xx are transient
 * and must not touch the roster.
 */
export function huddleCallsLoadFailureClears(err: unknown): boolean {
    const status = statusOf(err);
    return status === 403 || status === 404;
}

/** The map after a failed load of one channel's calls. Returns `prev` itself
 *  (no re-render) when the failure is transient. */
export function applyHuddleCallsLoadFailure(
    prev: Record<string, HuddleCallInfo[]>,
    huddleId: string,
    err: unknown,
): Record<string, HuddleCallInfo[]> {
    if (!huddleCallsLoadFailureClears(err)) return prev;
    return { ...prev, [huddleId]: [] };
}

/** Short reason for the console line a kept roster leaves behind. */
export function huddleCallsLoadFailureReason(err: unknown): string {
    const status = statusOf(err);
    if (status !== null) return `HTTP ${status}`;
    const code = (err as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : 'network';
}

/**
 * A `huddle:participant` JOIN for a call this client does not have means our
 * map is missing a live call (a load that failed before this fix, a seed that
 * landed after the spawn event, a `call_spawned` lost while the socket was
 * down). The event alone cannot rebuild the call (no name, no spawner, no
 * roster), so the caller re-reads that ONE channel. Event-driven, one channel,
 * and only when the map is provably wrong: this is not polling.
 *
 * A LEAVE for an unknown call is the ordinary tail of a call that was just
 * destroyed, so it never triggers a read.
 */
export function participantEventNeedsReload(
    calls: Record<string, HuddleCallInfo[]>,
    huddleId: string,
    callId: string,
    action: 'join' | 'leave',
): boolean {
    if (action !== 'join') return false;
    return !(calls[huddleId] ?? []).some(c => c.call_id === callId);
}

/** The ids of one server's Calls channels, as a stable string, so an effect
 *  that loads them re-runs when that list changes and not every time ANY
 *  server's channel list is replaced with an equal copy. */
export function huddleChannelKey(channels: ReadonlyArray<{ channel_id: string; kind: string }> | undefined): string {
    if (!channels) return '';
    return channels.filter(c => c.kind === 'huddle').map(c => c.channel_id).join(',');
}
