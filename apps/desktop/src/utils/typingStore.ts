/**
 * Pure state + transition functions for the "X is typing…" indicator.
 *
 * The wire protocol only ever tells us a user STARTED or STOPPED typing in a
 * conversation (`typing:start` / `typing:stop`, handled in useRealtime.ts) —
 * there is no periodic "still typing" ping, and `typing:stop` is best-effort
 * only: the sender (ChatPane.tsx) calls for a `typing:start` on every keystroke
 * (put on the wire at most once a second — see typingSendDecision) and
 * self-clears with `typing:stop` after 3s of local inactivity. If the
 * sender's app is force-quit, crashes, loses network, or the OS suspends it
 * mid-keystroke, that final `typing:stop` is simply never sent, and a
 * receiver that only reacts to start/stop events shows "X is typing…"
 * forever — this is the shipped bug (seen after the sender's app closed).
 *
 * The fix is an expiry: every `typing:start` is stamped with the time it was
 * received, and a user drops out of the indicator once too long has passed
 * with no fresh start — independent of whether a matching `typing:stop` ever
 * arrives. Because the sender re-sends `typing:start` on every keystroke and
 * only goes quiet once it is about to send `typing:stop` (at 3s of local
 * inactivity), a fresh start always arrives well under 3s apart during
 * active typing; `TYPING_EXPIRY_MS` is set a few seconds above that 3s local
 * timeout so it only ever fires as the safety net for a `typing:stop` that
 * never arrived, never as a false timeout on an ordinary typing pause.
 *
 * Kept pure and timestamp-driven — an explicit `now` parameter, never
 * `Date.now()` internally — rather than a per-user `setTimeout` buried in a
 * component: deterministic to unit test, immune to timer drift/throttling in
 * a backgrounded renderer, and self-correcting on every new event without
 * needing to track and clear a timer handle per (conversation, user) pair.
 */

/** A few seconds above the sender's 3s local typing:stop timeout (see above). */
export const TYPING_EXPIRY_MS = 5000;

/** conversation_id -> user_id -> ms timestamp of the last start/refresh seen. */
export type TypingTimestamps = Record<string, Record<string, number>>;

/** conversation_id -> Set of user_ids currently shown as typing — the shape
 *  components (ChatPane/Dashboard) already consume. */
export type TypingUsersView = Record<string, Set<string>>;

/**
 * Receivers ignore a refresh this soon after the last one they recorded
 * (same state reference back → no re-render). Older senders emit a start per
 * keystroke; this caps the re-render rate at one per user per window while
 * keeping the stored timestamp at most this stale — worst-case gap a receiver
 * can see while someone types: TYPING_START_MIN_GAP_MS + 3 s + this < expiry.
 */
export const TYPING_REFRESH_MIN_MS = 400;

/** Minimum spacing of OUTBOUND `typing:start` per conversation (see useRealtime). */
export const TYPING_START_MIN_GAP_MS = 1000;

/**
 * Whether to put an outbound typing event on the wire, updating `lastStart`
 * (conversation → ms of the last start sent). Starts are throttled to one per
 * TYPING_START_MIN_GAP_MS per conversation; a stop always goes and re-arms.
 */
export function typingSendDecision(
    lastStart: Map<string, number>,
    event: 'typing:start' | 'typing:stop',
    conversationId: string,
    now: number,
): boolean {
    if (event === 'typing:stop') {
        lastStart.delete(conversationId);
        return true;
    }
    const last = lastStart.get(conversationId);
    if (last !== undefined && now - last < TYPING_START_MIN_GAP_MS) return false;
    lastStart.set(conversationId, now);
    return true;
}

/** Record a `typing:start` (or a refresh of an existing one) for a user in a conversation.
 *  With `minRefreshMs`, a refresh of an entry recorded less than that long ago
 *  returns the same reference (no change). */
export function recordTypingStart(
    state: TypingTimestamps,
    conversationId: string,
    userId: string,
    now: number,
    minRefreshMs = 0,
): TypingTimestamps {
    const prev = state[conversationId]?.[userId];
    if (minRefreshMs > 0 && prev !== undefined && now - prev >= 0 && now - prev < minRefreshMs) return state;
    return {
        ...state,
        [conversationId]: { ...state[conversationId], [userId]: now },
    };
}

/** Record an explicit `typing:stop` for a user in a conversation. No-ops if absent (returns the same reference). */
export function recordTypingStop(
    state: TypingTimestamps,
    conversationId: string,
    userId: string,
): TypingTimestamps {
    if (!state[conversationId] || !(userId in state[conversationId])) return state;
    const nextConv = { ...state[conversationId] };
    delete nextConv[userId];
    return { ...state, [conversationId]: nextConv };
}

/**
 * Drop a user's typing state from every conversation at once — used when
 * that user's presence goes offline, which is at least as strong a signal as
 * an explicit stop (an offline client cannot still be typing). No-ops
 * (returns the same reference) if the user wasn't recorded as typing
 * anywhere, so callers can invoke this unconditionally on every presence
 * update without worrying about extra re-renders.
 */
export function clearTypingForUser(state: TypingTimestamps, userId: string): TypingTimestamps {
    let changed = false;
    const next: TypingTimestamps = {};
    for (const [conversationId, users] of Object.entries(state)) {
        if (userId in users) {
            changed = true;
            const nextUsers = { ...users };
            delete nextUsers[userId];
            next[conversationId] = nextUsers;
        } else {
            next[conversationId] = users;
        }
    }
    return changed ? next : state;
}

/**
 * Drop every timestamp older than `expiryMs` relative to `now`, across all
 * conversations. Called on an interval (useRealtime.ts) so a missed
 * `typing:stop` self-heals even with no further WS traffic for that
 * conversation. No-ops (returns the same reference) when nothing expired, so
 * it's safe to call frequently without causing spurious re-renders.
 */
export function pruneExpiredTyping(state: TypingTimestamps, now: number, expiryMs: number = TYPING_EXPIRY_MS): TypingTimestamps {
    let changed = false;
    const next: TypingTimestamps = {};
    for (const [conversationId, users] of Object.entries(state)) {
        const nextUsers: Record<string, number> = {};
        let convChanged = false;
        for (const [userId, ts] of Object.entries(users)) {
            if (now - ts < expiryMs) {
                nextUsers[userId] = ts;
            } else {
                convChanged = true;
            }
        }
        if (!convChanged) {
            next[conversationId] = users;
            continue;
        }
        changed = true;
        // Drop the conversation key entirely once it's empty, rather than
        // keeping a `{}` around — matches recordTypingStop's shape and keeps
        // toTypingUsersView's output free of empty Sets.
        if (Object.keys(nextUsers).length > 0) next[conversationId] = nextUsers;
    }
    return changed ? next : state;
}

/** Project the timestamp store into the Set-shaped view components consume. */
export function toTypingUsersView(state: TypingTimestamps): TypingUsersView {
    const view: TypingUsersView = {};
    for (const [conversationId, users] of Object.entries(state)) {
        const ids = Object.keys(users);
        if (ids.length > 0) view[conversationId] = new Set(ids);
    }
    return view;
}
