/**
 * "Message yourself" — the pure rules the UI shares.
 *
 * A self conversation is an ordinary DM (type 'dm') with ONE member: you. It is
 * never pre-created or pre-listed: it does not exist until the first time you
 * pick yourself in the new-message search, after which it is a normal row in
 * the DM list. Everything the UI needs to branch on lives here so the rules are
 * unit-testable without React and cannot drift between the places that apply
 * them (list row, chat header, composer, notifications, search).
 *
 * Identity: the server marks the row `is_self` and sets `other_user_id` to the
 * caller's OWN id (GET /v1/conversations). The client derives self-ness from
 * either, so a chat that only carries `{ type, other_user_id }` in React state
 * (the `activeChat` shape) is still recognised without plumbing a new field
 * through every setter.
 */

export const SELF_LABEL = 'You';

/** What every self row is called: `<your name> (You)`. */
export function selfConversationTitle(username: string): string {
    const name = (username || '').trim();
    return name ? `${name} (${SELF_LABEL})` : SELF_LABEL;
}

interface ConvLike {
    type?: string | null;
    other_user_id?: string | null;
    is_self?: boolean | null;
}

/** True when `conv` is the caller's own "message yourself" DM. */
export function isSelfDm(conv: ConvLike | null | undefined, myUserId: string | null | undefined): boolean {
    if (!conv || conv.type !== 'dm') return false;
    if (conv.is_self === true) return true;
    return !!myUserId && !!conv.other_user_id && conv.other_user_id === myUserId;
}

/**
 * Label the self row of a freshly fetched conversation list as
 * "<name> (You)". The server sends the plain username (the label is a
 * presentation choice, and the phone app owns its own wording).
 * Pure: returns a new array, never mutates the input; every other row is
 * returned by reference, untouched.
 */
export function labelSelfConversations<T extends ConvLike & { title?: string | null }>(
    rows: readonly T[],
    myUserId: string | null | undefined,
): T[] {
    return rows.map(r => {
        if (!isSelfDm(r, myUserId)) return r;
        const base = (r.title || '').replace(/ \(You\)$/, '');
        return { ...r, title: selfConversationTitle(base) };
    });
}

/**
 * Does the search box text point at yourself? Used by the new-message picker
 * and the DM list filter. Empty/blank never matches — you are NOT listed until
 * you search, which is the whole point of "don't add yourself to the chat
 * history". Matches your name (substring, like every other row) or the words
 * people actually type for it.
 */
export function selfMatchesQuery(query: string, username: string | null | undefined): boolean {
    const q = (query || '').trim().toLowerCase();
    if (!q) return false;
    if (q === 'me' || q === 'myself' || q === 'self') return true;
    const name = (username || '').trim().toLowerCase();
    return !!name && name.includes(q);
}

/**
 * What a self chat does NOT do. Single source for the UI's "hide / disable"
 * decisions — every flag is `false` for a self chat and `true` otherwise.
 * Only the entries that change are listed; anything not here behaves like a DM
 * (text, replies, edits, deletes, reactions, attachments, GIFs, pins, save for
 * me, in-chat search, retention).
 */
export interface ChatAffordances {
    /** Emit `typing:start` / `typing:stop`. */
    typingIndicators: boolean;
    /** Send a visible read receipt (a self-only read still syncs your badge). */
    readReceipts: boolean;
    /** Phone / video buttons. */
    calls: boolean;
    /** Safety-number / trust shield in the header. */
    trustBadge: boolean;
    /** Friend actions: add to group, remove friend, block, report, invite to server. */
    friendActions: boolean;
    /** Per-chat notification mode picker (your own messages never notify). */
    notificationMode: boolean;
    /** The friend-status lookup that gates the composer on unfriend/block. */
    friendshipLookup: boolean;
}

export function chatAffordances(isSelf: boolean): ChatAffordances {
    const on = !isSelf;
    return {
        typingIndicators: on,
        readReceipts: on,
        calls: on,
        trustBadge: on,
        friendActions: on,
        notificationMode: on,
        friendshipLookup: on,
    };
}

/**
 * Must an INCOMING message stay silent — no unread count, no mention count, no
 * toast, no sound? True for anything you sent yourself (self-fan-out delivers
 * your own messages from your other devices) and, belt and braces, for EVERY
 * message in your self conversation regardless of what its sender field says:
 * the chat has one participant, so there is nobody else it could be from, and a
 * message that arrives there from a sibling device must never buzz this one.
 */
export function isSilentIncoming(p: {
    senderUserId?: string | null;
    myUserId?: string | null;
    convIsSelf: boolean;
}): boolean {
    if (p.convIsSelf) return true;
    return !!p.myUserId && p.senderUserId === p.myUserId;
}

export interface DmPickerRow {
    user_id: string;
    username: string;
    avatar_url?: string | null;
    isSelf?: boolean;
}

/**
 * The people shown in the new-message picker for the current search text.
 * Friends are filtered by name, exactly as before. YOU are prepended only when
 * the search points at you (see selfMatchesQuery) — never in the empty-search
 * list, which is what keeps the self chat out of sight until it is wanted.
 */
export function buildDmPickerResults(p: {
    search: string;
    me: { user_id?: string | null; username?: string | null; avatar_url?: string | null } | null | undefined;
    friends: readonly DmPickerRow[];
}): DmPickerRow[] {
    const q = p.search.toLowerCase();
    const friends = p.friends.filter(f => f.username.toLowerCase().includes(q));
    const me = p.me;
    if (me?.user_id && selfMatchesQuery(p.search, me.username)) {
        return [
            { user_id: me.user_id, username: me.username ?? '', avatar_url: me.avatar_url ?? undefined, isSelf: true },
            // Never list yourself twice, whatever the friends payload contains.
            ...friends.filter(f => f.user_id !== me.user_id),
        ];
    }
    return friends.filter(f => f.user_id !== me?.user_id);
}
