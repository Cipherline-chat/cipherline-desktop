/**
 * The screen-share picker's source lists, kept between opens, so the picker
 * paints a full grid on the SAME frame it opens — names and the last
 * previews — and refreshes underneath instead of starting from a spinner.
 *
 * ── Measured cost of what the picker waits for (see the commit) ───────────
 * Every list comes from the main process's desktopCapturer.getSources(),
 * which is IPC + real capture work (one call at a time — electron/
 * desktop-sources.ts). Names alone (thumbnailSize 0x0) are the cheap part;
 * previews capture every source. The picker used to wait for an IPC round
 * trip before showing anything; with this cache a reopen shows the last grid
 * at once, and hovering the share button warms it before the first open.
 *
 * Rules that keep it honest:
 *   - names always come from a FRESH call before a selection can be trusted:
 *     a cached tile whose source has gone is dropped as soon as the names
 *     pass returns, and the main process only ever admits ids from its own
 *     latest list (desktop-capturer-resolve falls back to a fresh lookup);
 *   - a cached preview is kept for an id that is still present until its new
 *     preview arrives (a reopen never flashes back to placeholders);
 *   - memory only, this renderer; cleared with clearDesktopSourceCache()
 *     (sign-out) — previews are pictures of the user's screen.
 */

export type DesktopSourceKind = 'screen' | 'window';
export interface DesktopSourceTile { id: string; name: string; thumbnailDataUrl: string }

/** What main returns for a window with no capturable image. */
export const EMPTY_THUMB = 'data:image/png;base64,';
export const hasPreview = (s: DesktopSourceTile): boolean => !!s.thumbnailDataUrl && s.thumbnailDataUrl !== EMPTY_THUMB;

interface Entry { list: DesktopSourceTile[]; namesAt: number; previewsAt: number }
const cache = new Map<DesktopSourceKind, Entry>();

export function getCachedSources(kind: DesktopSourceKind): DesktopSourceTile[] | undefined {
    return cache.get(kind)?.list;
}

/**
 * A fresh NAMES list (no thumbnails) merged with what we had: the fresh list
 * decides which sources exist and their order/names; a previous preview is
 * carried over for an id that is still there.
 */
export function mergeNames(prev: readonly DesktopSourceTile[] | undefined, names: readonly DesktopSourceTile[]): DesktopSourceTile[] {
    const old = new Map((prev ?? []).map(s => [s.id, s]));
    return names.map(n => {
        const p = old.get(n.id);
        return { id: n.id, name: n.name, thumbnailDataUrl: p && hasPreview(p) ? p.thumbnailDataUrl : '' };
    });
}

/**
 * A fresh PREVIEWS list merged over the current one. Ids the previews call
 * did not return are dropped (the source went away between the two calls);
 * an empty preview for a present id keeps an older one only if there was one.
 */
export function mergePreviews(prev: readonly DesktopSourceTile[] | undefined, full: readonly DesktopSourceTile[]): DesktopSourceTile[] {
    const old = new Map((prev ?? []).map(s => [s.id, s]));
    return full.map(f => {
        if (hasPreview(f)) return { ...f };
        const p = old.get(f.id);
        return { ...f, thumbnailDataUrl: p && hasPreview(p) ? p.thumbnailDataUrl : f.thumbnailDataUrl };
    });
}

export function storeNames(kind: DesktopSourceKind, names: readonly DesktopSourceTile[], now = Date.now()): DesktopSourceTile[] {
    const prev = cache.get(kind);
    const list = mergeNames(prev?.list, names);
    cache.set(kind, { list, namesAt: now, previewsAt: prev?.previewsAt ?? 0 });
    return list;
}

export function storePreviews(kind: DesktopSourceKind, full: readonly DesktopSourceTile[], now = Date.now()): DesktopSourceTile[] {
    const prev = cache.get(kind);
    const list = mergePreviews(prev?.list, full);
    cache.set(kind, { list, namesAt: now, previewsAt: now });
    return list;
}

/** Bumped by clearDesktopSourceCache: a run started before it must not refill the cache. */
let generation = 0;

export function clearDesktopSourceCache(): void {
    generation++;
    cache.clear();
    inflight.clear();
}

// ── Refresh runs (the picker AND the warm-up share them) ──────────────────

export type GetSources = (types: DesktopSourceKind[], opts?: { thumbnails?: boolean }) => Promise<DesktopSourceTile[]>;

/** One refresh of one tab: names first, then previews. Both resolve to the merged, cached list. */
export interface RefreshRun {
    names: Promise<DesktopSourceTile[]>;
    previews: Promise<DesktopSourceTile[]>;
    /** Set by cancelDesktopSourceRefresh: the previews capture is not started. */
    cancelled: boolean;
}

const inflight = new Map<DesktopSourceKind, RefreshRun>();

/**
 * Refresh one tab's list. SINGLE-FLIGHT per tab: while a run is going (the
 * click's warm-up, a hover warm-up, the picker itself), every caller gets
 * that same run instead of starting another. That matters because the main
 * process runs enumerations one at a time — measured in the harness, a
 * picker that issued its own names call while the warm-up's previews call
 * was running waited for the whole previews capture before showing a tile.
 */
export function refreshDesktopSources(kind: DesktopSourceKind, getSources: GetSources): RefreshRun {
    const running = inflight.get(kind);
    if (running) return running;
    const g = generation;
    const names = getSources([kind], { thumbnails: false })
        .then(n => (g === generation ? storeNames(kind, n) : mergeNames(undefined, n)));
    const run = { names, cancelled: false } as RefreshRun;
    run.previews = names.then(() => {
        if (run.cancelled) throw new Error('preview capture cancelled (picker closed)');
        return getSources([kind]);
    }).then(full => (g === generation ? storePreviews(kind, full) : mergePreviews(undefined, full)));
    const previews = run.previews;
    inflight.set(kind, run);
    const done = () => { if (inflight.get(kind) === run) inflight.delete(kind); };
    previews.then(done, done);
    // Callers attach their own handlers; an unobserved rejection is not an error here.
    names.catch(() => {});
    previews.catch(() => {});
    return run;
}

/**
 * The picker closed: a run whose names are still in flight will not go on to
 * capture previews nobody is going to look at. (A capture already running in
 * the main process cannot be interrupted — Electron's getSources has no
 * cancel — but it is never followed by more work.)
 */
export function cancelDesktopSourceRefresh(kind: DesktopSourceKind): void {
    const run = inflight.get(kind);
    if (!run) return;
    run.cancelled = true;
    inflight.delete(kind);
}

/** A warm-up within this long of the last completed previews is skipped. */
export const PREFETCH_FRESH_MS = 10_000;

/**
 * Warm the cache for one tab (hovering the share button, or the click
 * itself, before the modal has mounted). Skipped while the cached previews
 * are younger than PREFETCH_FRESH_MS; joins a run already going. Never throws.
 */
export function prefetchDesktopSources(kind: DesktopSourceKind, getSources: GetSources | undefined, now = Date.now()): Promise<void> {
    if (!getSources) return Promise.resolve();
    const e = cache.get(kind);
    if (e && now - e.previewsAt < PREFETCH_FRESH_MS && !inflight.has(kind)) return Promise.resolve();
    return refreshDesktopSources(kind, getSources).previews.then(() => {}, () => {});
}

// ── Click-to-paint timing ─────────────────────────────────────────────────

let requestedAt: number | null = null;
/** A click older than this is not what opened the picker. */
export const PICKER_CLICK_WINDOW_MS = 5000;
/** The share button was clicked (performance.now()). */
export function markPickerRequested(at = performance.now()): void { requestedAt = at; }
/**
 * The click that opened the picker, or null (opened some other way, or too
 * long ago). Idempotent — safe in a React state initializer, which
 * StrictMode runs twice.
 */
export function pickerRequestedAt(now = performance.now()): number | null {
    return requestedAt !== null && now - requestedAt >= 0 && now - requestedAt <= PICKER_CLICK_WINDOW_MS ? requestedAt : null;
}

/** Test-only. */
export function __resetDesktopSourceCacheForTests(): void {
    clearDesktopSourceCache();
    requestedAt = null;
}
