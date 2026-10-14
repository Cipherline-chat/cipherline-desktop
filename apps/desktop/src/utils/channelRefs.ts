/**
 * channelRefs: `#channel` links in server-channel messages.
 *
 * WIRE FORMAT (packages/shared/content.ts `ChannelRef`, docs/channel-links.md):
 * the message text carries the plain, readable `#name` the sender picked, and
 * an optional `channel_refs: [{ id, name }]` array on the text / edit content
 * says which channel each `#name` names. There is no inline `<#c:...>` token on
 * purpose: a client that predates the field (desktop <= 1.0.21, mobile) ignores
 * it and shows `#memes` exactly as typed, where an unknown inline token would
 * be printed raw. Because the readable form IS the text, every plain-text
 * surface (reply quote, notification, pinned row, search, Copy Text) already
 * shows `#memes` with no work here.
 *
 * Everything in this file is pure and DOM-free except `revealChannelRow`,
 * which takes its root as a parameter.
 *
 * Visibility rule: a ref is only ever resolved against the reader's OWN list
 * of channels it can view in the server being read. Anything else, whether a
 * private channel, a deleted one, or a channel in another server, renders as
 * the same neutral `#unknown-channel`, so a reader cannot tell "exists but
 * hidden from me" from "gone".
 */
import { Permissions, hasPermission, isAdministrator, type ChannelRef } from '@cipherline/shared';
import { foldForMatch } from './mentionSuggestions';

export type { ChannelRef };

/** The one label every unresolvable ref renders as (private, deleted, other server). */
export const UNAVAILABLE_CHANNEL_LABEL = 'unknown-channel';

/** Caps on what a reader accepts from a (sender-controlled) `channel_refs`. */
export const MAX_CHANNEL_REFS = 25;
const MAX_REF_NAME_LEN = 100;
const MAX_REF_ID_LEN = 64;
/** Channel names are at most 50 chars (CreateChannelDto); the query never needs more. */
const MAX_QUERY_LEN = 50;

/** The channel fields this module reads (a structural subset of ChannelInfo). */
export interface LinkableChannel {
    channel_id: string;
    server_id: string;
    kind: 'text' | 'voice' | 'huddle';
    name: string;
    topic: string | null;
    icon_emoji?: string | null;
    icon_name?: string | null;
    position: number;
    parent_category_id: string | null;
    my_permissions?: string;
}

export interface LinkableCategory {
    category_id: string;
    name: string;
    position: number;
}

// ── Composer trigger ──────────────────────────────────────────────────────────

/**
 * True when the END of `before` sits inside a code span or block: an odd
 * number of ``` fences, or (outside fences) an odd number of single backticks
 * on the current line. A `#` typed there is code, not a channel link.
 */
export function isInsideCode(before: string): boolean {
    const fences = before.match(/```/g)?.length ?? 0;
    if (fences % 2 === 1) return true;
    const noFences = before.replace(/```[\s\S]*?```/g, '');
    const line = noFences.slice(noFences.lastIndexOf('\n') + 1);
    return (line.match(/`/g)?.length ?? 0) % 2 === 1;
}

export interface ChannelTrigger {
    /** The typed filter text after `#` (trailing spaces trimmed). */
    query: string;
    /** Index of the `#` in the composer text. */
    start: number;
}

/**
 * Detect an open `#channel` query at the caret. `before` = composer text up to
 * the caret. Mirrors the `@` trigger: the `#` must be at the very start or
 * right after whitespace (so `C#`, `issue#12` and `example.com/#anchor` never
 * open it), and the query may contain spaces but no `#`, `@`, `<`, `>` or
 * newline. Two extra rules `@` does not need: the first character after `#`
 * may not be whitespace (`# heading`), and a `#` inside code never triggers.
 */
export function detectChannelTrigger(before: string): ChannelTrigger | null {
    const m = before.match(/(?:^|(?<=\s))#([^#@<>\n]{0,50})$/);
    if (!m) return null;
    const raw = m[1];
    if (/^\s/.test(raw)) return null;
    const start = before.length - m[0].length;
    if (isInsideCode(before.slice(0, start))) return null;
    return { query: raw.trimEnd().slice(0, MAX_QUERY_LEN), start };
}

// ── Visibility + candidates ───────────────────────────────────────────────────

/**
 * Whether the reader can VIEW this channel, from the per-channel permissions
 * the channel list already carries. The list endpoint is VIEW_CHANNEL-filtered
 * server-side, so a missing `my_permissions` (a locally built object) is taken
 * as visible; a present one that cannot be parsed fails CLOSED.
 */
export function canViewChannel(ch: Pick<LinkableChannel, 'my_permissions'>): boolean {
    if (ch.my_permissions === undefined || ch.my_permissions === null) return true;
    let perms: bigint;
    try { perms = BigInt(ch.my_permissions); } catch { return false; }
    return isAdministrator(perms) || hasPermission(perms, Permissions.VIEW_CHANNEL);
}

/** The channels of `serverId` a `#` link may name for this reader. */
export function linkableChannels<C extends LinkableChannel>(channels: readonly C[] | null | undefined, serverId: string | null | undefined): C[] {
    if (!channels || !serverId) return [];
    return channels.filter(c =>
        c.server_id === serverId
        && (c.kind === 'text' || c.kind === 'huddle' || c.kind === 'voice')
        && canViewChannel(c));
}

export interface ChannelCandidate {
    channel: LinkableChannel;
    /** Category the channel sits under, or null when uncategorized. */
    categoryName: string | null;
    /** 'text' channels, or 'call' for Calls/voice channels. */
    group: 'text' | 'call';
}

/**
 * Every channel the `#` picker may offer, in sidebar order: text channels
 * first, then Calls channels, each by (category position, channel position).
 * Hidden channels are never in the result (see linkableChannels).
 */
export function buildChannelCandidates(
    channels: readonly LinkableChannel[] | null | undefined,
    categories: readonly LinkableCategory[] | null | undefined,
    serverId: string | null | undefined,
): ChannelCandidate[] {
    const cats = new Map<string, LinkableCategory>();
    for (const c of categories ?? []) cats.set(c.category_id, c);
    const catPos = (ch: LinkableChannel) => {
        const cat = ch.parent_category_id ? cats.get(ch.parent_category_id) : undefined;
        return cat ? cat.position : -1; // uncategorized sits on top, like the sidebar
    };
    return linkableChannels(channels, serverId)
        .map((channel): ChannelCandidate => ({
            channel,
            categoryName: (channel.parent_category_id && cats.get(channel.parent_category_id)?.name) || null,
            group: channel.kind === 'text' ? 'text' : 'call',
        }))
        .sort((a, b) =>
            (a.group === b.group ? 0 : a.group === 'text' ? -1 : 1)
            || catPos(a.channel) - catPos(b.channel)
            || a.channel.position - b.channel.position);
}

/** Filter + rank by name: prefix matches before substring matches, each in input order. */
export function rankChannelCandidates<T extends { channel: { name: string } }>(candidates: readonly T[], rawQuery: string, limit = 10): T[] {
    const q = foldForMatch(rawQuery).trim();
    if (q === '') return candidates.slice(0, limit);
    const prefix: T[] = [];
    const contains: T[] = [];
    for (const c of candidates) {
        const f = foldForMatch(c.channel.name);
        if (f.startsWith(q)) prefix.push(c);
        else if (f.includes(q)) contains.push(c);
    }
    return prefix.concat(contains).slice(0, limit);
}

// ── Wire: refs <-> text ───────────────────────────────────────────────────────

/**
 * Validate a received `channel_refs` (sender-controlled). Returns only
 * well-formed entries: `{ id, name }` strings within the length caps, an id of
 * uuid-ish characters, a name with no line break, first entry per name wins,
 * at most MAX_CHANNEL_REFS. Anything else yields [].
 */
export function sanitizeChannelRefs(raw: unknown): ChannelRef[] {
    if (!Array.isArray(raw)) return [];
    const out: ChannelRef[] = [];
    const names = new Set<string>();
    for (const r of raw) {
        if (out.length >= MAX_CHANNEL_REFS) break;
        if (!r || typeof r !== 'object') continue;
        const { id, name } = r as { id?: unknown; name?: unknown };
        if (typeof id !== 'string' || typeof name !== 'string') continue;
        if (id.length === 0 || id.length > MAX_REF_ID_LEN || !/^[A-Za-z0-9-]+$/.test(id)) continue;
        if (name.length === 0 || name.length > MAX_REF_NAME_LEN || /[\r\n]/.test(name)) continue;
        if (names.has(name)) continue;
        names.add(name);
        out.push({ id, name });
    }
    return out;
}

/** Same end-of-name boundary buildWireText uses for `@label`. */
const NAME_END_RE = /[\s<>@'"!?.,;:)\]}]/;

export interface ChannelRefSpan {
    /** Index of the `#`. */
    start: number;
    /** Index just past the name. */
    end: number;
    ref: ChannelRef;
}

/**
 * Where each ref's `#name` appears in `text`. A match needs the `#` at the
 * start or after whitespace, not inside code, the exact (case-sensitive) name,
 * then the end of the text or a boundary character. Longest name first, so
 * `#memes-archive` is not read as `#memes` + "-archive" (that also fails the
 * boundary) and `#general chat` beats `#general`.
 */
export function findChannelRefSpans(text: string, refs: readonly ChannelRef[]): ChannelRefSpan[] {
    if (!text || refs.length === 0) return [];
    const byLength = [...refs].sort((a, b) => b.name.length - a.name.length);
    const spans: ChannelRefSpan[] = [];
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '#') continue;
        if (i > 0 && !/\s/.test(text[i - 1])) continue;
        for (const ref of byLength) {
            if (!text.startsWith(ref.name, i + 1)) continue;
            const end = i + 1 + ref.name.length;
            if (end < text.length && !NAME_END_RE.test(text[end])) continue;
            if (isInsideCode(text.slice(0, i))) break;
            spans.push({ start: i, end, ref });
            i = end - 1;
            break;
        }
    }
    return spans;
}

export type ChannelSegment =
    | { kind: 'text'; from: number; to: number }
    | { kind: 'ref'; span: ChannelRefSpan };

/**
 * Split the text range [from, to) around the channel-link spans lying wholly
 * inside it (the renderer's plain run between two mention tokens). A span that
 * crosses the range edge (a crafted name overlapping a mention token) is left
 * as text. `spans` must be in order, as findChannelRefSpans returns them.
 */
export function segmentByChannelSpans(from: number, to: number, spans: readonly ChannelRefSpan[]): ChannelSegment[] {
    const out: ChannelSegment[] = [];
    let at = from;
    for (const s of spans) {
        if (s.start < at || s.end > to) continue;
        if (s.start > at) out.push({ kind: 'text', from: at, to: s.start });
        out.push({ kind: 'ref', span: s });
        at = s.end;
    }
    if (to > at) out.push({ kind: 'text', from: at, to });
    return out;
}

/**
 * The `channel_refs` to send with `text`, from the composer's name -> id map
 * (filled as the user picks from the `#` list, or seeded from the message
 * being edited). Only names that still appear as a link in the final text are
 * kept, so deleting the `#name` from the draft drops its ref. Order = first
 * appearance; empty array = send no field.
 */
export function collectChannelRefs(text: string, nameToId: Readonly<Record<string, string>>): ChannelRef[] {
    const refs = Object.entries(nameToId).map(([name, id]) => ({ id, name }));
    const seen = new Set<string>();
    const out: ChannelRef[] = [];
    for (const s of findChannelRefSpans(text, refs)) {
        if (seen.has(s.ref.name)) continue;
        seen.add(s.ref.name);
        out.push(s.ref);
        if (out.length >= MAX_CHANNEL_REFS) break;
    }
    return out;
}

/** name -> id from a received message, to seed the composer when it is edited. */
export function channelRefNameMap(raw: unknown): Record<string, string> {
    const map: Record<string, string> = {};
    for (const r of sanitizeChannelRefs(raw)) map[r.name] = r.id;
    return map;
}

// ── Render-time resolution ────────────────────────────────────────────────────

export type ChannelRefResolution =
    | { state: 'visible'; channel: LinkableChannel }
    /** The reader's channel list for this server is not loaded yet. */
    | { state: 'pending' }
    /** Private, deleted, or in another server: deliberately indistinguishable. */
    | { state: 'unavailable' };

/**
 * Resolve a ref BY ID against the channels the reader can view in the server
 * being read (`linkableChannels` output). `visible === null` means that list
 * has not loaded. The stored name is never consulted here: a rename shows the
 * current name, and a name collision cannot redirect a link.
 */
export function resolveChannelRef(ref: ChannelRef, visible: readonly LinkableChannel[] | null): ChannelRefResolution {
    if (visible === null) return { state: 'pending' };
    const channel = visible.find(c => c.channel_id === ref.id);
    return channel ? { state: 'visible', channel } : { state: 'unavailable' };
}

export interface ChannelPillView {
    /** Text shown after the `#`. */
    label: string;
    clickable: boolean;
    /** Accessible name. */
    ariaLabel: string;
    /** Hover text. */
    title: string;
    kind: 'text' | 'call' | 'neutral';
}

/**
 * What a ref's pill shows. Visible -> the channel's CURRENT name, clickable,
 * topic on hover. Unavailable -> `#unknown-channel`, never the stored name and
 * never anything that differs between "private" and "deleted". Pending (list
 * not loaded yet) -> the stored name the sender's text already contains,
 * neutral and inert, so a cold open does not flash `#unknown-channel`.
 */
export function channelPillView(ref: ChannelRef, resolution: ChannelRefResolution): ChannelPillView {
    if (resolution.state === 'visible') {
        const ch = resolution.channel;
        const isCall = ch.kind !== 'text';
        const topic = ch.topic?.trim();
        return {
            label: ch.name,
            clickable: true,
            ariaLabel: `Channel ${ch.name}`,
            title: topic ? topic : (isCall ? `Calls channel ${ch.name}` : `Channel ${ch.name}`),
            kind: isCall ? 'call' : 'text',
        };
    }
    if (resolution.state === 'pending') {
        return { label: ref.name, clickable: false, ariaLabel: `Channel ${ref.name}`, title: ref.name, kind: 'neutral' };
    }
    return {
        label: UNAVAILABLE_CHANNEL_LABEL,
        clickable: false,
        ariaLabel: 'Unknown channel',
        title: "You can't view this channel, or it no longer exists",
        kind: 'neutral',
    };
}

// ── Navigation ────────────────────────────────────────────────────────────────

export type ChannelNavigation =
    /** A text channel: open it (and scroll the sidebar to it). */
    | { action: 'open'; channel: LinkableChannel }
    /** A Calls/voice channel: scroll the call panel to it. Never auto-joins. */
    | { action: 'reveal'; channel: LinkableChannel };

/** What a click on a link to `channelId` does, or null when it must do nothing. */
export function channelNavigationFor(
    channelId: string,
    channels: readonly LinkableChannel[] | null | undefined,
    serverId: string | null | undefined,
): ChannelNavigation | null {
    const channel = linkableChannels(channels, serverId).find(c => c.channel_id === channelId);
    if (!channel) return null;
    return channel.kind === 'text' ? { action: 'open', channel } : { action: 'reveal', channel };
}

/** Minimal DOM surface `revealChannelRow` needs (so it is testable without a DOM). */
export interface RevealRoot {
    querySelector(selector: string): { scrollIntoView?: (opts?: ScrollIntoViewOptions) => void; classList?: { add(c: string): void; remove(c: string): void } } | null;
}

export const CHANNEL_ROW_FLASH_CLASS = 'cl-channel-row-flash';

/**
 * Scroll the sidebar / call-panel row for `channelId` (`[data-channel-id]`)
 * into view and flash it briefly. Returns false when the row is not rendered
 * (e.g. its category is collapsed). Ids are checked before they reach a
 * selector, so a crafted ref cannot inject one.
 */
export function revealChannelRow(channelId: string, root: RevealRoot, flashMs = 1200): boolean {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(channelId)) return false;
    const el = root.querySelector(`[data-channel-id="${channelId}"]`);
    if (!el) return false;
    el.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    if (el.classList) {
        el.classList.add(CHANNEL_ROW_FLASH_CLASS);
        setTimeout(() => el.classList?.remove(CHANNEL_ROW_FLASH_CLASS), flashMs);
    }
    return true;
}
