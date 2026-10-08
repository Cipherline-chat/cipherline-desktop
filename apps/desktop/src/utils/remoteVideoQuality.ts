/**
 * Which simulcast layer each remote camera tile asks the SFU for, and how
 * fast that changes.
 *
 * Before: every tile called setVideoQuality with a fixed tier from its
 * caller (sidebar MEDIUM/LOW by count, fullscreen grid MEDIUM ≤ 6 else LOW,
 * focus HIGH), the last effect to run won, and the sidebar tile of a focused
 * stream had to suppress itself so it would not race the focus tile back to
 * LOW. The FocusedStreamBanner also mounted its HIGH tile only after a 160 ms
 * crossfade. Measured in the harness (camera E2EE, LiveKit v1.9.12): a HIGH
 * request reaches a decoded full-resolution frame in ~0.3–0.85 s — the SFU
 * grants an upgrade at once and PLIs the publisher for a keyframe
 * (DownTrack.SetMaxSpatialLayer → postKeyFrameRequestEvent), so the request
 * itself was never the slow part; what made focus look bad was WHAT was
 * published (a CPU-shrunk 960×540 "HIGH", see cameraQuality.ts) and the
 * extra delays in front of the request.
 *
 * Now:
 *   - pickTileLayer() chooses from the tile's RENDERED size × devicePixelRatio
 *     against the publisher's ACTUAL layers (trackInfo.layers), capped by how
 *     many tiles share the view, with hysteresis so a tile near a boundary
 *     does not flap;
 *   - a per-publication arbiter (claimRemoteQuality) merges every tile that
 *     shows the stream — the result is the MAX — so the sidebar copy of a
 *     focused stream can no longer pull it down, and:
 *       · upgrades apply immediately (no debounce),
 *       · downgrades wait DOWNGRADE_DELAY_MS and are cancelled if anything
 *         asks for more meanwhile (unfocus → refocus stays sharp);
 *   - prewarmRemoteQuality() asks for the top layer on press/hover of a
 *     tile and when focus changes, before the focus view has even mounted.
 *
 * Layer pausing for off-screen tiles stays in remoteVideoDemand.ts.
 */
import { VideoQuality } from 'livekit-client';

/** A tile may show a layer up to this much smaller than it (mild upscale). */
export const UPSCALE_TOLERANCE = 1.15;
/** Downgrade only once the tile is this much below the switch point. */
export const HYSTERESIS = 0.85;
export const DOWNGRADE_DELAY_MS = 2500;
export const PREWARM_HOLD_MS = 2500;

export interface LayerDims { quality: VideoQuality; width: number; height: number }

/** Where a tile is shown. 'focus' = the stage / focused banner. */
export type TileRole = 'focus' | 'grid' | 'tile';

/**
 * Per-tile pixel cap by how many video tiles share the view. A cap is in
 * DEVICE pixels of the shorter side, so it means the same thing whatever
 * ladder the publisher has (720p cameras publish 180/360/720, 1080p
 * 270/540/1080, 1440p 360/720/1440):
 *   ≤ 4 tiles → up to 1080 (a 720p or 1080p camera's top; a 1440p camera's
 *               720p — 1440p is for a focused viewer only);
 *   5–9       → up to 540 (the mid layer of a 720p/1080p camera);
 *   10+       → up to 270 (the low layer).
 * The active speaker in a grid gets the next tier up. 'focus' is uncapped.
 */
export function capForCount(role: TileRole, count: number, speaking = false): number {
    if (role === 'focus') return Infinity;
    const n = Math.max(1, count);
    const tiers = [1080, 540, 270];
    let i = n <= 4 ? 0 : n <= 9 ? 1 : 2;
    if (speaking && i > 0) i -= 1;
    return tiers[i];
}

/**
 * Device pixels on the video's SHORTER side, as the tile draws it.
 * 'contain' (focus, grid): the video fits inside the box. 'cover' (sidebar
 * thumbnails): it fills the box and is cropped, so it is drawn LARGER than
 * the box along one axis. DPR below 1 counts as 1 (never ask for less than
 * the CSS size).
 */
export function displayedPixels(cssW: number, cssH: number, dpr: number, aspect = 16 / 9, fit: 'contain' | 'cover' = 'contain'): number {
    if (!(cssW > 0) || !(cssH > 0)) return 0;
    const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9;
    const shownH = fit === 'contain' ? Math.min(cssH, cssW / a) : Math.max(cssH, cssW / a);
    const shownW = shownH * a;
    return Math.round(Math.min(shownW, shownH) * Math.max(1, dpr || 1));
}

const short = (l: LayerDims) => Math.min(l.width, l.height);

/** Normalise trackInfo.layers: valid, sorted low → high, one per quality. */
export function normaliseLayers(layers: readonly { quality?: number; width?: number; height?: number }[] | undefined): LayerDims[] {
    const seen = new Map<number, LayerDims>();
    for (const l of layers ?? []) {
        if (typeof l.quality !== 'number' || !(l.width && l.height)) continue;
        if (l.quality < VideoQuality.LOW || l.quality > VideoQuality.HIGH) continue;
        seen.set(l.quality, { quality: l.quality as VideoQuality, width: l.width, height: l.height });
    }
    return [...seen.values()].sort((a, b) => a.quality - b.quality);
}

export interface PickInput {
    /** Device pixels the tile shows on the video's shorter side (displayedPixels). */
    need: number;
    layers: readonly LayerDims[];
    role: TileRole;
    count: number;
    speaking?: boolean;
    /** What this tile asked for last time (hysteresis). */
    current?: VideoQuality;
    /** Settings → Voice & Video → Incoming video quality (default 'auto'). */
    mode?: IncomingVideoMode;
}

/**
 * Incoming video quality (Voice & Video, or "Lower" on the performance offer):
 *   - 'auto'      — size × DPR with the count tiers (pickTileLayer);
 *   - 'reduced'   — every camera tile at the LOW layer, the active speaker at
 *                   most MEDIUM; a camera the user FOCUSES keeps its normal
 *                   (sharp) choice. Plus a cap on how many remote cameras are
 *                   decoded at once (DECODE_CAP, chooseDecodedSet);
 *   - 'datasaver' — for metered connections: everything LOW, a focused camera
 *                   at most MEDIUM, the same decode cap, and screen shares
 *                   asked for at most 30 fps.
 * Off-screen tiles are paused in every mode (remoteVideoDemand.ts).
 */
export type IncomingVideoMode = 'auto' | 'reduced' | 'datasaver';
export const INCOMING_VIDEO_MODES: readonly IncomingVideoMode[] = ['auto', 'reduced', 'datasaver'];
export function parseIncomingVideoMode(raw: string | null | undefined): IncomingVideoMode {
    return (INCOMING_VIDEO_MODES as readonly string[]).includes(raw ?? '') ? raw as IncomingVideoMode : 'auto';
}
/** Remote cameras decoded at once in 'reduced' / 'datasaver'. */
export const DECODE_CAP = 9;
/** Screen-share receive frame-rate cap in 'datasaver'. */
export const DATASAVER_SHARE_FPS = 30;

/** Highest layer index a mode allows for a tile (null = no extra cap). */
function modeCapIdx(mode: IncomingVideoMode | undefined, role: TileRole, speaking: boolean, layers: readonly LayerDims[]): number | null {
    const mid = Math.min(1, layers.length - 1);
    if (mode === 'reduced') {
        if (role === 'focus') return null;
        return speaking ? mid : 0;
    }
    if (mode === 'datasaver') return role === 'focus' ? mid : 0;
    return null;
}

/**
 * The layer a tile should ask for.
 *   1. by size: the smallest layer whose short side × UPSCALE_TOLERANCE
 *      covers the need;
 *   2. 'focus' never goes below the smallest layer ≥ 720p (or the top, for a
 *      smaller camera) — a focused 720p/1080p camera is always its top
 *      layer, a 1440p camera's top goes to a focus view ≥ ~830 device px;
 *   3. capped by capForCount (never below the lowest layer);
 *   4. hysteresis: a downgrade from `current` only happens when the need has
 *      fallen clearly (HYSTERESIS) below what the lower layer can cover —
 *      except a cap change, which applies at once (the arbiter still delays
 *      the actual downgrade).
 * No layer info (not yet known) → HIGH for focus, LOW otherwise — the safe
 * asks before the publisher's layers arrive.
 */
export function pickTileLayer(i: PickInput): VideoQuality {
    const layers = i.layers;
    if (layers.length === 0) return i.role === 'focus' ? VideoQuality.HIGH : VideoQuality.LOW;
    // Rounded so the thresholds are whole device pixels (180 × 1.15 = 207, not 206.99…).
    const covers = (l: LayerDims, need: number) => Math.round(short(l) * UPSCALE_TOLERANCE) >= need;
    let idx = layers.findIndex(l => covers(l, i.need));
    if (idx < 0) idx = layers.length - 1;
    if (i.role === 'focus') {
        const floor = layers.findIndex(l => short(l) >= 720);
        idx = Math.max(idx, floor < 0 ? layers.length - 1 : floor);
    }
    const cap = capForCount(i.role, i.count, i.speaking);
    let capIdx = -1;
    layers.forEach((l, k) => { if (short(l) <= cap) capIdx = k; });
    if (capIdx < 0) capIdx = 0;
    const modeCap = modeCapIdx(i.mode, i.role, !!i.speaking, layers);
    if (modeCap !== null) capIdx = Math.min(capIdx, modeCap);
    idx = Math.min(idx, capIdx);

    if (i.current !== undefined) {
        const curIdx = layers.findIndex(l => l.quality === i.current);
        if (curIdx > idx && curIdx <= capIdx) {
            // Staying where we are is allowed until the need drops clearly
            // below what the next layer down covers (avoid flapping at the edge).
            const below = layers[curIdx - 1];
            const clearlySmaller = i.need <= Math.round(short(below) * UPSCALE_TOLERANCE * HYSTERESIS);
            if (!clearlySmaller) idx = curIdx;
        }
    }
    return layers[idx].quality;
}

// ── Screen shares ──────────────────────────────────────────────────────────

/**
 * The layer a screen-share tile asks for. A share from this version on
 * publishes [≤720p ≤30 fps, full] (screenShare.ts shareHasLowerLayer); older
 * clients, VP9 shares and ≤720p shares publish one layer, which is simply
 * requested.
 *   - focused / stage (fullscreen solo or focus): the FULL layer — same
 *     resolution, frame rate and ceiling as before (Data saver excepted);
 *   - grid / sidebar: the lower layer, unless the tile shows more device
 *     pixels than the lower layer covers (a big grid cell on a 1440p screen),
 *     with the same hysteresis as cameras;
 *   - Reduced: the lower layer unless focused; Data saver: always the lower.
 * Returns the quality of the chosen layer as the publisher advertised it (a
 * two-layer share is LOW + MEDIUM to the SFU — rids q / h).
 */
export function pickShareLayer(i: { layers: readonly LayerDims[]; role: TileRole; need: number; mode?: IncomingVideoMode; current?: VideoQuality }): VideoQuality {
    const l = i.layers;
    if (l.length <= 1) return l[0]?.quality ?? VideoQuality.HIGH;
    const low = l[0];
    const top = l[l.length - 1];
    if (i.mode === 'datasaver') return low.quality;
    if (i.role === 'focus') return top.quality;
    if (i.mode === 'reduced') return low.quality;
    const switchAt = Math.round(short(low) * UPSCALE_TOLERANCE);
    if (i.need > switchAt) return top.quality;
    if (i.current === top.quality && i.need > Math.round(switchAt * HYSTERESIS)) return top.quality;
    return low.quality;
}

// ── Decode cap ─────────────────────────────────────────────────────────────

export interface DecodeCandidates {
    /** Remote camera identities in display (roster) order. */
    order: readonly string[];
    /** The focused camera's identity, if any — always decoded. */
    focused?: string | null;
    /** Recent speakers, most recent first (SidebarConference promotedIds). */
    recentSpeakers?: readonly string[];
    /** Who was decoded last time — kept in preference, so the set is stable. */
    prev?: ReadonlySet<string>;
    cap: number;
}

/**
 * Which remote cameras get decoded when at most `cap` may be. Priority:
 * the focused camera, then recent speakers (most recent first), then whoever
 * was already decoded (stability: nobody is swapped out except to make room
 * for someone higher), then roster order. Everyone else shows their avatar
 * until they speak. Returns null when everyone fits (no cap in effect).
 */
export function chooseDecodedSet(c: DecodeCandidates): Set<string> | null {
    if (c.order.length <= c.cap) return null;
    const inRoster = new Set(c.order);
    const out: string[] = [];
    const add = (id: string | null | undefined) => {
        if (!id || out.length >= c.cap || !inRoster.has(id) || out.includes(id)) return;
        out.push(id);
    };
    add(c.focused);
    for (const id of c.recentSpeakers ?? []) add(id);
    for (const id of c.order) if (c.prev?.has(id)) add(id);
    for (const id of c.order) add(id);
    return new Set(out);
}

// ── Per-publication arbiter ────────────────────────────────────────────────

export interface QualityTarget {
    setVideoQuality(q: VideoQuality): void;
}

interface Entry {
    claims: Map<number, VideoQuality>;
    applied: VideoQuality | undefined;
    timer: ReturnType<typeof setTimeout> | null;
    /** When the last UPGRADE was requested (performance.now()) — diagnostics only. */
    upgradedAt: number | null;
}

const entries = new WeakMap<QualityTarget, Entry>();
let nextId = 1;

function entryFor(pub: QualityTarget): Entry {
    let e = entries.get(pub);
    if (!e) { e = { claims: new Map(), applied: undefined, timer: null, upgradedAt: null }; entries.set(pub, e); }
    return e;
}

function apply(pub: QualityTarget, e: Entry, q: VideoQuality) {
    if (e.applied === undefined || q > e.applied) e.upgradedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    e.applied = q;
    try { pub.setVideoQuality(q); } catch { /* unsubscribed meanwhile */ }
}

function settle(pub: QualityTarget, e: Entry) {
    if (e.claims.size === 0) {
        // Nobody shows it: leave the layer as is (remoteVideoDemand pauses
        // the stream), but drop any pending downgrade.
        if (e.timer) { clearTimeout(e.timer); e.timer = null; }
        return;
    }
    const want = Math.max(...e.claims.values()) as VideoQuality;
    if (e.applied === undefined || want > e.applied) {
        if (e.timer) { clearTimeout(e.timer); e.timer = null; }
        apply(pub, e, want); // upgrades: immediately
        return;
    }
    if (want === e.applied) {
        if (e.timer) { clearTimeout(e.timer); e.timer = null; }
        return;
    }
    // Downgrade: wait, re-evaluate at fire time.
    if (e.timer) return;
    e.timer = setTimeout(() => {
        e.timer = null;
        if (e.claims.size === 0) return;
        const now = Math.max(...e.claims.values()) as VideoQuality;
        if (e.applied === undefined || now !== e.applied) apply(pub, e, now);
    }, DOWNGRADE_DELAY_MS);
}

export interface QualityClaim {
    set(q: VideoQuality): void;
    release(): void;
}

/** One tile's say in the publication's layer. Release on unmount. */
export function claimRemoteQuality(pub: QualityTarget): QualityClaim {
    const e = entryFor(pub);
    const id = nextId++;
    let released = false;
    return {
        set(q) {
            if (released) return;
            if (e.claims.get(id) === q) return;
            e.claims.set(id, q);
            settle(pub, e);
        },
        release() {
            if (released) return;
            released = true;
            e.claims.delete(id);
            settle(pub, e);
        },
    };
}

/**
 * Ask for `q` (default: the top layer) now and hold it for `holdMs`, so the
 * layer is already flowing by the time a focus view mounts. Used on press
 * and hover of a focusable tile, and when the focused stream changes.
 */
export function prewarmRemoteQuality(pub: QualityTarget, q: VideoQuality = VideoQuality.HIGH, holdMs = PREWARM_HOLD_MS): () => void {
    const c = claimRemoteQuality(pub);
    c.set(q);
    const t = setTimeout(() => c.release(), holdMs);
    return () => { clearTimeout(t); c.release(); };
}

/**
 * Diagnostics: ms since the last upgrade request for this publication, or
 * null if none in the last `withinMs`. VideoTile logs it when the decoded
 * size changes — the focus-switch time, readable in the console on a real
 * call ("[VideoQuality] … 1920×1080, 540 ms after the upgrade request").
 */
export function msSinceUpgrade(pub: QualityTarget, withinMs = 10_000): number | null {
    const at = entries.get(pub)?.upgradedAt;
    if (at === null || at === undefined) return null;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const d = now - at;
    return d >= 0 && d <= withinMs ? Math.round(d) : null;
}

/** Test/diagnostic: the layer currently requested for a publication. */
export function appliedQuality(pub: QualityTarget): VideoQuality | undefined {
    return entries.get(pub)?.applied;
}
