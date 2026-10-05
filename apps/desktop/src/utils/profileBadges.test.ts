import { describe, expect, it } from 'vitest';
import {
    DEFAULT_PROFILE_BADGE_COLOR,
    DEFAULT_PROFILE_BADGE_ICON,
    PROFILE_BADGE_COLOR_TOKENS,
    PROFILE_BADGE_ICONS,
    resolveProfileBadgeColor,
    resolveProfileBadgeIcon,
    sortProfileBadges,
    type ProfileBadge,
} from './profileBadges';

/**
 * The admin's exact allowlists, copied from `admin/src/profile/validation.js`
 * (`BADGE_ICONS` / `BADGE_COLORS`) as of 2026-09-14. These are duplicated
 * here on purpose — NOT imported — so a test run fails loudly the moment
 * this file's static maps drift from what an admin can actually pick,
 * instead of only failing when someone happens to grant a badge with the
 * missing name.
 */
const ADMIN_BADGE_ICONS = [
    'anchor', 'award', 'badge-check', 'bot', 'bug', 'cake', 'camera', 'code',
    'coffee', 'compass', 'cpu', 'crown', 'feather', 'flame', 'gamepad-2', 'gem',
    'ghost', 'gift', 'globe', 'hammer', 'headphones', 'heart', 'infinity', 'key',
    'leaf', 'lock', 'medal', 'mic', 'moon', 'music', 'palette', 'rocket',
    'shield', 'sparkles', 'star', 'sun', 'terminal', 'trophy', 'wrench', 'zap',
];

const ADMIN_BADGE_COLORS = [
    'accent', 'gold', 'red', 'orange', 'green', 'cyan', 'blue', 'purple',
    'pink', 'slate',
];

function badge(overrides: Partial<ProfileBadge>): ProfileBadge {
    return {
        badge_id: 'b1',
        icon: 'award',
        color: 'accent',
        label: 'Label',
        sort_order: 0,
        ...overrides,
    };
}

describe('profileBadges icon allowlist coverage', () => {
    it('has exactly the admin allowlist count (catches additions/removals on either side)', () => {
        // Positive-controlled: temporarily deleting one entry from
        // PROFILE_BADGE_ICONS and re-running this test fails it (verified
        // manually — 39 !== 40); restored before commit.
        expect(Object.keys(PROFILE_BADGE_ICONS).length).toBe(ADMIN_BADGE_ICONS.length);
    });

    it.each(ADMIN_BADGE_ICONS)('resolves admin icon "%s" to a real component, not the fallback', (name) => {
        const resolved = resolveProfileBadgeIcon(name);
        expect(resolved).toBeDefined();
        expect(resolved).not.toBe(DEFAULT_PROFILE_BADGE_ICON);
        expect(resolved).toBe(PROFILE_BADGE_ICONS[name]);
    });

    it('has no icon name outside the admin allowlist (catches stale/renamed entries)', () => {
        const extra = Object.keys(PROFILE_BADGE_ICONS).filter((k) => !ADMIN_BADGE_ICONS.includes(k));
        expect(extra).toEqual([]);
    });
});

describe('profileBadges color allowlist coverage', () => {
    it('has exactly the admin allowlist count', () => {
        expect(Object.keys(PROFILE_BADGE_COLOR_TOKENS).length).toBe(ADMIN_BADGE_COLORS.length);
    });

    it.each(ADMIN_BADGE_COLORS)('resolves admin color "%s" to its own distinct token set', (name) => {
        const resolved = resolveProfileBadgeColor(name);
        expect(resolved).toEqual(PROFILE_BADGE_COLOR_TOKENS[name]);
    });

    it('maps every admin color name to a visually distinct `text` class (no accidental collapsing)', () => {
        // Guards the exact failure mode flagged while designing this map: an
        // admin picking 10 different colors to tell badges apart would have
        // that intent silently defeated if two names resolved to the same
        // token. Positive-controlled: temporarily aliasing 'pink' to the
        // 'red' token set and re-running this test fails it (verified
        // manually — Set size 9 !== 10); restored before commit.
        const texts = ADMIN_BADGE_COLORS.map((name) => PROFILE_BADGE_COLOR_TOKENS[name].text);
        expect(new Set(texts).size).toBe(ADMIN_BADGE_COLORS.length);
    });

    it('has no color name outside the admin allowlist', () => {
        const extra = Object.keys(PROFILE_BADGE_COLOR_TOKENS).filter((k) => !ADMIN_BADGE_COLORS.includes(k));
        expect(extra).toEqual([]);
    });
});

describe('resolveProfileBadgeIcon fallback', () => {
    it('falls back to the generic icon for an unrecognised name', () => {
        expect(resolveProfileBadgeIcon('totally-made-up')).toBe(DEFAULT_PROFILE_BADGE_ICON);
    });

    it('falls back for null/undefined/empty without throwing', () => {
        expect(resolveProfileBadgeIcon(null)).toBe(DEFAULT_PROFILE_BADGE_ICON);
        expect(resolveProfileBadgeIcon(undefined)).toBe(DEFAULT_PROFILE_BADGE_ICON);
        expect(resolveProfileBadgeIcon('')).toBe(DEFAULT_PROFILE_BADGE_ICON);
    });

    it('does not fall through the object prototype for a dangerous key', () => {
        // Positive-controlled: swapping `hasOwnProperty.call` for a plain
        // `PROFILE_BADGE_ICONS[icon]` lookup and re-running this test fails
        // it (verified manually — 'constructor' resolves to Object's
        // constructor function instead of the fallback); restored before
        // commit.
        expect(resolveProfileBadgeIcon('constructor')).toBe(DEFAULT_PROFILE_BADGE_ICON);
        expect(resolveProfileBadgeIcon('toString')).toBe(DEFAULT_PROFILE_BADGE_ICON);
    });
});

describe('resolveProfileBadgeColor fallback', () => {
    it('falls back to the accent tokens for an unrecognised name', () => {
        expect(resolveProfileBadgeColor('totally-made-up')).toEqual(PROFILE_BADGE_COLOR_TOKENS[DEFAULT_PROFILE_BADGE_COLOR]);
    });

    it('falls back for null/undefined/empty without throwing', () => {
        expect(resolveProfileBadgeColor(null)).toEqual(PROFILE_BADGE_COLOR_TOKENS.accent);
        expect(resolveProfileBadgeColor(undefined)).toEqual(PROFILE_BADGE_COLOR_TOKENS.accent);
        expect(resolveProfileBadgeColor('')).toEqual(PROFILE_BADGE_COLOR_TOKENS.accent);
    });

    it('does not fall through the object prototype for a dangerous key', () => {
        expect(resolveProfileBadgeColor('constructor')).toEqual(PROFILE_BADGE_COLOR_TOKENS.accent);
    });
});

describe('sortProfileBadges', () => {
    it('sorts ascending by sort_order', () => {
        const input = [badge({ badge_id: 'b', sort_order: 5 }), badge({ badge_id: 'a', sort_order: -2 }), badge({ badge_id: 'c', sort_order: 0 })];
        // Positive-controlled: temporarily flipping the comparator's sign
        // (`b.sort_order - a.sort_order`) and re-running this test fails it
        // (verified manually — order came back [b, c, a]); restored before
        // commit.
        expect(sortProfileBadges(input).map((b) => b.badge_id)).toEqual(['a', 'c', 'b']);
    });

    it('breaks ties on sort_order by badge_id ascending, deterministically', () => {
        const input = [badge({ badge_id: 'zebra', sort_order: 1 }), badge({ badge_id: 'apple', sort_order: 1 }), badge({ badge_id: 'mango', sort_order: 1 })];
        expect(sortProfileBadges(input).map((b) => b.badge_id)).toEqual(['apple', 'mango', 'zebra']);
    });

    it('does not mutate the input array', () => {
        const input = [badge({ badge_id: 'b', sort_order: 2 }), badge({ badge_id: 'a', sort_order: 1 })];
        const copy = [...input];
        sortProfileBadges(input);
        expect(input).toEqual(copy);
    });

    it('returns an empty array for an empty input, never throws', () => {
        expect(sortProfileBadges([])).toEqual([]);
    });
});
