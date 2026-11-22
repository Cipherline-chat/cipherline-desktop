/**
 * The Gift Pro box: a Lume present with a Glow ribbon and, inside, the Pro
 * crown. Pure vector (inline SVG) and pure CSS motion (styles/gifts.css), so
 * it costs no assets and the harness can seek every frame.
 *
 *   idle        wrapped; a light sweep across it and a tiny wiggle, each about
 *               every 6 s and never at the same time (the unopened chat card)
 *   closed      wrapped and still (the buyer's "waiting" card)
 *   unwrapping  ~1.3 s: squash, bow + ribbon fall away, lid pops up and off,
 *               the crown rises out on a soft Lume glow, a few sparks
 *   open        the crown above the open box, glow breathing slowly
 *   tying       ~1.1 s: box pops in, lid drops on, ribbon draws down, bow
 *               springs, and (with `burst`) confetti flies out (purchase success)
 *   muted       wrapped, greyed (refunded / unavailable / error)
 *
 * Reduced motion: `tying` collapses to its end pose (closed) and every other
 * animation is removed, EXCEPT the unwrap: it becomes a ~0.9 s cross-fade from
 * the wrapped box to the open one (data-motion="fade": opacity only, no squash,
 * fall, rise, rotate or sparks), so the recipient still sees the box open
 * before anything that follows it (owner 2026-11-18).
 *
 * `onUnwrapped` fires when the unwrap's LAST keyframe ends (UNWRAP_END_KEYFRAME
 * / UNWRAP_FADE_END_KEYFRAME: the real animationend, not a guessed timer). The
 * host keeps its own safety fallback for an animation that never runs.
 * Decorative only: the host card carries the words.
 */
import React, { useEffect, useId, useMemo, useRef } from 'react';
import { useCelebrationReduced } from '../../../utils/a11y/motionPrefs';
import { confettiPieces } from './giftConfetti';
import '../../../styles/gifts.css';

export type GiftBoxState = 'idle' | 'closed' | 'unwrapping' | 'open' | 'tying' | 'muted';

/** Full unwrap length (gifts.css: the halo, the last to end, runs 440 + 860 ms; sparks 800 + 500). */
export const UNWRAP_MS = 1300;
/** The keyframe whose end IS the end of the full unwrap (single element: .gb-halo). */
export const UNWRAP_END_KEYFRAME = 'gb-halo-in';
/** Reduced-motion unwrap: the opacity-only cross-fade (gifts.css gb-xfade-*). */
export const UNWRAP_FADE_MS = 900;
export const UNWRAP_FADE_END_KEYFRAME = 'gb-xfade-in';

export interface GiftBoxProps {
    state: GiftBoxState;
    /** Rendered square size in px. */
    size?: number;
    /** With `tying`: the confetti burst. */
    burst?: boolean;
    className?: string;
    /** With `unwrapping`: called once when the unwrap's final keyframe has ended. */
    onUnwrapped?: () => void;
}

/** Spark directions for the unwrap (px, in the 120-unit art space). */
const SPARKS: Array<[number, number]> = [
    [0, -34], [24, -24], [34, 0], [24, 22], [-24, 22], [-34, 0], [-24, -24], [12, -36],
];

const STAR = 'M0 -5 C0.6 -1.2 1.2 -0.6 5 0 C1.2 0.6 0.6 1.2 0 5 C-0.6 1.2 -1.2 0.6 -5 0 C-1.2 -0.6 -0.6 -1.2 0 -5 Z';

export const GiftBox: React.FC<GiftBoxProps> = ({ state, size = 96, burst = false, className, onUnwrapped }) => {
    const reduced = useCelebrationReduced();
    const raw = useId();
    const uid = useMemo(() => `gb${raw.replace(/[^a-zA-Z0-9]/g, '')}`, [raw]);
    const shown: GiftBoxState = reduced && state === 'tying' ? 'closed' : state;
    const motion = !reduced ? 'full' : shown === 'unwrapping' ? 'fade' : 'still';
    const rootRef = useRef<HTMLDivElement>(null);
    const onUnwrappedRef = useRef(onUnwrapped);
    useEffect(() => { onUnwrappedRef.current = onUnwrapped; }, [onUnwrapped]);
    // A native listener (animationend bubbles up from the SVG parts): the end of
    // the unwrap is whichever final keyframe this motion mode plays.
    useEffect(() => {
        const el = rootRef.current;
        if (!el || shown !== 'unwrapping') return;
        const last = motion === 'fade' ? UNWRAP_FADE_END_KEYFRAME : UNWRAP_END_KEYFRAME;
        let done = false;
        const onEnd = (e: Event) => {
            if (done || (e as AnimationEvent).animationName !== last) return;
            done = true;
            onUnwrappedRef.current?.();
        };
        el.addEventListener('animationend', onEnd);
        return () => el.removeEventListener('animationend', onEnd);
    }, [shown, motion]);
    const pieces = useMemo(() => (burst && !reduced ? confettiPieces(18, 7, Math.round(size * 0.95)) : []), [burst, reduced, size]);
    const id = (n: string) => `${uid}-${n}`;
    const url = (n: string) => `url(#${id(n)})`;

    return (
        <div
            ref={rootRef}
            className={['gb', className ?? ''].filter(Boolean).join(' ')}
            data-state={shown}
            data-motion={motion}
            style={{ width: size, height: size }}
            aria-hidden="true"
        >
            <svg viewBox="0 0 120 120" width={size} height={size} focusable="false">
                <defs>
                    <linearGradient id={id('body')} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stopColor="#3BEAD6" />
                        <stop offset="1" stopColor="#0E8F7C" />
                    </linearGradient>
                    <linearGradient id={id('lid')} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stopColor="#6AF5E5" />
                        <stop offset="1" stopColor="#19C3AB" />
                    </linearGradient>
                    <linearGradient id={id('rib')} x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0" stopColor="#E8A93A" />
                        <stop offset="0.45" stopColor="#FFD978" />
                        <stop offset="1" stopColor="#F0B444" />
                    </linearGradient>
                    <linearGradient id={id('crown')} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stopColor="#FFEBB0" />
                        <stop offset="0.55" stopColor="#FFC94D" />
                        <stop offset="1" stopColor="#E09A2B" />
                    </linearGradient>
                    <radialGradient id={id('halo')} cx="0.5" cy="0.5" r="0.5">
                        <stop offset="0" stopColor="rgb(37,224,200)" stopOpacity="0.7" />
                        <stop offset="0.45" stopColor="rgb(37,224,200)" stopOpacity="0.22" />
                        <stop offset="1" stopColor="rgb(37,224,200)" stopOpacity="0" />
                    </radialGradient>
                    <linearGradient id={id('shine')} x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0" stopColor="#fff" stopOpacity="0" />
                        <stop offset="0.5" stopColor="#fff" stopOpacity="0.55" />
                        <stop offset="1" stopColor="#fff" stopOpacity="0" />
                    </linearGradient>
                    <clipPath id={id('clip')}>
                        <rect x="24" y="62" width="72" height="46" rx="7" />
                        <rect x="18" y="48" width="84" height="16" rx="5" />
                    </clipPath>
                </defs>

                <g className="gb-rig">
                    <ellipse className="gb-shadow" cx="60" cy="111" rx="36" ry="4.5" fill="rgba(0,0,0,.38)" />

                    <g className="gb-halo"><circle cx="60" cy="44" r="46" fill={url('halo')} /></g>

                    <g className="gb-crown">
                        <path d="M38 57 L34.5 32.5 L48.5 44 L60 26.5 L71.5 44 L85.5 32.5 L82 57 Z" fill={url('crown')} stroke="#C98A1E" strokeWidth="1.2" strokeLinejoin="round" />
                        <path d="M41.5 50 L39.6 37.5 L46.5 43.2 Z" fill="rgba(255,255,255,.45)" />
                        <rect x="36.5" y="51.5" width="47" height="7.5" rx="2.6" fill="#E8A93A" stroke="#C98A1E" strokeWidth="1" />
                        <circle cx="60" cy="55.25" r="2.7" fill="#25E0C8" />
                        <circle cx="47" cy="55.25" r="1.7" fill="#FFF6DA" />
                        <circle cx="73" cy="55.25" r="1.7" fill="#FFF6DA" />
                        <circle cx="34.5" cy="32.5" r="2.7" fill="#FFEBB0" />
                        <circle cx="60" cy="26.5" r="3.1" fill="#FFEBB0" />
                        <circle cx="85.5" cy="32.5" r="2.7" fill="#FFEBB0" />
                    </g>

                    <g className="gb-body">
                        <rect x="24" y="62" width="72" height="46" rx="7" fill={url('body')} />
                        <rect x="28" y="66" width="3" height="34" rx="1.5" fill="rgba(255,255,255,.22)" />
                        <rect className="gb-inside" x="24" y="62" width="72" height="9" rx="4" fill="#073F37" />
                    </g>
                    <rect className="gb-ribbon-v" x="54" y="62" width="12" height="46" fill={url('rib')} />

                    <g className="gb-lid">
                        <rect x="18" y="48" width="84" height="16" rx="5" fill={url('lid')} />
                        <rect x="18" y="60" width="84" height="4" rx="2" fill="rgba(0,0,0,.14)" />
                        <rect x="23" y="50.5" width="28" height="2.4" rx="1.2" fill="rgba(255,255,255,.45)" />
                        <rect x="54" y="48" width="12" height="16" fill={url('rib')} />
                    </g>

                    <g className="gb-loop gb-loop-l">
                        <path d="M60 46 C52 29 33.5 27.5 35.5 40 C36.8 47.5 50 48.5 60 46 Z" fill={url('rib')} stroke="#C98A1E" strokeWidth="1" strokeLinejoin="round" />
                        <path d="M57.5 45 C51.5 36 42.5 34.5 42 40 C42.4 43.6 50.5 45.6 57.5 45 Z" fill="#C98A1E" opacity="0.5" />
                    </g>
                    <g className="gb-loop gb-loop-r">
                        <path d="M60 46 C68 29 86.5 27.5 84.5 40 C83.2 47.5 70 48.5 60 46 Z" fill={url('rib')} stroke="#C98A1E" strokeWidth="1" strokeLinejoin="round" />
                        <path d="M62.5 45 C68.5 36 77.5 34.5 78 40 C77.6 43.6 69.5 45.6 62.5 45 Z" fill="#C98A1E" opacity="0.5" />
                    </g>
                    <g className="gb-knot"><rect x="54" y="40.5" width="12" height="10" rx="3.8" fill={url('rib')} stroke="#C98A1E" strokeWidth="1" /></g>

                    <g clipPath={url('clip')}>
                        <rect className="gb-shine" x="-34" y="36" width="20" height="84" fill={url('shine')} transform="skewX(-18)" />
                    </g>

                    <g className="gb-sparks">
                        {SPARKS.map(([sx, sy], i) => (
                            <circle
                                key={i} cx="60" cy="42" r={i % 2 ? 1.6 : 2.2}
                                fill={i % 3 === 0 ? '#FFEBB0' : '#25E0C8'}
                                style={{ ['--sx' as string]: `${sx}px`, ['--sy' as string]: `${sy}px` } as React.CSSProperties}
                            />
                        ))}
                    </g>

                    <g className="gb-stars">
                        <g transform="translate(14 34)"><path className="gb-star gb-star-1" d={STAR} fill="#FFEBB0" /></g>
                        <g transform="translate(104 28)"><path className="gb-star gb-star-2" d={STAR} fill="#7FF2E4" /></g>
                        <g transform="translate(106 86) scale(.75)"><path className="gb-star gb-star-3" d={STAR} fill="#FFEBB0" /></g>
                    </g>
                </g>
            </svg>
            {pieces.length > 0 && (
                <div className="gb-burst">
                    {pieces.map((p, i) => (
                        <i
                            key={i}
                            className={`gb-c gb-c--${p.shape}`}
                            style={{
                                ['--c' as string]: p.color,
                                ['--dx' as string]: `${p.dx}px`,
                                ['--dy' as string]: `${p.dy}px`,
                                ['--fall' as string]: `${p.fall}px`,
                                ['--rot' as string]: `${p.rot}deg`,
                                ['--d' as string]: `${p.delay}ms`,
                                ['--s' as string]: String(p.scale),
                            } as React.CSSProperties}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};

export default GiftBox;
