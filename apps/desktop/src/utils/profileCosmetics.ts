/**
 * Avatar decorations + profile effects: the catalog, unlock rules, per-item
 * option schemas and seasonal windows.
 *
 * MIRRORS apps/api/src/auth/profile-cosmetics.catalog.ts (ids, rules, option
 * specs, seasons; the desktop and API share no source - `profileCosmetics.test.ts`
 * imports that file and fails on drift). The SERVER enforces the rules on
 * PATCH /auth/profile and POST /auth/cosmetics/claim; this module only drives
 * the picker (locked items say how to unlock them).
 * Nothing here is a paid perk: an item is free, an easter-egg unlock, a
 * profile-level unlock, an achievement unlock or a limited-time (seasonal) claim.
 *
 * The art for each id lives in components/ProfileCosmetics.tsx (decorations,
 * SVG) and components/cosmetics/effects/ (effects, canvas). An id this client
 * does not know renders nothing.
 */
import { EGG_IDS } from './eggProgress';
import { ACHIEVEMENTS } from './achievements/catalog';

export type UnlockRule =
    | { kind: 'free' }
    | { kind: 'egg'; egg: string }
    | { kind: 'eggs'; min: number }
    /** Profile level (utils/profileLevel.ts). Cosmetic-only: levels are client-attested. */
    | { kind: 'level'; min: number }
    /** One achievement (the server's achievement-registry). Cosmetic-only. */
    | { kind: 'achievement'; id: string }
    /** Limited time: claimable while SEASONS[season] runs, kept forever once claimed. */
    | { kind: 'seasonal'; season: string };

export interface CosmeticItem {
    id: string;
    label: string;
    rule: UnlockRule;
    /** One line for the picker's detail strip. */
    blurb?: string;
    /**
     * Still rendered and still equippable by accounts that hold it, but the
     * picker does not list it (the pre-options colour variants: the hue
     * option on the base item replaces them).
     */
    legacy?: true;
}

const FREE: UnlockRule = { kind: 'free' };
const HALLOWEEN: UnlockRule = { kind: 'seasonal', season: 'halloween-2026' };
const WINTER: UnlockRule = { kind: 'seasonal', season: 'winter-2026' };

export const AVATAR_DECORATIONS: readonly CosmeticItem[] = [
    { id: 'lume-ring', label: 'Lume ring', rule: FREE, blurb: 'A clean ring of light with a glint that travels around it.' },
    { id: 'deep-dash', label: 'Deep dash', rule: FREE, blurb: 'A dashed ring that turns slowly. Try Morse.' },
    { id: 'keys-peek', label: 'Keys peeking', rule: FREE, blurb: 'Keys, peeking over the top of your avatar.' },
    { id: 'dive-bezel', label: 'Dive bezel', rule: FREE, blurb: 'A diver\'s watch bezel with a lume pip at twelve.' },
    { id: 'kelp', label: 'Kelp', rule: FREE, blurb: 'A kelp bed rising up your left side, swaying slowly.' },
    { id: 'seagrass', label: 'Seagrass', rule: FREE, blurb: 'Long ribbons of eelgrass leaning in the current.' },
    { id: 'starfish', label: 'Starfish', rule: FREE, blurb: 'A starfish holding on to the edge.' },
    { id: 'sea-fan', label: 'Sea fan', rule: { kind: 'level', min: 3 }, blurb: 'A gorgonian fan, every branch grown, never drawn.' },
    { id: 'bull-kelp', label: 'Bull kelp', rule: { kind: 'level', min: 5 }, blurb: 'A float and its blades streaming over your avatar.' },
    { id: 'anglerfish', label: 'Anglerfish', rule: { kind: 'level', min: 7 }, blurb: 'Its lure glows over your avatar.' },
    { id: 'aurora-ring', label: 'Aurora ring', rule: { kind: 'eggs', min: 3 }, blurb: 'Colours flowing around the ring.' },
    { id: 'jellyfish', label: 'Jellyfish', rule: { kind: 'eggs', min: 5 }, blurb: 'A moon jelly drifting over your shoulder.' },
    { id: 'abyss-halo', label: 'Abyss halo', rule: { kind: 'eggs', min: 8 }, blurb: 'A halo breathing slowly in the dark.' },
    { id: 'manta', label: 'Manta', rule: { kind: 'eggs', min: 12 }, blurb: 'A manta banking over your avatar, lit from above.' },
    { id: 'keys-crown', label: 'Keys, crowned', rule: { kind: 'egg', egg: 'keys-finale-crown' }, blurb: 'Keys, crowned.' },
    { id: 'pearl-string', label: 'Pearl string', rule: { kind: 'achievement', id: 'verify-15' }, blurb: 'A string of pearls, one for every safety number you checked.' },
    { id: 'jack-o-lantern', label: 'Jack-o\'-lantern', rule: HALLOWEEN, blurb: 'A carved pumpkin with a candle that flickers.' },
    { id: 'vampire-squid', label: 'Vampire squid', rule: HALLOWEEN, blurb: 'The deep sea\'s own vampire, cloaked over your shoulder.' },
    { id: 'frost-crown', label: 'Frost crown', rule: WINTER, blurb: 'Ice crystals growing along the top of your avatar.' },
    // Legacy colour variants (see CosmeticItem.legacy).
    { id: 'lume-ring-ember', label: 'Lume ring, ember', rule: { kind: 'level', min: 5 }, legacy: true },
    { id: 'deep-dash-ember', label: 'Deep dash, ember', rule: { kind: 'level', min: 5 }, legacy: true },
    { id: 'keys-peek-ember', label: 'Keys peeking, ember', rule: { kind: 'level', min: 5 }, legacy: true },
    { id: 'lume-ring-violet', label: 'Lume ring, violet', rule: { kind: 'level', min: 8 }, legacy: true },
    { id: 'deep-dash-violet', label: 'Deep dash, violet', rule: { kind: 'level', min: 8 }, legacy: true },
    { id: 'keys-peek-violet', label: 'Keys peeking, violet', rule: { kind: 'level', min: 8 }, legacy: true },
];

export const PROFILE_EFFECTS: readonly CosmeticItem[] = [
    { id: 'bubbles', label: 'Bubbles', rule: FREE, blurb: 'Bubbles wobbling up through the card.' },
    { id: 'glimmer', label: 'Glimmer', rule: FREE, blurb: 'Points of light that catch and fade.' },
    { id: 'plankton', label: 'Plankton', rule: FREE, blurb: 'Tiny motes drifting up through the card.' },
    { id: 'sonar', label: 'Sonar', rule: FREE, blurb: 'A slow ping out from your avatar.' },
    { id: 'current', label: 'Current', rule: { kind: 'level', min: 3 }, blurb: 'Threads of light carried on a deep current.' },
    { id: 'god-rays', label: 'God rays', rule: { kind: 'level', min: 6 }, blurb: 'Shafts of sunlight reaching down, with motes caught in them.' },
    { id: 'keepsake-rain', label: 'Keepsake rain', rule: { kind: 'level', min: 10 }, blurb: 'Your avatar, or one of your own emojis, drifting down the card.' },
    { id: 'confetti', label: 'Confetti', rule: { kind: 'egg', egg: 'konami' }, blurb: 'A celebration that never quite ends.' },
    { id: 'bioluminescence', label: 'Bioluminescence', rule: { kind: 'eggs', min: 6 }, blurb: 'Lights waking up across the card, in waves.' },
    { id: 'abyss-snow', label: 'Abyss snow', rule: { kind: 'eggs', min: 15 }, blurb: 'Marine snow sinking into the deep.' },
    { id: 'shooting-stars', label: 'Shooting stars', rule: { kind: 'achievement', id: 'streak-30' }, blurb: 'A starry banner, and now and then a streak across it.' },
    { id: 'aurora', label: 'Aurora', rule: { kind: 'achievement', id: 'streak-100' }, blurb: 'Curtains of the northern lights folding over the card.' },
    { id: 'shoal', label: 'Shoal', rule: { kind: 'achievement', id: 'crowd-20' }, blurb: 'A school of fish turning together around you.' },
    { id: 'whale-song', label: 'Whale song', rule: { kind: 'achievement', id: 'voice-500h' }, blurb: 'A great whale passing far below, singing.' },
    { id: 'web-of-trust', label: 'Web of trust', rule: { kind: 'achievement', id: 'verify-30' }, blurb: 'A constellation that links up around you.' },
    { id: 'ghost-lights', label: 'Ghost lights', rule: HALLOWEEN, blurb: 'Will-o\'-the-wisps drifting through the dark.' },
    { id: 'first-snow', label: 'First snow', rule: WINTER, blurb: 'Big, slow snowflakes, every one different.' },
];

// ── Seasons (MIRRORS SEASONS on the server) ──────────────────────────────────
// `from` / `to` are inclusive LOCAL dates. The picker uses the device's own
// calendar; the server accepts the widest envelope any time zone can be in.
export interface Season { from: string; to: string }
export const SEASONS: Readonly<Record<string, Season>> = {
    'halloween-2026': { from: '2026-10-17', to: '2026-11-01' },
    'winter-2026': { from: '2026-12-14', to: '2027-01-04' },
};
export const SEASON_NAMES: Readonly<Record<string, string>> = {
    'halloween-2026': 'Halloween 2026',
    'winter-2026': 'Winter 2026',
};

const localDate = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Is `season` running on this device's calendar date? */
export function isSeasonOpenLocal(season: string, now: Date = new Date()): boolean {
    const s = Object.prototype.hasOwnProperty.call(SEASONS, season) ? SEASONS[season] : null;
    if (!s) return false;
    const today = localDate(now);
    return today >= s.from && today <= s.to;
}

/** Where a season is on this device's calendar. */
export function seasonStatus(season: string, now: Date = new Date()): 'upcoming' | 'open' | 'over' {
    const s = Object.prototype.hasOwnProperty.call(SEASONS, season) ? SEASONS[season] : null;
    if (!s) return 'over';
    const today = localDate(now);
    return today < s.from ? 'upcoming' : today > s.to ? 'over' : 'open';
}

/** "Nov 1" for a season's first / last day. */
const dayLabel = (iso: string | undefined): string => {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const lastDayLabel = (season: string): string => dayLabel(SEASONS[season]?.to);

// ── Per-item options: the generic schema ─────────────────────────────────────
//
// The picker renders these GENERICALLY from `optionSpecsFor(kind, id)`; it
// needs no per-item code. Values are stored in users.cosmetic_options
// { d?: {key: value}, e?: {...} } (d = decoration, e = effect). Absent = the
// spec's default (hue: absent = "Match theme" / the item's stock colour).
//
//   type          key  value                       control the picker draws
//   'hue'         h    integer 0-359               hue swatches (HUE_PRESETS) + "Match theme" (= clear)
//   'range'       i/n/s integer min..max, step     segmented control, one segment per step; `words` name them
//   'choice'      p    index into `choices`        segmented control / small menu of `choices[].label`
//   'color'       c    index into `choices`        swatches, each `choices[].hex`, named by `label`
//   'image-source' m   'avatar' | 'p_<32 hex>'     "Your avatar" + the owner's own My Emojis (PNG/WebP/GIF);
//                                                  NEVER an upload or URL. Friends see the emoji once it was
//                                                  delivered device-to-device (hooks/useStatusEmojiShare.ts);
//                                                  anyone else sees a plain fallback particle.
//
// Every spec has `label` (the control's name) and `default`. The server
// (profile-cosmetics.catalog.ts) validates the same keys and bounds per item.

export type OptionKey = 'h' | 'i' | 'n' | 's' | 'p' | 'c' | 'm';
export type OptionSpec =
    | { key: 'h'; type: 'hue'; label: string; default: null }
    | { key: 'i' | 'n' | 's'; type: 'range'; label: string; min: number; max: number; step: 1; default: number; words: readonly string[] }
    | { key: 'p'; type: 'choice'; label: string; default: number; choices: readonly { value: number; label: string }[] }
    | { key: 'c'; type: 'color'; label: string; default: number; choices: readonly { value: number; label: string; hex: string }[] }
    | { key: 'm'; type: 'image-source'; label: string; default: 'avatar' };

export type ItemOptions = Partial<Record<Exclude<OptionKey, 'm'>, number>> & { m?: string };
export interface CosmeticOptions { d?: ItemOptions; e?: ItemOptions }

const hue = (label = 'Colour'): OptionSpec => ({ key: 'h', type: 'hue', label, default: null });
const range = (key: 'i' | 'n' | 's', label: string, words: readonly [string, string, string]): OptionSpec =>
    ({ key, type: 'range', label, min: 1, max: 3, step: 1, default: 2, words });
const INTENSITY_WORDS = ['Soft', 'Medium', 'Bold'] as const;
const DENSITY_WORDS = ['Sparse', 'Some', 'Lots'] as const;
const SPEED_WORDS = ['Slow', 'Steady', 'Quick'] as const;
const glow = (label = 'Glow') => range('i', label, INTENSITY_WORDS);
const density = (label = 'Density', words: readonly [string, string, string] = DENSITY_WORDS) => range('n', label, words);
const speed = (label = 'Speed') => range('s', label, SPEED_WORDS);
const choice = (label: string, labels: readonly string[], def = 0): OptionSpec =>
    ({ key: 'p', type: 'choice', label, default: def, choices: labels.map((l, value) => ({ value, label: l })) });
const colour = (label: string, sw: readonly (readonly [string, string])[], def = 0): OptionSpec =>
    ({ key: 'c', type: 'color', label, default: def, choices: sw.map(([l, hex], value) => ({ value, label: l, hex })) });

/** Colourways (index = stored value). The art reads the same tables. */
export const STARFISH_COLOURS = [['Coral', '#FF7A59'], ['Sunset', '#FFB341'], ['Violet', '#A77BFF'], ['Sand', '#E8C9A0']] as const;
export const SEA_FAN_COLOURS = [['Violet', '#9C6BFF'], ['Crimson', '#FF4F6D'], ['Gold', '#FFC94D'], ['Ivory', '#F1E6D2']] as const;
export const AURORA_RING_COLOURS = [['Lume', '#25E0C8'], ['Borealis', '#5CFF9D'], ['Dusk', '#B57BFF'], ['Ember', '#FF8A4D']] as const;
export const CROWN_COLOURS = [['Gold', '#FFC94D'], ['Silver', '#DCE4F7'], ['Rose gold', '#F4A38C']] as const;
export const PEARL_COLOURS = [['Akoya', '#F4F1EA'], ['Golden', '#F2C979'], ['Tahitian', '#5B6478'], ['Rose', '#F6C6CF']] as const;
export const AURORA_COLOURS = [['Borealis', '#5CFF9D'], ['Lume', '#25E0C8'], ['Dusk', '#B57BFF'], ['Ember', '#FF8A4D']] as const;
export const GHOST_COLOURS = [['Wisp', '#9DFFCF'], ['Pumpkin', '#FF9A3C'], ['Spectral', '#9CC8FF']] as const;

export const DECORATION_OPTIONS: Readonly<Record<string, readonly OptionSpec[]>> = {
    'lume-ring': [hue(), choice('Style', ['Single', 'Double', 'Halo']), glow()],
    'deep-dash': [hue(), choice('Pattern', ['Dashes', 'Dots', 'Morse']), speed('Spin')],
    'keys-peek': [hue('Keys'), choice('Mood', ['Happy', 'Sleepy', 'Wink'])],
    'dive-bezel': [hue('Lume'), choice('Markings', ['First quarter', 'All around'])],
    'kelp': [hue(), density('Fronds', ['Few', 'Some', 'Lush']), speed('Sway')],
    'seagrass': [hue(), density('Blades', ['Few', 'Some', 'Lush']), speed('Sway')],
    'starfish': [colour('Colour', STARFISH_COLOURS), choice('Texture', ['Spotted', 'Smooth'])],
    'sea-fan': [colour('Colour', SEA_FAN_COLOURS), density('Branches', ['Few', 'Some', 'Lush'])],
    'bull-kelp': [hue(), speed('Drift')],
    'anglerfish': [hue('Lure'), choice('Lure', ['Steady', 'Flicker'])],
    'aurora-ring': [colour('Palette', AURORA_RING_COLOURS), speed('Flow')],
    'jellyfish': [hue(), choice('Jellies', ['One', 'Two'])],
    'abyss-halo': [hue(), glow()],
    'manta': [choice('Species', ['Reef manta', 'Black manta']), hue('Rim light')],
    'keys-crown': [colour('Metal', CROWN_COLOURS)],
    'pearl-string': [colour('Pearls', PEARL_COLOURS)],
    'jack-o-lantern': [choice('Carving', ['Grin', 'Spooky', 'Sweet']), glow('Candle')],
    'vampire-squid': [hue('Glow')],
    'frost-crown': [hue('Ice'), density('Crystals', ['Few', 'Some', 'Lots'])],
};

export const EFFECT_OPTIONS: Readonly<Record<string, readonly OptionSpec[]>> = {
    'bubbles': [hue(), density()],
    'glimmer': [hue(), density()],
    'plankton': [hue(), density()],
    'sonar': [hue(), speed('Ping rate')],
    'current': [hue(), density('Streams'), speed()],
    'god-rays': [hue('Light'), glow('Brightness'), speed('Drift')],
    'keepsake-rain': [{ key: 'm', type: 'image-source', label: 'Image', default: 'avatar' }, density('Amount'), speed('Fall speed')],
    'confetti': [density()],
    'bioluminescence': [hue(), density()],
    'abyss-snow': [density(), speed()],
    'shooting-stars': [hue('Trails'), density('Stars')],
    'aurora': [colour('Palette', AURORA_COLOURS), glow('Brightness'), speed('Flow')],
    'shoal': [hue('Fish'), density('School', ['Small', 'Medium', 'Large'])],
    'whale-song': [hue('Song'), choice('Whale', ['Humpback', 'Blue whale'])],
    'web-of-trust': [hue(), density('Nodes')],
    'ghost-lights': [colour('Colour', GHOST_COLOURS), density()],
    'first-snow': [density(), speed()],
};

/** The option schema for an item ([] = no options). */
export function optionSpecsFor(kind: 'decoration' | 'effect', id: string | null | undefined): readonly OptionSpec[] {
    if (!id) return [];
    const m = kind === 'decoration' ? DECORATION_OPTIONS : EFFECT_OPTIONS;
    return Object.prototype.hasOwnProperty.call(m, id) ? m[id] : [];
}

/** `m` values: the owner's avatar, or one of their own device-only My Emojis. */
export const IMAGE_SOURCE = /^(avatar|p_[0-9a-f]{32})$/;

export function isOptionValue(spec: OptionSpec, v: unknown): boolean {
    switch (spec.type) {
        case 'hue': return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 359;
        case 'range': return typeof v === 'number' && Number.isInteger(v) && v >= spec.min && v <= spec.max;
        case 'choice':
        case 'color': return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < spec.choices.length;
        case 'image-source': return typeof v === 'string' && IMAGE_SOURCE.test(v);
        default: return false;
    }
}

/** A server value -> the knobs `id` takes (garbage and other items' keys dropped). */
export function readItemOptions(stored: unknown, kind: 'decoration' | 'effect', id: string | null | undefined): ItemOptions {
    const out: Record<string, number | string> = {};
    if (!stored || typeof stored !== 'object') return out as ItemOptions;
    const o = stored as Record<string, unknown>;
    for (const spec of optionSpecsFor(kind, id)) {
        const v = o[spec.key];
        if (isOptionValue(spec, v)) out[spec.key] = v as number | string;
    }
    return out as ItemOptions;
}

/**
 * keepsake-rain with one of the owner's My Emojis: the `cl:p_<id>` reference
 * to hand to hooks/useStatusEmojiShare.ts, so accepted friends receive the
 * image device-to-device (E2EE, once each) exactly like a status emoji. null
 * for any other effect / image source. The server only ever holds the id.
 */
export function keepsakeRainEmojiRef(effect: string | null | undefined, options: CosmeticOptions | null | undefined): string | null {
    if (effect !== 'keepsake-rain') return null;
    const m = readItemOptions(options?.e, 'effect', effect).m;
    return m && m.startsWith('p_') ? `cl:${m}` : null;
}

// ── Legacy option helpers (the pre-schema picker) ─────────────────────────────
// Kept so the existing picker compiles and keeps working until it renders the
// schema above. They only know the 1-3 knobs and the hue.
export type LegacyOptionKey = 'h' | 'i' | 'n' | 's';
export const OPTION_LABELS: Readonly<Record<LegacyOptionKey, string>> = { h: 'Color', i: 'Intensity', n: 'Density', s: 'Speed' };
export const LEVEL_WORDS: Readonly<Record<Exclude<LegacyOptionKey, 'h'>, readonly [string, string, string]>> = {
    i: INTENSITY_WORDS,
    n: DENSITY_WORDS,
    s: SPEED_WORDS,
};
/** @deprecated Render `optionSpecsFor` instead: this drops the choice / colour / image knobs. */
export const optionKeysFor = (kind: 'decoration' | 'effect', id: string | null | undefined): readonly LegacyOptionKey[] =>
    optionSpecsFor(kind, id).map((s) => s.key).filter((k): k is LegacyOptionKey => k === 'h' || k === 'i' || k === 'n' || k === 's');

/** The tint a hue option paints with: bright enough to read on the card's navy. */
export const hueTint = (h: number | undefined): string | null => (typeof h === 'number' ? `hsl(${Math.round(h)} 78% 62%)` : null);

/** Hue swatches for the option row (degrees). */
export const HUE_PRESETS: readonly number[] = [172, 200, 222, 262, 300, 340, 18, 44, 140];

export const findDecoration = (id: string | null | undefined) => AVATAR_DECORATIONS.find((d) => d.id === id) ?? null;
export const findEffect = (id: string | null | undefined) => PROFILE_EFFECTS.find((d) => d.id === id) ?? null;

const KNOWN = new Set<string>(EGG_IDS);

/** Known eggs among `found` (a retired id stops counting, as on the server). */
export const knownFoundCount = (found: Iterable<string>): number => {
    let n = 0;
    for (const id of found) if (KNOWN.has(id)) n++;
    return n;
};

/**
 * `level` is the server-computed profile level (0 until known: locked).
 * `claimed` = the seasons this account claimed (`/auth/me` cosmetic_claims).
 * A seasonal item that is NOT claimed yet is still pickable while its season
 * runs: equipping it claims it (see `isSeasonOpenLocal` / `seasonalPickable`).
 */
export function isUnlocked(
    rule: UnlockRule, found: ReadonlySet<string>, level = 0, achievements?: ReadonlySet<string>, claimed?: ReadonlySet<string>,
): boolean {
    switch (rule.kind) {
        case 'free': return true;
        case 'egg': return found.has(rule.egg);
        case 'eggs': return knownFoundCount(found) >= rule.min;
        case 'level': return level >= rule.min;
        case 'achievement': return !!achievements?.has(rule.id);
        case 'seasonal': return !!claimed?.has(rule.season);
        default: return false;
    }
}

/** A seasonal item the account does not hold yet, but can take right now (picking it claims it). */
export const seasonalPickable = (rule: UnlockRule, claimed?: ReadonlySet<string>, now: Date = new Date()): boolean =>
    rule.kind === 'seasonal' && !claimed?.has(rule.season) && isSeasonOpenLocal(rule.season, now);

const achievementName = (id: string): string => ACHIEVEMENTS.find((a) => a.id === id)?.name ?? 'an achievement';

/** "Egg hunter" style label for an egg id: `late-night` -> `Late night`. */
export function eggLabel(id: string): string {
    const s = id.replace(/-/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** How to unlock, for the locked state of a picker tile. */
export function unlockHint(rule: UnlockRule, found: ReadonlySet<string>, level = 0, now: Date = new Date()): string {
    switch (rule.kind) {
        case 'free': return 'Free';
        case 'egg': return `Find the "${eggLabel(rule.egg)}" easter egg`;
        case 'eggs': return `Find ${rule.min} easter eggs (${Math.min(knownFoundCount(found), rule.min)} of ${rule.min} so far)`;
        case 'level': return `Reach profile level ${rule.min} (you are level ${level})`;
        case 'achievement': return `Unlock the "${achievementName(rule.id)}" achievement`;
        case 'seasonal': {
            const name = SEASON_NAMES[rule.season] ?? 'a limited-time event';
            const st = seasonStatus(rule.season, now);
            return st === 'open'
                ? `${name}: free to claim until ${lastDayLabel(rule.season)}, yours to keep`
                : st === 'upcoming'
                    ? `Arrives for ${name}, from ${dayLabel(SEASONS[rule.season]?.from)}`
                    : `Was available during ${name}`;
        }
        default: return '';
    }
}

/**
 * A terse lock label for a picker tile ("5/8 eggs", "Lv 8"); the full sentence
 * (`unlockHint`) stays available as the tile's tooltip / accessible name.
 */
export function shortUnlockHint(rule: UnlockRule, found: ReadonlySet<string>, _level = 0, now: Date = new Date()): string {
    switch (rule.kind) {
        case 'free': return '';
        case 'egg': return 'Secret egg';
        case 'eggs': return `${Math.min(knownFoundCount(found), rule.min)}/${rule.min} eggs`;
        case 'level': return `Lv ${rule.min}`;
        case 'achievement': return 'Achievement';
        case 'seasonal': {
            const st = seasonStatus(rule.season, now);
            return st === 'open' ? 'Claim free' : st === 'upcoming' ? 'Coming soon' : 'Event over';
        }
        default: return '';
    }
}

// ── legacy decoration colour modes ───────────────────────────────────────────
// The free ring / dash / Keys decorations used to come in level-gated ember /
// violet variants. The hue option on the base item replaces them; the ids
// still render for accounts that hold them.

/** The free decorations that also come in level-gated ember / violet colours. */
export const COLOURED_DECORATIONS = ['lume-ring', 'deep-dash', 'keys-peek'] as const;
export type DecorationColour = 'match' | 'ember' | 'violet';
/** Profile level that unlocks each non-default colour (mirrors AVATAR_DECORATIONS above). */
export const COLOUR_LEVELS: Readonly<Record<Exclude<DecorationColour, 'match'>, number>> = { ember: 5, violet: 8 };

/** `lume-ring-ember` -> { base: 'lume-ring', colour: 'ember' }; anything else is its own base, colour 'match'. */
export function splitDecorationId(id: string | null | undefined): { base: string | null; colour: DecorationColour } {
    if (!id) return { base: null, colour: 'match' };
    const m = /^(.+)-(ember|violet)$/.exec(id);
    if (m && (COLOURED_DECORATIONS as readonly string[]).includes(m[1])) return { base: m[1], colour: m[2] as DecorationColour };
    return { base: id, colour: 'match' };
}
export const joinDecorationId = (base: string, colour: DecorationColour): string => (colour === 'match' ? base : `${base}-${colour}`);
/** @deprecated Always false now: colour is the base item's hue option (optionSpecsFor), not a variant id. */
export const supportsColour = (_base: string | null): boolean => false;

// ── egg showcase / widgets (client-side mirrors of the server's limits) ──────

export const EGG_SHOWCASE_MAX = 3;
export const WIDGET_GAMES_MAX = 5;
export const WIDGET_GAME_MAX_LEN = 40;

/** Trim a typed game name; null when it cannot be saved (empty / too long / control chars). */
export function cleanGameName(raw: string): string | null {
    const s = raw.trim();
    // eslint-disable-next-line no-control-regex
    if (!s || s.length > WIDGET_GAME_MAX_LEN || /[\u0000-\u001f\u007f-\u009f]/.test(s)) return null;
    return s;
}

export interface ProfileWidgets { games: string[] }
