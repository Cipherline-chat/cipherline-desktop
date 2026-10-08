/**
 * The pure half of the loading screen's easter-egg game: its rules, and how
 * far each pillar has built itself out of the dot field.
 * No DOM, no GL, no timers — the worker (workers/loadingScreen.worker.ts)
 * owns the clock and the drawing; this file is what the tests can pin down.
 *
 * THE GAME — "Firewall". Keys is a jellyfish, so he swims the way one does:
 * every Space is one stroke upward, and between strokes he sinks. Pillars of
 * fine dots — the background field, packed tight — scroll in from the right,
 * building themselves out of the field as they come, each with one gap; swim
 * through the gap, score a point. Touch a wall or the sea floor and he
 * scatters into dots. The gaps stay the same size for the whole run; only the
 * speed climbs, a little with every point, with no ceiling.
 *
 * Units: the game lives in "U", where 1 U is half the canvas height. y is up,
 * 0 is the vertical centre, so the playfield runs y = -1 (floor) to +1 (the
 * top edge). Pillars run off both edges; Keys and the gaps stay below
 * RULES.top, so he never swims up under the score strip;
 * x is 0 at the centre and ±halfW at the edges (halfW = width / height).
 */

/* ── The game ─────────────────────────────────────────────────────────────── */

export const RULES = {
    gravity: 3.4, // U/s²
    flap: 1.12, // U/s: what one stroke's thrust brings his rise to (set, not added)
    thrust: 0.09, // s: the stroke eases him to that speed over a few frames, never a snap
    maxFall: 1.7, // U/s
    radius: 0.085, // Keys' hitbox: he is drawn 0.2 tall and ~0.21 wide, so a near miss of ~0.015 still counts
    wallW: 0.15,
    spacing: 0.95, // between walls
    speed0: 0.55, speedPerPoint: 0.012, // scroll, U/s: the start, and what each point adds (never capped)
    gap0: 0.66, // gap height: constant, it never narrows
    margin: 0.14, // a gap never hugs the top or the floor
    top: 0.84, // Keys' ceiling, and the highest a gap reaches: the top 8% of the window holds the score
    maxStep: 0.7, // a gap never jumps further than this from the last one
    slots: 8, // walls alive at once (the worker has room for this many)
    retryAfter: 0.5, // s after a crash before Space starts a new run
} as const;

export type GameMode = 'idle' | 'playing' | 'over';

export interface Wall { x: number; gap: number; gapH: number; passed: boolean; live: boolean }

export interface Game {
    mode: GameMode;
    y: number;
    vy: number;
    /** Seconds of stroke thrust left: vy eases toward RULES.flap meanwhile. */
    thrust: number;
    score: number;
    best: number;
    speed: number;
    walls: Wall[];
    /** Seconds since the run started / since the crash. */
    t: number;
    seed: number;
}

/** Mulberry32 — seeded, so a run's gaps are reproducible in tests. */
function rand(g: Game): number {
    let t = (g.seed = (g.seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function newGame(best = 0, seed = 1): Game {
    return {
        mode: 'idle', y: 0, vy: 0, thrust: 0, score: 0, best, speed: RULES.speed0, t: 0, seed,
        walls: Array.from({ length: RULES.slots }, () => ({ x: 0, gap: 0, gapH: RULES.gap0, passed: false, live: false })),
    };
}

/** Where Keys swims: a fixed column on the left, never too far from centre. */
export function keysX(halfW: number): number {
    return -Math.min(halfW * 0.5, 0.95);
}

const speedFor = (score: number) => RULES.speed0 + score * RULES.speedPerPoint;

function placeWall(g: Game, w: Wall, x: number, prevGap: number): void {
    const gapH = RULES.gap0;
    // the gap's centre stays within [lo, hi]: never against the floor or the ceiling
    const lo = -1 + gapH / 2 + RULES.margin, hi = RULES.top - gapH / 2 - RULES.margin;
    const mid = (lo + hi) / 2, lim = (hi - lo) / 2;
    let gap = mid + (rand(g) * 2 - 1) * lim;
    gap = Math.max(prevGap - RULES.maxStep, Math.min(prevGap + RULES.maxStep, gap));
    w.x = x;
    w.gap = Math.max(lo, Math.min(hi, gap));
    w.gapH = gapH;
    w.passed = false;
    w.live = true;
}

/** A fresh run from height y0. The first pulse is the key that started it. */
export function startRun(g: Game, halfW: number, y0: number): number[] {
    g.mode = 'playing';
    g.y = y0;
    g.vy = 0;
    g.thrust = RULES.thrust;
    g.score = 0;
    g.t = 0;
    g.speed = speedFor(0);
    const needed = Math.min(RULES.slots, Math.ceil((2 * halfW + RULES.wallW) / RULES.spacing) + 1);
    let prev = 0;
    g.walls.forEach((w, i) => {
        if (i < needed) {
            placeWall(g, w, halfW + 0.5 + i * RULES.spacing, prev);
            prev = w.gap;
        } else {
            w.live = false;
        }
    });
    return g.walls.map((_, i) => i);
}

/** Space / click. Returns what it did, so the caller can redraw. */
export function act(g: Game, halfW: number, y0: number): 'start' | 'flap' | 'wait' {
    if (g.mode === 'playing') { g.thrust = RULES.thrust; return 'flap'; }
    if (g.mode === 'over' && g.t < RULES.retryAfter) return 'wait';
    startRun(g, halfW, y0);
    return 'start';
}

/** Esc: leave the game (back to the loading screen). */
export function quit(g: Game): void {
    g.mode = 'idle';
    g.walls.forEach(w => { w.live = false; });
}

function hitsWall(y: number, kx: number, w: Wall): boolean {
    const r = RULES.radius;
    const x0 = w.x - RULES.wallW / 2, x1 = w.x + RULES.wallW / 2;
    const nx = Math.max(x0, Math.min(x1, kx));
    const dx = kx - nx;
    if (Math.abs(dx) >= r) return false;
    const lo = w.gap - w.gapH / 2, hi = w.gap + w.gapH / 2;
    // nearest point of the lower slab [-inf, lo] and the upper one [hi, inf]
    const dyLo = y > lo ? y - lo : 0;
    const dyHi = y < hi ? hi - y : 0;
    return dx * dx + dyLo * dyLo < r * r || dx * dx + dyHi * dyHi < r * r;
}

export interface StepResult { scored: boolean; died: boolean; respawned: number[] }

/** Advance the run by dt seconds. */
export function step(g: Game, dt: number, halfW: number): StepResult {
    const res: StepResult = { scored: false, died: false, respawned: [] };
    g.t += dt;
    if (g.mode !== 'playing') return res;
    if (g.thrust > 0) {
        // The stroke: momentum carries over and eases into the new rise.
        g.vy += (RULES.flap - g.vy) * (1 - Math.exp(-Math.min(dt, g.thrust) / 0.03));
        g.thrust = Math.max(0, g.thrust - dt);
    } else {
        g.vy = Math.max(-RULES.maxFall, g.vy - RULES.gravity * dt);
    }
    g.y += g.vy * dt;
    if (g.y + RULES.radius > RULES.top) { g.y = RULES.top - RULES.radius; g.vy = Math.min(0, g.vy); }

    const kx = keysX(halfW);
    let maxX = -Infinity;
    let lastGap = 0;
    for (const w of g.walls) if (w.live && w.x > maxX) { maxX = w.x; lastGap = w.gap; }
    g.walls.forEach((w, i) => {
        if (!w.live) return;
        w.x -= g.speed * dt;
        if (!w.passed && w.x + RULES.wallW / 2 < kx - RULES.radius) {
            w.passed = true;
            g.score++;
            res.scored = true;
            g.speed = speedFor(g.score);
        }
        if (w.x < -halfW - RULES.wallW) {
            placeWall(g, w, maxX + RULES.spacing - g.speed * dt, lastGap);
            maxX = w.x;
            lastGap = w.gap;
            res.respawned.push(i);
        }
    });

    const dead = g.y - RULES.radius < -1 || g.walls.some(w => w.live && hitsWall(g.y, kx, w));
    if (dead) {
        g.mode = 'over';
        g.t = 0;
        g.best = Math.max(g.best, g.score);
        res.died = true;
    }
    return res;
}

/* ── Pillars building out of the field ───────────────────────────────────── */

/**
 * How formed a pillar is at x (U), 0 = loose dots in the field, 1 = solid.
 * It starts loose as it enters on the right and is fully formed by the time
 * it is still 40% of the window's width ahead of Keys (FAIR_AHEAD) — so the
 * gap's position is always settled and readable with time to react. Early in
 * a run pillars settle sooner (50% of the width ahead); as the score climbs
 * they settle later, down to that bound and never past it. Collision uses
 * the rules' rectangles, which a pillar only reaches once formed.
 */
export const FAIR_AHEAD = 0.4;
export function formedAt(halfW: number, score: number): number {
    const ramp = Math.min(1, score / 20);
    return keysX(halfW) + 2 * halfW * (0.5 - (0.5 - FAIR_AHEAD) * ramp);
}
export function formation(x: number, halfW: number, score: number): number {
    const start = halfW + RULES.wallW / 2; // just entering on the right
    const done = formedAt(halfW, score);
    if (x <= done) return 1;
    if (x >= start) return 0;
    const k = (start - x) / (start - done);
    return k * k * (3 - 2 * k);
}
