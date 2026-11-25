/**
 * Page snapshots for link previews (main process). Owner, 2026-11-23: "I
 * want all pages to have a preview"; decision (a): when a page publishes no
 * preview picture, the SENDER's app takes a screenshot of the page.
 *
 * Only ever for a URL the unfurler just read as a real page without a picture
 * (unfurl.ts `snapshot: true`; ipc.ts refuses any other URL), only while
 * "Generate link previews" is on, and on the SENDER's device: the picture
 * then travels inside the end-to-end encrypted message like any thumbnail
 * (re-encoded to WebP by the renderer). Receivers never load the page.
 *
 * The window: an OFFSCREEN, never-shown BrowserWindow (1280x720) in a FRESH
 * IN-MEMORY session partition per snapshot (no cookies, cache, storage or
 * service workers shared with the app or with any other snapshot; cleared and
 * dropped afterwards):
 *   webPreferences  sandbox, contextIsolation, no nodeIntegration (any kind),
 *                   NO preload, webSecurity, no plugins, no WebGL, no
 *                   webview, no dialogs, autoplay needs a gesture (there is
 *                   none), audio muted, devtools off; JavaScript ON (most
 *                   pages draw nothing without it).
 *   denied          every permission request and check (camera, mic,
 *                   notifications, geolocation, clipboard, HID / serial / USB /
 *                   Bluetooth choosers, display capture), every popup
 *                   (window.open), every download (cancelled), HTTP auth
 *                   prompts, and any navigation after the first load (and a
 *                   cross-site one during it); WebRTC may not use UDP outside
 *                   the proxy.
 *   network         every request goes through the guarded loopback proxy
 *                   (snapshot-proxy.ts): https / wss to port 443 only, every
 *                   host resolved and checked against private / loopback /
 *                   link-local ranges and the tunnel pinned to that address
 *                   (DNS rebinding cannot reach the LAN); webRequest refuses
 *                   every other scheme and literal private addresses up front
 *                   (defence in depth) and caps the number of requests; the
 *                   proxy caps the bytes.
 *   UA              a normal desktop Chrome (EMBED_FETCH_UA): the link-preview
 *                   UA (WhatsApp/2) gets pages that do not render.
 *
 * Timing: load, then `did-finish-load` + a short settle, with a hard cap of
 * SNAPSHOT_LIMITS.hardCapMs from the start (a page still loading at the cap is
 * captured as it is if its document is there). The top viewport is captured,
 * judged (snapshot-verdict.ts: login / captcha / bot wall / error / blank
 * pages are never shown) and scaled to 1200x675 PNG for the renderer, which
 * re-encodes it to WebP (<= 150 KB).
 *
 * One snapshot at a time (createSnapshotQueue): queued, each cancellable by
 * its token (the renderer cancels when the link leaves the draft), the window
 * destroyed and the partition's data cleared after each.
 */
import { randomUUID } from 'crypto';
import type { BrowserWindow as BrowserWindowT, Session } from 'electron';
import { EMBED_FETCH_UA } from '../media-embed/pinned-fetch';
import { isPrivateIp } from '../net-guard';
import { cleanFacts, isLoginUrl, judgePage, pixelUniformity, PAGE_FACTS_SCRIPT, type PageFacts, type SnapshotVerdict } from './snapshot-verdict';
import { startSnapshotProxy, type SnapshotProxy } from './snapshot-proxy';
import { isIP } from 'net';

export const SNAPSHOT_LIMITS = {
    viewport: { width: 1280, height: 720 },
    output: { width: 1200, height: 675 },
    /** From loadURL to capture, whatever the page does. */
    hardCapMs: 4000,
    /** After did-finish-load, for late layout / fonts / hero images. */
    settleMs: 700,
    /** The whole job (capture + judging included) before the window is killed. */
    watchdogMs: 7000,
    maxRequests: 300,
    maxBytes: 20 * 1024 * 1024,
    maxRedirects: 5,
    /** Snapshots waiting behind the running one. */
    maxQueued: 6,
} as const;

export type SnapshotFailure = 'login' | 'bot-wall' | 'error' | 'blank' | 'failed' | 'timeout' | 'cancelled' | 'busy' | 'invalid' | 'not-eligible';

export interface SnapshotCounters {
    requests: number;
    blockedScheme: number;
    blockedPrivate: number;
    blockedOverCap: number;
    popups: number;
    downloads: number;
    permissions: number;
    navigationsBlocked: number;
    proxyTunnels: number;
    proxyRefused: number;
    proxyBytes: number;
}

export type SnapshotResult =
    | { ok: true; bytes: Uint8Array; mime: 'image/png'; width: number; height: number; ms: number; counters?: SnapshotCounters }
    | { ok: false; reason: SnapshotFailure; ms?: number; counters?: SnapshotCounters };

// ── The queue (pure, unit-tested) ──────────────────────────────────────────

type Runner = (url: string, signal: AbortSignal) => Promise<SnapshotResult>;

export interface SnapshotQueue {
    request(url: string, token: string): Promise<SnapshotResult>;
    /** Cancel a queued or running snapshot. True when there was one. */
    cancel(token: string): boolean;
    /** Test / dev: what is waiting and running. */
    state(): { running: string | null; queued: string[] };
}

export function createSnapshotQueue(run: Runner, maxQueued: number = SNAPSHOT_LIMITS.maxQueued): SnapshotQueue {
    interface Job { url: string; token: string; ac: AbortController; promise: Promise<SnapshotResult>; done: (r: SnapshotResult) => void }
    const queued: Job[] = [];
    let running: Job | null = null;
    const pump = () => {
        if (running || queued.length === 0) return;
        const job = queued.shift()!;
        running = job;
        run(job.url, job.ac.signal)
            .catch((): SnapshotResult => ({ ok: false, reason: 'failed' }))
            .then((r) => job.done(job.ac.signal.aborted && r.ok ? { ok: false, reason: 'cancelled' } : r))
            .finally(() => { running = null; pump(); });
    };
    return {
        request(url, token) {
            const same = running?.token === token ? running : queued.find((j) => j.token === token);
            if (same) return same.promise;
            if (queued.length >= maxQueued) return Promise.resolve({ ok: false, reason: 'busy' });
            let done!: (r: SnapshotResult) => void;
            const promise = new Promise<SnapshotResult>((ok) => { done = ok; });
            queued.push({ url, token, ac: new AbortController(), promise, done });
            pump();
            return promise;
        },
        cancel(token) {
            const i = queued.findIndex((j) => j.token === token);
            if (i !== -1) {
                const [job] = queued.splice(i, 1);
                job.done({ ok: false, reason: 'cancelled' });
                return true;
            }
            if (running?.token === token) { running.ac.abort(); return true; }
            return false;
        },
        state: () => ({ running: running?.url ?? null, queued: queued.map((j) => j.url) }),
    };
}

// ── The request policy (pure, unit-tested) ────────────────────────────────

const ALLOWED_SCHEMES = new Set(['https:', 'wss:', 'data:', 'blob:', 'about:']);
const LOCAL_NAME_RE = /^(?:localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa)\.?$/i;

/** What webRequest does with one request of the snapshot window (before the proxy's own checks). */
export function snapshotRequestDecision(rawUrl: string, requestsSoFar: number): 'allow' | 'scheme' | 'private' | 'cap' {
    if (requestsSoFar >= SNAPSHOT_LIMITS.maxRequests) return 'cap';
    let u: URL;
    try { u = new URL(rawUrl); } catch { return 'scheme'; }
    if (!ALLOWED_SCHEMES.has(u.protocol)) return 'scheme';
    if (u.protocol === 'https:' || u.protocol === 'wss:') {
        const host = u.hostname.replace(/^\[|\]$/g, '');
        if (isIP(host) ? isPrivateIp(host) : LOCAL_NAME_RE.test(host) || !host.includes('.')) return 'private';
        if (u.port && u.port !== '443') return 'private';
    }
    return 'allow';
}

/** The registrable-ish site of a host (last two labels; three under a two-letter public suffix like co.uk). */
export function siteOf(raw: string): string {
    let host: string;
    try { host = new URL(raw).hostname.toLowerCase(); } catch { return ''; }
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    const two = parts.slice(-2);
    const short = two[0].length <= 3 && two[1].length === 2; // co.uk, com.au, co.jp
    return parts.slice(short ? -3 : -2).join('.');
}

// ── One snapshot (Electron) ────────────────────────────────────────────────

export interface SnapshotDeps {
    BrowserWindow: typeof BrowserWindowT;
    fromPartition: (partition: string, options?: { cache: boolean }) => Session;
    log?: (line: string) => void;
    /** Test seam for the proxy. */
    startProxy?: typeof startSnapshotProxy;
    /**
     * Harness seam only (never set by main.ts): runs after every guard is
     * installed on the snapshot's session and before the page loads, so the
     * harness can serve its control page from memory to prove the guards.
     */
    prepareSession?: (ses: Session) => void | Promise<void>;
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
    new Promise((ok) => {
        const t = setTimeout(() => ok(fallback), ms);
        p.then((v) => { clearTimeout(t); ok(v); }, () => { clearTimeout(t); ok(fallback); });
    });

export async function takePageSnapshot(url: string, signal: AbortSignal, deps: SnapshotDeps): Promise<SnapshotResult> {
    const t0 = Date.now();
    const counters: SnapshotCounters = { requests: 0, blockedScheme: 0, blockedPrivate: 0, blockedOverCap: 0, popups: 0, downloads: 0, permissions: 0, navigationsBlocked: 0, proxyTunnels: 0, proxyRefused: 0, proxyBytes: 0 };
    if (signal.aborted) return { ok: false, reason: 'cancelled' };
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { ok: false, reason: 'invalid' }; }
    if (parsed.protocol !== 'https:') return { ok: false, reason: 'invalid' };

    let proxy: SnapshotProxy | null = null;
    let win: BrowserWindowT | null = null;
    // In-memory (no `persist:` prefix), unique per snapshot, no HTTP cache.
    const ses = deps.fromPartition(`cl-snapshot-${randomUUID()}`, { cache: false });
    const onDownload = (e: Electron.Event, item: Electron.DownloadItem) => { counters.downloads++; e.preventDefault(); try { item.cancel(); } catch { /* gone */ } };
    const denyChooser = (e: Electron.Event, ...rest: unknown[]) => { e.preventDefault(); const cb = rest.find((x) => typeof x === 'function') as ((id: string) => void) | undefined; try { cb?.(''); } catch { /* ignore */ } };
    const finish = (r: SnapshotResult): SnapshotResult => ({ ...r, ms: Date.now() - t0, counters: { ...counters, ...(proxy ? (({ tunnels, refused, bytes }) => ({ proxyTunnels: tunnels, proxyRefused: refused, proxyBytes: bytes }))(proxy.stats()) : {}) } } as SnapshotResult);
    try {
        proxy = await (deps.startProxy ?? startSnapshotProxy)({ maxBytes: SNAPSHOT_LIMITS.maxBytes, log: deps.log });
        await ses.setProxy({ mode: 'fixed_servers', proxyRules: `127.0.0.1:${proxy.port}`, proxyBypassRules: '<-loopback>' });
        ses.setPermissionRequestHandler((_wc, _permission, callback) => { counters.permissions++; callback(false); });
        ses.setPermissionCheckHandler(() => false);
        ses.setDevicePermissionHandler(() => false);
        ses.setDisplayMediaRequestHandler((_req, callback) => { counters.permissions++; callback({}); });
        ses.setSpellCheckerEnabled(false);
        // Every request (subresources and scripts' too) and navigator.userAgent:
        // a stock desktop Chrome, never Electron's default (which names the app).
        ses.setUserAgent(EMBED_FETCH_UA, 'en-US,en');
        ses.on('will-download', onDownload);
        ses.on('select-hid-device', denyChooser as never);
        ses.on('select-serial-port', denyChooser as never);
        ses.on('select-usb-device', denyChooser as never);
        ses.webRequest.onBeforeRequest((details, callback) => {
            const d = snapshotRequestDecision(details.url, counters.requests);
            if (d === 'allow') { counters.requests++; callback({}); return; }
            if (d === 'scheme') counters.blockedScheme++;
            else if (d === 'private') counters.blockedPrivate++;
            else counters.blockedOverCap++;
            callback({ cancel: true });
        });
        await deps.prepareSession?.(ses);
        if (signal.aborted) return finish({ ok: false, reason: 'cancelled' });

        win = new deps.BrowserWindow({
            show: false,
            width: SNAPSHOT_LIMITS.viewport.width,
            height: SNAPSHOT_LIMITS.viewport.height,
            useContentSize: true,
            frame: false,
            skipTaskbar: true,
            focusable: false,
            paintWhenInitiallyHidden: true,
            webPreferences: {
                offscreen: true,
                session: ses,
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                nodeIntegrationInSubFrames: false,
                nodeIntegrationInWorker: false,
                webviewTag: false,
                javascript: true,
                webSecurity: true,
                allowRunningInsecureContent: false,
                plugins: false,
                experimentalFeatures: false,
                webgl: false,
                spellcheck: false,
                disableDialogs: true,
                autoplayPolicy: 'user-gesture-required',
                backgroundThrottling: false,
                navigateOnDragDrop: false,
                devTools: false,
            },
        });
        win.setContentProtection(true);
        const wc = win.webContents;
        let loaded = false;
        let domReady = false;
        let failed = false;
        let gone = false;
        let loginSeen = false;
        let redirects = 0;
        let httpStatus = 0;
        wc.setUserAgent(EMBED_FETCH_UA);
        wc.setAudioMuted(true);
        wc.setFrameRate(10);
        wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
        wc.setWindowOpenHandler(() => { counters.popups++; return { action: 'deny' }; });
        wc.on('will-prevent-unload', (e) => e.preventDefault());
        wc.on('select-bluetooth-device', (e, _list, cb) => { e.preventDefault(); cb(''); });
        wc.on('login', (e, _details, _auth, cb) => { e.preventDefault(); loginSeen = true; cb(); });

        const startSite = siteOf(url);
        wc.on('will-redirect', (e) => {
            // A server redirect of the page itself (frames load freely, through the same guards).
            if (!e.isMainFrame) return;
            const target = e.url;
            redirects++;
            if (isLoginUrl(target)) { loginSeen = true; counters.navigationsBlocked++; e.preventDefault(); return; }
            if (loaded || redirects > SNAPSHOT_LIMITS.maxRedirects || !/^https:/i.test(target)) { counters.navigationsBlocked++; e.preventDefault(); }
        });
        wc.on('will-navigate', (e) => {
            // Renderer-initiated (a script, a meta refresh, a click): never after
            // the first load, never to another site.
            if (!e.isMainFrame) return;
            const target = e.url;
            if (isLoginUrl(target)) loginSeen = true;
            if (loaded || isLoginUrl(target) || siteOf(target) !== startSite || !/^https:/i.test(target)) { counters.navigationsBlocked++; e.preventDefault(); }
        });
        wc.on('did-navigate', (_e, _u, code) => { if (typeof code === 'number' && code > 0) httpStatus = code; });
        wc.on('dom-ready', () => { domReady = true; });
        wc.on('did-fail-load', (_e, code, _desc, _u, isMainFrame) => { if (isMainFrame && code !== -3) failed = true; });
        wc.on('render-process-gone', () => { gone = true; });

        let wake: () => void = () => {};
        wc.on('did-finish-load', () => { loaded = true; wake(); });
        const aborted = new Promise<void>((ok) => { if (signal.aborted) ok(); else signal.addEventListener('abort', () => ok(), { once: true }); });

        void wc.loadURL(url, { userAgent: EMBED_FETCH_UA, extraHeaders: 'Accept-Language: en-US,en;q=0.9\n' }).catch(() => { /* did-fail-load says */ });

        // did-finish-load + settle, within the hard cap.
        const cap = t0 + SNAPSHOT_LIMITS.hardCapMs;
        await Promise.race([
            new Promise<void>((ok) => { wake = ok; if (loaded) ok(); }),
            new Promise<void>((ok) => setTimeout(ok, Math.max(0, cap - Date.now()))),
            aborted,
        ]);
        if (signal.aborted) return finish({ ok: false, reason: 'cancelled' });
        if (loaded && !failed) {
            await Promise.race([new Promise<void>((ok) => setTimeout(ok, Math.min(SNAPSHOT_LIMITS.settleMs, Math.max(150, cap - Date.now())))), aborted]);
            if (signal.aborted) return finish({ ok: false, reason: 'cancelled' });
        }
        loaded = true; // from here on nothing navigates
        if (gone) return finish({ ok: false, reason: 'failed' });
        if (loginSeen) return finish({ ok: false, reason: 'login' });
        if (failed) return finish({ ok: false, reason: 'error' });
        if (!domReady) return finish({ ok: false, reason: 'timeout' });

        const left = () => Math.max(200, t0 + SNAPSHOT_LIMITS.watchdogMs - Date.now());
        const [facts, image] = await Promise.all([
            withTimeout<PageFacts | null>(wc.executeJavaScriptInIsolatedWorld(1999, [{ code: PAGE_FACTS_SCRIPT }]).then(cleanFacts), Math.min(1500, left()), null),
            withTimeout<Electron.NativeImage | null>(wc.capturePage({ x: 0, y: 0, ...SNAPSHOT_LIMITS.viewport }), left(), null),
        ]);
        if (signal.aborted) return finish({ ok: false, reason: 'cancelled' });
        if (!image || image.isEmpty()) return finish({ ok: false, reason: 'failed' });
        const size = image.getSize();
        const uniformity = pixelUniformity(new Uint8Array(image.toBitmap()), size.width, size.height);
        const verdict: SnapshotVerdict = judgePage({ facts, httpStatus, loginSeen, uniformity });
        deps.log?.(`[snapshot] ${parsed.hostname} ${verdict} status=${httpStatus} text=${facts?.textLength ?? '-'} media=${facts?.media ?? '-'} uniform=${uniformity.toFixed(3)} req=${counters.requests} ${Date.now() - t0}ms`);
        if (verdict !== 'ok') return finish({ ok: false, reason: verdict });
        const out = image.resize({ ...SNAPSHOT_LIMITS.output, quality: 'good' });
        const png = out.toPNG();
        return finish({ ok: true, bytes: new Uint8Array(png.buffer, png.byteOffset, png.byteLength), mime: 'image/png', ...out.getSize(), ms: 0 });
    } catch (e) {
        deps.log?.(`[snapshot] ${parsed.hostname} failed: ${e instanceof Error ? e.message : String(e)}`);
        return finish({ ok: false, reason: signal.aborted ? 'cancelled' : 'failed' });
    } finally {
        try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* gone */ }
        win = null;
        try { ses.webRequest.onBeforeRequest(null); } catch { /* ignore */ }
        ses.removeListener('will-download', onDownload);
        ses.removeAllListeners('select-hid-device');
        ses.removeAllListeners('select-serial-port');
        ses.removeAllListeners('select-usb-device');
        try { ses.setPermissionRequestHandler(null); ses.setPermissionCheckHandler(null); ses.setDevicePermissionHandler(null); ses.setDisplayMediaRequestHandler(null); } catch { /* ignore */ }
        await proxy?.close().catch(() => {});
        await ses.closeAllConnections().catch(() => {});
        await ses.clearData().catch(() => {});
    }
}

/** The app's snapshotter: one at a time, through the queue. */
export function createPageSnapshotter(deps: SnapshotDeps): SnapshotQueue {
    return createSnapshotQueue((url, signal) => {
        // The watchdog: a page that hangs its renderer (busy loop, huge
        // layout) cannot hold the queue; aborting destroys its window.
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), SNAPSHOT_LIMITS.watchdogMs + 1000);
        const onAbort = () => ac.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        return takePageSnapshot(url, ac.signal, deps)
            .then((r) => (!r.ok && r.reason === 'cancelled' && !signal.aborted ? { ...r, reason: 'timeout' as const } : r))
            .finally(() => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); });
    });
}
