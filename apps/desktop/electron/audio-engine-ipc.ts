/**
 * Main-process side of the native audio engine ("Strong" noise suppression, DeepFilterNet via crates/cl-audio-node).
 *
 * The engine never runs here. Main only (1) decides whether it is available (addon + model files present), (2) starts a
 * utilityProcess running electron/audio-engine-host.ts on first use and stops it ~30 s after the last call ends, and
 * (3) wires a MessageChannelMain: one end to the utility process, the other to the renderer, which forwards it into the
 * AudioWorklet. Audio frames then travel worklet <-> utility process directly and never touch main or the renderer's main
 * thread. Pure of electron imports (deps are injected) so it is unit-tested; electron/ imports nothing from src/.
 *
 * Nothing but PCM frames, settings and stats may cross the port: the host validates every message (audio-engine-protocol.ts).
 * The renderer can only ask three things over IPC: available / open / close. Paths are pinned here, never taken from the page.
 */
export const AUDIO_ENGINE_IDLE_STOP_MS = 30_000;
export const AUDIO_ENGINE_START_TIMEOUT_MS = 20_000;

interface PortMainLike { close(): void }
interface ChildLike {
    pid?: number;
    postMessage(m: unknown, t?: unknown[]): void;
    on(ev: 'message', cb: (m: unknown) => void): unknown;
    on(ev: 'exit', cb: (code: number) => void): unknown;
    kill(): boolean;
}
interface SenderLike { id?: number; postMessage(ch: string, m: unknown, t?: unknown[]): void; send(ch: string, ...a: unknown[]): void; once?(ev: string, cb: () => void): void }
interface IpcLike { handle(ch: string, fn: (e: { sender: SenderLike }, arg?: unknown) => unknown): void }

export interface AudioEngineFiles { host: string; addon: string; model: string }
export interface AudioEngineDeps {
    ipc: IpcLike;
    fork: (hostPath: string) => ChildLike;
    newChannel: () => { port1: PortMainLike; port2: unknown };
    files: AudioEngineFiles;
    exists: (p: string) => boolean;
    log?: (line: string) => void;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (t: unknown) => void;
}
export interface AudioEngineAvailability { available: boolean; reason?: 'addon-missing' | 'model-missing' | 'host-missing' | 'unsupported' }

export function audioEngineAvailability(files: AudioEngineFiles, exists: (p: string) => boolean): AudioEngineAvailability {
    if (!exists(files.host)) return { available: false, reason: 'host-missing' };
    if (!exists(files.addon)) return { available: false, reason: 'addon-missing' };
    if (!exists(files.model)) return { available: false, reason: 'model-missing' };
    return { available: true };
}

export interface AudioEngineController { stop(): void; running(): boolean }

export function registerAudioEngineIpc(d: AudioEngineDeps): AudioEngineController {
    const setT = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clearT = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    const log = (s: string) => { try { d.log?.(s); } catch { /* logging must never throw */ } };
    let child: ChildLike | null = null;
    let starting: Promise<boolean> | null = null;
    let idleTimer: unknown = null;
    let session: { sender: SenderLike; port: PortMainLike | null } | null = null;

    const stopChild = () => {
        if (idleTimer) { clearT(idleTimer); idleTimer = null; }
        const c = child; child = null; starting = null;
        if (c) { try { c.kill(); } catch { /* gone */ } log('audio-engine: utility process stopped'); }
    };
    const endSession = (notify: boolean) => {
        const s = session; session = null;
        if (s?.port) { try { s.port.close(); } catch { /* closed */ } }
        if (s && notify) { try { s.sender.send('audio-engine:exit', { reason: 'engine-exit' }); } catch { /* window gone */ } }
    };

    /** Start the utility process if needed; resolves true once the addon + model loaded. */
    const ensureChild = (): Promise<boolean> => {
        if (child && starting) return starting;
        const c = d.fork(d.files.host);
        child = c;
        starting = new Promise<boolean>((resolve) => {
            const timer = setT(() => { log('audio-engine: start timed out'); resolve(false); if (child === c) stopChild(); }, AUDIO_ENGINE_START_TIMEOUT_MS);
            c.on('message', (m) => {
                const t = m && typeof m === 'object' ? (m as { type?: unknown }).type : null;
                if (t === 'ready') { clearT(timer); resolve((m as { modelOk?: unknown }).modelOk === true); }
                else if (t === 'failed') {
                    clearT(timer);
                    log('audio-engine: ' + String((m as { error?: unknown }).error ?? 'failed').replace(/[^\x20-\x7e]/g, '').slice(0, 160));
                    if (session) endSession(true);   // an engine that died mid-call: tell the page now, it falls back to Light
                    resolve(false);
                }
            });
            c.on('exit', (code) => {
                clearT(timer);
                log(`audio-engine: utility process exited (${code})`);
                if (child === c) { child = null; starting = null; }
                endSession(true);
                resolve(false);
            });
            c.postMessage({ type: 'init', addonPath: d.files.addon, modelPath: d.files.model });
        });
        return starting;
    };

    d.ipc.handle('audio-engine:available', () => audioEngineAvailability(d.files, d.exists));

    d.ipc.handle('audio-engine:open', async (event) => {
        const av = audioEngineAvailability(d.files, d.exists);
        if (!av.available) return { ok: false, error: av.reason };
        if (idleTimer) { clearT(idleTimer); idleTimer = null; }
        endSession(false);   // one call at a time: a new open replaces the old
        const ok = await ensureChild();
        if (!ok || !child) { stopChild(); return { ok: false, error: 'engine-start-failed' }; }
        const { port1, port2 } = d.newChannel();
        session = { sender: event.sender, port: port1 };
        child.postMessage({ type: 'open' }, [port1]);
        session.port = null;   // ownership moved to the utility process
        event.sender.postMessage('audio-engine:port', null, [port2]);
        event.sender.once?.('destroyed', () => { if (session && session.sender === event.sender) closeSession(); });
        return { ok: true };
    });

    const closeSession = () => {
        const had = session !== null;
        session = null;
        if (child) { try { child.postMessage({ type: 'close' }); } catch { /* gone */ } }
        if (had || child) {
            if (idleTimer) clearT(idleTimer);
            idleTimer = setT(() => { idleTimer = null; stopChild(); }, AUDIO_ENGINE_IDLE_STOP_MS);
        }
    };
    d.ipc.handle('audio-engine:close', () => { closeSession(); return { ok: true }; });

    return { stop: () => { endSession(false); stopChild(); }, running: () => child !== null };
}
