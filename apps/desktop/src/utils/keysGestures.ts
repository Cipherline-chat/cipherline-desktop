/**
 * keysGestures — the body gestures Keys plays when what he mirrors changes
 * (utils/keysMirror.ts `gestureFor`), plus the one-shot reactions (startle,
 * dizzy, a call starting), and the little runner that plays them.
 *
 * Every gesture is transform-only keyframes for ONE html wrapper (HomeKeys'
 * `.hk-gest`), so it runs on the compositor and costs nothing between plays.
 * Sizes are relative (translate %, scale, deg) so they read the same in the
 * 76–128 px Home slot. Every gesture ends at `none`: the persistent pose
 * lives on a different wrapper (`.hk-pose`, a CSS transition), so a gesture
 * is a flourish ON TOP of the pose and never has to know it.
 *
 * Interruption: `GestureRunner.play` starts the new gesture FROM wherever the
 * wrapper is at that instant (its computed transform), then cancels the old
 * one, so a scene that changes mid-gesture hands over without a snap — the
 * same "from wherever it is now" rule the spam shows use.
 */

import type { Gesture } from './keysMirror';

export type Transient = 'startle' | 'dizzy' | 'callPerk';
export type Motion = Gesture | Transient;

export interface Spec { ms: number; frames: Keyframe[] }

const f = (offset: number, transform: string, easing?: string): Keyframe =>
    (easing ? { offset, transform, easing } : { offset, transform });
const IO = 'cubic-bezier(.45,0,.55,1)';
const OUT = 'cubic-bezier(.2,.8,.2,1)';
const IN = 'cubic-bezier(.5,0,.75,0)';

export const MOTIONS: Record<Motion, Spec> = {
    // asleep → up: rub one eye, the other, then a big full-body stretch
    wake: { ms: 1500, frames: [
        f(.12, 'rotate(-5deg) translateY(1%)', IO), f(.24, 'rotate(3deg) translateY(1%)', IO),
        f(.34, 'rotate(-4deg)', IO), f(.44, 'rotate(0deg)', IO),
        f(.66, 'translateY(-7%) scale(.93, 1.12)', OUT), f(.84, 'translateY(0) scale(1.04, .96)', IO),
        f(1, 'none'),
    ] },
    // → asleep: a slow yawn up, a sag, and he settles into the curl
    doze: { ms: 1600, frames: [
        f(.38, 'translateY(-4%) scale(.95, 1.1)', IO), f(.55, 'translateY(-4%) scale(.95, 1.1)', IO),
        f(.75, 'translateY(1%) scale(1.03, .96) rotate(-2deg)', IO), f(1, 'none'),
    ] },
    // → DND: leans in for a "shh", a small nod
    shh: { ms: 1100, frames: [
        f(.3, 'rotate(-7deg) translateY(2%)', OUT), f(.5, 'rotate(-4deg) translateY(1%)', IO),
        f(.68, 'rotate(-7deg) translateY(2%)', IO), f(1, 'none'),
    ] },
    // DND → : shakes it off
    unshh: { ms: 800, frames: [
        f(.2, 'rotate(6deg)', IO), f(.42, 'rotate(-6deg)', IO), f(.64, 'rotate(3deg)', IO), f(1, 'none'),
    ] },
    // → gaming: two excited hops
    hype: { ms: 950, frames: [
        f(.2, 'translateY(-14%) scale(.95, 1.06)', OUT), f(.38, 'translateY(0) scale(1.07, .93)', IN),
        f(.58, 'translateY(-9%) scale(.97, 1.04)', OUT), f(.78, 'translateY(0) scale(1.04, .96)', IN),
        f(1, 'none'),
    ] },
    // gaming / call / night → : leans back and stretches
    stretch: { ms: 1150, frames: [
        f(.35, 'translateY(-5%) scale(.95, 1.1) rotate(3deg)', OUT), f(.55, 'translateY(-5%) scale(.95, 1.1) rotate(-3deg)', IO),
        f(.8, 'scale(1.03, .97)', IO), f(1, 'none'),
    ] },
    // → call: perks up and tilts his head to listen
    listen: { ms: 1000, frames: [
        f(.25, 'translateY(-5%) scale(1.05)', OUT), f(.5, 'rotate(-6deg) translateY(-2%)', IO),
        f(.75, 'rotate(-6deg) translateY(-2%)', IO), f(1, 'none'),
    ] },
    // connection lost: sags, a shiver
    droop: { ms: 1100, frames: [
        f(.3, 'translateY(4%) scale(1.03, .94)', IO), f(.45, 'translateY(4%) translateX(-2%) scale(1.03, .94)'),
        f(.55, 'translateY(4%) translateX(2%) scale(1.03, .94)'), f(.65, 'translateY(4%) translateX(-1%) scale(1.03, .94)'),
        f(1, 'none'),
    ] },
    // connection back: a hop
    perk: { ms: 750, frames: [
        f(.35, 'translateY(-11%) scale(.96, 1.06)', OUT), f(.65, 'translateY(0) scale(1.05, .95)', IN), f(1, 'none'),
    ] },
    // the pile grew: wobbles under the weight
    swamped: { ms: 950, frames: [
        f(.2, 'rotate(-6deg) translateY(2%)', IO), f(.42, 'rotate(5deg) translateY(3%)', IO),
        f(.64, 'rotate(-3deg) translateY(3%) scale(1.03, .96)', IO), f(1, 'none'),
    ] },
    // the pile shrank: wriggles and pops up out of it
    digOut: { ms: 1250, frames: [
        f(.15, 'translateY(5%) rotate(-4deg)', IO), f(.3, 'translateY(5%) rotate(4deg)', IO),
        f(.5, 'translateY(-13%) scale(.95, 1.07) rotate(-3deg)', OUT), f(.72, 'translateY(0) scale(1.05, .95)', IN),
        f(.86, 'rotate(2deg)', IO), f(1, 'none'),
    ] },
    // camouflage on / off
    shimmer: { ms: 750, frames: [
        f(.3, 'scale(1.05, .97)', IO), f(.6, 'scale(.98, 1.03)', IO), f(1, 'none'),
    ] },
    // the night lantern comes on: a sleepy yawn, reaching up to it
    yawn: { ms: 1400, frames: [
        f(.4, 'translateY(-4%) scale(.95, 1.1)', IO), f(.6, 'translateY(-4%) scale(.95, 1.1) rotate(4deg)', IO),
        f(.82, 'rotate(2deg)', IO), f(1, 'none'),
    ] },
    // something new in his hands: a squat to pick it up
    pickup: { ms: 850, frames: [
        f(.35, 'translateY(5%) scale(1.04, .92)', IO), f(.65, 'translateY(-4%) scale(.98, 1.03)', OUT), f(1, 'none'),
    ] },
    // the crown arrived
    proud: { ms: 950, frames: [
        f(.3, 'translateY(-4%) scale(1.08)', OUT), f(.7, 'translateY(-4%) scale(1.08)', IO), f(1, 'none'),
    ] },
    // the paper plane whooshed past: a jump, then he lands and settles
    startle: { ms: 750, frames: [
        f(.22, 'translateY(-20%) scale(.9, 1.12)', OUT), f(.5, 'translateY(0) scale(1.08, .92)', IN),
        f(.72, 'translateY(-4%) scale(.98, 1.02)', OUT), f(1, 'none'),
    ] },
    // the Home button, mashed: a full spin, then a wobble that dies away
    dizzy: { ms: 1700, frames: [
        f(.04, 'rotate(0deg)'), f(.22, 'rotate(180deg)', 'linear'), f(.4, 'rotate(360deg)', OUT),
        f(.52, 'rotate(372deg)', IO), f(.64, 'rotate(350deg)', IO), f(.76, 'rotate(366deg)', IO),
        f(.88, 'rotate(357deg)', IO), f(1, 'rotate(360deg)'),
    ] },
    // a call started somewhere: ears up, a glance down at "Happening now"
    callPerk: { ms: 900, frames: [
        f(.3, 'translateY(-6%) scale(.97, 1.05)', OUT), f(.55, 'rotate(5deg) translateY(1%)', IO),
        f(.8, 'rotate(5deg) translateY(1%)', IO), f(1, 'none'),
    ] },
};

/** Its first frame, filled in with where the wrapper is right now. */
export function framesFrom(current: string, spec: Spec): Keyframe[] {
    const from = current && current !== 'none' ? current : 'none';
    return [{ offset: 0, transform: from }, ...spec.frames];
}

export interface GestureHost {
    animate(frames: Keyframe[], opts: KeyframeAnimationOptions): Animation;
}

/**
 * Plays one gesture at a time on one element. A new one starts from the
 * element's current transform and replaces the running one; `settle` eases a
 * cut-off gesture home instead of snapping it.
 */
export class GestureRunner {
    private running: Animation | null = null;
    /** What is playing (null = nothing). For tests and the host's "busy" check.
     *  'play' = a click reaction (utils/keysPlay.ts) via `playSpec`. */
    current: Motion | 'settle' | 'play' | null = null;
    private readonly el: GestureHost;
    private readonly readTransform: () => string;
    constructor(el: GestureHost, readTransform: () => string) {
        this.el = el;
        this.readTransform = readTransform;
    }

    play(m: Motion): Animation | null {
        const spec = MOTIONS[m];
        return this.start(framesFrom(this.readTransform(), spec), spec.ms, m);
    }

    /** A one-off body gesture (a click reaction: utils/keysPlay.ts), started
     *  from wherever he is, exactly like a named one. */
    playSpec(spec: Spec): Animation | null {
        return this.start(framesFrom(this.readTransform(), spec), spec.ms, 'play');
    }

    /** Ease back to rest from wherever he is (used when a gesture is cut off
     *  with nothing to replace it, e.g. reduced motion switched on). */
    settle(): void {
        if (!this.running) return;
        this.start([{ transform: this.readTransform() || 'none' }, { transform: 'none' }], 220, 'settle');
    }

    cancel(): void {
        this.running?.cancel();
        this.running = null;
        this.current = null;
    }

    pause(): void { this.running?.pause(); }
    resume(): void { this.running?.play(); }

    private start(frames: Keyframe[], ms: number, name: Motion | 'settle' | 'play'): Animation | null {
        let anim: Animation;
        try {
            anim = this.el.animate(frames, { duration: ms, easing: 'linear', fill: 'none' });
        } catch {
            return null;
        }
        const prev = this.running;
        this.running = anim;
        this.current = name;
        prev?.cancel(); // AFTER the new one holds the element: no frame at rest in between
        const done = () => { if (this.running === anim) { this.running = null; this.current = null; } };
        try { anim.addEventListener?.('finish', done); anim.addEventListener?.('cancel', done); } catch { /* fakes */ }
        return anim;
    }
}

// ── the paper plane and the little puffs ────────────────────────────────────

/** The fly-by, relative to Keys' box: in from the left over the greeting,
 *  a dip toward him, over his head, and a climbing turn out to the right. */
export const PLANE_FRAMES: Keyframe[] = [
    { offset: 0, transform: 'translate(-380px, 34px) rotate(-6deg)', opacity: 0 },
    { offset: .08, transform: 'translate(-330px, 22px) rotate(-5deg)', opacity: 1, easing: IO },
    { offset: .3, transform: 'translate(-205px, -6px) rotate(-1deg)', easing: IO },
    { offset: .48, transform: 'translate(-70px, 10px) rotate(7deg)', easing: IO },
    { offset: .58, transform: 'translate(-6px, -4px) rotate(-6deg)', easing: IO },
    { offset: .74, transform: 'translate(56px, -36px) rotate(-26deg)', easing: IO },
    { offset: .9, transform: 'translate(92px, -78px) rotate(-48deg)', opacity: .9 },
    { offset: 1, transform: 'translate(104px, -108px) rotate(-66deg)', opacity: 0 },
];

export const PUFFS = {
    /** The "!" over his head when the plane startles him. */
    bang: { ms: 900, frames: [
        { opacity: 0, transform: 'translateY(6px) scale(.4)' },
        { opacity: 1, transform: 'translateY(-2px) scale(1.15)', offset: .2, easing: OUT },
        { opacity: 1, transform: 'translateY(-4px) scale(1)', offset: .7 },
        { opacity: 0, transform: 'translateY(-10px) scale(.9)' },
    ] as Keyframe[] },
    /** The "shh" as he goes DND. */
    shh: { ms: 1400, frames: [
        { opacity: 0, transform: 'translate(0, 4px) scale(.6)' },
        { opacity: 1, transform: 'translate(-4px, -2px) scale(1)', offset: .25, easing: OUT },
        { opacity: 1, transform: 'translate(-8px, -6px) scale(1)', offset: .7 },
        { opacity: 0, transform: 'translate(-12px, -12px) scale(.95)' },
    ] as Keyframe[] },
    /** Stars circling when he's dizzy. */
    stars: { ms: 1700, frames: [
        { opacity: 0, transform: 'rotate(0deg) scale(.6)' },
        { opacity: 1, transform: 'rotate(140deg) scale(1)', offset: .2 },
        { opacity: 1, transform: 'rotate(520deg) scale(1)', offset: .8 },
        { opacity: 0, transform: 'rotate(640deg) scale(.8)' },
    ] as Keyframe[] },
    /** Rings rising off him when a call starts somewhere. */
    ping: { ms: 1100, frames: [
        { opacity: 0, transform: 'scale(.5)' },
        { opacity: .9, transform: 'scale(.8)', offset: .25 },
        { opacity: 0, transform: 'scale(1.5)' },
    ] as Keyframe[] },
} as const;
export type Puff = keyof typeof PUFFS;
