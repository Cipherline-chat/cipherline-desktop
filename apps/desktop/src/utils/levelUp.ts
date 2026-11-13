/**
 * Level-up celebration: the pure half (components/levelUp/LevelUpHost.tsx
 * binds it; LevelUpCelebration.tsx draws it).
 *
 * The level itself is the SERVER's (`/auth/me` profile_level, computed from
 * achievements + easter eggs, cosmetic only — apps/api/src/auth/profile-extras.ts).
 * This module decides only WHETHER and HOW to celebrate a level this device
 * sees, and remembers per account which level it last celebrated, so that:
 *
 *   - each level is celebrated once (never on a restart, never again after a
 *     backup restore: the record travels in backups, see backupRegistry.ts);
 *   - the first time this record is created (first run after the update, a
 *     new device, a new sign-in) the current level is adopted SILENTLY: levels
 *     the account already had are never celebrated;
 *   - a level that grew without anything happening on THIS device (another
 *     device's unlocks, picked up by an unrelated profile refresh) is adopted
 *     silently too: the device where it happened already celebrated it
 *     ("armed" = a local unlock / egg find just happened, LevelUpHost);
 *   - a level going DOWN (a retired achievement) never celebrates and never
 *     lowers the record, so getting it back cannot replay it;
 *   - the FIRST celebration is the big one: only when the account was at
 *     level 0 or 1 before it (a new account's 0 -> 1, or 1 -> 2 for someone
 *     who was level 1 when this shipped), and only once (`big`).
 *
 * Nothing here is sent anywhere. The record is a tiny JSON blob in
 * secureLocalStore (encrypted at rest, per account).
 */
import { AVATAR_DECORATIONS, PROFILE_EFFECTS } from './profileCosmetics';
import { MAX_LEVEL, SLOT_LEVELS, pointsForLevel, showcaseSlots } from './profileExtras';

export const levelUpKey = (uid: string): string => `cipherline_level_up_${uid}`;

export interface LevelUpRecord {
    /** The highest level this account has celebrated (or silently adopted) on this device. */
    level: number;
    /** Has the big first-level-up sequence been shown? */
    big: boolean;
}

const cleanLevel = (n: unknown): number | null =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.min(MAX_LEVEL, Math.floor(n)) : null;

/** Defensive parse: missing, corrupt or hand-edited -> null ("no record yet"). */
export function parseLevelUpRecord(raw: string | null): LevelUpRecord | null {
    if (!raw) return null;
    try {
        const v = JSON.parse(raw) as Partial<LevelUpRecord> | null;
        if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
        const level = cleanLevel(v.level);
        if (level === null) return null;
        return { level, big: v.big === true };
    } catch {
        return null;
    }
}

export const serializeLevelUpRecord = (r: LevelUpRecord): string => JSON.stringify({ level: r.level, big: r.big });

export type LevelUpVariant = 'big' | 'short';

export type LevelUpDecision =
    /** Nothing to do (unknown level, same level, or lower). */
    | { kind: 'none' }
    /** Write `record` and show nothing (first run / growth this device did not cause). */
    | { kind: 'adopt'; record: LevelUpRecord }
    /** Celebrate `level` (from `from`); write `record` when it starts playing. */
    | { kind: 'celebrate'; level: number; from: number; variant: LevelUpVariant; record: LevelUpRecord };

/**
 * What to do now that the server says the account is at `observed`.
 * `armed`: something happened on THIS device just before (an unlock, an egg).
 */
export function decideLevelUp(record: LevelUpRecord | null, observed: unknown, armed: boolean): LevelUpDecision {
    const level = cleanLevel(observed);
    if (level === null) return { kind: 'none' };
    if (!record) return { kind: 'adopt', record: { level, big: false } };
    if (level <= record.level) return { kind: 'none' };
    if (!armed) return { kind: 'adopt', record: { level, big: record.big } };
    const variant: LevelUpVariant = !record.big && record.level <= 1 ? 'big' : 'short';
    return { kind: 'celebrate', level, from: record.level, variant, record: { level, big: record.big || variant === 'big' } };
}

/** When the celebration's Continue has finished rising, per variant (styles/level-up.css timeline). */
export const LEVEL_UP_INTRO_MS: Readonly<Record<LevelUpVariant, number>> = { big: 3300, short: 1600 };
export const LEVEL_UP_EXIT_MS = 300;
export const LEVEL_UP_EXIT_STILL_MS = 120;

/** How the celebration is drawn: the full sequence, or the still card (prefers-reduced-motion). */
export type LevelUpMotion = 'full' | 'still';
export const levelUpMotion = (reducedMotion: boolean): LevelUpMotion => (reducedMotion ? 'still' : 'full');

// ── what a level unlocks (from the catalogs the picker uses) ────────────────

export interface LevelUnlock {
    kind: 'decoration' | 'effect' | 'slot';
    /** Decoration / effect id ('' for a slot). */
    id: string;
    label: string;
    /** "Avatar decoration", "Profile effect", "Showcase". */
    category: string;
}

const ORDINAL = ['zeroth', 'first', 'second', 'third', '4th', '5th', '6th', '7th', '8th', '9th'];
const ordinal = (n: number): string => (n < ORDINAL.length ? ORDINAL[n] : `${n}th`);

/**
 * Everything reaching exactly `level` adds: the picker-listed decorations and
 * effects whose rule is that level (legacy colour variants are not listed: the
 * hue option replaced them), and a showcase slot on a slot level.
 */
export function unlocksAtLevel(level: number): LevelUnlock[] {
    const out: LevelUnlock[] = [];
    for (const d of AVATAR_DECORATIONS) {
        if (!d.legacy && d.rule.kind === 'level' && d.rule.min === level) out.push({ kind: 'decoration', id: d.id, label: d.label, category: 'Avatar decoration' });
    }
    for (const e of PROFILE_EFFECTS) {
        if (!e.legacy && e.rule.kind === 'level' && e.rule.min === level) out.push({ kind: 'effect', id: e.id, label: e.label, category: 'Profile effect' });
    }
    if ((SLOT_LEVELS as readonly number[]).includes(level)) {
        out.push({ kind: 'slot', id: '', label: `A ${ordinal(showcaseSlots(level))} showcase section`, category: 'Profile showcase' });
    }
    return out;
}

/** Everything a jump from `from` to `to` unlocks, in level order. */
export function unlocksBetween(from: number, to: number): LevelUnlock[] {
    const out: LevelUnlock[] = [];
    for (let l = Math.max(1, from + 1); l <= Math.min(MAX_LEVEL, to); l++) out.push(...unlocksAtLevel(l));
    return out;
}

/** The next level above `level` that unlocks anything (null at the top). */
export function nextUnlockLevel(level: number): number | null {
    for (let l = level + 1; l <= MAX_LEVEL; l++) if (unlocksAtLevel(l).length > 0) return l;
    return null;
}

/** "Dive bezel and Sonar", "A, B and C". */
export function joinLabels(labels: readonly string[]): string {
    if (labels.length <= 1) return labels[0] ?? '';
    return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

export interface LevelUpCopy {
    eyebrow: string;
    title: string;
    line: string;
    /** "5 of 9 points to level 3" (null at the top or when the points are unknown). */
    progress: { label: string; fraction: number } | null;
    /** Said once through the live region. */
    announcement: string;
}

/** The words on the card. `points` / `nextPoints` come from /auth/me (may be absent). */
export function levelUpCopy(level: number, variant: LevelUpVariant, points?: number | null, nextPoints?: number | null): LevelUpCopy {
    const top = level >= MAX_LEVEL;
    const floor = pointsForLevel(level);
    const progress = !top && typeof points === 'number' && typeof nextPoints === 'number' && nextPoints > floor && points >= floor && points < nextPoints
        ? { label: `${points} of ${nextPoints} points to level ${level + 1}`, fraction: (points - floor) / (nextPoints - floor) }
        : null;
    return {
        eyebrow: variant === 'big' ? 'Your first level up' : 'Level up',
        title: top ? `Level ${level}. The top.` : variant === 'big' ? `Level ${level}!` : `Level ${level}`,
        line: top
            ? 'Nothing deeper than this. Every light down here is yours.'
            : variant === 'big'
                ? 'Every achievement and easter egg you find lights the way up.'
                : 'Still rising. Keep exploring.',
        progress,
        announcement: `Level up! You reached profile level ${level}.`,
    };
}
