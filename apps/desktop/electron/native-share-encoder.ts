/**
 * Main-process side of the native share encoder (Linux hardware screen share, experimental, off by default).
 * See docs/plans/native-share-encoder.md. Deliberately imports nothing from src/ (Electron rootDir trap).
 *
 * Spawns native/share-encoder/build/share-encoder-helper, forwards its stdout (framed access units; parsed in the E2EE worker by
 * src/utils/nativeShareInject.ts AccessUnitParser) and relays IDR / REFRESH / BITRATE commands. In capture mode the helper owns the
 * screen: xdg-desktop-portal ScreenCast -> PipeWire -> encoder, and reports what happened as one JSON object per stderr line.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export const NATIVE_SHARE_ENV_FLAG = 'CIPHERLINE_NATIVE_SHARE_ENCODER';

export function isNativeShareEncoderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return (env[NATIVE_SHARE_ENV_FLAG] ?? '').trim() === '1';
}

/** Real-screen capture (portal ScreenCast -> PipeWire) instead of the synthetic source. width/height are then the MAX encode size. */
export interface NativeCaptureOpts { source: 'monitor' | 'window' | 'any'; persist: boolean; restoreToken?: string }
export interface NativeShareEncoderArgs { helperPath: string; backend: 'vaapi' | 'nvenc' | 'pcm'; width: number; height: number; fps: number; bitrateBps: number; device?: string; capture?: NativeCaptureOpts }

/** A restore token is an opaque portal string. It reaches the helper over stdin (never argv/env, which other processes can read); keep it to a safe charset anyway. */
export const RESTORE_TOKEN_RE = /^[A-Za-z0-9_\-+=.:/]{1,512}$/;

export function helperArgv(a: NativeShareEncoderArgs): string[] {
    const ints = [a.width, a.height, a.fps, a.bitrateBps];
    if (!ints.every(n => Number.isInteger(n) && n > 0 && n <= 1 << 30)) throw new Error('invalid encoder geometry/bitrate');
    const common = ['--backend', a.backend, '--width', String(a.width), '--height', String(a.height), '--fps', String(a.fps), '--bitrate', String(a.bitrateBps)];
    let argv: string[];
    if (a.capture) {
        argv = ['--capture', ...common, '--source', a.capture.source];
        if (a.capture.persist) argv.push('--persist');
        if (a.capture.restoreToken) {
            if (!RESTORE_TOKEN_RE.test(a.capture.restoreToken)) throw new Error('invalid restore token');
            argv.push('--restore-stdin');
        }
    } else argv = ['--serve', ...common];
    if (a.device) argv.push('--device', a.device);
    return argv;
}

/** helper exit code -> the stable reason the renderer reports (call_events) and falls back on. */
export function helperExitReason(code: number | null): string {
    switch (code) {
        case 0: return 'stopped';
        case 3: return 'open_failed';
        case 4: return 'encode_failed';
        case 5: return 'source_ended';
        case 6: return 'no_frames';
        case 10: return 'no_dbus';
        case 11: return 'no_portal';
        case 12: return 'portal_denied';
        case 13: return 'portal_protocol';
        case 14: return 'pipewire_unavailable';
        case 15: return 'encoder_open_failed';
        case 16: return 'session_limit';
        case 17: return 'driver_too_old';
        case 18: return 'size_over_limit';
        case null: return 'killed';
        default: return `helper_exit_${code}`;
    }
}

export type HelperEvent =
    | { event: 'portal'; width: number; height: number; sourceType: number; cursor: string; restoreToken: string;
        /** The stream's compositor position (portal `position`), only when the portal gave one. Optional by spec. */
        position?: { x: number; y: number };
        /** How long the portal's Start took, ms: a restored grant answers at once, a chooser waits on a person. 0 = not reported. */
        startMs: number }
    | { event: 'format'; srcW: number; srcH: number; w: number; h: number; encoder: string; gpu: string; driver: string; nvencApi: string; profile: string }
    | { event: 'stats'; encoder: string; w: number; h: number; fps: number; inFps: number; dropped: number; idleRepeats: number; encMsP50: number; encMsP95: number; encMsMax: number; kbps: number; effFps: number; low: boolean; lowFps: number; lowKbps: number }
    | { event: 'low'; state: 'on' | 'off'; reason: string; w: number; h: number }
    | { event: 'low_failed'; code: string; message: string }
    | { event: 'fps_limited'; fps: number; requested: number; encMsP95: number }
    | { event: 'ended'; reason: string }
    | { event: 'error'; message: string; code: string };

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f]/g;
const str = (v: unknown, max = 160): string => (typeof v === 'string' ? v.replace(CTRL, ' ').slice(0, max) : '');
const num = (v: unknown, lo = 0, hi = 1e9): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);

/**
 * One stderr line of the helper -> a typed, bounded event, or null. The helper is our own binary, but its output still crosses into the
 * renderer, so only an allowlist of event kinds and fields passes, with every number clamped and every string length-limited.
 */
export function parseHelperEvent(line: string): HelperEvent | null {
    if (line.length > 2000 || line[0] !== '{') return null;
    let j: Record<string, unknown>;
    try { const v = JSON.parse(line) as unknown; if (!v || typeof v !== 'object' || Array.isArray(v)) return null; j = v as Record<string, unknown>; } catch { return null; }
    if (typeof j.error === 'string') return { event: 'error', message: str(j.error, 300), code: str(j.code, 40) || 'error' };
    switch (j.event) {
        case 'portal': {
            const t = typeof j.restore_token === 'string' && RESTORE_TOKEN_RE.test(j.restore_token) ? j.restore_token : '';
            const px = j.x, py = j.y;
            const inRange = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= -100000 && v <= 100000;
            const position = j.has_pos === 1 && inRange(px) && inRange(py) ? { x: px, y: py } : undefined;
            return { event: 'portal', width: num(j.width, 0, 65536), height: num(j.height, 0, 65536), sourceType: num(j.source_type, 0, 8), cursor: str(j.cursor, 16), restoreToken: t, ...(position ? { position } : {}), startMs: Math.floor(num(j.start_ms, 0, 600000)) };
        }
        case 'format': return { event: 'format', srcW: num(j.src_w, 0, 65536), srcH: num(j.src_h, 0, 65536), w: num(j.w, 0, 65536), h: num(j.h, 0, 65536), encoder: str(j.encoder, 16), gpu: str(j.gpu, 96), driver: str(j.driver, 48), nvencApi: str(j.nvenc_api, 12), profile: str(j.profile, 16) };
        case 'stats': return { event: 'stats', encoder: str(j.encoder, 16), w: num(j.w, 0, 65536), h: num(j.h, 0, 65536), fps: num(j.fps, 0, 1000), inFps: num(j.in_fps, 0, 10000), dropped: num(j.dropped), idleRepeats: num(j.idle_repeats), encMsP50: num(j.enc_ms_p50, 0, 1e5), encMsP95: num(j.enc_ms_p95, 0, 1e5), encMsMax: num(j.enc_ms_max, 0, 1e5), kbps: num(j.kbps, 0, 1e7), effFps: num(j.eff_fps, 0, 1000), low: j.low === 1, lowFps: num(j.low_fps, 0, 1000), lowKbps: num(j.low_kbps, 0, 1e7) };
        case 'fps_limited': return { event: 'fps_limited', fps: num(j.fps, 0, 1000), requested: num(j.requested, 0, 1000), encMsP95: num(j.enc_ms_p95, 0, 1e5) };
        case 'low': return { event: 'low', state: j.state === 'on' ? 'on' : 'off', reason: str(j.reason, 40), w: num(j.w, 0, 65536), h: num(j.h, 0, 65536) };
        case 'low_failed': return { event: 'low_failed', code: str(j.code, 40) || 'low_failed', message: str(j.message, 300) };
        case 'ended': return { event: 'ended', reason: str(j.reason, 200) };
        default: return null;
    }
}

export interface NativeShareEncoderHandle {
    child: ChildProcessByStdio<Writable, Readable, Readable>;
    requestIdr(): void;
    setBitrate(bps: number): void;
    stop(): void;
}

/** Start the helper. `onChunk` gets raw stdout bytes; `onExit` fires once (the fallback trigger). */
export function startNativeShareEncoder(a: NativeShareEncoderArgs, onChunk: (b: Buffer) => void, onExit: (code: number | null) => void, onLine?: (line: string) => void): NativeShareEncoderHandle {
    const child = spawn(a.helperPath, helperArgv(a), { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
    child.stdin.on('error', () => { /* helper gone: onExit handles it */ });
    if (a.capture?.restoreToken) child.stdin.write(`TOKEN ${a.capture.restoreToken}\n`);
    child.stdout.on('data', onChunk);
    // stderr carries one-line JSON (events, applied bitrate, final stats). Line-buffered, bounded, never parsed for control.
    let err = '';
    child.stderr.on('data', (b: Buffer) => {
        err += b.toString('utf8');
        let i: number;
        while ((i = err.indexOf('\n')) >= 0) { const line = err.slice(0, i); err = err.slice(i + 1); if (onLine && line.length < 2000) onLine(line); }
        if (err.length > 4000) err = '';
    });
    // 'error' (e.g. ENOENT/EACCES on a missing helper) never reaches 'exit': report it as an exit so the caller falls back.
    let exited = false;
    const done = (code: number | null) => { if (!exited) { exited = true; onExit(code); } };
    child.once('exit', done);
    child.once('error', () => done(127));
    return {
        child,
        requestIdr: () => { child.stdin.write('IDR\n'); },
        setBitrate: (bps: number) => { if (Number.isInteger(bps) && bps > 0) child.stdin.write(`BITRATE ${bps}\n`); },
        stop: () => { try { child.stdin.write('STOP\n'); } catch { /* gone */ } setTimeout(() => child.kill('SIGKILL'), 1000).unref(); },
    };
}
