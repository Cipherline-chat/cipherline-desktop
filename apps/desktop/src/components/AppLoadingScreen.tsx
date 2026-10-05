/**
 * AppLoadingScreen — Keys waits in the deep, watches your cursor, then surfaces.
 *
 * The first thing anyone sees when the app opens. Keys (the mark's dome and
 * four key-shaped legs, verbatim from apps/website/public/logo.svg) hangs in
 * a small 3D scene: a dot-matrix seabed glowing under him, plankton drifting
 * past at two depths, and two orbits of light around him. The loading cue is
 * the comet orbit, a pulse of light that runs along his legs like signal bars
 * filling up, and an honest line of status text. Move the mouse and the scene
 * turns toward it: near and far plankton part, the orbits tip, Keys turns
 * his head, his eyes follow you, his legs reach for the pointer, and a soft
 * light tracks it across the water. Click and he hops. When the data lands
 * he kicks for the surface and the scene is gone in just over half a second.
 *
 *   'loading'   — idle, indefinite (after SLOW_MS a calm "taking longer"
 *                 line fades in; no fake percentage, nothing that stalls)
 *   'surfacing' — the ~620ms ascent, then onSurfaced() fires and the caller
 *                 unmounts us
 *
 * PERF CONTRACT — this animates during the app's heaviest main-thread moment
 * (the Dashboard mounting and fetching right behind it), so it must neither
 * need the main thread to keep moving nor make the compositor work harder
 * than the screen it replaced:
 *   - Every animated property is transform or opacity, on HTML elements, and
 *     no keyframe references a custom property, so all idle motion runs on the
 *     compositor and keeps going straight through a long task. (Animations
 *     on SVG children — <rect>, <path>, <g> — are not a reliable compositor
 *     path in Chromium, so Keys is built from HTML here; the SVGs are static.)
 *   - The pointer is ONE passive pointermove listener, coalesced to at most
 *     one write per animation frame and per POINTER_WRITE_MS, which sets
 *     three non-inheriting custom properties (--mx, --my, --md) on the six
 *     elements that follow it (see writePointer for why never on the root).
 *     No React state, no layout reads, no work that scales with the scene's
 *     element count. The followers move by CSS transitions, which the
 *     compositor plays smoothly even if the next pointer event is stuck
 *     behind a long task.
 *   - Everything large is STILL: the seabed (pre-projected to 2D, see
 *     seabedPaths), the light pool and the halo are painted once into the
 *     base layer. Only small things move or pulse, because whatever moves is
 *     redrawn every frame.
 *   - Few loop restarts. Every restart of every CSS animation wakes the main
 *     thread (React listens for animationiteration at its root), so the
 *     plankton is nine sliding strips rather than dozens of looping dots and
 *     short cycles are written three-to-an-iteration. Measured idle: zero
 *     main-thread frames in 1.5 s, against 195 for the screen this replaced.
 *   - No canvas and no rAF loop. Reduced motion attaches no listeners at all.
 * See styles/loading-scene.css for the scene itself, and loadingScene.ts for
 * the non-React parts.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import '../styles/loading-scene.css';
import {
    STAGE_LABEL, SLOW_LABEL, beginWait, holdWait, releaseWait, rememberPointer,
    now, pointerTargets, writePointer, seabedPaths, outerOrbitDots, type LoadingStage,
} from './loadingScene';

export type { LoadingStage } from './loadingScene';
export type LoadingPhase = 'loading' | 'surfacing';

/** Must match the ls-leave / ls-ascend durations in loading-scene.css. */
export const SURFACE_MS = 620;
/** Reduced motion swaps the ascent for a plain cross-fade. */
export const REDUCED_MS = 260;
/**
 * After this long on screen (counted across the App → HydrationGate handoff,
 * see beginWait) a calm "taking longer than usual" line fades in.
 */
export const SLOW_MS = 8000;
/**
 * At most one pointer write per this many ms (and per animation frame).
 * Everything that follows the pointer eases over 0.65–1.1 s, so 5 targets a
 * second look the same as 60 (an underwater, slightly floaty follow), and
 * each write costs a style recalc and a batch of fresh compositor
 * transitions.
 */
export const POINTER_WRITE_MS = 200;

interface Props {
    /** 'surfacing' plays the ascent, then calls onSurfaced. */
    phase?: LoadingPhase;
    /** Fired once the ascent has finished. */
    onSurfaced?: () => void;
    /** What is being waited on; drives the status line. Defaults to 'start'. */
    stage?: LoadingStage;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Plankton: [left%, top%, size px, alpha]. Fixed rather than random so the
 * field never reshuffles on a re-render (the website's bubble field,
 * kit/65-ocean.js, is deterministic for the same reason). Dealt into
 * columns ("strips") below.
 */
const PLANKTON: ReadonlyArray<readonly [number, number, number, number]> = [
    [4, 12, 3, .5], [11, 34, 2, .35], [18, 71, 4, .55], [24, 48, 2.5, .4],
    [31, 88, 3, .45], [37, 22, 2, .3], [43, 62, 3.5, .5], [49, 8, 2, .35],
    [55, 41, 4, .6], [61, 79, 2.5, .4], [67, 27, 3, .45], [73, 56, 2, .3],
    [79, 91, 4, .55], [85, 17, 2.5, .35], [91, 66, 3, .5], [96, 38, 2, .4],
    [8, 82, 3.5, .55], [15, 5, 2, .35], [28, 59, 3, .45], [34, 95, 2.5, .4],
    [46, 31, 2, .3], [58, 74, 3, .5], [70, 14, 2.5, .4], [82, 49, 3, .45],
    [21, 44, 2.5, .4], [64, 97, 2, .35], [52, 3, 3, .5],
];

interface Strip {
    left: number; // % of the layer
    dur: number; // s per full climb of one layer height
    delay: number; // s
    dots: ReadonlyArray<{ x: number; y: number; size: number; alpha: number }>;
}
/**
 * Deal the plankton into a few columns. Each dot sits in the top half of
 * its strip and again 50% lower, so sliding the strip up by half its height
 * is a seamless loop (see .ls-strip).
 */
function strips(far: boolean): Strip[] {
    const lefts = far ? [16, 37, 58, 79] : [7, 26, 47, 68, 88];
    const src = PLANKTON.filter((_, i) => (i % 9 < 4) === far);
    return lefts.map((left, s) => ({
        left,
        dur: far ? 26 + s * 2.5 : 15 + s * 1.3,
        delay: -(s * 3.7 + (far ? 5 : 0)),
        dots: src.filter((_, i) => i % lefts.length === s).map(([l, top, size, alpha]) => ({
            x: Math.round((l * 7) % 26),
            y: top / 2,
            size: far ? Math.max(1.5, size * 0.7) : size * 1.3,
            // the far layer's dimness is baked in (no opacity on the layer)
            alpha: far ? alpha * 0.55 : alpha,
        })),
    }));
}
const FAR_STRIPS = strips(true);
const NEAR_STRIPS = strips(false);

const OUTER_ORBIT = outerOrbitDots();

/**
 * The seabed and the still outer orbit: a few static paths, painted once
 * (see seabedPaths / outerOrbitDots). Origin = Keys' eye line, centred.
 */
const Seabed: React.FC = () => (
    <svg className="ls-floor" width="3200" height="1700" viewBox="-1600 -300 3200 1700">
        {seabedPaths().map((p, i) => <path key={i} d={p.d} fill={p.fill} fillOpacity={p.opacity} />)}
        <g fill="#25E0C8" fillOpacity={0.3}>
            {OUTER_ORBIT.map((d, i) => <ellipse key={i} cx={d.x.toFixed(1)} cy={d.y.toFixed(1)} rx={d.rx.toFixed(2)} ry={d.ry.toFixed(2)} />)}
        </g>
    </svg>
);

/**
 * The comet orbit: a static SVG of dots (rasterised once) inside three
 * wrappers — the tilt (follows the pointer), the intro (unfurls once) and the
 * spin (a compositor loop). The dots grade from a bright head to a fading
 * tail, which is what makes the spin read as "working".
 */
const Orbit: React.FC<{ r: number; n: number; kind: string }> = ({ r, n, kind }) => {
    const box = r * 2 + 16;
    const dots = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const f = i / (n - 1);
        dots.push(
            <circle
                key={i}
                cx={(box / 2 + Math.cos(a) * r).toFixed(2)}
                cy={(box / 2 + Math.sin(a) * r).toFixed(2)}
                r={(1.2 + f * f * 2.8).toFixed(2)}
                fill={i === n - 1 ? '#E6FFFB' : '#25E0C8'}
                opacity={(0.1 + f * f * 0.9).toFixed(3)}
            />,
        );
    }
    return (
        <div className={`ls-orbit ls-orbit--${kind} ls-p`}>
            <div className="ls-orbit-in">
                <div className="ls-orbit-spin" style={{ width: box, height: box, marginLeft: -box / 2, marginTop: -box / 2 }}>
                    <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`}>{dots}</svg>
                </div>
            </div>
        </div>
    );
};

/**
 * Keys himself, rebuilt from the logo's shapes as HTML so every moving part
 * can animate on the compositor: the look (pointer), the bob (idle), the boop
 * (click), then legs (pointer reach + idle sway), dome and eyes. A tiny real
 * 3D rig: the eyes sit in front of the dome and the legs behind it, so one
 * head turn makes them shift against each other.
 */
const KeysRig: React.FC<{ boopRef: React.RefObject<HTMLDivElement | null> }> = ({ boopRef }) => (
    <div className="ls-k-look ls-p">
        <div className="ls-k-bob">
            <div className="ls-k-boop" ref={boopRef}>
                <div className="ls-k-legs ls-p">
                    {[1, 2, 3, 4].map(i => (
                        <div key={i} className={`ls-k-reach ls-k-reach-${i}`}>
                            <div className={`ls-k-leg ls-k-leg-${i}`}>
                                <div className="ls-k-leg-lit" />
                            </div>
                        </div>
                    ))}
                </div>
                <div className="ls-k-dome">
                    <div className="ls-k-shine" />
                </div>
                <div className="ls-k-eyes">
                    <div className="ls-k-blink">
                        <svg viewBox="0 0 110 90" width="100%" height="100%">
                            <path d="M33.5 40 l3.75 -5 l3.75 5 l3.75 -5 l3.75 5" fill="none" stroke="#0B0F1E" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
                            <path d="M61.5 40 l3.75 -5 l3.75 5 l3.75 -5 l3.75 5" fill="none" stroke="#0B0F1E" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    </div>
                </div>
            </div>
        </div>
    </div>
);

const Plankton: React.FC<{ far: boolean }> = ({ far }) => (
    <div className={`ls-layer ls-plankton ls-plankton--${far ? 'far' : 'near'} ls-p`}>
        {(far ? FAR_STRIPS : NEAR_STRIPS).map((st, s) => (
            <div
                key={s}
                className="ls-strip"
                style={{ left: `${st.left}%`, ['--ls-dur' as string]: `${st.dur}s`, ['--ls-delay' as string]: `${st.delay}s` }}
            >
                {st.dots.flatMap((d, i) => [0, 50].map(off => (
                    <span
                        key={`${i}-${off}`}
                        className="ls-bub"
                        style={{
                            left: d.x,
                            top: `${d.y + off}%`,
                            width: d.size,
                            height: d.size,
                            background: `rgba(37, 224, 200, ${d.alpha.toFixed(3)})`,
                        }}
                    />
                )))}
            </div>
        ))}
    </div>
);

export const AppLoadingScreen: React.FC<Props> = ({ phase = 'loading', onSurfaced, stage = 'start' }) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const boopRef = useRef<HTMLDivElement>(null);
    const surfacedRef = useRef(false);
    const onSurfacedRef = useRef(onSurfaced);
    useEffect(() => { onSurfacedRef.current = onSurfaced; });

    const [reduced] = useState(
        () => typeof window !== 'undefined'
            && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
    );

    // When this wait began (continuing a previous screen's), and how far into
    // it we already are — fed to CSS as a negative animation-delay so a
    // handoff remount picks every loop up mid-stride.
    const [wait] = useState(() => beginWait());
    const [el0] = useState(() => Math.max(0, (now() - wait.t0) / 1000));

    useEffect(() => {
        holdWait(wait.t0);
        return releaseWait;
    }, [wait]);

    const [slow, setSlow] = useState(() => now() - wait.t0 >= SLOW_MS);

    const finish = useCallback(() => {
        if (surfacedRef.current) return;
        surfacedRef.current = true;
        onSurfacedRef.current?.();
    }, []);

    // One timer, not an animationend listener: several elements finish at
    // once, the scene may be mounted with phase already 'surfacing', and a
    // dropped animationend (reduced motion runs no animation at all) would
    // strand the gate up forever. A timer can't miss.
    useEffect(() => {
        if (phase !== 'surfacing') return;
        const t = window.setTimeout(finish, reduced ? REDUCED_MS : SURFACE_MS);
        return () => window.clearTimeout(t);
    }, [phase, reduced, finish]);

    // The slow hint: one timer, only while loading, gone the moment we surface.
    useEffect(() => {
        if (phase !== 'loading' || slow) return;
        const t = window.setTimeout(() => setSlow(true), Math.max(0, SLOW_MS - (now() - wait.t0)));
        return () => window.clearTimeout(t);
    }, [phase, slow, wait]);

    // A handoff remount picks up where the pointer left Keys. Before paint, so
    // the first style already has it and no transition plays from centre.
    useLayoutEffect(() => {
        const root = rootRef.current;
        if (root && wait.continued && (wait.mx || wait.my || wait.md)) {
            writePointer(pointerTargets(root), wait.mx, wait.my, wait.md);
        }
    }, [wait]);

    // The pointer. Deliberately outside React: a move writes three custom
    // properties onto the few elements that follow it (see writePointer), at
    // most once a frame and once per POINTER_WRITE_MS, and that's all.
    useEffect(() => {
        const root = rootRef.current;
        if (!root || reduced || phase !== 'loading') return;

        // Viewport size, cached: read here (after commit, layout is clean)
        // and on resize — never inside the move handler.
        let w = window.innerWidth || 1;
        let h = window.innerHeight || 1;
        let x = 0;
        let y = 0;
        let raf = 0;
        let timer = 0;
        let lastWrite = -Infinity;
        let last = '';

        const targets = pointerTargets(root);
        const write = (mx: number, my: number, md: number) => {
            const key = `${mx.toFixed(2)} ${my.toFixed(2)} ${md.toFixed(2)}`;
            if (key === last) return;
            last = key;
            rememberPointer(mx, my, md);
            writePointer(targets, mx, my, md);
        };
        const flush = () => {
            raf = 0;
            lastWrite = now();
            const cx = w / 2;
            const cy = h * 0.46; // Keys' height in the scene (see .ls-keys)
            const mx = clamp((x - cx) / cx, -1, 1);
            const my = clamp((y - cy) / (h - cy), -1, 1);
            // Proximity to Keys: 1 on top of him, 0 from ~a third of the
            // shorter side away. Drives how hard his legs reach.
            const md = clamp(1 - Math.hypot(x - cx, y - cy) / (Math.min(w, h) * 0.36), 0, 1);
            write(mx, my, md);
        };
        const onMove = (e: PointerEvent) => {
            x = e.clientX;
            y = e.clientY;
            if (raf || timer) return;
            const remaining = POINTER_WRITE_MS - (now() - lastWrite);
            if (remaining <= 0) raf = window.requestAnimationFrame(flush);
            else timer = window.setTimeout(() => { timer = 0; raf = window.requestAnimationFrame(flush); }, remaining);
        };
        const cancel = () => {
            if (raf) window.cancelAnimationFrame(raf);
            if (timer) window.clearTimeout(timer);
            raf = 0;
            timer = 0;
        };
        const onLeave = () => {
            cancel();
            write(0, 0, 0); // drift home; the CSS transitions do the easing
        };
        let flip = false;
        const onDown = () => {
            // A hop. Alternating between two identical keyframes restarts the
            // animation without a forced reflow.
            const b = boopRef.current;
            if (!b) return;
            flip = !flip;
            b.classList.remove(flip ? 'ls-boop-b' : 'ls-boop-a');
            b.classList.add(flip ? 'ls-boop-a' : 'ls-boop-b');
        };
        const onResize = () => { w = window.innerWidth || 1; h = window.innerHeight || 1; };

        root.addEventListener('pointermove', onMove, { passive: true });
        root.addEventListener('pointerleave', onLeave, { passive: true });
        root.addEventListener('pointerdown', onDown, { passive: true });
        window.addEventListener('resize', onResize, { passive: true });
        return () => {
            root.removeEventListener('pointermove', onMove);
            root.removeEventListener('pointerleave', onLeave);
            root.removeEventListener('pointerdown', onDown);
            window.removeEventListener('resize', onResize);
            cancel();
        };
    }, [reduced, phase]);

    const label = STAGE_LABEL[stage] ?? STAGE_LABEL.start;

    return (
        <div
            ref={rootRef}
            className={`ls-root${phase === 'surfacing' ? ' is-surfacing' : ''}${slow ? ' is-slow' : ''}`}
            style={{ ['--ls-el' as string]: `${el0.toFixed(3)}s` }}
        >
            {/* Back to front. First everything that never moves — painted
                once into the base layer — then the few small things that do. */}
            <div className="ls-still" aria-hidden="true">
                <Seabed />
                <div className="ls-floor-pool" />
                <div className="ls-k-halo" />
            </div>

            {/* A light that follows the pointer across the water. */}
            <div className="ls-glow ls-p" aria-hidden="true"><div className="ls-glow-in" /></div>

            <div className="ls-scene" aria-hidden="true">
                <Plankton far />

                {/* The comet orbit sits BEHIND Keys and is tilted so its near
                    arc always passes below his legs: occlusion by plain paint
                    order, no 3D sorting. (The faint outer orbit is still, so
                    it is drawn into the seabed art.) */}
                <div className="ls-layer ls-orbits">
                    <Orbit r={168} n={46} kind="inner" />
                </div>

                <div className="ls-layer ls-keys">
                    <div className="ls-k-pos">
                        <KeysRig boopRef={boopRef} />
                    </div>
                </div>

                <Plankton far={false} />
            </div>

            <div className="ls-status" aria-hidden="true">
                <div className="ls-status-line">
                    {label}
                    <span className="ls-ellipsis"><i>.</i><i>.</i><i>.</i></span>
                </div>
                <div className="ls-status-slow">{SLOW_LABEL}</div>
            </div>

            <div className="ls-light" aria-hidden="true" />

            <span className="sr-only" role="status" aria-live="polite">
                {slow ? `${label}. ${SLOW_LABEL}` : `${label}…`}
            </span>
        </div>
    );
};

export default AppLoadingScreen;
