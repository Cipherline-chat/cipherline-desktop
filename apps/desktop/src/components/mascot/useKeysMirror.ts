import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';
import { useEasterCostume, claimEggNow } from '../../hooks/useEasterEggs';
import { isMotionActive, onMotionChange } from '../../utils/idleMotion';
import {
    sceneFor, sameScene, gestureFor, Cooldown, homePress, newlyOnline, waveForArrivals, isCoffeeHour,
    PLANE_COOLDOWN_MS, PLANE_FLIGHT_MS, PLANE_STARTLE_AT, STARTLE_MS, WAVE_COOLDOWN_MS,
    CALL_PERK_COOLDOWN_MS, COFFEE_MS, COFFEE_EGG, COFFEE_COOLDOWN_MS,
    type MirrorInputs, type MirrorStatus, type Scene, type PileTier,
} from '../../utils/keysMirror';
import { GestureRunner, PLANE_FRAMES, PUFFS, type Motion, type Puff, type Spec } from '../../utils/keysGestures';
import {
    onKeysBeat, getOwnCallMedia, onOwnCallMedia, keysActivityOn, onKeysActivity, NIGHT_DIVE_EVENT, isNightDiveNow,
    type NightDiveDetail,
} from '../../utils/keysBeats';
import type { KeysFace } from '../../utils/keysBrain';

/**
 * What the Home deck tells Keys about you. Counts and flags only — see
 * utils/keysMirror.ts for the privacy line and the precedence rules.
 */
export interface HomeKeysMirror {
    status: MirrorStatus;
    gaming: boolean;
    inCall: boolean;
    /** Unread messages owed to you (DMs + servers), a number. */
    unread: number;
    pro: boolean;
    /** Friends online right now (ids, compared set-to-set for arrivals). */
    onlineFriends?: ReadonlySet<string>;
    /** How many calls are live in "Happening now". */
    liveCalls?: number;
}

const reducedMotion = () =>
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
const readTransform = (el: Element | null) => {
    if (!el) return 'none';
    try { return getComputedStyle(el).transform || 'none'; } catch { return 'none'; }
};
/** Nobody is looking: the window is hidden, blurred / untouched (the idle
 *  gate) or Settings covers Home. One-shots are skipped then, not queued. */
const unseen = () =>
    typeof document !== 'undefined' && (document.hidden || !isMotionActive()
        || document.documentElement.getAttribute('data-cl-occluded') === 'on');

type PuffKey = Puff | 'plane';

/** How far into the doze / shh his eyes close (the yawn's peak). */
export const EYES_CLOSE_AFTER_MS = 650;

export interface KeysMirrorView {
    scene: Scene;
    /** The face to hold (a startle outranks the scene's own). */
    face: KeysFace | null;
    speaking: boolean;
    /** A rising edge asks the rig to wave (a friend came online). */
    wave: boolean;
    /** The gesture wrapper (.hk-gest). */
    gestRef: (el: HTMLDivElement | null) => void;
    /** The puffs and the plane (GearFront). */
    puffRef: (k: PuffKey) => (el: HTMLElement | null) => void;
    /** Play a click reaction's body gesture on the gesture wrapper, through
     *  the same runner as the scene gestures (so it starts from wherever he
     *  is and a scene change mid-way hands over without a snap). */
    playBody: (spec: Spec) => void;
    /** One of the puffs (the "!", the "shh", the stars, the ping). */
    puff: (k: Puff) => void;
}

/**
 * The live half of the mirror: gathers the inputs HomeKeys cannot get from
 * its host (network, call media, transfers, backups, the night dive, the
 * calendar hat, the morning coffee), turns them into a scene, plays the
 * gesture for each change, and runs the one-shot reactions (paper plane,
 * dizzy, wave, call perk) behind their rate limits.
 *
 * `busy()` is true while the spam egg owns his body: scene gestures wait it
 * out (the scene itself still changes underneath; nothing is lost).
 */
export function useKeysMirror(host: HomeKeysMirror | undefined, busy: () => boolean): KeysMirrorView {
    const connected = useNetworkStatus();
    const costume = useEasterCostume();

    const [media, setMedia] = useState(getOwnCallMedia);
    useEffect(() => onOwnCallMedia(setMedia), []);

    const readActs = () => ({ transfer: keysActivityOn('transfer'), backup: keysActivityOn('backup') });
    const [acts, setActs] = useState(readActs);
    useEffect(() => onKeysActivity(() => setActs(readActs())), []);

    // The night dive (another feature owns the clock and the attribute; with
    // no such feature, no event ever comes and this stays false). 'initial'
    // just reports the state; only 'enter' / 'exit' are transitions, and the
    // scene diff plays them.
    const [night, setNight] = useState(() => isNightDiveNow());
    useEffect(() => {
        const on = (e: Event) => {
            const d = (e as CustomEvent<NightDiveDetail>).detail;
            setNight(typeof d?.active === 'boolean' ? d.active : isNightDiveNow());
        };
        window.addEventListener(NIGHT_DIVE_EVENT, on);
        return () => window.removeEventListener(NIGHT_DIVE_EVENT, on);
    }, []);

    // Morning coffee: 05:00–09:59, first Home visit of the day, for 30 s.
    const [coffee, setCoffee] = useState(false);
    useEffect(() => {
        if (!isCoffeeHour(new Date()) || !claimEggNow(COFFEE_EGG, { cooldownMs: COFFEE_COOLDOWN_MS })) return;
        setCoffee(true);
        const t = setTimeout(() => setCoffee(false), COFFEE_MS);
        return () => clearTimeout(t);
    }, []);

    const status = host?.status ?? 'online';
    const gaming = !!host?.gaming;
    const inCall = !!host?.inCall;
    const unread = host?.unread ?? 0;
    const pro = !!host?.pro;

    const pileRef = useRef<PileTier>(0);
    const sceneRef = useRef<Scene | null>(null);
    const scene = useMemo(() => {
        const inputs: MirrorInputs = {
            status, connected, gaming, inCall,
            speaking: inCall && media.speaking, sharing: inCall && media.sharing, video: inCall && media.video,
            unread, transfer: acts.transfer, backup: acts.backup, night, pro, costume: !!costume, coffee,
        };
        const next = sceneFor(inputs, pileRef.current);
        const prev = sceneRef.current;
        return prev && sameScene(prev, next) ? prev : next;
    }, [status, connected, gaming, inCall, media, unread, acts, night, pro, costume, coffee]);

    // ── the gesture wrapper and the puffs ──────────────────────────────────
    const gestEl = useRef<HTMLDivElement | null>(null);
    const runner = useRef<GestureRunner | null>(null);
    const gestRef = useCallback((el: HTMLDivElement | null) => {
        gestEl.current = el;
        runner.current?.cancel();
        runner.current = el && typeof el.animate === 'function'
            ? new GestureRunner(el, () => readTransform(gestEl.current))
            : null;
    }, []);
    const puffs = useRef<Partial<Record<PuffKey, HTMLElement | null>>>({});
    const puffRef = useCallback((k: PuffKey) => (el: HTMLElement | null) => { puffs.current[k] = el; }, []);
    const anims = useRef(new Set<Animation>());

    const move = useCallback((m: Motion) => {
        if (reducedMotion() || unseen()) return;
        runner.current?.play(m);
    }, []);
    const playBody = useCallback((spec: Spec) => {
        if (reducedMotion() || unseen()) return;
        runner.current?.playSpec(spec);
    }, []);
    const puff = useCallback((k: Puff) => {
        const el = puffs.current[k] as (HTMLElement & { animate?: HTMLElement['animate'] }) | null | undefined;
        if (!el || typeof el.animate !== 'function' || reducedMotion() || unseen()) return;
        const a = el.animate(PUFFS[k].frames, { duration: PUFFS[k].ms, easing: 'linear', fill: 'none' });
        anims.current.add(a);
        a.addEventListener?.('finish', () => anims.current.delete(a));
    }, []);

    // Going to sleep / DND: his eyes stay open through the yawn or the lean-in
    // and close at its end, instead of snapping shut before he has moved.
    // (undefined = no lag; the scene's own face applies.)
    const [lagFace, setLagFace] = useState<KeysFace | null | undefined>(undefined);
    const lagTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(lagTimer.current), []);

    // A scene change: play the gesture between the two (layout effect, so it
    // starts in the same frame as the attributes that move the pose and gear).
    useLayoutEffect(() => {
        const prev = sceneRef.current;
        sceneRef.current = scene;
        pileRef.current = scene.pile;
        if (!prev || prev === scene) return;
        clearTimeout(lagTimer.current);
        setLagFace(undefined);
        const g = gestureFor(prev, scene);
        if (!g || busy() || reducedMotion() || unseen()) return;
        move(g);
        if (g === 'shh') puff('shh');
        if ((g === 'doze' || g === 'shh') && prev.face !== scene.face) {
            setLagFace(prev.face);
            lagTimer.current = setTimeout(() => setLagFace(undefined), EYES_CLOSE_AFTER_MS);
        }
    }, [scene, busy, move, puff]);

    // The window starts resting mid-gesture: freeze, and pick up where it was.
    useEffect(() => onMotionChange(active => {
        if (active) { runner.current?.resume(); anims.current.forEach(a => a.play()); }
        else { runner.current?.pause(); anims.current.forEach(a => a.pause()); }
    }), []);

    useEffect(() => () => {
        runner.current?.cancel();
        anims.current.forEach(a => a.cancel());
        anims.current.clear();
    }, []);

    // ── one-shots ──────────────────────────────────────────────────────────
    const [startled, setStartled] = useState(false);
    const [wave, setWave] = useState(false);
    const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
    const later = useCallback((fn: () => void, ms: number) => { timers.current.push(setTimeout(fn, ms)); }, []);
    useEffect(() => () => timers.current.forEach(clearTimeout), []);

    const planeGate = useRef(new Cooldown(PLANE_COOLDOWN_MS));
    const homeTimes = useRef<number[]>([]);
    const lastDizzy = useRef(-Infinity);
    const sceneNow = useRef(scene);
    useLayoutEffect(() => { sceneNow.current = scene; }, [scene]);

    useEffect(() => onKeysBeat(kind => {
        const now = Date.now();
        if (kind === 'home') {
            const r = homePress(homeTimes.current, now, lastDizzy.current);
            homeTimes.current = r.times;
            if (!r.dizzy) return;
            lastDizzy.current = now;
            if (busy()) return;
            move('dizzy');
            puff('stars');
            return;
        }
        // kind === 'message'. DND means do not disturb: he doesn't jump.
        if (sceneNow.current.pose === 'focus' || unseen()) return;
        if (!planeGate.current.tryFire(now)) return;
        const plane = puffs.current.plane as (HTMLElement & { animate?: HTMLElement['animate'] }) | null | undefined;
        if (reducedMotion()) {
            // A still plane parked beside him for a moment, no flight.
            plane?.classList.add('is-static');
            later(() => plane?.classList.remove('is-static'), 1600);
            return;
        }
        if (plane && typeof plane.animate === 'function') {
            const a = plane.animate(PLANE_FRAMES, { duration: PLANE_FLIGHT_MS, easing: 'linear', fill: 'none' });
            anims.current.add(a);
            a.addEventListener?.('finish', () => anims.current.delete(a));
        }
        later(() => {
            if (busy()) return;
            setStartled(true);
            move('startle');
            puff('bang');
            later(() => setStartled(false), STARTLE_MS);
        }, Math.round(PLANE_FLIGHT_MS * PLANE_STARTLE_AT));
    }), [busy, later, move, puff]);

    // A friend came online: a wave (the rig's own, toward the deck below).
    const mountedAt = useRef(0);
    useEffect(() => { mountedAt.current = Date.now(); }, []);
    const prevOnline = useRef<ReadonlySet<string> | null>(null);
    const waveGate = useRef(new Cooldown(WAVE_COOLDOWN_MS));
    const onlineFriends = host?.onlineFriends;
    useEffect(() => {
        if (!onlineFriends) return;
        const prev = prevOnline.current;
        prevOnline.current = onlineFriends;
        if (!prev) return;
        const arrivals = newlyOnline(prev, onlineFriends).length;
        const now = Date.now();
        if (!waveForArrivals(arrivals, now - mountedAt.current) || unseen() || busy()) return;
        if (sceneNow.current.pose !== 'awake' && sceneNow.current.pose !== 'gaming') return;
        if (!waveGate.current.tryFire(now)) return;
        setWave(true);
        later(() => setWave(false), 3400);
    }, [onlineFriends, busy, later]);

    // A call started somewhere ("Happening now" grew), and it isn't yours.
    const prevCalls = useRef<number | null>(null);
    const callGate = useRef(new Cooldown(CALL_PERK_COOLDOWN_MS));
    const liveCalls = host?.liveCalls;
    useEffect(() => {
        if (liveCalls === undefined) return;
        const prev = prevCalls.current;
        prevCalls.current = liveCalls;
        if (prev === null || liveCalls <= prev || inCall || busy()) return;
        if (sceneNow.current.pose === 'asleep' || sceneNow.current.pose === 'focus') return;
        if (!callGate.current.tryFire(Date.now())) return;
        move('callPerk');
        puff('ping');
    }, [liveCalls, inCall, busy, move, puff]);

    return {
        scene,
        face: startled ? 'wide' : lagFace !== undefined ? lagFace : scene.face,
        speaking: inCall && media.speaking,
        wave,
        gestRef,
        puffRef,
        playBody,
        puff,
    };
}
