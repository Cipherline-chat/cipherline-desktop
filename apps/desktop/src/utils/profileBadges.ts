/**
 * profileBadges — pure logic for rendering admin-granted custom profile
 * badges (desktop client half). The server contract (frozen, owned jointly
 * with the admin dashboard — see `admin/src/profile/validation.js` and
 * `apps/api/src/profile-badges/profile-badges.service.ts`):
 *
 *   type ProfileBadge = {
 *     badge_id: string;
 *     icon: string;    // a lucide icon NAME from the admin's allowlist
 *     color: string;   // a design-token NAME (never a hex) from the admin's allowlist
 *     label: string;   // untrusted operator-authored text — the hover tip
 *     sort_order: number;
 *   };
 *
 * Badges are cosmetic and fail soft server-side (an unmigrated table or a
 * broken query yields `[]`, never a 500) — this module keeps that posture on
 * the client: an icon/colour name this build does not recognise renders a
 * neutral fallback rather than throwing or rendering nothing silently, since
 * the admin allowlist and the client's static maps are independently
 * deployed and CAN drift (API/admin roll separately from the desktop app).
 *
 * Same posture as `announcements.ts`'s color/icon resolution (that module is
 * the established precedent for "server sends an allowlisted NAME, client
 * resolves it through a static map, degrades gracefully on drift").
 */
import type { LucideIcon } from 'lucide-react';
import {
    Anchor, Award, Badge as BadgeIcon, BadgeCheck, Bot, Bug, Cake, Camera, Code,
    Coffee, Compass, Cpu, Crown, Feather, Flame, Gamepad2, Gem,
    Ghost, Gift, Globe, Hammer, Headphones, Heart, Infinity as InfinityIcon, Key,
    Leaf, Lock, Medal, Mic, Moon, Music, Palette, Rocket,
    Shield, Sparkles, Star, Sun, Terminal, Trophy, Wrench, Zap,
} from 'lucide-react';

export interface ProfileBadge {
    badge_id: string;
    icon: string;
    color: string;
    label: string;
    sort_order: number;
}

// ── Icon mapping ──────────────────────────────────────────────────────────

/**
 * ICON NAME → lucide component. Covers exactly the admin's `BADGE_ICONS`
 * allowlist (`admin/src/profile/validation.js`, 40 names, kebab-case lucide
 * ids). Deliberately an explicit static map, not a dynamic
 * `import(\`lucide-react/${name}\`)` — that would pull every icon the app
 * might ever reference into the bundle instead of just the ones actually
 * used, and would turn a typo'd/rotated admin name into a runtime import
 * failure instead of a typed lookup miss.
 */
export const PROFILE_BADGE_ICONS: Record<string, LucideIcon> = {
    anchor: Anchor,
    award: Award,
    'badge-check': BadgeCheck,
    bot: Bot,
    bug: Bug,
    cake: Cake,
    camera: Camera,
    code: Code,
    coffee: Coffee,
    compass: Compass,
    cpu: Cpu,
    crown: Crown,
    feather: Feather,
    flame: Flame,
    'gamepad-2': Gamepad2,
    gem: Gem,
    ghost: Ghost,
    gift: Gift,
    globe: Globe,
    hammer: Hammer,
    headphones: Headphones,
    heart: Heart,
    infinity: InfinityIcon,
    key: Key,
    leaf: Leaf,
    lock: Lock,
    medal: Medal,
    mic: Mic,
    moon: Moon,
    music: Music,
    palette: Palette,
    rocket: Rocket,
    shield: Shield,
    sparkles: Sparkles,
    star: Star,
    sun: Sun,
    terminal: Terminal,
    trophy: Trophy,
    wrench: Wrench,
    zap: Zap,
};

/**
 * Fallback glyph for an icon name this build doesn't recognise (allowlist
 * drift, typo, or a name added to the admin side after this build shipped).
 * A generic "badge" glyph rather than rendering nothing: the badge is a
 * deliberate admin action and its label is still meaningful text, so hiding
 * the whole thing would silently drop that signal. Not itself part of the
 * admin's selectable allowlist — purely a client-side "unknown" marker.
 */
export const DEFAULT_PROFILE_BADGE_ICON: LucideIcon = BadgeIcon;

/** Resolve an icon name to its component, or the generic fallback glyph for
 *  anything unrecognised (null/empty/unknown). Never throws. */
export function resolveProfileBadgeIcon(icon: string | null | undefined): LucideIcon {
    if (icon && Object.prototype.hasOwnProperty.call(PROFILE_BADGE_ICONS, icon)) {
        return PROFILE_BADGE_ICONS[icon];
    }
    return DEFAULT_PROFILE_BADGE_ICON;
}

// ── Color mapping ─────────────────────────────────────────────────────────

export interface ProfileBadgeColorTokens {
    /** Soft tinted background for the badge's circular swatch. */
    bg: string;
    /** Matching hairline border. */
    border: string;
    /** Full-strength token colour for the icon glyph itself. */
    text: string;
}

/**
 * COLOR NAME → house design-token classes. Covers exactly the admin's
 * `BADGE_COLORS` allowlist (`admin/src/profile/validation.js`, 10 names).
 *
 * The "glow in the deep" palette (`apps/desktop/src/index.css` /
 * `tailwind.config.js`) only defines THREE accent hues outright — `cl-lume`
 * (teal, primary/accent), `cl-flash` (red/coral), `cl-glow` (amber/gold) —
 * plus `cl-ok` (green, already used for online status). That covers 4 of
 * the 10 allowlisted names (`accent`→lume, `red`→flash, `gold`→glow,
 * `green`→ok) with an exact semantic match. The other 6
 * (`orange`/`cyan`/`blue`/`purple`/`pink`/`slate`) have no bespoke token —
 * rather than invent new CSS custom properties for a 10-name admin picker
 * (the `announcements.ts` precedent explicitly favours reusing what exists
 * over growing the palette), they resolve to Tailwind's own stock scale at
 * the `-400` step, which several existing surfaces already do against this
 * same dark theme (`TrialBanner.tsx`'s `orange-500`, `ChatPane.tsx`'s
 * `blue-500`, `CallPane.tsx`'s `slate-500`) — still a design-token
 * reference, not a hardcoded hex, and it keeps all 10 admin colours visually
 * DISTINCT, which matters here: an admin picking a colour per badge to tell
 * badges apart would have that intent collapsed if e.g. `purple` and `pink`
 * both silently became "red".
 */
export const PROFILE_BADGE_COLOR_TOKENS: Record<string, ProfileBadgeColorTokens> = {
    accent: { bg: 'bg-cl-lume/14', border: 'border-cl-lume/30', text: 'text-cl-lume' },
    gold: { bg: 'bg-cl-glow/14', border: 'border-cl-glow/30', text: 'text-cl-glow' },
    red: { bg: 'bg-cl-flash/14', border: 'border-cl-flash/30', text: 'text-cl-flash' },
    orange: { bg: 'bg-orange-400/14', border: 'border-orange-400/30', text: 'text-orange-400' },
    green: { bg: 'bg-cl-ok/14', border: 'border-cl-ok/30', text: 'text-cl-ok' },
    cyan: { bg: 'bg-cyan-400/14', border: 'border-cyan-400/30', text: 'text-cyan-400' },
    blue: { bg: 'bg-blue-400/14', border: 'border-blue-400/30', text: 'text-blue-400' },
    purple: { bg: 'bg-purple-400/14', border: 'border-purple-400/30', text: 'text-purple-400' },
    pink: { bg: 'bg-pink-400/14', border: 'border-pink-400/30', text: 'text-pink-400' },
    slate: { bg: 'bg-slate-400/14', border: 'border-slate-400/30', text: 'text-slate-400' },
};

export const DEFAULT_PROFILE_BADGE_COLOR = 'accent';

/** Resolve a colour name to its token set. Anything unrecognised (unknown
 *  name, null, empty string) falls back to `accent` — never throws, never
 *  passes a raw/unstyled value through to the DOM. */
export function resolveProfileBadgeColor(color: string | null | undefined): ProfileBadgeColorTokens {
    if (color && Object.prototype.hasOwnProperty.call(PROFILE_BADGE_COLOR_TOKENS, color)) {
        return PROFILE_BADGE_COLOR_TOKENS[color];
    }
    return PROFILE_BADGE_COLOR_TOKENS[DEFAULT_PROFILE_BADGE_COLOR];
}

// ── Ordering ──────────────────────────────────────────────────────────────

/**
 * Badges in display order. The API already returns them pre-sorted
 * (`ORDER BY user_id, sort_order ASC, created_at ASC, badge_id ASC`), but
 * the client re-sorts defensively rather than trusting wire order — the API
 * comment at `profile-badges.service.ts:98` notes `sort_order` is returned
 * as a number specifically so the client can do this. Ties break on
 * `badge_id` (the one tiebreaker field the client actually has) for a
 * deterministic result regardless of input order; `Array.prototype.sort` is
 * stable, but this is a public function that may be called on a
 * re-assembled or hand-built array, not just the wire response, so it
 * doesn't rely on that alone. Pure — never mutates the input.
 */
export function sortProfileBadges(badges: readonly ProfileBadge[]): ProfileBadge[] {
    return [...badges].sort((a, b) => {
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
        return a.badge_id < b.badge_id ? -1 : a.badge_id > b.badge_id ? 1 : 0;
    });
}
