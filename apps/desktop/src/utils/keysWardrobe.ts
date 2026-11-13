/**
 * keysWardrobe — what Keys wears on his head on the Home deck when nothing
 * else has a claim on it.
 *
 * Owner, 2026-10-28: "Keys on the Home page doesn't need to have a crown all
 * the time. Maybe have it rotate between that and some other stuff he could
 * wear, as well as nothing."
 *
 * So the crown is one hat among several, and "nothing" comes up often:
 *
 *   beanie   a coral knit beanie with a pom-pom
 *   captain  a tiny captain's cap (white top, navy band, gold badge)
 *   snorkel  a dive mask over his eyes, with a snorkel
 *   shades   sunglasses pushed up on his dome (his eyes stay free)
 *   flower   a little sea flower tucked by his ear
 *   crown    the crown, for Pro only
 *
 * ── The rules ───────────────────────────────────────────────────────────────
 * WHEN: a pick on every Home visit (HomeKeys mounts: the app starting, or
 * coming back to Home), and now and then while you leave him be on Home
 * (`wardrobeIdleDecision`: at most every few minutes, only while he is free,
 * awake, seen and between gestures). Never mid-gesture, never mid-show, never
 * right after a click. The swap itself is the gear's own CSS entry / exit
 * (the old one comes off, the new one goes on a beat later) plus a small
 * body bob (keysGestures `dress`, or `proud` for the crown); under reduced
 * motion it is an instant swap with no bob.
 *
 * WHAT: a weighted draw (`ODDS`). The same hat never comes up twice in a row
 * (`last` is excluded); going bare can. Bare is the single likeliest result.
 *
 * PRO: the crown is in the draw for Pro accounts only, and is a little more
 * likely than any one other hat (it takes half of bare's share). Everyone
 * gets the other hats. When Pro status turns up a moment AFTER Home mounted
 * (the billing status loads asynchronously at launch), `proArrived` turns a
 * bare pick into the crown with exactly the probability that makes the
 * launch pick follow the Pro odds: the crown arrives (with his proud bob)
 * instead of the hat flickering. Losing Pro takes the crown off.
 *
 * PRIORITY: anything that already claims his head outranks the wardrobe
 * (keysMirror `sceneFor`): a calendar costume (Halloween, New Year, the
 * birthday), the call headset, DND headphones / eye mask, the night lantern,
 * and camouflage. The pick is kept underneath and comes back when the head
 * is free again.
 *
 * Pure: the random source is injected everywhere (`Rng`); the only state is
 * the session's last pick (so the next Home visit does not repeat it).
 */

export type Rng = () => number;

/** Every hat, in paint order (keysMirror GEAR keeps the same order). */
export const HATS = ['crown', 'beanie', 'captain', 'snorkel', 'shades', 'flower'] as const;
export type Hat = (typeof HATS)[number];
/** What he wears: a hat, or nothing (null). */
export type Wear = Hat | null;

/** The hats anyone can draw (the crown is Pro's). */
export const EVERYDAY_HATS: readonly Hat[] = ['beanie', 'captain', 'snorkel', 'shades', 'flower'];

/** Weights before excluding the last pick. Non-Pro: bare 40%, each hat 12%.
 *  Pro: half of bare's share becomes the crown (bare 20%, crown 20%, each
 *  other hat 12%). */
export const ODDS = {
    bare: 0.4,
    hat: 0.12,
    /** The share of `bare` a Pro account's crown takes. */
    crownShareOfBare: 0.5,
} as const;

export interface PickCtx {
    pro: boolean;
    /** The previous pick (excluded if it is a hat; bare may repeat). */
    last: Wear;
}

/** The draw's table: outcomes in a fixed order (bare first), weights
 *  normalised to sum to 1. */
export function wardrobeOdds({ pro, last }: PickCtx): [Wear, number][] {
    const crown = pro ? ODDS.bare * ODDS.crownShareOfBare : 0;
    const rows: [Wear, number][] = [[null, ODDS.bare - crown]];
    if (pro) rows.push(['crown', crown]);
    for (const h of EVERYDAY_HATS) rows.push([h, ODDS.hat]);
    const kept = rows.filter(([w]) => w === null || w !== last);
    const total = kept.reduce((s, [, p]) => s + p, 0);
    return kept.map(([w, p]) => [w, p / total]);
}

const unit = (r: number) => (Number.isFinite(r) ? Math.min(Math.max(r, 0), 1 - Number.EPSILON) : 0);

/** One draw. A broken rng (NaN, out of range) is clamped, never throws. */
export function pickHat(ctx: PickCtx, rng: Rng): Wear {
    const u = unit(rng());
    let acc = 0;
    const table = wardrobeOdds(ctx);
    for (const [w, p] of table) {
        acc += p;
        if (u < acc) return w;
    }
    return table[table.length - 1][0];
}

/** A value of `rng()` that makes `pickHat` return `wear` (the middle of its
 *  slice), for tests and the harness. -1 if `wear` cannot be drawn. */
export function drawFor(wear: Wear, ctx: PickCtx): number {
    let acc = 0;
    for (const [w, p] of wardrobeOdds(ctx)) {
        if (w === wear) return acc + p / 2;
        acc += p;
    }
    return -1;
}

/**
 * Pro status arrived just after a non-Pro pick: a bare pick becomes the crown
 * with probability `crownShareOfBare`, which is exactly the Pro odds (the
 * crown's slice is carved out of bare's, and the other slices are equal in
 * both tables). Anything else stays as it is; the crown never repeats.
 */
export function proArrived(current: Wear, last: Wear, rng: Rng): Wear {
    if (current !== null || last === 'crown') return current;
    return unit(rng()) < ODDS.crownShareOfBare ? 'crown' : null;
}

/** Pro turning up later than this after Home mounted is a purchase, not the
 *  launch's status load: no re-roll (the next pick includes the crown). */
export const PRO_SETTLE_MS = 6000;

// ── changing while you leave him be ─────────────────────────────────────────

/** How often HomeKeys asks whether it is time for a change. */
export const WARDROBE_CHECK_MS = 45_000;
/** At least this long on one look before an idle change. */
export const WARDROBE_MIN_MS = 4 * 60 * 1000;
/** Each check past the minimum changes with this chance (so the wait
 *  wanders: about six minutes on average). */
export const WARDROBE_CHANCE = 0.35;
/** Not this soon after a click on him (he is being played with). */
export const WARDROBE_QUIET_MS = 20_000;
/** Not this soon after his scene changed (its gesture and the gear's own
 *  entry / exit are still settling). */
export const WARDROBE_SETTLE_MS = 2500;

export interface WardrobeIdleCtx {
    now: number;
    /** When the current look was picked. */
    pickedAt: number;
    lastClickAt: number;
    /** When his scene last changed. */
    sceneAt: number;
    /** He is free: awake, head not claimed, seen, no show / finale / beat /
     *  rare bit / gesture in flight, the pointer not on him. */
    free: boolean;
}

/** Time for a new look? (The caller then draws it with `pickHat`.) */
export function wardrobeIdleDecision(c: WardrobeIdleCtx, rng: Rng): boolean {
    if (!c.free) return false;
    if (!(c.now - c.pickedAt >= WARDROBE_MIN_MS)) return false;
    if (c.now - c.lastClickAt < WARDROBE_QUIET_MS) return false;
    if (c.now - c.sceneAt < WARDROBE_SETTLE_MS) return false;
    return unit(rng()) < WARDROBE_CHANCE;
}

// ── the session's last pick ─────────────────────────────────────────────────

let lastWorn: Wear = null;
/** The last look of this session (Home remounts on every visit). */
export const lastHat = (): Wear => lastWorn;
export const rememberHat = (w: Wear): void => { lastWorn = w; };
export function __resetWardrobe(): void { lastWorn = null; }
