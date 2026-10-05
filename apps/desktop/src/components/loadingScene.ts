/**
 * The non-React half of AppLoadingScreen: status copy, the cross-mount wait
 * clock, the pointer write, and the seabed geometry. Kept out of the
 * component file so that file only exports components (React Fast Refresh).
 */

/**
 * What is actually being waited on, for the status line. Only pass a stage
 * the caller KNOWS is in progress — the line must never claim work that
 * isn't happening.
 *   'start' — generic (default): nothing more specific is known.
 *   'auth'  — restoring a stored session / refreshing its token.
 *   'sync'  — signed in; conversations, friends and servers are loading
 *             (HydrationGate).
 */
export type LoadingStage = 'start' | 'auth' | 'sync';

export const STAGE_LABEL: Readonly<Record<LoadingStage, string>> = {
    start: 'Getting things ready',
    auth: 'Signing you in',
    sync: 'Catching up on your chats',
};

export const SLOW_LABEL = 'Taking a little longer than usual. Hang tight.';

/** Two screens mounted within this gap are one continuous wait. */
export const HANDOFF_MS = 1500;

export const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * The app shows the loading screen twice in a row on a normal start — once
 * from App.tsx while the session is restored, then again from HydrationGate
 * while data loads — and those are separate mounts. Without this, every
 * animation would restart at the handoff (a visible hitch), the intro would
 * replay, Keys would snap back to looking straight ahead and the slow-hint
 * clock would reset. So the wait is tracked here: a mount that follows an
 * unmount within HANDOFF_MS continues the same wait. Module state, but only
 * timing and the last pointer position — never any user data.
 *
 * -1 means "none" (0 is a legitimate performance.now() value).
 */
const session = { start: -1, endedAt: -1, mx: 0, my: 0, md: 0 };

export interface WaitStart {
    /** performance.now() at which this wait began. */
    t0: number;
    /** Whether it continues a previous screen's wait. */
    continued: boolean;
    /** Last pointer values of the previous screen (0s when not continued). */
    mx: number;
    my: number;
    md: number;
}

/** Called once per mount (in a state initialiser). Pure read. */
export function beginWait(t: number = now()): WaitStart {
    const continued = session.start >= 0 && session.endedAt >= 0 && t - session.endedAt < HANDOFF_MS;
    return continued
        ? { t0: session.start, continued, mx: session.mx, my: session.my, md: session.md }
        : { t0: t, continued, mx: 0, my: 0, md: 0 };
}
/** A screen is on screen for the wait that began at t0. */
export function holdWait(t0: number): void {
    session.start = t0;
    session.endedAt = -1;
}
/** That screen went away. */
export function releaseWait(): void {
    session.endedAt = now();
}
export function rememberPointer(mx: number, my: number, md: number): void {
    session.mx = mx; session.my = my; session.md = md;
}
/** Test hook: forget any previous wait. */
export function __resetLoadingSession(): void {
    session.start = -1; session.endedAt = -1; session.mx = 0; session.my = 0; session.md = 0;
}

/**
 * The pointer's three values go ONLY onto the elements that follow it (class
 * `ls-p`, a fixed six of them), never onto the root, and the stylesheet
 * registers them with `@property … inherits: false`. That matters more than
 * anything else in the screen: an INHERITED custom property changing on the
 * root reaches every descendant, and Chromium re-syncs every compositor
 * animation on an element whose variables changed — ~60 of them, every
 * write. Measured: main thread busy 4.2 s of every 4 s while the pointer
 * moved, against ~0.6 s with the values kept off the animated elements.
 */
export function pointerTargets(root: HTMLElement): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>('.ls-p'));
}
export function writePointer(targets: readonly HTMLElement[], mx: number, my: number, md: number): void {
    const a = mx.toFixed(2);
    const b = my.toFixed(2);
    const c = md.toFixed(2);
    for (const t of targets) {
        t.style.setProperty('--mx', a);
        t.style.setProperty('--my', b);
        t.style.setProperty('--md', c);
    }
}

/**
 * The seabed, PRE-PROJECTED: a dot matrix on a floor 250px below Keys' eye
 * line, seen through a 1000px perspective, flattened to 2D once here. It used
 * to be a 1600px plane under a CSS 3D transform, which costs a composited
 * layer drawn with perspective sampling every frame (measured: it alone took
 * the frames a software-composited window could draw down by about a third).
 * As plain SVG paths it is painted once into the base layer with everything
 * else that never moves.
 *
 * Coordinates are px relative to the vanishing point (Keys' eye line, centre
 * of the window), so the art is independent of window size. Dots are grouped
 * by brightness so the whole floor is a handful of <path> elements.
 */
export interface SeabedPath { d: string; fill: string; opacity: number }

const F = 1000; // perspective distance (px)
const FLOOR_Y = 250; // floor depth below the eye line (px)
const PITCH = 28;

let seabedCache: SeabedPath[] | null = null;

export function seabedPaths(): SeabedPath[] {
    if (seabedCache) return seabedCache;
    const groups = new Map<string, { fill: string; opacity: number; parts: string[] }>();
    const add = (fill: string, alpha: number, X: number, Z: number, r: number) => {
        const q = Math.round(alpha * 20) / 20; // 0.05 steps
        if (q < 0.05) return;
        const s = F / (F - Z);
        const x = X * s;
        const y = FLOOR_Y * s;
        // A flat disc seen from above is an ellipse; squashed less than true
        // perspective would, so the far rows still read as dots, not dashes.
        const rx = r * s;
        const ry = rx * Math.max(0.45, FLOOR_Y / (F - Z));
        const key = `${fill}|${q}`;
        let g = groups.get(key);
        if (!g) { g = { fill, opacity: q, parts: [] }; groups.set(key, g); }
        g.parts.push(
            `M${(x - rx).toFixed(1)} ${y.toFixed(1)}a${rx.toFixed(2)} ${ry.toFixed(2)} 0 1 0 ${(2 * rx).toFixed(2)} 0a${rx.toFixed(2)} ${ry.toFixed(2)} 0 1 0 ${(-2 * rx).toFixed(2)} 0`,
        );
    };
    for (let Z = -1200; Z <= 380; Z += PITCH) {
        for (let X = -812; X <= 812; X += PITCH) {
            // Fade into the dark around a point just behind Keys.
            const t = Math.hypot(X, Z + 50) / 760;
            const fade = t >= 1 ? 0 : t < 0.5 ? 0.62 - (0.62 - 0.26) * (t / 0.5) : 0.26 * (1 - (t - 0.5) / 0.5);
            add('#25E0C8', fade, X, Z, 1.5);
            // The brighter patch of seabed directly under him.
            const u = Math.hypot(X, Z) / 300;
            if (u < 1) add('#C8FFF7', 0.9 * (1 - u), X, Z, 2.1);
        }
    }
    seabedCache = Array.from(groups.values()).map(g => ({ d: g.parts.join(''), fill: g.fill, opacity: g.opacity }));
    return seabedCache;
}

/**
 * The still outer orbit, pre-projected like the seabed: a ring of dots of
 * radius `r` in a plane rolled 12 degrees and tipped 70 degrees back, centred
 * `dy` px below Keys' eye line, seen through the same 1000px perspective.
 * Being still, it belongs in the base layer rather than on a compositor layer
 * of its own. Returns dot centres and radii in px relative to the vanishing
 * point.
 */
export function outerOrbitDots(r = 235, n = 68, dy = 40): Array<{ x: number; y: number; rx: number; ry: number }> {
    const tip = (70 * Math.PI) / 180;
    const roll = (12 * Math.PI) / 180;
    const out: Array<{ x: number; y: number; rx: number; ry: number }> = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        // the ring tipped back: its far half rises, its near half comes forward
        const px = Math.cos(a) * r;
        const py = Math.sin(a) * r * Math.cos(tip);
        const pz = Math.sin(a) * r * Math.sin(tip);
        // then rolled in the screen plane
        const x = px * Math.cos(roll) - py * Math.sin(roll);
        const y = px * Math.sin(roll) + py * Math.cos(roll);
        const k = F / (F - pz);
        out.push({ x: x * k, y: (dy + y) * k, rx: 1.4 * k, ry: 1.4 * k * Math.max(0.4, Math.cos(tip)) });
    }
    return out;
}
