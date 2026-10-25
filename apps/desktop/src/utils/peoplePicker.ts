/**
 * People picker — the pure half.
 *
 * The rules behind the New Message dialog's friend list (and, by design, any
 * other "pick people" dialog: create group, add to group, share to…), kept
 * free of React so they are unit-testable and cannot drift between dialogs:
 *
 *   - who is shown, in what order, under which section heading;
 *   - what each row says under the name (status line) and beside it (last
 *     activity);
 *   - what every key does (one decision function, so the keyboard contract is
 *     written down in exactly one place);
 *   - what the footer's primary button does for a given selection.
 *
 * Privacy: everything here is derived from state the client ALREADY holds —
 * the friends payload, the live presence map, and `lastActivityAt`, which is
 * the device-local "when did I last see a message in this conversation" map
 * Dashboard keeps encrypted at rest. Nothing new is fetched or sent.
 */
import type { UserStatus } from './userStatusModel';
import { STATUS_CONFIG } from './userStatusModel';
import { resolveActiveStatus, type StatusMap, type PresenceMap } from './activeNow';

/** A friend row as the picker receives it (the `/friends` `accepted` shape, plus the self row). */
export interface PickerFriend {
    user_id: string;
    username: string;
    discriminator?: number | null;
    avatar_url?: string | null;
    /** The friends payload's own status — only a fallback when no live map is supplied. */
    status?: string | null;
    /** True for the "message yourself" row (see selfConversation.ts). */
    isSelf?: boolean;
}

/** Live status entry (the `friendStatuses` map from useUserStatus). */
export interface PickerStatusEntry {
    status?: string | null;
    custom_status_text?: string | null;
    custom_status_emoji?: string | null;
    current_game?: string | null;
    on_mobile?: boolean;
}

export interface PickerPerson extends PickerFriend {
    status: UserStatus;
    onMobile: boolean;
    currentGame: string | null;
    /** One-line status under the name: custom status, game, or the plain status label. */
    secondary: string;
    /** The existing DM with this person, if there is one. */
    conversationId: string | null;
    hasChat: boolean;
    /** Device-local time of the last message seen in that DM (ms), if known. */
    lastActivityAt: number | null;
}

export type PickerSectionKey = 'recent' | 'online' | 'offline' | 'results';

export interface PickerSection {
    key: PickerSectionKey;
    label: string;
    people: PickerPerson[];
}

interface ConversationLike {
    conversation_id?: string | null;
    id?: string | null;
    type?: string | null;
    other_user_id?: string | null;
    is_self?: boolean | null;
}

/** How many "Recent" rows the unfiltered list leads with. */
export const RECENT_LIMIT = 5;

const KNOWN: readonly UserStatus[] = ['online', 'away', 'dnd', 'offline'];
const asStatus = (s: unknown): UserStatus =>
    typeof s === 'string' && (KNOWN as readonly string[]).includes(s) ? (s as UserStatus) : 'offline';

/**
 * The status line under a name. Offline people never show a custom status or
 * a game — the same rule StatusIcon applies, so an "invisible" friend's last
 * custom status cannot leak through this dialog.
 */
export function personSecondary(p: {
    isSelf?: boolean;
    status: UserStatus;
    onMobile?: boolean;
    currentGame?: string | null;
    customText?: string | null;
    customEmoji?: string | null;
}): string {
    if (p.isSelf) return 'Message yourself';
    if (p.status === 'offline') return STATUS_CONFIG.offline.label;
    const text = (p.customText ?? '').trim();
    if (text) {
        // A `cl:` custom-emoji reference is an image, not text.
        const emoji = (p.customEmoji ?? '').startsWith('cl:') ? '' : (p.customEmoji ?? '').trim();
        return emoji ? `${emoji} ${text}` : text;
    }
    if (p.currentGame && !p.onMobile) return `Playing ${p.currentGame}`;
    if (p.onMobile) return `${STATUS_CONFIG[p.status].label} on mobile`;
    return STATUS_CONFIG[p.status].label;
}

/** Compact relative time for a row's meta slot: "now", "4m", "2h", "3d", "2w", "5mo", "1y". */
export function formatShortAgo(then: number | null | undefined, now: number): string | null {
    if (!then || !Number.isFinite(then)) return null;
    const diff = now - then;
    if (diff < 0) return null; // clock skew — hide rather than show a future time
    const min = Math.floor(diff / 60_000);
    if (min < 1) return 'now';
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d`;
    if (day < 30) return `${Math.floor(day / 7)}w`;
    if (day < 365) return `${Math.max(1, Math.floor(day / 30.44))}mo`;
    return `${Math.floor(day / 365.25)}y`;
}

/** Decorate picker rows with status, chat and activity facts. Order is preserved. */
export function toPickerPeople(p: {
    rows: readonly PickerFriend[];
    conversations: readonly ConversationLike[];
    statuses?: Record<string, PickerStatusEntry | undefined> | null;
    presence?: PresenceMap | null;
    lastActivityAt?: Record<string, number> | null;
    myUserId?: string | null;
}): PickerPerson[] {
    const dmByUser = new Map<string, string>();
    let selfConvId: string | null = null;
    for (const c of p.conversations) {
        if (c?.type !== 'dm') continue;
        const cid = c.conversation_id ?? c.id ?? null;
        if (!cid) continue;
        const isSelf = c.is_self === true || (!!p.myUserId && c.other_user_id === p.myUserId);
        if (isSelf) { selfConvId = cid; continue; }
        if (c.other_user_id && !dmByUser.has(c.other_user_id)) dmByUser.set(c.other_user_id, cid);
    }
    const statuses = (p.statuses ?? {}) as StatusMap & Record<string, PickerStatusEntry | undefined>;
    const presence = p.presence ?? {};
    return p.rows.map(r => {
        const entry = statuses[r.user_id];
        const live: UserStatus = r.isSelf
            ? 'offline'
            : entry || presence[r.user_id] !== undefined
                ? resolveActiveStatus(r.user_id, statuses, presence)
                : asStatus(r.status);
        const onMobile = live !== 'offline' && !!entry?.on_mobile;
        const currentGame = live !== 'offline' && !onMobile ? (entry?.current_game ?? null) : null;
        const conversationId = r.isSelf ? selfConvId : (dmByUser.get(r.user_id) ?? null);
        const t = conversationId ? p.lastActivityAt?.[conversationId] : undefined;
        return {
            ...r,
            status: live,
            onMobile,
            currentGame,
            secondary: personSecondary({
                isSelf: r.isSelf,
                status: live,
                onMobile,
                currentGame,
                customText: entry?.custom_status_text,
                customEmoji: entry?.custom_status_emoji,
            }),
            conversationId,
            hasChat: !!conversationId,
            lastActivityAt: typeof t === 'number' && t > 0 ? t : null,
        };
    });
}

const byName = (a: PickerPerson, b: PickerPerson) =>
    a.username.localeCompare(b.username, undefined, { sensitivity: 'base' }) || a.user_id.localeCompare(b.user_id);

/** 0 exact · 1 prefix · 2 word-start (after . _ - or space) · 3 anywhere · -1 no match. */
export function matchRank(name: string, query: string): number {
    const n = name.toLowerCase();
    const q = query.trim().toLowerCase();
    if (!q) return 3;
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.split(/[._\-\s]+/).some(w => w.startsWith(q))) return 2;
    return n.includes(q) ? 3 : -1;
}

/**
 * Group and order the people for display.
 *
 * No search: **Recent** (DMs with a known last message, newest first, at most
 * RECENT_LIMIT) → **Online** (everyone visibly present, A–Z) → **Offline**
 * (A–Z). Each person appears exactly once. Recent leads because "message the
 * person I was just talking to" is the dominant use of this dialog; presence
 * next because a live person is the likelier reply.
 *
 * Search: one flat **Results** section, best match first (exact → prefix →
 * word start → anywhere), ties broken by recent chat, then presence, then
 * A–Z. The self row, when the search points at you, always leads.
 * Filtering itself is NOT done here — the rows arrive already filtered by
 * buildDmPickerResults, the one place that decides who matches.
 */
export function buildPickerSections(people: readonly PickerPerson[], search: string, recentLimit = RECENT_LIMIT): PickerSection[] {
    const q = search.trim();
    if (q) {
        const ranked = [...people].sort((a, b) => {
            if (!!a.isSelf !== !!b.isSelf) return a.isSelf ? -1 : 1;
            // A non-match (-1; normally filtered out upstream) sorts last, never first.
            const rank = (p: PickerPerson) => { const m = matchRank(p.username, q); return m < 0 ? 4 : m; };
            const r = rank(a) - rank(b);
            if (r) return r;
            const ta = a.lastActivityAt ?? 0, tb = b.lastActivityAt ?? 0;
            if (ta !== tb) return tb - ta;
            const pa = a.status !== 'offline' ? 0 : 1, pb = b.status !== 'offline' ? 0 : 1;
            if (pa !== pb) return pa - pb;
            return byName(a, b);
        });
        return ranked.length ? [{ key: 'results', label: 'Results', people: ranked }] : [];
    }
    const recent = people
        .filter(p => p.hasChat && p.lastActivityAt !== null && !p.isSelf)
        .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || byName(a, b))
        .slice(0, Math.max(0, recentLimit));
    const taken = new Set(recent.map(p => p.user_id));
    const rest = people.filter(p => !taken.has(p.user_id));
    const online = rest.filter(p => p.status !== 'offline').sort(byName);
    const offline = rest.filter(p => p.status === 'offline').sort(byName);
    const out: PickerSection[] = [];
    if (recent.length) out.push({ key: 'recent', label: 'Recent', people: recent });
    if (online.length) out.push({ key: 'online', label: 'Online', people: online });
    if (offline.length) out.push({ key: 'offline', label: 'Offline', people: offline });
    return out;
}

/** The sections flattened in display order — the keyboard's notion of "next row". */
export function flattenSections(sections: readonly PickerSection[]): PickerPerson[] {
    return sections.flatMap(s => s.people);
}

/** Move a highlight through `ids` by `delta`, wrapping at the ends. Unknown/absent → first (or last when moving up). */
export function moveHighlight(ids: readonly string[], current: string | null, delta: number): string | null {
    if (!ids.length) return null;
    const i = current ? ids.indexOf(current) : -1;
    if (i < 0) return delta < 0 ? ids[ids.length - 1] : ids[0];
    // Single steps wrap (arrow keys); page jumps clamp (PageUp/PageDown).
    if (Math.abs(delta) === 1) return ids[(i + delta + ids.length) % ids.length];
    return ids[Math.min(ids.length - 1, Math.max(0, i + delta))];
}

// ── Keyboard contract ─────────────────────────────────────────────────────

export type PickerKeyIntent =
    | { type: 'move'; delta: number }
    | { type: 'first' }
    | { type: 'last' }
    /** Open the highlighted person's chat right away. */
    | { type: 'open' }
    /** Add/remove the highlighted person; clear the query after (chip-input style). */
    | { type: 'toggle'; clearQuery: boolean }
    /** Run the footer's primary action for the current selection. */
    | { type: 'primary' }
    /** Remove the last chip. */
    | { type: 'removeLast' };

export const PAGE_STEP = 5;

/**
 * What a key press in the picker's search field means. Focus never leaves the
 * field (the list is driven through aria-activedescendant), so this is the
 * whole keyboard model:
 *
 *   ↑ / ↓            move the highlight (wraps)
 *   PageUp/PageDown  jump 5 rows
 *   Home / End       first / last row — only while the query is empty (they
 *                    move the caret otherwise)
 *   Enter            nothing selected → open the highlighted chat;
 *                    something selected → the primary action
 *   Shift+Enter      add/remove the highlighted person (clears the query)
 *   Space            add/remove the highlighted person — only while the
 *                    query is empty (it types a space otherwise)
 *   Ctrl/⌘+Enter     the primary action (opens the highlighted chat when
 *                    nothing is selected)
 *   Backspace        remove the last chip — only while the query is empty
 *   Escape           not handled here: ClModal closes the dialog
 *
 * Returns null for anything else (the input handles it normally).
 */
export function pickerKeyIntent(
    e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; isComposing?: boolean },
    ctx: { query: string; selectionCount: number; multiSelect: boolean },
): PickerKeyIntent | null {
    if (e.isComposing || e.altKey) return null;
    const empty = ctx.query === '';
    switch (e.key) {
        case 'ArrowDown': return { type: 'move', delta: 1 };
        case 'ArrowUp': return { type: 'move', delta: -1 };
        case 'PageDown': return { type: 'move', delta: PAGE_STEP };
        case 'PageUp': return { type: 'move', delta: -PAGE_STEP };
        case 'Home': return empty ? { type: 'first' } : null;
        case 'End': return empty ? { type: 'last' } : null;
        case 'Enter':
            if (e.shiftKey && ctx.multiSelect) return { type: 'toggle', clearQuery: !empty };
            if (ctx.selectionCount > 0) return { type: 'primary' };
            return { type: 'open' };
        case ' ':
            return empty && ctx.multiSelect && !e.ctrlKey && !e.metaKey ? { type: 'toggle', clearQuery: false } : null;
        case 'Backspace':
            return empty && ctx.selectionCount > 0 ? { type: 'removeLast' } : null;
        default: return null;
    }
}

// ── Primary action ────────────────────────────────────────────────────────

export type PrimaryAction =
    | { kind: 'none'; label: string }
    | { kind: 'open'; label: string; person: PickerPerson }
    | { kind: 'group'; label: string; people: PickerPerson[] };

/**
 * The footer's primary button for a selection. One person → their chat
 * ("Open chat" when it already exists, "Start chat" when it will be created).
 * Two or more → a group chat, which hands off to the group-creation step
 * (name + photo) rather than creating anything here.
 */
export function primaryActionFor(selected: readonly PickerPerson[]): PrimaryAction {
    if (selected.length === 0) return { kind: 'none', label: 'Start chat' };
    if (selected.length === 1) {
        const person = selected[0];
        return { kind: 'open', label: person.hasChat ? 'Open chat' : 'Start chat', person };
    }
    return { kind: 'group', label: 'Start group chat', people: [...selected] };
}

/** Toggle `id` in an ordered selection, never past `max`. Returns the same array when nothing changes. */
export function toggleSelection(selection: readonly string[], id: string, max: number): readonly string[] {
    if (selection.includes(id)) return selection.filter(x => x !== id);
    if (selection.length >= max) return selection;
    return [...selection, id];
}
