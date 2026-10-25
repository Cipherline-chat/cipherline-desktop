/**
 * milestones — the "firsts" and the 100th call, wired to the moments.
 *
 * The DECISIONS are pure and live in utils/moments.ts (messageDeliveredMoment,
 * callConnectedMoment, serverCreatedMoment); this file is the thin I/O around
 * them: the one persisted fact (a per-account COUNT of calls that connected),
 * the account's own set of found eggs (so a second machine never replays a
 * once-ever moment), and the window event that carries "a call connected" from
 * where LiveKit says so (CallPane) to the one component that knows who you are
 * (components/moments/MilestoneWatch.tsx).
 *
 * Privacy (doctrine rule 8): triggers are structural facts. The message text,
 * the recipient, the call's participants, the server's name — none of it is
 * read here. A message counts as "delivered" because the server accepted it;
 * a call counts because the media room connected; a server because it was
 * created. The only thing stored is one integer, on this device, in the
 * encrypted local store (and the backup, so a restore keeps the count).
 */
import { secureLocalStore } from './secureLocalStore';
import { eggsFound } from './eggProgress';
import { requestMoment } from './moments';
import { parseCallCount, callConnectedMoment } from './moments';
import { messageDeliveredMoment } from './moments';
import { serverCreatedMoment } from './moments';

/** Fired on window when a call's media room connects (once per call). Carries no detail. */
export const CALL_CONNECTED_EVENT = 'cipherline:call-connected';

/** Per-account counter of calls that connected (an integer, as text). */
export const callCountKey = (userId: string) => `cipherline_calls_connected_${userId}`;

/** CallPane: the media room connected. Fire-and-forget; nothing happens if nobody listens. */
export function announceCallConnected(): void {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    try { window.dispatchEvent(new Event(CALL_CONNECTED_EVENT)); } catch { /* cosmetic */ }
}

/**
 * Count one connected call and ask for the moment it earns, if any. Waits for
 * the account-bound store to be ready (a record read cold right after sign-in
 * would restart the count at 0).
 */
export function noteCallConnected(userId: string | null | undefined, createdIso: string | null | undefined): void {
    if (!userId) return;
    void secureLocalStore.whenAccountReady().then(() => {
        const before = parseCallCount(secureLocalStore.getItem(callCountKey(userId)));
        try { secureLocalStore.setItem(`cipherline_calls_connected_${userId}`, String(before + 1)); } catch { /* the count is cosmetic */ }
        const id = callConnectedMoment(before, createdIso, eggsFound());
        if (id) requestMoment(id);
    }).catch(() => { /* cosmetic */ });
}

/** ChatPane: the server accepted a message of yours (not an edit, not your own notes). */
export function noteMessageDelivered(createdIso: string | null | undefined, isSelfChat: boolean): void {
    const id = messageDeliveredMoment(createdIso, eggsFound(), isSelfChat);
    if (id) requestMoment(id);
}

/**
 * Dashboard: a server was created. `ownedBefore` = how many servers in the
 * LOADED list you owned beforehand (null while the list was loading).
 */
export function noteServerCreated(ownedBefore: number | null): void {
    const id = serverCreatedMoment(ownedBefore, eggsFound());
    if (id) requestMoment(id);
}
