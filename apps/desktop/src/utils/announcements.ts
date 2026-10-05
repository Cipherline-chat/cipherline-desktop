/**
 * announcements — pure logic for the admin-authored announcement-banner
 * feature (desktop client half). Talks to `GET /v1/announcements`, a frozen
 * contract owned jointly with a separate agent building the admin UI + API:
 *
 *   type BannerView = {
 *     id: string;
 *     title: string | null;
 *     body: string;
 *     icon: string | null;   // a lucide icon NAME from a server-validated allowlist
 *     color: string;         // a PRESET NAME (not a hex) from the app palette
 *     dismissible: boolean;
 *     starts_at: string | null;
 *     ends_at: string | null;
 *   };
 *
 * All targeting and scheduling is resolved server-side — if a banner is in
 * the response it applies to this user right now (CLAUDE.md: the client has
 * NO load-bearing checks by design). This module does NOT re-derive
 * eligibility. It only:
 *
 *   1. Maps color/icon PRESET NAMES to house tokens/components, falling back
 *      to a neutral style / no icon for anything it doesn't recognize —
 *      the API agent may still be settling the exact allowlist it validates
 *      server-side, so this mapping must degrade gracefully rather than
 *      crash or render a raw, unstyled value.
 *   2. Filters out banners the user has already dismissed (client-only
 *      state — server-lean: the server does not track who dismissed what).
 *   3. Bounds how many banners render at once so the stack can't take over
 *      the window.
 *   4. Bounds how much dismissal bookkeeping accumulates over time.
 *   5. Formats an optional "ends in Xh" string for display — never for
 *      filtering (CLAUDE.md is explicit: `ends_at` is informational only).
 */
import type { LucideIcon } from 'lucide-react';
import {
    AlertCircle, AlertOctagon, AlertTriangle, Bell, Calendar, CalendarClock, CheckCircle2, Clock, Coffee, Flag, Gift, Heart, Info, Megaphone, PartyPopper, Rocket, Shield, ShieldAlert, Sparkles, Star, Tag, Wrench, Zap,
} from 'lucide-react';

export interface BannerView {
    id: string;
    title: string | null;
    body: string;
    icon: string | null;
    color: string;
    dismissible: boolean;
    starts_at: string | null;
    ends_at: string | null;
}

// ── Color preset mapping ─────────────────────────────────────────────────

export interface AnnouncementColorTokens {
    /** House convention (see TrialBanner / AddFriendModal / AuthScreen):
     *  a soft tinted background, a matching hairline border, and text/icon
     *  in the full-strength token color. */
    bg: string;
    border: string;
    text: string;
}

/**
 * PRESET NAME → house token classes, drawn from the app palette in
 * `apps/desktop/src/index.css` / `tailwind.config`: `cl-lume` (teal,
 * primary/positive), `cl-flash` (red, careful/danger), `cl-glow` (the app's
 * one warm/amber-ish token — there is no separate "amber" hex in the
 * palette, so `amber` maps to `cl-glow`), and a `neutral` preset built from
 * the plain surface/border/muted-text tokens for a purely informational
 * banner with no color signal.
 *
 * ASSUMPTION (flagged per the task): the API agent's exact preset-name
 * allowlist wasn't available while building this. `lume`/`flash`/`amber`/
 * `neutral` are the names used here, with `teal`/`red`/`glow` accepted as
 * aliases in case the server settles on the raw token name instead of the
 * "meaning" name. This map is additive-only — extend it, never repurpose
 * the `neutral` fallback key, if the real allowlist lands with different
 * names.
 */
export const ANNOUNCEMENT_COLOR_TOKENS: Record<string, AnnouncementColorTokens> = {
    // These four ARE the server's allowlist (admin/src/announcements.validate.js
    // and the API's mirror of it). They were guessed as lume/flash/amber while
    // the two halves were built in parallel; the server settled on semantic
    // names instead, so `warn` and `danger` were silently falling back to
    // neutral — a "danger" maintenance notice rendering as grey chrome.
    // Keep this set in step with the server allowlist; anything off-list
    // degrades to neutral rather than passing a raw value to the DOM.
    neutral: { bg: 'bg-cl-surface',  border: 'border-cl-border',   text: 'text-cl-muted' },
    info:    { bg: 'bg-cl-lume/10',  border: 'border-cl-lume/25',  text: 'text-cl-lume' },
    warn:    { bg: 'bg-cl-glow/10',  border: 'border-cl-glow/25',  text: 'text-cl-glow' },
    danger:  { bg: 'bg-cl-flash/10', border: 'border-cl-flash/25', text: 'text-cl-flash' },
};

export const DEFAULT_ANNOUNCEMENT_COLOR = 'neutral';

/** Resolve a preset name to its token set. Anything unrecognized (unknown
 *  name, null, empty string) falls back to `neutral` — never throws, never
 *  passes a raw/unstyled value through to the DOM. */
export function resolveAnnouncementColor(color: string | null | undefined): AnnouncementColorTokens {
    if (color && Object.prototype.hasOwnProperty.call(ANNOUNCEMENT_COLOR_TOKENS, color)) {
        return ANNOUNCEMENT_COLOR_TOKENS[color];
    }
    return ANNOUNCEMENT_COLOR_TOKENS[DEFAULT_ANNOUNCEMENT_COLOR];
}

// ── Icon preset mapping ───────────────────────────────────────────────────

/**
 * ICON NAME → lucide component. Same "additive allowlist, fall back to
 * nothing" posture as color: a name this build doesn't recognize (server
 * allowlist grew, typo, future icon) renders NO icon rather than an
 * undefined component or a dynamic-import/string-eval hack.
 */
export const ANNOUNCEMENT_ICONS: Record<string, LucideIcon> = {
    megaphone: Megaphone,
    info: Info,
    'alert-triangle': AlertTriangle,
    // The server's allowlist includes these three; without them an admin could
    // pick a legal icon that silently rendered as nothing on the client.
    'alert-octagon': AlertOctagon,
    'calendar-clock': CalendarClock,
    shield: Shield,
    'alert-circle': AlertCircle,
    sparkles: Sparkles,
    rocket: Rocket,
    'party-popper': PartyPopper,
    gift: Gift,
    wrench: Wrench,
    star: Star,
    bell: Bell,
    calendar: Calendar,
    zap: Zap,
    'shield-alert': ShieldAlert,
    clock: Clock,
    heart: Heart,
    tag: Tag,
    coffee: Coffee,
    'check-circle-2': CheckCircle2,
    flag: Flag,
};

/** Resolve an icon name to its component, or `null` when absent/unrecognized. */
export function resolveAnnouncementIcon(icon: string | null | undefined): LucideIcon | null {
    if (!icon) return null;
    return Object.prototype.hasOwnProperty.call(ANNOUNCEMENT_ICONS, icon) ? ANNOUNCEMENT_ICONS[icon] : null;
}

// ── Dismissal filtering ───────────────────────────────────────────────────

/** Banners the user has NOT dismissed, in the order the server gave them
 *  (already priority-ordered — this never re-sorts). */
export function filterDismissed(
    banners: readonly BannerView[],
    dismissedIds: ReadonlySet<string> | readonly string[],
): BannerView[] {
    const set = dismissedIds instanceof Set ? dismissedIds : new Set(dismissedIds);
    return banners.filter(b => !set.has(b.id));
}

export function isDismissed(ids: readonly string[], bannerId: string): boolean {
    return ids.includes(bannerId);
}

// ── Stack bounding ────────────────────────────────────────────────────────

export const MAX_VISIBLE_ANNOUNCEMENTS = 2;

export interface BoundedAnnouncementStack {
    visible: BannerView[];
    overflow: BannerView[];
}

/** Cap how many banners render by default. Nothing is discarded — the rest
 *  comes back as `overflow` for a "+N more" affordance the caller can expand
 *  on demand, rather than a fixed ceiling that silently hides real
 *  announcements forever. `maxVisible` is floored to 1 so the stack can
 *  never collapse to nothing. */
export function boundAnnouncementStack(
    banners: readonly BannerView[],
    maxVisible: number = MAX_VISIBLE_ANNOUNCEMENTS,
): BoundedAnnouncementStack {
    const cap = Math.max(1, Math.floor(maxVisible));
    return { visible: banners.slice(0, cap), overflow: banners.slice(cap) };
}

// ── Dismissal-id bookkeeping (bounded growth) ────────────────────────────

/** Cap on remembered dismissed-banner ids per account. Bounds storage growth
 *  ("a banner id dismissed months ago and long deleted should not linger")
 *  without needing any signal about when a banner was deleted server-side —
 *  plain LRU-style eviction of the OLDEST dismissal once the cap is hit
 *  self-heals regardless of the announcement's own lifecycle. Comfortably
 *  larger than any plausible number of announcements a real admin authors
 *  concurrently. */
export const MAX_REMEMBERED_DISMISSALS = 200;

/** Append `bannerId` to the dismissal history (moving it to the end if
 *  already present, so re-dismissing something refreshes its recency) and
 *  cap the result to the most recent `max` entries, dropping the oldest.
 *  Pure — the caller persists the returned array. */
export function recordDismissal(
    ids: readonly string[],
    bannerId: string,
    max: number = MAX_REMEMBERED_DISMISSALS,
): string[] {
    const cap = Math.max(1, Math.floor(max));
    const withoutExisting = ids.filter(id => id !== bannerId);
    const next = [...withoutExisting, bannerId];
    return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Parse the JSON-array dismissal blob read out of secureLocalStore.
 *  Anything malformed (missing key, corrupt JSON, wrong shape) yields an
 *  empty list rather than throwing — a dismissal that fails to load just
 *  means the banner reappears once, never a crash. */
export function parseDismissedIds(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

// ── Display-only countdown ────────────────────────────────────────────────

/** Human "ends in Xm/Xh/Xd" string, or `null` when there's nothing useful to
 *  show (no `ends_at`, unparsable, or already elapsed — a banner whose
 *  window lapsed is still shown if the server included it; this just avoids
 *  printing a stale/negative countdown for it). Display-only: never used to
 *  filter or hide a banner — that determination is entirely server-side. */
export function formatEndsIn(endsAt: string | null | undefined, now: number = Date.now()): string | null {
    if (!endsAt) return null;
    const end = Date.parse(endsAt);
    if (Number.isNaN(end)) return null;
    const ms = end - now;
    if (ms <= 0) return null;
    const mins = Math.round(ms / 60_000);
    if (mins < 1) return 'ends in <1m';
    if (mins < 60) return `ends in ${mins}m`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `ends in ${hours}h`;
    const days = Math.round(hours / 24);
    return `ends in ${days}d`;
}
