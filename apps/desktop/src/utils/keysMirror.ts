/**
 * keysMirror — Keys on the Home deck mirrors what YOU are doing.
 *
 * Owner, 2026-10-20: "have keys on the main dashboard mirror what you're
 * doing ... if your status is DND have it do something, same with idle ...
 * make sure that everything has a nice animation going into that mode".
 *
 * This file is the pure half (vitest is `environment: node` for it): app
 * state in → a SCENE out (his body pose, the gear he wears / holds / has
 * beside him, his face), plus the gesture that carries him from one scene to
 * the next, plus the small rate-limit gates for the one-shot reactions
 * (paper-plane fly-by, Home-button dizzy, friend-online wave, a call starting
 * somewhere). HomeKeys renders the verdict; home-keys-mirror.css draws it.
 *
 * Inputs are COUNTS AND FLAGS ONLY: your own presence status, whether a game
 * is detected, whether you are in a call (and speaking / sharing / on camera),
 * the unread COUNT, whether a transfer or a backup is running. Never message
 * content, never who said what (doctrine rule 8). Nothing here does I/O.
 *
 * ── Precedence ──────────────────────────────────────────────────────────────
 * Keys has one body, one head, two hands and room for one prop on each side,
 * so several states share him by SLOT, and a slot goes to the strongest claim:
 *
 *   body pose  no connection > in a call > gaming > DND > away (asleep) > awake
 *   head       call headset > DND headphones;  DND eye mask only when nothing
 *              he is doing needs his eyes (pose 'focus');  the crown (Pro) only
 *              on a bare head with no calendar hat;  the night lantern always
 *   hands      screen-share frame (not gaming) > game controller > transfer box
 *              > backup papers > morning coffee;  empty while asleep/offline
 *   left       the TV (gaming), with a LIVE light when you share it in a call
 *   right      ring light (camera on in a call) > safe (backup running)
 *   floor      the unread pile (10 / 50 / 100+), whatever else is going on
 *   bubbles    no-signal > call bubble > Zzz
 *   overall    invisible = camouflage (translucent, floating eyes) on top of
 *              any of the above
 *
 * So DND + gaming = gaming at the TV, wearing DND headphones, the DND sign
 * planted beside him, no eye mask (he needs to see the screen). Away + in a
 * call = in the call (activity outranks idleness). Lost connection hides what
 * the server can no longer vouch for (call, game, status) but keeps what is
 * local and still true (the pile, the lantern, the crown).
 */

import type { KeysFace } from './keysBrain';

export type MirrorStatus = 'online' | 'away' | 'dnd' | 'offline';

export interface MirrorInputs {
    /** Your chosen/derived presence. 'offline' while connected = invisible. */
    status: MirrorStatus;
    /** The socket / network is up (useNetworkStatus). */
    connected: boolean;
    /** The local game detector has a game (its NAME is never needed). */
    gaming: boolean;
    inCall: boolean;
    speaking: boolean;
    sharing: boolean;
    video: boolean;
    /** Unread messages you are still owed (a count, nothing else). */
    unread: number;
    /** A big upload is in flight. */
    transfer: boolean;
    /** A backup run is in progress. */
    backup: boolean;
    /** Night dive (00:00–04:59, `<html data-depth="night">`). */
    night: boolean;
    pro: boolean;
    /** He is wearing a calendar hat today (Halloween, New Year, birthday). */
    costume: boolean;
    /** The morning-coffee beat is on (HomeKeys decides when, once a day). */
    coffee: boolean;
}

export const NEUTRAL_INPUTS: MirrorInputs = {
    status: 'online', connected: true, gaming: false, inCall: false, speaking: false,
    sharing: false, video: false, unread: 0, transfer: false, backup: false,
    night: false, pro: false, costume: false, coffee: false,
};

export type Pose = 'awake' | 'asleep' | 'focus' | 'gaming' | 'call' | 'offline';

/** Every piece of gear HomeKeys can draw. Order = paint order inside a layer. */
export const GEAR = [
    // left / right of him, and the floor
    'tv', 'live', 'ringlight', 'safe', 'sign',
    // on him
    'tvglow', 'headset', 'headphones', 'mask', 'crown', 'lantern', 'camoEyes',
    'controller', 'frame', 'box', 'papers', 'mug',
    // above him
    'noSignal', 'callBubble', 'zzz',
] as const;
export type Gear = (typeof GEAR)[number];

export type PileTier = 0 | 1 | 2 | 3;
/** Unread thresholds for the pile: a few envelopes, a heap, buried to the eyes. */
export const PILE_AT = [10, 50, 100] as const;
/** Going DOWN a tier needs the count this far below its threshold, so a count
 *  hovering at 49/50 does not bury and unbury him every few seconds. */
export const PILE_HYSTERESIS = 0.8;

export function pileTier(unread: number, prev: PileTier = 0): PileTier {
    const n = Number.isFinite(unread) && unread > 0 ? unread : 0;
    let up: PileTier = 0;
    for (let i = 0; i < PILE_AT.length; i++) if (n >= PILE_AT[i]) up = (i + 1) as PileTier;
    if (up >= prev) return up;
    // Descending: stay on a tier until the count is clearly below it.
    let t = prev;
    while (t > up && n < Math.floor(PILE_AT[t - 1] * PILE_HYSTERESIS)) t = (t - 1) as PileTier;
    return t;
}

export interface Scene {
    pose: Pose;
    /** Sorted in GEAR order, so two equal scenes compare equal. */
    gear: readonly Gear[];
    pile: PileTier;
    camo: boolean;
    /** The lantern burns low while he sleeps. */
    lanternDim: boolean;
    /** The face the scene holds (the host can still override briefly). */
    face: KeysFace | null;
    /** For his accessible name: what he is doing, in a few words ('' = nothing). */
    doing: string;
}

export function poseFor(i: MirrorInputs): Pose {
    if (!i.connected) return 'offline';
    if (i.inCall) return 'call';
    if (i.gaming) return 'gaming';
    if (i.status === 'dnd') return 'focus';
    if (i.status === 'away') return 'asleep';
    return 'awake';
}

export function sceneFor(i: MirrorInputs, prevPile: PileTier = 0): Scene {
    const pose = poseFor(i);
    const on = new Set<Gear>();
    const pile = pileTier(i.unread, prevPile);
    const offline = pose === 'offline';

    if (i.night) on.add('lantern');
    if (offline) {
        on.add('noSignal');
    } else {
        const dnd = i.status === 'dnd';
        // left: the game; and a LIVE light when you are sharing it in a call
        if (i.gaming) { on.add('tv'); on.add('tvglow'); }
        if (i.gaming && i.inCall && i.sharing) on.add('live');
        // right: the ring light outranks the safe
        if (i.inCall && i.video) on.add('ringlight');
        else if (i.backup) on.add('safe');
        // head
        if (i.inCall) on.add('headset');
        else if (dnd) on.add('headphones');
        if (pose === 'focus') on.add('mask');
        if (dnd) on.add('sign');
        // hands (nothing in them while he naps)
        if (pose !== 'asleep') {
            const hands: Gear | null =
                i.inCall && i.sharing && !i.gaming ? 'frame'
                    : i.gaming ? 'controller'
                        : i.transfer ? 'box'
                            : i.backup ? 'papers'
                                : i.coffee ? 'mug'
                                    : null;
            if (hands) on.add(hands);
        }
        // bubbles
        if (i.inCall) on.add('callBubble');
        else if (pose === 'asleep') on.add('zzz');
        // invisible
        if (i.status === 'offline') on.add('camoEyes');
    }
    if (i.pro && !i.costume && !on.has('headset') && !on.has('headphones')) on.add('crown');

    const camo = !offline && i.status === 'offline';
    // His face: no signal worries him; napping and DND close his eyes; a game
    // (even one you're streaming in a call) gets the determined slants; and
    // a heap of unread mail worries him too.
    const face: KeysFace | null =
        pose === 'offline' ? 'worried'
            : pose === 'asleep' || pose === 'focus' ? 'closed'
                : i.gaming ? 'focus'
                    : pile >= 2 && pose === 'awake' ? 'worried'
                        : null;

    const doing = [
        offline ? 'no signal'
            : pose === 'call' ? (i.sharing ? 'on a call, sharing a screen' : 'on a call')
                : pose === 'gaming' ? 'gaming'
                    : pose === 'focus' ? 'do not disturb'
                        : pose === 'asleep' ? 'napping'
                            : '',
        camo ? 'camouflaged' : '',
        pile === 3 ? 'buried in messages' : pile === 2 ? 'swamped with messages' : '',
    ].filter(Boolean).join(', ');

    return {
        pose,
        gear: GEAR.filter(g => on.has(g)),
        pile,
        camo,
        lanternDim: pose === 'asleep' && on.has('lantern'),
        face,
        doing,
    };
}

export function sameScene(a: Scene, b: Scene): boolean {
    return a.pose === b.pose && a.pile === b.pile && a.camo === b.camo && a.lanternDim === b.lanternDim
        && a.face === b.face && a.doing === b.doing
        && a.gear.length === b.gear.length && a.gear.every((g, k) => g === b.gear[k]);
}

// ── transitions ─────────────────────────────────────────────────────────────

/**
 * The body gesture that carries him between two scenes (HomeKeys plays it as
 * a Web Animation on his gesture wrapper, from wherever that wrapper is right
 * now, so an interrupted gesture hands over without a snap). The gear's own
 * entry / exit is CSS transitions (exits first, entries a beat later), and
 * the body pose is a CSS transition too: both retarget smoothly when a new
 * scene lands mid-way, so ANY change, in any direction, at any moment, is
 * seamless. One gesture per change, the most meaningful one.
 */
export type Gesture =
    | 'wake'      // asleep → anything: rubs his eyes, a big stretch
    | 'doze'      // → asleep: a yawn, then he curls up
    | 'shh'       // → DND: leans in, a little "shh"
    | 'unshh'     // DND → : shakes it off
    | 'hype'      // → gaming: an excited double hop
    | 'stretch'   // gaming / call → : leans back, stretches
    | 'listen'    // → call: perks up, tilts to listen
    | 'droop'     // → no connection: sags, shivers
    | 'perk'      // connection back: a hop
    | 'swamped'   // the pile grew a tier: wobbles under it
    | 'digOut'    // the pile shrank: digs himself out
    | 'shimmer'   // camouflage on / off
    | 'yawn'      // the lantern came on (night dive): a sleepy yawn as he reaches up
    | 'pickup'    // something new in his hands
    | 'proud';    // the crown arrived

const NEED_EYES_OPEN: readonly Pose[] = ['awake', 'gaming', 'call'];
const HANDS: readonly Gear[] = ['controller', 'frame', 'box', 'papers', 'mug'];

export function gestureFor(prev: Scene | null, next: Scene): Gesture | null {
    if (!prev) return null; // the first scene simply IS (mount, or the app starting)
    const a = prev.pose, b = next.pose;
    if (a !== b) {
        if (b === 'offline') return 'droop';
        if (a === 'offline') return 'perk';
        if (a === 'asleep') return 'wake';
        if (b === 'asleep') return 'doze';
        if (b === 'call') return 'listen';
        if (b === 'gaming') return 'hype';
        if (b === 'focus') return 'shh';
        if (a === 'focus') return NEED_EYES_OPEN.includes(b) ? 'unshh' : 'stretch';
        return 'stretch'; // gaming / call → awake
    }
    if (next.pile > prev.pile) return 'swamped';
    if (next.pile < prev.pile) return 'digOut';
    if (next.camo !== prev.camo) return 'shimmer';
    const had = new Set(prev.gear);
    const added = next.gear.filter(g => !had.has(g));
    if (added.includes('lantern')) return 'yawn';
    if (prev.gear.includes('lantern') && !next.gear.includes('lantern')) return 'stretch';
    if (added.some(g => HANDS.includes(g))) return 'pickup';
    if (added.includes('crown')) return 'proud';
    return null;
}

/** Gear that enters at the same moment as an outgoing piece waits this long,
 *  so the old prop is visibly on its way out first (home-keys-mirror.css
 *  `--hkg-in`). Exits never wait. */
export const GEAR_ENTER_DELAY_MS = 320;

// ── one-shot reactions: rate limits ─────────────────────────────────────────

/** A simple cooldown: fires, then refuses until `cooldownMs` has passed. */
export class Cooldown {
    private last = -Infinity;
    readonly cooldownMs: number;
    constructor(cooldownMs: number) { this.cooldownMs = cooldownMs; }
    /** Fire if allowed (and record it). A clock that went backwards fails quiet. */
    tryFire(now: number): boolean {
        if (now - this.last < this.cooldownMs && now >= this.last) return false;
        this.last = now;
        return true;
    }
    reset(): void { this.last = -Infinity; }
}

/** At least this long between paper planes. A burst of messages inside it is
 *  one plane (the first), not a squadron. */
export const PLANE_COOLDOWN_MS = 10_000;
/** The plane's flight, and when (fraction of it) it passes him and he startles. */
export const PLANE_FLIGHT_MS = 2400;
export const PLANE_STARTLE_AT = 0.56;
/** How long the startled face holds. */
export const STARTLE_MS = 900;

/** Home pressed this many times inside the window → he gets dizzy. */
export const DIZZY_PRESSES = 4;
export const DIZZY_WINDOW_MS = 2500;
export const DIZZY_COOLDOWN_MS = 8000;

/** One Home press. Returns the trimmed press history and whether he spins. */
export function homePress(times: readonly number[], now: number, lastDizzy: number): { times: number[]; dizzy: boolean } {
    const kept = [...times.filter(t => now - t < DIZZY_WINDOW_MS && now >= t), now];
    if (kept.length >= DIZZY_PRESSES && (now - lastDizzy >= DIZZY_COOLDOWN_MS || now < lastDizzy)) return { times: [], dizzy: true };
    return { times: kept, dizzy: false };
}

/** A friend coming online gets a wave, at most this often. */
export const WAVE_COOLDOWN_MS = 45_000;
/** More than this many "came online" at once is a snapshot (a reconnect, the
 *  first presence load), not a friend arriving: no wave. */
export const WAVE_MAX_BATCH = 3;
/** Nothing waves in the first moments on Home (presence is still settling). */
export const WAVE_SETTLE_MS = 8000;

/** Who is online now that was not before. */
export function newlyOnline(prev: ReadonlySet<string>, next: ReadonlySet<string>): string[] {
    const out: string[] = [];
    next.forEach(id => { if (!prev.has(id)) out.push(id); });
    return out;
}

export function waveForArrivals(arrivals: number, sinceMountMs: number): boolean {
    return arrivals > 0 && arrivals <= WAVE_MAX_BATCH && sinceMountMs >= WAVE_SETTLE_MS;
}

/** A call starting somewhere (the "Happening now" count rising) perks him up. */
export const CALL_PERK_COOLDOWN_MS = 30_000;

/** The morning coffee: 05:00–09:59 local, once a day, for this long. */
export const COFFEE_MS = 30_000;
export const COFFEE_EGG = 'keys-coffee';
export const COFFEE_COOLDOWN_MS = 10 * 60 * 60 * 1000;
export function isCoffeeHour(d: Date): boolean {
    const h = d.getHours();
    return h >= 5 && h < 10;
}

/** Uploads at least this big make him carry a box (small ones are instant). */
export const BIG_TRANSFER_BYTES = 8 * 1024 * 1024;
