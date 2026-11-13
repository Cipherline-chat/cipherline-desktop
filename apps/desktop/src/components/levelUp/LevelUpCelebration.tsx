/**
 * LevelUpCelebration — the full-screen level-up moment (WHEN it plays:
 * LevelUpHost; WHETHER and which variant: utils/levelUp.ts).
 *
 * `big` (the first level-up, ~3.3 s): the app dims and blurs into the deep, a
 * plume of light rises from below with a stream of bubbles, Keys glides up out
 * of it, the level medallion (a dive-watch bezel) lights, the old number rolls
 * away and the new one lands with a sonar ring and a burst of sparks, then
 * what the level unlocks and "Continue".
 * `short` (every later level, ~1.6 s): the same scene without Keys's swim and
 * the bubble stream, on a lighter veil.
 * `still` motion (prefers-reduced-motion): the finished frame, faded in.
 *
 * Interaction (same contract as ProWelcome): Esc closes at any time; a click
 * or Enter during the intro fast-forwards to the finished frame, after it any
 * click closes; focus moves in on mount, to "Continue" at rest, is trapped
 * while open and goes back where it was on close. Choreography and why it is
 * compositor-only: styles/level-up.css.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LayoutGrid, Lock, Sparkles } from 'lucide-react';
import cipherlineMark from '../../assets/cipherline-mark.svg';
import { useNotificationPrefsSafe } from '../../contexts/NotificationContext';
import { useEscape } from '../../hooks/useEscape';
import { playSound } from '../../utils/notificationSounds';
import { Keys } from '../mascot/Keys';
import { AvatarDecoration } from '../ProfileCosmetics';
import { decorationLook } from '../../utils/decorationLook';
import {
    LEVEL_UP_EXIT_MS, LEVEL_UP_EXIT_STILL_MS, LEVEL_UP_INTRO_MS,
    joinLabels, levelUpCopy, nextUnlockLevel, unlocksAtLevel, unlocksBetween,
    type LevelUpMotion, type LevelUpVariant, type LevelUnlock,
} from '../../utils/levelUp';
import '../../styles/level-up.css';


/** Deterministic pseudo-random (no Math.random at render). */
const seeded = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

/** The one-shot stream of bubbles that rises with the plume. */
const BUBBLES = (() => {
    const r = seeded(7);
    return Array.from({ length: 26 }, () => ({
        left: `${(32 + r() * 36).toFixed(1)}%`,
        size: Math.round(4 + r() * 10),
        rise: `${Math.round(55 + r() * 40)}vh`,
        sway: `${Math.round((r() - 0.5) * 60)}px`,
        dur: `${(1.3 + r() * 1.1).toFixed(2)}s`,
        del: `${(r() * 1.2).toFixed(2)}s`,
        ring: r() < 0.55,
    }));
})();

/** Slow ambient motes (forever, while the card is up). */
const MOTES = (() => {
    const r = seeded(23);
    return Array.from({ length: 22 }, () => ({
        left: `${(r() * 100).toFixed(1)}%`,
        top: `${(30 + r() * 75).toFixed(1)}%`,
        size: +(1.5 + r() * 2.5).toFixed(1),
        warm: r() < 0.25,
        o: (0.25 + r() * 0.5).toFixed(2),
        dur: `${(7 + r() * 6).toFixed(1)}s`,
        del: `${(r() * 3).toFixed(2)}s`,
    }));
})();

/** Sparks thrown out when the number lands. */
const SPARKS = Array.from({ length: 16 }, (_, i) => ({
    angle: Math.round(i * (360 / 16) + (i % 2 ? 7 : -5)),
    dist: 120 + ((i * 37) % 70),
    warm: i % 4 === 1,
}));

const TICKS = Array.from({ length: 60 }, (_, i) => i);

type Phase = 'intro' | 'rest' | 'closing';
type ProfileThemeLike = { primary: string; accent: string } | null | undefined;

export interface LevelUpCelebrationProps {
    level: number;
    /** The level before (the number that rolls away). */
    from: number;
    variant: LevelUpVariant;
    motion: LevelUpMotion;
    /** From /auth/me profile_level, for the "N more points" line. */
    points?: number | null;
    nextPoints?: number | null;
    /** Your profile theme (/auth/me), so an unlocked decoration previews in your colour. */
    profileTheme?: ProfileThemeLike;
    onClose: () => void;
}

/** The new item as it would look on you right now (your Match-theme colour, its default options). */
const UnlockArt: React.FC<{ u: LevelUnlock; theme: ProfileThemeLike }> = ({ u, theme }) => {
    if (u.kind === 'decoration') {
        return (
            <AvatarDecoration {...decorationLook({ avatar_decoration: u.id, profile_theme: theme ?? null })} className="lvu-chip-av" compact>
                <span className="lvu-chip-face"><img src={cipherlineMark} alt="" draggable={false} /></span>
            </AvatarDecoration>
        );
    }
    return <span className="lvu-chip-ico">{u.kind === 'effect' ? <Sparkles size={18} strokeWidth={2} /> : <LayoutGrid size={18} strokeWidth={2} />}</span>;
};

export const LevelUpCelebration: React.FC<LevelUpCelebrationProps> = ({ level, from, variant, motion, points, nextPoints, profileTheme, onClose }) => {
    const still = motion === 'still';
    const [phase, setPhaseState] = useState<Phase>(still ? 'rest' : 'intro');
    const phaseRef = useRef(phase);
    const setPhase = useCallback((p: Phase) => { phaseRef.current = p; setPhaseState(p); }, []);
    const rootRef = useRef<HTMLDivElement>(null);
    const ctaRef = useRef<HTMLButtonElement>(null);
    const returnFocusTo = useRef<Element | null>(null);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const notifPrefs = useNotificationPrefsSafe();

    const copy = levelUpCopy(level, variant, points, nextPoints);
    const unlocks = useMemo(() => unlocksBetween(from, level), [from, level]);
    const next = useMemo(() => {
        if (unlocks.length > 0) return null;
        const at = nextUnlockLevel(level);
        return at === null ? null : { at, labels: unlocksAtLevel(at).map((u) => u.label) };
    }, [unlocks.length, level]);

    // Once per mount; the mount itself is once per level.
    useEffect(() => { playSound('celebration', notifPrefs?.prefs); },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        []);

    useEffect(() => {
        returnFocusTo.current = document.activeElement;
        rootRef.current?.focus({ preventScroll: true });
        return () => {
            if (closeTimer.current) clearTimeout(closeTimer.current);
            const el = returnFocusTo.current as HTMLElement | null;
            if (el && typeof el.focus === 'function' && el.isConnected) el.focus({ preventScroll: true });
        };
    }, []);

    // The intro ends on a timer, never on animationend (an animation that never
    // ran — a backgrounded window — cannot strand the dialog without its button).
    useEffect(() => {
        if (phase !== 'intro') return;
        const t = setTimeout(() => setPhase('rest'), LEVEL_UP_INTRO_MS[variant]);
        return () => clearTimeout(t);
    }, [phase, setPhase, variant]);

    useEffect(() => {
        if (phase !== 'rest') return;
        const active = document.activeElement;
        if (!active || active === document.body || active === rootRef.current) ctaRef.current?.focus({ preventScroll: true });
    }, [phase]);

    const close = useCallback(() => {
        if (phaseRef.current === 'closing') return;
        setPhase('closing');
        closeTimer.current = setTimeout(onClose, still ? LEVEL_UP_EXIT_STILL_MS : LEVEL_UP_EXIT_MS);
    }, [onClose, still, setPhase]);

    const fastForward = useCallback(() => {
        if (phaseRef.current !== 'intro') return;
        const root = rootRef.current;
        if (root && typeof root.getAnimations === 'function') {
            for (const a of root.getAnimations({ subtree: true })) {
                if (a.effect?.getTiming().iterations !== Infinity) { try { a.finish(); } catch { /* already done */ } }
            }
        }
        setPhase('rest');
    }, [setPhase]);

    // The top of the app's Escape stack while open: nothing underneath also reacts.
    useEscape(() => { close(); });

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            ctaRef.current?.focus({ preventScroll: true }); // the dialog's one control
            return;
        }
        if ((e.key === 'Enter' || e.key === ' ') && e.target === rootRef.current) {
            e.preventDefault();
            if (phaseRef.current === 'intro') fastForward(); else close();
        }
    };

    const onClick = () => {
        if (phaseRef.current === 'intro') fastForward(); else close();
    };

    const overlay = (
        <div
            ref={rootRef}
            className="lvu"
            data-variant={variant}
            data-motion={motion}
            data-phase={phase}
            data-testid="level-up"
            role="dialog"
            aria-modal="true"
            aria-labelledby="lvu-title"
            aria-describedby="lvu-line"
            tabIndex={-1}
            onKeyDown={onKeyDown}
            onClick={onClick}
        >
            <div className="lvu-veil" aria-hidden="true" />
            <div className="lvu-fx" aria-hidden="true">
                <div className="lvu-plume" />
                {variant === 'big' && BUBBLES.map((b, i) => (
                    <i
                        key={`b${i}`}
                        className={b.ring ? 'lvu-bubble lvu-bubble--ring' : 'lvu-bubble'}
                        style={{
                            left: b.left, width: b.size, height: b.size,
                            ['--rise' as string]: b.rise, ['--sway' as string]: b.sway, ['--dur' as string]: b.dur, ['--del' as string]: b.del,
                        }}
                    />
                ))}
                {MOTES.map((m, i) => (
                    <i
                        key={`m${i}`}
                        className={m.warm ? 'lvu-mote lvu-mote--warm' : 'lvu-mote'}
                        style={{ left: m.left, top: m.top, width: m.size, height: m.size, ['--o' as string]: m.o, ['--dur' as string]: m.dur, ['--del' as string]: m.del }}
                    />
                ))}
            </div>

            <div className="lvu-stage">
                <div className="lvu-scene" aria-hidden="true">
                    <div className="lvu-bloom" />
                    <div className="lvu-rays" />
                    <div className="lvu-flash" />
                    <div className="lvu-sonar" />
                    <div className="lvu-sonar lvu-sonar--2" />
                    <div className="lvu-sparks">
                        {SPARKS.map((s, i) => (
                            <i key={i} className={s.warm ? 'lvu-spark lvu-spark--warm' : 'lvu-spark'} style={{ transform: `rotate(${s.angle}deg)`, ['--d' as string]: `${s.dist}px` }}><b /></i>
                        ))}
                    </div>
                    <div className="lvu-medal">
                        <svg className="lvu-bezel" viewBox="0 0 200 200" focusable="false">
                            <defs>
                                <linearGradient id="lvu-ring-g" x1="0" y1="0" x2="1" y2="1">
                                    <stop offset="0" stopColor="#7FF5E4" />
                                    <stop offset=".55" stopColor="#25E0C8" />
                                    <stop offset="1" stopColor="#1497C9" />
                                </linearGradient>
                            </defs>
                            <circle cx="100" cy="100" r="93" className="lvu-bezel-rim" />
                            {TICKS.map((t) => (
                                <line
                                    key={t}
                                    x1="100" y1={t % 5 === 0 ? 11 : 13} x2="100" y2={t % 5 === 0 ? 20 : 17}
                                    className={t % 5 === 0 ? 'lvu-tick lvu-tick--major' : 'lvu-tick'}
                                    transform={`rotate(${t * 6} 100 100)`}
                                />
                            ))}
                            <circle cx="100" cy="100" r="74" className="lvu-bezel-ring" stroke="url(#lvu-ring-g)" />
                            <path d="M100 4 l7 10 h-14 z" className="lvu-pip" />
                        </svg>
                        <div className="lvu-glint" />
                        <div className="lvu-num">
                            {!still && <span className="lvu-num-old">{from}</span>}
                            <span className="lvu-num-new">{level}</span>
                        </div>
                    </div>
                    {variant === 'big' && (
                        <div className="lvu-keys">
                            {/* Still once he arrives (owner 2026-11-12): no wave, no bob, no idle wiggle. */}
                            <Keys size={136} interactive={false} waveOnMount={false} lively={false} idleSway={false} ariaLabel="" />
                        </div>
                    )}
                </div>

                <div className="lvu-eyebrow">{copy.eyebrow}</div>
                <h2 id="lvu-title" className="lvu-title">{copy.title}</h2>
                <p id="lvu-line" className="lvu-line">{copy.line}</p>
                {copy.progress && (
                    <div className="lvu-progress">
                        <span className="lvu-progress-track" aria-hidden="true">
                            <i className="lvu-progress-fill" style={{ ['--f' as string]: Math.max(0.04, Math.min(1, copy.progress.fraction)).toFixed(3) }} />
                        </span>
                        <span className="lvu-progress-label">{copy.progress.label}</span>
                    </div>
                )}

                {unlocks.length > 0 && (
                    <div className="lvu-unlocks">
                        <div className="lvu-unlocks-h">Unlocked</div>
                        <ul className="lvu-chips">
                            {unlocks.map((u, i) => (
                                <li key={`${u.kind}:${u.id}:${i}`} className="lvu-chip" style={{ ['--i' as string]: i }}>
                                    <UnlockArt u={u} theme={profileTheme} />
                                    <span className="lvu-chip-txt"><b>{u.label}</b><small>{u.category}</small></span>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                {next && (
                    <div className="lvu-unlocks">
                        <ul className="lvu-chips">
                            <li className="lvu-chip lvu-chip--next" style={{ ['--i' as string]: 0 }}>
                                <span className="lvu-chip-ico"><Lock size={16} strokeWidth={2.2} /></span>
                                <span className="lvu-chip-txt"><b>Level {next.at} unlocks {joinLabels(next.labels)}</b><small>Everything to unlock is in Settings, Profile</small></span>
                            </li>
                        </ul>
                    </div>
                )}

                <button
                    ref={ctaRef}
                    type="button"
                    className="lvu-cta"
                    data-testid="level-up-continue"
                    tabIndex={phase === 'rest' ? 0 : -1}
                    onClick={(e) => { e.stopPropagation(); close(); }}
                >
                    Continue
                </button>
            </div>
        </div>
    );

    return createPortal(overlay, document.body);
};

export default LevelUpCelebration;
