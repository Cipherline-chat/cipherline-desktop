import React, { useEffect, useRef } from 'react';
import { isMotionActive, onMotionChange } from '../../utils/idleMotion';

/**
 * Server Settings' ambient light — real motes drifting through the water,
 * not the blurred solid-colour blobs "Dry Dock" shipped with (server-dock.css
 * still keeps those for ChannelSettingsDialog's small Create/Edit Channel
 * card, under the `--m1`/`--m2` names — this is Server Settings' own
 * replacement, not a change to that dialog).
 *
 * Same technique as the sibling "Descent" settings' SeaBackdrop.tsx (a canvas
 * of small circles drifting upward with a gentle sideways sway, teal with an
 * occasional warm one), just without its zone-based colour/count ramp — Dry
 * Dock isn't zoned, so one calm, constant field. Mounted ONCE, spanning the
 * whole rail+content row rather than the old two separately-seeded fields,
 * so motes drift continuously across the seam between them instead of two
 * fields that merely happened to line up.
 *
 * Deliberately sparser than SeaBackdrop's own surface-zone count: this sits
 * behind a working settings surface, not a hero backdrop, so it reads as
 * ambient light rather than something competing with the form fields on
 * top of it.
 */

interface Mote {
    x: number; y: number; r: number; a: number; p: number; v: number; warm: boolean;
}

const MOTE_COUNT = 22;
const MOTE_SPEED = 0.6;

export const DockBackdrop: React.FC = () => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const cv = canvasRef.current;
        const wrap = cv?.parentElement;
        if (!cv || !wrap) return;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const cx = cv.getContext('2d');
        if (!cx) return;

        const spawn = (y?: number): Mote => ({
            x: Math.random() * cv.width,
            y: y !== undefined ? y : Math.random() * cv.height,
            r: 0.8 + Math.random() * 1.8,
            a: 0.05 + Math.random() * 0.2,
            p: Math.random() * Math.PI * 2,
            v: 0.12 + Math.random() * 0.3,
            warm: Math.random() < 0.05,
        });

        const resize = () => {
            cv.width = wrap.clientWidth;
            cv.height = wrap.clientHeight;
        };
        resize();
        // ResizeObserver, not a window resize listener: this canvas resizes
        // with a flex row inside a modal that itself resizes independently
        // of the window (windowed-mode card, tab-content height changes),
        // none of which fire a window 'resize' event.
        const ro = new ResizeObserver(resize);
        ro.observe(wrap);

        const motes: Mote[] = [];
        for (let i = 0; i < MOTE_COUNT; i++) motes.push(spawn());

        let raf = 0;
        let running = false;
        const tick = () => {
            cx.clearRect(0, 0, cv.width, cv.height);
            for (const m of motes) {
                m.y -= m.v * MOTE_SPEED;
                m.p += 0.012;
                if (m.y < -10) Object.assign(m, spawn(cv.height + 8));
                const x = m.x + Math.sin(m.p) * 14;
                cx.beginPath();
                cx.arc(x, m.y, m.r, 0, 7);
                cx.fillStyle = m.warm ? `rgba(255,201,77,${m.a})` : `rgba(37,224,200,${m.a})`;
                cx.fill();
            }
            raf = requestAnimationFrame(tick);
        };
        // Same idle-motion gate as SeaBackdrop: purely decorative, so it stops
        // while the window is blurred, minimised or hidden to the tray instead
        // of drawing 60 frames a second nobody sees.
        const sync = () => {
            if (isMotionActive() && !running) { running = true; raf = requestAnimationFrame(tick); }
            else if (!isMotionActive() && running) { running = false; cancelAnimationFrame(raf); raf = 0; }
        };
        const offMotion = onMotionChange(sync);
        sync();

        return () => {
            offMotion();
            cancelAnimationFrame(raf);
            ro.disconnect();
        };
    }, []);

    return (
        <div className="dock-motes-wrap" aria-hidden="true">
            <canvas ref={canvasRef} className="dock-motes" />
        </div>
    );
};

export default DockBackdrop;
