/**
 * Profile extras - the client half: level + showcase slots, the interests
 * catalog, "Friends since" formatting + anniversary logic,
 * and the high-five rules the UI mirrors.
 *
 * MIRRORS apps/api/src/auth/profile-extras.ts (ids, curve, slot levels). The
 * desktop and API share no source; `profileExtras.test.ts` reads that file and
 * fails on drift. The SERVER computes the level and enforces every limit; the
 * client only draws the picker. Levels are client-attested (achievements), so
 * they unlock cosmetics ONLY.
 */

// ── level + showcase ─────────────────────────────────────────────────────────

export const MAX_LEVEL = 10;
export const BASE_SHOWCASE_SLOTS = 3;
export const SLOT_LEVELS = [3, 6, 10] as const;
export const pointsForLevel = (n: number): number => n * n;
export const showcaseSlots = (level: number): number => BASE_SHOWCASE_SLOTS + SLOT_LEVELS.filter((l) => level >= l).length;

export const SHOWCASE_BLOCKS = ['links', 'games', 'steam', 'achievements', 'most_played', 'interests'] as const;
export type ShowcaseBlock = (typeof SHOWCASE_BLOCKS)[number];
/** Steam (shown only when verified), games, links. `eggs` was retired 2026-10-24: it is ignored if a server still sends it. */
export const DEFAULT_SHOWCASE_BLOCKS: readonly ShowcaseBlock[] = ['steam', 'games', 'links'];
export const TOP_ACHIEVEMENTS_MAX = 3;
/** How many About blocks a card shows open; the rest fold under "Show more". */
export const ABOUT_BLOCKS_EXPANDED_MAX = 4;
export const BLOCK_LABELS: Readonly<Record<ShowcaseBlock, string>> = {
    links: 'Links', games: 'Favorite games', steam: 'Steam', achievements: 'Top achievements',
    most_played: 'Most played this week', interests: 'Interests',
};

export interface ProfileShowcase { blocks: ShowcaseBlock[]; top_achievements: string[] }

const isBlock = (b: unknown): b is ShowcaseBlock => (SHOWCASE_BLOCKS as readonly unknown[]).includes(b);

/** What the server sent (or an old server did not) -> blocks to draw, in order. */
export function showcaseBlocksOf(s: { blocks?: unknown; top_achievements?: unknown } | null | undefined): ProfileShowcase {
    if (!s || !Array.isArray(s.blocks)) return { blocks: [...DEFAULT_SHOWCASE_BLOCKS], top_achievements: [] };
    const blocks = [...new Set(s.blocks.filter(isBlock))];
    const top = Array.isArray(s.top_achievements) ? s.top_achievements.filter((x): x is string => typeof x === 'string').slice(0, TOP_ACHIEVEMENTS_MAX) : [];
    return { blocks, top_achievements: top };
}

/** "Level 3 unlocks a 4th slot" - the next level that adds a slot, or null at the top. */
export function nextSlotLevel(level: number): number | null {
    return SLOT_LEVELS.find((l) => level < l) ?? null;
}

// ── interests ────────────────────────────────────────────────────────────────

export const INTERESTS_MAX = 8;
export type InterestGroup = 'Games' | 'Music' | 'Hobbies' | 'Tech';
export interface Interest { id: string; label: string; group: InterestGroup }

const g = (group: InterestGroup, pairs: Array<[string, string]>): Interest[] => pairs.map(([id, label]) => ({ id, label, group }));
export const INTERESTS: readonly Interest[] = [
    ...g('Games', [
        ['fps', 'Shooters'], ['rpg', 'RPGs'], ['mmo', 'MMOs'], ['strategy', 'Strategy'], ['moba', 'MOBAs'], ['survival', 'Survival'],
        ['sandbox', 'Sandbox'], ['roguelike', 'Roguelikes'], ['racing', 'Racing'], ['fighting-games', 'Fighting games'],
        ['puzzle-games', 'Puzzle games'], ['indie-games', 'Indie games'], ['horror-games', 'Horror games'], ['simulation', 'Simulation'],
        ['sports-games', 'Sports games'], ['retro-gaming', 'Retro gaming'], ['tabletop-rpg', 'Tabletop RPGs'],
    ]),
    ...g('Music', [
        ['indie-music', 'Indie'], ['hip-hop', 'Hip-hop'], ['electronic', 'Electronic'], ['rock', 'Rock'], ['metal', 'Metal'], ['jazz', 'Jazz'],
        ['classical', 'Classical'], ['lofi', 'Lo-fi'], ['pop', 'Pop'], ['k-pop', 'K-pop'], ['synthwave', 'Synthwave'],
        ['live-music', 'Live music'], ['guitar', 'Guitar'], ['making-music', 'Making music'],
    ]),
    ...g('Hobbies', [
        ['anime', 'Anime'], ['movies', 'Movies'], ['reading', 'Reading'], ['writing', 'Writing'], ['drawing', 'Drawing'],
        ['photography', 'Photography'], ['cooking', 'Cooking'], ['baking', 'Baking'], ['hiking', 'Hiking'], ['travel', 'Travel'],
        ['fitness', 'Fitness'], ['running', 'Running'], ['cycling', 'Cycling'], ['board-games', 'Board games'], ['chess', 'Chess'],
        ['coffee', 'Coffee'], ['pets', 'Pets'], ['cars', 'Cars'], ['skateboarding', 'Skateboarding'],
    ]),
    ...g('Tech', [
        ['programming', 'Programming'], ['open-source', 'Open source'], ['linux', 'Linux'], ['privacy', 'Privacy'],
        ['pc-building', 'PC building'], ['hardware', 'Hardware'], ['3d-printing', '3D printing'], ['ai', 'AI'],
        ['cybersecurity', 'Cybersecurity'], ['game-dev', 'Game dev'], ['robotics', 'Robotics'], ['space', 'Space'],
    ]),
];
const BY_ID = new Map(INTERESTS.map((i) => [i.id, i]));
export const interestLabel = (id: string): string => BY_ID.get(id)?.label ?? id;

/** Known, unique tags only (an id a newer/older server sends that we lack is dropped). */
export function cleanInterests(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.filter((x): x is string => typeof x === 'string' && BY_ID.has(x)))].slice(0, INTERESTS_MAX);
}

/** Interests both people have, in THEIR order (so the card keeps one stable order). */
export function sharedInterests(mine: readonly string[] | null | undefined, theirs: readonly string[] | null | undefined): string[] {
    const m = new Set(mine ?? []);
    return (theirs ?? []).filter((id) => m.has(id));
}

/** "You both like: Shooters, Anime and Linux", or null when nothing is shared. */
export function youBothLikeLine(shared: readonly string[]): string | null {
    if (shared.length === 0) return null;
    const names = shared.map(interestLabel);
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    return `You both like: ${list}`;
}

// ── friends since + anniversary ──────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** 'YYYY-MM' -> 'July 2025'. Anything else (including a full date) -> null: month precision only. */
export function formatFriendsSince(month: unknown): string | null {
    if (typeof month !== 'string') return null;
    const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
    return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Whole years of friendship if `now` (LOCAL calendar day) is the anniversary of
 * the accepted instant `sinceIso`, else 0. Both are read in local time. A
 * 29 Feb friendship is celebrated on 28 Feb in non-leap years. Day one (0
 * years) is not an anniversary.
 */
export function anniversaryYears(sinceIso: string | null | undefined, now: Date): number {
    if (!sinceIso) return 0;
    const t = new Date(sinceIso);
    if (Number.isNaN(t.getTime())) return 0;
    const years = now.getFullYear() - t.getFullYear();
    if (years < 1) return 0;
    const month = t.getMonth();
    let day = t.getDate();
    if (month === 1 && day === 29) {
        const leap = new Date(now.getFullYear(), 1, 29).getMonth() === 1;
        if (!leap) day = 28;
    }
    return now.getMonth() === month && now.getDate() === day ? years : 0;
}

/** Key for "already toasted this friend's anniversary this year" (local year). */
export const anniversaryToastKey = (friendId: string, now: Date): string => `${friendId}:${now.getFullYear()}-${pad(now.getMonth() + 1)}`;

// ── high five ────────────────────────────────────────────────────────────────

/** DND = count only: no toast, no animation. Anything else celebrates. */
export function shouldCelebrateHighFive(dndActive: boolean, status: string | null | undefined): boolean {
    return !dndActive && status !== 'dnd';
}

export type HighFiveResult = 'sent' | 'already' | 'gone' | 'error';

/** Map the POST /v1/users/:id/high-five outcome to the button state. */
export function highFiveResultOf(httpStatus: number | undefined, message?: unknown): HighFiveResult {
    if (httpStatus === undefined) return 'error';
    if (httpStatus >= 200 && httpStatus < 300) return 'sent';
    // 429 is also the throttler's answer; only the server's own wording means "already today".
    if (httpStatus === 429) return typeof message === 'string' && /high-fived today/i.test(message) ? 'already' : 'error';
    if (httpStatus === 404) return 'gone';
    return 'error';
}
