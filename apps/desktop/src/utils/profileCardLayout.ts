/**
 * What the profile card shows, for THIS viewer, and in what order.
 *
 * The card is one calm column (no tabs): the owner's showcase blocks in their
 * order, then the two sections that used to have tabs of their own -
 * achievements and most played - when the owner did not place them. A section
 * with nothing to show is never drawn: an empty "Most played" on a stranger's
 * card would say "this person has (or hides) activity", and the server already
 * answers a stranger with the same empty list as a user with nothing.
 *
 * Pure; ProfileCard renders whatever this returns.
 */
import { ACHIEVEMENTS, achievementById, type AchievementDef, type AchievementTier } from './achievements/catalog';
import { ABOUT_BLOCKS_EXPANDED_MAX, TOP_ACHIEVEMENTS_MAX, type ShowcaseBlock } from './profileExtras';

export interface SectionInput {
    /** The owner's blocks, in their order (showcaseBlocksOf(...).blocks). */
    blocks: readonly ShowcaseBlock[];
    /** Whether each block has something to show to this viewer. */
    has: Readonly<Record<ShowcaseBlock, boolean>>;
}

/**
 * Owner blocks with content, in order; then `achievements` and `most_played`
 * when they have content but were not placed by the owner (they always had a
 * home on the card, as tabs).
 */
export function cardSections({ blocks, has }: SectionInput): ShowcaseBlock[] {
    const out: ShowcaseBlock[] = [];
    for (const b of blocks) if (has[b] && !out.includes(b)) out.push(b);
    for (const b of ['achievements', 'most_played'] as const) if (has[b] && !out.includes(b)) out.push(b);
    return out;
}

/** The first `ABOUT_BLOCKS_EXPANDED_MAX` open; the rest fold under "Show N more". */
export function splitFold<T>(sections: readonly T[], max = ABOUT_BLOCKS_EXPANDED_MAX): { open: T[]; folded: T[] } {
    return { open: sections.slice(0, max), folded: sections.slice(max) };
}

// ── achievements on the card ─────────────────────────────────────────────────

export const TIER_RANK: Readonly<Record<AchievementTier, number>> = { gold: 3, silver: 2, bronze: 1 };

export interface UnlockedAchievement { id: string; month: string }

/**
 * The (up to three) medallions on the card: the owner's own picks when they
 * made any (still-unlocked, known ids only), otherwise the rarest unlocked -
 * gold before silver before bronze, the most recent first within a tier.
 */
export function featuredAchievements(
    unlocked: readonly UnlockedAchievement[] | null | undefined,
    picks: readonly string[] | null | undefined,
    max = TOP_ACHIEVEMENTS_MAX,
): AchievementDef[] {
    const known = (id: string) => achievementById(id);
    const picked = (picks ?? []).map(known).filter((d): d is AchievementDef => !!d);
    if (picked.length > 0) {
        // Picks are validated server-side; when we also know the unlocked list,
        // drop anything no longer in it (a pick can outlive a data reset).
        const have = unlocked ? new Set(unlocked.map((u) => u.id)) : null;
        const kept = have ? picked.filter((d) => have.has(d.id)) : picked;
        if (kept.length > 0) return kept.slice(0, max);
    }
    if (!unlocked) return [];
    const month = new Map(unlocked.map((u) => [u.id, u.month]));
    return ACHIEVEMENTS
        .filter((a) => month.has(a.id))
        .sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || (month.get(b.id) ?? '').localeCompare(month.get(a.id) ?? ''))
        .slice(0, max);
}

export type AchievementFilter = 'unlocked' | 'locked';

/**
 * The "View all" sheet: unlocked (rarest, then newest) or locked (closest to
 * done first when progress is known - your own card - else catalog order).
 */
export function achievementsFor(
    filter: AchievementFilter,
    unlocked: readonly UnlockedAchievement[] | null | undefined,
    progress?: Readonly<Record<string, { current: number; target: number }>> | null,
): AchievementDef[] {
    const month = new Map((unlocked ?? []).map((u) => [u.id, u.month]));
    if (filter === 'unlocked') {
        return ACHIEVEMENTS
            .filter((a) => month.has(a.id))
            .sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || (month.get(b.id) ?? '').localeCompare(month.get(a.id) ?? ''));
    }
    const locked = ACHIEVEMENTS.filter((a) => !month.has(a.id));
    if (!progress) return locked;
    const frac = (a: AchievementDef) => {
        const p = progress[a.id];
        return p && p.target > 0 ? Math.min(1, p.current / p.target) : 0;
    };
    // Secret ones go last and never sort by progress (that would hint at what they are).
    return [...locked].sort((a, b) => (Number(a.secret) - Number(b.secret)) || (a.secret ? 0 : frac(b) - frac(a)));
}

/** 0..1 ring fill for a level (the level ring on the card). */
export const levelFill = (level: number, max: number): number => (max > 0 ? Math.max(0, Math.min(1, level / max)) : 0);
