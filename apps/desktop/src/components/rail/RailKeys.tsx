import React, { useCallback, useEffect, useRef } from 'react';
import cipherlineMark from '../../assets/cipherline-mark.svg';
import { useMascotCue } from '../../hooks/useMascotCue';
import { railClick, RAIL_EGG_START, type RailEggState, type RailMove } from '../../utils/railKeysEgg';

/**
 * The brand mark at the top of the left server rail: Keys himself, and the
 * Home button. A click ALWAYS goes Home first (this component never swallows,
 * delays or re-targets it, and it neither calls preventDefault nor sets a drag
 * handle: the button stays `no-drag`).
 *
 * Spam him and he plays (utils/railKeysEgg.ts is the rule): wiggle, hop, spin,
 * squash, jelly swim, then a dizzy finale with sparkles; then he rests for a
 * few seconds. Animations only: no speech bubble, no text, no sound (the egg
 * that was here before had none either).
 *
 * Cost and containment:
 *   - Web Animations on the mark's <img> (transform / opacity: compositor), one
 *     at a time (a new rung cancels the last), started from the click handler;
 *     nothing runs between clicks.
 *   - The finale adds six tiny sparkle <svg>s, removed when they finish. The
 *     rung ladder is 3-6 clicks apart and the finale is followed by a 3.2 s
 *     rest, so click RATE cannot raise the animation count.
 *   - Everything he does stays within ~12 px above and ~26 px either side of
 *     the mark: inside the rail's own 16 px padding and its 72 px width, and
 *     the mark's LAYOUT box is the same 30 x 24 it always was (the extra size
 *     is negative margin), so nothing below him moves.
 *   - prefers-reduced-motion (read at click time): no movement at all, just a
 *     brief opacity pulse on the rungs and a longer, softer one on the finale.
 */

const MARK_W = 38;
const MARK_H = 30;
/** The layout box stays the original 30 x 24: the difference is margin. */
const GROW_X = (MARK_W - 30) / 2;
const GROW_Y = (MARK_H - 24) / 2;

const SPRING = 'cubic-bezier(.34,1.56,.64,1)';
const motionOk = () => !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Keyframes + timing for each rung. Origin is at his feet (set on the img). */
const MOVES: Record<RailMove, { frames: Keyframe[]; ms: number; easing: string }> = {
    wiggle: {
        ms: 620, easing: SPRING, frames: [
            { transform: 'rotate(0)' }, { transform: 'rotate(-10deg)' }, { transform: 'rotate(8deg)' },
            { transform: 'rotate(-3deg)' }, { transform: 'rotate(0)' },
        ],
    },
    hop: {
        ms: 600, easing: 'ease-out', frames: [
            { transform: 'translateY(0) scale(1, 1)' },
            { transform: 'translateY(1px) scale(1.1, .86)', offset: 0.18 },
            { transform: 'translateY(-9px) scale(.93, 1.1)', offset: 0.5 },
            { transform: 'translateY(0) scale(1.08, .9)', offset: 0.78 },
            { transform: 'translateY(0) scale(1, 1)' },
        ],
    },
    spin: {
        ms: 820, easing: SPRING, frames: [{ transform: 'rotate(0)' }, { transform: 'rotate(372deg)', offset: 0.72 }, { transform: 'rotate(360deg)' }],
    },
    squash: {
        ms: 900, easing: SPRING, frames: [
            { transform: 'scale(1, 1)' }, { transform: 'scale(1.3, .55)', offset: 0.2 }, { transform: 'scale(1.24, .6)', offset: 0.42 },
            { transform: 'scale(.92, 1.14)', offset: 0.65 }, { transform: 'scale(1.05, .96)', offset: 0.82 }, { transform: 'scale(1, 1)' },
        ],
    },
    jelly: {
        ms: 1100, easing: 'ease-in-out', frames: [
            { transform: 'translateY(0) scale(1, 1)' },
            { transform: 'translateY(1px) scale(1.07, .92)', offset: 0.1 }, { transform: 'translateY(-6px) scale(.93, 1.08)', offset: 0.22 },
            { transform: 'translateY(0) scale(1, 1)', offset: 0.42 },
            { transform: 'translateY(1px) scale(1.07, .92)', offset: 0.5 }, { transform: 'translateY(-7px) scale(.92, 1.1)', offset: 0.62 },
            { transform: 'translateY(0) scale(1, 1)', offset: 0.82 },
            { transform: 'translateY(-3px) scale(.97, 1.04)', offset: 0.92 }, { transform: 'translateY(0) scale(1, 1)' },
        ],
    },
    // Dizzy: a drunken wobble that settles, with a slow sag. Sparkles ride on top.
    dizzy: {
        ms: 2000, easing: 'ease-in-out', frames: [
            { transform: 'rotate(0) translateX(0)' },
            { transform: 'rotate(-16deg) translateX(-3px)', offset: 0.12 }, { transform: 'rotate(14deg) translateX(3px)', offset: 0.28 },
            { transform: 'rotate(-11deg) translateX(-2px)', offset: 0.44 }, { transform: 'rotate(8deg) translateX(2px)', offset: 0.6 },
            { transform: 'rotate(-4deg) translateX(-1px)', offset: 0.78 }, { transform: 'rotate(2deg)', offset: 0.9 },
            { transform: 'rotate(0) translateX(0)' },
        ],
    },
};

/** What reduced motion gets instead of movement: a calm opacity pulse. */
const STATIC_PULSE: Record<'rung' | 'finale', { frames: Keyframe[]; ms: number }> = {
    rung: { ms: 260, frames: [{ opacity: 1 }, { opacity: 0.55 }, { opacity: 1 }] },
    finale: { ms: 900, frames: [{ opacity: 1 }, { opacity: 0.5, offset: 0.25 }, { opacity: 1, offset: 0.5 }, { opacity: 0.5, offset: 0.75 }, { opacity: 1 }] },
};

const SPARKLE_PATH = 'M5 0 L6.2 3.8 L10 5 L6.2 6.2 L5 10 L3.8 6.2 L0 5 L3.8 3.8 Z';
const SPARKLES = [
    { x: -22, y: -12, d: 0, c: 'var(--cl-glow)' }, { x: 21, y: -14, d: 120, c: 'var(--cl-lume)' },
    { x: -12, y: -18, d: 240, c: 'var(--cl-lume)' }, { x: 12, y: -19, d: 360, c: 'var(--cl-glow)' },
    { x: -26, y: -2, d: 480, c: 'var(--cl-glow)' }, { x: 25, y: -4, d: 600, c: 'var(--cl-lume)' },
];

export const RailKeys: React.FC<{ onClick: () => void }> = ({ onClick }) => {
    const markRef = useRef<HTMLImageElement>(null);
    const sparkRef = useRef<HTMLSpanElement>(null);
    const stateRef = useRef<RailEggState>(RAIL_EGG_START);
    const runningRef = useRef<Animation | null>(null);

    const play = useCallback((move: RailMove) => {
        const el = markRef.current;
        if (!el || typeof el.animate !== 'function') return;
        const rung = move === 'dizzy' ? 'finale' : 'rung';
        // One at a time: the new rung takes over from wherever the last was.
        runningRef.current?.cancel();
        if (!motionOk()) {
            const p = STATIC_PULSE[rung];
            runningRef.current = el.animate(p.frames, { duration: p.ms, easing: 'ease-in-out' });
            return;
        }
        const m = MOVES[move];
        runningRef.current = el.animate(m.frames, { duration: m.ms, easing: m.easing });
        if (move !== 'dizzy') return;
        const host = sparkRef.current;
        if (!host) return;
        for (const s of SPARKLES) {
            const star = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            star.setAttribute('viewBox', '0 0 10 10');
            star.setAttribute('width', '9');
            star.setAttribute('height', '9');
            star.setAttribute('aria-hidden', 'true');
            star.style.cssText = `position:absolute;left:50%;top:42%;margin:-4.5px 0 0 -4.5px;opacity:0;pointer-events:none;color:${s.c}`;
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', SPARKLE_PATH);
            path.setAttribute('fill', 'currentColor');
            star.appendChild(path);
            host.appendChild(star);
            const a = star.animate([
                { transform: 'translate(0, 0) scale(0) rotate(0)', opacity: 0 },
                { transform: `translate(${s.x * 0.7}px, ${s.y * 0.7}px) scale(1.2) rotate(70deg)`, opacity: 1, offset: 0.35 },
                { transform: `translate(${s.x}px, ${s.y}px) scale(0) rotate(160deg)`, opacity: 0 },
            ], { duration: 1000, delay: s.d, easing: 'ease-out', fill: 'both' });
            a.onfinish = a.oncancel = () => star.remove();
        }
    }, []);

    // The `cl:cuttlefish` cue (searching the mascot by name): a wiggle. This
    // mark is always mounted and never covered by the modal that emits it.
    useMascotCue(useCallback(() => play('wiggle'), [play]));

    useEffect(() => () => {
        runningRef.current?.cancel();
        sparkRef.current?.replaceChildren();
    }, []);

    const handleClick = () => {
        onClick(); // Home first, always.
        const r = railClick(stateRef.current, performance.now());
        stateRef.current = r.state;
        if (r.move) play(r.move);
    };

    return (
        <button
            onClick={handleClick}
            title="cipherline"
            className="no-drag"
            data-ob-anchor="rail-logo"
            style={{ position: 'relative', border: 'none', background: 'none', cursor: 'pointer', padding: 0, display: 'flex', flex: 'none', transition: 'transform .35s var(--cl-spring)' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.transform = 'translateY(0)'; }}
        >
            <img
                ref={markRef}
                src={cipherlineMark}
                alt="cipherline"
                width={MARK_W}
                height={MARK_H}
                draggable={false}
                style={{ margin: `-${GROW_Y}px -${GROW_X}px`, transformOrigin: '50% 90%', maxWidth: 'none', width: MARK_W, height: MARK_H }}
            />
            {/* Sparkles (the finale's, created and removed imperatively). */}
            <span ref={sparkRef} aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'visible' }} />
        </button>
    );
};

export default RailKeys;
