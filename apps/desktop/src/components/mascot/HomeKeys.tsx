import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Keys, type KeysFace, type KeysMood, type KeysSignal, type PokeReaction } from './Keys';
import { isMotionActive, onMotionChange } from '../../utils/idleMotion';
import {
    registerClick, isBroken, reached, lineIndex, inputTime, SPAM_GAP_MS, SPAM_COUNTS_AT,
    type SpamStreak, type PlayVerdict,
} from '../../utils/keysBurst';
import { SHOWS, REST, ready, upNext, deal, type Move, type Personality, type Show, type Target } from '../../utils/keysSpam';
import { readSpamBag, writeSpamBag } from '../../utils/keysSpamStore';
import { BROWS } from '../../utils/keysBrain';
import type { Gear } from '../../utils/keysMirror';
import { ParallaxController, tiltAngles, layerShift, type Rect } from '../../utils/keysParallax';
import {
    playStateFor, PLAYS, CLAIMING, GARNISH, FinaleGate, VariationBag, finaleEggId, fxFor, NUDGE, NUDGE_GAP_MS, RARE_BEATS,
    type PlayState, type PlayCtx, type PlayMove, type PlayFace, type PlayTarget, type GearTarget, type FxTarget, type Beat, type Finale,
} from '../../utils/keysPlay';
import {
    shinyThisLaunch, rareIdleDecision, rareIdleLastAt, markRareIdle, RARE_IDLE_CHECK_MS, RARE_IDLE_MS, type RareIdleBit,
} from '../../utils/keysRare';
import { recordEggFound } from '../../utils/eggProgress';
import { useKeysMirror, type HomeKeysMirror } from './useKeysMirror';
import { GearBack, GearOn, GearFront } from './KeysGear';
import { PlayBack, PlayOn, PlayFront } from './KeysPlayFx';
import '../../styles/home-keys.css';
import '../../styles/home-keys-mirror.css';
import '../../styles/home-keys-play.css';

export type { HomeKeysMirror };

/**
 * Keys on the Home deck: the shared rig (Keys.tsx) plus what makes him feel
 * alive in a spot he occupies all day, and the easter egg.
 *
 *  - A slow jellyfish swim: a quick little stroke up, then a long glide down.
 *    It moves ONE html wrapper (.hk-swim) with transform only, so it runs on
 *    the compositor; the shared rig's twelve-segment leg sway, which costs
 *    main-thread style + paint every frame (SVG children cannot be
 *    composited), is turned off here (`idleSway={false}`). The swim stops
 *    with the rest of the app's decoration when the window is blurred,
 *    hidden or untouched (utils/idleMotion.ts) and under reduced motion.
 *  - Blinks (the rig's own), and every so often a glance to one side.
 *  - Pointer over him: a 3D parallax tilt (utils/keysParallax.ts). The
 *    scene tilts toward the pointer and each layer shifts by its own depth
 *    (the TV and the floor less than his body), his eyes follow it. A
 *    spring-like ease in JS writes two CSS variables per frame only while
 *    they move; React does not re-render. Off under reduced motion.
 *  - Clicks while he mirrors an activity: that activity's own reactions,
 *    three per state, and a finale for spamming him (utils/keysPlay.ts).
 *    Neutral Keys keeps the poke ladder and the spam egg below; a garnish
 *    (crown, coffee, lantern, the pile) plays on top of it without taking
 *    the egg away.
 *  - Rare: Shiny Keys (one launch in 500), and now and then a juggle or a
 *    newspaper while you leave him be (utils/keysRare.ts).
 *  - One click: the rig's poke ladder (a wiggle, happy brows, a quip from
 *    the host).
 *  - Spam him and KEEP IT UP: he puts on a show that builds for five
 *    seconds (one of five, a different one each streak: utils/keysSpam.ts),
 *    then the host opens the Firewall game. Stop short and he settles back
 *    down his own way. If the game cannot open (a call is live), the show
 *    ends on its PAYOFF instead (a disco, a victory lap, a reboot, a
 *    power-up, a reveal: utils/keysSpam.ts), not on a refusal line. The streak rule is utils/keysBurst.ts. Every show's
 *    motion is Web Animations on html elements (transform / opacity:
 *    compositor), started from the click handler, so nothing runs between
 *    clicks. Under reduced motion the shows' motion is skipped (his lines
 *    still build), and the game still opens: see keysBurst homeGameVerdict.
 *  - He MIRRORS you (useKeysMirror, utils/keysMirror.ts): asleep when you're
 *    away, masked and shushing on DND, at a little TV with a controller when
 *    you're gaming, in a headset on a call, camouflaged when invisible,
 *    buried in envelopes when the unreads pile up, carrying a box for a big
 *    upload, filing papers into a safe during a backup, a lantern at night;
 *    and a paper plane startles him when a message lands. Every state has an
 *    entry and an exit, and any change can interrupt any other.
 */

export type { PlayVerdict };

/**
 * The one refusal that still has to be said: a machine that cannot draw the
 * game at all. (A live call used to get one fixed refusal line on
 * every show: it is now the show's own payoff, see `startPayoff`. The game
 * still never opens over a call; HomePanel owns that rule.)
 */
export const BURST_LINES = {
    unavailable: 'I’d play, but this machine can’t draw the game.',
} as const;

/** How long a payoff lasts when nothing may move (reduced motion, or the
 *  window is resting): just long enough to read his line. */
export const STATIC_PAYOFF_MS = 2400;

/** From the 5-second click to the game opening: long enough to see the finale. */
export const PLAY_DELAY_MS = 750;
/** How long past the gap the "streak is over" settle waits before it starts.
 *  Only the settle's start: whether a click continues the streak is decided
 *  by the clicks' own timestamps. The slack is for a busy main thread: a
 *  click that happened inside the gap but is still queued must get handled
 *  (and cancel this) before the settle could throw the streak away. */
export const SETTLE_SLACK_MS = 200;
const SETTLE_AFTER_MS = SPAM_GAP_MS + SETTLE_SLACK_MS;
const LINE_MS = 2400;

export interface HomeKeysProps {
    /** The signed-in account: the show rotation is kept per account. */
    userId: string;
    signal: KeysSignal;
    /** The host's quip (the poke ladder's lines); a show line outranks it. */
    speech: string | null;
    /** The ambience switch: the swim, glances and idle perks. */
    lively: boolean;
    /** The ladder's pokes (the host picks the line). Not called for streak clicks. */
    onPoke: (count: number) => void;
    /** Asked when the streak completes: may the game open right now? */
    canPlay: () => PlayVerdict;
    /** Open the game. */
    onPlay: () => void;
    /** What you're doing, for him to mirror (counts and flags only). Absent =
     *  a neutral, online Keys. */
    mirror?: HomeKeysMirror;
    /** A click reaction or finale played (not the poke ladder, which calls
     *  onPoke): the host's cue for the little sound. */
    onReact?: () => void;
}

/** Where the click reactions' gear targets live (KeysGear's markup). */
const GEAR_SEL: Record<GearTarget, string> = {
    rig: '.k2-root', tv: '.hkg-tv', pad: '.hkg-pad > svg', headset: '.hkg-headset', phones: '.hkg-phones > svg',
    sign: '.hkg-sign > svg', crown: '.hkg-crown > svg', lantern: '.hkg-lantern > svg', halo: '.hkg-lantern-halo',
    mug: '.hkg-mug > svg', box: '.hkg-box > svg', safe: '.hkg-safe > svg', camoEyes: '.hkg-camoeyes > svg',
    pile: '.hkg-pile', callb: '.hkg-callb', nosig: '.hkg-nosig > svg', zzz: '.hkg-zzz', ringlight: '.hkg-ring > svg',
    frame: '.hkg-frame > svg',
};
const BASE_LABEL = 'Keys, the Cipherline mascot';
/** Nobody is looking: hidden, resting, or Settings covers Home. */
const unseen = () =>
    typeof document !== 'undefined' && (document.hidden || !isMotionActive()
        || document.documentElement.getAttribute('data-cl-occluded') === 'on');

const reducedMotion = () =>
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** The keyframe's animated properties (not its offset / easing / composite). */
const propsOf = (k: Keyframe) => Object.keys(k).filter(p => p !== 'offset' && p !== 'easing' && p !== 'composite');

/** His silhouette (the mark's own shapes), for the glitch's ghost copies. */
const Silhouette: React.FC<{ className: string; reg: (el: Element | null) => void }> = ({ className, reg }) => (
    <svg ref={reg} className={className} viewBox="0 0 110 92" aria-hidden="true" focusable="false">
        <path d="M21 48 A34 34 0 0 1 89 48 L89 53 L21 53 Z" />
        <rect x="22.5" y="47" width="13" height="27" rx="6.5" />
        <rect x="39.8" y="47" width="13" height="27" rx="6.5" />
        <rect x="57.1" y="47" width="13" height="27" rx="6.5" />
        <rect x="74.4" y="47" width="13" height="27" rx="6.5" />
    </svg>
);

export const HomeKeys: React.FC<HomeKeysProps> = ({ userId, signal, speech, lively, onPoke, canPlay, onPlay, mirror, onReact }) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const reactRef = useRef<HTMLDivElement>(null);
    const [face, setFace] = useState<KeysFace | null>(null);
    const [line, setLine] = useState<{ text: string; cls?: string } | null>(null);
    const [mood, setMood] = useState<KeysMood>('awake');
    /** The show this streak gets (its elements mount on the streak's first click). */
    const [show, setShow] = useState<Personality | null>(null);
    /** The show's own eyes are drawn (from its `eyesFrom` on). */
    const [eyesOn, setEyesOn] = useState(false);

    const streak = useRef<SpamStreak | null>(null);
    const showRef = useRef<Personality | null>(null);
    const clickN = useRef(0);
    const dealt = useRef(false);
    /** Until when (performance.now) clicks are swallowed: the finale (or a
     *  refusal) plays out even though the spammer is still clicking. */
    const busyUntil = useRef(-Infinity);
    const els = useRef<Partial<Record<Target, Element | null>>>({});
    const held = useRef(new Map<Target, { anim: Animation; to: Keyframe }>());
    const transient = useRef(new Map<Target, Animation>());
    /** A payoff in flight: how long it runs, how much has played, and since
     *  when (null = paused because the window is resting). */
    const payoffRun = useRef<{ total: number; elapsed: number; since: number | null } | null>(null);
    const timers = useRef<{ settle?: ReturnType<typeof setTimeout>; line?: ReturnType<typeof setTimeout>; play?: ReturnType<typeof setTimeout>; end?: ReturnType<typeof setTimeout> }>({});
    const latest = useRef({ canPlay, onPlay, userId, onReact });
    useEffect(() => { latest.current = { canPlay, onPlay, userId, onReact }; });

    // ── the click reactions (utils/keysPlay.ts) ──────────────────────────
    const [playFace, setPlayFace] = useState<PlayFace | null>(null);
    const [playWave, setPlayWave] = useState(false);
    /** Asleep: he moved his bed to the other side (the finale). */
    const [bedMoved, setBedMoved] = useState(false);
    const [rareBit, setRareBit] = useState<RareIdleBit | null>(null);
    const [shiny] = useState(() => shinyThisLaunch());
    const fxEls = useRef<Partial<Record<FxTarget, HTMLElement | null>>>({});
    const regFx = useCallback((t: FxTarget) => (el: HTMLElement | null) => { fxEls.current[t] = el; }, []);
    /** The reaction animation currently on each element (so the next one
     *  starts from where it is), and the ones that hold (the DND wall). */
    const playAnims = useRef(new Map<Element, Animation>());
    /** The current beat's own timers (its line, its face): a new beat drops them. */
    const beatTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
    const otherTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
    const beatUntil = useRef(-Infinity);
    const lastClickAt = useRef(-Infinity);
    /** A claiming state's finale in flight (clicks are its own), and the DND
     *  wall waiting to be knocked over. */
    const finaleRun = useRef<{ state: PlayState; until: number; hold?: { release: Beat; timer: ReturnType<typeof setTimeout> } } | null>(null);
    const gates = useRef(new Map<PlayState, FinaleGate>());
    const bags = useRef(new Map<PlayState, VariationBag>());
    const playStateRef = useRef<PlayState>('neutral');
    const ctxRef = useRef<PlayCtx>({ video: false, sharing: false });
    const viewRef = useRef<{ playBody: (s: { ms: number; frames: Keyframe[] }) => void; puff: (k: NonNullable<Beat['puff']>) => void } | null>(null);

    const reg = useCallback((t: Target) => (el: Element | null) => { els.current[t] = el; }, []);

    /** Start a show's moves (Web Animations, compositor). Nothing loops. */
    const play = useCallback((moves: Move[]) => {
        if (reducedMotion()) return;
        const nodeFor = (t: Target): Element | null =>
            t === 'body' ? reactRef.current
                : t === 'rig' ? reactRef.current?.querySelector('.k2-root') ?? null
                    : els.current[t] ?? null;
        for (const m of moves) {
            const node = nodeFor(m.target) as (Element & { animate?: Element['animate'] }) | null;
            if (!node || typeof node.animate !== 'function') continue;
            const prev = held.current.get(m.target);
            let frames = m.frames;
            if (frames.length > 1 && propsOf(frames[0]).length === 0) {
                // "from wherever it is now": its held state, else REST
                const from: Keyframe = {};
                const props = new Set(frames.slice(1).flatMap(propsOf));
                for (const p of props) from[p] = prev?.to[p] ?? REST[m.target][p];
                frames = [{ ...from, ...(frames[0].easing ? { easing: frames[0].easing } : {}) }, ...frames.slice(1)];
            }
            if (m.hold && prev) {
                // carry held properties this move does not touch, so nothing snaps
                const extra = propsOf(prev.to).filter(p => !(p in frames[0]));
                if (extra.length) {
                    const keep = Object.fromEntries(extra.map(p => [p, prev.to[p]]));
                    frames = [{ ...frames[0], ...keep }, ...frames.slice(1, -1), { ...frames[frames.length - 1], ...keep }];
                }
            }
            const anim = node.animate(frames, { duration: m.ms, easing: m.easing ?? 'linear', fill: m.hold ? 'forwards' : 'none' });
            if (m.hold) {
                const last = frames[frames.length - 1];
                held.current.set(m.target, { anim, to: Object.fromEntries(propsOf(last).map(p => [p, last[p]])) });
                prev?.anim.cancel();
            } else {
                transient.current.get(m.target)?.cancel();
                transient.current.set(m.target, anim);
            }
        }
    }, []);

    /** Drop every show animation (he is at REST by then, or covered by the game). */
    const resetAnims = useCallback(() => {
        held.current.forEach(h => h.anim.cancel());
        held.current.clear();
        transient.current.forEach(a => a.cancel());
        transient.current.clear();
    }, []);

    const say = useCallback((text: string, cls?: string, ms = LINE_MS) => {
        clearTimeout(timers.current.line);
        setLine(prev => (prev?.text === text && prev.cls === cls ? prev : { text, cls }));
        timers.current.line = setTimeout(() => setLine(null), ms);
    }, []);

    /** The show is over: back to plain Keys. */
    const endShow = useCallback(() => {
        payoffRun.current = null;
        clearTimeout(timers.current.settle);
        clearTimeout(timers.current.end);
        resetAnims();
        showRef.current = null;
        setShow(null);
        setEyesOn(false);
        setFace(null);
        rootRef.current?.classList.remove('hk-avoid');
    }, [resetAnims]);

    useEffect(() => () => {
        const t = timers.current;
        clearTimeout(t.settle); clearTimeout(t.line); clearTimeout(t.play); clearTimeout(t.end);
        resetAnims();
    }, [resetAnims]);

    // ── reactions: the machinery ─────────────────────────────────────────
    const later = useCallback((fn: () => void, ms: number, own = true) => {
        (own ? beatTimers : otherTimers).current.push(setTimeout(fn, ms));
    }, []);
    const dropBeatTimers = useCallback(() => {
        beatTimers.current.forEach(clearTimeout);
        beatTimers.current = [];
    }, []);

    const resolve = useCallback((t: PlayTarget): Element | null => {
        const sel = (GEAR_SEL as Record<string, string | undefined>)[t];
        if (sel) return rootRef.current?.querySelector(sel) ?? null;
        return fxEls.current[t as FxTarget] ?? null;
    }, []);

    /** One move, started from wherever its element is right now (a reaction
     *  that is cut off hands over without a snap, the GestureRunner's rule). */
    const runMove = useCallback((m: PlayMove) => {
        const el = resolve(m.t) as (Element & { animate?: Element['animate'] }) | null;
        if (!el || typeof el.animate !== 'function') return;
        const prev = playAnims.current.get(el);
        let frames = m.frames;
        if (prev && frames.length > 1) {
            try {
                const cs = getComputedStyle(el);
                const first: Keyframe = { ...frames[0] };
                if ('transform' in first) first.transform = cs.transform || 'none';
                if ('opacity' in first) first.opacity = cs.opacity || first.opacity;
                frames = [first, ...frames.slice(1)];
            } catch { /* keep the authored first frame */ }
        }
        let a: Animation;
        try {
            a = el.animate(frames, { duration: m.ms, delay: m.delay ?? 0, easing: m.easing ?? 'linear', fill: m.hold ? 'both' : 'backwards' });
        } catch { return; }
        playAnims.current.set(el, a);
        prev?.cancel(); // after the new one holds the element
        const done = () => { if (playAnims.current.get(el) === a) playAnims.current.delete(el); };
        if (!m.hold) { try { a.addEventListener?.('finish', done); } catch { /* fakes */ } }
    }, [resolve]);

    /** Play a beat: its body gesture, its moves, its face and line. Under
     *  reduced motion (or nobody looking) only the face and the line. */
    const playBeat = useCallback((b: Beat, now: number) => {
        dropBeatTimers();
        // Which reaction played last (for the harness and the tests; a
        // plain attribute, nothing reads it).
        if (rootRef.current) rootRef.current.dataset.beat = b.id;
        const live = !reducedMotion() && !unseen();
        if (b.line) {
            const line = b.line;
            if (b.lineAt) later(() => say(line, undefined, LINE_MS), b.lineAt);
            else say(line, undefined, LINE_MS);
        }
        if (b.face) {
            const { face: fc, at = 0, ms } = b.face;
            later(() => setPlayFace(fc), at);
            later(() => setPlayFace(cur => (cur === fc ? null : cur)), at + ms);
        } else {
            setPlayFace(null);
        }
        if (live) {
            if (b.body) viewRef.current?.playBody(b.body);
            b.moves.forEach(runMove);
            if (b.puff) viewRef.current?.puff(b.puff);
            if (b.wave) {
                setPlayWave(true);
                later(() => setPlayWave(false), 3400, false);
            }
            const root = rootRef.current;
            if (b.cls && root) {
                const cls = b.cls;
                root.classList.add(cls);
                later(() => root.classList.remove(cls), b.ms, false);
            }
        }
        beatUntil.current = now + b.ms;
    }, [dropBeatTimers, later, runMove, say]);

    const gateFor = useCallback((ps: PlayState) => {
        let gt = gates.current.get(ps);
        if (!gt) { gt = new FinaleGate(); gates.current.set(ps, gt); }
        return gt;
    }, []);
    const bagFor = useCallback((ps: PlayState) => {
        let bg = bags.current.get(ps);
        if (!bg) { bg = new VariationBag(3); bags.current.set(ps, bg); }
        return bg;
    }, []);

    /** The DND wall comes down (your click, or it gives up waiting). */
    const releaseHold = useCallback((now: number) => {
        const run = finaleRun.current;
        if (!run?.hold) return;
        clearTimeout(run.hold.timer);
        const rel = run.hold.release;
        finaleRun.current = { state: run.state, until: now + rel.ms };
        playBeat(rel, now);
        latest.current.onReact?.();
        later(() => { if (finaleRun.current?.state === run.state && !finaleRun.current.hold) finaleRun.current = null; }, rel.ms, false);
    }, [later, playBeat]);

    /** A state's finale. Claiming states own the clicks while it plays;
     *  a garnish's plays alongside the neutral show. Counts as its egg. */
    const playFinale = useCallback((ps: Exclude<PlayState, 'neutral'>, now: number) => {
        let f: Finale = PLAYS[ps].finale(ctxRef.current);
        // A garnish's finale over a running show is a prop flourish only:
        // the show's own lines keep the bubble.
        if (!CLAIMING.has(ps) && showRef.current) f = { ...f, line: undefined };
        playBeat(f, now);
        recordEggFound(finaleEggId(ps));
        latest.current.onReact?.();
        if (f.moveBed) later(() => setBedMoved(b => !b), 500, false);
        if (!CLAIMING.has(ps)) return;
        const live = !reducedMotion() && !unseen();
        finaleRun.current = { state: ps, until: now + f.ms };
        later(() => {
            const run = finaleRun.current;
            if (!run || run.state !== ps || run.hold) return;
            if (f.hold && live) {
                const timer = setTimeout(() => releaseHold(performance.now()), f.hold.ms);
                otherTimers.current.push(timer);
                finaleRun.current = { state: ps, until: Infinity, hold: { release: f.hold.release, timer } };
            } else {
                finaleRun.current = null;
            }
        }, f.ms, false);
    }, [later, playBeat, releaseHold]);

    useEffect(() => () => {
        beatTimers.current.forEach(clearTimeout);
        otherTimers.current.forEach(clearTimeout);
        const run = finaleRun.current;
        if (run?.hold) clearTimeout(run.hold.timer);
        playAnims.current.forEach(a => a.cancel());
        playAnims.current.clear();
    }, []);

    /** A click while he is busy with something that claims him. */
    const claimClick = useCallback((ps: Exclude<PlayState, 'neutral'>, now: number, prevClick: number) => {
        const run = finaleRun.current;
        if (run) {
            if (run.hold) releaseHold(now);
            return; // mid-finale: he's busy
        }
        if (gateFor(ps).click(now)) { playFinale(ps, now); return; }
        // Clicking again while a beat is still playing: flustered, not a new beat.
        if (now - prevClick < NUDGE_GAP_MS && now < beatUntil.current) {
            if (!reducedMotion() && !unseen()) viewRef.current?.playBody(NUDGE);
            return;
        }
        const beats = PLAYS[ps].beats(ctxRef.current);
        playBeat(beats[bagFor(ps).next(Math.random)], now);
        latest.current.onReact?.();
    }, [bagFor, gateFor, playBeat, playFinale, releaseHold]);

    /** The streak broke short of five seconds: this show's way of settling. */
    const recover = useCallback(() => {
        const id = showRef.current;
        const got = reached(streak.current);
        streak.current = null;
        if (!id || got < 0.05) { endShow(); return; }
        const rc = SHOWS[id].recover(got);
        play(rc.moves);
        if (got >= 0.4) say(SHOWS[id].recoveredLine, SHOWS[id].speech);
        clearTimeout(timers.current.settle);
        timers.current.settle = setTimeout(endShow, rc.ms + 40);
    }, [endShow, play, say]);

    /**
     * The 5 s were kept up but the game cannot open: the show ends on its own
     * payoff, a finite one-shot (transform / opacity Web Animations, nothing
     * loops, everything ends at REST). Static, with just his line, when
     * nothing may move: reduced motion, or the window is resting. Paused (and
     * resumed where it left off) if the window rests mid-payoff.
     */
    const startPayoff = useCallback((s: Show, verdict: Exclude<PlayVerdict, 'ok'>) => {
        const po = s.payoff();
        const live = !reducedMotion() && isMotionActive();
        const total = live ? po.ms : STATIC_PAYOFF_MS;
        say(verdict === 'unavailable' ? BURST_LINES.unavailable : s.payoffLine, s.speech, Math.max(LINE_MS, total - 200));
        if (live) play(po.moves);
        payoffRun.current = { total, elapsed: 0, since: performance.now() };
        clearTimeout(timers.current.settle);
        timers.current.settle = setTimeout(endShow, total + 40);
        return total;
    }, [endShow, play, say]);

    // Reaction animations pause with the window too (and pick up where they were).
    useEffect(() => onMotionChange(active => {
        playAnims.current.forEach(a => { try { if (active) a.play(); else a.pause(); } catch { /* fakes */ } });
    }), []);

    // The window starts resting mid-payoff (blurred, minimised, hidden, or
    // 45 s untouched): freeze it, and pick it up again where it stopped.
    useEffect(() => onMotionChange(active => {
        const run = payoffRun.current;
        if (!run) return;
        if (!active && run.since !== null) {
            run.elapsed += performance.now() - run.since;
            run.since = null;
            clearTimeout(timers.current.settle);
            held.current.forEach(h => h.anim.pause());
            transient.current.forEach(a => a.pause());
        } else if (active && run.since === null) {
            run.since = performance.now();
            held.current.forEach(h => h.anim.play());
            transient.current.forEach(a => a.play());
            timers.current.settle = setTimeout(endShow, Math.max(0, run.total - run.elapsed) + 40);
        }
    }), [endShow]);

    // Every click asks here first (Keys' interceptPoke). A click that starts
    // a streak returns null: the rig runs its normal poke ladder. Clicks that
    // keep a streak going are the show's.
    const interceptPoke = useCallback((timeStamp: number | undefined): PokeReaction | null => {
        // When the click happened, not when we got to it (keysBurst inputTime).
        const now = inputTime(timeStamp, performance.now());
        const prevClick = lastClickAt.current;
        lastClickAt.current = now;
        // What he is mirroring decides who answers (utils/keysPlay.ts).
        const ps = playStateRef.current;
        if (ps !== 'neutral' && CLAIMING.has(ps)) {
            claimClick(ps, now, prevClick);
            return 'none';
        }
        // A garnish's finale lands on the burst's sixth click, on top of
        // whatever the neutral egg is doing (it never stops the egg).
        const garnish = ps !== 'neutral' && GARNISH.has(ps) ? ps : null;
        const garnishFinale = garnish !== null && gateFor(garnish).click(now);
        if (garnish && garnishFinale) playFinale(garnish, now);
        // Mid-finale: he's busy. The clicks that are still coming in must not
        // start a new streak (that would cut the finale off).
        if (now < busyUntil.current || payoffRun.current) return 'none';
        if (isBroken(streak.current, now)) recover();
        const r = registerClick(streak.current, now);
        streak.current = r.streak;
        clearTimeout(timers.current.settle);

        if (!r.continued) {
            // A new streak: whatever was settling stops, and the next show
            // in the rotation is lined up (not used up: see SPAM_COUNTS_AT).
            if (showRef.current) endShow();
            const { userId: uid } = latest.current;
            const stored = readSpamBag(uid);
            const bag = ready(stored);
            if (bag !== stored) writeSpamBag(uid, bag);
            // Its elements mount with the streak's second click: a lone
            // poke never puts anything extra in the DOM.
            showRef.current = upNext(bag);
            clickN.current = 0;
            dealt.current = false;
            timers.current.settle = setTimeout(recover, SETTLE_AFTER_MS);
            // A garnish adds its own beat to the poke (the ladder still runs).
            if (garnish && !garnishFinale) {
                const beats = PLAYS[garnish].beats(ctxRef.current);
                playBeat(beats[bagFor(garnish).next(Math.random)], now);
            }
            return null;
        }

        const id = showRef.current ?? 'dance';
        const s = SHOWS[id];
        const n = ++clickN.current;
        if (n === 1) {
            setShow(id);
            // The show takes over from a garnish's beat: its late line and
            // face are dropped (its prop motion just finishes).
            dropBeatTimers();
            setPlayFace(null);
        }
        if (!dealt.current && (r.fired || r.progress >= SPAM_COUNTS_AT)) {
            // This streak counts: the next one gets the next show.
            const { userId: uid } = latest.current;
            writeSpamBag(uid, deal(ready(readSpamBag(uid))));
            dealt.current = true;
        }

        if (r.fired) {
            const verdict = latest.current.canPlay();
            busyUntil.current = now + PLAY_DELAY_MS + 500;
            if (verdict === 'ok') {
                play(s.finale().moves);
                say(s.finaleLine, s.speech);
                clearTimeout(timers.current.play);
                timers.current.play = setTimeout(() => {
                    latest.current.onPlay();
                    // back to plain Keys under the game, ready for when it closes
                    timers.current.end = setTimeout(endShow, 300);
                }, PLAY_DELAY_MS);
            } else {
                // The payoff owns the clicks that are still coming in
                // (payoffRun), however long it runs.
                busyUntil.current = now + startPayoff(s, verdict) + 300;
            }
            return 'none';
        }

        play(s.click(r.progress, n));
        if (r.progress >= s.eyesFrom) {
            if (s.eyes !== 'own') { setFace('blank'); setEyesOn(true); }
            else if (s.face) setFace(s.face);
        }
        rootRef.current?.classList.toggle('hk-avoid', !!s.avoid);
        say(s.lines[lineIndex(r.progress)], s.speech);
        // No click within the gap: the streak is over.
        timers.current.settle = setTimeout(recover, SETTLE_AFTER_MS);
        return 'none';
    }, [bagFor, claimClick, dropBeatTimers, endShow, gateFor, play, playBeat, playFinale, recover, say, startPayoff]);

    // MID-STREAK ONLY: a click that lands in his hit zone (the slot plus its
    // padding) but not on him still counts as a click on him. During a show
    // he ducks, skews, shrinks and sidesteps (up to ~16 px), so a pointer
    // that has not moved is soon NOT over him, and a measured 1-4 clicks per
    // streak (real Chromium pointer, still cursor) missed him and threw away
    // the streak. Outside a live streak this does nothing, so the padding
    // never steals a click from a neighbour. It goes straight to the streak
    // with the event's own timestamp (a re-dispatched rig.click() would be
    // stamped with the moment it was re-dispatched).
    const onZoneClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        const rig = reactRef.current?.querySelector<HTMLElement>('.k2-root');
        if (!rig || rig.contains(e.target as Node)) return;
        const at = inputTime(e.timeStamp, performance.now());
        // A claiming state's burst (he sidesteps and tiptoes too): a click
        // in his zone right after one on him still counts.
        if (CLAIMING.has(playStateRef.current) && at - lastClickAt.current <= NUDGE_GAP_MS * 2) { interceptPoke(e.timeStamp); return; }
        const s = streak.current;
        if (!s || isBroken(s, at)) return;
        interceptPoke(e.timeStamp);
    }, [interceptPoke]);

    // The 3D hover parallax (utils/keysParallax.ts): the pointer over his
    // hit zone, eased, tilts the scene and shifts each layer by its depth
    // (keysParallax tiltAngles / layerShift), as inline transforms. The rect is read when the pointer
    // arrives (and after a scroll / resize), never in the frame loop. Off
    // under reduced motion; parked at rest while the window is hidden.
    useEffect(() => {
        const el = rootRef.current;
        if (!el) return;
        const ctl = new ParallaxController({
            raf: cb => requestAnimationFrame(cb),
            caf: id => cancelAnimationFrame(id),
            now: () => performance.now(),
            apply: (v, active) => {
                // Inline transforms on the five layers, not CSS variables on
                // the root: a custom property invalidates style for his whole
                // subtree (~230 nodes; measured ~14 ms a write in the full
                // app stylesheet), a transform only its own element.
                const L = layers();
                const px = (n: number) => `${n.toFixed(2)}px`;
                if (!active) {
                    for (const n of [L.par, L.lean, L.eyes, ...L.back, ...L.front]) if (n) n.style.transform = '';
                } else {
                    const { rx, ry } = tiltAngles(v);
                    const back = layerShift('back', v), front = layerShift('front', v), me = layerShift('body', v);
                    const eyes = layerShift('eyes', v);
                    const away = el.classList.contains('hk-avoid') ? -1 : 1; // dodge: eyes anywhere but the pointer
                    if (L.par) L.par.style.transform = `perspective(420px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
                    for (const n of L.back) n.style.transform = `translate(${px(back.x)}, ${px(back.y)})`;
                    for (const n of L.front) n.style.transform = `translate(${px(front.x)}, ${px(front.y)})`;
                    if (L.lean) L.lean.style.transform = `translate(${px(me.x)}, ${px(me.y)}) rotate(${(v.x * 4).toFixed(2)}deg)`;
                    if (L.eyes) L.eyes.style.transform = `translate(${px(eyes.x * away)}, ${px(eyes.y * away)})`;
                }
                el.classList.toggle('is-tilt', active);
            },
        });
        // Looked up per frame (a handful of scoped queries, no style work):
        // the effect stages mount and unmount with his state.
        const layers = () => ({
            par: el.querySelector<HTMLElement>(':scope > .hk-par'),
            lean: el.querySelector<HTMLElement>(':scope > .hk-par > .hk-lean'),
            eyes: el.querySelector<SVGGElement>('.k2-eyes'),
            back: [...el.querySelectorAll<HTMLElement>(':scope > .hk-par > .hkg-stage--back')],
            front: [...el.querySelectorAll<HTMLElement>(':scope > .hk-par > .hkg-stage--front')],
        });
        const readRect = (): Rect => {
            const r = el.getBoundingClientRect();
            return { left: r.left, top: r.top, width: r.width, height: r.height };
        };
        const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
        const sync = () => ctl.setEnabled(!reducedMotion() && !document.hidden);
        sync();
        const onEnter = (e: PointerEvent) => {
            el.classList.add('is-look');
            ctl.enter(readRect());
            ctl.move(e.clientX, e.clientY);
        };
        const onMove = (e: PointerEvent) => {
            if (!el.classList.contains('is-look')) el.classList.add('is-look');
            ctl.move(e.clientX, e.clientY, ctl.needsRect() ? readRect() : undefined);
        };
        const onLeave = () => {
            el.classList.remove('is-look');
            ctl.leave();
        };
        const stale = () => ctl.invalidate();
        el.addEventListener('pointerenter', onEnter, { passive: true });
        el.addEventListener('pointermove', onMove, { passive: true });
        el.addEventListener('pointerleave', onLeave, { passive: true });
        document.addEventListener('visibilitychange', sync);
        window.addEventListener('resize', stale, { passive: true });
        window.addEventListener('scroll', stale, { passive: true, capture: true });
        mq?.addEventListener?.('change', sync);
        return () => {
            ctl.destroy();
            el.removeEventListener('pointerenter', onEnter);
            el.removeEventListener('pointermove', onMove);
            el.removeEventListener('pointerleave', onLeave);
            document.removeEventListener('visibilitychange', sync);
            window.removeEventListener('resize', stale);
            window.removeEventListener('scroll', stale, { capture: true });
            mq?.removeEventListener?.('change', sync);
        };
    }, []);

    // Now and then, a glance to one side: one timer, a class for 1.8 s, no
    // React render. Not while the pointer has his attention, not mid-show,
    // not while the window is resting (idleMotion), never under reduced motion.
    useEffect(() => {
        const el = rootRef.current;
        if (!el || !lively) return;
        let t: ReturnType<typeof setTimeout>;
        let clear: ReturnType<typeof setTimeout>;
        const loop = () => {
            t = setTimeout(() => {
                if (!reducedMotion() && isMotionActive() && !el.classList.contains('is-look') && !showRef.current) {
                    const cls = Math.random() < 0.5 ? 'hk-glance-l' : 'hk-glance-r';
                    el.classList.add(cls);
                    clear = setTimeout(() => el.classList.remove(cls), 1800);
                }
                loop();
            }, 9000 + Math.random() * 9000);
        };
        loop();
        return () => {
            clearTimeout(t); clearTimeout(clear);
            el.classList.remove('hk-glance-l', 'hk-glance-r');
        };
    }, [lively]);

    // The mirror waits while the spam egg or a finale owns his body (its
    // gestures only; the scene itself keeps up underneath).
    const busy = useCallback(() => showRef.current !== null || payoffRun.current !== null || finaleRun.current !== null, []);
    const view = useKeysMirror(mirror, busy);
    const { scene } = view;
    const gearOn = useCallback((g: Gear) => scene.gear.includes(g), [scene]);

    const playState = playStateFor(scene);
    const video = scene.gear.includes('ringlight');
    const sharing = scene.gear.includes('frame') || scene.gear.includes('live');
    useLayoutEffect(() => {
        viewRef.current = { playBody: view.playBody, puff: view.puff };
        ctxRef.current = { video, sharing };
    });
    // A new state: the old one's burst is forgotten, its finale (and the
    // DND wall) let go; leaving sleep puts the bed back.
    useLayoutEffect(() => {
        const prev = playStateRef.current;
        playStateRef.current = playState;
        if (prev === playState) return;
        gates.current.get(prev)?.clear();
        const run = finaleRun.current;
        if (run && run.state !== playState) {
            if (run.hold) clearTimeout(run.hold.timer);
            finaleRun.current = null;
        }
    }, [playState]);
    // Waking up puts the bed back (state adjusted during render, React's
    // pattern for "reset when a prop changes").
    const pose = scene.pose;
    const [bedPose, setBedPose] = useState(pose);
    if (pose !== bedPose) {
        setBedPose(pose);
        if (pose !== 'asleep' && bedMoved) setBedMoved(false);
    }

    const fxList = useMemo<FxTarget[]>(() => [
        ...fxFor(playState, { video, sharing }),
        ...(rareBit === 'juggle' ? (['ball0', 'ball1', 'ball2'] as const) : rareBit === 'newspaper' ? (['paper'] as const) : []),
        ...(shiny ? (['shine0', 'shine1'] as const) : []),
    ], [playState, video, sharing, rareBit, shiny]);

    // Shiny Keys: seen = found (once, ever), and a little twinkle hello.
    useEffect(() => {
        if (!shiny) return;
        recordEggFound('shiny-keys');
        const t = setTimeout(() => {
            if (reducedMotion() || unseen()) return;
            const pop = (tt: FxTarget, delay: number): PlayMove => ({ t: tt, ms: 900, delay, frames: [
                { opacity: 0, transform: 'scale(0) rotate(0deg)' }, { offset: 0.3, opacity: 1, transform: 'scale(1.2) rotate(45deg)' },
                { opacity: 0, transform: 'scale(.4) rotate(90deg)' },
            ] });
            runMove(pop('shine0', 0));
            runMove(pop('shine1', 260));
        }, 1200);
        return () => clearTimeout(t);
    }, [shiny, runMove]);

    // The rare idle bits: now and then (at most one an hour) while you are
    // on Home and leaving him alone, he juggles or reads a tiny newspaper.
    useEffect(() => {
        if (!lively) return;
        let t: ReturnType<typeof setTimeout>;
        const loop = () => {
            t = setTimeout(() => {
                const now = performance.now();
                const ps = playStateRef.current;
                const free = !reducedMotion() && !unseen()
                    && (ps === 'neutral' || ps === 'crown' || ps === 'lantern')
                    && !busy() && now >= beatUntil.current
                    && !rootRef.current?.classList.contains('is-look');
                const bit = rareIdleDecision({ now, lastAt: rareIdleLastAt(), lastClickAt: lastClickAt.current, free }, Math.random);
                if (bit) { markRareIdle(now); setRareBit(bit); }
                loop();
            }, RARE_IDLE_CHECK_MS);
        };
        loop();
        return () => clearTimeout(t);
    }, [lively, busy]);
    // ...its props mount with it, then it plays, then they go.
    useEffect(() => {
        if (!rareBit) return;
        const go = setTimeout(() => playBeat(RARE_BEATS[rareBit], performance.now()), 0);
        const t = setTimeout(() => setRareBit(null), RARE_IDLE_MS[rareBit] + 120);
        return () => { clearTimeout(go); clearTimeout(t); };
    }, [rareBit, playBeat]);

    const eyes = show && eyesOn ? SHOWS[show].eyes : null;
    const bubble = line ?? (speech ? { text: speech } : null);
    const label = [BASE_LABEL, scene.doing, shiny ? 'in a rare color' : ''].filter(Boolean).join(', ');
    const heldFace: KeysFace | null = face ?? (playFace === 'oneEye' ? 'blank' : playFace) ?? view.face;

    return (
        <div
            ref={rootRef}
            className="hk"
            data-swim={lively ? signal : 'off'}
            data-spam={show ?? undefined}
            data-pose={scene.pose}
            data-pile={scene.pile}
            data-camo={scene.camo ? 'on' : undefined}
            data-speaking={view.speaking ? 'on' : undefined}
            data-play={playState}
            data-bed={bedMoved && scene.pose === 'asleep' ? 'moved' : undefined}
            data-shiny={shiny ? 'on' : undefined}
            onClick={onZoneClick}
        >
            {/* The bubble lives out here, not in the rig: it must not bob or
                lean with him. Hidden while he naps, as the rig does. */}
            {bubble && mood !== 'asleep' && (
                <span key={bubble.text} className={`k2-speech${bubble.cls ? ` ${bubble.cls}` : ''}`}>{bubble.text}</span>
            )}
            {/* The parallax stage: everything that tilts and shifts with the
                pointer (the bubble above stays put). */}
            <div className="hk-par">
            <GearBack on={gearOn} />
            <PlayBack fx={fxList} reg={regFx} />
            <div className="hk-lean">
                <div className="hk-swim">
                <div className="hk-pose">
                <div className="hk-gest" ref={view.gestRef}>
                    <div className="hk-react" ref={reactRef}>
                        {/* Behind him: the show's back layer. */}
                        {show === 'glitch' && (
                            <>
                                <Silhouette className="hk-ghost hk-ghost-a" reg={reg('ghostA')} />
                                <Silhouette className="hk-ghost hk-ghost-b" reg={reg('ghostB')} />
                            </>
                        )}
                        {show === 'dance' && (
                            <span className="hk-disco" aria-hidden="true">
                                <span ref={reg('discoA')} className="hk-disco-a" />
                                <span ref={reg('discoB')} className="hk-disco-b" />
                            </span>
                        )}
                        {show === 'charge' && (
                            <span className="hk-rings" aria-hidden="true">
                                <span ref={reg('fill')} className="hk-ring hk-ring--fill" />
                                <span ref={reg('ring0')} className="hk-ring" />
                                <span ref={reg('ring1')} className="hk-ring" />
                                <span ref={reg('ring2')} className="hk-ring" />
                            </span>
                        )}
                        <Keys
                            fluid
                            idleSway={false}
                            lively={lively}
                            signal={signal}
                            onMoodChange={setMood}
                            face={heldFace}
                            wave={view.wave || playWave}
                            ariaLabel={label}
                            asButton
                            interceptPoke={interceptPoke}
                            onPoke={onPoke}
                        />
                        <GearOn on={gearOn} lanternDim={scene.lanternDim} />
                        <PlayOn fx={fxList} reg={regFx} oneEye={playFace === 'oneEye'} />
                        {/* In front: the show's face and props, in his own
                            viewBox's proportions (110 x 92). */}
                        <span className="hk-face" aria-hidden="true">
                            {show === 'camo' && <span ref={reg('stripes')} className="hk-stripes" />}
                            {show === 'camo' && <span className="hk-sheen-clip"><span ref={reg('sheen')} className="hk-sheen" /></span>}
                            {show === 'glitch' && <span ref={reg('scan')} className="hk-scan" />}
                            {show === 'dodge' && (
                                <>
                                    <span ref={reg('streak0')} className="hk-streak hk-streak--r" />
                                    <span ref={reg('streak1')} className="hk-streak hk-streak--l" />
                                    <span ref={reg('dust')} className="hk-dust" />
                                </>
                            )}
                            {(show === 'dance' || show === 'charge') && (
                                <>
                                    <span ref={reg('spark0')} className="hk-spark hk-spark--0" />
                                    <span ref={reg('spark1')} className="hk-spark hk-spark--1" />
                                    <span ref={reg('spark2')} className="hk-spark hk-spark--2" />
                                </>
                            )}
                            {show === 'dance' && <span ref={reg('ball')} className="hk-ball"><i /></span>}
                            {eyes === 'pixel' && (
                                <svg className="hk-eyes" viewBox="0 0 110 92">
                                    <rect x="36.5" y="33" width="9" height="7" />
                                    <rect x="64.5" y="33" width="9" height="7" />
                                    <rect x="45.5" y="35" width="3" height="3" opacity=".6" />
                                </svg>
                            )}
                            {eyes === 'focus' && (
                                <svg className="hk-eyes hk-eyes--stroke" viewBox="0 0 110 92">
                                    <path d="M34 35 L48 39.5" />
                                    <path d="M62 39.5 L76 35" />
                                </svg>
                            )}
                            {eyes === 'float' && (
                                <>
                                    <svg ref={reg('eyesDark')} className="hk-eyes hk-eyes--stroke" viewBox="0 0 110 92">
                                        <path d={BROWS.awakeL} /><path d={BROWS.awakeR} />
                                    </svg>
                                    <svg ref={reg('eyesLight')} className="hk-eyes hk-eyes--stroke hk-eyes--light" viewBox="0 0 110 92">
                                        <path d={BROWS.awakeL} /><path d={BROWS.awakeR} />
                                    </svg>
                                </>
                            )}
                            {show === 'dance' && (
                                <>
                                    <span ref={reg('note0')} className="hk-note">♪</span>
                                    <span ref={reg('note1')} className="hk-note hk-note--b">♫</span>
                                    <span ref={reg('note2')} className="hk-note">♪</span>
                                </>
                            )}
                        </span>
                    </div>
                </div>
                </div>
                </div>
            </div>
            <GearFront on={gearOn} pile={scene.pile} reg={view.puffRef} />
            <PlayFront fx={fxList} reg={regFx} />
            </div>
        </div>
    );
};

export default HomeKeys;
