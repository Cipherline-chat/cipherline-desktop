/**
 * channelSaveActions — the two REMOVING channel actions, "Remove from server"
 * (unsave, DELETE /v1/channels/:cid/saves/:mid, SAVE_MESSAGES) and "Unpin"
 * (DELETE /v1/channels/:cid/pins/:mid, MANAGE_MESSAGES), with their
 * optimistic update and what happens when the server says no.
 *
 * Pulled out of Dashboard so the failure handling is testable. The bug it
 * fixes (staging 2026-10-08, "you cannot un-server-save a message", "same
 * with unpinning"): every failure used to roll the optimistic change back,
 * including a 404 — and a 404 here means the server ALREADY agrees the
 * message is not saved / not pinned. Rolling back on it put the icon back on
 * a message the server had no row for, and every retry did the same, so the
 * save or pin could never be removed from this client. (The 404s themselves
 * came from an API-side hang: a save/pin that never committed — see
 * AuditLogService.write in apps/api — but a client that disagrees with a
 * plain "it isn't saved" is wrong on its own.)
 *
 * Owner rules this keeps (2026-09-27): pin implies save; unpin KEEPS the save;
 * a pinned message cannot be unsaved — unpin first (the API answers 409
 * MESSAGE_PINNED, and the menus never offer it, see messageMenuGating).
 */
import { asSaveRequestError, withId, withoutId } from './channelServerSaves';

/** A request that hangs must not leave the optimistic state up forever. */
export const SAVE_REQUEST_TIMEOUT_MS = 20_000;

type IdListUpdate = (channelId: string, update: (ids: string[] | undefined) => string[]) => void;

export interface ChannelSaveActionDeps {
    apiBase: string;
    token: string;
    http: { delete: (url: string, config: { headers: Record<string, string>; timeout: number }) => Promise<unknown> };
    /** Functional update of the channel's SAVED id list (channelServerSaves). */
    updateSaved: IdListUpdate;
    /** Functional update of the channel's PINNED id list (channelPinnedIds). */
    updatePinned: IdListUpdate;
    /** Tell the user why it didn't happen (a toast). */
    notify: (message: string) => void;
}

/**
 *  'ok'           — removed.
 *  'already-gone' — the server has no such save/pin (404): the optimistic
 *                   removal already matches it, so it is KEPT, not rolled back.
 *  'pinned'       — unsave only: the message is pinned (409 MESSAGE_PINNED);
 *                   rolled back and shown as pinned.
 *  'forbidden'    — 403; rolled back.
 *  'failed'       — anything else (network, 5xx, timeout); rolled back.
 */
export type RemoveOutcome = 'ok' | 'already-gone' | 'pinned' | 'forbidden' | 'failed';

export function classifyRemoveFailure(err: unknown): Exclude<RemoveOutcome, 'ok'> {
    const res = asSaveRequestError(err).response;
    if (res?.data?.code === 'MESSAGE_PINNED') return 'pinned';
    if (res?.status === 404) return 'already-gone';
    if (res?.status === 403) return 'forbidden';
    return 'failed';
}

const authed = (token: string) => ({ headers: { Authorization: `Bearer ${token}` }, timeout: SAVE_REQUEST_TIMEOUT_MS });

/** "Remove from server" — the message expires on its original clock again. */
export async function unsaveChannelMessage(deps: ChannelSaveActionDeps, channelId: string, msgId: string): Promise<RemoveOutcome> {
    deps.updateSaved(channelId, ids => withoutId(ids, msgId));
    try {
        await deps.http.delete(`${deps.apiBase}/channels/${channelId}/saves/${msgId}`, authed(deps.token));
        return 'ok';
    } catch (err: unknown) {
        const outcome = classifyRemoveFailure(err);
        if (outcome === 'already-gone') return outcome;
        // Roll back: the server still says it's saved.
        deps.updateSaved(channelId, ids => withId(ids, msgId));
        if (outcome === 'pinned') {
            // Pinned (by someone else meanwhile, or our pinned list was stale):
            // reflect it, and say why.
            deps.updatePinned(channelId, ids => withId(ids, msgId));
            deps.notify('This message is pinned. Unpin it first to remove it from the server.');
        } else if (outcome === 'forbidden') {
            deps.notify("You don't have permission to remove saved messages in this channel.");
        } else {
            console.error('[ServerSave] unsave failed:', err);
            deps.notify("Couldn't remove this message from the server. Try again.");
        }
        return outcome;
    }
}

/** "Unpin" — the message STAYS saved, so the saved list is never touched. */
export async function unpinChannelMessage(deps: ChannelSaveActionDeps, channelId: string, msgId: string): Promise<RemoveOutcome> {
    deps.updatePinned(channelId, ids => withoutId(ids, msgId));
    try {
        await deps.http.delete(`${deps.apiBase}/channels/${channelId}/pins/${msgId}`, authed(deps.token));
        return 'ok';
    } catch (err: unknown) {
        const outcome = classifyRemoveFailure(err);
        if (outcome === 'already-gone') return outcome;
        // Roll back: the server still says it's pinned.
        deps.updatePinned(channelId, ids => withId(ids, msgId));
        if (outcome === 'forbidden') {
            deps.notify("You don't have permission to unpin messages in this channel.");
        } else {
            console.error('[ServerPin] unpin failed:', err);
            deps.notify("Couldn't unpin this message. Try again.");
        }
        return outcome;
    }
}
