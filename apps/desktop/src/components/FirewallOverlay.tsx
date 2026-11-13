/**
 * FirewallOverlay: the loading screen's easter-egg game, opened by spamming
 * Keys: left-click on Home (components/mascot/HomeKeys.tsx, utils/keysBurst.ts)
 * or right-click on the rail's mark from anywhere (components/rail/RailKeys.tsx,
 * utils/railKeysGame.ts). Dashboard mounts the one instance (hooks/useFirewallGame.ts).
 *
 * It is the SAME game: the loading screen's worker module
 * (workers/loadingScreen.worker.ts) drawing WebGL into an OffscreenCanvas,
 * started through loadingWorkerHost's spawnWorker, with the rules in
 * utils/loadingGame.ts. Nothing is forked; this file is only a different
 * frame around it: it covers the Home pane (not the whole window, so the
 * rail, sidebars and any call or ringing UI stay where they are), and keeps
 * the best score per account (utils/flappyBest.ts: encrypted at rest, synced to
 * the server's leaderboard, which wins when it is higher) and the leaderboard
 * panel (FlappyLeaderboardPanel.tsx).
 *
 * Keys:
 *   - Space swims (and starts / restarts a run). Taken in the capture phase
 *     only when focus is in the overlay or nowhere in particular (body), and
 *     never from a text field, so a click elsewhere gives Space back to
 *     whatever was clicked. While open, the plain `space` combo is CLAIMED
 *     (utils/keyClaims.ts): the keybind dispatcher and push-to-talk skip it,
 *     even though their listeners run before this one.
 *   - Esc closes, through the shared Escape stack (useEscape). So does a click
 *     on any rail control (hooks/useFirewallGame.ts railExitProps): the same
 *     close, so the run's score and best are handled identically.
 * The host never opens it during a call, and closes it if one starts.
 *
 * Lifecycle: the canvas is created by the effect itself (a canvas can hand
 * its control to an OffscreenCanvas only once, and StrictMode re-runs the
 * effect), and on close the worker drops its GL context and is terminated
 * (releaseWorker(…, true)). It pauses while the app's decoration does
 * (window blurred, hidden or untouched: utils/idleMotion.ts); the worker's
 * clock clamps, so a run resumes where it froze.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Trophy, X } from 'lucide-react';
import { canUseWorker, markBroken, releaseWorker, spawnWorker, type WorkerLike } from './loadingWorkerHost';
import type { FromWorker } from '../workers/loadingScreenProtocol';
import type { GameMode } from '../utils/loadingGame';
import { useEscape } from '../hooks/useEscape';
import { FIREWALL_RAIL_ATTR } from '../hooks/useFirewallGame';
import { claimKeyCombo } from '../utils/keyClaims';
import { onMotionChange } from '../utils/idleMotion';
import { bestFor, onBestChange, recordRun, syncNow } from '../utils/flappyBest';
import { FlappyLeaderboardPanel } from './FlappyLeaderboardPanel';
import { hitchProbeEnabled, startHitchProbe, type HitchProbe } from './firewallHitchProbe';
import '../styles/firewall.css';

export interface FirewallOverlayProps {
    userId: string;
    onClose: () => void;
    /** 'pane' (default): fills its positioned parent. 'shell': fixed to the app
     *  shell's content area (right of the rail, below the titlebar), for the
     *  single instance Dashboard mounts so it opens from any view. */
    placement?: 'pane' | 'shell';
}

type Gl = 'starting' | 'ok' | 'failed';

const isEditable = (t: EventTarget | null): boolean => {
    const el = t as HTMLElement | null;
    if (!el || typeof el.tagName !== 'string') return false;
    return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
};

const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => <kbd className="fw-kbd">{children}</kbd>;

export const FirewallOverlay: React.FC<FirewallOverlayProps> = ({ userId, onClose, placement = 'pane' }) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const workerRef = useRef<WorkerLike | null>(null);
    // No OffscreenCanvas / no workers / WebGL already failed this session:
    // known before anything mounts.
    const [gl, setGl] = useState<Gl>(() => (canUseWorker(document.createElement('canvas')) ? 'starting' : 'failed'));
    const [mode, setMode] = useState<GameMode>('idle');
    const [best, setBest] = useState(() => bestFor(userId));
    const bestRef = useRef(best);
    // The score card's number. Mid-run points do not go through here: see liveScore.
    const [score, setScore] = useState(0);
    // The HUD's two running numbers are all a point changes, and a point lands about
    // every pillar: they are written straight to their spans rather than re-rendering
    // this whole overlay each time. React never renders into those spans.
    const liveScore = useRef(0);
    const liveScoreEl = useRef<HTMLSpanElement | null>(null);
    const attachLiveScore = useCallback((el: HTMLSpanElement | null) => {
        liveScoreEl.current = el;
        if (el) el.textContent = String(liveScore.current);
    }, []);
    const liveBestEl = useRef<HTMLSpanElement | null>(null);
    const paintBest = useCallback(() => {
        if (liveBestEl.current) liveBestEl.current.textContent = `Best ${bestRef.current}`;
    }, []);
    const attachLiveBest = useCallback((el: HTMLSpanElement | null) => {
        liveBestEl.current = el;
        paintBest();
    }, [paintBest]);
    /** A higher best from the server (a reconcile on sign-in, or the panel's fetch) replaces the local one. */
    const raiseBest = useCallback((b: number) => {
        if (b <= bestRef.current) return;
        bestRef.current = b;
        setBest(b);
        paintBest();
    }, [paintBest]);
    // The best when the current run began, to tell a NEW best from merely a good run.
    const bestAtStart = useRef(best);
    const modeRef = useRef<GameMode>('idle');
    const [newBest, setNewBest] = useState(false);
    // "New best" while a run is still going: past the best you started with (not on the very first run, where every point is one).
    const [beatingBest, setBeatingBest] = useState(false);
    const [boardOpen, setBoardOpen] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const motionActive = useRef(true);
    const trophyRef = useRef<HTMLButtonElement>(null);
    // Dev and staging builds: the hitch probe (firewallHitchProbe.ts). Its game-over "Copy hitch report" button was
    // removed (owner 2026-11-13); the probe still logs its summary to the console and window.__fwHitchReport on close.
    const [probeOn] = useState(hitchProbeEnabled);
    const probeRef = useRef<HitchProbe | null>(null);

    // The worker: one per open, terminated on close.
    useEffect(() => {
        const stage = stageRef.current, root = rootRef.current;
        if (!stage || !root) return;
        const canvas = document.createElement('canvas');
        canvas.className = 'fw-canvas';
        canvas.setAttribute('aria-hidden', 'true');
        stage.appendChild(canvas);
        const w = canUseWorker(canvas) ? spawnWorker() : null;
        if (!w) {
            canvas.remove();
            // Only reachable when the worker constructor itself threw.
            queueMicrotask(() => setGl('failed'));
            return;
        }
        let dead = false;
        // Dev and staging builds only: what the app was doing at each dropped game frame (firewallHitchProbe.ts).
        const probe = probeOn ? startHitchProbe() : null;
        probeRef.current = probe;
        const release = () => {
            if (dead) return false;
            dead = true;
            workerRef.current = null;
            releaseWorker(w, canvas, true);
            return true;
        };
        const fail = () => {
            if (!release()) return;
            markBroken();
            setGl('failed');
            setMode('idle');
        };
        w.onmessage = (e: MessageEvent<FromWorker>) => {
            const m = e.data;
            if (m.type === 'ok') setGl('ok');
            else if (m.type === 'nogl') fail();
            else if (m.type === 'probe') probe?.onWorker(m);
            else if (m.type === 'game') {
                if (m.mode === 'playing' && modeRef.current !== 'playing') {
                    bestAtStart.current = bestRef.current; // a fresh run: the bar to beat is the best so far
                    setNewBest(false);
                }
                setBeatingBest(m.mode === 'playing' && bestAtStart.current > 0 && m.score > bestAtStart.current);
                modeRef.current = m.mode;
                setMode(m.mode);
                liveScore.current = m.score;
                if (liveScoreEl.current) liveScoreEl.current.textContent = String(m.score);
                if (m.mode !== 'playing') setScore(m.score);
                // Every point counts, not just the crash: quitting a good run mid-flight keeps it.
                if (m.score > 0 && m.mode !== 'idle') recordRun(userId, m.score, m.runMs ?? 0);
                const known = Math.max(bestRef.current, m.best, bestFor(userId));
                if (known > bestRef.current) {
                    // Its span only exists once there is a best: the first one has to render it.
                    if (bestRef.current <= 0) setBest(known);
                    bestRef.current = known;
                    paintBest();
                }
                if (m.mode !== 'playing') setBest(bestRef.current); // the card reads it
                if (m.mode === 'over' && m.score > 0 && m.score > bestAtStart.current) setNewBest(true);
            }
        };
        w.onerror = (e: ErrorEvent) => { e.preventDefault?.(); fail(); };
        const size = () => ({ w: root.clientWidth || 1, h: root.clientHeight || 1, dpr: window.devicePixelRatio || 1 });
        try {
            const off = canvas.transferControlToOffscreen();
            w.postMessage({ type: 'init', canvas: off, ...size(), best: bestRef.current, reduced: false, probe: !!probe, power: 'high-performance' }, [off]);
        } catch {
            probe?.stop();
            fail();
            canvas.remove();
            return;
        }
        workerRef.current = w;
        // The pane resizes with the window and the sidebars' drag handles.
        const ro = typeof ResizeObserver === 'function'
            ? new ResizeObserver(() => { if (!dead) w.postMessage({ type: 'resize', ...size() }); })
            : null;
        ro?.observe(root);
        // Rest with the rest of the app's decoration (blurred / hidden / idle).
        const offMotion = onMotionChange(active => {
            motionActive.current = active;
            if (!dead) w.postMessage({ type: active ? 'resume' : 'pause' });
        });
        return () => {
            ro?.disconnect();
            offMotion();
            void syncNow(); // closing mid-run: send the best now, not at the next debounce
            probe?.stop();
            release();
            canvas.remove();
        };
        // userId is fixed for the overlay's life (the host unmounts it on a switch).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => onBestChange(raiseBest), [raiseBest]);

    // The leaderboard panel is a pause: the game does not run behind it.
    useEffect(() => {
        if (!boardOpen) return;
        workerRef.current?.postMessage({ type: 'pause' });
        return () => { if (motionActive.current) workerRef.current?.postMessage({ type: 'resume' }); };
    }, [boardOpen]);
    const closeBoard = () => {
        setBoardOpen(false);
        trophyRef.current?.focus({ preventScroll: true }); // back where they were
    };

    // The pointer, for the idle scene's parallax (Keys turns to face it): the
    // latest position over the pane, at most once a frame, no loop.
    useEffect(() => {
        const root = rootRef.current;
        if (!root || gl !== 'ok') return;
        let raf = 0;
        let x = 0, y = 0, on = true;
        const flush = () => { raf = 0; workerRef.current?.postMessage({ type: 'pointer', x, y, on }); };
        const queue = () => { if (!raf) raf = requestAnimationFrame(flush); };
        const onMove = (e: PointerEvent) => {
            const r = root.getBoundingClientRect();
            x = ((e.clientX - r.left) / (r.width || 1)) * 2 - 1;
            y = 1 - ((e.clientY - r.top) / (r.height || 1)) * 2;
            on = true;
            queue();
        };
        const onLeave = () => { on = false; queue(); };
        root.addEventListener('pointermove', onMove, { passive: true });
        root.addEventListener('pointerleave', onLeave, { passive: true });
        return () => {
            root.removeEventListener('pointermove', onMove);
            root.removeEventListener('pointerleave', onLeave);
            if (raf) cancelAnimationFrame(raf);
        };
    }, [gl]);

    // Space. Capture phase so nothing underneath sees a press the game used;
    // the claim keeps the global hotkeys (registered before us) off it too.
    useEffect(() => {
        const releaseClaim = claimKeyCombo('space');
        const owns = (t: EventTarget | null) =>
            // inside the leaderboard panel Space belongs to its tabs, switch and buttons
            !(t instanceof Node && !!panelRef.current?.contains(t)) && (
                t === document.body || t === document.documentElement || t === null
                || (t instanceof Node && !!rootRef.current?.contains(t))
                // A click on a rail control closes the game, so focus resting on one
                // (Tab, or a right-click that opened its menu) must not let Space press it.
                || (t instanceof Element && !!t.closest(`[${FIREWALL_RAIL_ATTR}]`)));
        const onKey = (e: KeyboardEvent) => {
            if (e.code !== 'Space' && e.key !== ' ') return;
            if (e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target) || !owns(e.target)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.type === 'keydown' && !e.repeat) workerRef.current?.postMessage({ type: 'act' });
        };
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('keyup', onKey, true);
        return () => {
            releaseClaim();
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('keyup', onKey, true);
        };
    }, []);

    // Focus: into the overlay on open (so Space is ours, not a focused
    // button's), and back where it was on close.
    useEffect(() => {
        const prev = document.activeElement as HTMLElement | null;
        rootRef.current?.focus({ preventScroll: true });
        return () => {
            if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus({ preventScroll: true });
        };
    }, []);

    useEscape(() => onClose(), true);

    const playing = mode !== 'idle';
    const ready = gl === 'ok';

    return (
        <div
            ref={rootRef}
            className={`fw-root${placement === 'shell' ? ' fw-root--shell' : ''}${playing ? ' is-game' : ''}${ready ? ' is-ready' : ''}`}
            role="dialog"
            aria-label="Firewall, a game"
            tabIndex={-1}
            data-ob-anchor="home-firewall"
        >
            <div
                ref={stageRef}
                className="fw-stage"
                // A click swims too, once the scene is up (buttons stop their own).
                onPointerDown={(e) => { if (ready && e.button === 0) workerRef.current?.postMessage({ type: 'act' }); }}
            />

            <div className="fw-hud">
                <div className="fw-hud-side">
                    <span className="fw-title">Firewall</span>
                </div>
                <div className="fw-score" aria-live="polite">
                    {playing && <span ref={attachLiveScore} className="fw-score-now" />}
                    {best > 0 && <span ref={attachLiveBest} className="fw-score-best" />}
                    {mode === 'playing' && beatingBest && (
                        <span className="fw-score-new" data-testid="fw-new-best-chip">New best</span>
                    )}
                </div>
                <div className="fw-hud-side fw-hud-end">
                    {ready && <span className="fw-keys" aria-hidden="true"><Kbd>Space</Kbd> swim <Kbd>Esc</Kbd> close</span>}
                    <button
                        ref={trophyRef}
                        type="button"
                        className="fw-iconbtn fw-trophy"
                        onClick={() => setBoardOpen((o) => !o)}
                        aria-label="Leaderboard"
                        aria-expanded={boardOpen}
                        data-testid="fw-trophy"
                    >
                        <Trophy size={15} strokeWidth={2.4} />
                    </button>
                    <button type="button" className="fw-close" onClick={onClose} aria-label="Close the game">
                        <X size={16} strokeWidth={2.4} />
                    </button>
                </div>
            </div>

            {ready && mode === 'idle' && (
                <div className="fw-hint">Press <Kbd>Space</Kbd> to swim through the firewall</div>
            )}

            {ready && mode === 'over' && (
                <div className={`fw-over${newBest ? ' is-new-best' : ''}`}>
                    {newBest && (
                        <div className="fw-newbest" role="status" data-testid="fw-new-best">
                            <span className="fw-newbest-ring" aria-hidden="true" />
                            <Trophy size={18} strokeWidth={2.4} aria-hidden="true" /> New best!
                        </div>
                    )}
                    <div className="fw-over-title">
                        Score {score} <span className="fw-sep">·</span> Best {best}
                    </div>
                    <div className="fw-over-sub">
                        <Kbd>Space</Kbd> to play again <span className="fw-sep">·</span> <Kbd>Esc</Kbd> to close
                    </div>
                    <button type="button" className="fw-btn" onClick={() => setBoardOpen(true)}>See the leaderboard</button>
                </div>
            )}

            {boardOpen && (
                <div ref={panelRef} className="fw-lb-wrap">
                    <FlappyLeaderboardPanel
                        onClose={closeBoard}
                        onMe={(me) => raiseBest(me.best_score)}
                    />
                </div>
            )}

            {gl === 'failed' && (
                <div className="fw-over">
                    <div className="fw-over-title">Firewall can’t run here</div>
                    <div className="fw-over-sub">It needs WebGL, which this machine isn’t offering right now.</div>
                    <button type="button" className="fw-btn" onClick={onClose}>Back to Home</button>
                </div>
            )}
        </div>
    );
};

export default FirewallOverlay;
