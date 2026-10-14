/**
 * ProWelcome — the "you're Pro" moment, played once per purchase.
 *
 * WHEN it shows is decided elsewhere (utils/proCelebration.ts, driven by
 * SubscriptionContext): straight after an in-app checkout succeeds, or when
 * this device observes the account go from free to an active paid
 * subscription (hosted-checkout fallback, paid on the website, trial → paid).
 *
 * WHAT it is: a full-screen layer of its own (portaled to <body>, z 2200, so
 * it also covers the in-app checkout it takes over from). A slit of light
 * draws across the dark, a member card with the user's name swings up out of
 * it, a sheen crosses the card, the crown medallion ignites, and the four
 * things that just unlocked rise in below a "Let's go". The choreography and
 * why it is compositor-only live in styles/pro-celebration.css.
 *
 * Interaction:
 *   - Esc or "Skip" closes at any time.
 *   - A click during the intro fast-forwards to the finished frame; a click on
 *     the backdrop after that closes.
 *   - Focus moves into the dialog on mount, to "Let's go" once it appears, is
 *     trapped inside while open, and returns to where it was on close.
 *   - prefers-reduced-motion: the finished frame, faded in, nothing moving.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Crown, Video, MonitorUp, Upload, HardDrive } from 'lucide-react';
import cipherlineMark from '../assets/cipherline-mark.svg';
import { useNotificationPrefsSafe } from '../contexts/NotificationContext';
import { useEscape } from '../hooks/useEscape';
import { playSound } from '../utils/notificationSounds';
import { FREE_UPLOAD_LIMIT_LABEL, PRO_UPLOAD_LIMIT_LABEL } from '../utils/uploadLimitCopy';
import '../styles/pro-celebration.css';

/** When "Let's go" has finished rising (its 2.75 s delay + 0.6 s ease, less the tail). */
export const PRO_WELCOME_INTRO_MS = 2900;
export const PRO_WELCOME_EXIT_MS = 280;
export const PRO_WELCOME_EXIT_REDUCED_MS = 120;

/** What Pro adds over the free tier (mirrors UpgradePromptModal's PERKS and
 *  BillingService.getEntitlements: video/screen-share, the upload cap, the
 *  per-server saved-storage quota). */
const PERKS = [
    { Icon: Video, title: 'HD video', detail: 'Camera on in any call' },
    { Icon: MonitorUp, title: 'Screen share', detail: 'Share your screen live' },
    { Icon: Upload, title: `${PRO_UPLOAD_LIMIT_LABEL} uploads`, detail: `Up from ${FREE_UPLOAD_LIMIT_LABEL}` },
    { Icon: HardDrive, title: 'More storage', detail: 'Grows with your server' },
] as const;

/** Deterministic drifting motes (no Math.random at render). */
const MOTES = (() => {
    let seed = 11;
    const r = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    return Array.from({ length: 24 }, () => {
        const gold = r() < 0.3;
        const size = 2 + r() * 3;
        return {
            left: `${(r() * 100).toFixed(1)}%`,
            top: `${(40 + r() * 70).toFixed(1)}%`,
            size,
            gold,
            o: (0.25 + r() * 0.5).toFixed(2),
            dur: `${(7 + r() * 6).toFixed(1)}s`,
            del: `${(0.6 + r() * 2).toFixed(2)}s`,
        };
    });
})();

const SHAFTS = [
    { left: '16%', width: '10%', skew: 6 },
    { left: '40%', width: '15%', skew: -4 },
    { left: '68%', width: '11%', skew: 5 },
] as const;

const MAX_TILT_DEG = 7;

function prefersReducedMotion(): boolean {
    try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/** "OCT 2026" — the month the membership started (this moment). */
function memberSince(now: Date): string {
    return now.toLocaleString('en-US', { month: 'short', year: 'numeric' }).toUpperCase();
}

/** Card text that prints on one character at a time, like an embosser, as the
 *  card settles. The whole run is capped at ~0.5 s however long the name is. */
const Printed: React.FC<{ text: string; start: number }> = ({ text, start }) => {
    const chars = Array.from(text);
    const step = Math.min(0.045, 0.5 / Math.max(1, chars.length));
    return (
        <>
            {chars.map((c, i) => (
                <span key={i} className="pcel-ch" style={{ animationDelay: `${(start + i * step).toFixed(3)}s` }}>{c}</span>
            ))}
        </>
    );
};

type Phase = 'intro' | 'rest' | 'closing';

export interface ProWelcomeProps {
    onClose: () => void;
    /** The account's username, printed on the card. Optional: a pending
     *  username (empty string) falls back to a nameless greeting. */
    name?: string | null;
}

export const ProWelcome: React.FC<ProWelcomeProps> = ({ onClose, name }) => {
    const [reduced] = useState(prefersReducedMotion);
    const [phase, setPhaseState] = useState<Phase>(reduced ? 'rest' : 'intro');
    /** Mirrors `phase` for the event handlers; written only alongside it. */
    const phaseRef = useRef(phase);
    const setPhase = useCallback((p: Phase) => { phaseRef.current = p; setPhaseState(p); }, []);
    const rootRef = useRef<HTMLDivElement>(null);
    const ctaRef = useRef<HTMLButtonElement>(null);
    const tiltRef = useRef<HTMLDivElement>(null);
    const returnFocusTo = useRef<Element | null>(null);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const since = useMemo(() => memberSince(new Date()), []);
    const notifPrefs = useNotificationPrefsSafe();
    const trimmed = (name ?? '').trim();

    // Once per mount; the mount itself is once per purchase.
    useEffect(() => { playSound('celebration', notifPrefs?.prefs); },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        []);

    // Focus: into the dialog now, back to wherever it was on unmount.
    useEffect(() => {
        returnFocusTo.current = document.activeElement;
        rootRef.current?.focus({ preventScroll: true });
        return () => {
            if (closeTimer.current) clearTimeout(closeTimer.current);
            const el = returnFocusTo.current as HTMLElement | null;
            if (el && typeof el.focus === 'function' && el.isConnected) el.focus({ preventScroll: true });
        };
    }, []);

    // The intro ends on a timer, not on animationend: a timer cannot be lost
    // to an animation that never ran (reduced motion, a backgrounded window).
    useEffect(() => {
        if (phase !== 'intro') return;
        const t = setTimeout(() => setPhase('rest'), PRO_WELCOME_INTRO_MS);
        return () => clearTimeout(t);
    }, [phase, setPhase]);

    // At rest, hand focus to "Let's go" unless the user already put it somewhere.
    useEffect(() => {
        if (phase !== 'rest') return;
        const active = document.activeElement;
        if (!active || active === document.body || active === rootRef.current) {
            ctaRef.current?.focus({ preventScroll: true });
        }
    }, [phase]);

    const close = useCallback(() => {
        if (phaseRef.current === 'closing') return;
        setPhase('closing');
        closeTimer.current = setTimeout(onClose, reduced ? PRO_WELCOME_EXIT_REDUCED_MS : PRO_WELCOME_EXIT_MS);
    }, [onClose, reduced, setPhase]);

    /** Jump every one-shot animation to its end and settle at rest. */
    const fastForward = useCallback(() => {
        if (phaseRef.current !== 'intro') return;
        const root = rootRef.current;
        if (root && typeof root.getAnimations === 'function') {
            for (const a of root.getAnimations({ subtree: true })) {
                const iterations = a.effect?.getTiming().iterations;
                if (iterations !== Infinity) { try { a.finish(); } catch { /* already done */ } }
            }
        }
        setPhase('rest');
    }, [setPhase]);

    // Esc closes from anywhere. Registered on the app's Escape stack, so this
    // top-most layer takes the press and nothing underneath (an open settings
    // pane, the checkout it covers) also reacts to it.
    useEscape(() => { close(); });

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Tab') {
            // Trap: cycle through the dialog's own buttons only.
            const items = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('button:not([tabindex="-1"])') ?? []);
            if (items.length === 0) { e.preventDefault(); return; }
            const i = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === -1 || i === items.length - 1 ? 0 : i + 1);
            e.preventDefault();
            items[next].focus();
            return;
        }
        if ((e.key === 'Enter' || e.key === ' ') && e.target === rootRef.current) {
            e.preventDefault();
            if (phaseRef.current === 'intro') fastForward(); else close();
        }
    };

    const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (phaseRef.current === 'intro') { fastForward(); return; }
        // At rest only a click on the open backdrop closes; the card and the
        // copy are things people click while reading.
        const t = e.target as HTMLElement;
        if (!t.closest('.pcel-scene, .pcel-title, .pcel-sub, .pcel-perks, button')) close();
    };

    // Pointer tilt, at rest only, one style write per frame.
    const tiltFrame = useRef<number | null>(null);
    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (reduced || phaseRef.current !== 'rest' || !tiltRef.current) return;
        const { clientX, clientY } = e;
        if (tiltFrame.current !== null) return;
        tiltFrame.current = requestAnimationFrame(() => {
            tiltFrame.current = null;
            const el = tiltRef.current;
            if (!el) return;
            const r = el.getBoundingClientRect();
            const dx = Math.max(-1, Math.min(1, (clientX - (r.left + r.width / 2)) / (window.innerWidth / 2)));
            const dy = Math.max(-1, Math.min(1, (clientY - (r.top + r.height / 2)) / (window.innerHeight / 2)));
            el.style.setProperty('--pcel-ry', `${(dx * MAX_TILT_DEG).toFixed(2)}deg`);
            el.style.setProperty('--pcel-rx', `${(-dy * MAX_TILT_DEG).toFixed(2)}deg`);
        });
    };
    useEffect(() => () => { if (tiltFrame.current !== null) cancelAnimationFrame(tiltFrame.current); }, []);

    const overlay = (
        <div
            ref={rootRef}
            className="pcel"
            data-phase={phase}
            data-reduced={reduced ? '' : undefined}
            role="dialog"
            aria-modal="true"
            aria-labelledby="pcel-title"
            aria-describedby="pcel-sub pcel-perks"
            tabIndex={-1}
            onKeyDown={onKeyDown}
            onClick={onClick}
            onPointerMove={onPointerMove}
        >
            <div className="pcel-veil" aria-hidden="true" />
            <div className="pcel-fx" aria-hidden="true">
                {SHAFTS.map((s, i) => (
                    <i key={i} className="pcel-shaft" style={{ left: s.left, width: s.width, transform: `skewX(${s.skew}deg)` }} />
                ))}
                {MOTES.map((m, i) => (
                    <i
                        key={i}
                        className="pcel-mote"
                        style={{
                            left: m.left, top: m.top, width: m.size, height: m.size,
                            background: m.gold ? 'var(--pcel-mote-b)' : 'var(--pcel-mote-a)',
                            boxShadow: `0 0 ${m.size * 3}px ${m.gold ? 'var(--pcel-mote-b)' : 'var(--pcel-mote-a)'}`,
                            ['--o' as string]: m.o, ['--dur' as string]: m.dur, ['--del' as string]: m.del,
                        }}
                    />
                ))}
            </div>

            {phase === 'intro' && (
                <button type="button" className="pcel-skip" onClick={(e) => { e.stopPropagation(); close(); }}>
                    Skip
                </button>
            )}

            <div className="pcel-stage">
                <div className="pcel-scene" aria-hidden="true">
                    <div className="pcel-bloom" />
                    <div className="pcel-under" />
                    <div className="pcel-slit" />
                    <div className="pcel-tilt" ref={tiltRef}>
                        <div className="pcel-card">
                            <div className="pcel-sonar" />
                            <div className="pcel-card-in">
                                <div className="pcel-card-top">
                                    <div className="pcel-brand">
                                        <img src={cipherlineMark} alt="" draggable={false} />
                                        Cipherline
                                    </div>
                                    <div className="pcel-medal">
                                        <i className="pcel-medal-ring" />
                                        <i className="pcel-medal-ring" />
                                        <Crown strokeWidth={1.4} fill="currentColor" />
                                    </div>
                                </div>
                                <div className="pcel-card-word">Pro</div>
                                <div className="pcel-card-bot">
                                    <div><small>Member</small><b data-testid="pcel-member"><Printed text={trimmed || 'You'} start={0.95} /></b></div>
                                    <div><small>Since</small><b><Printed text={since} start={1.2} /></b></div>
                                </div>
                            </div>
                            <div className="pcel-sheen" />
                        </div>
                    </div>
                </div>

                <h2 id="pcel-title" className="pcel-title">
                    Welcome to <em>Pro</em>{trimmed ? `, ${trimmed}` : ''}.
                </h2>
                <p id="pcel-sub" className="pcel-sub">Everything below just switched on.</p>

                <ul id="pcel-perks" className="pcel-perks">
                    {PERKS.map(({ Icon, title, detail }, i) => (
                        <li key={title} className="pcel-perk" style={{ ['--i' as string]: i }}>
                            <Icon size={22} strokeWidth={2} aria-hidden="true" />
                            <div className="pcel-perk-t">{title}</div>
                            <div className="pcel-perk-s">{detail}</div>
                        </li>
                    ))}
                </ul>

                <button
                    ref={ctaRef}
                    type="button"
                    className="pcel-cta"
                    // Not reachable by Tab while it is still invisible.
                    tabIndex={phase === 'rest' ? 0 : -1}
                    onClick={(e) => { e.stopPropagation(); close(); }}
                >
                    Let’s go
                </button>
            </div>
        </div>
    );

    return createPortal(overlay, document.body);
};

export default ProWelcome;
