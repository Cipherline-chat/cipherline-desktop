/**
 * keysRare — the two rare surprises for Keys on Home (owner-approved
 * 2026-10-20).
 *
 *  - SHINY KEYS: about one app launch in SHINY_ODDS, he is a rare colourway
 *    for the whole session. Rolled ONCE per launch (module state: a renderer
 *    reload is a new launch, re-rendering or re-mounting Home is not), never
 *    per render. Counts as the egg `shiny-keys` when he is first seen.
 *  - RARE IDLE BITS: now and then, while you are on Home and leaving him
 *    alone, he juggles or reads a tiny newspaper. At most one per
 *    RARE_IDLE_MIN_GAP_MS, and only on a random roll even then.
 *
 * Pure: the RNG and the clock are passed in.
 */

export type Rng = () => number;

/** One launch in this many. */
export const SHINY_ODDS = 500;
export const SHINY_EGG = 'shiny-keys';

/** One roll: true with probability 1 / SHINY_ODDS. */
export function rollShiny(rng: Rng): boolean {
    const r = rng();
    return Number.isFinite(r) && r >= 0 && r < 1 / SHINY_ODDS;
}

let launchShiny: boolean | null = null;

/** This launch's roll (made on first call, then fixed until the renderer
 *  reloads). The RNG is only consulted the first time. */
export function shinyThisLaunch(rng: Rng = Math.random): boolean {
    if (launchShiny === null) launchShiny = rollShiny(rng);
    return launchShiny;
}

/** Harness / test hook: force the roll (null = roll again next time). */
export function __setShinyLaunch(v: boolean | null): void { launchShiny = v; }

// ── rare idle bits ──────────────────────────────────────────────────────────

export const RARE_IDLE_BITS = ['juggle', 'newspaper'] as const;
export type RareIdleBit = (typeof RARE_IDLE_BITS)[number];

/** At most one rare bit per hour. */
export const RARE_IDLE_MIN_GAP_MS = 60 * 60 * 1000;
/** How often HomeKeys asks. */
export const RARE_IDLE_CHECK_MS = 90_000;
/** The chance a check that is allowed actually plays one. */
export const RARE_IDLE_CHANCE = 0.1;
/** "Leaving him alone": no click on him for at least this long. */
export const RARE_IDLE_QUIET_MS = 30_000;
/** How long each bit plays. */
export const RARE_IDLE_MS: Record<RareIdleBit, number> = { juggle: 3600, newspaper: 4800 };

export interface RareIdleContext {
    now: number;
    /** When the last rare bit played (any mount, this launch). */
    lastAt: number;
    /** When he was last clicked. */
    lastClickAt: number;
    /** Nothing else owns him (no show, no finale, no click reaction), his
     *  pose is plain awake, the window is visible and in use, nothing covers
     *  Home, motion is allowed, and the pointer is not on him. */
    free: boolean;
}

/** Should a rare bit play now, and which? (null = not now) */
export function rareIdleDecision(ctx: RareIdleContext, rng: Rng): RareIdleBit | null {
    if (!ctx.free) return null;
    if (ctx.now - ctx.lastClickAt < RARE_IDLE_QUIET_MS) return null;
    // A clock that went backwards fails quiet (no bit), as Cooldown does.
    if (ctx.now < ctx.lastAt || ctx.now - ctx.lastAt < RARE_IDLE_MIN_GAP_MS) return null;
    if (!(rng() < RARE_IDLE_CHANCE)) return null;
    return rng() < 0.5 ? 'juggle' : 'newspaper';
}

let lastRareAt = -Infinity;
/** The launch-wide "last rare bit" stamp (a re-mounted Home keeps the limit). */
export const rareIdleLastAt = (): number => lastRareAt;
export const markRareIdle = (now: number): void => { lastRareAt = now; };
export function __resetRareIdle(): void { lastRareAt = -Infinity; }
