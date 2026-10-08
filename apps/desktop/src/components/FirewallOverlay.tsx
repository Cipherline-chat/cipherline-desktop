/**
 * FirewallOverlay: the loading screen's easter-egg game, opened on Home by
 * spamming Keys (components/mascot/HomeKeys.tsx, utils/keysBurst.ts).
 *
 * It is the SAME game: the loading screen's worker module
 * (workers/loadingScreen.worker.ts) drawing WebGL into an OffscreenCanvas,
 * started through loadingWorkerHost's spawnWorker, with the rules in
 * utils/loadingGame.ts. Nothing is forked; this file is only a different
 * frame around it: it covers the Home pane (not the whole window, so the
 * rail, sidebars and any call or ringing UI stay where they are), and keeps
 * the best score per account (utils/firewallBest.ts).
 *
 * Keys:
 *   - Space swims (and starts / restarts a run). Taken in the capture phase
 *     only when focus is in the overlay or nowhere in particular (body), and
 *     never from a text field, so a click elsewhere gives Space back to
 *     whatever was clicked. While open, the plain `space` combo is CLAIMED
 *     (utils/keyClaims.ts): the keybind dispatcher and push-to-talk skip it,
 *     even though their listeners run before this one.
 *   - Esc closes, through the shared Escape stack (useEscape).
 * The host never opens it during a call, and closes it if one starts.
 *
 * Lifecycle: the canvas is created by the effect itself (a canvas can hand
 * its control to an OffscreenCanvas only once, and StrictMode re-runs the
 * effect), and on close the worker drops its GL context and is terminated
 * (releaseWorker(…, true)). It pauses while the app's decoration does
 * (window blurred, hidden or untouched: utils/idleMotion.ts); the worker's
 * clock clamps, so a run resumes where it froze.
 */
import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { canUseWorker, markBroken, releaseWorker, spawnWorker, type WorkerLike } from './loadingWorkerHost';
import type { FromWorker } from '../workers/loadingScreenProtocol';
import type { GameMode } from '../utils/loadingGame';
import { useEscape } from '../hooks/useEscape';
import { claimKeyCombo } from '../utils/keyClaims';
import { onMotionChange } from '../utils/idleMotion';
import { readFirewallBest, writeFirewallBest } from '../utils/firewallBest';
import '../styles/firewall.css';

export interface FirewallOverlayProps {
    userId: string;
    onClose: () => void;
}

type Gl = 'starting' | 'ok' | 'failed';

const isEditable = (t: EventTarget | null): boolean => {
    const el = t as HTMLElement | null;
    if (!el || typeof el.tagName !== 'string') return false;
    return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
};

const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => <kbd className="fw-kbd">{children}</kbd>;

export const FirewallOverlay: React.FC<FirewallOverlayProps> = ({ userId, onClose }) => {
    const rootRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const workerRef = useRef<WorkerLike | null>(null);
    // No OffscreenCanvas / no workers / WebGL already failed this session:
    // known before anything mounts.
    const [gl, setGl] = useState<Gl>(() => (canUseWorker(document.createElement('canvas')) ? 'starting' : 'failed'));
    const [mode, setMode] = useState<GameMode>('idle');
    const [score, setScore] = useState(0);
    const [best, setBest] = useState(() => readFirewallBest(userId));
    const bestRef = useRef(best);

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
            else if (m.type === 'game') {
                setMode(m.mode);
                setScore(m.score);
                if (m.best > bestRef.current) {
                    bestRef.current = writeFirewallBest(userId, m.best);
                    setBest(Math.max(bestRef.current, m.best));
                }
            }
        };
        w.onerror = (e: ErrorEvent) => { e.preventDefault?.(); fail(); };
        const size = () => ({ w: root.clientWidth || 1, h: root.clientHeight || 1, dpr: window.devicePixelRatio || 1 });
        try {
            const off = canvas.transferControlToOffscreen();
            w.postMessage({ type: 'init', canvas: off, ...size(), best: bestRef.current, reduced: false }, [off]);
        } catch {
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
        const offMotion = onMotionChange(active => { if (!dead) w.postMessage({ type: active ? 'resume' : 'pause' }); });
        return () => {
            ro?.disconnect();
            offMotion();
            release();
            canvas.remove();
        };
        // userId is fixed for the overlay's life (the host unmounts it on a switch).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
            t === document.body || t === document.documentElement || t === null
            || (t instanceof Node && !!rootRef.current?.contains(t));
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
            className={`fw-root${playing ? ' is-game' : ''}${ready ? ' is-ready' : ''}`}
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
                    {playing && <span className="fw-score-now">{score}</span>}
                    {best > 0 && <span className="fw-score-best">Best {best}</span>}
                </div>
                <div className="fw-hud-side fw-hud-end">
                    {ready && <span className="fw-keys" aria-hidden="true"><Kbd>Space</Kbd> swim <Kbd>Esc</Kbd> close</span>}
                    <button type="button" className="fw-close" onClick={onClose} aria-label="Close the game">
                        <X size={16} strokeWidth={2.4} />
                    </button>
                </div>
            </div>

            {ready && mode === 'idle' && (
                <div className="fw-hint">Press <Kbd>Space</Kbd> to swim through the firewall</div>
            )}

            {ready && mode === 'over' && (
                <div className="fw-over">
                    <div className="fw-over-title">
                        Score {score} <span className="fw-sep">·</span> Best {best}
                    </div>
                    <div className="fw-over-sub">
                        <Kbd>Space</Kbd> to play again <span className="fw-sep">·</span> <Kbd>Esc</Kbd> to close
                    </div>
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
