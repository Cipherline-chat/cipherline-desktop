/**
 * Worker-side wiring of the native share encoder (SPIKE, off by default).
 *
 * Installed LAST in workers/e2eeWorker.ts so it is the OUTERMOST `onmessage`
 * wrapper: for the one sender track a renderer bound to a native session, the
 * encoded-frame stream goes through the inject stage BEFORE the Annex-B
 * canonicalizer and LiveKit's cryptor. With no `cl:native-share` message ever
 * received (the flag-off case) every message is passed to the inner handler
 * untouched, so behaviour is unchanged.
 *
 * Messages in (from the renderer):
 *   cl:native-share   { trackId, port, tick?, refresh?, layers? }   bind a main-process MessagePort (helper stdout chunks in, commands out);
 *                     layers: 2 = the share is a 2-layer simulcast (the lighter copy): a second injector serves the low layer
 *   cl:native-low     { trackId, on, w?, h?, fps?, bps? }   open/close the helper's lighter-copy session (ignored on a single-layer session)
 *   cl:native-preview { trackId, on, w?, fps? }   ask the helper for (or stop) the sharer's own thumbnail; frames come back as cl:native-preview-frame
 *   cl:native-arm     { trackId }   start the stall watchdog (it does not run while the portal chooser is open; the first AU also starts it)
 *   cl:native-bitrate { trackId, bps }    sender-estimate -> helper target (rate limited by the caller's BitrateController)
 *   cl:native-test    { trackId, skipAus?, guard? }   TEST ONLY: drop the next N AUs, optionally without the resync guard
 * Messages out (to the page):
 *   cl:native-share-status { trackId, state: 'ok'|'dead', stats }
 *   cl:native-preview-frame { trackId, w, h, rgba: ArrayBuffer (transferred) }   one thumbnail; never an access unit, never counted by the stall watchdog
 */
import {
    AccessUnitParser, NativeInjector, FallbackWatchdog, createInjectStage, createLayeredInjectStage, LayerClassifier,
    DEFAULT_INJECTOR_OPTIONS, type InjectableFrame, type NativeAccessUnit,
} from './nativeShareInject';
import { readPreviewPayload, NATIVE_PREVIEW_FRAME_KIND } from './nativeSharePreview';

export const NATIVE_STATUS_KIND = 'cl:native-share-status';
export const NATIVE_AU_KIND = 'cl:native-au';

interface Scope { onmessage: ((ev: MessageEvent) => unknown) | null; postMessage(msg: unknown, transfer?: Transferable[]): void }
interface Session { tick: boolean; inj: NativeInjector; lowInj: NativeInjector | null; classifier: LayerClassifier; port: MessagePort; dog: FallbackWatchdog; dead: boolean; skip: number; guard: boolean; timer: ReturnType<typeof setInterval> }

export function installNativeInjector(scope: Scope, now: () => number = () => Date.now()): boolean {
    const inner = scope.onmessage;
    if (typeof inner !== 'function') return false;
    const sessions = new Map<string, Session>();

    const status = (trackId: string, s: Session, state: 'ok' | 'dead') => {
        try { scope.postMessage({ kind: NATIVE_STATUS_KIND, data: { trackId, state, stats: { ...s.inj.stats }, ...(s.lowInj ? { lowStats: { ...s.lowInj.stats }, unclassified: s.classifier.unclassified } : {}) } }); } catch { /* page gone */ }
    };

    scope.onmessage = function (this: unknown, ev: MessageEvent) {
        const msg = ev?.data as { kind?: string; data?: Record<string, unknown> } | undefined;
        try {
            if (msg?.kind === 'cl:native-share') {
                const trackId = msg.data?.trackId, port = msg.data?.port;
                if (typeof trackId === 'string' && port instanceof MessagePort && !sessions.has(trackId)) {
                    const parser = new AccessUnitParser();
                    const inj = new NativeInjector(() => port.postMessage({ cmd: 'idr' }), now, DEFAULT_INJECTOR_OPTIONS, msg.data?.refresh === true ? () => port.postMessage({ cmd: 'refresh' }) : undefined);
                    let exited = false;
                    const dog = new FallbackWatchdog(now, 1500, () => exited, false);
                    const lowInj = msg.data?.layers === 2 ? new NativeInjector(() => port.postMessage({ cmd: 'idr', layer: 'low' }), now, DEFAULT_INJECTOR_OPTIONS) : null;
                    const s: Session = { tick: msg.data?.tick === true, inj, lowInj, classifier: new LayerClassifier(), port, dog, dead: false, skip: 0, guard: true, timer: setInterval(() => {
                        if (s.dead) return;
                        if (dog.shouldFallBack()) { s.dead = true; clearInterval(s.timer); status(trackId, s, 'dead'); }
                    }, 250) };
                    port.onmessage = (e: MessageEvent) => {
                        const d = e.data;
                        if (d && typeof d === 'object' && !(d instanceof ArrayBuffer) && !ArrayBuffer.isView(d)) {
                            if ((d as { exit?: unknown }).exit !== undefined) exited = true;
                            return;
                        }
                        const chunk = d instanceof ArrayBuffer ? new Uint8Array(d) : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : null;
                        if (!chunk || s.dead) return;
                        let aus: NativeAccessUnit[];
                        try { aus = parser.push(chunk); } catch { exited = true; return; }
                        for (const au of aus) {
                            if (au.preview === true) {
                                // A thumbnail for the sharer's own tile: straight to the page, never to an injector or the stall watchdog.
                                const pic = readPreviewPayload(au.data);
                                if (pic) { try { scope.postMessage({ kind: NATIVE_PREVIEW_FRAME_KIND, data: { trackId, w: pic.w, h: pic.h, rgba: pic.rgba.buffer } }, [pic.rgba.buffer]); } catch { /* page gone */ } }
                                continue;
                            }
                            if (au.low === true) {
                                // The lighter copy's AUs go to the low layer's injector ONLY; on a session without one they are discarded (never fed to the full layer).
                                if (!s.lowInj || s.skip > 0) continue;
                                s.lowInj.onAu(au);
                                if (s.tick) { try { scope.postMessage({ kind: NATIVE_AU_KIND, data: { trackId, key: au.key, low: true } }); } catch { /* page gone */ } }
                                continue;
                            }
                            dog.sawAu();
                            if (s.skip > 0) { s.skip--; if (s.guard) inj.noteDroppedAu(); continue; }
                            inj.onAu(au);
                            // 1:1 pacing: the page pushes one tiny VideoFrame per AU (nativeShareDummy.createGeneratorShareTrack).
                            if (s.tick) { try { scope.postMessage({ kind: NATIVE_AU_KIND, data: { trackId, key: au.key } }); } catch { /* page gone */ } }
                        }
                    };
                    sessions.set(trackId, s);
                }
                return;
            }
            if (msg?.kind === 'cl:native-arm') {
                // The page saw the helper's first format (portal answered, first frame, encoder open): AUs are owed from now on.
                sessions.get(String(msg.data?.trackId))?.dog.arm();
                return;
            }
            if (msg?.kind === 'cl:native-bitrate') {
                const s = sessions.get(String(msg.data?.trackId));
                const bps = Number(msg.data?.bps);
                if (s && !s.dead && Number.isInteger(bps) && bps > 0) s.port.postMessage({ cmd: 'bitrate', bps });
                return;
            }
            if (msg?.kind === 'cl:native-preview') {
                const s = sessions.get(String(msg.data?.trackId));
                if (s && !s.dead) {
                    const w = Number(msg.data?.w), fps = Number(msg.data?.fps);
                    s.port.postMessage(msg.data?.on === true ? { cmd: 'preview', on: true, w, fps } : { cmd: 'preview', on: false });
                }
                return;
            }
            if (msg?.kind === 'cl:native-low') {
                const s = sessions.get(String(msg.data?.trackId));
                if (s && !s.dead && s.lowInj) {
                    s.lowInj.reset();   // whatever was queued belongs to a dead reference chain (a new session starts with an IDR, an old one must not leak out)
                    if (msg.data?.on === true) s.port.postMessage({ cmd: 'low', on: true, w: msg.data.w, h: msg.data.h, fps: msg.data.fps, bps: msg.data.bps });
                    else s.port.postMessage({ cmd: 'low', on: false });
                }
                return;
            }
            if (msg?.kind === 'cl:native-stats-req') {
                const id = String(msg.data?.trackId); const s = sessions.get(id);
                if (s) status(id, s, s.dead ? 'dead' : 'ok');
                return;
            }
            if (msg?.kind === 'cl:native-test') {
                const s = sessions.get(String(msg.data?.trackId));
                if (s) { if (msg.data?.ignorePli !== undefined) s.inj.ignorePli = msg.data.ignorePli === true; else { s.skip = Number(msg.data?.skipAus) || 0; s.guard = msg.data?.guard !== false; } }
                return;
            }
            if (msg?.kind === 'encode' && msg.data?.readableStream instanceof ReadableStream && typeof msg.data.trackId === 'string') {
                const s = sessions.get(msg.data.trackId);
                if (s) {
                    const dead = () => s.dead;
                    const stage = s.lowInj ? createLayeredInjectStage<InjectableFrame>(s.inj, s.lowInj, s.classifier) : createInjectStage<InjectableFrame>(s.inj);
                    // After the helper is declared dead, stop injecting: dummy frames are dropped (never forwarded as dummy bytes)
                    // while the page republishes through the normal Chromium path.
                    const gate = new TransformStream<InjectableFrame, InjectableFrame>({ transform(f, c) { if (!dead()) c.enqueue(f); } });
                    const readableStream = (msg.data.readableStream as ReadableStream<InjectableFrame>).pipeThrough(stage).pipeThrough(gate);
                    ev = { data: { ...msg, data: { ...msg.data, readableStream } } } as MessageEvent;
                }
            }
        } catch { /* fall through to the inner handler with the original message */ }
        return inner.call(this, ev);
    };
    return true;
}
