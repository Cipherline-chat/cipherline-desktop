/**
 * keysPlay — what Keys does when you click him while he is mirroring you.
 *
 * Owner, 2026-10-20: "when he's doing any of the actions ... make sure when
 * interacting with him he does something fun every time that pertains to his
 * activity ... add like 3 variations to each and a final spam click event at
 * the end."
 *
 * So every mirrored state (utils/keysMirror.ts) gets:
 *   - THREE click reactions ("beats") in that activity's own language, dealt
 *     from a little bag so the same one never plays twice in a row;
 *   - one FINALE for spamming him (FINALE_CLICKS clicks inside
 *     FINALE_WINDOW_MS), with a cooldown, that counts once as the egg
 *     `keys-finale-<state>` (finaleEggId).
 *
 * Two kinds of state:
 *
 *   CLAIMING (offline, call, gaming, dnd, asleep, camo, box, safe): what he
 *   is doing owns his body. Every click is that state's: a beat, or (clicks
 *   landing on a beat still in flight) a small nudge that blends into it, and
 *   the burst ends on the finale. The Firewall-game streak (keysBurst /
 *   keysSpam) is off in these states: you cannot start a game mid-call, at a
 *   TV, asleep...
 *
 *   GARNISH (pile, coffee, lantern, crown): something he has or wears while
 *   he is otherwise himself. The neutral egg keeps working untouched: the
 *   first click of a streak still runs the poke ladder and the host's quip,
 *   and keeping it up still builds a show into the game. The garnish adds its
 *   own beat on top of that first click (prop-level), and its finale lands
 *   on the burst's sixth click as a prop-level flourish while the show goes
 *   on underneath. (Pro users wear the crown all day, and the unread pile is
 *   common: neither may cost anyone the Firewall egg.)
 *
 * Everything here is data: keyframes for named html targets (HomeKeys
 * resolves the names: gear pieces already on screen, or the small fx
 * elements KeysPlayFx mounts for the current state), plus a body gesture for
 * the GestureRunner, which starts from wherever he is, so a beat never snaps
 * a scene gesture (or another beat) that is mid-flight. Transform and
 * opacity only; every fx rests at opacity 0; every move ends at rest.
 * Flashes are slow (well under three a second).
 *
 * Lines are short and dry. No puns about the sea.
 */

import type { Scene } from './keysMirror';
import type { KeysFace } from './keysBrain';
import type { Puff } from './keysGestures';

export const PLAY_STATES = [
    'offline', 'call', 'gaming', 'dnd', 'asleep', 'camo', 'box', 'safe',
    'pile', 'coffee', 'lantern', 'crown',
] as const;
export type PlayState = (typeof PLAY_STATES)[number] | 'neutral';

export const CLAIMING: ReadonlySet<PlayState> = new Set<PlayState>(['offline', 'call', 'gaming', 'dnd', 'asleep', 'camo', 'box', 'safe']);
export const GARNISH: ReadonlySet<PlayState> = new Set<PlayState>(['pile', 'coffee', 'lantern', 'crown']);

/** Which state answers a click, by precedence (the strongest claim on him). */
export function playStateFor(scene: Pick<Scene, 'pose' | 'gear' | 'pile' | 'camo'>): PlayState {
    switch (scene.pose) {
        case 'offline': return 'offline';
        case 'call': return 'call';
        case 'gaming': return 'gaming';
        case 'focus': return 'dnd';
        case 'asleep': return 'asleep';
        default: break;
    }
    const has = (g: string) => (scene.gear as readonly string[]).includes(g);
    if (scene.camo) return 'camo';
    if (has('box')) return 'box';
    if (has('safe') || has('papers')) return 'safe';
    if (scene.pile >= 1) return 'pile';
    if (has('mug')) return 'coffee';
    if (has('lantern')) return 'lantern';
    if (has('crown')) return 'crown';
    return 'neutral';
}

// ── the rules for clicks ────────────────────────────────────────────────────

/** A burst of this many clicks inside the window is the finale. */
export const FINALE_CLICKS = 6;
export const FINALE_WINDOW_MS = 2500;
/** After a finale, this long before that state's finale can play again
 *  (clicks still get beats meanwhile). */
export const FINALE_COOLDOWN_MS = 15_000;
/** A click this soon after the previous one, while a beat is still playing,
 *  nudges him instead of starting the next beat (so a burst reads as him
 *  getting flustered, not as three beats fighting). */
export const NUDGE_GAP_MS = 450;
/** The DND wall waits this long for you to knock it over before it falls on
 *  its own. */
export const WALL_WAIT_MS = 3500;

export const finaleEggId = (s: Exclude<PlayState, 'neutral'>): string => `keys-finale-${s}`;
/** Every finale egg id, for the coordinator to add to the egg registries. */
export const FINALE_EGG_IDS: readonly string[] = PLAY_STATES.map(finaleEggId);

/**
 * Counts a state's clicks toward its finale. Fires on the FINALE_CLICKS-th
 * click inside FINALE_WINDOW_MS, then not again until FINALE_COOLDOWN_MS has
 * passed (counted from when it fired). A clock that went backwards fails
 * quiet (no finale), as keysMirror's Cooldown does.
 */
export class FinaleGate {
    private times: number[] = [];
    private firedAt = -Infinity;
    click(now: number): boolean {
        this.times = this.times.filter(t => now - t < FINALE_WINDOW_MS && now >= t);
        this.times.push(now);
        if (this.times.length < FINALE_CLICKS) return false;
        if (now < this.firedAt || now - this.firedAt < FINALE_COOLDOWN_MS) return false;
        this.firedAt = now;
        this.times = [];
        return true;
    }
    /** Forget the clicks so far (not the cooldown). */
    clear(): void { this.times = []; }
    cooling(now: number): boolean { return now >= this.firedAt && now - this.firedAt < FINALE_COOLDOWN_MS; }
}

/**
 * Deals 0..n-1: every index once per round, in a shuffled order, and never
 * the same index twice in a row (not even across rounds).
 */
export class VariationBag {
    private bag: number[] = [];
    private last = -1;
    private readonly n: number;
    constructor(n = 3) { this.n = Math.max(1, Math.floor(n)); }
    next(rng: () => number): number {
        if (this.n === 1) return (this.last = 0);
        if (this.bag.length === 0) {
            const b = Array.from({ length: this.n }, (_, i) => i);
            for (let i = b.length - 1; i > 0; i--) {
                const r = rng();
                const j = Math.min(i, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * (i + 1))));
                [b[i], b[j]] = [b[j], b[i]];
            }
            if (b[0] === this.last) [b[0], b[b.length - 1]] = [b[b.length - 1], b[0]];
            this.bag = b;
        }
        this.last = this.bag.shift()!;
        return this.last;
    }
}

// ── what a beat is ──────────────────────────────────────────────────────────

/** Gear already on screen (KeysGear), and the rig. */
export type GearTarget =
    | 'rig' | 'tv' | 'pad' | 'headset' | 'phones' | 'sign' | 'crown' | 'lantern' | 'halo'
    | 'mug' | 'box' | 'safe' | 'camoEyes' | 'pile' | 'callb' | 'nosig' | 'zzz' | 'ringlight' | 'frame';

/** The small effects KeysPlayFx mounts for the current state. */
export type FxTarget =
    | 'gameover' | 'hiscore' | `conf${0 | 1 | 2 | 3 | 4 | 5}` | `shard${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7}`
    | 'vol' | 'busy' | 'wall' | 'finger' | 'mute' | 'tap' | `squig${0 | 1 | 2}`
    | `env${0 | 1 | 2}` | `aval${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
    | `doc${0 | 1 | 2 | 3 | 4}` | 'dial' | 'door' | 'vaultKey' | 'stripes' | 'antenna'
    | `drop${0 | 1 | 2}` | 'gust' | 'beam' | 'moth' | `csp${0 | 1}` | 'dust'
    | `ball${0 | 1 | 2}` | 'paper' | `shine${0 | 1}`;

export type PlayTarget = GearTarget | FxTarget;

export interface PlayMove {
    t: PlayTarget;
    frames: Keyframe[];
    ms: number;
    delay?: number;
    easing?: string;
    /** Keep the end state (the DND wall, until it is knocked over). */
    hold?: boolean;
}

export type PlayFace = KeysFace | 'oneEye';

export interface Beat {
    id: string;
    line?: string;
    /** When the line is said (ms from the start; default 0). */
    lineAt?: number;
    /** The body gesture (.hk-gest, via the GestureRunner: it prepends his
     *  current transform). Must end at 'none'. */
    body?: { ms: number; frames: Keyframe[] };
    moves: PlayMove[];
    /** A face held from `at` for `ms`. */
    face?: { face: PlayFace; at?: number; ms: number };
    /** The rig's own arm wave. */
    wave?: boolean;
    puff?: Puff;
    /** A class on the root for the beat's length (an svg-level detail CSS
     *  owns, e.g. reading eyes). */
    cls?: string;
    /** How long the beat owns him. */
    ms: number;
}

export interface Finale extends Beat {
    /** Wait for a click (or `ms`) and then play `release` (the DND wall). */
    hold?: { ms: number; release: Beat };
    /** Asleep: he moves his bed to the other side (HomeKeys flips a flag). */
    moveBed?: boolean;
}

export interface PlayCtx { video: boolean; sharing: boolean }

// ── keyframe helpers ────────────────────────────────────────────────────────

const IO = 'cubic-bezier(.45,0,.55,1)';
const OUT = 'cubic-bezier(.2,.8,.2,1)';
const IN = 'cubic-bezier(.5,0,.75,0)';
const g = (offset: number, transform: string, easing?: string): Keyframe =>
    (easing ? { offset, transform, easing } : { offset, transform });
const kf = (offset: number, p: Keyframe): Keyframe => ({ offset, ...p });
const body = (ms: number, ...frames: Keyframe[]) => ({ ms, frames });

/** An fx that pops in, holds and fades out. */
function popFx(t: PlayTarget, ms: number, delay = 0, from = 'scale(.4)', at = 'none', holdTo = 0.8): PlayMove {
    return {
        t, ms, delay, frames: [
            { opacity: 0, transform: from },
            kf(0.18, { opacity: 1, transform: at === 'none' ? 'scale(1.08)' : at, easing: OUT }),
            kf(0.28, { opacity: 1, transform: at }),
            kf(holdTo, { opacity: 1, transform: at }),
            { opacity: 0, transform: from },
        ],
    };
}
/** A wobble on a gear piece, ending at rest. */
function wobble(t: PlayTarget, ms: number, deg: number, delay = 0): PlayMove {
    return {
        t, ms, delay, frames: [
            { transform: 'none' },
            kf(0.2, { transform: `rotate(${-deg}deg)`, easing: IO }),
            kf(0.4, { transform: `rotate(${deg * 0.8}deg)`, easing: IO }),
            kf(0.6, { transform: `rotate(${-deg * 0.45}deg)`, easing: IO }),
            kf(0.8, { transform: `rotate(${deg * 0.2}deg)`, easing: IO }),
            { transform: 'none' },
        ],
    };
}
/** Fade a gear piece out and back (the Zzz while he is bothered). */
function dip(t: PlayTarget, ms: number, low = 0): PlayMove {
    return { t, ms, frames: [{ opacity: 1 }, kf(0.12, { opacity: low }), kf(0.85, { opacity: low }), { opacity: 1 }] };
}
/** Something tossed from its spot along an arc and landing elsewhere (%, of itself). */
function arc(t: PlayTarget, ms: number, delay: number, dx: number, up: number, land: number, spin: number): PlayMove {
    return {
        t, ms, delay, frames: [
            { opacity: 0, transform: 'translate(0, 0) rotate(0deg)' },
            kf(0.08, { opacity: 1, transform: 'translate(0, 0) rotate(0deg)', easing: OUT }),
            kf(0.45, { opacity: 1, transform: `translate(${dx * 0.55}%, ${-up}%) rotate(${spin * 0.5}deg)`, easing: IN }),
            kf(0.88, { opacity: 1, transform: `translate(${dx}%, ${land}%) rotate(${spin}deg)` }),
            { opacity: 0, transform: `translate(${dx}%, ${land}%) rotate(${spin}deg)` },
        ],
    };
}

// ── the states ──────────────────────────────────────────────────────────────

type Play = { beats: (c: PlayCtx) => readonly [Beat, Beat, Beat]; finale: (c: PlayCtx) => Finale };

/** Travel is in % of the piece itself (each is a few px square). */
const SHARDS: { dx: number; dy: number; r: number }[] = [
    { dx: -390, dy: -440, r: -90 }, { dx: 100, dy: -570, r: 120 }, { dx: 490, dy: -310, r: 200 }, { dx: 600, dy: 160, r: -160 },
    { dx: 310, dy: 490, r: 90 }, { dx: -160, dy: 550, r: -220 }, { dx: -550, dy: 290, r: 150 }, { dx: -620, dy: -100, r: -120 },
];
const CONFETTI: { dx: number; dy: number; r: number }[] = [
    { dx: -400, dy: -650, r: 200 }, { dx: -100, dy: -820, r: -160 }, { dx: 230, dy: -750, r: 240 },
    { dx: 480, dy: -550, r: -200 }, { dx: -580, dy: -380, r: 160 }, { dx: 650, dy: -300, r: -260 },
];

const gaming: Play = {
    beats: () => [
        {
            id: 'gameover', line: 'Lag.', ms: 1700,
            body: body(900, g(0.12, 'translateY(-6%) scale(.96, 1.05)', OUT), g(0.26, 'translateY(3%) scale(1.08, .9)', IN),
                g(0.45, 'translateY(1%) scale(1.03, .97)', IO), g(1, 'none')),
            moves: [
                { t: 'pad', ms: 900, frames: [{ transform: 'none' }, kf(0.12, { transform: 'translateY(-10%) rotate(-8deg)', easing: IN }),
                    kf(0.26, { transform: 'translateY(9%) rotate(4deg) scale(1.05, .9)' }), kf(0.45, { transform: 'translateY(5%) rotate(2deg)', easing: IO }), { transform: 'none' }] },
                { t: 'gameover', ms: 1700, delay: 180, frames: [{ opacity: 0, transform: 'scale(1.5)' }, kf(0.16, { opacity: 1, transform: 'scale(1)', easing: OUT }),
                    kf(0.4, { opacity: 1 }), kf(0.5, { opacity: 0.25 }), kf(0.62, { opacity: 1 }), kf(0.88, { opacity: 1, transform: 'scale(1)' }), { opacity: 0, transform: 'scale(.9)' }] },
            ],
        },
        {
            id: 'hiscore', line: 'New high score. No witnesses.', ms: 1600,
            body: body(1000, g(0.2, 'translateY(-12%) scale(.95, 1.06)', OUT), g(0.4, 'translateY(0) scale(1.06, .94)', IN),
                g(0.6, 'translateY(-6%) scale(.98, 1.03)', OUT), g(0.8, 'translateY(0) scale(1.03, .97)', IN), g(1, 'none')),
            face: { face: 'happy', ms: 1400 },
            moves: [
                popFx('hiscore', 1600, 60),
                ...CONFETTI.map((c, i): PlayMove => ({
                    t: `conf${i}` as FxTarget, ms: 1400, delay: 80 + i * 45, frames: [
                        { opacity: 0, transform: 'translate(0, 0) rotate(0deg)' },
                        kf(0.1, { opacity: 1, transform: 'translate(0, 0) rotate(0deg)', easing: 'cubic-bezier(.2,.7,.4,1)' }),
                        kf(0.5, { opacity: 1, transform: `translate(${c.dx}%, ${c.dy}%) rotate(${c.r}deg)`, easing: 'cubic-bezier(.4,0,.8,.6)' }),
                        { opacity: 0, transform: `translate(${c.dx * 1.3}%, ${c.dy + 600}%) rotate(${c.r * 2}deg)` },
                    ],
                })),
            ],
        },
        {
            id: 'ragequit', line: 'I’m fine.', lineAt: 1300, ms: 2300,
            body: body(2300, g(0.1, 'translateY(-5%) scale(.96, 1.05)', OUT), g(0.24, 'rotate(9deg) translateX(5%)', IO),
                g(0.58, 'rotate(8deg) translateX(5%)', IO), g(0.7, 'rotate(-3deg) translateY(3%) scale(1.03, .96)', IO),
                g(0.84, 'translateY(1%)', IO), g(1, 'none')),
            face: { face: 'worried', at: 1300, ms: 1000 },
            moves: [
                { t: 'pad', ms: 2300, frames: [
                    { transform: 'none', opacity: 1 },
                    kf(0.08, { transform: 'translateY(4%)', easing: OUT }),
                    kf(0.18, { transform: 'translate(-18%, -42%) rotate(-70deg)', opacity: 1, easing: 'linear' }),
                    kf(0.28, { transform: 'translate(-48%, -20%) rotate(-170deg)', opacity: 0 }),
                    kf(0.62, { transform: 'translate(-30%, -30%) rotate(-40deg)', opacity: 0 }),
                    kf(0.72, { transform: 'translateY(-8%)', opacity: 1, easing: IN }),
                    kf(0.82, { transform: 'translateY(3%) scale(1.04, .94)', opacity: 1, easing: IO }),
                    { transform: 'none', opacity: 1 },
                ] },
            ],
        },
    ],
    finale: () => ({
        id: 'pixels', line: 'Did that save? It did not.', lineAt: 700, ms: 2700,
        body: body(1500, g(0.14, 'translateY(-16%) scale(.92, 1.1)', OUT), g(0.3, 'translateY(0) scale(1.06, .94)', IN),
            g(0.5, 'rotate(-4deg)', IO), g(0.7, 'rotate(3deg)', IO), g(1, 'none')),
        face: { face: 'wide', ms: 1700 },
        moves: [
            { t: 'tv', ms: 2700, frames: [
                { opacity: 1, transform: 'none' },
                kf(0.06, { transform: 'scale(1.08, .92)', easing: IO }),
                kf(0.12, { transform: 'scale(.92, 1.08)', easing: IO }),
                kf(0.18, { opacity: 0, transform: 'scale(1.2)' }),
                kf(0.66, { opacity: 0, transform: 'scale(.6)' }),
                kf(0.82, { opacity: 1, transform: 'scale(1.06)', easing: OUT }),
                { opacity: 1, transform: 'none' },
            ] },
            // the screen goes with the set: GAME OVER flashes, then nothing
            { t: 'gameover', ms: 2700, frames: [
                { opacity: 0, transform: 'scale(1)' }, kf(0.03, { opacity: 1, transform: 'scale(1)' }),
                kf(0.15, { opacity: 1, transform: 'scale(1)' }), kf(0.18, { opacity: 0, transform: 'scale(1.2)' }), { opacity: 0, transform: 'scale(1)' },
            ] },
            { t: 'hiscore', ms: 300, frames: [{ opacity: 0 }, { opacity: 0 }] },
            ...SHARDS.map((s, i): PlayMove => ({
                t: `shard${i}` as FxTarget, ms: 2700, frames: [
                    { opacity: 0, transform: 'translate(0, 0) rotate(0deg) scale(.6)' },
                    kf(0.16, { opacity: 1, transform: 'translate(0, 0) rotate(0deg) scale(1)', easing: OUT }),
                    kf(0.4, { opacity: 1, transform: `translate(${s.dx}%, ${s.dy}%) rotate(${s.r}deg)`, easing: IO }),
                    kf(0.58, { opacity: 1, transform: `translate(${s.dx * 1.05}%, ${s.dy + 60}%) rotate(${s.r * 1.1}deg)`, easing: IN }),
                    kf(0.78, { opacity: 1, transform: 'translate(0, 0) rotate(0deg) scale(.85)' }),
                    { opacity: 0, transform: 'translate(0, 0) scale(.6)' },
                ],
            })),
        ],
    }),
};

const asleep: Play = {
    beats: () => [
        {
            id: 'rollover', line: 'Five more minutes.', ms: 1600,
            body: body(1600, g(0.25, 'rotate(-8deg) translateX(-3%)', IO), g(0.55, 'rotate(9deg) translateX(3%) scale(1.03, .97)', IO),
                g(0.8, 'rotate(3deg) translateX(1%)', IO), g(1, 'none')),
            moves: [dip('zzz', 1600)],
        },
        {
            id: 'oneeye', line: '…', ms: 1800,
            body: body(1800, g(0.15, 'translateY(-2%) rotate(-3deg)', IO), g(0.8, 'translateY(-2%) rotate(-3deg)', IO), g(1, 'none')),
            face: { face: 'oneEye', at: 150, ms: 1450 },
            moves: [dip('zzz', 1800)],
        },
        {
            id: 'startle', line: 'I’m up.', ms: 2000, puff: 'bang',
            body: body(2000, g(0.12, 'translateY(-22%) scale(.9, 1.14)', OUT), g(0.3, 'translateY(-6%)', IO),
                g(0.5, 'translateY(-4%) rotate(3deg)', IO), g(0.75, 'translateY(2%) scale(1.04, .95) rotate(-2deg)', IO), g(1, 'none')),
            face: { face: 'wide', ms: 900 },
            moves: [dip('zzz', 2000)],
        },
    ],
    finale: () => ({
        id: 'movebed', line: 'Fine. I’ll sleep over here.', lineAt: 400, ms: 2600, moveBed: true,
        body: body(2600, g(0.1, 'translateY(-14%) scale(.94, 1.08)', OUT), g(0.2, 'translateY(-5%) rotate(-5deg)', IO),
            g(0.26, 'translateY(-5%) rotate(5deg)', IO), g(0.32, 'translateY(-5%) rotate(-4deg)', IO), g(0.4, 'translateY(-6%)', IO),
            g(0.55, 'translateY(-8%) rotate(3deg)', IO), g(0.7, 'translateY(-4%) rotate(-2deg)', IO), g(1, 'none')),
        face: { face: 'focus', ms: 1400 },
        moves: [dip('zzz', 2600), { t: 'dust', ms: 900, delay: 1500, frames: [
            { opacity: 0, transform: 'scale(.5)' }, kf(0.25, { opacity: 0.8, transform: 'scale(1)', easing: OUT }), { opacity: 0, transform: 'scale(1.4)' },
        ] }],
    }),
};

const dnd: Play = {
    beats: () => [
        {
            id: 'sign', line: 'Read the sign.', ms: 1400,
            body: body(1400, g(0.25, 'rotate(7deg) translateX(3%)', OUT), g(0.7, 'rotate(7deg) translateX(3%)', IO), g(1, 'none')),
            moves: [wobble('sign', 1300, 11, 200)],
        },
        {
            id: 'volume', line: 'Louder.', ms: 1500,
            body: body(1200, g(0.25, 'translateY(1%) rotate(-3deg)', IO), g(0.5, 'translateY(1%) rotate(3deg)', IO), g(0.75, 'rotate(-2deg)', IO), g(1, 'none')),
            moves: [
                { t: 'phones', ms: 1200, frames: [{ transform: 'none' }, kf(0.2, { transform: 'scale(1.08)', easing: OUT }), kf(0.35, { transform: 'scale(1.02)' }),
                    kf(0.5, { transform: 'scale(1.1)', easing: OUT }), { transform: 'none' }] },
                { t: 'vol', ms: 1500, frames: [{ opacity: 0, transform: 'translateX(-20%) scaleY(.2)' }, kf(0.25, { opacity: 1, transform: 'none', easing: OUT }),
                    kf(0.8, { opacity: 1, transform: 'none' }), { opacity: 0, transform: 'translateX(20%)' }] },
            ],
        },
        {
            id: 'busy', ms: 1900,
            body: body(1900, g(0.15, 'translateY(-3%)', OUT), g(0.85, 'translateY(-3%)', IO), g(1, 'none')),
            moves: [{ t: 'busy', ms: 1900, frames: [
                { opacity: 0, transform: 'translateY(40%) rotate(-14deg) scale(.5)' },
                kf(0.15, { opacity: 1, transform: 'translateY(0) rotate(-6deg) scale(1)', easing: OUT }),
                kf(0.85, { opacity: 1, transform: 'translateY(0) rotate(-6deg) scale(1)' }),
                { opacity: 0, transform: 'translateY(30%) rotate(-6deg) scale(.8)' },
            ] }],
        },
    ],
    finale: () => ({
        id: 'wall', line: 'No.', ms: 550,
        body: body(550, g(0.4, 'translateY(3%) scale(1.03, .96)', IO), g(1, 'none')),
        moves: [{ t: 'wall', ms: 550, hold: true, frames: [
            { opacity: 1, transform: 'scaleY(0)' }, kf(0.75, { opacity: 1, transform: 'scaleY(1.06)', easing: OUT }), { opacity: 1, transform: 'scaleY(1)' },
        ] }],
        hold: {
            ms: WALL_WAIT_MS,
            release: {
                id: 'wallDown', line: 'Rude.', lineAt: 450, ms: 1300, puff: 'bang',
                body: body(1100, g(0.4, 'translateY(-8%) scale(.96, 1.05)', OUT), g(0.6, 'none', IN), g(1, 'none')),
                face: { face: 'wide', at: 300, ms: 900 },
                moves: [
                    { t: 'wall', ms: 800, frames: [
                        { opacity: 1, transform: 'scaleY(1)' },
                        kf(0.65, { opacity: 1, transform: 'perspective(260px) rotateX(-84deg)', easing: IN }),
                        kf(0.8, { opacity: 0.7, transform: 'perspective(260px) rotateX(-90deg)' }),
                        { opacity: 0, transform: 'perspective(260px) rotateX(-90deg)' },
                    ] },
                    { t: 'dust', ms: 900, delay: 450, frames: [
                        { opacity: 0, transform: 'scale(.5)' }, kf(0.25, { opacity: 0.8, transform: 'scale(1.1)', easing: OUT }), { opacity: 0, transform: 'scale(1.5)' },
                    ] },
                ],
            },
        },
    }),
};

const call: Play = {
    beats: (c) => [
        {
            id: 'shh', line: 'Mic’s hot.', ms: 1500, puff: 'shh',
            body: body(1400, g(0.25, 'rotate(-6deg) translateY(2%)', OUT), g(0.75, 'rotate(-6deg) translateY(2%)', IO), g(1, 'none')),
            moves: [{ t: 'finger', ms: 1500, frames: [
                { opacity: 0, transform: 'rotate(28deg) scaleY(0)' },
                kf(0.2, { opacity: 1, transform: 'rotate(28deg) scaleY(1)', easing: OUT }),
                kf(0.8, { opacity: 1, transform: 'rotate(28deg) scaleY(1)' }),
                { opacity: 0, transform: 'rotate(28deg) scaleY(0)' },
            ] }],
        },
        {
            id: 'mute', line: 'Muted. Probably.', ms: 1700,
            body: body(900, g(0.3, 'translateY(-3%)', OUT), g(0.6, 'translateY(1%)', IO), g(1, 'none')),
            moves: [popFx('mute', 1700, 100), wobble('headset', 700, 4)],
        },
        c.video ? {
            id: 'camwave', line: 'Hi, camera.', ms: 2400, wave: true,
            body: body(2200, g(0.15, 'rotate(5deg) translateX(3%)', OUT), g(0.85, 'rotate(5deg) translateX(3%)', IO), g(1, 'none')),
            face: { face: 'happy', ms: 2200 },
            moves: [{ t: 'ringlight', ms: 900, frames: [{ transform: 'none' }, kf(0.3, { transform: 'scale(1.1)', easing: OUT }), { transform: 'none' }] }],
        } : c.sharing ? {
            id: 'present', line: 'Look. My screen.', ms: 1700,
            body: body(1700, g(0.2, 'translateY(-3%)', OUT), g(0.8, 'translateY(-3%)', IO), g(1, 'none')),
            face: { face: 'happy', ms: 1500 },
            moves: [{ t: 'frame', ms: 1700, frames: [{ transform: 'none' }, kf(0.25, { transform: 'translateY(-14%) scale(1.12)', easing: OUT }),
                kf(0.8, { transform: 'translateY(-14%) scale(1.12)' }), { transform: 'none' }] }],
        } : {
            id: 'tap', line: 'Is this thing on?', ms: 1500,
            body: body(1100, g(0.2, 'rotate(-4deg)', IO), g(0.35, 'rotate(-4deg) translateY(1%)', IO), g(0.5, 'rotate(-4deg)', IO),
                g(0.65, 'rotate(-4deg) translateY(1%)', IO), g(1, 'none')),
            moves: [
                wobble('headset', 900, 3, 150),
                { t: 'tap', ms: 1200, delay: 200, frames: [{ opacity: 0, transform: 'scale(.4)' }, kf(0.2, { opacity: 0.9, transform: 'scale(.8)' }), { opacity: 0, transform: 'scale(1.8)' }] },
            ],
        },
    ],
    finale: () => ({
        id: 'feedback', line: 'That was me. Sorry.', lineAt: 1500, ms: 2700,
        body: body(2700, g(0.04, 'translateX(-3%)'), g(0.08, 'translateX(3%)'), g(0.12, 'translateX(-3%) rotate(-2deg)'), g(0.16, 'translateX(3%) rotate(2deg)'),
            g(0.2, 'translateX(-3%)'), g(0.24, 'translateX(3%)'), g(0.28, 'translateX(-2%)'), g(0.32, 'translateX(2%)'),
            g(0.4, 'translateX(-2%) rotate(-2deg)'), g(0.48, 'translateX(1%)', IO), g(0.58, 'translateY(-6%) scale(.96, 1.05)', OUT),
            g(0.7, 'translateY(1%) scale(1.03, .97)', IN), g(1, 'none')),
        face: { face: 'wide', ms: 1500 },
        moves: [
            ...([0, 1, 2] as const).map((i): PlayMove => ({
                t: `squig${i}` as FxTarget, ms: 1700, delay: i * 90, frames: [
                    { opacity: 0, transform: 'scale(.6) rotate(0deg)' },
                    kf(0.1, { opacity: 1, transform: 'scale(1) rotate(-8deg)' }),
                    kf(0.25, { opacity: 1, transform: 'scale(1.1) rotate(8deg)' }),
                    kf(0.4, { opacity: 1, transform: 'scale(1.05) rotate(-6deg)' }),
                    kf(0.55, { opacity: 1, transform: 'scale(1.15) rotate(6deg)' }),
                    kf(0.75, { opacity: 0.8, transform: 'scale(1.2) rotate(-4deg)' }),
                    { opacity: 0, transform: 'scale(1.3) rotate(0deg)' },
                ],
            })),
            { t: 'headset', ms: 2700, frames: [
                { transform: 'none', opacity: 1 },
                kf(0.55, { transform: 'none', opacity: 1 }),
                kf(0.66, { transform: 'translate(22%, -30%) rotate(28deg)', opacity: 1, easing: OUT }),
                kf(0.74, { transform: 'translate(38%, -18%) rotate(60deg)', opacity: 0 }),
                kf(0.88, { transform: 'translateY(-16%)', opacity: 0 }),
                { transform: 'none', opacity: 1 },
            ] },
            wobble('callb', 1200, 8),
        ],
    }),
};

/** Envelopes for the avalanche: x% of his box, rest tilt, stagger. */
const AVAL: { r: number }[] = [{ r: -14 }, { r: 11 }, { r: -4 }, { r: 18 }, { r: -12 }, { r: 24 }, { r: -20 }, { r: 9 }, { r: -7 }, { r: 15 }];

const pile: Play = {
    beats: () => [
        {
            id: 'popout', line: 'Another one.', lineAt: 900, ms: 2000,
            body: body(2000, g(0.5, 'none'), g(0.58, 'translateY(3%) scale(1.04, .94)', IN), g(0.7, 'none', OUT), g(1, 'none')),
            face: { face: 'worried', at: 1000, ms: 900 },
            moves: [{ t: 'env0', ms: 2000, frames: [
                { opacity: 0, transform: 'translate(0, 0) rotate(0deg)' },
                kf(0.08, { opacity: 1, transform: 'translate(0, 0) rotate(0deg)', easing: 'cubic-bezier(.2,.7,.4,1)' }),
                kf(0.38, { opacity: 1, transform: 'translate(10%, -470%) rotate(200deg)', easing: IN }),
                kf(0.52, { opacity: 1, transform: 'translate(14%, -360%) rotate(352deg)' }),
                kf(0.58, { opacity: 1, transform: 'translate(14%, -380%) rotate(360deg)', easing: OUT }),
                kf(0.84, { opacity: 1, transform: 'translate(14%, -372%) rotate(366deg)', easing: IN }),
                { opacity: 0, transform: 'translate(120%, -200%) rotate(420deg)' },
            ] }],
        },
        {
            id: 'toss', line: 'Sorted.', ms: 1600,
            body: body(1000, g(0.2, 'translateY(-8%) scale(.96, 1.05)', OUT), g(0.4, 'translateY(0) scale(1.04, .96)', IN), g(1, 'none')),
            face: { face: 'happy', ms: 1300 },
            moves: [arc('env0', 1500, 0, -160, 420, 40, -220), arc('env1', 1500, 90, 40, 520, 30, 260), arc('env2', 1500, 180, 200, 380, 60, 200)],
        },
        {
            id: 'sink', line: 'I’ll get to them.', ms: 1700,
            body: body(1700, g(0.3, 'translateY(8%) scale(1.05, .9)', IO), g(0.7, 'translateY(8%) scale(1.05, .9)', IO), g(1, 'none')),
            face: { face: 'worried', ms: 1600 },
            moves: [{ t: 'pile', ms: 1700, frames: [{ transform: 'none' }, kf(0.3, { transform: 'translateY(-4%)', easing: IO }),
                kf(0.7, { transform: 'translateY(-4%)' }), { transform: 'none' }] }],
        },
    ],
    finale: () => ({
        id: 'avalanche', line: 'Found the bottom.', lineAt: 2300, ms: 3300,
        body: body(3300, g(0.18, 'none'), g(0.26, 'translateY(6%) scale(1.06, .9)', IN), g(0.66, 'translateY(6%) scale(1.06, .9)', IO),
            g(0.8, 'translateY(-10%) scale(.95, 1.06)', OUT), g(0.9, 'translateY(1%) scale(1.03, .97)', IN), g(1, 'none')),
        face: { face: 'worried', at: 600, ms: 1700 },
        moves: AVAL.map((a, i): PlayMove => ({
            t: `aval${i}` as FxTarget, ms: 3300, frames: [
                { opacity: 0, transform: `translate(${(i % 3 - 1) * 40}%, -700%) rotate(${a.r * 3}deg)` },
                kf(0.04 + i * 0.012, { opacity: 1, transform: `translate(${(i % 3 - 1) * 40}%, -700%) rotate(${a.r * 3}deg)`, easing: 'cubic-bezier(.4,0,.9,.6)' }),
                kf(0.2 + i * 0.012, { opacity: 1, transform: `rotate(${a.r}deg)`, easing: OUT }),
                kf(0.24 + i * 0.012, { opacity: 1, transform: `translateY(-14%) rotate(${a.r}deg)`, easing: IN }),
                kf(0.28 + i * 0.012, { opacity: 1, transform: `rotate(${a.r}deg)` }),
                kf(0.7, { opacity: 1, transform: `rotate(${a.r}deg)`, easing: IN }),
                kf(0.9, { opacity: 1, transform: `translate(${380 + i * 30}%, ${-120 - (i % 4) * 60}%) rotate(${a.r + 140}deg)` }),
                { opacity: 0, transform: `translate(${420 + i * 30}%, ${-140 - (i % 4) * 60}%) rotate(${a.r + 160}deg)` },
            ],
        })),
    }),
};

const DOCS = [{ dx: -170, h: 300, r: -40 }, { dx: -60, h: 420, r: 30 }, { dx: 40, h: 480, r: -20 }, { dx: 150, h: 380, r: 50 }, { dx: 240, h: 260, r: -60 }];

const box: Play = {
    beats: () => [
        {
            id: 'drop', line: 'That was the fragile one.', lineAt: 700, ms: 1900,
            body: body(1900, g(0.32, 'translateY(-6%) scale(.95, 1.06)', OUT), g(0.5, 'translateY(1%)', IO),
                g(0.75, 'translateY(4%) scale(1.03, .95)', IO), g(1, 'none')),
            face: { face: 'wide', at: 600, ms: 700 },
            moves: [{ t: 'box', ms: 1900, frames: [
                { transform: 'none' }, kf(0.12, { transform: 'translateY(-8%)', easing: OUT }),
                kf(0.32, { transform: 'translateY(22%) rotate(7deg)', easing: IN }),
                kf(0.42, { transform: 'translateY(16%) rotate(-3deg) scale(1.05, .92)', easing: IO }),
                kf(0.52, { transform: 'translateY(20%) rotate(2deg)' }), kf(0.78, { transform: 'translateY(20%) rotate(2deg)', easing: IO }),
                { transform: 'none' },
            ] }],
        },
        {
            id: 'juggle', line: 'Still got it.', ms: 1500,
            body: body(1500, g(0.15, 'translateY(3%) scale(1.03, .96)', IO), g(0.4, 'translateY(-4%)', OUT), g(0.78, 'translateY(2%)', IN), g(1, 'none')),
            moves: [{ t: 'box', ms: 1500, frames: [
                { transform: 'none' }, kf(0.15, { transform: 'translateY(4%) scale(1.05, .95)', easing: OUT }),
                kf(0.45, { transform: 'translateY(-75%) rotate(180deg)', easing: IN }),
                kf(0.76, { transform: 'translateY(0) rotate(360deg)', easing: IO }),
                kf(0.86, { transform: 'translateY(4%) rotate(360deg) scale(1.04, .95)' }),
                { transform: 'rotate(360deg)' },
            ] }],
        },
        {
            id: 'rattle', line: 'Sounds like bytes.', ms: 1800,
            body: body(1800, g(0.2, 'rotate(-5deg)', IO), g(0.8, 'rotate(-5deg)', IO), g(1, 'none')),
            moves: [{ t: 'box', ms: 1800, frames: [
                { transform: 'none' }, kf(0.2, { transform: 'translate(-14%, -20%) rotate(-10deg)', easing: OUT }),
                kf(0.28, { transform: 'translate(-14%, -20%) rotate(-4deg)' }), kf(0.34, { transform: 'translate(-14%, -20%) rotate(-16deg)' }),
                kf(0.4, { transform: 'translate(-14%, -20%) rotate(-4deg)' }), kf(0.46, { transform: 'translate(-14%, -20%) rotate(-16deg)' }),
                kf(0.52, { transform: 'translate(-14%, -20%) rotate(-5deg)' }), kf(0.58, { transform: 'translate(-14%, -20%) rotate(-14deg)' }),
                kf(0.8, { transform: 'translate(-14%, -20%) rotate(-10deg)', easing: IO }), { transform: 'none' },
            ] }],
        },
    ],
    finale: () => ({
        id: 'burst', line: 'Everything’s accounted for.', lineAt: 1500, ms: 2700,
        body: body(2700, g(0.12, 'translateY(-10%) scale(.95, 1.06)', OUT), g(0.3, 'none', IN), g(0.62, 'translateY(3%) scale(1.03, .96)', IO),
            g(0.72, 'translateY(-2%)', IO), g(0.82, 'translateY(3%) scale(1.03, .96)', IO), g(1, 'none')),
        face: { face: 'wide', ms: 1300 },
        moves: [
            { t: 'box', ms: 2700, frames: [
                { transform: 'none' }, kf(0.08, { transform: 'scale(1.1, .9)', easing: IO }),
                kf(0.16, { transform: 'translateY(-6%) scale(.92, 1.12)', easing: OUT }), kf(0.3, { transform: 'none', easing: IO }),
                kf(0.78, { transform: 'none' }), kf(0.84, { transform: 'scale(1.06, .94)' }), { transform: 'none' },
            ] },
            ...DOCS.map((d, i): PlayMove => ({
                t: `doc${i}` as FxTarget, ms: 2700, delay: i * 40, frames: [
                    { opacity: 0, transform: 'translate(0, 0) scale(.5)' },
                    kf(0.12, { opacity: 1, transform: 'translate(0, 0) scale(1)', easing: OUT }),
                    kf(0.36, { opacity: 1, transform: `translate(${d.dx}%, ${-d.h}%) rotate(${d.r}deg)`, easing: IO }),
                    kf(0.56, { opacity: 1, transform: `translate(${d.dx * 0.9}%, ${-d.h * 0.75}%) rotate(${d.r * 1.6}deg)`, easing: IN }),
                    kf(0.78, { opacity: 1, transform: 'translate(0, 0) scale(.8)' }),
                    kf(0.84, { opacity: 0, transform: 'translate(0, 0) scale(.5)' }),
                    { opacity: 0, transform: 'translate(0, 0) scale(.5)' },
                ],
            })),
        ],
    }),
};

const safe: Play = {
    beats: () => [
        {
            id: 'dial', line: 'Don’t watch.', ms: 1800,
            body: body(1800, g(0.2, 'rotate(5deg) translateX(3%)', OUT), g(0.85, 'rotate(5deg) translateX(3%)', IO), g(1, 'none')),
            moves: [{ t: 'dial', ms: 1800, frames: [
                { opacity: 0, transform: 'rotate(0deg)' }, kf(0.06, { opacity: 1, transform: 'rotate(0deg)', easing: IO }),
                kf(0.35, { opacity: 1, transform: 'rotate(250deg)', easing: IO }), kf(0.55, { opacity: 1, transform: 'rotate(120deg)', easing: IO }),
                kf(0.8, { opacity: 1, transform: 'rotate(300deg)', easing: IO }), kf(0.94, { opacity: 1, transform: 'rotate(360deg)' }),
                { opacity: 0, transform: 'rotate(360deg)' },
            ] }],
        },
        {
            id: 'door', line: 'It’s all encrypted anyway.', ms: 1900,
            body: body(1900, g(0.2, 'rotate(4deg) translateX(2%)', OUT), g(0.85, 'rotate(4deg) translateX(2%)', IO), g(1, 'none')),
            moves: [
                { t: 'door', ms: 1900, frames: [
                    { opacity: 0, transform: 'none' }, kf(0.05, { opacity: 1, transform: 'none', easing: OUT }),
                    kf(0.25, { opacity: 1, transform: 'perspective(90px) rotateY(-72deg)' }), kf(0.7, { opacity: 1, transform: 'perspective(90px) rotateY(-72deg)', easing: IN }),
                    kf(0.84, { opacity: 1, transform: 'none' }), kf(0.95, { opacity: 1, transform: 'none' }), { opacity: 0, transform: 'none' },
                ] },
                { t: 'safe', ms: 1900, frames: [{ transform: 'none' }, kf(0.84, { transform: 'none' }), kf(0.88, { transform: 'translateX(-4%)' }),
                    kf(0.92, { transform: 'translateX(3%)' }), { transform: 'none' }] },
            ],
        },
        {
            id: 'pat', line: 'Locked. Twice.', ms: 1400,
            body: body(1400, g(0.2, 'rotate(6deg) translateX(4%)', OUT), g(0.33, 'rotate(6deg) translateX(4%) translateY(2%)'),
                g(0.43, 'rotate(6deg) translateX(4%)'), g(0.53, 'rotate(6deg) translateX(4%) translateY(2%)'),
                g(0.8, 'rotate(6deg) translateX(4%)', IO), g(1, 'none')),
            moves: [{ t: 'safe', ms: 1400, frames: [{ transform: 'none' }, kf(0.33, { transform: 'scale(1.04, .95)' }), kf(0.43, { transform: 'none' }),
                kf(0.53, { transform: 'scale(1.04, .95)' }), kf(0.63, { transform: 'none' }), { transform: 'none' }] }],
        },
    ],
    finale: () => ({
        id: 'vault', line: 'New combination. Don’t ask.', lineAt: 1800, ms: 2900,
        body: body(2900, g(0.15, 'rotate(5deg) translateX(3%)', OUT), g(0.6, 'rotate(5deg) translateX(3%)', IO),
            g(0.7, 'translateY(-8%) scale(.95, 1.06)', OUT), g(0.82, 'none', IN), g(1, 'none')),
        face: { face: 'wide', at: 1100, ms: 900 },
        moves: [
            { t: 'dial', ms: 1100, frames: [
                { opacity: 0, transform: 'rotate(0deg)' }, kf(0.08, { opacity: 1, transform: 'rotate(0deg)', easing: 'cubic-bezier(.3,0,.7,1)' }),
                kf(0.9, { opacity: 1, transform: 'rotate(1080deg)' }), { opacity: 0, transform: 'rotate(1080deg)' },
            ] },
            { t: 'door', ms: 2000, delay: 1000, frames: [
                { opacity: 1, transform: 'none' }, kf(0.15, { opacity: 1, transform: 'perspective(90px) rotateY(-85deg)', easing: OUT }),
                kf(0.7, { opacity: 1, transform: 'perspective(90px) rotateY(-85deg)', easing: IN }),
                kf(0.8, { opacity: 1, transform: 'none' }), kf(0.92, { opacity: 1, transform: 'none' }), { opacity: 0, transform: 'none' },
            ] },
            { t: 'vaultKey', ms: 1500, delay: 1200, frames: [
                { opacity: 0, transform: 'translate(0, 0) rotate(0deg) scale(.5)' },
                kf(0.15, { opacity: 1, transform: 'translate(0, 0) scale(1)', easing: OUT }),
                kf(0.45, { opacity: 1, transform: 'translate(-60%, -160%) rotate(-200deg)', easing: IO }),
                kf(0.75, { opacity: 1, transform: 'translate(0, 0) rotate(-360deg) scale(.7)', easing: IN }),
                { opacity: 0, transform: 'translate(0, 0) scale(.5)' },
            ] },
            { t: 'safe', ms: 2900, frames: [{ transform: 'none' }, kf(0.82, { transform: 'none' }), kf(0.86, { transform: 'translateY(-10%) scale(.96, 1.06)' }),
                kf(0.92, { transform: 'translateY(2%) scale(1.05, .95)' }), { transform: 'none' }] },
        ],
    }),
};

const camo: Play = {
    beats: () => [
        {
            id: 'blink', line: 'You saw nothing.', ms: 1300,
            body: body(1300, g(0.1, 'scale(1.05)', OUT), g(0.3, 'scale(1.05)', IO), g(0.42, 'none', IO), g(1, 'none')),
            moves: [{ t: 'rig', ms: 1300, frames: [{ opacity: 0.22 }, kf(0.1, { opacity: 1 }), kf(0.3, { opacity: 1 }), kf(0.45, { opacity: 0.22 }), { opacity: 0.22 }] }],
        },
        {
            id: 'eyes', line: 'Not here.', ms: 1700,
            moves: [{ t: 'camoEyes', ms: 1700, frames: [
                { transform: 'none' }, kf(0.15, { transform: 'translateX(-9%)', easing: OUT }), kf(0.35, { transform: 'translateX(-9%)' }),
                kf(0.45, { transform: 'translateX(9%)', easing: OUT }), kf(0.65, { transform: 'translateX(9%)' }),
                kf(0.8, { transform: 'translateY(5%)', easing: IO }), { transform: 'none' },
            ] }],
        },
        {
            id: 'tiptoe', line: 'Nope.', lineAt: 900, ms: 2100,
            body: body(2100, g(0.12, 'translateX(5%) translateY(-2%)', IO), g(0.24, 'translateX(10%)', IO), g(0.36, 'translateX(15%) translateY(-2%)', IO),
                g(0.48, 'translateX(18%)', IO), g(0.6, 'translateX(18%)', IO), g(0.85, 'translateX(0)', IO), g(1, 'none')),
            moves: [],
        },
    ],
    finale: () => ({
        id: 'reveal', line: 'Fine. You found me.', ms: 2700,
        body: body(2700, g(0.15, 'translateY(-12%) scale(.95, 1.08)', OUT), g(0.3, 'translateY(0) scale(1.05, .95)', IN),
            g(0.45, 'rotate(-4deg)', IO), g(0.6, 'rotate(4deg)', IO), g(0.75, 'none', IO), g(1, 'none')),
        face: { face: 'happy', ms: 2000 },
        moves: [
            { t: 'rig', ms: 2700, frames: [{ opacity: 0.22 }, kf(0.12, { opacity: 1 }), kf(0.75, { opacity: 1 }), { opacity: 0.22 }] },
            { t: 'stripes', ms: 2700, frames: [{ opacity: 0 }, kf(0.12, { opacity: 0.9 }), kf(0.3, { opacity: 0 }), kf(0.45, { opacity: 0.9 }), kf(0.62, { opacity: 0 }), { opacity: 0 }] },
            { t: 'camoEyes', ms: 2700, frames: [{ opacity: 1 }, kf(0.1, { opacity: 0 }), kf(0.8, { opacity: 0 }), { opacity: 1 }] },
        ],
    }),
};

const offline: Play = {
    beats: () => [
        {
            id: 'antenna', line: 'Any bars?', ms: 2000,
            moves: [
                { t: 'antenna', ms: 2000, frames: [
                    { opacity: 0, transform: 'scaleY(0)' }, kf(0.15, { opacity: 1, transform: 'scaleY(1)', easing: OUT }),
                    kf(0.25, { opacity: 1, transform: 'rotate(-14deg)', easing: IO }), kf(0.35, { opacity: 1, transform: 'rotate(12deg)', easing: IO }),
                    kf(0.45, { opacity: 1, transform: 'rotate(-10deg)', easing: IO }), kf(0.55, { opacity: 1, transform: 'rotate(8deg)', easing: IO }),
                    kf(0.65, { opacity: 1, transform: 'rotate(-4deg)', easing: IO }), kf(0.85, { opacity: 1, transform: 'none' }),
                    { opacity: 0, transform: 'scaleY(0)' },
                ] },
                { t: 'nosig', ms: 2000, frames: [{ opacity: 1 }, kf(0.3, { opacity: 0.35 }), kf(0.6, { opacity: 1 }), { opacity: 1 }] },
            ],
        },
        {
            id: 'smack', line: 'Percussive maintenance.', ms: 1300, puff: 'bang',
            body: body(1300, g(0.1, 'translateX(-6%) rotate(-4deg)', OUT), g(0.18, 'translateX(4%) rotate(5deg)', IO),
                g(0.26, 'translateX(-2%) rotate(-2deg)', IO), g(0.4, 'none', IO), g(1, 'none')),
            moves: [{ t: 'nosig', ms: 1300, frames: [{ transform: 'none' }, kf(0.12, { transform: 'translateY(-10%) rotate(-8deg)', easing: OUT }),
                kf(0.3, { transform: 'none', easing: IO }), { transform: 'none' }] }],
        },
        {
            id: 'reach', line: 'One bar. Gone.', lineAt: 600, ms: 1900,
            body: body(1900, g(0.3, 'translateY(-12%) scale(.9, 1.16)', OUT), g(0.7, 'translateY(-12%) scale(.9, 1.16)', IO), g(1, 'none')),
            face: { face: 'worried', at: 1100, ms: 800 },
            moves: [{ t: 'antenna', ms: 1900, frames: [
                { opacity: 0, transform: 'scaleY(0)' }, kf(0.25, { opacity: 1, transform: 'scaleY(1.5)', easing: OUT }),
                kf(0.7, { opacity: 1, transform: 'scaleY(1.5)' }), { opacity: 0, transform: 'scaleY(0)' },
            ] }],
        },
    ],
    finale: () => ({
        id: 'climb', line: 'Still nothing.', lineAt: 1900, ms: 2700,
        body: body(2700, g(0.1, 'translateY(-14%) scale(.94, 1.08)', OUT), g(0.2, 'translateY(0) scale(1.05, .95)', IN),
            g(0.32, 'translateY(-18%) scale(.93, 1.1)', OUT), g(0.44, 'translateY(0) scale(1.05, .95)', IN),
            g(0.56, 'translateY(-22%) scale(.92, 1.12)', OUT), g(0.68, 'translateY(0) scale(1.06, .94)', IN),
            g(0.8, 'translateY(3%) scale(1.04, .95)', IO), g(1, 'none')),
        face: { face: 'focus', ms: 1800 },
        moves: [
            { t: 'antenna', ms: 2700, frames: [
                { opacity: 0, transform: 'scaleY(0)' }, kf(0.12, { opacity: 1, transform: 'scaleY(1.2)', easing: OUT }),
                kf(0.6, { opacity: 1, transform: 'scaleY(2.6)', easing: IO }), kf(0.72, { opacity: 1, transform: 'scaleY(2.6) rotate(10deg)' }),
                kf(0.84, { opacity: 1, transform: 'scaleY(1) rotate(-6deg)', easing: IN }), { opacity: 0, transform: 'scaleY(0)' },
            ] },
            { t: 'nosig', ms: 2700, frames: [{ opacity: 1, transform: 'none' }, kf(0.3, { opacity: 0.4, transform: 'scale(.9)' }),
                kf(0.6, { opacity: 1, transform: 'scale(1.1)' }), kf(0.75, { opacity: 1, transform: 'none' }), { opacity: 1, transform: 'none' }] },
        ],
    }),
};

const coffee: Play = {
    beats: () => [
        {
            id: 'sip', line: 'Ahh.', lineAt: 700, ms: 1500,
            face: { face: 'happy', at: 700, ms: 800 },
            moves: [{ t: 'mug', ms: 1500, frames: [{ transform: 'none' }, kf(0.3, { transform: 'translate(-6%, -14%) rotate(-28deg)', easing: OUT }),
                kf(0.7, { transform: 'translate(-6%, -14%) rotate(-28deg)', easing: IO }), { transform: 'none' }] }],
        },
        {
            id: 'spill', line: 'That was decaf anyway.', lineAt: 600, ms: 1600,
            face: { face: 'worried', at: 400, ms: 1100 },
            moves: [
                { t: 'mug', ms: 1600, frames: [{ transform: 'none' }, kf(0.25, { transform: 'rotate(52deg)', easing: OUT }),
                    kf(0.5, { transform: 'rotate(52deg)', easing: IO }), { transform: 'none' }] },
                ...([0, 1, 2] as const).map((i): PlayMove => ({
                    t: `drop${i}` as FxTarget, ms: 900, delay: 350 + i * 110, frames: [
                        { opacity: 0, transform: 'translate(0, 0) scale(.6)' }, kf(0.1, { opacity: 1, transform: 'translate(0, 0) scale(1)' }),
                        kf(0.8, { opacity: 1, transform: `translate(${(i - 1) * 40}%, 520%) scale(1, 1.3)`, easing: IN }),
                        { opacity: 0, transform: `translate(${(i - 1) * 40}%, 560%) scale(1.4, .6)` },
                    ],
                })),
            ],
        },
        {
            id: 'blow', line: 'Too hot.', ms: 1400,
            moves: [
                { t: 'mug', ms: 1400, frames: [{ transform: 'none' }, kf(0.2, { transform: 'translateY(-10%)', easing: OUT }),
                    kf(0.8, { transform: 'translateY(-10%)', easing: IO }), { transform: 'none' }] },
                { t: 'gust', ms: 1100, delay: 250, frames: [{ opacity: 0, transform: 'translateX(0) scaleX(.4)' }, kf(0.3, { opacity: 0.9, transform: 'translateX(-40%) scaleX(1)' }),
                    { opacity: 0, transform: 'translateX(-110%) scaleX(1.2)' }] },
            ],
        },
    ],
    finale: () => ({
        id: 'jitters', line: 'That was my fourth.', lineAt: 1200, ms: 2300,
        body: body(2300, g(0.5, 'none'), g(0.54, 'translateX(-2%)'), g(0.58, 'translateX(2%)'), g(0.62, 'translateX(-2%)'), g(0.66, 'translateX(2%)'),
            g(0.7, 'translateX(-2%)'), g(0.74, 'translateX(2%)'), g(0.78, 'translateX(-1%)'), g(0.82, 'translateX(1%)'), g(1, 'none')),
        face: { face: 'wide', at: 1100, ms: 1100 },
        moves: [{ t: 'mug', ms: 2300, frames: [{ transform: 'none' }, kf(0.2, { transform: 'translate(-6%, -18%) rotate(-70deg)', easing: OUT }),
            kf(0.45, { transform: 'translate(-6%, -18%) rotate(-75deg)', easing: IO }), kf(0.6, { transform: 'none', easing: IO }), { transform: 'none' }] }],
    }),
};

const lantern: Play = {
    beats: () => [
        {
            id: 'flicker', line: 'Bulb’s going.', ms: 1500,
            moves: [{ t: 'halo', ms: 1500, frames: [{ opacity: 1 }, kf(0.12, { opacity: 0.15 }), kf(0.28, { opacity: 0.9 }), kf(0.44, { opacity: 0.1 }),
                kf(0.66, { opacity: 1 }), kf(0.8, { opacity: 0.4 }), { opacity: 1 }] }],
        },
        {
            id: 'shine', line: 'Still up?', ms: 1900,
            body: body(1900, g(0.25, 'translateY(2%) scale(1.03)', OUT), g(0.75, 'translateY(2%) scale(1.03)', IO), g(1, 'none')),
            moves: [{ t: 'beam', ms: 1900, frames: [{ opacity: 0, transform: 'scale(.3)' }, kf(0.25, { opacity: 0.85, transform: 'scale(1)', easing: OUT }),
                kf(0.75, { opacity: 0.85, transform: 'scale(1.06)' }), { opacity: 0, transform: 'scale(1.2)' }] }],
        },
        {
            id: 'tap', line: 'There.', lineAt: 700, ms: 1300,
            moves: [wobble('lantern', 1300, 9), { t: 'halo', ms: 1300, frames: [{ opacity: 1, transform: 'scale(1)' }, kf(0.3, { opacity: 0.3, transform: 'scale(.8)' }),
                kf(0.6, { opacity: 1, transform: 'scale(1.3)', easing: OUT }), { opacity: 1, transform: 'scale(1)' }] }],
        },
    ],
    finale: () => ({
        id: 'moth', line: 'Go to bed.', lineAt: 1300, ms: 2500,
        moves: [
            wobble('lantern', 2500, 14),
            { t: 'moth', ms: 2500, frames: [
                { opacity: 0, transform: 'rotate(0deg) translateX(160%) rotate(0deg)' },
                kf(0.1, { opacity: 1, transform: 'rotate(60deg) translateX(160%) rotate(-60deg)' }),
                kf(0.9, { opacity: 1, transform: 'rotate(760deg) translateX(160%) rotate(-760deg)' }),
                { opacity: 0, transform: 'rotate(820deg) translateX(240%) rotate(-820deg)' },
            ] },
            { t: 'halo', ms: 2500, frames: [{ opacity: 1, transform: 'scale(1)' }, kf(0.3, { opacity: 1, transform: 'scale(1.5)' }), kf(0.7, { opacity: 1, transform: 'scale(1.5)' }),
                { opacity: 1, transform: 'scale(1)' }] },
        ],
    }),
};

const crown: Play = {
    beats: () => [
        {
            id: 'spin', line: 'Still fits.', lineAt: 900, ms: 1500,
            moves: [{ t: 'crown', ms: 1500, frames: [{ transform: 'none' }, kf(0.15, { transform: 'translateY(-14%)', easing: IO }),
                kf(0.75, { transform: 'translateY(-14%) rotate(360deg)', easing: IN }), kf(0.88, { transform: 'translateY(0) rotate(360deg)' }),
                kf(0.94, { transform: 'translateY(2%) rotate(360deg)' }), { transform: 'rotate(360deg)' }] }],
        },
        {
            id: 'tip', line: 'Can’t see.', lineAt: 400, ms: 1700,
            body: body(1700, g(0.3, 'none'), g(0.45, 'rotate(-4deg)', IO), g(0.55, 'rotate(4deg)', IO), g(0.65, 'rotate(-2deg)', IO), g(1, 'none')),
            moves: [{ t: 'crown', ms: 1700, frames: [{ transform: 'none' }, kf(0.25, { transform: 'translate(3%, 24%) rotate(16deg)', easing: IN }),
                kf(0.65, { transform: 'translate(3%, 24%) rotate(16deg)', easing: OUT }), kf(0.85, { transform: 'translate(0, -4%)', easing: IO }), { transform: 'none' }] }],
        },
        {
            id: 'polish', line: 'Shiny.', ms: 1300,
            moves: [wobble('crown', 1100, 6), popFx('csp0', 900, 200), popFx('csp1', 900, 450)],
        },
    ],
    finale: () => ({
        id: 'fling', line: 'Heavy is the head.', lineAt: 1700, ms: 2400,
        body: body(2400, g(0.12, 'translateY(3%) scale(1.04, .95)', IO), g(0.25, 'translateY(-4%)', OUT), g(0.7, 'none', IO),
            g(0.78, 'translateY(3%) scale(1.04, .95)', IN), g(1, 'none')),
        moves: [
            { t: 'crown', ms: 2400, frames: [
                { transform: 'none' }, kf(0.12, { transform: 'translateY(4%)', easing: OUT }),
                kf(0.42, { transform: 'translateY(-60%) rotate(540deg)', easing: IN }),
                kf(0.74, { transform: 'translateY(0) rotate(700deg)', easing: OUT }), kf(0.82, { transform: 'translateY(3%) rotate(712deg)', easing: IO }),
                kf(0.9, { transform: 'rotate(726deg)', easing: IO }), { transform: 'rotate(720deg)' },
            ] },
            popFx('csp0', 700, 1650), popFx('csp1', 700, 1800),
        ],
    }),
};

export const PLAYS: Record<Exclude<PlayState, 'neutral'>, Play> = {
    offline, call, gaming, dnd, asleep, camo, box, safe, pile, coffee, lantern, crown,
};

/** The fx elements a state mounts (KeysPlayFx renders exactly these). */
export function fxFor(state: PlayState, ctx: PlayCtx = { video: false, sharing: false }): FxTarget[] {
    if (state === 'neutral') return [];
    const p = PLAYS[state];
    const all = [...p.beats(ctx), p.finale(ctx)];
    const f = p.finale(ctx);
    if (f.hold) all.push(f.hold.release);
    const out = new Set<FxTarget>();
    for (const b of all) for (const m of b.moves) if (!isGearTarget(m.t)) out.add(m.t as FxTarget);
    return [...out];
}

const GEAR_TARGETS: ReadonlySet<string> = new Set<GearTarget>([
    'rig', 'tv', 'pad', 'headset', 'phones', 'sign', 'crown', 'lantern', 'halo', 'mug', 'box', 'safe',
    'camoEyes', 'pile', 'callb', 'nosig', 'zzz', 'ringlight', 'frame',
]);
export const isGearTarget = (t: string): t is GearTarget => GEAR_TARGETS.has(t);

/** A rapid click on a beat in flight: a small flinch, blended in by the runner. */
export const NUDGE: { ms: number; frames: Keyframe[] } = {
    ms: 320,
    frames: [g(0.3, 'translateY(2%) scale(1.04, .95)', OUT), g(0.65, 'translateY(-2%) scale(.98, 1.03)', IO), g(1, 'none')],
};

// ── the rare idle bits (utils/keysRare.ts decides when) ─────────────────────

export const RARE_BEATS: Record<'juggle' | 'newspaper', Beat> = {
    juggle: {
        id: 'juggle', ms: 3600,
        body: body(3600, g(0.1, 'translateY(-2%)', IO), g(0.2, 'translateY(1%)', IO), g(0.3, 'translateY(-2%)', IO), g(0.4, 'translateY(1%)', IO),
            g(0.5, 'translateY(-2%)', IO), g(0.6, 'translateY(1%)', IO), g(0.7, 'translateY(-2%)', IO), g(0.8, 'translateY(1%)', IO), g(1, 'none')),
        face: { face: 'happy', ms: 3400 },
        moves: ([0, 1, 2] as const).map((i): PlayMove => {
            // one ball's loop: right hand → up over → left hand → up over, twice
            const lo = 'translate(-130%, 0)', hi = 'translate(0, -320%)', ro = 'translate(130%, 0)';
            const fr: Keyframe[] = [{ opacity: 0, transform: lo }, kf(0.05, { opacity: 1, transform: lo, easing: 'cubic-bezier(.3,.6,.5,1)' })];
            const seq = [hi, ro, hi, lo, hi, ro, hi, lo];
            seq.forEach((t, k) => fr.push(kf(0.05 + (k + 1) * 0.11, { opacity: 1, transform: t, easing: k % 2 === 0 ? 'cubic-bezier(.5,0,.7,.4)' : 'cubic-bezier(.3,.6,.5,1)' })));
            fr.push({ opacity: 0, transform: lo });
            return { t: `ball${i}` as FxTarget, ms: 3000, delay: i * 300, frames: fr };
        }),
    },
    newspaper: {
        id: 'newspaper', ms: 4800, cls: 'hk-reading',
        body: body(4800, g(0.1, 'translateY(1%) rotate(-2deg)', IO), g(0.9, 'translateY(1%) rotate(-2deg)', IO), g(1, 'none')),
        moves: [{ t: 'paper', ms: 4800, frames: [
            { opacity: 0, transform: 'translateY(30%) scale(.6)' }, kf(0.08, { opacity: 1, transform: 'none', easing: OUT }),
            kf(0.5, { opacity: 1, transform: 'none' }), kf(0.53, { opacity: 1, transform: 'scaleX(.15)' }), kf(0.56, { opacity: 1, transform: 'none' }),
            kf(0.92, { opacity: 1, transform: 'none', easing: IN }), { opacity: 0, transform: 'translateY(30%) scale(.6)' },
        ] }],
    },
};
