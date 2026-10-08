/**
 * AppLoadingScreen — Keys, an honest line and bar, a field of dots in space, and a secret.
 *
 * The first thing anyone sees when the app opens. Keys (the real mark, drawn
 * from apps/website/public/logo.svg's own geometry) swims gently in the
 * middle: a quick jellyfish stroke, then a slow glide, always upright, turning
 * a few degrees to face the pointer. Under him, one big line says what is
 * actually being waited on, and a slim bar of dots shows honest progress
 * (real stages and core loads; it slows rather than lies, and only fills
 * when loading is really done). After SLOW_MS a calm "taking longer" line
 * joins them. Behind him is the onboarding's ambient dot field — the faint
 * teal/ice dots from behind the privacy-step globe — in real 3D: a gentle
 * current streams past, and the camera orbits toward the pointer, so near
 * dots swing ~5x further than far ones.
 *
 * When the data lands, the bar fills, the camera rushes forward through the
 * field while Keys swells and fades, and the screen dissolves into the
 * Dashboard that has been mounted underneath all along (SURFACE_MS, nothing
 * pops at the end).
 *
 * THE SECRET: after HINT_MS a small "Press Space to play" appears. Only Space
 * starts it (a click never does, so stray clicks while waiting are
 * harmless): "Firewall" — the field speeds into a side-scroller and Keys
 * swims, one stroke per Space, through gaps in pillars that build themselves
 * out of the field's dots as they come (rules in utils/loadingGame.ts). The
 * score is plain text in a strip across the top. Esc leaves the game. If the
 * app finishes loading during a game nobody is yanked out: a "Cipherline is
 * ready · Enter to continue" chip appears; a crash holds on the score card
 * ("Enter to continue · Space to play again"); only Enter or Esc goes into
 * the app — nothing continues on its own. Offered only where the caller
 * hands off through onSurfaced (HydrationGate) — App.tsx's own screen is
 * unmounted abruptly, so a game could not be kept there.
 *
 *   'loading'   — indefinite (no fake percentage, nothing that stalls)
 *   'surfacing' — the app is ready: leave as soon as no game is up (or they
 *                 chose to), then onSurfaced() fires and the caller unmounts us
 *
 * PERF CONTRACT. This is on screen exactly while the renderer's main thread
 * is busiest (the Dashboard mounting behind it; real users have seen 2–3 s
 * stalls), so NOTHING that moves runs on the main thread:
 *   - Keys, the field, the bar and the game run in a dedicated worker
 *     (workers/loadingScreen.worker.ts) drawing WebGL into an
 *     OffscreenCanvas: one draw call per frame, 30 fps at rest. A blocked
 *     main thread cannot stall it.
 *   - The main thread posts only sizes, the bar's slot, progress, and raw
 *     input: keys, and the pointer coalesced to one message per frame (one
 *     rAF per pointer burst, never a loop). The worker posts back only state
 *     changes (first frame, game state and score).
 *   - The DOM (text, chips, score) animates with transform/opacity only
 *     (styles/app-loading.css), on HTML elements.
 *   - No OffscreenCanvas / no worker / no WebGL → the static mark and the
 *     text on the plain backdrop, a slim CSS sweep as the cue, no game.
 *     Reduced motion → a still field, a still Keys, the text and a still
 *     bar: no current, no swim, no pointer, no game.
 *   - The worker is parked across the App → HydrationGate handoff and
 *     terminated (GL context released) on exit (loadingWorkerHost.ts).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import '../styles/app-loading.css';
import {
    STAGE_LABEL, SLOW_LABEL, OFFLINE_LABEL, OFFLINE_SUB, HINT_MS, beginWait, holdWait, releaseWait, now,
    isLeaving, showsReadyChip, progressBand, OVER_GUARD_MS, type GameState, type LoadingStage,
} from './loadingWait';
import { acquireWorker, canUseWorker, markBroken, releaseWorker, type WorkerLike } from './loadingWorkerHost';
import { useEscape } from '../hooks/useEscape';
import { readLoadingGameBest, saveLoadingGameBest } from '../utils/loadingGameBest';
import type { FromWorker } from '../workers/loadingScreenProtocol';

export type { LoadingStage } from './loadingWait';
export type LoadingPhase = 'loading' | 'surfacing';

/** The exit into the app. Must match lo-out in app-loading.css (and the worker's dolly). */
export const SURFACE_MS = 560;
/** Reduced motion: a plain fade, no movement (see app-loading.css). */
export const REDUCED_MS = 200;
/**
 * After this long on screen (counted across the App → HydrationGate handoff,
 * see beginWait) a calm "taking longer than usual" line fades in.
 */
export const SLOW_MS = 8000;

interface Props {
    /** 'surfacing' = the app is ready: exit (once no run is in progress), then onSurfaced. */
    phase?: LoadingPhase;
    /** Fired once the exit has finished. */
    onSurfaced?: () => void;
    /** What is being waited on; drives the status line. Defaults to 'start'. */
    stage?: LoadingStage;
    /**
     * While syncing: the fraction (0..1) of the core loads that have settled
     * (HydrationGate). Drives the loading bar; never a percentage on screen.
     */
    progress?: number;
    /**
     * The OFFLINE screen's game stage (components/OfflineScreen.tsx): the same
     * field, Keys and Firewall, but the words are "You're offline" instead of a
     * loading line, there is no loading bar, and `phase` 'surfacing' means
     * "back online". Needs onSurfaced like the loading screen does.
     */
    offline?: boolean;
    /**
     * Start a run as soon as the field is drawn: the user already pressed
     * Space somewhere else (the offline card's hint), so this screen is the
     * transition INTO the game, not another "press Space" prompt.
     */
    autoPlay?: boolean;
    /**
     * Fired when the game stage has nothing to show and the screen is NOT
     * leaving: the player quit with Esc (back to the card they came from), or
     * there is no field to play on. Only meaningful with autoPlay.
     */
    onIdle?: () => void;
}

/** 'static': no field (no worker/WebGL). 'starting' → 'ok' once the field has drawn. */
type Gl = 'static' | 'starting' | 'ok';

/** Best score on record. Seeded from the encrypted local store on first use, so
 *  it survives an app restart (see utils/loadingGameBest.ts). */
let sessionBest: number | null = null;
const currentBest = (): number => (sessionBest ??= readLoadingGameBest());

const isEditable = (t: EventTarget | null): boolean => {
    const el = t as HTMLElement | null;
    if (!el || typeof el.tagName !== 'string') return false;
    return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
};

/** Keys: logo.svg's shapes, viewBox trimmed to its own bounds. Static art. */
const Mark: React.FC = () => (
    <svg className="lo-mark" viewBox="21 14 68 64" aria-hidden="true" focusable="false">
        <g fill="#25E0C8">
            <rect x="22.5" y="44" width="13" height="34" rx="6.5" />
            <rect x="39.8" y="44" width="13" height="34" rx="6.5" />
            <rect x="57.1" y="44" width="13" height="34" rx="6.5" />
            <rect x="74.4" y="44" width="13" height="34" rx="6.5" />
            <path d="M21 48 A34 34 0 0 1 89 48 L89 53 L21 53 Z" />
        </g>
        <g fill="none" stroke="#0B0F1E" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M33.5 40 l3.75 -5 l3.75 5 l3.75 -5 l3.75 5" />
            <path d="M61.5 40 l3.75 -5 l3.75 5 l3.75 -5 l3.75 5" />
        </g>
    </svg>
);

const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => <kbd className="lo-kbd">{children}</kbd>;

export const AppLoadingScreen: React.FC<Props> = ({ phase = 'loading', onSurfaced, stage = 'start', progress = 0, offline = false, autoPlay = false, onIdle }) => {
    const [reduced] = useState(
        () => typeof window !== 'undefined'
            && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
    );
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const textRef = useRef<HTMLDivElement>(null);
    const slotRef = useRef<HTMLDivElement>(null);
    const workerRef = useRef<WorkerLike | null>(null);
    /** When the last crash happened (performance.now), for the Enter/Esc guard. */
    const overAt = useRef(-Infinity);
    const fired = useRef(false);
    const latest = useRef(onSurfaced);
    const latestIdle = useRef(onIdle);
    useEffect(() => { latest.current = onSurfaced; latestIdle.current = onIdle; });

    // When this wait began (continuing a previous screen's), and how far into
    // it we already are — fed to CSS as a negative animation-delay so a
    // handoff remount doesn't replay the intro.
    const [wait] = useState(() => beginWait());
    const [el0] = useState(() => Math.max(0, (now() - wait.t0) / 1000));
    useEffect(() => {
        holdWait(wait.t0);
        return releaseWait;
    }, [wait]);

    const [gl, setGl] = useState<Gl>('starting');
    const [game, setGame] = useState<GameState>('idle');
    const [score, setScore] = useState({ now: 0, best: currentBest() });
    const [continued, setContinued] = useState(false);
    const [slow, setSlow] = useState(() => offline || now() - wait.t0 >= SLOW_MS);

    const loaded = phase === 'surfacing';
    // Offline can come back more than once: "continue" belongs to THIS return,
    // so a connection that drops again mid-exit doesn't pre-approve the next.
    if (!loaded && continued) setContinued(false);
    const leaving = isLeaving(loaded, game, continued);
    const readyChip = showsReadyChip(loaded, game, continued);
    const live = gl === 'ok' && !reduced;
    // The game needs the field, and a caller that waits for our exit.
    const playable = live && onSurfaced !== undefined;

    const finish = useCallback(() => {
        if (fired.current) return;
        fired.current = true;
        latest.current?.();
    }, []);

    // The worker: start it (or take over the one parked by the previous
    // screen), hand it the canvas, and from then on only forward sizes.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !canUseWorker(canvas)) { setGl('static'); return; }
        const got = acquireWorker(canvas);
        if (!got) { setGl('static'); return; }
        const w = got.worker;
        let dead = false;
        const fail = () => {
            if (dead) return;
            dead = true;
            markBroken();
            workerRef.current = null;
            releaseWorker(w, canvas, true);
            setGl('static');
            setGame('idle');
        };
        w.onmessage = (e: MessageEvent<FromWorker>) => {
            const m = e.data;
            if (m.type === 'ok') setGl('ok');
            else if (m.type === 'nogl') fail();
            else if (m.type === 'game') {
                sessionBest = saveLoadingGameBest(Math.max(currentBest(), m.best));
                if (m.mode === 'over') overAt.current = now();
                setGame(m.mode);
                setScore({ now: m.score, best: currentBest() });
            }
        };
        w.onerror = (e: ErrorEvent) => { e.preventDefault?.(); fail(); };
        const size = () => ({ w: window.innerWidth || 1, h: window.innerHeight || 1, dpr: window.devicePixelRatio || 1 });
        try {
            if (got.resumed) {
                w.postMessage({ type: 'resume' });
            } else {
                const off = canvas.transferControlToOffscreen();
                w.postMessage({ type: 'init', canvas: off, ...size(), best: currentBest(), reduced }, [off]);
            }
        } catch {
            fail();
            return;
        }
        workerRef.current = w;
        // Where the worker draws the bar: the DOM slot under the status line,
        // by offsets (not getBoundingClientRect: the text's intro transform
        // would skew a measurement taken while it plays).
        const postBar = () => {
            const slot = slotRef.current, text = textRef.current;
            if (!slot || !text) return;
            const W = window.innerWidth || 1, H = window.innerHeight || 1;
            const cx = text.offsetLeft + slot.offsetLeft + slot.offsetWidth / 2;
            const cy = text.offsetTop + slot.offsetTop + slot.offsetHeight / 2;
            w.postMessage({ type: 'bar', x: cx - W / 2, y: H / 2 - cy, w: slot.offsetWidth });
        };
        // The offline screen has no loading bar (the worker draws none until told where).
        if (!offline) postBar();
        // The brand font arriving can change the headline's height: re-place the bar.
        void document.fonts?.ready.then(() => { if (workerRef.current === w && !offline) postBar(); });
        const onResize = () => { w.postMessage({ type: 'resize', ...size() }); if (!offline) postBar(); };
        window.addEventListener('resize', onResize, { passive: true });
        return () => {
            window.removeEventListener('resize', onResize);
            if (dead) return;
            workerRef.current = null;
            releaseWorker(w, canvas, fired.current);
        };
        // Mount-only: the worker outlives prop changes; `reduced` is fixed at mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The pointer, for the field's parallax: the latest position, posted at
    // most once per frame (one rAF per burst of moves — no loop, no React).
    useEffect(() => {
        if (!live || leaving) return;
        let raf = 0;
        let x = 0, y = 0, on = true;
        const flush = () => {
            raf = 0;
            workerRef.current?.postMessage({ type: 'pointer', x, y, on });
        };
        const queue = () => { if (!raf) raf = window.requestAnimationFrame(flush); };
        const onMove = (e: PointerEvent) => {
            const w = window.innerWidth || 1, h = window.innerHeight || 1;
            x = (e.clientX / w) * 2 - 1;
            y = 1 - (e.clientY / h) * 2;
            on = true;
            queue();
        };
        const onOut = (e: PointerEvent) => { if (!e.relatedTarget) { on = false; queue(); } };
        window.addEventListener('pointermove', onMove, { passive: true });
        document.addEventListener('pointerout', onOut, { passive: true });
        return () => {
            window.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerout', onOut);
            if (raf) window.cancelAnimationFrame(raf);
        };
    }, [live, leaving]);

    // The loading bar: what is honestly known, as it changes. Never backwards
    // (the worker also keeps the max, across the handoff remount too).
    const band = progressBand(stage, progress, loaded);
    useEffect(() => {
        if (offline) return;
        workerRef.current?.postMessage({ type: 'progress', ...band });
    }, [band.floor, band.ceil, band.done, gl]); // eslint-disable-line react-hooks/exhaustive-deps

    // The offline card's Space already asked for a game: begin the run the
    // moment the field has drawn (once), rather than asking for Space again.
    const autoStarted = useRef(false);
    useEffect(() => {
        if (!autoPlay || !playable || autoStarted.current) return;
        autoStarted.current = true;
        workerRef.current?.postMessage({ type: 'act' });
    }, [autoPlay, playable]);

    // Back to where they came from: no field to play on at all, or the run
    // ended with Esc. (Leaving because the connection is back is `leaving`,
    // handled by the exit timer — never this.)
    const everPlayed = useRef(false);
    useEffect(() => {
        if (game !== 'idle') { everPlayed.current = true; return; }
        if (!autoPlay || leaving) return;
        if (gl === 'static' || reduced || (everPlayed.current && !loaded)) latestIdle.current?.();
    }, [game, autoPlay, leaving, gl, reduced, loaded]);

    // Leaving: tell the worker (the dolly through the field), then one timer.
    // Not an animationend listener: a dropped event (reduced motion, a hidden
    // window) would strand the gate up forever; a timer can't miss.
    useEffect(() => {
        if (!leaving) return;
        workerRef.current?.postMessage({ type: 'exit' });
        const t = window.setTimeout(finish, reduced ? REDUCED_MS : SURFACE_MS);
        return () => window.clearTimeout(t);
    }, [leaving, reduced, finish]);

    // The slow hint: one timer, only while loading, gone the moment we leave.
    useEffect(() => {
        if (loaded || slow) return;
        const t = window.setTimeout(() => setSlow(true), Math.max(0, SLOW_MS - (now() - wait.t0)));
        return () => window.clearTimeout(t);
    }, [loaded, slow, wait]);

    // Keys, only while there is a game to play. Capture phase, so the
    // Dashboard mounted underneath never sees a key the game used.
    useEffect(() => {
        if (!playable || leaving) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return;
            const w = workerRef.current;
            if (!w) return;
            const take = () => { e.preventDefault(); e.stopPropagation(); };
            if (e.code === 'Space' || e.key === ' ') {
                take();
                if (!e.repeat) w.postMessage({ type: 'act' });
            } else if (e.key === 'Enter' && readyChip) {
                take();
                if (now() - overAt.current >= OVER_GUARD_MS) setContinued(true);
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [playable, leaving, readyChip]);

    // Esc, through the app's shared Escape stack (utils/escapeStack.ts): once
    // the app is ready it continues into it; before that it leaves the game.
    // Right after a crash both wait OVER_GUARD_MS, so mashed keys can't skip
    // the score.
    useEscape(() => {
        if (game === 'over' && now() - overAt.current < OVER_GUARD_MS) return;
        if (readyChip) setContinued(true);
        else workerRef.current?.postMessage({ type: 'quit' });
    }, playable && !leaving && (readyChip || game !== 'idle'));

    const label = offline ? OFFLINE_LABEL : (STAGE_LABEL[stage] ?? STAGE_LABEL.start);
    const inGame = game !== 'idle';
    const hintDelay = Math.max(0, HINT_MS - (now() - wait.t0)) / 1000;

    const cls = [
        'lo-root',
        gl === 'ok' ? 'is-gl' : '',
        gl === 'static' ? 'is-static' : '',
        inGame ? 'is-game' : '',
        leaving ? 'is-surfacing' : '',
        slow ? 'is-slow' : '',
        reduced ? 'is-reduced' : '',
    ].filter(Boolean).join(' ');

    return (
        <div className={cls} style={{ ['--lo-el' as string]: `${el0.toFixed(3)}s` }}>
            {gl !== 'static' && <canvas ref={canvasRef} className="lo-canvas" aria-hidden="true" />}

            <div className="lo-keys" aria-hidden="true"><div className="lo-keys-bob"><Mark /></div></div>

            <div className="lo-text" ref={textRef} aria-hidden="true">
                <div className="lo-headline">{label}</div>
                {/* The loading bar's slot: the worker draws it here in dots; without
                    the field (no WebGL) a plain CSS sweep stands in. */}
                <div className="lo-bar" ref={slotRef}>
                    {gl === 'static' && !reduced && <div className="lo-track"><div className="lo-sweep" /></div>}
                </div>
                <div className="lo-slow">{offline ? OFFLINE_SUB : SLOW_LABEL}</div>
            </div>

            {playable && !inGame && !leaving && !autoPlay && (
                <div className="lo-hint" style={{ animationDelay: `${hintDelay.toFixed(3)}s` }} aria-hidden="true">
                    Press <Kbd>Space</Kbd> to play
                </div>
            )}

            {/* Game over holds on the score until they choose — even once the
                app is ready (then Enter goes in). Never continues on its own. */}
            {playable && game === 'over' && !leaving && (
                <div className="lo-over" aria-hidden="true">
                    <div className="lo-over-title">
                        Score {score.now} <span className="lo-sep">·</span> Best {score.best}
                    </div>
                    <div className="lo-over-sub">
                        {loaded
                            ? <><Kbd>Enter</Kbd> to continue <span className="lo-sep">·</span> <Kbd>Space</Kbd> to play again</>
                            : <><Kbd>Space</Kbd> to play again <span className="lo-sep">·</span> <Kbd>Esc</Kbd> to stop</>}
                    </div>
                </div>
            )}

            {/* In a game: one strip across the top (Keys never swims up into
                it): what is still loading (or that it is done), the score,
                and the keys. */}
            {playable && inGame && (
                <div className="lo-hud">
                    <div className="lo-hud-side">
                        {readyChip || (leaving && loaded) ? (
                            <button type="button" className="lo-ready" onClick={() => setContinued(true)}>
                                <span className="lo-ready-dot" />
                                {offline ? "You're back online" : 'Cipherline is ready'} <span className="lo-sep">·</span> <Kbd>Enter</Kbd> to continue
                            </button>
                        ) : (
                            <div className="lo-pill" aria-hidden="true">
                                <span className="lo-pill-dot" />
                                {offline ? label : `${label}…`}
                            </div>
                        )}
                    </div>
                    <div className="lo-score" aria-hidden="true">
                        <span className="lo-score-now">{score.now}</span>
                        {score.best > 0 && <span className="lo-score-best">Best {score.best}</span>}
                    </div>
                    <div className="lo-hud-side lo-hud-keys" aria-hidden="true"><Kbd>Space</Kbd> swim <Kbd>Esc</Kbd> stop</div>
                </div>
            )}

            <span className="sr-only" role="status" aria-live="polite">
                {readyChip
                    ? (offline ? "You're back online. Press Enter to continue." : 'Cipherline is ready. Press Enter to continue.')
                    : offline ? `${label}. ${OFFLINE_SUB}`
                    : slow ? `${label}. ${SLOW_LABEL}` : `${label}…`}
            </span>
        </div>
    );
};

export default AppLoadingScreen;
