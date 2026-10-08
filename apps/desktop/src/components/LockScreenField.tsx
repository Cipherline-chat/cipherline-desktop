/**
 * LockScreenField — the loading screen's field of dots, as the lock screen's
 * backdrop.
 *
 * The same worker, scene and look as AppLoadingScreen (workers/
 * loadingScreen.worker.ts: faint teal/ice dots in real 3D, a gentle current, the
 * camera orbiting toward the pointer), with Keys switched off — the PIN card
 * is the subject here, the dots are atmosphere.
 *
 * The lock screen can sit up for hours, so it is deliberately cheap and quiet:
 *   - the field runs in the worker, never the main thread (the loading screen's
 *     perf contract), and is told to stop drawing whenever the window is
 *     hidden or minimised, resuming when it is shown again;
 *   - prefers-reduced-motion gets one still frame;
 *   - no WebGL / no worker → nothing is drawn and the lock screen is exactly
 *     what it was (a flat backdrop). It never blocks or delays unlocking.
 * It shows nothing about the app: no content, no state, only dots.
 */
import React, { useEffect, useRef, useState } from 'react';
import { acquireWorker, canUseWorker, markBroken, releaseWorker, type WorkerLike } from './loadingWorkerHost';
import type { FromWorker } from '../workers/loadingScreenProtocol';

export const LockScreenField: React.FC<{ onLive?: (live: boolean) => void }> = ({ onLive }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [live, setLive] = useState(false);
    const [supported] = useState(() => typeof document !== 'undefined' && typeof HTMLCanvasElement !== 'undefined'
        && typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function');
    const onLiveRef = useRef(onLive);
    useEffect(() => { onLiveRef.current = onLive; });

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !canUseWorker(canvas)) return;
        const got = acquireWorker(canvas);
        if (!got) return;
        const w: WorkerLike = got.worker;
        let dead = false;
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
        const fail = () => {
            if (dead) return;
            dead = true;
            markBroken();
            releaseWorker(w, canvas, true);
            setLive(false);
            onLiveRef.current?.(false);
        };
        w.onmessage = (e: MessageEvent<FromWorker>) => {
            if (e.data.type === 'ok') { setLive(true); onLiveRef.current?.(true); }
            else if (e.data.type === 'nogl') fail();
        };
        w.onerror = (e: ErrorEvent) => { e.preventDefault?.(); fail(); };
        const size = () => ({ w: window.innerWidth || 1, h: window.innerHeight || 1, dpr: window.devicePixelRatio || 1 });
        try {
            if (got.resumed) {
                w.postMessage({ type: 'resume' });
            } else {
                const off = canvas.transferControlToOffscreen();
                w.postMessage({ type: 'init', canvas: off, ...size(), best: 0, reduced }, [off]);
            }
            w.postMessage({ type: 'keys', visible: false });
        } catch {
            fail();
            return;
        }

        const onResize = () => w.postMessage({ type: 'resize', ...size() });
        window.addEventListener('resize', onResize, { passive: true });

        // A locked app is often left open and forgotten: don't draw into a
        // window nobody can see.
        const onVisibility = () => {
            w.postMessage(document.hidden ? { type: 'pause' } : { type: 'resume' });
        };
        document.addEventListener('visibilitychange', onVisibility);

        // The pointer, for the parallax: latest position, at most once a frame.
        let raf = 0, x = 0, y = 0, on = true;
        const flush = () => { raf = 0; w.postMessage({ type: 'pointer', x, y, on }); };
        const queue = () => { if (!raf) raf = window.requestAnimationFrame(flush); };
        const onMove = (e: PointerEvent) => {
            x = (e.clientX / (window.innerWidth || 1)) * 2 - 1;
            y = 1 - (e.clientY / (window.innerHeight || 1)) * 2;
            on = true;
            queue();
        };
        const onOut = (e: PointerEvent) => { if (!e.relatedTarget) { on = false; queue(); } };
        window.addEventListener('pointermove', onMove, { passive: true });
        document.addEventListener('pointerout', onOut, { passive: true });

        return () => {
            window.removeEventListener('resize', onResize);
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerout', onOut);
            if (raf) window.cancelAnimationFrame(raf);
            if (dead) return;
            // Final: release the GL context now (unlocking is the end of this screen).
            releaseWorker(w, canvas, true);
            onLiveRef.current?.(false);
        };
    }, []);

    if (!supported) return null;
    return (
        <canvas
            ref={canvasRef}
            aria-hidden="true"
            style={{
                position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block',
                pointerEvents: 'none', opacity: live ? 1 : 0, transition: 'opacity 700ms ease-out',
            }}
        />
    );
};

export default LockScreenField;
