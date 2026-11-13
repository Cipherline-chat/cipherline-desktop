/**
 * Pure half of the Linux/Wayland annotation overlay (electron/annotation-overlay-wayland.ts):
 * everything the main process decides or validates before a byte reaches the native helper
 * (src-native/wayland_overlay/cl_wayland_overlay.c). Electron-free so it is all unit tested
 * (annotation-overlay-wayland-protocol.test.ts).
 *
 * ── Why the helper exists ──
 * A Wayland client cannot position or stack its own windows, so Electron's overlay
 * BrowserWindow cannot be laid over the shared screen. Compositors that implement
 * wlr-layer-shell (KWin, Sway, Hyprland, other wlroots desktops, COSMIC) let a client pin a
 * surface to the OVERLAY layer of one output with an empty input region; Electron cannot
 * create such surfaces, so a tiny native helper does, and main drives it over a pipe.
 * Mutter (GNOME) has no layer-shell: those sessions stay on the in-app preview.
 *
 * ── Trust ──
 * The helper receives ONLY stroke geometry and colours, produced here from the renderer's
 * deltas after validation: ids become small integers, colours must be #RRGGBB, points are
 * clamped to [0,1] and quantised, widths clamped, timestamps clamped to a window around
 * "now", and counts and rates are capped (a hostile or buggy renderer can neither flood the
 * pipe nor pin a stroke on the sharer's real desktop). Nothing from the network is ever
 * forwarded verbatim.
 *
 * ── Which output? ──
 * A portal share does not say which monitor was picked, and Chromium does not expose the
 * portal's stream position. What IS known: the compositor's outputs (from the helper),
 * Electron's displays, and the size of the captured frame (the renderer's track settings).
 * An Electron display is paired to a compositor output by identical logical rectangle; the
 * share is then matched to a display by frame size. When more than one display fits equally
 * well (two identical monitors) the answer is "don't know", never a guess: main returns
 * `needs_choice` with the real layout, the renderer asks the SHARER "Which screen are you
 * sharing?" once per share, and the answer comes back as `chosenDisplayId`, honoured only if it
 * is one of the displays that really fit. A stroke on the wrong monitor is worse than none (the
 * in-app preview still shows every stroke).
 */
import type { Rect } from './annotation-overlay-projection';

// ── Helper → main ───────────────────────────────────────────────────────────

export interface WaylandOutput {
    index: number;
    /** Connector name from wl_output.name / xdg-output ('-' when the compositor gave none). */
    name: string;
    /** Logical rectangle in compositor space (xdg-output; wl_output geometry as fallback). */
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
    /** Current mode in physical pixels, oriented like the logical rectangle. */
    physicalWidth: number;
    physicalHeight: number;
}

export type HelperEvent =
    | { kind: 'hello'; version: number }
    | { kind: 'out'; out: WaylandOutput }
    /** `HZ <idx> <mhz>`: that output's current refresh in millihertz (wl_output.mode). */
    | { kind: 'hz'; index: number; mhz: number }
    | { kind: 'ready'; layerShell: boolean; x11: boolean }
    | { kind: 'shown'; index: number; width: number; height: number; scale: number }
    | { kind: 'closed' }
    | { kind: 'err'; code: string };

const INT = /^-?\d{1,7}$/;
const toInt = (s: string | undefined, lo: number, hi: number): number | null => {
    if (s === undefined || !INT.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) && n >= lo && n <= hi ? n : null;
};

/** One stdout line from the helper → a typed event, or null if it is not exactly well-formed. */
export function parseHelperLine(line: string): HelperEvent | null {
    if (line.length > 256) return null;
    const p = line.split(' ');
    switch (p[0]) {
        case 'HELLO': {
            const v = toInt(p[1], 0, 1000);
            return p.length === 2 && v !== null ? { kind: 'hello', version: v } : null;
        }
        case 'OUT': {
            if (p.length !== 10) return null;
            const index = toInt(p[1], 0, 15);
            const name = /^[A-Za-z0-9._:-]{1,40}$/.test(p[2]) ? p[2] : null;
            const x = toInt(p[3], -200000, 200000), y = toInt(p[4], -200000, 200000);
            const width = toInt(p[5], 1, 65536), height = toInt(p[6], 1, 65536);
            const scale = toInt(p[7], 1, 16);
            const pw = toInt(p[8], 1, 65536), ph = toInt(p[9], 1, 65536);
            if ([index, x, y, width, height, scale, pw, ph].some(v => v === null) || !name) return null;
            return {
                kind: 'out',
                out: {
                    index: index!, name, x: x!, y: y!, width: width!, height: height!, scale: scale!,
                    physicalWidth: pw!, physicalHeight: ph!,
                },
            };
        }
        case 'HZ': {
            if (p.length !== 3) return null;
            const index = toInt(p[1], 0, 15), mhz = toInt(p[2], 1, 1000000);
            return index !== null && mhz !== null ? { kind: 'hz', index, mhz } : null;
        }
        case 'READY': {
            // READY layer_shell=<0|1> x11=<0|1>  (x11 = an ARGB-capable XWayland is reachable)
            if (p.length !== 3) return null;
            const ls = /^layer_shell=([01])$/.exec(p[1]), x = /^x11=([01])$/.exec(p[2]);
            return ls && x ? { kind: 'ready', layerShell: ls[1] === '1', x11: x[1] === '1' } : null;
        }
        case 'SHOWN': {
            if (p.length !== 5) return null;
            const index = toInt(p[1], 0, 15), width = toInt(p[2], 1, 65536), height = toInt(p[3], 1, 65536), scale = toInt(p[4], 1, 16);
            if (index === null || width === null || height === null || scale === null) return null;
            return { kind: 'shown', index, width, height, scale };
        }
        case 'CLOSED':
            return p.length === 1 ? { kind: 'closed' } : null;
        case 'ERR':
            return p.length === 2 && /^[a-z_]{1,32}$/.test(p[1]) ? { kind: 'err', code: p[1] } : null;
        default:
            return null;
    }
}

// ── Output matching ─────────────────────────────────────────────────────────

/** The slice of Electron's `Display` the matcher needs. */
export interface DisplayLite {
    id: number;
    /** DIP bounds — on Wayland, the compositor's logical rectangle. */
    bounds: Rect;
    /** Physical size = bounds size × scaleFactor. */
    scaleFactor: number;
    /** Electron's primary display (drawn as such in the "which screen?" chooser). */
    primary?: boolean;
}

export type WaylandMatchHow = 'display-id' | 'only-display' | 'stream-size' | 'chosen' | 'stream-position' | 'remembered';

/** Edges of a logical rectangle may differ by a pixel between xdg-output and Chromium's rounding. */
const RECT_TOLERANCE = 1;
/** A frame is "the whole of this display" when the aspect ratios agree within 1%. */
const ASPECT_TOLERANCE = 0.01;
/** ...and "exactly this display" when physical size agrees within a couple of pixels. */
const EXACT_TOLERANCE_PX = 2;

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;
export const sameLogicalRect = (r: Rect, o: WaylandOutput): boolean =>
    near(r.x, o.x, RECT_TOLERANCE) && near(r.y, o.y, RECT_TOLERANCE)
    && near(r.width, o.width, RECT_TOLERANCE) && near(r.height, o.height, RECT_TOLERANCE);

export interface FrameSize { width: number; height: number }

/** Validate the renderer's frame-size hint (it is a hint, never trusted blindly). */
export function cleanFrameHint(raw: unknown): FrameSize | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const ok = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 16 && v <= 32768;
    return ok(r.width) && ok(r.height) ? { width: r.width, height: r.height } : null;
}

/** The renderer's "I picked this display" hint: an integer id, nothing else (it is validated against real candidates later). */
export function cleanDisplayChoice(raw: unknown): number | null {
    return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw <= 0x7fffffff ? raw : null;
}

/**
 * What the renderer knows beyond the frame size, as validated hints (never trusted blindly):
 *  - `stream`: the portal's own statement of which monitor rectangle it streams (native hardware share).
 *  - `remembered`: the sharer's earlier answer to "which screen?" as the display layout it was given for plus the rectangle
 *    it picked. Only ever used when the layout is still exactly the same (see matchWaylandOutput).
 */
export interface ShowHint {
    stream: Rect | null;
    remembered: { layout: Rect[]; chosen: Rect } | null;
}

const cleanRectHint = (raw: unknown): Rect | null => {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const c = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= -100000 && v <= 100000;
    const d = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65536;
    return c(r.x) && c(r.y) && d(r.width) && d(r.height) ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
};

/** Validate the renderer's extra hints; anything malformed is dropped (an absent hint only means a question may be asked). */
export function cleanShowHint(raw: unknown): ShowHint {
    const none: ShowHint = { stream: null, remembered: null };
    if (!raw || typeof raw !== 'object') return none;
    const r = raw as Record<string, unknown>;
    const stream = cleanRectHint(r.stream);
    let remembered: ShowHint['remembered'] = null;
    const m = r.remembered;
    if (m && typeof m === 'object') {
        const mm = m as Record<string, unknown>;
        const chosen = cleanRectHint(mm.chosen);
        const layout = Array.isArray(mm.layout) && mm.layout.length >= 1 && mm.layout.length <= 16 ? mm.layout.map(cleanRectHint) : null;
        if (chosen && layout && layout.every((l): l is Rect => l !== null)) remembered = { layout, chosen };
    }
    return { stream, remembered };
}

const sameRectNear = (a: Rect, b: Rect): boolean =>
    near(a.x, b.x, RECT_TOLERANCE) && near(a.y, b.y, RECT_TOLERANCE) && near(a.width, b.width, RECT_TOLERANCE) && near(a.height, b.height, RECT_TOLERANCE);

/** The same set of display rectangles, in any order. A different count, or any moved/resized one, is a different layout. */
export function sameLayout(a: readonly Rect[], b: readonly Rect[]): boolean {
    if (a.length !== b.length) return false;
    const left = [...b];
    for (const r of a) {
        const i = left.findIndex(o => sameRectNear(r, o));
        if (i < 0) return false;
        left.splice(i, 1);
    }
    return true;
}

/** Same shape as the whole display, to within ASPECT_TOLERANCE (a downscaled capture keeps it). */
export function frameCoversDisplay(frame: FrameSize, d: DisplayLite): boolean {
    const dw = d.bounds.width, dh = d.bounds.height;
    if (!(dw > 0 && dh > 0 && frame.width > 0 && frame.height > 0)) return false;
    const fa = frame.width / frame.height, da = dw / dh;
    return Math.abs(fa / da - 1) <= ASPECT_TOLERANCE;
}

function frameIsExactPhysical(frame: FrameSize, d: DisplayLite): boolean {
    const pw = d.bounds.width * d.scaleFactor, ph = d.bounds.height * d.scaleFactor;
    return near(frame.width, pw, EXACT_TOLERANCE_PX) && near(frame.height, ph, EXACT_TOLERANCE_PX);
}

export type WaylandMatch =
    | { ok: true; output: WaylandOutput; displayId: number; how: WaylandMatchHow }
    | { ok: false; why: 'no_pairs' | 'not_whole_screen' }
    /** Several displays fit the share equally well: `candidates` are their Electron display ids. */
    | { ok: false; why: 'ambiguous'; candidates: number[] };

/**
 * The compositor output a `screen:` share shows, or why that cannot be known.
 * `displayId` is the capture source's `display_id` when Chromium filled it (it is empty on
 * most Wayland portals).
 */
export function matchWaylandOutput(opts: {
    displays: readonly DisplayLite[];
    outputs: readonly WaylandOutput[];
    frame: FrameSize | null;
    displayId?: string | null;
    /** The Electron display id the SHARER picked in the chooser (a hint; only honoured when it is a real candidate). */
    chosenDisplayId?: number | null;
    hint?: ShowHint;
}): WaylandMatch {
    const { displays, outputs, frame } = opts;
    // Pair Electron displays with compositor outputs by identical logical rectangle. A display
    // matching several outputs (mirrored heads) or none is left out: not reliably addressable.
    const pairs: Array<{ display: DisplayLite; output: WaylandOutput }> = [];
    for (const d of displays) {
        const hits = outputs.filter(o => sameLogicalRect(d.bounds, o));
        if (hits.length === 1) pairs.push({ display: d, output: hits[0] });
    }
    // One display and one output: no rectangle comparison is needed to know they are the same.
    if (pairs.length === 0 && displays.length === 1 && outputs.length === 1) {
        pairs.push({ display: displays[0], output: outputs[0] });
    }
    if (pairs.length === 0) return { ok: false, why: 'no_pairs' };

    if (opts.displayId) {
        const byId = pairs.find(p => String(p.display.id) === String(opts.displayId));
        if (byId) return { ok: true, output: byId.output, displayId: byId.display.id, how: 'display-id' };
    }
    // The portal said which rectangle it streams (position + size): exactly one display with that rectangle IS the share,
    // identical monitors included (they sit at different positions). Two displays claiming the same rectangle is not an answer.
    if (opts.hint?.stream) {
        const at = pairs.filter(p => sameRectNear(p.display.bounds, opts.hint!.stream!));
        if (at.length === 1) return { ok: true, output: at[0].output, displayId: at[0].display.id, how: 'stream-position' };
    }
    // The sharer's earlier answer, valid only while the display layout is exactly what it was answered for.
    let chosen = opts.chosenDisplayId;
    let chosenHow: 'chosen' | 'remembered' = 'chosen';
    if (typeof chosen !== 'number' && opts.hint?.remembered && sameLayout(displays.map(d => d.bounds), opts.hint.remembered.layout)) {
        const rm = opts.hint.remembered;
        const hits = displays.filter(d => sameRectNear(d.bounds, rm.chosen));
        if (hits.length === 1) { chosen = hits[0].id; chosenHow = 'remembered'; }
    }
    // A share that is not the whole of the chosen screen (the portal also offers single
    // windows) cannot be laid over by a full-output surface.
    if (frame) {
        const fitting = pairs.filter(p => frameCoversDisplay(frame, p.display));
        if (fitting.length === 0) return { ok: false, why: 'not_whole_screen' };
        if (fitting.length === 1) {
            const only = pairs.length === 1 && displays.length === 1;
            return { ok: true, output: fitting[0].output, displayId: fitting[0].display.id, how: only ? 'only-display' : 'stream-size' };
        }
        const exact = fitting.filter(p => frameIsExactPhysical(frame, p.display));
        if (exact.length === 1) return { ok: true, output: exact[0].output, displayId: exact[0].display.id, how: 'stream-size' };
        // Several identical monitors: nothing in the frame tells them apart. The sharer's own
        // answer (asked once per share) is the only honest signal left.
        const picked = pickChosen(fitting, chosen, chosenHow);
        if (picked) return picked;
        return { ok: false, why: 'ambiguous', candidates: (exact.length > 1 ? exact : fitting).map(p => p.display.id) };
    }
    // No frame size known (an older renderer): only a lone display is certain.
    if (pairs.length === 1 && displays.length === 1) {
        return { ok: true, output: pairs[0].output, displayId: pairs[0].display.id, how: 'only-display' };
    }
    const picked = pickChosen(pairs, chosen, chosenHow);
    if (picked) return picked;
    return { ok: false, why: 'ambiguous', candidates: pairs.map(p => p.display.id) };
}

/** The sharer's choice, but only if it is one of the displays that could really be the share. */
function pickChosen(
    eligible: ReadonlyArray<{ display: DisplayLite; output: WaylandOutput }>,
    chosen: number | null | undefined,
    how: 'chosen' | 'remembered' = 'chosen',
): WaylandMatch | null {
    if (typeof chosen !== 'number') return null;
    const hit = eligible.find(p => p.display.id === chosen);
    return hit ? { ok: true, output: hit.output, displayId: hit.display.id, how } : null;
}

// ── Main → helper ───────────────────────────────────────────────────────────

/** Mirrors annotationStore / the overlay preload (kept equal by the wiring test). */
export const LASER_TTL_MS = 1500;
export const MAX_STROKES = 256;
export const MAX_POINTS_PER_STROKE = 8192;
/** Points per `A` line (keeps every line far below the helper's line limit). */
export const MAX_POINTS_PER_LINE = 1024;
const PALETTE_RE = /^#([0-9a-fA-F]{6})$/;
const MAX_ID_LEN = 64;
/** Stamps outside [now - PAST, now + FUTURE] are not trusted. */
const STAMP_PAST_MS = 60_000;
const STAMP_FUTURE_MS = 5_000;
const MIN_WIDTH = 1;
const MAX_WIDTH = 24;

/** Token bucket: refills `perSec` tokens per second up to `burst`. */
export class TokenBucket {
    private tokens: number;
    private last: number;
    constructor(private readonly perSec: number, private readonly burst: number, now: number) {
        this.tokens = burst;
        this.last = now;
    }
    take(n: number, now: number): boolean {
        const dt = Math.max(0, now - this.last);
        this.last = now;
        this.tokens = Math.min(this.burst, this.tokens + (dt / 1000) * this.perSec);
        if (n > this.tokens) return false;
        this.tokens -= n;
        return true;
    }
}

export interface EncoderStats {
    lines: number;
    dropped: number;
    rejected: number;
}

const unit = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);

/**
 * Turns the renderer's OverlayDelta stream into helper command lines. One instance per
 * overlay session; `reset()` before reuse.
 */
export class WaylandStrokeEncoder {
    private ids = new Map<string, number>();
    private nextSid = 1;
    private lineBucket: TokenBucket;
    private pointBucket: TokenBucket;
    readonly stats: EncoderStats = { lines: 0, dropped: 0, rejected: 0 };

    constructor(private readonly now: () => number = Date.now) {
        const t = now();
        // 240 commands/s and 8000 points/s sustained. The burst has to cover the one legitimate
        // spike - the full-state resend when the overlay comes up (a reset plus every stroke the
        // store still holds, up to MAX_STROKES, the longest of them MAX_POINTS_PER_STROKE) - and
        // nothing more. The transport's own per-sender bucket is 60 msgs/s, so a well-behaved
        // session never gets near the sustained rates.
        this.lineBucket = new TokenBucket(240, MAX_STROKES + 44, t);
        this.pointBucket = new TokenBucket(8000, MAX_POINTS_PER_STROKE * 2, t);
    }

    reset(): void {
        this.ids.clear();
        this.nextSid = 1;
    }

    private stamp(v: unknown, fallback: number): number {
        const now = this.now();
        if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
        const t = Math.round(v);
        return t >= now - STAMP_PAST_MS && t <= now + STAMP_FUTURE_MS ? t : fallback;
    }

    private closedStamp(v: unknown): number {
        const now = this.now();
        if (v === 0 || v === undefined || v === null) return 0;
        // A malformed / absurd close stamp starts the fade now rather than pinning the stroke.
        return this.stamp(v, now);
    }

    private sidFor(id: unknown, create: boolean, out: string[]): number | null {
        if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LEN) return null;
        const have = this.ids.get(id);
        if (have !== undefined) return have;
        if (!create) return null;
        if (this.ids.size >= MAX_STROKES) {
            const oldest = this.ids.entries().next().value as [string, number] | undefined;
            if (oldest) { this.ids.delete(oldest[0]); out.push(`R ${oldest[1]}`); }
        }
        const sid = this.nextSid++;
        this.ids.set(id, sid);
        return sid;
    }

    private points(raw: unknown, cap: number): string[] {
        const out: string[] = [];
        if (!Array.isArray(raw)) return out;
        for (const p of raw) {
            if (out.length >= cap) break;
            if (!p || typeof p !== 'object') continue;
            const x = unit((p as { x: unknown }).x), y = unit((p as { y: unknown }).y);
            if (x === null || y === null) continue;
            out.push(`${Math.round(x * 65535)},${Math.round(y * 65535)}`);
        }
        return out;
    }

    private emit(lines: string[], line: string, pointCount: number): void {
        const t = this.now();
        if (!this.lineBucket.take(1, t) || !this.pointBucket.take(pointCount, t)) { this.stats.dropped++; return; }
        lines.push(line);
        this.stats.lines++;
    }

    /** Validate one delta and return the command lines to send (possibly none). */
    encode(raw: unknown): string[] {
        const lines: string[] = [];
        if (!raw || typeof raw !== 'object') { this.stats.rejected++; return lines; }
        const d = raw as { reset?: unknown; upsert?: unknown; append?: unknown; remove?: unknown };
        if (d.reset === true) { this.reset(); this.emit(lines, 'Z', 0); }
        if (Array.isArray(d.remove)) {
            for (const id of d.remove.slice(0, MAX_STROKES)) {
                const sid = this.sidFor(id, false, lines);
                if (sid === null) continue;
                this.ids.delete(id as string);
                this.emit(lines, `R ${sid}`, 0);
            }
        }
        if (Array.isArray(d.upsert)) {
            for (const s of d.upsert.slice(0, MAX_STROKES)) {
                if (!s || typeof s !== 'object') { this.stats.rejected++; continue; }
                const st = s as Record<string, unknown>;
                const m = typeof st.color === 'string' ? PALETTE_RE.exec(st.color) : null;
                if (!m) { this.stats.rejected++; continue; }
                const sid = this.sidFor(st.id, true, lines);
                if (sid === null) { this.stats.rejected++; continue; }
                const width = typeof st.width === 'number' && Number.isFinite(st.width)
                    ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, st.width)) : 4;
                const now = this.now();
                const pts = this.points(st.points, MAX_POINTS_PER_STROKE);
                this.emit(
                    lines,
                    `U ${sid} ${m[1].toLowerCase()} ${Math.round(width * 10)} ${this.stamp(st.updatedAt, now)} ${this.closedStamp(st.closedAt)} ${pts.length}${pts.length ? ' ' + pts.join(' ') : ''}`,
                    pts.length,
                );
            }
        }
        if (Array.isArray(d.append)) {
            for (const a of d.append.slice(0, MAX_STROKES)) {
                if (!a || typeof a !== 'object') { this.stats.rejected++; continue; }
                const ap = a as Record<string, unknown>;
                const sid = this.sidFor(ap.id, false, lines);
                if (sid === null) continue;           // never saw its begin: ignore rather than invent
                const now = this.now();
                const pts = this.points(ap.points, MAX_POINTS_PER_STROKE);
                const upd = this.stamp(ap.updatedAt, now), clo = this.closedStamp(ap.closedAt);
                if (pts.length === 0) { this.emit(lines, `A ${sid} ${upd} ${clo} 0`, 0); continue; }
                for (let i = 0; i < pts.length; i += MAX_POINTS_PER_LINE) {
                    const chunk = pts.slice(i, i + MAX_POINTS_PER_LINE);
                    this.emit(lines, `A ${sid} ${upd} ${clo} ${chunk.length} ${chunk.join(' ')}`, chunk.length);
                }
            }
        }
        return lines;
    }
}
