import React, { useEffect, useRef } from 'react';
import { isMotionActive, onMotionChange } from '../../utils/idleMotion';
import { computeCanvasBackingSize } from '../../utils/canvasSizing';

/**
 * The water column behind the Descent settings: one tall gradient that pans
 * down as you change zones, a canvas of bioluminescent motes that thin out
 * with depth, and a flash-tinted vignette that only breathes in at the abyss
 * (the vignette + bead color are driven by .sd-z-abyss on the root).
 */
interface SeaBackdropProps {
    /** 0 = Surface, 1 = Twilight, 2 = Midnight, 3 = Abyss */
    zone: number;
}

interface Mote {
    x: number; y: number; r: number; a: number; p: number; v: number; warm: boolean;
}

const MOTE_COUNT = [26, 20, 12, 6];
const MOTE_SPEED = [1, 0.8, 0.55, 0.35];

export const SeaBackdrop: React.FC<SeaBackdropProps> = ({ zone }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    // The rAF loop reads these refs so zone changes never restart the loop.
    const targetRef = useRef(MOTE_COUNT[0]);
    const speedRef = useRef(MOTE_SPEED[0]);
    targetRef.current = MOTE_COUNT[zone] ?? 12;
    speedRef.current = MOTE_SPEED[zone] ?? 0.6;

    useEffect(() => {
        const cv = canvasRef.current;
        if (!cv) return;
        // Still frame (in fact zero frames — the canvas just never draws):
        // satisfies prefers-reduced-motion without a separate "draw once and
        // freeze" path, since there is nothing on the canvas to freeze.
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const cx = cv.getContext('2d');
        if (!cx) return;

        // CSS-pixel size of the canvas's box. The backing store
        // (`cv.width`/`cv.height`) is set to CSS size * devicePixelRatio (see
        // `resize` below) so motes stay sharp on high-DPI displays, but every
        // drawing call below runs through a `ctx.scale(dpr, dpr)` transform
        // and therefore wants CSS-pixel coordinates. Keeping this as the one
        // source of truth (rather than re-deriving CSS size from `cv.width`
        // at each call site) is what keeps the device-pixel backing store and
        // the CSS-pixel drawing math from drifting apart.
        const sizeRef = { current: { width: 0, height: 0 } };

        const spawn = (y?: number): Mote => ({
            x: Math.random() * sizeRef.current.width,
            y: y !== undefined ? y : Math.random() * sizeRef.current.height,
            r: 0.8 + Math.random() * 1.8,
            a: 0.05 + Math.random() * 0.22,
            p: Math.random() * Math.PI * 2,
            v: 0.12 + Math.random() * 0.3,
            warm: Math.random() < 0.04,
        });

        // Was `cv.width = cv.offsetWidth; cv.height = cv.offsetHeight`, which
        // left the canvas at the HTML default 300x150 backing store: `.sd-motes`
        // is `position:absolute;inset:0` with no explicit `width`/`height`, and
        // for an absolutely-positioned REPLACED element (a <canvas>, like an
        // <img>) with `width`/`height` left `auto`, the box does not stretch to
        // fill `inset:0` — per the CSS sizing algorithm for such elements, auto
        // width/height falls back to the element's intrinsic size, which for a
        // fresh canvas is exactly 300x150. `offsetWidth`/`offsetHeight` then
        // faithfully reported that same 300x150 box back, so every mote drew
        // inside it — the observed top-left corner. Fixed on the CSS side too
        // (`.sd-motes` now sets `width:100%;height:100%` explicitly, in
        // settings-descent.css) so the box itself fills its parent; this reads
        // the box's actual rendered size via `getBoundingClientRect()` (layout
        // pixels, sub-pixel accurate) rather than trusting the box to already
        // be sized right, and additionally scales the backing store by
        // devicePixelRatio so the motes are crisp rather than soft on a
        // high-DPI panel.
        const resize = () => {
            const rect = cv.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            const { width, height } = computeCanvasBackingSize(rect.width, rect.height, dpr);
            if (cv.width !== width) cv.width = width;
            if (cv.height !== height) cv.height = height;
            // `setTransform` (not `scale`) so a second resize replaces the
            // transform outright instead of compounding the DPR scale onto
            // whatever was already there.
            cx.setTransform(dpr, 0, 0, dpr, 0, 0);
            sizeRef.current = { width: rect.width, height: rect.height };
        };
        resize();

        // ResizeObserver over the canvas's own box — fires on window resizes
        // (which change the settings surface's size) and on any other layout
        // change that resizes this element without the window itself
        // resizing (e.g. a future denser/narrower Descent layout), which a
        // bare `window.addEventListener('resize', …)` would miss.
        let ro: ResizeObserver | undefined;
        if (typeof ResizeObserver !== 'undefined') {
            ro = new ResizeObserver(resize);
            ro.observe(cv);
        } else {
            // jsdom / very old runtime fallback.
            window.addEventListener('resize', resize);
        }

        const motes: Mote[] = [];
        for (let i = 0; i < targetRef.current; i++) motes.push(spawn());

        let raf = 0;
        let running = false;
        let last = 0;

        // Draw at ~30fps, not at the display's refresh rate.
        //
        // Every frame clears and repaints the whole settings surface, so this
        // loop is the single largest main-thread cost while the Descent is
        // open — measured at ~410 ms/sec (about 40% of one core) at DPR 1 on a
        // 1920x1080 surface. Halving the draw rate halves that.
        //
        // Nothing visible is lost: the motes rise at 0.12–0.42 px per 60Hz
        // frame, so even at 30fps the largest step is well under one pixel.
        // Motion is scaled by ELAPSED time below rather than assumed per
        // frame, so the drift speed on screen is unchanged — this is the same
        // ambience running at half the redraw cost, not a slower one.
        const FRAME_MS = 1000 / 30;

        const tick = (now: number) => {
            raf = requestAnimationFrame(tick);
            if (!last) last = now;
            const dt = now - last;
            if (dt < FRAME_MS) return;
            last = now;
            // Steps per 60Hz-frame-equivalent, so the visual speed is the same
            // whatever rate we actually end up drawing at (and a long stall
            // can't teleport the field).
            const step = Math.min(dt / 16.667, 4);

            const { width: w, height: h } = sizeRef.current;
            cx.clearRect(0, 0, w, h);
            while (motes.length < targetRef.current) motes.push(spawn(h + 8));
            if (motes.length > targetRef.current) motes.length = targetRef.current;
            for (const m of motes) {
                m.y -= m.v * speedRef.current * step;
                m.p += 0.012 * step;
                if (m.y < -10) Object.assign(m, spawn(h + 8));
                const x = m.x + Math.sin(m.p) * 14;
                cx.beginPath();
                cx.arc(x, m.y, m.r, 0, 7);
                cx.fillStyle = m.warm ? `rgba(255,201,77,${m.a})` : `rgba(37,224,200,${m.a})`;
                cx.fill();
            }
        };

        // Focus/visibility/on-screen gate. The CSS decorative loops stop when
        // the window is blurred or hidden (utils/idleMotion.ts); this canvas
        // is driven by rAF rather than by a stylesheet, so it needs its own
        // gate — rAF is NOT throttled for a window that is merely
        // blurred-but-visible, nor for a canvas that has scrolled/been
        // navigated out of view while still mounted. Same contract as the CSS
        // gate: purely decorative, so nothing is lost by stopping it, and it
        // resumes as soon as the window is active AND the canvas is on
        // screen again.
        let intersecting = true;
        let io: IntersectionObserver | undefined;

        const start = () => {
            if (running) return;
            running = true;
            // Drop the stale timestamp so the first frame after a resume is a
            // normal step rather than one scaled by the whole idle period.
            last = 0;
            raf = requestAnimationFrame(tick);
        };
        const stop = () => {
            if (!running) return;
            running = false;
            cancelAnimationFrame(raf);
            raf = 0;
        };
        const sync = () => {
            // isMotionActive: the shared gate, which also hears the main
            // process's minimise / hide-to-tray (utils/idleMotion.ts).
            if (isMotionActive() && intersecting) start();
            else stop();
        };

        if (typeof IntersectionObserver !== 'undefined') {
            io = new IntersectionObserver(([entry]) => {
                intersecting = entry?.isIntersecting ?? true;
                sync();
            });
            io.observe(cv);
        }

        window.addEventListener('focus', sync);
        window.addEventListener('blur', sync);
        document.addEventListener('visibilitychange', sync);
        const offMotion = onMotionChange(sync);
        sync();

        return () => {
            stop();
            offMotion();
            window.removeEventListener('focus', sync);
            window.removeEventListener('blur', sync);
            document.removeEventListener('visibilitychange', sync);
            if (ro) ro.disconnect();
            else window.removeEventListener('resize', resize);
            if (io) io.disconnect();
        };
    }, []);

    return (
        <div className="sd-sea" aria-hidden="true">
            <div className="sd-sea-grad" style={{ transform: `translateY(${-zone * 40}vh)` }} />
            <canvas ref={canvasRef} className="sd-motes" />
            <div className="sd-sea-vignette" />
        </div>
    );
};
