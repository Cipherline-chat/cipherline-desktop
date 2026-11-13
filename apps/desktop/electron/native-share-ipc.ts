/**
 * IPC for the native (Linux hardware) share encoder. Registered by main.ts on Linux when the helper binary exists; whether a share USES
 * it is a renderer decision (utils/nativeShareSelect.ts, off by default). Pure of Electron imports: ipcMain and the MessageChannelMain
 * factory are injected so it is testable and so electron/ keeps importing nothing from src/.
 *
 * Every payload from the renderer is validated against an allowlist here; the helper path is pinned by main and never taken from the
 * renderer, and `device` is deliberately not accepted.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isCaptureSourceId } from './capture-consent';
import {
    startNativeShareEncoder, helperExitReason, parseHelperEvent, RESTORE_TOKEN_RE,
    type NativeShareEncoderArgs, type NativeShareEncoderHandle,
} from './native-share-encoder';

export const NATIVE_SHARE_LIMITS = { minDim: 64, maxDim: 7680, maxFps: 240, minBps: 100_000, maxBps: 200_000_000 } as const;

/** Validate renderer-supplied start args against an allowlist. Returns the sanitized args or null. */
export function sanitizeStartArgs(raw: unknown, helperPath: string, allowTestBackend = false): NativeShareEncoderArgs | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const L = NATIVE_SHARE_LIMITS;
    const int = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null);
    const width = int(r.width, L.minDim, L.maxDim), height = int(r.height, L.minDim, L.maxDim);
    const fps = int(r.fps, 1, L.maxFps), bitrateBps = int(r.bitrateBps, L.minBps, L.maxBps);
    const backend = r.backend === 'nvenc' ? 'nvenc' : r.backend === 'pcm' && allowTestBackend ? 'pcm' : 'vaapi';
    if (width === null || height === null || fps === null || bitrateBps === null) return null;
    // `device` is deliberately NOT accepted from the renderer: the helper picks the default render node / first CUDA device.
    const out: NativeShareEncoderArgs = { helperPath, backend, width, height, fps, bitrateBps };
    if (r.capture !== undefined) {
        const c = r.capture;
        if (!c || typeof c !== 'object') return null;
        const cc = c as Record<string, unknown>;
        const source = cc.source === 'monitor' || cc.source === 'window' || cc.source === 'any' ? cc.source : null;
        if (source === null || typeof cc.persist !== 'boolean') return null;
        let restoreToken: string | undefined;
        if (cc.restoreToken !== undefined && cc.restoreToken !== '') {
            if (typeof cc.restoreToken !== 'string' || !RESTORE_TOKEN_RE.test(cc.restoreToken)) return null;
            restoreToken = cc.restoreToken;
        }
        out.capture = { source, persist: cc.persist, ...(restoreToken ? { restoreToken } : {}) };
    }
    return out;
}

/**
 * Commands the worker may send over the port. Anything else is ignored. `layer: 'low'` addresses the lighter copy's own encoder session
 * (nativeShareInject.ts: a second simulcast layer); `{ cmd: 'low' }` opens (with an integer size/rate/bitrate) or closes that session.
 */
export function portCommandLine(m: unknown): string | null {
    if (!m || typeof m !== 'object') return null;
    const c = m as { cmd?: unknown; bps?: unknown; layer?: unknown; on?: unknown; w?: unknown; h?: unknown; fps?: unknown };
    const low = c.layer === 'low';
    const bpsOk = typeof c.bps === 'number' && Number.isInteger(c.bps) && c.bps >= NATIVE_SHARE_LIMITS.minBps && c.bps <= NATIVE_SHARE_LIMITS.maxBps;
    if (c.cmd === 'idr') return low ? 'LOW_IDR' : 'IDR';
    if (c.cmd === 'refresh') return low ? null : 'REFRESH';   // intra-refresh is a full-layer feature; the copy always answers with an IDR
    if (c.cmd === 'bitrate' && bpsOk) return `${low ? 'LOW_BITRATE' : 'BITRATE'} ${c.bps}`;
    if (c.cmd === 'preview') {
        // The sharer's own thumbnail (native/share-encoder/preview.h): a bounded width and rate, or off. Full-layer only.
        if (low) return null;
        if (c.on === false) return 'PREVIEW OFF';
        const int = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null);
        const w = int(c.w, 64, 1280), fps = int(c.fps, 1, 15);
        return c.on === true && w !== null && fps !== null ? `PREVIEW ${w} ${fps}` : null;
    }
    if (c.cmd === 'low') {
        if (c.on === false) return 'LOW OFF';
        const int = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null);
        const w = int(c.w, 16, NATIVE_SHARE_LIMITS.maxDim), h = int(c.h, 16, NATIVE_SHARE_LIMITS.maxDim), fps = int(c.fps, 1, 60);
        if (c.on === true && w !== null && h !== null && fps !== null && bpsOk) return `LOW ${w} ${h} ${fps} ${c.bps}`;
    }
    return null;
}

/** The share's consent binding, from the renderer: the pick's source id and the grant minted for it. Shape-checked only; main's consent decides. */
export function sanitizeShareBinding(raw: unknown): { sourceId: string; token: string } | null {
    const g = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).grant : null;
    if (!g || typeof g !== 'object') return null;
    const { sourceId, token } = g as Record<string, unknown>;
    if (!isCaptureSourceId(sourceId) || typeof token !== 'string' || token.length < 1 || token.length > 200) return null;
    return { sourceId, token };
}

/** The part of capture-consent the native share needs (see createCaptureConsent().beginNativeShare). */
export interface NativeShareConsent { beginNativeShare(senderId: number, token: unknown, sourceId: unknown): { commit: () => boolean } | null }

interface PortMainLike { postMessage(m: unknown, t?: unknown[]): void; on(ev: 'message', cb: (e: { data: unknown }) => void): void; start(): void; close(): void }
interface SenderLike { id?: number; postMessage(ch: string, m: unknown, t?: unknown[]): void; send(ch: string, ...a: unknown[]): void; once?(ev: string, cb: () => void): void }
interface IpcLike { handle(ch: string, fn: (e: { sender: SenderLike }, arg?: unknown) => unknown): void }

export interface NativeShareIpcOptions {
    /** Raw helper stderr lines (diagnostics / tests). Events for the renderer are parsed and forwarded regardless. */
    onHelperLine?: (line: string) => void;
    /** Accept backend 'pcm' (the software test backend). Never set in a shipping build; the lab harness sets it. */
    allowTestBackend?: boolean;
    exists?: (p: string) => boolean;
    /** main's capture consent: lets a native share's audio start (the share is main's own helper, so main binds the grant). */
    consent?: NativeShareConsent;
}

export function registerNativeShareIpc(ipc: IpcLike, newChannel: () => { port1: PortMainLike; port2: unknown }, helperPath: string, opts: NativeShareIpcOptions | ((line: string) => void) = {}): void {
    const o: NativeShareIpcOptions = typeof opts === 'function' ? { onHelperLine: opts } : opts;
    const exists = o.exists ?? existsSync;
    let cur: { handle: NativeShareEncoderHandle; port: PortMainLike } | null = null;
    const stop = () => { if (cur) { cur.handle.stop(); try { cur.port.close(); } catch { /* closed */ } cur = null; } };
    ipc.handle('native-share:available', () => ({ helper: exists(helperPath) }));
    ipc.handle('native-share:start', (event, raw) => {
        const args = sanitizeStartArgs(raw, helperPath, o.allowTestBackend === true);
        if (!args) return { ok: false, error: 'invalid arguments' };
        if (!exists(helperPath)) return { ok: false, error: 'helper missing' };
        stop();
        // Bind the renderer's grant to THIS native session before anything runs; committed once the helper really captures.
        const binding = sanitizeShareBinding(raw);
        const bound = binding && o.consent && typeof event.sender.id === 'number' ? o.consent.beginNativeShare(event.sender.id, binding.token, binding.sourceId) : null;
        const { port1, port2 } = newChannel();
        let handle: NativeShareEncoderHandle;
        try {
            handle = startNativeShareEncoder(args,
                // MessagePortMain can only transfer ports, so this is a structured-clone copy (cost measured in the design doc).
                (b) => { try { const copy = new Uint8Array(b.length); copy.set(b); port1.postMessage(copy.buffer); } catch { /* port closed */ } },
                (code) => {
                    const reason = helperExitReason(code);
                    try { port1.postMessage({ exit: code ?? -1 }); event.sender.send('native-share:exit', { code: code ?? -1, reason }); } catch { /* window gone */ }
                },
                (line) => {
                    o.onHelperLine?.(line);
                    const ev = parseHelperEvent(line);
                    if (ev && (ev as { event?: unknown }).event === 'format' && bound) bound.commit();   // first frame + encoder open: the capture is live
                    if (ev) { try { event.sender.send('native-share:event', ev); } catch { /* window gone */ } }
                });
        } catch (e) { return { ok: false, error: String((e as Error).message) }; }
        port1.on('message', (m) => { const line = portCommandLine(m.data); if (line) { try { handle.child.stdin.write(line + '\n'); } catch { /* helper gone */ } } });
        port1.start();
        cur = { handle, port: port1 };
        event.sender.once?.('destroyed', stop);   // the window (and so the call) is gone: never leave a capture running
        event.sender.postMessage('native-share:port', null, [port2]);
        return { ok: true };
    });
    ipc.handle('native-share:stop', () => { stop(); return { ok: true }; });
    ipc.handle('native-share:probe', (_e, raw) => {
        const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
        const int = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);
        const w = int(r.width, 64, 7680), h = int(r.height, 64, 4320), f = int(r.fps, 1, 240);
        return probeBackends(helperPath, 8000, w && h && f ? { width: w, height: h, fps: f } : undefined);
    });
}

export interface NvencInfo { gpu: string; driver: string; nvencApi: string; capW: number; capH: number; bgrxInput: boolean; device?: string; vaDriver?: string; entrypoint?: string; rc?: string; profile?: string; packedHeaders?: number }
export interface BackendProbe {
    vaapi: boolean; nvenc: boolean;
    detail: Record<string, string>;
    /** What the NVENC open reported (GPU, driver, negotiated API, size limits). Absent when NVENC is unavailable. */
    nvencInfo?: NvencInfo;
    /** What the VA-API open chose (render node, GPU, VA driver, entrypoint, rate control, packed-header mask). Absent when VA-API is unavailable. */
    vaapiInfo?: NvencInfo;
    /** Frames/s the encoder sustained at the requested size in a short unpaced run (the capability-driven ceiling). Absent unless asked for. */
    sustainedFps?: number;
}

function jsonLines(stderr: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const l of stderr.split('\n')) { if (l[0] !== '{' || l.length > 2000) continue; try { const v = JSON.parse(l) as unknown; if (v && typeof v === 'object') out.push(v as Record<string, unknown>); } catch { /* not JSON */ } }
    return out;
}

/** Pure: the helper's probe stderr -> what the app needs. */
export function parseProbeOutput(stderr: string): { info?: NvencInfo; sustainedFps?: number } {
    let info: NvencInfo | undefined, sustainedFps: number | undefined;
    for (const j of jsonLines(stderr)) {
        const s = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
        const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
        if (j.open === 'ok') info = { gpu: s(j.gpu, 96), driver: s(j.driver, 48), nvencApi: s(j.nvenc_api, 12), capW: n(j.cap_w || j.max_w), capH: n(j.cap_h || j.max_h), bgrxInput: j.bgrx_input === 1,
            ...(typeof j.device === 'string' ? { device: s(j.device, 64), vaDriver: s(j.va_driver, 16), entrypoint: s(j.entrypoint, 16), rc: s(j.rc, 24), profile: s(j.profile, 24), packedHeaders: n(j.packed_headers) } : {}) };
        else if (typeof j.fps === 'number' && j.mode === 'bench' && Number.isFinite(j.fps)) sustainedFps = Math.round(j.fps);
        else if (typeof j.fps === 'number' && typeof j.mode === 'string' && Number.isFinite(j.fps)) sustainedFps = Math.round(j.fps);
    }
    return { info, sustainedFps };
}

/** Ask the helper whether each backend can open (a real open: driver present, device usable). Never throws; unavailable is a normal answer. */
export function probeBackends(helperPath: string, timeoutMs = 8000, size?: { width: number; height: number; fps: number }): Promise<BackendProbe> {
    const one = (backend: 'vaapi' | 'nvenc', calibrate = backend === 'nvenc') => new Promise<{ ok: boolean; line: string; stderr: string }>((resolve) => {
        const w = size?.width ?? 1280, h = size?.height ?? 720, f = size?.fps ?? 30;
        const argv = ['--probe', '--backend', backend, '--width', String(w), '--height', String(h), '--fps', String(f), '--bitrate', '4000000'];
        if (size && calibrate) argv.push('--calibrate', '45');
        execFile(helperPath, argv, { timeout: timeoutMs, windowsHide: true }, (err, _out, stderr) => {
            const text = String(stderr);
            const line = text.split('\n').filter((l) => l.startsWith('{') && !l.includes('"event"')).shift() ?? '';
            resolve({ ok: !err, line: line.slice(0, 200), stderr: text });
        });
    });
    // NVENC wins whenever it opens, so only an NVENC-less machine pays for a VA-API calibration run.
    return one('nvenc').then(async (n) => {
        const v = await one('vaapi', !n.ok);
        const pn = n.ok ? parseProbeOutput(n.stderr) : {};
        const pv = v.ok ? parseProbeOutput(v.stderr) : {};
        const sustained = n.ok ? pn.sustainedFps : pv.sustainedFps;
        return {
            vaapi: v.ok, nvenc: n.ok, detail: { vaapi: v.line, nvenc: n.line },
            ...(pn.info ? { nvencInfo: pn.info } : {}), ...(pv.info ? { vaapiInfo: pv.info } : {}), ...(sustained !== undefined ? { sustainedFps: sustained } : {}),
        };
    });
}
