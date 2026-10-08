/**
 * keysBrain — the pure logic behind Keys 2.0 (components/mascot/Keys.tsx).
 *
 * Ported from the website mascot (apps/website/src/marketing/kit/40-keys.js),
 * whose mood machine lived tangled in component state. Kept dependency-free
 * so the node-env vitest can cover it (the same constraint that shaped
 * eggPools.ts — see its header).
 *
 * Two channels, layered by the component:
 *  - mood (interaction): awake → happy on pokes, sleepy at 5, asleep at 8;
 *    hover wakes; a 2.6s rest timer returns to awake — except from asleep,
 *    which only a hover (or an alert signal) ends.
 *  - signal (app state, owned by the host): 'alert' outranks sleep — Keys
 *    wakes for a mention.
 */

export type KeysMood = 'awake' | 'happy' | 'sleepy' | 'asleep';
export type KeysSignal = 'idle' | 'pulse' | 'alert';

export interface BrainState {
    mood: KeysMood;
    pokes: number;
}

export const INITIAL_BRAIN: BrainState = { mood: 'awake', pokes: 0 };

/** 6 pokes → sleepy, 9 → asleep (one more rung than the website mascot — the
 *  desktop ladder gained the squish-and-ink payoff at poke 5). */
export const SLEEPY_AT = 6;
export const ASLEEP_AT = 9;
/** ms of no pokes before a happy/sleepy Keys settles back to awake. */
export const REST_MS = 2600;

/** A click/tap on Keys. */
export function onPoke(s: BrainState): BrainState {
    const pokes = s.pokes + 1;
    if (pokes >= ASLEEP_AT) return { mood: 'asleep', pokes };
    if (pokes >= SLEEPY_AT) return { mood: 'sleepy', pokes };
    return { mood: 'happy', pokes };
}

/** Pointer enters — only rouses a drowsy/sleeping Keys. */
export function onWake(s: BrainState): BrainState {
    if (s.mood === 'sleepy' || s.mood === 'asleep') return { mood: 'awake', pokes: 0 };
    return s;
}

/** The rest timer fired. Asleep ignores it — napping is earned. */
export function onRest(s: BrainState): BrainState {
    if (s.mood === 'asleep') return s;
    return { mood: 'awake', pokes: 0 };
}

/** App-state precedence: an alert wakes even a sleeping Keys. */
export function applySignal(s: BrainState, signal: KeysSignal): BrainState {
    if (signal === 'alert' && s.mood === 'asleep') return { mood: 'awake', pokes: 0 };
    return s;
}

/** Whether the rest timer should be (re)armed after this state. */
export function shouldArmRest(s: BrainState): boolean {
    return s.mood === 'happy' || s.mood === 'sleepy';
}

/** One-shot reaction for the Nth poke — an escalation ladder, not the same
 *  wiggle every time (doctrine rule 3 applied to motion): wiggle → hop →
 *  limb-flail → dizzy spin → SQUISH (with ink — he's a cuttlefish) as the
 *  pre-sleepy payoff. Sleepy pokes get a drowsy stir; poking someone asleep
 *  does nothing (he's asleep). */
export type PokeReaction = 'wiggle' | 'hop' | 'flail' | 'spin' | 'squish' | 'stir' | 'none';

/** A face the host holds for a while, over the mood's own brows: happy, or
 *  'blank' (no brows drawn: the host draws his eyes itself, e.g. the Home
 *  deck's spam shows, utils/keysSpam.ts). */
export type KeysFace = 'happy' | 'blank';
export function pokeReaction(pokes: number): PokeReaction {
    if (pokes >= ASLEEP_AT) return 'none';
    if (pokes >= SLEEPY_AT) return 'stir';
    return (['wiggle', 'hop', 'flail', 'spin', 'squish'] as const)[(pokes - 1) % 5];
}

/** Whether the Nth poke earns a spoken line. NOT every click — the animation
 *  is the payoff (rule 1, visual first); words punctuate the ladder instead
 *  of narrating it: the opening poke, the dizzy spin, and one drowsy protest
 *  as he goes sleepy. The squish stays silent — the ink IS the line. */
export function shouldSpeak(pokes: number): boolean {
    return pokes === 1 || pokes === 4 || pokes === SLEEPY_AT;
}

/** Blink cadence: 2600–5800ms, from a caller-supplied [0,1) random. */
export function nextBlinkDelay(rand: number): number {
    return 2600 + rand * 3200;
}

/** W-brow path generator — the mark's zigzag, parameterised by baseline y +
 *  amplitude. Same math as the website's brow(). */
export function browPath(x: number, y: number, amp: number): string {
    const w = 3.75;
    return `M${x} ${y} l${w} ${-amp} l${w} ${amp} l${w} ${-amp} l${w} ${amp}`;
}

/** The full brow vocabulary. Closed is a soft smile-arc, not a flat line;
 *  sad is the downcast sag OfflineScreen has always worn while offline. */
export const BROWS = {
    awakeL: browPath(33.5, 40, 5),
    awakeR: browPath(61.5, 40, 5),
    happyL: browPath(33.5, 37, 6),
    happyR: browPath(61.5, 37, 6),
    closedL: 'M33.5 39 q7.5 4 15 0',
    closedR: 'M61.5 39 q7.5 4 15 0',
    sadL: 'M33.5 37 Q40 43.5 46.5 37',
    sadR: 'M61.5 37 Q68 43.5 74.5 37',
} as const;
