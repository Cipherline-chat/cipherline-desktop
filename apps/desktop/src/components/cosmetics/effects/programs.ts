/**
 * The profile-effect programs (engine.tsx runs them). Each is a small,
 * continuous simulation or a pure function of time over seeded noise, drawn
 * in card CSS pixels. Light is composited with `screen` unless the program
 * says otherwise, and peak alpha over the text column is kept low.
 *
 * Craft notes, per program, are on each one. The common vocabulary: a glow
 * sprite (soft core + falloff) for anything luminous, depth (`z`) to vary size,
 * speed and brightness together, and simplex noise for every drift so motion
 * never repeats on a visible period.
 */
import { AURORA_COLOURS, GHOST_COLOURS } from '../../../utils/profileCosmetics';
import { hexToHsl, hslToRgb, shade, type HSL } from '../colour';
import { glowSprite, lvl, sprite, type FxEnv, type FxProgram } from './engine';
import { simplex3 } from './noise';

const TAU = Math.PI * 2;
const area = (env: FxEnv) => Math.max(0.35, Math.min(1.6, (env.w * env.h) / (340 * 470)));
const count = (env: FxEnv, base: number) => Math.max(3, Math.round(base * area(env)));
const hsl = (hex: string): HSL => hexToHsl(hex)!;
const wrap = (v: number, lo: number, hi: number) => (v < lo ? v + (hi - lo) : v > hi ? v - (hi - lo) : v);

// ── Bubbles ──────────────────────────────────────────────────────────────────
// Rings with a specular glint, wobbling as they rise; small ones rise slower.
interface Bubble { x: number; y: number; r: number; v: number; ph: number; wob: number; f: number }
const bubbles: FxProgram<Bubble[]> = {
    stock: '#7FE9DA',
    preroll: 0,
    init(env, rand) {
        const n = count(env, lvl(env.opts.n, 8, 14, 22));
        return Array.from({ length: n }, () => {
            const r = 1.6 + rand() * rand() * 6;
            return { x: rand() * env.w, y: rand() * env.h, r, v: 14 + r * 6, ph: rand() * TAU, wob: 2 + r * 0.9, f: 1.2 + rand() * 1.4 };
        });
    },
    frame(g, bs, t, dt, env) {
        const ring = shade(env.tint, 12, 0.6), fill = shade(env.tint, 10, 0.06), glint = 'rgba(255,255,255,.75)';
        for (const b of bs) {
            b.y -= b.v * dt;
            if (b.y < -b.r * 2) { b.y = env.h + b.r * 2 + (b.ph % 1) * 30; b.x = (b.x + 97.3) % env.w; }
            const x = b.x + Math.sin(t * b.f + b.ph) * b.wob;
            const fade = Math.min(1, (b.y + b.r) / 40);
            g.globalAlpha = fade;
            g.beginPath(); g.arc(x, b.y, b.r, 0, TAU);
            g.fillStyle = fill; g.fill();
            g.lineWidth = Math.max(0.7, b.r * 0.16); g.strokeStyle = ring; g.stroke();
            g.beginPath(); g.arc(x, b.y, b.r * 0.62, Math.PI * 1.1, Math.PI * 1.45);
            g.lineWidth = Math.max(0.6, b.r * 0.18); g.strokeStyle = glint; g.stroke();
        }
        g.globalAlpha = 1;
    },
};

// ── Glimmer ──────────────────────────────────────────────────────────────────
// Four-point glints that bloom and fade, each reappearing somewhere new.
interface Glint { x: number; y: number; period: number; off: number; size: number; cycle: number }
const glimmer: FxProgram<{ gs: Glint[]; rand: () => number }> = {
    stock: '#DCEBFF',
    init(env, rand) {
        const n = count(env, lvl(env.opts.n, 7, 12, 20));
        return { rand, gs: Array.from({ length: n }, () => ({ x: rand() * env.w, y: rand() * env.h, period: 2.6 + rand() * 2.4, off: rand() * 5, size: 5 + rand() * 7, cycle: -1 })) };
    },
    frame(g, s, t, _dt, env) {
        const spr = glowSprite(env.tint, 32, 0.12, 34);
        g.lineCap = 'round';
        for (const p of s.gs) {
            const u = (t + p.off) / p.period;
            const c = Math.floor(u);
            if (c !== p.cycle) { if (p.cycle !== -1) { p.x = s.rand() * env.w; p.y = s.rand() * env.h; } p.cycle = c; }
            const k = Math.pow(Math.sin(Math.PI * (u - c)), 3);
            if (k < 0.01) continue;
            const L = p.size * (0.4 + k);
            g.globalAlpha = k * 0.85;
            g.drawImage(spr, p.x - L, p.y - L, L * 2, L * 2);
            g.strokeStyle = 'rgba(255,255,255,.9)';
            g.lineWidth = 0.9;
            g.beginPath(); g.moveTo(p.x - L, p.y); g.lineTo(p.x + L, p.y); g.moveTo(p.x, p.y - L * 1.3); g.lineTo(p.x, p.y + L * 1.3); g.stroke();
        }
        g.globalAlpha = 1;
    },
};

// ── Plankton ─────────────────────────────────────────────────────────────────
// Motes carried on a slow noise current, near ones larger, brighter and faster.
interface Mote { x: number; y: number; z: number; ph: number; f: number }
const plankton: FxProgram<{ ms: Mote[]; n3: ReturnType<typeof simplex3> }> = {
    stock: '#9FF3E6',
    init(env, rand) {
        const n = count(env, lvl(env.opts.n, 30, 54, 90));
        return { n3: simplex3(11), ms: Array.from({ length: n }, () => ({ x: rand() * env.w, y: rand() * env.h, z: 0.25 + rand() * 0.75, ph: rand() * TAU, f: 0.6 + rand() * 1.8 })) };
    },
    frame(g, s, t, dt, env) {
        const spr = glowSprite(env.tint, 24, 0.16, 30);
        for (const m of s.ms) {
            const a = s.n3(m.x * 0.006, m.y * 0.006, t * 0.04) * Math.PI;
            m.x = wrap(m.x + Math.cos(a) * 7 * m.z * dt, -6, env.w + 6);
            m.y = wrap(m.y + (Math.sin(a) * 5 - 5 - 7 * m.z) * dt, -6, env.h + 6);
            const tw = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * m.f + m.ph));
            const sz = 2.5 + m.z * 6;
            g.globalAlpha = tw * (0.25 + 0.75 * m.z);
            g.drawImage(spr, m.x - sz / 2, m.y - sz / 2, sz, sz);
        }
        g.globalAlpha = 1;
    },
};

// ── Sonar ────────────────────────────────────────────────────────────────────
// Pings out from the avatar; contacts flare as each ping passes them.
interface Contact { x: number; y: number; flare: number; last: number }
const sonar: FxProgram<{ cs: Contact[] }> = {
    stock: '#25E0C8',
    init(env, rand) {
        const cs: Contact[] = [];
        for (let i = 0; i < 7; i++) {
            const a = rand() * TAU, d = env.avatar.r + 40 + rand() * Math.max(env.w, env.h) * 0.55;
            const x = env.avatar.x + Math.cos(a) * d, y = env.avatar.y + Math.sin(a) * d;
            if (x > 8 && x < env.w - 8 && y > 8 && y < env.h - 8) cs.push({ x, y, flare: 0, last: -1 });
        }
        return { cs };
    },
    frame(g, s, t, dt, env) {
        const P = lvl(env.opts.s, 4.2, 3, 2.1);
        const reach = Math.hypot(Math.max(env.avatar.x, env.w - env.avatar.x), Math.max(env.avatar.y, env.h - env.avatar.y));
        const life = 2.4 * P;
        const { x: ax, y: ay, r: ar } = env.avatar;
        for (let k = Math.floor((t - life) / P); k <= Math.floor(t / P); k++) {
            const age = t - k * P;
            if (age < 0 || age > life) continue;
            const u = age / life;
            const rad = ar + 4 + Math.pow(u, 0.8) * reach;
            const a = Math.pow(1 - u, 1.7);
            g.strokeStyle = shade(env.tint, 6, 0.16 * a); g.lineWidth = 9;
            g.beginPath(); g.arc(ax, ay, rad - 4, 0, TAU); g.stroke();
            g.strokeStyle = shade(env.tint, 14, 0.55 * a); g.lineWidth = 1.3;
            g.beginPath(); g.arc(ax, ay, rad, 0, TAU); g.stroke();
            for (const c of s.cs) {
                if (c.last !== k && Math.abs(Math.hypot(c.x - ax, c.y - ay) - rad) < 7) { c.flare = 1; c.last = k; }
            }
        }
        const spr = glowSprite(env.tint, 28, 0.14, 34);
        for (const c of s.cs) {
            c.flare *= Math.exp(-dt * 1.4);
            if (c.flare < 0.02) continue;
            g.globalAlpha = c.flare;
            g.drawImage(spr, c.x - 9, c.y - 9, 18, 18);
        }
        g.globalAlpha = 1;
    },
};

// ── Current ──────────────────────────────────────────────────────────────────
// Threads of light carried through a meandering flow field: each particle
// leaves a short fading trail, so the field itself becomes visible.
interface Thread { x: number; y: number; z: number; hx: Float32Array; hy: Float32Array; head: number; len: number }
const TRAIL = 44;
const current: FxProgram<{ ts: Thread[]; n3: ReturnType<typeof simplex3>; acc: number; rand: () => number }> = {
    stock: '#7FB8FF',
    preroll: 3,
    init(env, rand) {
        const n = count(env, lvl(env.opts.n, 18, 28, 42));
        const ts = Array.from({ length: n }, () => {
            const x = rand() * env.w, y = rand() * env.h;
            return { x, y, z: 0.35 + rand() * 0.65, hx: new Float32Array(TRAIL).fill(x), hy: new Float32Array(TRAIL).fill(y), head: 0, len: 0 };
        });
        return { ts, n3: simplex3(23), acc: 0, rand };
    },
    frame(g, s, t, dt, env) {
        const spd = lvl(env.opts.s, 13, 19, 29);
        s.acc += dt;
        const sample = s.acc >= 1 / 30;
        if (sample) s.acc = 0;
        for (const p of s.ts) {
            const a = s.n3(p.x * 0.0032, p.y * 0.0042, t * 0.03) * 1.7 + 0.25 * Math.sin(p.y * 0.02 + t * 0.2);
            p.x += (Math.cos(a) * 0.75 + 0.35) * spd * (0.5 + p.z) * dt;
            p.y += Math.sin(a) * spd * 0.8 * (0.5 + p.z) * dt;
            if (p.x > env.w + 20 || p.y < -20 || p.y > env.h + 20) {
                p.x = -10; p.y = s.rand() * env.h; p.hx.fill(p.x); p.hy.fill(p.y); p.len = 0;
            }
            if (sample) { p.head = (p.head + 1) % TRAIL; p.hx[p.head] = p.x; p.hy[p.head] = p.y; p.len = Math.min(TRAIL, p.len + 1); }
        }
        g.lineCap = 'butt'; g.lineJoin = 'round';
        const spr = glowSprite(env.tint, 20, 0.16, 30);
        for (const p of s.ts) {
            if (p.len < 3) continue;
            g.globalAlpha = 0.4 * p.z;
            g.drawImage(spr, p.x - 2.5, p.y - 2.5, 5, 5);
        }
        g.globalAlpha = 1;
        // Trails: one stroke per segment band across ALL threads (4 strokes a
        // frame, not one per thread), each band brighter towards the head.
        const SEG = 4;
        for (let seg = 0; seg < SEG; seg++) {
            g.beginPath();
            for (const p of s.ts) {
                if (p.len < 3) continue;
                const from = Math.floor((p.len - 1) * seg / SEG), to = Math.floor((p.len - 1) * (seg + 1) / SEG);
                for (let i = from; i <= to; i++) {
                    const idx = (p.head - (p.len - 1) + i + TRAIL * 2) % TRAIL;
                    if (i === from) g.moveTo(p.hx[idx], p.hy[idx]); else g.lineTo(p.hx[idx], p.hy[idx]);
                }
            }
            g.strokeStyle = shade(env.tint, 14, 0.05 + seg * 0.1);
            g.lineWidth = 0.7 + seg * 0.3;
            g.stroke();
        }
    },
};

// ── God rays ─────────────────────────────────────────────────────────────────
// Volumetric shafts from a sun beyond the top-left edge. Each shaft is one
// wedge whose light falls off along its length; the edges fall off because
// the frame is drawn small, Gaussian-softened (`blur`) and upscaled - true soft
// light, not stripes. Brightness breathes per shaft on its own noise and the
// whole fan sways a few degrees. Dust drifts at full resolution and is only lit
// where it crosses a shaft (the particulate that sells the volume).
interface Ray { x0: number; w0: number; k: number; x: number }
interface Dust { x: number; y: number; z: number }
interface Rays { rays: Ray[]; dust: Dust[]; n3: ReturnType<typeof simplex3>; ang: number; I: Float32Array }
const godRays: FxProgram<Rays> = {
    stock: '#CDEBFF',
    lowRes: 0.33,
    blur: 3,
    fps: 30,
    init(env, rand) {
        const rays: Ray[] = [];
        const n = 9;
        for (let i = 0; i < n; i++) {
            const x0 = -env.w * 0.3 + (i + 0.5 + (rand() - 0.5) * 0.7) * (env.w * 1.2 / n);
            rays.push({ x0, w0: 6 + Math.pow(rand(), 1.5) * 34, k: i * 13.7, x: x0 });
        }
        const dust = Array.from({ length: count(env, 70) }, () => ({ x: rand() * env.w, y: rand() * env.h, z: 0.3 + rand() * 0.7 }));
        return { rays, dust, n3: simplex3(5), ang: 0.3, I: new Float32Array(n) };
    },
    frame(g, s, t, dt, env) {
        const drift = lvl(env.opts.s, 0.5, 1, 1.7);
        const gain = lvl(env.opts.i, 0.65, 1, 1.4);
        s.ang = 0.3 + 0.045 * Math.sin(t * 0.055 * drift) + 0.02 * s.n3(0, 0, t * 0.05 * drift);
        const tan = Math.tan(s.ang);
        const L = env.h * 1.1;
        g.globalCompositeOperation = 'lighter';
        // The sun's glow where the shafts converge.
        const sun = g.createRadialGradient(env.w * 0.12, -20, 0, env.w * 0.12, -20, env.w * 0.75);
        sun.addColorStop(0, shade(env.tint, 26, 0.34 * gain));
        sun.addColorStop(0.4, shade(env.tint, 10, 0.08 * gain));
        sun.addColorStop(1, shade(env.tint, 0, 0));
        g.fillStyle = sun;
        g.fillRect(0, 0, env.w, env.h * 0.7);
        s.rays.forEach((r, i) => {
            const I = Math.max(0, 0.3 + 0.7 * s.n3(r.k, 0.5, t * 0.08 * drift));
            s.I[i] = I;
            r.x = r.x0 + 9 * Math.sin(t * 0.045 * drift + r.k);
            const grad = g.createLinearGradient(0, 0, 0, L);
            grad.addColorStop(0, shade(env.tint, 24, 0.7 * I * gain));
            grad.addColorStop(0.25, shade(env.tint, 14, 0.36 * I * gain));
            grad.addColorStop(0.6, shade(env.tint, 4, 0.1 * I * gain));
            grad.addColorStop(1, shade(env.tint, 0, 0));
            g.fillStyle = grad;
            const wt = r.w0, wb = r.w0 * 2.4;
            g.beginPath();
            g.moveTo(r.x - wt / 2, -10); g.lineTo(r.x + wt / 2, -10);
            g.lineTo(r.x + tan * L + wb / 2, L); g.lineTo(r.x + tan * L - wb / 2, L);
            g.closePath(); g.fill();
        });
        g.globalCompositeOperation = 'source-over';
        for (const d of s.dust) {
            d.x = wrap(d.x + (s.n3(d.x * 0.01, d.y * 0.01, t * 0.1) * 6 + 2) * d.z * dt, -4, env.w + 4);
            d.y = wrap(d.y + (s.n3(d.y * 0.01, d.x * 0.01, 9 + t * 0.1) * 5 + 3) * d.z * dt, -4, env.h + 4);
        }
    },
    after(g, s, _t, _dt, env) {
        const tan = Math.tan(s.ang);
        const spr = glowSprite(env.tint, 16, 0.2, 34);
        for (const d of s.dust) {
            let lit = 0;
            s.rays.forEach((r, i) => {
                const cx = r.x + tan * (d.y + 10);
                const half = (r.w0 + r.w0 * 1.4 * (d.y / env.h)) / 2 + 3;
                const q = 1 - Math.abs(d.x - cx) / half;
                if (q > 0) lit += q * s.I[i];
            });
            const a = Math.min(1, lit * 1.4) * (1 - (d.y / env.h) * 0.6) * d.z;
            if (a < 0.03) continue;
            const sz = 2 + d.z * 3.5;
            g.globalAlpha = a;
            g.drawImage(spr, d.x - sz / 2, d.y - sz / 2, sz, sz);
        }
        g.globalAlpha = 1;
    },
};

// ── Keepsake rain ────────────────────────────────────────────────────────────
// The owner's avatar, or one of their own emojis, drifting down with a gentle
// sway and turn. Without the image (a viewer who was never sent the emoji),
// soft droplets fall instead - never a broken image.
interface Drop { x: number; y: number; z: number; rot: number; vr: number; ph: number }
const keepsakeRain: FxProgram<{ ds: Drop[]; spr: HTMLCanvasElement | null }> = {
    stock: '#25E0C8',
    blend: 'normal',
    preroll: 0,
    init(env, rand) {
        const n = count(env, lvl(env.opts.n, 6, 10, 16));
        let spr: HTMLCanvasElement | null = null;
        if (env.image) {
            const S = 64;
            spr = document.createElement('canvas');
            spr.width = S; spr.height = S;
            const g = spr.getContext('2d')!;
            if (env.imageRound) { g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 1, 0, TAU); g.clip(); }
            const im = env.image as HTMLImageElement;
            const iw = im.naturalWidth || (im as unknown as { width: number }).width || S;
            const ih = im.naturalHeight || (im as unknown as { height: number }).height || S;
            const sc = env.imageRound ? Math.max(S / iw, S / ih) : Math.min(S / iw, S / ih);
            try { g.drawImage(env.image, (S - iw * sc) / 2, (S - ih * sc) / 2, iw * sc, ih * sc); } catch { spr = null; }
            if (spr && env.imageRound) { g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,.55)'; g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 1, 0, TAU); g.stroke(); }
        }
        return { spr, ds: Array.from({ length: n }, () => ({ x: rand() * env.w, y: rand() * env.h, z: 0.45 + rand() * 0.55, rot: (rand() - 0.5) * 0.8, vr: (rand() - 0.5) * 0.6, ph: rand() * TAU })) };
    },
    frame(g, s, t, dt, env) {
        const v = lvl(env.opts.s, 12, 20, 32);
        const glow = glowSprite(env.tint, 48, 0.1, 20);
        for (const d of s.ds) {
            d.y += v * (0.55 + d.z * 0.7) * dt;
            d.rot += d.vr * dt;
            const size = (s.spr ? 14 : 8) + d.z * (s.spr ? 14 : 8);
            if (d.y > env.h + size) { d.y = -size; d.x = (d.x + 131.7) % env.w; }
            const x = d.x + Math.sin(t * 0.7 + d.ph) * 10 * d.z;
            // Vivid in the banner sky; once it falls past the avatar into the text it
            // quietens (the card must stay readable under it).
            const below = d.y - (env.avatar.y + env.avatar.r);
            const quiet = below <= 0 ? 1 : Math.max(0.32, 1 - below / 70);
            const edge = Math.min(1, (env.h + size - d.y) / 40, (d.y + size) / 30) * quiet;
            g.globalAlpha = 0.35 * edge * d.z;
            g.drawImage(glow, x - size, d.y - size, size * 2, size * 2);
            g.globalAlpha = (0.55 + 0.4 * d.z) * edge;
            if (s.spr) {
                g.save();
                g.translate(x, d.y);
                g.rotate(d.rot + Math.sin(t * 0.9 + d.ph) * 0.2);
                g.drawImage(s.spr, -size / 2, -size / 2, size, size);
                g.restore();
            } else {
                const core = glowSprite(env.tint, 24, 0.22, 36);
                g.drawImage(core, x - size / 2, d.y - size / 2, size, size);
            }
        }
        g.globalAlpha = 1;
    },
};

// ── Confetti ─────────────────────────────────────────────────────────────────
// Paper that flutters: each piece flips (its height follows a cosine), so it
// shows its pale back side half the time.
const CONFETTI = ['#25E0C8', '#5E8EE0', '#FFC94D', '#4ADE80', '#FF8FB1', '#FF6B5E', '#B7A4FF'];
interface Paper { x: number; y: number; w: number; h: number; c: number; v: number; ph: number; f: number; rot: number; spin: number }
const confetti: FxProgram<Paper[]> = {
    stock: '#25E0C8',
    blend: 'normal',
    init(env, rand) {
        const n = count(env, lvl(env.opts.n, 16, 28, 44));
        return Array.from({ length: n }, (_, i) => ({ x: rand() * env.w, y: rand() * env.h, w: 4 + rand() * 3, h: 7 + rand() * 4, c: i % CONFETTI.length, v: 22 + rand() * 18, ph: rand() * TAU, f: 2 + rand() * 3, rot: rand() * TAU, spin: (rand() - 0.5) * 3 }));
    },
    frame(g, ps, t, dt, env) {
        for (const p of ps) {
            p.y += p.v * dt;
            p.x += Math.sin(t * 1.3 + p.ph) * 18 * dt;
            p.rot += p.spin * dt;
            if (p.y > env.h + 12) { p.y = -12; p.x = (p.x + 89.1) % env.w; }
            const flip = Math.cos(t * p.f + p.ph);
            g.save();
            g.translate(p.x, p.y);
            g.rotate(p.rot);
            g.scale(1, Math.max(0.08, Math.abs(flip)));
            g.globalAlpha = 0.85;
            g.fillStyle = flip > 0 ? CONFETTI[p.c] : shade(hsl(CONFETTI[p.c]), 18, 1, -25);
            g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            g.restore();
        }
        g.globalAlpha = 1;
    },
};

// ── Bioluminescence ──────────────────────────────────────────────────────────
// Dots asleep in the dark; every few seconds a wave sweeps across from a new
// direction and each dot flares as the front reaches it, then fades.
interface Lume { x: number; y: number; s: number; e: number; wave: number }
const bioluminescence: FxProgram<{ ls: Lume[]; n3: ReturnType<typeof simplex3>; rand: () => number }> = {
    stock: '#5EF2FF',
    init(env, rand) {
        const n = count(env, lvl(env.opts.n, 22, 38, 60));
        return { rand, n3: simplex3(77), ls: Array.from({ length: n }, () => ({ x: rand() * env.w, y: rand() * env.h, s: 0.6 + rand() * 0.8, e: 0.1, wave: -1 })) };
    },
    frame(g, s, t, dt, env) {
        const W = 4.6;
        const k = Math.floor(t / W);
        const age = t - k * W;
        // Seeded origin per wave: a point on the card's edge.
        const a = (Math.sin(k * 12.9898) * 43758.5453) % 1;
        const ang = Math.abs(a) * TAU;
        const ox = env.w / 2 + Math.cos(ang) * env.w * 0.75, oy = env.h / 2 + Math.sin(ang) * env.h * 0.6;
        const front = age * 150;
        const spr = glowSprite(env.tint, 32, 0.12, 34);
        for (const l of s.ls) {
            l.x = wrap(l.x + s.n3(l.x * 0.01, l.y * 0.01, t * 0.05) * 4 * dt, 0, env.w);
            l.y = wrap(l.y + s.n3(l.y * 0.01, 50 + l.x * 0.01, t * 0.05) * 4 * dt, 0, env.h);
            if (l.wave !== k && Math.abs(Math.hypot(l.x - ox, l.y - oy) - front) < 10) { l.e = 1; l.wave = k; }
            l.e = Math.max(0.14 + 0.06 * Math.sin(t * 2 + l.x), l.e * Math.exp(-dt * 0.75));
            const sz = (7 + 16 * l.e) * l.s;
            g.globalAlpha = Math.min(1, l.e * 1.1);
            g.drawImage(spr, l.x - sz / 2, l.y - sz / 2, sz, sz);
        }
        g.globalAlpha = 1;
    },
};

// ── Abyss snow ───────────────────────────────────────────────────────────────
// Marine snow: soft irregular flecks sinking, tumbling, at three depths.
interface Fleck { x: number; y: number; z: number; ph: number }
const abyssSnow: FxProgram<{ fs: Fleck[]; n3: ReturnType<typeof simplex3> }> = {
    stock: '#DCE8FF',
    init(env, rand) {
        const n = count(env, lvl(env.opts.n, 30, 50, 80));
        return { n3: simplex3(31), fs: Array.from({ length: n }, () => ({ x: rand() * env.w, y: rand() * env.h, z: 0.2 + rand() * 0.8, ph: rand() * TAU })) };
    },
    frame(g, s, t, dt, env) {
        const v = lvl(env.opts.s, 0.6, 1, 1.5);
        const spr = sprite('fleck', 16, 16, (c) => {
            const gr = c.createRadialGradient(8, 8, 0, 8, 8, 8);
            gr.addColorStop(0, 'rgba(232,240,255,.95)'); gr.addColorStop(0.4, 'rgba(220,232,255,.5)'); gr.addColorStop(1, 'rgba(220,232,255,0)');
            c.fillStyle = gr; c.beginPath(); c.ellipse(8, 8, 8, 5.5, 0.6, 0, TAU); c.fill();
        });
        for (const f of s.fs) {
            f.y += (5 + 15 * f.z) * v * dt;
            f.x += s.n3(f.x * 0.01, f.y * 0.01, t * 0.06) * 6 * f.z * dt;
            if (f.y > env.h + 8) { f.y = -8; f.x = (f.x + 71.3) % env.w; }
            const sz = 2 + f.z * 5;
            g.globalAlpha = 0.18 + 0.55 * f.z;
            g.save();
            g.translate(f.x, f.y);
            g.rotate(t * 0.6 * (f.z - 0.5) + f.ph);
            g.drawImage(spr, -sz / 2, -sz / 2, sz, sz);
            g.restore();
        }
        g.globalAlpha = 1;
    },
};

// ── Shooting stars ───────────────────────────────────────────────────────────
// A night sky in the banner (twinkling, fading into the card) and, every few
// seconds, a meteor with a tapered, glowing tail.
interface Star { x: number; y: number; m: number; ph: number; f: number }
const shootingStars: FxProgram<{ ss: Star[] }> = {
    stock: '#CFE3FF',
    init(env, rand) {
        const n = count(env, lvl(env.opts.n, 24, 40, 64));
        return { ss: Array.from({ length: n }, () => ({ x: rand() * env.w, y: Math.pow(rand(), 1.6) * (env.banner + 70), m: rand(), ph: rand() * TAU, f: 0.8 + rand() * 2 })) };
    },
    frame(g, s, t, _dt, env) {
        const spr = glowSprite(hsl('#E8F0FF'), 12, 0.25, 30);
        for (const st of s.ss) {
            const fade = st.y < env.banner ? 1 : Math.max(0, 1 - (st.y - env.banner) / 70);
            const tw = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * st.f + st.ph));
            const sz = 2 + st.m * 3.5;
            g.globalAlpha = tw * fade * (0.35 + 0.65 * st.m);
            g.drawImage(spr, st.x - sz / 2, st.y - sz / 2, sz, sz);
        }
        // Meteors: one every ~3.1 s, seeded per index so they never repeat a path.
        const P = 3.1, life = 0.95;
        for (let k = Math.floor((t - life) / P); k <= Math.floor(t / P); k++) {
            const age = t - k * P - ((Math.abs(Math.sin(k * 7.13)) * 1.4) % 1.4);
            if (age < 0 || age > life) continue;
            const r1 = Math.abs(Math.sin(k * 3.7) * 1000) % 1, r2 = Math.abs(Math.sin(k * 9.1) * 1000) % 1;
            const ang = Math.PI * (0.8 + r2 * 0.12);
            const x0 = env.w * (0.45 + r1 * 0.6), y0 = env.banner * (0.05 + r2 * 0.4);
            const u = age / life;
            const dist = 420 * age;
            const hx = x0 + Math.cos(ang) * dist, hy = y0 + Math.sin(ang) * dist;
            const len = 80 * Math.sin(Math.PI * Math.min(1, u * 1.2));
            const tx = hx - Math.cos(ang) * len, ty = hy - Math.sin(ang) * len;
            const a = Math.sin(Math.PI * u);
            const grad = g.createLinearGradient(tx, ty, hx, hy);
            grad.addColorStop(0, shade(env.tint, 10, 0));
            grad.addColorStop(1, shade(env.tint, 26, 0.95 * a));
            g.globalAlpha = 1;
            g.strokeStyle = grad; g.lineCap = 'round';
            g.lineWidth = 1.6; g.beginPath(); g.moveTo(tx, ty); g.lineTo(hx, hy); g.stroke();
            g.globalAlpha = a;
            const head = glowSprite(env.tint, 24, 0.16, 36);
            g.drawImage(head, hx - 7, hy - 7, 14, 14);
        }
        g.globalAlpha = 1;
    },
};

// ── Aurora ───────────────────────────────────────────────────────────────────
// Curtains of light: per column, a ray from a folding baseline upward, its
// brightness travelling sideways along the curtain (the "rays" you see move).
// Colour follows the real thing: the lower edge greenest, the tops shifting.
// Rendered as LIGHT into a small float buffer (the frame is 0.36x, so ~120
// columns): per column and layer, a ray from the baseline up, coloured by a
// lookup table (bright lower edge, shifting hue towards the top), added in.
// One putImageData a frame; individual canvas draws per column cost ~10-16 ms.
const LUT = 64;
interface Aurora {
    n3: ReturnType<typeof simplex3>;
    lut: Float32Array[];
    acc: Float32Array | null;
    img: ImageData | null;
}
function auroraLut(base: HSL, layer: number): Float32Array {
    const stops: Array<[number, HSL, number]> = [
        [0, base, 0],
        [0.06, { ...base, l: Math.min(100, base.l + 18) }, 0.95],
        [0.28, { ...base, l: Math.min(100, base.l + 4) }, 0.55],
        [0.65, { ...base, h: base.h + (layer === 0 ? 60 : -40) }, 0.22],
        [1, { ...base, h: base.h + (layer === 0 ? 110 : layer === 1 ? -50 : 70), l: base.l + 4 }, 0],
    ];
    const out = new Float32Array(LUT * 3);
    for (let i = 0; i < LUT; i++) {
        const u = i / (LUT - 1);
        let k = 0;
        while (k < stops.length - 2 && u > stops[k + 1][0]) k++;
        const [u0, c0, a0] = stops[k], [u1, c1, a1] = stops[k + 1];
        const f = Math.min(1, Math.max(0, (u - u0) / (u1 - u0)));
        const r0 = hslToRgb(c0), r1 = hslToRgb(c1);
        const a = a0 + (a1 - a0) * f;
        for (let ch = 0; ch < 3; ch++) out[i * 3 + ch] = (r0[ch] + (r1[ch] - r0[ch]) * f) * a;
    }
    return out;
}
const aurora: FxProgram<Aurora> = {
    stock: '#5CFF9D',
    lowRes: 0.36,
    cssBlur: 0.6,
    fps: 30,
    init(env) {
        const base = hsl(AURORA_COLOURS[Math.max(0, Math.min(3, env.opts.c ?? 0))][1]);
        return { n3: simplex3(99), lut: [0, 1, 2].map((l) => auroraLut(base, l)), acc: null, img: null };
    },
    frame(g, s, t, _dt, env) {
        const spd = lvl(env.opts.s, 0.55, 1, 1.6);
        const gain = lvl(env.opts.i, 0.7, 1, 1.35);
        const base = hsl(AURORA_COLOURS[Math.max(0, Math.min(3, env.opts.c ?? 0))][1]);
        // The curtains only ever occupy the band above banner + 40: buffer just that.
        const cw = g.canvas.width, sc = cw / env.w;
        const rows = Math.min(g.canvas.height, Math.ceil((env.banner + 40) * sc));
        if (!s.img || s.img.width !== cw || s.img.height !== rows) {
            s.img = g.createImageData(cw, rows);
            s.acc = new Float32Array(cw * rows * 3);
        }
        const acc = s.acc!;
        acc.fill(0);
        for (let layer = 0; layer < 3; layer++) {
            const lut = s.lut[layer];
            // One column per low-res pixel; the layer is softened by the compositor (cssBlur).
            for (let px = 0; px < cw; px++) {
                const x = px / sc;
                const fold = s.n3(x * 0.005, layer * 7.1, t * 0.04 * spd);
                const yb = env.banner * (0.62 + 0.14 * layer) + 22 * fold + 6 * Math.sin(x * 0.03 + t * 0.4 * spd + layer);
                const H = (46 + 60 * (0.5 + 0.5 * s.n3(x * 0.008, layer * 3.3 + 1, t * 0.06 * spd))) * (1 - layer * 0.18);
                const ray = 0.5 + 0.5 * s.n3(x * 0.035 - t * 0.35 * spd, layer * 11.7, t * 0.12 * spd);
                const b = ray * ray * (1 - layer * 0.2) * gain;
                if (b < 0.02) continue;
                const top = Math.max(0, Math.floor((yb - H) * sc)), bot = Math.min(rows - 1, Math.ceil((yb + 2) * sc));
                const inv = (LUT - 1) / (H * sc), ybs = yb * sc;
                for (let py = top; py <= bot; py++) {
                    const li = Math.round((ybs - py) * inv);
                    if (li < 0 || li >= LUT) continue;
                    const l3 = li * 3, o = (py * cw + px) * 3;
                    const r = lut[l3] * b, gg = lut[l3 + 1] * b, bb = lut[l3 + 2] * b;
                    acc[o] += r; acc[o + 1] += gg; acc[o + 2] += bb;
                }
            }
        }
        // Light -> RGBA (un-premultiplied; alpha = the brightest channel), packed 32 bits at a time.
        const px32 = new Uint32Array(s.img.data.buffer);
        for (let i = 0, o = 0; i < px32.length; i++, o += 3) {
            const r = acc[o], gg = acc[o + 1], bb = acc[o + 2];
            const m = r > gg ? (r > bb ? r : bb) : (gg > bb ? gg : bb);
            if (m < 1) { px32[i] = 0; continue; }
            const k = 255 / m, a = m > 255 ? 255 : m;
            px32[i] = ((a & 255) << 24 | ((bb * k) & 255) << 16 | ((gg * k) & 255) << 8 | ((r * k) & 255)) >>> 0;
        }
        g.putImageData(s.img, 0, 0);
        g.globalCompositeOperation = 'lighter';
        // The glow it casts down onto the card.
        g.globalAlpha = 1;
        const wash = g.createLinearGradient(0, env.banner * 0.6, 0, env.banner + 120);
        wash.addColorStop(0, shade(base, 0, 0.16 * gain));
        wash.addColorStop(1, shade(base, 0, 0));
        g.fillStyle = wash;
        g.fillRect(0, env.banner * 0.6, env.w, env.banner * 0.4 + 120);
        g.globalCompositeOperation = 'source-over';
    },
};

// ── Shoal ────────────────────────────────────────────────────────────────────
// Boids (separation, alignment, cohesion) orbiting the avatar. Fish catch the
// light as they turn: brightness follows heading, so the school flashes.
interface Fish { x: number; y: number; vx: number; vy: number; ph: number }
/**
 * The leader: an ellipse AROUND the avatar (it must never cross it - the
 * avatar repels the fish, and a leader passing over it splits the school into
 * groups that never rejoin), breathing in size so the loop never repeats exactly.
 */
function shoalTarget(env: FxEnv, t: number): [number, number] {
    const a = t * 0.26 + 0.5 * Math.sin(t * 0.07);
    const k = 1 + 0.12 * Math.sin(t * 0.13);
    const rx = Math.min(Math.max(env.avatar.r + 40, env.w * 0.36), env.w * 0.42) * k;
    const ry = Math.min(Math.max(env.avatar.r + 40, Math.min(env.h * 0.28, 130)), env.h * 0.4) * k;
    return [env.avatar.x + rx * Math.cos(a), env.avatar.y + Math.min(30, env.h * 0.1) + ry * Math.sin(a)];
}
const shoal: FxProgram<{ fs: Fish[]; n3: ReturnType<typeof simplex3> }> = {
    stock: '#BFE9FF',
    preroll: 3,
    init(env, rand) {
        const n = count(env, lvl(env.opts.n, 26, 42, 64));
        const [tx, ty] = shoalTarget(env, 0);
        return {
            n3: simplex3(42),
            fs: Array.from({ length: n }, () => {
                const a = rand() * TAU, d = rand() * 34;
                return { x: tx + Math.cos(a) * d, y: ty + Math.sin(a) * d * 0.6, vx: 60, vy: 0, ph: rand() * TAU };
            }),
        };
    },
    frame(g, s, t, dt, env) {
        // The school chases a leader point on a slow Lissajous loop around the avatar.
        const [tx, ty] = shoalTarget(env, t);
        const fs = s.fs;
        for (const f of fs) {
            let cx = 0, cy = 0, avx = 0, avy = 0, sx = 0, sy = 0, nb = 0;
            for (const o of fs) {
                if (o === f) continue;
                const dx = o.x - f.x, dy = o.y - f.y, d2 = dx * dx + dy * dy;
                if (d2 < 2500) { cx += o.x; cy += o.y; avx += o.vx; avy += o.vy; nb++; if (d2 < 196) { sx -= dx / (d2 + 1); sy -= dy / (d2 + 1); } }
            }
            let fx = 0, fy = 0;
            if (nb) { fx += (cx / nb - f.x) * 0.9 + (avx / nb - f.vx) * 1.4; fy += (cy / nb - f.y) * 0.9 + (avy / nb - f.vy) * 1.4; }
            fx += sx * 1300; fy += sy * 1300;
            const dx = tx - f.x, dy = ty - f.y, d = Math.hypot(dx, dy) || 1;
            // Seek (desired velocity minus current): converges on the leader without orbiting wide.
            const want = Math.min(80, 18 + d * 1.6);
            fx += ((dx / d) * want - f.vx) * 2.2; fy += ((dy / d) * want - f.vy) * 2.2;
            // Keep clear of the avatar itself.
            const ax = f.x - env.avatar.x, ay = f.y - env.avatar.y, da = Math.hypot(ax, ay) || 1;
            if (env.h >= 200 && da < env.avatar.r + 16) { fx += (ax / da) * 260; fy += (ay / da) * 260; }
            const w = s.n3(f.x * 0.012, f.y * 0.012, t * 0.25) * 30;
            fx += Math.cos(f.ph) * w; fy += Math.sin(f.ph) * w;
            f.vx += fx * dt; f.vy += fy * dt;
            const sp = Math.hypot(f.vx, f.vy) || 1, cl = Math.max(26, Math.min(80, sp));
            f.vx = (f.vx / sp) * cl; f.vy = (f.vy / sp) * cl;
            f.x += f.vx * dt; f.y += f.vy * dt;
        }
        const body = sprite(`fish|${env.tint.h.toFixed(0)}`, 18, 8, (c) => {
            c.fillStyle = shade(env.tint, 14);
            c.beginPath(); c.moveTo(17, 4); c.quadraticCurveTo(12, 0.6, 5, 2.6); c.lineTo(0.5, 0.5); c.lineTo(2.4, 4); c.lineTo(0.5, 7.5); c.lineTo(5, 5.4); c.quadraticCurveTo(12, 7.4, 17, 4); c.fill();
            c.fillStyle = 'rgba(255,255,255,.7)'; c.fillRect(8, 3.4, 7, 1);
        });
        for (const f of fs) {
            const a = Math.atan2(f.vy, f.vx);
            const flash = Math.pow(Math.abs(Math.cos(a - t * 0.15 - 0.6)), 8);
            g.globalAlpha = 0.46 + 0.54 * flash;
            g.save();
            g.translate(f.x, f.y); g.rotate(a);
            g.drawImage(body, -10, -3.6, 15, 6.6);
            g.restore();
        }
        g.globalAlpha = 1;
    },
};

// ── Whale song ───────────────────────────────────────────────────────────────
// A great whale far below, its body built along an undulating spine, rim-lit
// from above, crossing the card every ~45 s; every few seconds its song rings
// out as arcs from its head.
interface Whale { n3: ReturnType<typeof simplex3>; flecks: Fleck[] }
const whaleSong: FxProgram<Whale> = {
    stock: '#7FB8FF',
    fps: 40,
    init(env, rand) {
        return { n3: simplex3(8), flecks: Array.from({ length: count(env, 28) }, () => ({ x: rand() * env.w, y: rand() * env.h, z: 0.2 + rand() * 0.6, ph: 0 })) };
    },
    frame(g, s, t, dt, env) {
        const blue = env.opts.p === 1;
        const L = env.w * (blue ? 0.92 : 0.7);
        const P = 46;
        // Phase-shifted so a fresh card (and the reduced-motion still) already shows the whale.
        const u = ((t + P * 0.42) % P) / P;
        const hx = env.w + L * 0.15 - u * (env.w + L * 1.4);
        const yc = env.h * 0.78 + 8 * Math.sin(t * 0.21);
        const N = 26;
        const top: Array<[number, number]> = [], bot: Array<[number, number]> = [];
        let headY = yc;
        for (let i = 0; i <= N; i++) {
            const sN = i / N;
            const x = hx + sN * L;
            const y = yc + (blue ? 5 : 7) * sN * sN * Math.sin(TAU * t * 0.22 - sN * 3.2);
            if (i === 0) headY = y;
            // Thickness profile: a blunt head, the widest point a third back, a thin peduncle.
            const th = (blue ? 0.085 : 0.14) * L * Math.pow(Math.sin(Math.PI * Math.min(1, sN * 1.08 + 0.04)), 0.75) * (1 - 0.55 * sN);
            top.push([x, y - th * 0.95]);
            bot.push([x, y + th * 1.05]);
        }
        const tailX = hx + L, tailY = yc + (blue ? 5 : 7) * Math.sin(TAU * t * 0.22 - 3.2);
        const fl = 0.11 * L, flap = Math.sin(TAU * t * 0.22 - 3.6) * 0.5;
        const path = new Path2D();
        path.moveTo(top[0][0], top[0][1]);
        for (let i = 1; i <= N; i++) path.lineTo(top[i][0], top[i][1]);
        path.lineTo(tailX + fl * 0.5, tailY - fl * (0.75 + flap));
        path.quadraticCurveTo(tailX + fl * 0.2, tailY, tailX + fl * 0.5, tailY + fl * (0.75 - flap));
        for (let i = N; i >= 0; i--) path.lineTo(bot[i][0], bot[i][1]);
        path.closePath();
        const body = g.createLinearGradient(0, yc - 0.1 * L, 0, yc + 0.1 * L);
        body.addColorStop(0, shade(env.tint, 18, 0.2));
        body.addColorStop(0.5, shade(env.tint, 0, 0.08));
        body.addColorStop(1, shade(env.tint, -10, 0.03));
        g.fillStyle = body;
        g.fill(path);
        // Rim light along the back.
        g.beginPath();
        for (let i = 0; i <= N; i++) { if (i === 0) g.moveTo(top[i][0], top[i][1]); else g.lineTo(top[i][0], top[i][1]); }
        g.strokeStyle = shade(env.tint, 26, 0.5); g.lineWidth = 1.2; g.stroke();
        // Pectoral fin (long on a humpback).
        const pi = Math.round(N * 0.3);
        const [px, py] = bot[pi];
        const fa = 0.7 + 0.25 * Math.sin(t * 0.5);
        const pl = (blue ? 0.12 : 0.3) * L;
        g.beginPath();
        g.moveTo(px - 4, py - 2);
        g.quadraticCurveTo(px + pl * 0.3, py + pl * Math.sin(fa) * 0.6, px + pl * Math.cos(fa), py + pl * Math.sin(fa));
        g.quadraticCurveTo(px + pl * 0.45, py + pl * Math.sin(fa) * 0.4, px + 8, py);
        g.fillStyle = shade(env.tint, 10, 0.14); g.fill();
        g.strokeStyle = shade(env.tint, 22, 0.3); g.lineWidth = 0.8; g.stroke();
        if (!blue) {
            g.strokeStyle = shade(env.tint, 20, 0.12); g.lineWidth = 0.7;
            for (let k = 1; k <= 4; k++) {
                g.beginPath();
                for (let i = 1; i <= Math.round(N * 0.45); i++) { const yy = bot[i][1] - k * 2.2; if (i === 1) g.moveTo(bot[i][0], yy); else g.lineTo(bot[i][0], yy); }
                g.stroke();
            }
        }
        // Eye.
        g.globalAlpha = 0.9;
        g.drawImage(glowSprite(env.tint, 16, 0.25, 36), top[2][0] - 3, headY - 3, 6, 6);
        g.globalAlpha = 1;
        // Song: arcs from the head every 6.5 s.
        const S = 6.5;
        for (let k = Math.floor((t - 4) / S); k <= Math.floor(t / S); k++) {
            const age = t - k * S;
            if (age < 0 || age > 4) continue;
            for (let r = 0; r < 3; r++) {
                const a2 = age - r * 0.35;
                if (a2 < 0) continue;
                const rad = 10 + a2 * 46;
                const al = Math.pow(1 - a2 / 4, 2) * 0.45;
                g.strokeStyle = shade(env.tint, 20, al); g.lineWidth = 1.2;
                g.beginPath(); g.arc(hx - 4, headY, rad, Math.PI * 0.8, Math.PI * 1.35); g.stroke();
            }
        }
        const spr = glowSprite(hsl('#DCE8FF'), 12, 0.25, 20);
        for (const f of s.flecks) {
            f.y = wrap(f.y + (3 + 6 * f.z) * dt, -4, env.h + 4);
            g.globalAlpha = 0.15 + 0.35 * f.z;
            g.drawImage(spr, f.x - 1.5, f.y - 1.5, 3, 3);
        }
        g.globalAlpha = 1;
    },
};

// ── Web of trust ─────────────────────────────────────────────────────────────
// A constellation around you: drifting nodes, links that fade in with
// proximity, and light passing node to node along the links (trust, travelling).
interface Node { hx: number; hy: number; x: number; y: number; flare: number }
interface Pulse { a: number; b: number; u: number }
const webOfTrust: FxProgram<{ ns: Node[]; ps: Pulse[]; n3: ReturnType<typeof simplex3>; next: number; rand: () => number }> = {
    stock: '#25E0C8',
    init(env, rand) {
        const n = count(env, lvl(env.opts.n, 13, 20, 30));
        const ns: Node[] = [];
        for (let i = 0; i < n * 4 && ns.length < n; i++) {
            const x = 10 + rand() * (env.w - 20), y = 10 + rand() * (env.h - 20);
            if (Math.hypot(x - env.avatar.x, y - env.avatar.y) < env.avatar.r + 18) continue;
            if (ns.some((m) => Math.hypot(m.hx - x, m.hy - y) < 34)) continue;
            ns.push({ hx: x, hy: y, x, y, flare: 0 });
        }
        return { ns, ps: [], n3: simplex3(3), next: 0.4, rand };
    },
    frame(g, s, t, dt, env) {
        const D = 104;
        const { x: ax, y: ay, r: ar } = env.avatar;
        for (const [i, nd] of s.ns.entries()) {
            nd.x = nd.hx + 9 * s.n3(i * 3.1, 0, t * 0.08);
            nd.y = nd.hy + 9 * s.n3(i * 3.1, 5, t * 0.08);
            nd.flare *= Math.exp(-dt * 2);
        }
        const edges: Array<[number, number, number]> = [];
        g.lineWidth = 0.8;
        for (let i = 0; i < s.ns.length; i++) {
            const a = s.ns[i];
            const da = Math.hypot(a.x - ax, a.y - ay);
            if (da < ar + 80) {
                const q = 1 - (da - ar) / 80;
                const ex = ax + ((a.x - ax) / da) * (ar + 6), ey = ay + ((a.y - ay) / da) * (ar + 6);
                g.strokeStyle = shade(env.tint, 10, 0.6 * q);
                g.beginPath(); g.moveTo(ex, ey); g.lineTo(a.x, a.y); g.stroke();
                edges.push([-1, i, q]);
            }
            for (let j = i + 1; j < s.ns.length; j++) {
                const b = s.ns[j];
                const d = Math.hypot(a.x - b.x, a.y - b.y);
                if (d > D) continue;
                const q = Math.pow(1 - d / D, 1.4);
                g.strokeStyle = shade(env.tint, 6, 0.52 * q);
                g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
                edges.push([i, j, q]);
            }
        }
        // Light travelling along the links, mostly out from you.
        s.next -= dt;
        if (s.next <= 0 && edges.length) {
            const own = edges.filter((e) => e[0] === -1);
            const pool = own.length && s.rand() < 0.55 ? own : edges;
            const e = pool[Math.floor(s.rand() * pool.length)];
            s.ps.push(s.rand() < 0.5 || e[0] === -1 ? { a: e[0], b: e[1], u: 0 } : { a: e[1], b: e[0], u: 0 });
            s.next = 0.35 + s.rand() * 0.6;
        }
        const pos = (i: number, toward: Node): [number, number] => {
            if (i >= 0) return [s.ns[i].x, s.ns[i].y];
            const d = Math.hypot(toward.x - ax, toward.y - ay) || 1;
            return [ax + ((toward.x - ax) / d) * (ar + 6), ay + ((toward.y - ay) / d) * (ar + 6)];
        };
        const glow = glowSprite(env.tint, 32, 0.14, 36);
        s.ps = s.ps.filter((p) => {
            const B = s.ns[p.b < 0 ? p.a : p.b];
            const [x1, y1] = pos(p.a, B), [x2, y2] = pos(p.b, s.ns[p.a < 0 ? p.b : p.a]);
            const len = Math.hypot(x2 - x1, y2 - y1) || 1;
            p.u += (110 / len) * dt;
            if (p.u >= 1) { if (p.b >= 0) s.ns[p.b].flare = 1; return false; }
            const x = x1 + (x2 - x1) * p.u, y = y1 + (y2 - y1) * p.u;
            g.globalAlpha = 0.9;
            g.drawImage(glow, x - 6, y - 6, 12, 12);
            return true;
        });
        for (const nd of s.ns) {
            const sz = 9 + 12 * nd.flare;
            g.globalAlpha = 0.55 + 0.45 * nd.flare;
            g.drawImage(glow, nd.x - sz / 2, nd.y - sz / 2, sz, sz);
        }
        g.globalAlpha = 1;
    },
};

// ── Ghost lights ─────────────────────────────────────────────────────────────
// Will-o'-the-wisps wandering on noise paths, flickering, trailing light;
// a low mist drifts along the bottom of the card.
interface Wisp { hx: Float32Array; hy: Float32Array; head: number; k: number }
const WT = 22;
const ghostLights: FxProgram<{ ws: Wisp[]; n3: ReturnType<typeof simplex3>; acc: number; col: HSL }> = {
    stock: '#9DFFCF',
    preroll: 1.5,
    init(env) {
        const n = lvl(env.opts.n, 4, 6, 9);
        const col = hsl(GHOST_COLOURS[Math.max(0, Math.min(2, env.opts.c ?? 0))][1]);
        return { col, n3: simplex3(13), acc: 0, ws: Array.from({ length: n }, (_, k) => ({ hx: new Float32Array(WT).fill(env.w / 2), hy: new Float32Array(WT).fill(env.h / 2), head: 0, k })) };
    },
    frame(g, s, t, dt, env) {
        // Mist: one pre-drawn band, scrolled.
        // Horizontally seamless (each puff is drawn wrapped), vertically clear of both edges.
        const mist = sprite(`mist|${s.col.h}`, 256, 64, (c) => {
            for (let i = 0; i < 8; i++) {
                const x = (i / 8) * 256 + 9, y = 42 + Math.sin(i * 2.3) * 6, r = 18 + (i % 3) * 3;
                for (const dx of [-256, 0, 256]) {
                    c.save();
                    c.translate(x + dx, y); c.scale(2.6, 1);
                    const gr = c.createRadialGradient(0, 0, 0, 0, 0, r);
                    gr.addColorStop(0, shade(s.col, 10, 0.13)); gr.addColorStop(1, shade(s.col, 0, 0));
                    c.fillStyle = gr; c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
                    c.restore();
                }
            }
        });
        const off = (t * 9) % env.w;
        g.globalAlpha = 0.9;
        g.drawImage(mist, -off, env.h - 70, env.w, 80);
        g.drawImage(mist, env.w - off, env.h - 70, env.w, 80);
        s.acc += dt;
        const sample = s.acc >= 1 / 30;
        if (sample) s.acc = 0;
        const spr = glowSprite(s.col, 48, 0.12, 34);
        for (const w of s.ws) {
            const x = env.w * (0.5 + 0.46 * s.n3(w.k * 13.3, 0, t * 0.055));
            const y = env.h * (0.55 + 0.42 * s.n3(w.k * 7.7, 100, t * 0.045));
            if (sample) { w.head = (w.head + 1) % WT; w.hx[w.head] = x; w.hy[w.head] = y; }
            const flick = 0.65 + 0.35 * s.n3(w.k, 9, t * 2.2);
            for (let i = WT - 1; i >= 1; i -= 2) {
                const idx = (w.head - i + WT) % WT;
                const q = 1 - i / WT;
                g.globalAlpha = 0.18 * q * flick;
                const sz = 6 + 10 * q;
                g.drawImage(spr, w.hx[idx] - sz / 2, w.hy[idx] - sz / 2, sz, sz);
            }
            g.globalAlpha = flick;
            g.drawImage(spr, x - 15, y - 15, 30, 30);
        }
        g.globalAlpha = 1;
    },
};

// ── First snow ───────────────────────────────────────────────────────────────
// Large six-fold flakes, every one drawn from a different branch pattern;
// near ones bigger and slightly out of focus, all turning as they fall.
interface Flake { x: number; y: number; z: number; rot: number; vr: number; v: number; kind: number; ph: number }
function flakeSprite(kind: number, blur: boolean): HTMLCanvasElement {
    return sprite(`flake|${kind}|${blur ? 1 : 0}`, 48, 48, (c) => {
        c.translate(24, 24);
        if (blur) c.filter = 'blur(1.2px)';
        c.strokeStyle = 'rgba(240,248,255,.95)';
        c.lineCap = 'round';
        const R = 19;
        for (let i = 0; i < 6; i++) {
            c.save();
            c.rotate(i * Math.PI / 3);
            c.lineWidth = 1.8;
            c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -R); c.stroke();
            c.lineWidth = 1.3;
            const bs = kind === 0 ? [0.4, 0.7] : kind === 1 ? [0.55] : kind === 2 ? [0.3, 0.55, 0.8] : [0.62];
            for (const b of bs) {
                const l = R * (kind === 3 ? 0.38 : (1 - b) * 0.55);
                c.beginPath(); c.moveTo(0, -R * b); c.lineTo(-l, -R * b - l * 0.8); c.moveTo(0, -R * b); c.lineTo(l, -R * b - l * 0.8); c.stroke();
            }
            if (kind === 1) { c.beginPath(); c.arc(0, -R * 0.25, 2.2, 0, TAU); c.stroke(); }
            c.restore();
        }
        c.fillStyle = 'rgba(240,248,255,.9)';
        c.beginPath(); c.arc(0, 0, 2.4, 0, TAU); c.fill();
    });
}
const firstSnow: FxProgram<Flake[]> = {
    stock: '#E8F4FF',
    blend: 'normal',
    init(env, rand) {
        const n = count(env, lvl(env.opts.n, 12, 20, 32));
        return Array.from({ length: n }, () => {
            const z = 0.25 + rand() * 0.75;
            return { x: rand() * env.w, y: rand() * env.h, z, rot: rand() * TAU, vr: (rand() - 0.5) * 0.8, v: 8 + 20 * z, kind: Math.floor(rand() * 4), ph: rand() * TAU };
        });
    },
    frame(g, fs, t, dt, env) {
        const sp = lvl(env.opts.s, 0.6, 1, 1.5);
        for (const f of fs) {
            f.y += f.v * sp * dt;
            f.rot += f.vr * dt;
            const size = 7 + f.z * 15;
            if (f.y > env.h + size) { f.y = -size; f.x = (f.x + 113.3) % env.w; }
            const x = f.x + Math.sin(t * 0.6 + f.ph) * 12 * f.z;
            g.globalAlpha = 0.3 + 0.55 * f.z;
            g.save();
            g.translate(x, f.y); g.rotate(f.rot);
            g.drawImage(flakeSprite(f.kind, f.z > 0.82), -size / 2, -size / 2, size, size);
            g.restore();
        }
        g.globalAlpha = 1;
    },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each program has its own state type; the runtime treats it as opaque
export const EFFECT_PROGRAMS: Readonly<Record<string, FxProgram<any>>> = {
    'bubbles': bubbles,
    'glimmer': glimmer,
    'plankton': plankton,
    'sonar': sonar,
    'current': current,
    'god-rays': godRays,
    'keepsake-rain': keepsakeRain,
    'confetti': confetti,
    'bioluminescence': bioluminescence,
    'abyss-snow': abyssSnow,
    'shooting-stars': shootingStars,
    'aurora': aurora,
    'shoal': shoal,
    'whale-song': whaleSong,
    'web-of-trust': webOfTrust,
    'ghost-lights': ghostLights,
    'first-snow': firstSnow,
};
