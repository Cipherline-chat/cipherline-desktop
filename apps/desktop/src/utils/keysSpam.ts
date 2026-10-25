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
 * When the game cannot open (he is spammed in a call, or the machine cannot
 * draw it) the show does not end on a refusal line: each has a PAYOFF, a
 * 3-5 second finish in the show's own language (a disco, a victory lap, a
 * reboot, a power-up, a reveal). See `payoff()` below.
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
    | 'eyesDark' | 'eyesLight'           // camo: his eyes, on him / floating
    // payoff-only props (HomeKeys mounts them with their show):
    | 'discoA' | 'discoB' | 'ball'       // dance: the colour wash, the light rays, the glitter ball
    | 'spark0' | 'spark1' | 'spark2'     // dance, charge: twinkles
    | 'scan'                             // glitch: the boot scan line
    | 'streak0' | 'streak1' | 'dust'     // dodge: speed lines (right / left of him), the skid
    | 'sheen';                           // camo: the highlight sweeping his dome

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
    discoA: { transform: 'none', opacity: 0 },
    discoB: { transform: 'none', opacity: 0 },
    ball: { transform: 'none', opacity: 0 },
    spark0: { transform: 'none', opacity: 0 },
    spark1: { transform: 'none', opacity: 0 },
    spark2: { transform: 'none', opacity: 0 },
    scan: { transform: 'none', opacity: 0 },
    streak0: { transform: 'none', opacity: 0 },
    streak1: { transform: 'none', opacity: 0 },
    dust: { transform: 'none', opacity: 0 },
    sheen: { transform: 'none', opacity: 0 },
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
    /** Said while the payoff plays. Never mentions why the game stayed shut. */
    payoffLine: string;
    /**
     * The 5 s were kept up but the game cannot open (he is in a call, or the
     * machine cannot draw it): the show's own 3-5 s finish instead of a
     * refusal. One-shot, finite, transform / opacity only, and it ends at REST.
     */
    payoff(): { moves: Move[]; ms: number };
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

/**
 * Keyframes from absolute stop times: [ms, frame] pairs over `total` ms. A
 * leading `[0, {}]` means "from wherever this target is now" (see Move). Each
 * stop eases into the next with `ease`: the animation's own timing stays
 * linear, so the stops land exactly when written. A payoff is one animation
 * per target, so each is written as one timeline.
 */
type Stops = ReadonlyArray<readonly [number, Keyframe]>;
const tl = (total: number, stops: Stops, ease = 'ease-in-out'): Keyframe[] =>
    stops.map(([t, f]) => {
        const easing = f.easing ?? ease;
        return Object.keys(f).length === 0 ? { easing } : { ...f, easing, offset: clamp01(t / total) };
    });
/** A soft bell (0 → peak → 0) every `period` ms from `start`, as stops: a
 *  colour change at most twice per period, never a strobe. */
const bells = (start: number, period: number, count: number, peak: number, extra: (i: number) => Keyframe = () => ({})): Stops => {
    const out: Array<readonly [number, Keyframe]> = [];
    for (let i = 0; i < count; i++) {
        const t = start + i * period;
        out.push([t, { opacity: 0, ...extra(i) }], [t + period / 2, { opacity: peak, ...extra(i) }]);
    }
    out.push([start + count * period, { opacity: 0 }]);
    return out;
};
/** Twinkles: a four-point star grows, turns and goes, at each of `ats`. */
const twinkles = (target: Target, total: number, ats: readonly number[], ms = 640): Move => {
    const stops: Array<readonly [number, Keyframe]> = [[0, { transform: 'scale(0) rotate(0deg)', opacity: 0 }]];
    for (const at of ats) {
        stops.push(
            [at, { transform: 'scale(0) rotate(0deg)', opacity: 0 }],
            [at + ms * 0.4, { transform: 'scale(1) rotate(45deg)', opacity: 0.95 }],
            [at + ms, { transform: 'scale(0.2) rotate(90deg)', opacity: 0 }],
        );
    }
    stops.push([total, REST[target]]);
    return { target, ms: total, frames: tl(total, stops, 'ease-out') };
};
/** A ring that expands and fades at each of `ats` (charge). */
const ringBursts = (target: Target, total: number, ats: readonly number[], to = 1.5): Move => {
    const stops: Array<readonly [number, Keyframe]> = [[0, REST[target]]];
    for (const at of ats) {
        stops.push(
            [at, { transform: 'scale(0.95)', opacity: 0 }],
            [at + 120, { transform: 'scale(1)', opacity: 0.8 }],
            [at + 640, { transform: `scale(${to})`, opacity: 0 }],
        );
    }
    stops.push([total, REST[target]]);
    return { target, ms: total, frames: tl(total, stops, 'ease-out') };
};

/* ── glitch: an overloaded screen ─────────────────────────────────────────── */
const glitch: Show = {
    id: 'glitch',
    lines: ['input received.', 'input received. input received.', 'buffer at 87%.', 'fans: MAXIMUM.', 'ERR_TOO_MUCH_FUN'],
    finaleLine: 'rebooting… into a game.',
    recoveredLine: '…rebooted. all good. probably.',
    payoffLine: 'reboot complete. 0 errors.',
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
    payoff() {
        // Reboot: a slow RGB-split drift, the screen switches off, a dark
        // beat, then it comes back on and a scan line sweeps him. No flicker:
        // one off, one on, ghosts that fade rather than blink. (No skewX on the
        // body: measured, it drops the animation off the compositor.)
        const T = 3600;
        return {
            ms: T, moves: [
                { target: 'body', hold: true, ms: T, frames: tl(T, [
                    [0, {}],
                    [350, { transform: 'translate(3px, 0px) rotate(-2deg)' }],
                    [700, { transform: 'translate(-3px, 0px) rotate(2deg)' }],
                    [1000, { transform: 'scale(1.18, 0.05)', opacity: 1 }],
                    [1250, { transform: 'scale(0.02, 0.05)', opacity: 1 }],
                    [1350, { transform: 'scale(0.001, 0.001)', opacity: 0 }],
                    [1950, { transform: 'scale(0.001, 0.001)', opacity: 0 }],
                    [2050, { transform: 'scale(0.02, 0.05)', opacity: 1 }],
                    [2300, { transform: 'scale(1.18, 0.05)', opacity: 1 }],
                    [2650, { transform: 'scale(0.98, 1.06)', opacity: 1 }],
                    [2950, REST.body],
                    [T, REST.body],
                ]) },
                { target: 'ghostA', ms: T, frames: tl(T, [
                    [0, REST.ghostA],
                    [450, { transform: 'translateX(-6px)', opacity: 0.5 }],
                    [900, { transform: 'translateX(-9px)', opacity: 0.6 }],
                    [1100, REST.ghostA],
                    [2300, REST.ghostA],
                    [2650, { transform: 'translateX(-5px)', opacity: 0.45 }],
                    [3000, REST.ghostA],
                    [T, REST.ghostA],
                ]) },
                { target: 'ghostB', ms: T, frames: tl(T, [
                    [0, REST.ghostB],
                    [450, { transform: 'translateX(6px)', opacity: 0.5 }],
                    [900, { transform: 'translateX(9px)', opacity: 0.6 }],
                    [1100, REST.ghostB],
                    [2300, REST.ghostB],
                    [2650, { transform: 'translateX(5px)', opacity: 0.45 }],
                    [3000, REST.ghostB],
                    [T, REST.ghostB],
                ]) },
                { target: 'scan', ms: T, frames: tl(T, [
                    [0, REST.scan],
                    [2300, { transform: 'translateY(0%)', opacity: 0 }],
                    [2450, { transform: 'translateY(60%)', opacity: 0.85 }],
                    [3000, { transform: 'translateY(840%)', opacity: 0.7 }],
                    [3150, { transform: 'translateY(880%)', opacity: 0 }],
                    [T, REST.scan],
                ], 'ease-in-out') },
            ],
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
    payoffLine: 'fastest one here. no contest.',
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
    payoff() {
        // He gives up and races you: a wind-up, a dash out to the left with
        // speed lines, a skid and a little hop ("see?"), a dash back across,
        // and a bouncy stop in the middle. Always the same rhythm, never off
        // the slot by more than ~34 px (and only 10 to the right).
        const T = 3600;
        const dash = (x: number, r: number) => ({ transform: `translate(${x}px, -2px) rotate(${r}deg) scale(1.26, 0.86)` });
        const brake = (x: number) => ({ transform: `translate(${x}px, 2px) rotate(-1deg) scale(0.9, 1.1)` });
        const trail = (target: Target, at: number): Move => ({
            target, ms: T, frames: tl(T, [
                [0, REST[target]],
                [at - 120, { transform: 'translateX(0px)', opacity: 0 }],
                [at, { transform: 'translateX(-4px)', opacity: 0.8 }],
                [at + 240, { transform: 'translateX(-14px)', opacity: 0 }],
                [T, REST[target]],
            ], 'ease-out'),
        });
        const puff = (at: number): Stops => [
            [at, { transform: 'scale(0.3)', opacity: 0 }],
            [at + 120, { transform: 'scale(1)', opacity: 0.6 }],
            [at + 400, { transform: 'scale(1.5)', opacity: 0 }],
        ];
        return {
            ms: T, moves: [
                { target: 'body', hold: true, ms: T, frames: tl(T, [
                    [0, {}],
                    [300, { transform: 'translate(7px, 3px) rotate(7deg) scale(1.06, 0.9)' }],
                    [520, dash(-30, -5)],
                    [760, brake(-34)],
                    [980, { transform: 'translate(-30px, 0px) scale(1.04, 0.94)' }],
                    [1300, { transform: 'translate(-30px, -9px) rotate(-6deg) scale(0.96, 1.06)' }],
                    [1550, { transform: 'translate(-30px, 0px) scale(1.06, 0.92)' }],
                    [1800, { transform: 'translate(-31px, 2px) rotate(-3deg) scale(1.06, 0.9)' }],
                    [2050, dash(10, 5)],
                    [2300, brake(13)],
                    [2650, { transform: 'translate(0px, -8px) rotate(-3deg) scale(0.97, 1.05)' }],
                    [2900, { transform: 'translate(0px, 1px) scale(1.07, 0.92)' }],
                    [T, REST.body],
                ]) },
                trail('streak0', 520),
                { target: 'streak1', ms: T, frames: tl(T, [
                    [0, REST.streak1],
                    [1930, { transform: 'translateX(0px)', opacity: 0 }],
                    [2050, { transform: 'translateX(4px)', opacity: 0.8 }],
                    [2290, { transform: 'translateX(14px)', opacity: 0 }],
                    [T, REST.streak1],
                ], 'ease-out') },
                { target: 'dust', ms: T, frames: tl(T, [[0, REST.dust], ...puff(760), ...puff(2300), [T, REST.dust]] as Stops, 'ease-out') },
            ],
        };
    },
};

/* ── charge: powering up ──────────────────────────────────────────────────── */
const charge: Show = {
    id: 'charge',
    lines: ['charging.', 'charging..', 'charging...', 'almost there…', 'FULL POWER.'],
    finaleLine: 'LAUNCH.',
    recoveredLine: '…entering power-saving mode.',
    payoffLine: 'power: full. nobody was hurt.',
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
    payoff() {
        // Fully charged and nowhere to spend it: he crouches, launches into a
        // hover (rings burst outward, one every ~0.6 s), floats, and lands
        // with a last ring and a squash. Stays within ~24 px of the slot.
        const T = 3600;
        return {
            ms: T, moves: [
                { target: 'body', hold: true, ms: T, frames: tl(T, [
                    [0, {}],
                    [250, { transform: 'translateY(9px) scale(1.14, 0.76)' }],
                    [650, { transform: 'translateY(-20px) scale(0.92, 1.14)' }],
                    [1000, { transform: 'translateY(-24px) scale(1, 1)' }],
                    [1500, { transform: 'translateY(-18px) rotate(-2deg)' }],
                    [2000, { transform: 'translateY(-23px) rotate(2deg)' }],
                    [2500, { transform: 'translateY(-16px) rotate(0deg)' }],
                    [2800, { transform: 'translateY(3px) scale(1.12, 0.84)' }],
                    [3150, { transform: 'translateY(-3px) scale(0.97, 1.04)' }],
                    [T, REST.body],
                ]) },
                { target: 'fill', hold: true, ms: T, frames: tl(T, [
                    [0, {}],
                    [250, { transform: 'scale(0.9)', opacity: 0.8 }],
                    [650, { transform: 'scale(1.35)', opacity: 0 }],
                    [T, REST.fill],
                ], 'ease-out') },
                ringBursts('ring0', T, [650, 1850]),
                ringBursts('ring1', T, [1250, 2800]),
                ringBursts('ring2', T, [2450], 1.4),
                twinkles('spark0', T, [700, 2800]),
                twinkles('spark1', T, [850, 2950]),
                twinkles('spark2', T, [1000, 3100]),
            ],
        };
    },
};

/* ── camo: a cuttlefish's trick ───────────────────────────────────────────── */
const camo: Show = {
    id: 'camo',
    lines: ['you can’t see me.', 'I’m a rock.', 'still a rock.', 'rocks don’t get clicked.', 'how are you still finding me.'],
    finaleLine: 'okay. not a rock. let’s play.',
    recoveredLine: '…did it work?',
    payoffLine: 'ta-da. a very handsome rock.',
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
    payoff() {
        // The cuttlefish drops the act: the pattern washes over him three
        // times (about once a second), he fades back in, takes a bow, and a
        // sheen sweeps his dome.
        const T = 3800;
        return {
            ms: T, moves: [
                { target: 'rig', hold: true, ms: T, frames: tl(T, [[0, {}], [500, { opacity: 0.2 }], [1700, { opacity: 1 }], [T, REST.rig]]) },
                { target: 'eyesDark', hold: true, ms: T, frames: tl(T, [[0, {}], [500, { opacity: 0.2 }], [1700, { opacity: 1 }], [T, REST.eyesDark]]) },
                { target: 'eyesLight', hold: true, ms: T, frames: tl(T, [[0, {}], [500, { opacity: 0.8 }], [1700, { opacity: 0 }], [T, REST.eyesLight]]) },
                { target: 'stripes', ms: T, frames: tl(T, [[0, REST.stripes], ...bells(300, 1000, 3, 0.7), [T, REST.stripes]] as Stops) },
                { target: 'body', hold: true, ms: T, frames: tl(T, [
                    [0, {}],
                    [2200, { transform: 'none' }],
                    [2650, { transform: 'translateY(-4px) scale(1.14)' }],
                    [3000, { transform: 'scale(0.98)' }],
                    [3300, REST.body],
                    [T, REST.body],
                ], 'cubic-bezier(.2, 1.3, .4, 1)') },
                { target: 'sheen', ms: T, frames: tl(T, [
                    [0, REST.sheen],
                    [2300, { transform: 'translateX(-150%)', opacity: 1 }],
                    [3050, { transform: 'translateX(450%)', opacity: 1 }],
                    [3060, REST.sheen],
                    [T, REST.sheen],
                ], 'ease-in-out') },
            ],
        };
    },
};

/* ── dance: every click is a beat ─────────────────────────────────────────── */
const dance: Show = {
    id: 'dance',
    lines: ['oh? a beat.', 'I can work with this.', 'faster?', 'FASTER.', 'drop it…'],
    finaleLine: 'the drop. let’s play.',
    recoveredLine: '…okay, the song’s over.',
    payoffLine: 'and THAT was the drop.',
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
    payoff() {
        // A little disco, 4.8 s at 120 bpm: he bobs on every beat and the
        // beat BUILDS to a drop at 2 s (a bigger hop, glitter). Behind him a
        // soft teal wash and amber light rays swell in turn (a colour change
        // every ~0.7 s at most), a glitter ball swings in above, notes float
        // up. Eight beats, then a bow.
        const T = 4800, BEAT = 500;
        const body: Array<readonly [number, Keyframe]> = [[0, {}]];
        for (let i = 0; i < 8; i++) {
            const b = i * BEAT, dir = i % 2 ? 1 : -1;
            const big = i === 4; // the drop
            const up = big
                ? 'translateY(-15px) rotate(' + deg(dir * 9) + ') scale(1.08)'
                : 'translateY(' + px(-(i < 4 ? 5 : 8)) + ') rotate(' + deg(dir * (i < 4 ? 4 : 7)) + ')';
            body.push(
                [b + 190, { transform: up }],
                [b + 400, { transform: 'translateY(1px) scale(1.04, 0.94)' }],
                [b + BEAT, { transform: 'none' }],
            );
        }
        body.push(
            [4250, { transform: 'translateY(-10px) scale(1.06)' }],
            [4500, { transform: 'translateY(1px) scale(1.06, 0.92)' }],
            [T, REST.body],
        );
        // the glitter ball: drops in, swings from its string, lifts away
        const ball: Array<readonly [number, Keyframe]> = [
            [0, { transform: 'translateY(-22px) rotate(0deg)', opacity: 0 }],
            [350, { transform: 'translateY(0px) rotate(0deg)', opacity: 1 }],
        ];
        for (let t = 850, i = 0; t <= 3850; t += 500, i++) ball.push([t, { transform: 'translateY(0px) rotate(' + deg(i % 2 ? -8 : 8) + ')', opacity: 1 }]);
        ball.push([4350, { transform: 'translateY(0px) rotate(0deg)', opacity: 1 }], [4700, { transform: 'translateY(-22px) rotate(0deg)', opacity: 0 }], [T, REST.ball]);
        // notes: each rises three times, staggered
        const note = (target: Target, start: number, dx: number): Move => {
            const stops: Array<readonly [number, Keyframe]> = [[0, REST[target]]];
            for (let i = 0; i < 3; i++) {
                const t = start + i * 1100, d = i % 2 ? 1 : -1;
                stops.push(
                    [t, { transform: 'none', opacity: 0 }],
                    [t + 150, { transform: 'translate(' + px(-6) + ', ' + px(-6) + ')', opacity: 0.95 }],
                    [t + 850, { transform: 'translate(' + px(dx * d) + ', ' + px(-30) + ') rotate(' + deg(d * 20) + ')', opacity: 0 }],
                );
            }
            stops.push([T, REST[target]]);
            return { target, ms: T, frames: tl(T, stops, 'ease-out') };
        };
        return {
            ms: T, moves: [
                { target: 'body', ms: T, frames: tl(T, body, 'ease-out') },
                { target: 'discoA', ms: T, frames: tl(T, [[0, REST.discoA], ...bells(0, 1400, 3, 0.8), [T, REST.discoA]] as Stops) },
                {
                    target: 'discoB', ms: T, frames: tl(T, [
                        [0, REST.discoB], ...bells(700, 1400, 2, 0.75, i => ({ transform: 'rotate(' + deg(i * 16) + ')' })), [T, REST.discoB],
                    ] as Stops),
                },
                { target: 'ball', ms: T, frames: tl(T, ball) },
                note('note0', 300, 14), note('note1', 650, 8), note('note2', 1000, 18),
                twinkles('spark0', T, [2000, 3300]),
                twinkles('spark1', T, [2250, 3550]),
                twinkles('spark2', T, [2500, 3800]),
            ],
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
