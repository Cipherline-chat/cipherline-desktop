/**
 * Preload for the desktop annotation overlay window (annotation-overlay.ts).
 *
 * The page itself is an inert <canvas> under `default-src 'none'`; every line
 * of behaviour is here, in the sandboxed preload, which has DOM access but
 * exposes nothing to the page. Input is one IPC channel carrying stroke
 * deltas from the main process; there is no contextBridge surface at all.
 *
 * Rendering mirrors src/components/call/AnnotationOverlay.tsx so a stroke looks
 * the same on the desktop as on every tile: normalized [0,1]² points mapped
 * onto the display, width scaled by frame width and DPR, and the same
 * WHOLE-STROKE model — one path at one opacity, solid while the pen is down,
 * fading out over LASER_TTL_MS once it closes.
 *
 * "Onto the display" is literal and load-bearing. The projection uses the
 * CAPTURE rectangle pushed over `annot-overlay:geometry`, never this window's
 * own `innerWidth`/`innerHeight`. Those are different rectangles: a screen
 * capture covers the whole display, while the window's client box is whatever
 * the compositor granted, and a work-area clamp (1920x1032 under a 48px
 * taskbar) made every stroke land short — 24px high at mid-screen, 48px at the
 * bottom, right only along the top edge. See annotation-overlay-projection.ts.
 *
 * It runs its own copy of both clocks (the abandonment WATCHDOG and the fade)
 * off the `updatedAt`/`closedAt` stamps each delta carries, rather than waiting
 * to be told what to remove: main and renderer share a machine, so Date.now()
 * agrees on both sides, and the overlay keeps ageing smoothly between deltas
 * instead of freezing on the last frame it was sent whenever the store goes
 * quiet — including for a stroke abandoned mid-draw.
 *
 * Same two performance rules as the in-app overlay, for the same measured
 * reasons (see AnnotationOverlay.tsx): one path per stroke rather than one per
 * segment, and NO ctx.shadowBlur — the glow is a graded stack of translucent
 * halo strokes under a bright core, because a shadowBlur over a whole-stroke
 * path blurs the entire display and cost ~400ms/frame at dpr 3.
 */
import { ipcRenderer } from 'electron';

// Structurally the same shape as src/utils/annotationOverlayTypes.ts, restated
// here rather than imported: this preload is compiled standalone and must not
// drag the renderer's module graph into a sandboxed context.
//
// `tool` is deliberately absent. The renderer stopped sending it when the pen
// was removed and the laser became the only tool, but this file still REQUIRED
// it in cleanStroke — so every upsert was rejected as malformed and the desktop
// overlay silently drew nothing at all. Matching the sender's shape is what
// makes it work again.
interface OverlayPoint { x: number; y: number }
interface OverlayStroke {
    id: string;
    color: string;
    width: number;
    points: OverlayPoint[];
    /** ms epoch of the last point; same clock as this process. Feeds the
     *  watchdog. */
    updatedAt: number;
    /** ms epoch at which the stroke closed and began fading; 0 while live. */
    closedAt: number;
}
interface OverlayDelta {
    reset?: boolean;
    upsert?: OverlayStroke[];
    append?: Array<{ id: string; points: OverlayPoint[]; updatedAt: number; closedAt: number }>;
    remove?: string[];
}
/**
 * Where to lay the canvas, in this window's own CSS pixels. Computed in the
 * main process from the captured Display's bounds — see
 * annotation-overlay-projection.ts, which this file cannot import because a
 * `sandbox: true` preload's `require` resolves only `electron` and a few node
 * builtins, never a relative path (same reason the wire types above are
 * restated rather than imported).
 */
interface OverlayGeometry {
    cssLeft: number;
    cssTop: number;
    cssWidth: number;
    cssHeight: number;
}

/** Must match annotationStore's LASER_TTL_MS / STROKE_IDLE_MS. */
const LASER_TTL_MS = 1500;
const STROKE_IDLE_MS = LASER_TTL_MS;
const PALETTE_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_STROKES = 2000;
/** Ceiling on the backing store, in device px per CSS px — see the header. */
const MAX_BACKING_SCALE = 2;
/**
 * The glow. MUST stay identical to AnnotationOverlay.tsx's GLOW_LAYERS /
 * HOT_CORE_*: this window paints the same strokes onto the sharer's real
 * desktop that the in-call tile paints onto the video, and a viewer pointing
 * at something has to be pointing at the same-looking thing in both. The
 * in-app file carries the reasoning and the measurements; the contract test
 * (utils/annotationOverlayContract.test.ts) fails if the two drift apart.
 *
 * `[width multiple of the core, opacity]`, widest and faintest first.
 */
const GLOW_LAYERS: readonly (readonly [number, number])[] = [
    [2.8, 0.07],
    [1.95, 0.14],
    [1.4, 0.26],
];
const HOT_CORE_WIDTH = 0.42;
const HOT_CORE_ALPHA = 0.55;
const HOT_CORE_COLOR = '#FFFFFF';

// Map keeps insertion order, which is draw order (oldest first).
const strokes = new Map<string, OverlayStroke>();
let raf: number | null = null;

const unit = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : NaN);
function cleanPoints(raw: unknown): OverlayPoint[] {
    if (!Array.isArray(raw)) return [];
    const out: OverlayPoint[] = [];
    for (const p of raw) {
        if (!p || typeof p !== 'object') continue;
        const x = unit((p as OverlayPoint).x), y = unit((p as OverlayPoint).y);
        if (Number.isNaN(x) || Number.isNaN(y)) continue;
        out.push({ x, y });
    }
    return out;
}
/**
 * A timestamp from a delta. A malformed one is replaced with `fallback` rather
 * than trusted: a NaN `updatedAt` would make the watchdog's arithmetic
 * undefined, and an absurd `closedAt` could pin a stroke on the display —
 * exactly the class of bug this file's clocks exist to prevent.
 */
function cleanStamp(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function cleanStroke(raw: unknown): OverlayStroke | null {
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Partial<OverlayStroke>;
    if (typeof s.id !== 'string' || !s.id) return null;
    if (typeof s.color !== 'string' || !PALETTE_RE.test(s.color)) return null;
    const width = typeof s.width === 'number' && Number.isFinite(s.width) ? Math.min(24, Math.max(1, s.width)) : 4;
    const now = Date.now();
    return {
        id: s.id, color: s.color, width,
        points: cleanPoints(s.points),
        updatedAt: cleanStamp(s.updatedAt, now),
        closedAt: cleanStamp(s.closedAt, 0),
    };
}

function canvasEl(): HTMLCanvasElement | null {
    return document.getElementById('c') as HTMLCanvasElement | null;
}

const backingScale = (): number => Math.min(MAX_BACKING_SCALE, window.devicePixelRatio || 1);

/**
 * The captured display's rectangle in this window's CSS pixels.
 *
 * Null until the main process sends it. It is NOT defaulted to the window's
 * own box: that box is precisely the wrong rectangle (see the header), and
 * silently guessing it is how the offset shipped. Strokes are held until the
 * real geometry arrives — which happens before any delta, on `did-finish-load`.
 */
let geometry: OverlayGeometry | null = null;

function cleanGeometry(raw: unknown): OverlayGeometry | null {
    if (!raw || typeof raw !== 'object') return null;
    const g = raw as Partial<OverlayGeometry>;
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
    const cssLeft = n(g.cssLeft), cssTop = n(g.cssTop);
    const cssWidth = n(g.cssWidth), cssHeight = n(g.cssHeight);
    if ([cssLeft, cssTop, cssWidth, cssHeight].some(Number.isNaN)) return null;
    if (!(cssWidth > 0) || !(cssHeight > 0)) return null;
    return { cssLeft, cssTop, cssWidth, cssHeight };
}

/**
 * Size the canvas to the CAPTURE rect and shift it so its origin sits on the
 * display's origin, whatever client box the window actually got.
 */
function resize(): void {
    const c = canvasEl();
    const g = geometry;
    if (!c || !g) return;
    const dpr = backingScale();
    const w = Math.max(1, Math.round(g.cssWidth * dpr));
    const h = Math.max(1, Math.round(g.cssHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    c.style.left = `${g.cssLeft}px`;
    c.style.top = `${g.cssTop}px`;
    c.style.width = `${g.cssWidth}px`;
    c.style.height = `${g.cssHeight}px`;
}

function draw(): void {
    const c = canvasEl();
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    // The capture rect, NOT the window's client box. Nothing is drawn before
    // the main process has said where the display is.
    const g = geometry;
    if (!g) return;
    const W = g.cssWidth, H = g.cssHeight;
    if (!(W > 0 && H > 0)) return;
    const dpr = backingScale();
    const now = Date.now();
    // Same width law as the in-app overlay: authored for a 960px-wide frame,
    // scaled with the frame, clamped so a line never turns hairline or fat.
    const scale = Math.min(2, Math.max(0.75, W / 960)) * dpr;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowBlur = 0;

    // Age the strokes on our own clock FIRST, exactly as annotationStore does.
    // Two rules, same order and same constants:
    //   1. WATCHDOG — a live stroke that has had no new point for
    //      STROKE_IDLE_MS is closed. This is what stops a stroke abandoned
    //      mid-draw (a lost pointerup, a peer who left, a truncated stream)
    //      from standing on the streamer's real desktop forever.
    //   2. FADE — a closed stroke is dropped once LASER_TTL_MS has passed.
    for (const [id, s] of strokes) {
        if (s.closedAt === 0) {
            if (now - s.updatedAt >= STROKE_IDLE_MS) s.closedAt = now;
            continue;
        }
        if (now - s.closedAt >= LASER_TTL_MS) strokes.delete(id);
    }

    // Span the backing store exactly. Using `c.width`/`c.height` rather than
    // recomputing `W * dpr` keeps this identical to what `resize()` allocated
    // even when the rounding there moved it by a pixel — the canvas maps its
    // backing store linearly onto its CSS box, so normalized 1.0 must be the
    // backing store's far edge, not a recomputed approximation of it.
    const sx = c.width, sy = c.height;
    for (const s of strokes.values()) {
        const n = s.points.length;
        if (n === 0) continue;
        // ONE opacity for the whole stroke — solid while the pen is down.
        const alpha = s.closedAt === 0 ? 1 : Math.max(0, Math.min(1, 1 - (now - s.closedAt) / LASER_TTL_MS));
        if (alpha <= 0) continue;

        // ONE path, stroked repeatedly: a graded stack of wide translucent
        // halos, then the bright core, then a white-hot centre thread.
        // Successive stroke() calls with no beginPath() between them re-stroke
        // the same path, so the geometry is walked once per pass.
        ctx.beginPath();
        ctx.moveTo(s.points[0].x * sx, s.points[0].y * sy);
        if (n === 1) ctx.lineTo(s.points[0].x * sx + 0.01, s.points[0].y * sy);
        else for (let i = 1; i < n; i++) ctx.lineTo(s.points[i].x * sx, s.points[i].y * sy);

        const w = s.width * scale;
        ctx.strokeStyle = s.color;
        // One globalAlpha per PASS — never one per point.
        for (const [wm, am] of GLOW_LAYERS) {
            ctx.globalAlpha = alpha * am;
            ctx.lineWidth = w * wm;
            ctx.stroke();
        }
        ctx.globalAlpha = alpha;
        ctx.lineWidth = w;
        ctx.stroke();
        ctx.globalAlpha = alpha * HOT_CORE_ALPHA;
        ctx.lineWidth = Math.max(1, w * HOT_CORE_WIDTH);
        ctx.strokeStyle = HOT_CORE_COLOR;
        ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Keep animating while anything is on screen: a live stroke is waiting on
    // its watchdog and a closed one is mid-fade, so neither can wait for the
    // next delta to arrive.
    if (strokes.size > 0 && raf == null) raf = requestAnimationFrame(() => { raf = null; draw(); });
}

function apply(delta: OverlayDelta): void {
    if (!delta || typeof delta !== 'object') return;
    if (delta.reset) strokes.clear();
    if (Array.isArray(delta.remove)) {
        for (const id of delta.remove) if (typeof id === 'string') strokes.delete(id);
    }
    if (Array.isArray(delta.upsert)) {
        for (const raw of delta.upsert) {
            const s = cleanStroke(raw);
            if (!s) continue;
            const existing = strokes.get(s.id);
            if (existing) { Object.assign(existing, s); }
            else {
                if (strokes.size >= MAX_STROKES) { const oldest = strokes.keys().next().value; if (oldest !== undefined) strokes.delete(oldest); }
                strokes.set(s.id, s);
            }
        }
    }
    if (Array.isArray(delta.append)) {
        for (const a of delta.append) {
            if (!a || typeof a !== 'object' || typeof a.id !== 'string') continue;
            const s = strokes.get(a.id);
            if (!s) continue; // never saw its begin: ignore rather than invent
            for (const p of cleanPoints(a.points)) s.points.push(p);
            s.updatedAt = cleanStamp(a.updatedAt, Date.now());
            s.closedAt = cleanStamp(a.closedAt, 0);
        }
    }
}

ipcRenderer.on('annot-overlay:delta', (_e, delta: OverlayDelta) => {
    apply(delta);
    draw();
});

/**
 * Where the captured display is. Sent before the first delta and again on
 * every window resize/move and display change, so the canvas can never be
 * left projecting against a stale rectangle.
 */
ipcRenderer.on('annot-overlay:geometry', (_e: unknown, raw: unknown) => {
    const g = cleanGeometry(raw);
    if (!g) return;
    geometry = g;
    resize();
    draw();
});

// A window `resize` no longer redefines the coordinate space — the main
// process does, and it re-sends geometry on the same events. Re-running
// resize()/draw() here just repaints at the new backing scale if the DPR
// changed with the move (dragging between monitors of different scaling).
window.addEventListener('resize', () => { resize(); draw(); });
document.addEventListener('DOMContentLoaded', () => { resize(); draw(); });
