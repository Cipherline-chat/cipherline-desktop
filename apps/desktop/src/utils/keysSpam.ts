/**
 * keysSpam: the five shows Keys puts on when you spam him on Home, and the
 * rotation that hands them out.
 *
 * The streak rules live in keysBurst.ts (no gap over 600 ms, the game at
 * 5 s). This file is WHAT he does meanwhile. Each show is a different
 * five-second build-up with its own motion language, eyes, lines, finale and
 * recovery, and each streak gets the next one, so coming back and spamming
 * him again gets you something new.
 *
 * Deliberately NOT the website's Keys (apps/website/src/marketing/kit/
 * 40-keys.js): that one already inflates and pops, dozes and wakes furious,
 * spins its eyes into dizzy spirals, blushes, spins on the spot, peeks in
 * from the edges and does a speed burst. None of those moves or gags are
 * reused here:
 *
 *   glitch   overload: stepped jitter with RGB-split ghost copies; he
 *            reboots (a CRT switch-off) into the game
 *   dodge    he ducks and sidesteps the clicks, eyes looking anywhere but
 *            the cursor, until he gives up and races you
 *   charge   he crouches, energy rings fill around him, he trembles; at
 *            full power he launches up into the game
 *   camo     a cuttlefish's trick: he camouflages, fading out until only
 *            his eyes are left, stripes flashing when he is "found"
 *   dance    every click is a beat; he dances to your tempo, notes flying,
 *            and drops into the game
 *
 * Everything here is pure: a show turns progress (0..1) into Web Animation
 * keyframes for named HTML targets, which HomeKeys plays from the click
 * handler (transform and opacity only, so it runs on the compositor and
 * nothing runs between clicks). Sizes are px for the Home slot (76-128 px).
 */

export const PERSONALITIES = ['glitch', 'dodge', 'charge', 'camo', 'dance'] as const;
export type Personality = (typeof PERSONALITIES)[number];

/** The html elements a show can animate (HomeKeys renders them). */
export type Target =
    | 'body'    // .hk-react, wraps the rig and its overlays
    | 'rig'     // the rig itself (Keys' outer span)
    | 'ghostA' | 'ghostB'                // glitch: RGB-split silhouettes
    | 'ring0' | 'ring1' | 'ring2' | 'fill' // charge: pulse rings, the filling ring
    | 'note0' | 'note1' | 'note2'        // dance: notes
    | 'stripes'                          // camo: the pattern flash
    | 'eyesDark' | 'eyesLight';          // camo: his eyes, on him / floating

/** Every target's resting state: where recoveries end. */
export const REST: Record<Target, Keyframe> = {
    body: { transform: 'none', opacity: 1 },
    rig: { transform: 'none', opacity: 1 },
    ghostA: { transform: 'none', opacity: 0 },
    ghostB: { transform: 'none', opacity: 0 },
    ring0: { transform: 'scale(0.7)', opacity: 0 },
    ring1: { transform: 'scale(0.7)', opacity: 0 },
    ring2: { transform: 'scale(0.7)', opacity: 0 },
    fill: { transform: 'scale(0.55)', opacity: 0 },
    note0: { transform: 'none', opacity: 0 },
    note1: { transform: 'none', opacity: 0 },
    note2: { transform: 'none', opacity: 0 },
    stripes: { opacity: 0 },
    eyesDark: { opacity: 1 },
    eyesLight: { opacity: 0 },
};

export interface Move {
    target: Target;
    /**
     * Keyframes. A leading `{}` means "from wherever this target is now"
     * (HomeKeys fills it from the target's held state, or REST).
     */
    frames: Keyframe[];
    ms: number;
    easing?: string;
    /** Keep the end state (fill forwards) until the next held move or the reset. */
    hold?: boolean;
}

/** What he draws for eyes during the show (from `eyesFrom` on). */
export type EyeStyle = 'own' | 'pixel' | 'focus' | 'float';

export interface Show {
    id: Personality;
    /** One line per second of the streak. */
    lines: readonly [string, string, string, string, string];
    /** Said as the game opens. */
    finaleLine: string;
    /** Said when a streak that got going breaks short. */
    recoveredLine: string;
    eyes: EyeStyle;
    /** Progress from which those eyes replace his brows. */
    eyesFrom: number;
    /** Keys' own face during the show ('happy' brows, say), when eyes are 'own'. */
    face?: 'happy';
    /** His eyes look AWAY from the pointer (dodge). */
    avoid?: boolean;
    /** Extra class on the speech bubble. */
    speech?: string;
    /** The show's intensity at `progress`: 0..1, non-decreasing. */
    level(progress: number): number;
    /** The `n`th click of the streak (n >= 1), at `progress`. */
    click(progress: number, n: number): Move[];
    /** He gives in: what plays while the game opens. */
    finale(): { moves: Move[]; ms: number };
    /** The streak broke at `progress`: settle back to REST. */
    recover(progress: number): { moves: Move[]; ms: number };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => { const t = clamp01(x); return t * t * (3 - 2 * t); };
const px = (v: number) => `${v.toFixed(2)}px`;
const deg = (v: number) => `${v.toFixed(2)}deg`;
/** A fixed pseudo-random in [-1, 1] for click n and channel k: varied, reproducible. */
const jit = (n: number, k: number) => {
    const x = Math.sin(n * 12.9898 + k * 78.233) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
};
/** Recoveries scale with how far the streak got; a non-starter just stops. */
const settleMs = (p: number) => Math.round(500 + 900 * clamp01(p));
/** Return a target to REST from wherever it is. */
const toRest = (target: Target, ms: number, easing = 'ease-out'): Move => ({ target, frames: [{}, REST[target]], ms, easing, hold: true });

/* ── glitch: an overloaded screen ─────────────────────────────────────────── */
const glitch: Show = {
    id: 'glitch',
    lines: ['input received.', 'input received. input received.', 'buffer at 87%.', 'fans: MAXIMUM.', 'ERR_TOO_MUCH_FUN'],
    finaleLine: 'rebooting… into a game.',
    recoveredLine: '…rebooted. all good. probably.',
    eyes: 'pixel',
    eyesFrom: 0.2,
    speech: 'hk-speech--term',
    level: p => smooth(p),
    click(p, n) {
        const s = this.level(p);
        const a = 1 + 5 * s, sk = 2 + 10 * s, g = 2 + 6 * s, go = 0.3 + 0.45 * s;
        const step = { easing: 'steps(1, end)' };
        return [
            {
                target: 'body', ms: 240, frames: [
                    { transform: `translate(${px(jit(n, 1) * a)}, ${px(jit(n, 2) * a * 0.4)}) skewX(${deg(jit(n, 3) * sk)})`, ...step },
                    { transform: `translate(${px(jit(n, 4) * a)}, 0px) skewX(${deg(-jit(n, 3) * sk * 0.6)})`, ...step },
                    { transform: 'none' },
                ],
            },
            {
                target: 'ghostA', ms: 260, frames: [
                    { transform: `translate(${px(-g)}, ${px(0.6)})`, opacity: go, ...step },
                    { transform: `translate(${px(-g * 1.6)}, ${px(-1)})`, opacity: go * 0.7, ...step },
                    { transform: 'none', opacity: 0 },
                ],
            },
            {
                target: 'ghostB', ms: 260, frames: [
                    { transform: `translate(${px(g)}, ${px(-0.6)})`, opacity: go, ...step },
                    { transform: `translate(${px(g * 1.3)}, ${px(1)})`, opacity: go * 0.7, ...step },
                    { transform: 'none', opacity: 0 },
                ],
            },
        ];
    },
    finale() {
        // A CRT switching off: flattened to a line, then to a dot, then gone.
        return {
            ms: 560, moves: [
                { target: 'body', hold: true, ms: 560, easing: 'ease-in', frames: [
                    {},
                    { transform: 'scale(1.18, 0.05)', opacity: 1, offset: 0.45 },
                    { transform: 'scale(0.02, 0.05)', opacity: 1, offset: 0.85 },
                    { transform: 'scale(0, 0)', opacity: 0 },
                ] },
                { target: 'ghostA', ms: 300, frames: [{ transform: 'translateX(-8px)', opacity: 0.8 }, { transform: 'none', opacity: 0 }] },
                { target: 'ghostB', ms: 300, frames: [{ transform: 'translateX(8px)', opacity: 0.8 }, { transform: 'none', opacity: 0 }] },
            ],
        };
    },
    recover(p) {
        const a = 1 + 4 * smooth(p), ms = settleMs(p);
        const step = { easing: 'steps(1, end)' };
        return {
            ms, moves: [{
                target: 'body', hold: true, ms, frames: [
                    {},
                    { transform: `translate(${px(a)}, 0px)`, offset: 0.15, ...step },
                    { transform: `translate(${px(-a * 0.5)}, 0px)`, offset: 0.35, ...step },
                    { transform: `translate(${px(a * 0.2)}, 0px)`, offset: 0.6, ...step },
                    REST.body,
                ],
            }, toRest('ghostA', 200), toRest('ghostB', 200)],
        };
    },
};

/* ── dodge: you won't catch him ───────────────────────────────────────────── */
// Poses he cycles through: x (− = away, toward the deck), duck (0..1), tilt.
const DODGE = [
    { x: -1, d: 0, r: -1 }, { x: -0.3, d: 1, r: 0.4 }, { x: -0.8, d: 0.35, r: -1.2 }, { x: 0.25, d: 0.85, r: 0.7 },
] as const;
const dodge: Show = {
    id: 'dodge',
    lines: ['nope.', 'missed.', 'too slow.', 'okay, you’re fast.', 'you’re relentless.'],
    finaleLine: 'fine. race you.',
    recoveredLine: '…is it safe?',
    eyes: 'own',
    eyesFrom: 0,
    avoid: true,
    level: p => smooth(p),
    click(p, n) {
        const s = this.level(p);
        const pose = DODGE[n % DODGE.length];
        // Small enough that he stays under the cursor: the gag is the
        // attempt, not making the egg impossible.
        const x = pose.x * (4 + 12 * s), duck = pose.d * (0.05 + 0.19 * s);
        return [{
            target: 'body', hold: true, ms: Math.round(260 - 120 * s), easing: 'cubic-bezier(.2, 1.5, .4, 1)',
            frames: [{}, { transform: `translate(${px(x)}, ${px(duck * 60)}) rotate(${deg(pose.r * (3 + 6 * s))}) scale(${(1 + duck * 0.35).toFixed(3)}, ${(1 - duck).toFixed(3)})` }],
        }];
    },
    finale() {
        return {
            ms: 420, moves: [{
                target: 'body', hold: true, ms: 420, easing: 'cubic-bezier(.5, 0, .9, .5)', frames: [
                    {},
                    { transform: 'translate(6px, 2px) scale(1.06, 0.9)', opacity: 1, offset: 0.3 },
                    { transform: 'translate(-70px, -2px) scale(1.3, 0.9)', opacity: 0 },
                ],
            }],
        };
    },
    recover(p) {
        const ms = settleMs(p);
        return {
            ms, moves: [{
                target: 'body', hold: true, ms, easing: 'ease-in-out', frames: [
                    {},
                    // creeps back out, leaning to peek first
                    { transform: 'translate(-6px, 4px) rotate(-7deg) scale(1.04, 0.92)', opacity: 1, offset: 0.55 },
                    REST.body,
                ],
            }],
        };
    },
};

/* ── charge: powering up ──────────────────────────────────────────────────── */
const charge: Show = {
    id: 'charge',
    lines: ['charging.', 'charging..', 'charging...', 'almost there…', 'FULL POWER.'],
    finaleLine: 'LAUNCH.',
    recoveredLine: '…entering power-saving mode.',
    eyes: 'focus',
    eyesFrom: 0.15,
    level: p => smooth(p),
    click(p, n) {
        const s = this.level(p);
        const t = 0.6 + 1.6 * s;
        return [
            { target: 'body', hold: true, ms: 160, frames: [{}, { transform: `translateY(${px(1 + 5 * s)}) scale(${(1 + 0.07 * s).toFixed(3)}, ${(1 - 0.13 * s).toFixed(3)})` }] },
            { target: 'rig', ms: 120, frames: [{ transform: 'none' }, { transform: `translateX(${px(t)})` }, { transform: `translateX(${px(-t)})` }, { transform: 'none' }] },
            { target: 'fill', hold: true, ms: 200, frames: [{}, { transform: `scale(${(0.55 + 0.45 * s).toFixed(3)})`, opacity: 0.15 + 0.55 * s }] },
            {
                target: (['ring0', 'ring1', 'ring2'] as const)[n % 3], ms: 520, easing: 'ease-out', frames: [
                    { transform: 'scale(0.7)', opacity: 0 },
                    { transform: 'scale(1)', opacity: 0.25 + 0.5 * s, offset: 0.3 },
                    { transform: `scale(${(1.12 + 0.18 * s).toFixed(3)})`, opacity: 0 },
                ],
            },
        ];
    },
    finale() {
        const burst = (target: Target): Move => ({ target, ms: 420, easing: 'ease-out', frames: [{ transform: 'scale(1)', opacity: 0.9 }, { transform: 'scale(1.3)', opacity: 0 }] });
        return {
            ms: 480, moves: [
                { target: 'body', hold: true, ms: 480, easing: 'cubic-bezier(.4, 0, .9, .4)', frames: [
                    {},
                    { transform: 'translateY(8px) scale(1.12, 0.78)', opacity: 1, offset: 0.3 },
                    // up and gone before he reaches the top of the pane
                    { transform: 'translateY(-46px) scale(0.9, 1.18)', opacity: 0 },
                ] },
                { target: 'fill', hold: true, ms: 420, frames: [{}, { transform: 'scale(1.3)', opacity: 0 }] },
                burst('ring0'), burst('ring1'), burst('ring2'),
            ],
        };
    },
    recover(p) {
        const ms = settleMs(p);
        return { ms, moves: [toRest('body', ms, 'ease-in-out'), toRest('fill', ms)] };
    },
};

/* ── camo: a cuttlefish's trick ───────────────────────────────────────────── */
const camo: Show = {
    id: 'camo',
    lines: ['you can’t see me.', 'I’m a rock.', 'still a rock.', 'rocks don’t get clicked.', 'how are you still finding me.'],
    finaleLine: 'okay. not a rock. let’s play.',
    recoveredLine: '…did it work?',
    eyes: 'float',
    eyesFrom: 0.1,
    level: p => smooth(p),
    click(p) {
        const s = this.level(p);
        const body = 1 - 0.86 * s; // how much of him is left
        return [
            { target: 'rig', hold: true, ms: 300, frames: [{}, { opacity: body }] },
            { target: 'eyesDark', hold: true, ms: 300, frames: [{}, { opacity: body }] },
            { target: 'eyesLight', hold: true, ms: 300, frames: [{}, { opacity: 1 - body }] },
            // found: the pattern flashes across him, and he flinches
            { target: 'stripes', ms: 280, frames: [{ opacity: 0.2 + 0.55 * s }, { opacity: 0 }] },
            { target: 'body', ms: 200, frames: [{ transform: 'none' }, { transform: `scale(${(1 - 0.02 - 0.04 * s).toFixed(3)})` }, { transform: 'none' }] },
        ];
    },
    finale() {
        return {
            ms: 480, moves: [
                { target: 'rig', hold: true, ms: 260, frames: [{}, { opacity: 1 }] },
                { target: 'eyesDark', hold: true, ms: 260, frames: [{}, { opacity: 1 }] },
                { target: 'eyesLight', hold: true, ms: 200, frames: [{}, { opacity: 0 }] },
                { target: 'stripes', ms: 480, frames: [{ opacity: 0.9 }, { opacity: 0 }] },
                { target: 'body', ms: 480, easing: 'cubic-bezier(.2, 1.4, .4, 1)', frames: [{ transform: 'scale(0.9)' }, { transform: 'scale(1.16)', offset: 0.4 }, { transform: 'none' }] },
            ],
        };
    },
    recover(p) {
        const ms = settleMs(p) + 300;
        return { ms, moves: [toRest('rig', ms, 'ease-in'), toRest('eyesDark', ms, 'ease-in'), toRest('eyesLight', ms, 'ease-in')] };
    },
};

/* ── dance: every click is a beat ─────────────────────────────────────────── */
const dance: Show = {
    id: 'dance',
    lines: ['oh? a beat.', 'I can work with this.', 'faster?', 'FASTER.', 'drop it…'],
    finaleLine: 'the drop. let’s play.',
    recoveredLine: '…okay, the song’s over.',
    eyes: 'own',
    eyesFrom: 0.1,
    face: 'happy',
    level: p => smooth(p),
    click(p, n) {
        const s = this.level(p);
        const dir = n % 2 ? 1 : -1;
        const k = n % 3;
        return [
            {
                target: 'body', ms: Math.round(300 - 90 * s), easing: 'ease-out', frames: [
                    { transform: 'none' },
                    { transform: `translateY(${px(-(2 + 8 * s))}) rotate(${deg(dir * (4 + 9 * s))})`, offset: 0.4 },
                    { transform: `translateY(1px) scale(${(1 + 0.06 * s).toFixed(3)}, ${(1 - 0.08 * s).toFixed(3)})`, offset: 0.8 },
                    { transform: 'none' },
                ],
            },
            {
                target: (['note0', 'note1', 'note2'] as const)[k], ms: 700, easing: 'ease-out', frames: [
                    { transform: 'none', opacity: 0 },
                    { transform: `translate(${px(-(4 + 4 * s))}, ${px(-6)})`, opacity: 0.95, offset: 0.2 },
                    { transform: `translate(${px(-(12 + 16 * s) * (k === 1 ? 0.5 : 1))}, ${px(-(16 + 12 * s))}) rotate(${deg(dir * 20)})`, opacity: 0 },
                ],
            },
        ];
    },
    finale() {
        const note = (target: Target, x: number): Move => ({ target, ms: 600, easing: 'ease-out', frames: [{ transform: 'none', opacity: 1 }, { transform: `translate(${px(x)}, -26px)`, opacity: 0 }] });
        return {
            ms: 600, moves: [
                { target: 'body', ms: 600, frames: [
                    { transform: 'none' },
                    { transform: 'translateY(-14px) rotate(-8deg) scale(1.08)', offset: 0.35 },
                    { transform: 'translateY(2px) scale(1.12, 0.86)', offset: 0.7 },
                    { transform: 'none' },
                ] },
                note('note0', -30), note('note1', -6), note('note2', 14),
            ],
        };
    },
    recover(p) {
        const ms = settleMs(p);
        return {
            ms, moves: [{
                target: 'body', hold: true, ms, easing: 'ease-in-out', frames: [
                    {}, { transform: 'rotate(4deg)', offset: 0.3 }, { transform: 'rotate(-3deg)', offset: 0.65 }, REST.body,
                ],
            }],
        };
    },
};

export const SHOWS: Record<Personality, Show> = { glitch, dodge, charge, camo, dance };

/* ── The rotation ─────────────────────────────────────────────────────────── */

/**
 * A shuffled bag: every round deals all five once, in a fresh order, and a
 * new round never starts with the show that ended the last one. Persisted
 * per account (utils/keysSpamStore.ts), so it carries across sessions.
 */
export interface SpamBag {
    /** Shows left in this round, next first. */
    bag: Personality[];
    /** The last one dealt (null before the first). */
    last: Personality | null;
}

export const EMPTY_BAG: SpamBag = { bag: [], last: null };

/** The bag with a show ready on top: refilled (shuffled by `rand`) when empty. */
export function ready(state: SpamBag, rand: () => number = Math.random): SpamBag {
    if (state.bag.length > 0) return state;
    const bag = [...PERSONALITIES];
    for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    if (state.last && bag[0] === state.last) [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
    return { bag, last: state.last };
}

/** The show the next streak gets (call `ready` first). */
export function upNext(state: SpamBag): Personality {
    return state.bag[0] ?? PERSONALITIES[0];
}

/** Use up the show on top. */
export function deal(state: SpamBag): SpamBag {
    if (!state.bag.length) return state;
    return { bag: state.bag.slice(1), last: state.bag[0] };
}

/** A stored bag, validated: anything malformed is an empty bag, never a throw. */
export function parseBag(raw: string | null): SpamBag {
    if (!raw) return EMPTY_BAG;
    try {
        const v = JSON.parse(raw) as { bag?: unknown; last?: unknown };
        const known = (x: unknown): x is Personality => typeof x === 'string' && (PERSONALITIES as readonly string[]).includes(x);
        const bag = Array.isArray(v.bag) ? v.bag.filter(known) : [];
        if (new Set(bag).size !== bag.length) return EMPTY_BAG;
        return { bag, last: known(v.last) ? v.last : null };
    } catch {
        return EMPTY_BAG;
    }
}
