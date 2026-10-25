import React, { useEffect, useRef } from 'react';
import type { ItemOptions } from '../../../utils/profileCosmetics';
import type { HSL } from '../colour';
import { rng } from '../geometry';
import type { FxEnv, FxProgram } from './engine';

/** The frame loop for one effect program on one card (policy: engine.ts). */

// ── the component ────────────────────────────────────────────────────────────

const reducedMotion = (): boolean =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Probe { frames: number; ms: number; avgMs: number; maxMs: number }
const probe = (): Probe | null => {
    const w = window as unknown as { __pcFxProbe?: boolean; __pcFxStats?: Probe };
    if (!w.__pcFxProbe) return null;
    if (!w.__pcFxStats) w.__pcFxStats = { frames: 0, ms: 0, avgMs: 0, maxMs: 0 };
    return w.__pcFxStats;
};

function measureAvatar(card: HTMLElement | null, w: number, h: number): { x: number; y: number; r: number; banner: number } {
    // No profile card around it (a picker thumbnail): centre everything on the host itself, so
    // effects that orbit or radiate from the avatar stay inside a 76x48 tile.
    const fallback = h < 200 ? { x: w / 2, y: h / 2, r: Math.min(w, h) * 0.3, banner: h * 0.4 } : { x: w / 2, y: 110, r: 46, banner: 112 };
    if (!card) return fallback;
    const cr = card.getBoundingClientRect();
    const av = card.querySelector('[data-hx-layer="avatar"] .pc-deco-host, [data-hx-layer="avatar"] button, [data-fx-avatar]') as HTMLElement | null;
    const bn = card.querySelector('[data-hx-layer="banner"], .pcd-banner') as HTMLElement | null;
    const out = { ...fallback };
    if (av) {
        const r = av.getBoundingClientRect();
        if (r.width > 0) { out.x = r.left - cr.left + r.width / 2; out.y = r.top - cr.top + r.height / 2; out.r = r.width / 2; }
    }
    if (bn) {
        const r = bn.getBoundingClientRect();
        if (r.height > 0) out.banner = r.bottom - cr.top;
    }
    return out;
}

export const EffectCanvas: React.FC<{
    program: FxProgram;
    /** Restart key: the effect id + its options + tint (a change re-seeds the simulation). */
    seed: number;
    tint: HSL;
    opts: ItemOptions;
    image: CanvasImageSource | null;
    imageRound: boolean;
    /** false = stop requesting frames and keep the last one (a resting, non-looping effect). */
    running?: boolean;
}> = ({ program, seed, tint, opts, image, imageRound, running = true }) => {
    const runningRef = useRef(running);
    const syncRef = useRef<() => void>(() => {});
    // `running` flips without re-seeding the simulation: just re-evaluate the loop.
    useEffect(() => { runningRef.current = running; syncRef.current(); }, [running]);
    const ref = useRef<HTMLCanvasElement>(null);
    const overRef = useRef<HTMLCanvasElement>(null);
    const optsKey = JSON.stringify(opts);
    const tintKey = `${tint.h}|${tint.s}|${tint.l}`;

    useEffect(() => {
        const canvas = ref.current;
        const host = canvas?.parentElement ?? null;
        if (!canvas || !host) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        // A `lowRes` program draws into a SMALL visible canvas that CSS stretches
        // to the card: the compositor upscales it on the GPU for free (bilinear),
        // with no full-size blit. Its crisp `after` pass gets its own full-res canvas.
        const over = program.after ? overRef.current : null;
        const octx = over?.getContext('2d') ?? null;
        const card = host.parentElement;
        const root = document.documentElement;
        let env: FxEnv | null = null;
        let state: unknown = null;
        let raf = 0;
        let last = 0;
        let acc = 0;
        let t = 0;
        let visible = true;
        let dpr = 1;
        let scale = 1;
        let sized = '';
        const frameMin = 1 / (program.fps ?? 60) - 0.002;

        const draw = (dt: number) => {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.setTransform(scale, 0, 0, scale, 0, 0);
            if (program.blur) ctx.filter = `blur(${program.blur}px)`;
            program.frame(ctx, state, t, dt, env!);
            ctx.filter = 'none';
            if (over && octx && program.after) {
                octx.setTransform(1, 0, 0, 1, 0, 0);
                octx.clearRect(0, 0, over.width, over.height);
                octx.setTransform(dpr, 0, 0, dpr, 0, 0);
                program.after(octx, state, t, dt, env!);
            }
        };
        let broken = false;
        const render = (dt: number) => {
            if (!env || broken) return;
            const pr = probe();
            const t0 = pr ? performance.now() : 0;
            try {
                draw(dt);
            } catch (e) {
                // A cosmetic must never take the card down: stop, clear, show nothing.
                broken = true;
                cancelAnimationFrame(raf);
                raf = 0;
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                console.warn('[profile effect] stopped:', e);
                return;
            }
            if (pr) {
                const ms = performance.now() - t0;
                pr.frames++; pr.ms += ms; pr.avgMs = pr.ms / pr.frames; pr.maxMs = Math.max(pr.maxMs, ms);
            }
        };

        const setup = () => {
            const w = host.clientWidth, h = host.clientHeight;
            if (w < 2 || h < 2) return false;
            dpr = Math.min(2, window.devicePixelRatio || 1);
            const key = `${w}x${h}@${dpr}`;
            if (key === sized) return true;
            sized = key;
            scale = program.lowRes ?? dpr;
            canvas.width = Math.max(1, Math.ceil(w * scale));
            canvas.height = Math.max(1, Math.ceil(h * scale));
            if (over) { over.width = Math.round(w * dpr); over.height = Math.round(h * dpr); }
            const av = measureAvatar(card, w, h);
            env = { w, h, avatar: { x: av.x, y: av.y, r: av.r }, banner: av.banner, tint, opts, image, imageRound };
            try { state = program.init(env, rng(seed)); } catch (e) { broken = true; console.warn('[profile effect] stopped:', e); return true; }
            // Pre-roll so a fresh card shows a settled, spread-out field.
            const pre = program.preroll ?? 0;
            t = 0;
            ctx.setTransform(scale, 0, 0, scale, 0, 0);
            try {
                for (let s = 0; s < pre; s += 1 / 30) { t += 1 / 30; program.frame(ctx, state, t, 1 / 30, env); }
            } catch (e) { broken = true; console.warn('[profile effect] stopped:', e); return true; }
            render(0);
            return true;
        };

        const running = () => raf !== 0;
        // Pause only when the WINDOW is not in front (data-cl-window, utils/idleMotion.ts) - never
        // for input idleness (owner rule: a card you are reading keeps playing).
        const shouldRun = () => !broken && runningRef.current && !reducedMotion() && !document.hidden && root.getAttribute('data-cl-window') !== 'inactive' && visible && !!env;
        const loop = (now: number) => {
            raf = requestAnimationFrame(loop);
            const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
            last = now;
            acc += dt;
            if (acc < frameMin) return;
            const step = Math.min(0.05, acc);
            acc = 0;
            t += step;
            render(step);
        };
        const sync = () => {
            if (shouldRun()) {
                if (!running()) { last = 0; acc = 0; raf = requestAnimationFrame(loop); }
            } else if (running()) {
                cancelAnimationFrame(raf);
                raf = 0;
            }
        };

        setup();
        sync();
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { if (setup()) sync(); }) : null;
        ro?.observe(host);
        const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(sync) : null;
        mo?.observe(root, { attributes: true, attributeFilter: ['data-cl-window'] });
        syncRef.current = sync;
        const io = typeof IntersectionObserver !== 'undefined'
            ? new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); sync(); })
            : null;
        io?.observe(host);
        document.addEventListener('visibilitychange', sync);
        const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
        mq?.addEventListener?.('change', sync);
        return () => {
            cancelAnimationFrame(raf);
            raf = 0;
            ro?.disconnect();
            mo?.disconnect();
            io?.disconnect();
            document.removeEventListener('visibilitychange', sync);
            mq?.removeEventListener?.('change', sync);
        };
        // optsKey / tintKey stand in for the objects (a new object with the same content must not restart).
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [program, seed, optsKey, tintKey, image, imageRound]);

    return (
        <>
            <canvas ref={ref} aria-hidden="true" style={program.cssBlur ? { filter: `blur(${program.cssBlur}px)` } : undefined} />
            {program.after && <canvas ref={overRef} aria-hidden="true" data-layer="crisp" />}
        </>
    );
};
