/**
 * Other people's presence, as this client knows it — the pure half.
 *
 * Three server events feed it (apps/api/src/gateway/presence.logic.ts is the
 * other end):
 *
 *   • `user:status_changed`      one user changed. Live, in order.
 *   • `user:friends_status_batch` every accepted friend, on each (re)connect.
 *   • `presence:snapshot`        every member of our presence audience
 *                                (friends, DM/group co-members, server
 *                                co-members) who is visibly present, on each
 *                                (re)connect, with `complete: true` — anyone
 *                                NOT listed is offline. Newer servers only.
 *
 * ── Why a bus, not a state slot ─────────────────────────────────────────
 * `useRealtime` used to hand these over as one-value state slots
 * (`statusChangedEvent`), consumed by an effect in `useUserStatus`. Two
 * `user:status_changed` frames arriving before React rendered — which is
 * exactly what happens when a server deploy reconnects everyone at once, or
 * the sweep takes several stale statuses down in one tick — overwrote each
 * other, and the effect only ever saw the last. The earlier ones were simply
 * lost, and whoever they described stayed at their old status until they
 * changed again. The bus delivers every event, in order, to a reducer applied
 * with functional state updates, so nothing is dropped.
 */

import type { UserStatus, FriendStatusEntry } from './userStatusModel';

export interface WirePresence {
    user_id: string;
    status: string;
    custom_status_text?: string | null;
    custom_status_emoji?: string | null;
    game_name?: string | null;
    /** Only ever true while visibly present on phones alone. Absent from
     *  older servers → false. */
    on_mobile?: boolean;
    last_seen_at?: string | null;
}

export type PresenceEvent =
    | { kind: 'changed'; entry: WirePresence }
    | { kind: 'friends_batch'; entries: WirePresence[] }
    | { kind: 'snapshot'; entries: WirePresence[]; complete: boolean };

const KNOWN: readonly UserStatus[] = ['online', 'away', 'dnd', 'offline'];

/** An unknown status string (a newer server, a corrupted frame) must never
 *  render as present — the safe reading of "I don't know" is offline. */
export function normalizeStatus(s: unknown): UserStatus {
    return typeof s === 'string' && (KNOWN as readonly string[]).includes(s) ? (s as UserStatus) : 'offline';
}

export function toEntry(w: WirePresence): FriendStatusEntry {
    const status = normalizeStatus(w.status);
    const visible = status !== 'offline';
    return {
        status,
        custom_status_text: visible ? (w.custom_status_text ?? null) : null,
        custom_status_emoji: visible ? (w.custom_status_emoji ?? null) : null,
        current_game: visible ? (w.game_name ?? null) : null,
        on_mobile: visible && w.on_mobile === true,
    };
}

const OFFLINE_ENTRY: FriendStatusEntry = {
    status: 'offline',
    custom_status_text: null,
    custom_status_emoji: null,
    current_game: null,
    on_mobile: false,
};

function sameEntry(a: FriendStatusEntry | undefined, b: FriendStatusEntry): boolean {
    return !!a
        && a.status === b.status
        && a.custom_status_text === b.custom_status_text
        && a.custom_status_emoji === b.custom_status_emoji
        && a.current_game === b.current_game
        && (a.on_mobile ?? false) === (b.on_mobile ?? false);
}

/**
 * Apply one event. Returns `prev` itself when nothing changed, so a React
 * state setter using this does not re-render for a no-op.
 */
export function applyPresenceEvent(
    prev: Record<string, FriendStatusEntry>,
    ev: PresenceEvent,
): Record<string, FriendStatusEntry> {
    if (ev.kind === 'changed') {
        const e = toEntry(ev.entry);
        if (sameEntry(prev[ev.entry.user_id], e)) return prev;
        return { ...prev, [ev.entry.user_id]: e };
    }

    let next: Record<string, FriendStatusEntry> | null = null;
    const put = (id: string, e: FriendStatusEntry) => {
        const cur = (next ?? prev)[id];
        if (sameEntry(cur, e)) return;
        if (!next) next = { ...prev };
        next[id] = e;
    };

    for (const w of ev.entries) put(w.user_id, toEntry(w));

    if (ev.kind === 'snapshot' && ev.complete) {
        // The contract: anyone we know who is not listed is offline. This is
        // what corrects a non-friend whose change we missed while our own
        // connection was down.
        const listed = new Set(ev.entries.map(w => w.user_id));
        for (const id of Object.keys(prev)) {
            if (!listed.has(id)) put(id, OFFLINE_ENTRY);
        }
    }
    return next ?? prev;
}

// ── The bus ───────────────────────────────────────────────────────────────

type Listener = (ev: PresenceEvent) => void;
const listeners = new Set<Listener>();

export const presenceBus = {
    emit(ev: PresenceEvent): void {
        for (const l of Array.from(listeners)) {
            try { l(ev); } catch (e) { console.error('[presenceBus] listener failed:', e); }
        }
    },
    subscribe(l: Listener): () => void {
        listeners.add(l);
        return () => { listeners.delete(l); };
    },
};

/**
 * The status to show for someone, given what we know.
 *
 *   • A live entry wins (WS events / snapshot).
 *   • Otherwise, before any complete snapshot has arrived, the caller's
 *     fallback (e.g. the server roster's `status` column) is the best we have.
 *   • After a complete snapshot, an unknown member of our audience is
 *     offline — the snapshot listed everyone who wasn't, and every change
 *     since has arrived as an event. Trusting a roster fetched an hour ago
 *     over that would bring back exactly the stale state the snapshot exists
 *     to remove.
 */
export function resolvePresence(
    live: FriendStatusEntry | undefined,
    fallback: { status?: string | null; on_mobile?: boolean | null } | undefined,
    snapshotAuthoritative: boolean,
): { status: UserStatus; onMobile: boolean } {
    if (live) return { status: live.status, onMobile: live.status !== 'offline' && !!live.on_mobile };
    if (snapshotAuthoritative || !fallback) return { status: 'offline', onMobile: false };
    const status = normalizeStatus(fallback.status);
    return { status, onMobile: status !== 'offline' && !!fallback.on_mobile };
}
