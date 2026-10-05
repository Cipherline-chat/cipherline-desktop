import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    INITIAL_BRAIN, onPoke, onWake, onRest, applySignal, shouldArmRest,
    nextBlinkDelay, pokeReaction, BROWS, REST_MS,
    type BrainState, type KeysMood, type KeysSignal, type PokeReaction,
} from '../../utils/keysBrain';
import { useMascotCue } from '../../hooks/useMascotCue';
import { isMotionActive } from '../../utils/idleMotion';
import '../../styles/keys.css';

export type { KeysMood, KeysSignal } from '../../utils/keysBrain';

/**
 * Keys 2.0 — the articulated mascot. Jointed 3-segment limbs with a
 * desynchronized living sway, mood machine (awake/happy/sleepy/asleep via
 * pokes, hover wakes), randomized blink, wave-on-mount, parametric brows,
 * zzz when napping. Ported from the website's 40-keys.js; pure-CSS rig
 * (keys.css) — React only toggles classes and brow path data.
 *
 * Built shareable: zero imports from any host screen. Consumers: the home
 * deck, MascotEmpty (empty states), DepthGauge's gauge footer, OfflineScreen,
 * the in-app checkout, TotpSetupModal, OnboardingChecklist, and the
 * registration wizard — the old per-site SVG copies are gone.
 */

// Wave-on-mount fires once per app session, not once per remount — the same
// pattern as emitMascotCue's session guard.
let wavedThisSession = false;
/** Test/dev escape hatch. */
export function __resetWaveGuard() { wavedThisSession = false; }

export interface KeysProps {
    /** Fixed pixel width. Height follows the 110:92 viewBox ratio. */
    size?: number;
    /** width:100%/height:auto — a container-sized slot scales Keys with zero JS. */
    fluid?: boolean;
    /** App-state channel: 'alert' (mentions — amber + urgent cadence, wakes a
     *  sleeping Keys), 'pulse' (unreads — lively), 'idle'. */
    signal?: KeysSignal;
    /** Controlled speech line (the host owns WHICH line — quip pools live with
     *  the host per the personality doctrine). Hidden while asleep. */
    speech?: string | null;
    /** Clicking/hovering drives the mood machine. Default true. */
    interactive?: boolean;
    /** The excited hello on first mount this session. Default true. */
    waveOnMount?: boolean;
    /** Occasional autonomous micro-behaviors between interactions (a leg
     *  kick every ~14-26s). Host gates this with its ambience switch —
     *  continuous-ish decoration needs the off switch (rule 11). */
    lively?: boolean;
    /** Controlled one-shot celebration: a rising edge plays the arm-wave
     *  immediately, ignoring the once-per-session mount guard. */
    wave?: boolean;
    /** Downcast brows + a single tear, sway dragging at half speed —
     *  OfflineScreen's face. Overrides the mood-driven brows. */
    sad?: boolean;
    /** Overrides the default "Keys, the Cipherline mascot" label. */
    ariaLabel?: string;
    onPoke?: (count: number) => void;
    onMoodChange?: (m: KeysMood) => void;
    className?: string;
}

const reducedMotion = () =>
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const Keys: React.FC<KeysProps> = ({
    size = 96, fluid, signal = 'idle', speech = null,
    interactive = true, waveOnMount = true, lively = false,
    wave: waveProp = false, sad = false,
    ariaLabel = 'Keys, the Cipherline mascot',
    onPoke: onPokeCb, onMoodChange, className,
}) => {
    const [brain, setBrain] = useState<BrainState>(INITIAL_BRAIN);
    const [blink, setBlink] = useState(false);
    const [wave, setWave] = useState(false);
    const [wig, setWig] = useState(0);
    // Which one-shot the current wig plays — escalation ladder, not the same
    // wiggle every time (pokeReaction in keysBrain).
    const [reaction, setReaction] = useState<PokeReaction>('wiggle');
    const restTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const mood = brain.mood;
    useEffect(() => { onMoodChange?.(mood); }, [mood, onMoodChange]);
    useEffect(() => () => { if (restTimer.current) clearTimeout(restTimer.current); }, []);

    // App state outranks the nap: a mention wakes him.
    useEffect(() => {
        setBrain(s => applySignal(s, signal));
    }, [signal]);

    const settle = useCallback((next: BrainState) => {
        setBrain(next);
        if (restTimer.current) clearTimeout(restTimer.current);
        if (shouldArmRest(next)) {
            restTimer.current = setTimeout(() => setBrain(s => onRest(s)), REST_MS);
        }
    }, []);

    const poke = useCallback(() => {
        if (!interactive) return;
        // Side effects OUTSIDE the state updater (StrictMode double-invokes
        // updaters); brainRef is advanced eagerly so rapid pokes never read a
        // stale count.
        const next = onPoke(brainRef.current);
        brainRef.current = next;
        setBrain(next);
        const r = pokeReaction(next.pokes);
        setReaction(r);
        if (r !== 'none') setWig(w => w + 1);
        if (restTimer.current) clearTimeout(restTimer.current);
        if (shouldArmRest(next)) {
            restTimer.current = setTimeout(() => setBrain(s => onRest(s)), REST_MS);
        }
        onPokeCb?.(next.pokes);
    }, [interactive, onPokeCb]);

    // Flail and squish put classes on the SVG (limb kicks / the ink cloud),
    // which REPLACE or overlay the idle rig while set — drop them once the
    // one-shot finishes so the sway resumes and the ink can replay next time.
    useEffect(() => {
        if (reaction !== 'flail' && reaction !== 'squish') return;
        const t = setTimeout(() => setReaction('none'), reaction === 'squish' ? 1500 : 650);
        return () => clearTimeout(t);
    }, [reaction, wig]);

    const hoverWake = useCallback(() => {
        if (!interactive) return;
        settle(onWake(brainRef.current));
    }, [interactive, settle]);
    // Latest-brain ref so hoverWake doesn't need brain in deps (which would
    // re-create the handler every poke).
    const brainRef = useRef(brain);
    useEffect(() => { brainRef.current = brain; }, [brain]);

    // The wave sequence — arm raise, mid-wave blink, settle back. Shared by
    // the once-per-session mount hello (450ms lead-in) and the controlled
    // `wave` prop (immediate — celebrations react to a state change).
    const wavingRef = useRef(false);
    const waveTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
    useEffect(() => () => waveTimers.current.forEach(clearTimeout), []);
    const playWave = useCallback((lead: number) => {
        if (wavingRef.current || reducedMotion()) return;
        wavingRef.current = true;
        const timers = waveTimers.current;
        timers.push(setTimeout(() => {
            setWave(true);
            setBrain(s => (s.mood === 'awake' ? { ...s, mood: 'happy' } : s));
            timers.push(setTimeout(() => {
                setBlink(true);
                timers.push(setTimeout(() => setBlink(false), 150));
            }, 2450));
            timers.push(setTimeout(() => {
                setWave(false);
                wavingRef.current = false;
                setBrain(s => (s.mood === 'happy' ? { mood: 'awake', pokes: s.pokes } : s));
            }, 3300));
        }, lead));
    }, []);

    // Wave once per session — the excited hello. Skipped under reduced motion.
    useEffect(() => {
        if (!waveOnMount || wavedThisSession || reducedMotion()) return;
        wavedThisSession = true;
        playWave(450);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Controlled celebration wave — plays on mount-with-true and on every
    // false→true edge, session guard not consulted.
    useEffect(() => {
        if (waveProp) playWave(0);
    }, [waveProp, playWave]);

    // Randomized blink loop — reduced-motion checked at schedule time so an
    // OS toggle mid-session takes effect at the next beat.
    useEffect(() => {
        let t: ReturnType<typeof setTimeout>;
        let closeT: ReturnType<typeof setTimeout>;
        const loop = () => {
            t = setTimeout(() => {
                // Not while the idle-motion gate is resting (window in the
                // background, or nobody has touched the app): each blink is
                // two React renders of the SVG for an eye nobody is watching.
                if (!reducedMotion() && isMotionActive()) {
                    setBlink(true);
                    closeT = setTimeout(() => setBlink(false), 130);
                }
                loop();
            }, nextBlinkDelay(Math.random()));
        };
        loop();
        return () => { clearTimeout(t); clearTimeout(closeT); };
    }, []);

    // Idle perk loop — an occasional flicker of autonomous life. Randomized
    // 14-26s cadence, skipped while asleep/waving/reduced-motion, and only
    // when the host says lively (its ambience switch).
    const [perk, setPerk] = useState(false);
    useEffect(() => {
        if (!lively) return;
        let t: ReturnType<typeof setTimeout>;
        let clearT: ReturnType<typeof setTimeout>;
        const loop = () => {
            t = setTimeout(() => {
                if (!reducedMotion() && isMotionActive() && brainRef.current.mood !== 'asleep') {
                    setPerk(true);
                    clearT = setTimeout(() => setPerk(false), 750);
                }
                loop();
            }, 14_000 + Math.random() * 12_000);
        };
        loop();
        return () => { clearTimeout(t); clearTimeout(clearT); };
    }, [lively]);

    // App-wide mascot cue (the `cuttlefish` egg, etc.) → wiggle.
    useMascotCue(useCallback(() => { setReaction('wiggle'); setWig(w => w + 1); }, []));

    const asleep = mood === 'asleep';
    const happy = mood === 'happy';
    const closed = asleep || mood === 'sleepy' || blink;

    const browL = sad ? BROWS.sadL : closed ? BROWS.closedL : happy ? BROWS.happyL : BROWS.awakeL;
    const browR = sad ? BROWS.sadR : closed ? BROWS.closedR : happy ? BROWS.happyR : BROWS.awakeR;

    const svgCls = [
        'k2-svg',
        wave ? 'k2-wave' : '',
        reaction === 'flail' ? 'k2-flail' : '',
        perk && !wave ? 'k2-perk' : '',
        sad ? 'k2-sad' : asleep ? 'k2-asleep' : signal === 'alert' ? 'k2-alert' : signal === 'pulse' ? 'k2-pulse' : '',
        className ?? '',
    ].filter(Boolean).join(' ');

    return (
        <span
            style={{ position: 'relative', display: 'inline-flex', width: fluid ? '100%' : undefined, cursor: interactive ? 'pointer' : undefined }}
            onClick={interactive ? poke : undefined}
            onMouseEnter={interactive ? hoverWake : undefined}
            role="img"
            aria-label={ariaLabel}
        >
            {speech && !asleep && <span className="k2-speech">{speech}</span>}
            {/* key={wig} remounts the wrapper so the one-shot wiggle replays —
                same remove/reflow/add trick the other mascots use, minus the
                manual reflow. */}
            <span
                key={wig}
                className={wig && reaction !== 'none' && reaction !== 'flail' ? `k2-${reaction}` : ''}
                style={{ display: 'inline-block', width: fluid ? '100%' : undefined }}
            >
                <svg
                    className={svgCls}
                    width={fluid ? undefined : size}
                    height={fluid ? undefined : size * (92 / 110)}
                    style={fluid ? { width: '100%', height: 'auto', overflow: 'visible', color: signal === 'alert' ? 'var(--cl-glow)' : 'var(--cl-lume)' } : { overflow: 'visible', color: signal === 'alert' ? 'var(--cl-glow)' : 'var(--cl-lume)' }}
                    viewBox="0 0 110 92"
                    fill="none"
                >
                    <g className="k2-tilt">
                        {/* Four 3-segment limbs as single round-capped strokes —
                            joints are perfect circles, seamless at any bend. */}
                        <g fill="none" stroke="currentColor" strokeWidth="13" strokeLinecap="round" strokeLinejoin="round">
                            <g className="k2-leg k2-leg-1"><line x1="29" y1="54" x2="29" y2="63" /><g className="k2-fore k2-fore-1"><line x1="29" y1="63" x2="29" y2="70" /><g className="k2-foot k2-foot-1"><line x1="29" y1="70" x2="29" y2="74" /></g></g></g>
                            <g className="k2-leg k2-leg-2"><line x1="46.3" y1="54" x2="46.3" y2="63" /><g className="k2-fore k2-fore-2"><line x1="46.3" y1="63" x2="46.3" y2="70" /><g className="k2-foot k2-foot-2"><line x1="46.3" y1="70" x2="46.3" y2="74" /></g></g></g>
                            <g className="k2-leg k2-leg-3"><line x1="63.6" y1="54" x2="63.6" y2="63" /><g className="k2-fore k2-fore-3"><line x1="63.6" y1="63" x2="63.6" y2="70" /><g className="k2-foot k2-foot-3"><line x1="63.6" y1="70" x2="63.6" y2="74" /></g></g></g>
                            <g className="k2-leg k2-leg-4"><line x1="80.9" y1="54" x2="80.9" y2="63" /><g className="k2-fore k2-fore-4"><line x1="80.9" y1="63" x2="80.9" y2="70" /><g className="k2-foot k2-foot-4"><line x1="80.9" y1="70" x2="80.9" y2="74" /></g></g></g>
                        </g>
                        {/* The dome — his head. */}
                        <path d="M21 48 A34 34 0 0 1 89 48 L89 53 L21 53 Z" fill="currentColor" />
                        {/* The W-brows — his eyes, the only face he has. */}
                        <g stroke="var(--cl-abyss)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" fill="none">
                            <path className="k2-brow" d={browL} />
                            <path className="k2-brow" d={browR} />
                        </g>
                        {/* A single small tear — understated, not overdone
                            (carried over from OfflineScreen's sad face). */}
                        {sad && <path d="M40 45 q-2 5 0 7.5 q2 -2.5 0 -7.5" fill="var(--cl-lume-hi)" opacity="0.85" />}
                    </g>
                    {reaction === 'squish' && (
                        <g className="k2-ink" fill="#0B0F1E">
                            <circle cx="38" cy="80" r="6" />
                            <circle cx="58" cy="84" r="8" />
                            <circle cx="74" cy="79" r="5" />
                        </g>
                    )}
                    {asleep && (
                        <g className="k2-zzz" fontFamily="var(--cl-font-display)" fontWeight="600" fill="currentColor">
                            <text x="90" y="20" fontSize="13">z</text>
                            <text x="95" y="9" fontSize="17" style={{ animationDelay: '.8s' }}>z</text>
                        </g>
                    )}
                </svg>
            </span>
        </span>
    );
};

export default Keys;
