/**
 * The sender-codec pin (utils/e2eeSenderCodec.ts) — the fix for the camera
 * "sharp but ~0.2 fps / black" regression on 1.0.18-staging.141.
 *
 * Three layers:
 *   1. the mechanism, through the INSTALLED livekit-client's real NALU code:
 *      without a codec, an H.264 frame whose first non-slice NAL looks like an
 *      H.265 slice header is guessed as H.265 and the clear prefix lands in the
 *      wrong place (the bug); with the codec it is right (the fix);
 *   2. the livekit-client source facts the fix relies on (pinned, so an
 *      upgrade that changes them fails here, not in a call);
 *   3. the pin itself, with fakes.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    codecFromMime, publishedVideoCodec, codecPinMessage, installE2EESenderCodecPin, e2eeWorkerOf,
    type CodecPinPublication, type CodecPinRoom,
} from './e2eeSenderCodec';

function livekitPath(rel: string): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
        const p = join(dir, 'node_modules', 'livekit-client', 'src', rel);
        if (existsSync(p)) return p;
        dir = dirname(dir);
    }
    throw new Error(`livekit-client source not found: ${rel}`);
}
const src = (rel: string) => readFileSync(livekitPath(rel), 'utf8');

type Nalu = { processNALUsForEncryption(d: Uint8Array, c?: 'h264' | 'h265'): { unencryptedBytes: number; detectedCodec: string; requiresNALUProcessing: boolean } };
const loadNalu = async () => await import(/* @vite-ignore */ livekitPath('e2ee/worker/naluUtils.ts')) as Nalu;

const SC = [0, 0, 0, 1];
const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());

describe('the regression, through the installed naluUtils', () => {
    // VideoToolbox's real keyframe layout (measured on the Mac mini): SPS 0x27
    // and PPS 0x28 (nal_ref_idc 1), then the IDR slice 0x25.
    const sps = [...SC, 0x27, 0x64, 0x00, 0x1f, 0xac, 0x13];
    const pps = [...SC, 0x28, 0xee, 0x3c, 0xb0];
    const idr = [...SC, 0x25, 0xb8, 0x00, 0x04, 0x10, 0x22, 0x33, 0x44];
    const vtKey = bytes(sps, pps, idr);
    const idrSliceAt = sps.length + pps.length + SC.length;

    it('with the codec (the pin): the clear prefix ends 2 bytes into the first H.264 slice', async () => {
        const n = await loadNalu();
        const r = n.processNALUsForEncryption(vtKey, 'h264');
        expect(r.detectedCodec).toBe('h264');
        expect(r.unencryptedBytes).toBe(idrSliceAt + 2);
    });
    it('without it (what LiveKit does for a sender): 0x27 reads as an H.265 IDR slice — prefix inside the SPS', async () => {
        const n = await loadNalu();
        const r = n.processNALUsForEncryption(vtKey);
        expect(r.detectedCodec).toBe('h265');
        expect(r.unencryptedBytes).toBe(SC.length + 2);          // 6: the SPS body gets encrypted
        expect(r.unencryptedBytes).not.toBe(idrSliceAt + 2);     // ≠ what the receiver (codec known) expects
    });
    it('same trap for an access-unit delimiter or SEI in front of a delta slice', async () => {
        const n = await loadNalu();
        const slice = [...SC, 0x41, 0x9a, 0x02, 0x10, 0x20];
        for (const lead of [[...SC, 0x09, 0xf0], [...SC, 0x06, 0x05, 0x01, 0x80]]) {
            const f = bytes(lead, slice);
            const right = n.processNALUsForEncryption(f, 'h264');
            const guessed = n.processNALUsForEncryption(f);
            expect(right.unencryptedBytes).toBe(lead.length + SC.length + 2);
            expect(guessed.detectedCodec).toBe('h265');
            expect(guessed.unencryptedBytes).not.toBe(right.unencryptedBytes);
        }
    });
    it('a plain slice-first frame guesses right — why some frames still got through', async () => {
        const n = await loadNalu();
        const f = bytes([...SC, 0x21, 0xe0, 0x02, 0x00, 0x12]);
        expect(n.processNALUsForEncryption(f).unencryptedBytes).toBe(n.processNALUsForEncryption(f, 'h264').unencryptedBytes);
    });
});

describe('livekit-client 2.18.8 facts the pin relies on', () => {
    const cryptor = src('e2ee/worker/FrameCryptor.ts');
    const worker = src('e2ee/worker/e2ee.worker.ts');
    const manager = src('e2ee/E2eeManager.ts');
    const engine = src('room/RTCEngine.ts');
    const pct = src('room/PCTransport.ts');

    it('a frame whose payload type is not in the map falls back to the cryptor\'s videoCodec', () => {
        expect(cryptor).toMatch(/const detectedCodec = this\.getVideoCodec\(frame\) \?\? this\.videoCodec;/);
    });
    it('the worker sets videoCodec from an updateCodec message (the Safari path we reuse)', () => {
        expect(worker).toMatch(/case 'updateCodec':\s*getTrackCryptor\(data\.participantIdentity, data\.trackId\)\.setVideoCodec\(data\.codec\);/);
    });
    it('senders are set up WITHOUT a codec (the gap), keyed by track.mediaStreamID', () => {
        expect(manager).toMatch(/this\.handleSender\(sender, track\.mediaStreamID, undefined\);/);
    });
    it('the payload-type map comes from the first video section of the publisher ANSWER', () => {
        expect(engine).toMatch(/this\.pcManager\.publisher\.once\(\s*PCEvents\.RTPVideoPayloadTypes/);
        expect(pct).toMatch(/sd\.type === 'answer'[\s\S]{0,400}media\.type === 'video'[\s\S]{0,80}PCEvents\.RTPVideoPayloadTypes/);
    });
});

describe('codec helpers', () => {
    it('codecFromMime', () => {
        expect(codecFromMime('video/H264')).toBe('h264');
        expect(codecFromMime('video/H265')).toBe('h265');
        expect(codecFromMime('video/VP8')).toBe('vp8');
        expect(codecFromMime('vp9')).toBe('vp9');
        expect(codecFromMime('audio/opus')).toBeNull();
        expect(codecFromMime('')).toBeNull();
        expect(codecFromMime(undefined)).toBeNull();
    });
    it('the negotiated codec (trackInfo) beats the requested one; audio is never pinned', () => {
        const vid = (o: Partial<CodecPinPublication>): CodecPinPublication => ({ kind: 'video', track: { mediaStreamID: 'm1', codec: 'h264' }, ...o });
        expect(publishedVideoCodec(vid({ trackInfo: { codecs: [{ mimeType: 'video/VP8' }] } }))).toBe('vp8');
        expect(publishedVideoCodec(vid({ trackInfo: { mimeType: 'video/H265' } }))).toBe('h265');
        expect(publishedVideoCodec(vid({}))).toBe('h264');
        expect(publishedVideoCodec({ kind: 'audio', track: { mediaStreamID: 'a', codec: 'opus' }, trackInfo: { mimeType: 'audio/opus' } })).toBeNull();
    });
    it('codecPinMessage is LiveKit\'s UpdateCodecMessage shape', () => {
        const pub: CodecPinPublication = { kind: 'video', track: { mediaStreamID: 'track-1' }, trackInfo: { codecs: [{ mimeType: 'video/H264' }] } };
        expect(codecPinMessage(pub, 'alice')).toEqual({ kind: 'updateCodec', data: { trackId: 'track-1', codec: 'h264', participantIdentity: 'alice' } });
        expect(codecPinMessage(pub, '')).toBeNull();
        expect(codecPinMessage({ ...pub, track: {} }, 'alice')).toBeNull();
    });
    it('e2eeWorkerOf reads the Room\'s encryption (or legacy e2ee) worker', () => {
        const w = { postMessage: () => {} };
        expect(e2eeWorkerOf({ options: { encryption: { worker: w } } })).toBe(w);
        expect(e2eeWorkerOf({ options: { e2ee: { worker: w } } })).toBe(w);
        expect(e2eeWorkerOf({ options: {} })).toBeNull();
        expect(e2eeWorkerOf({ options: { encryption: { worker: {} } } })).toBeNull();
    });
});

function fakeRoom(identity: string, pubs: CodecPinPublication[] = []) {
    const listeners = new Set<(p: CodecPinPublication) => void>();
    const room: CodecPinRoom & { publish(p: CodecPinPublication): void; listeners: number } = {
        localParticipant: { identity, trackPublications: new Map(pubs.map((p, i) => [String(i), p])) },
        on: (_e, cb) => { listeners.add(cb); },
        off: (_e, cb) => { listeners.delete(cb); },
        publish(p) { for (const l of [...listeners]) l(p); },
        get listeners() { return listeners.size; },
    };
    return room;
}
const video = (id: string, mime: string): CodecPinPublication => ({ kind: 'video', track: { kind: 'video', mediaStreamID: id }, trackInfo: { codecs: [{ mimeType: mime }] } });

describe('installE2EESenderCodecPin', () => {
    it('pins what is already published and every later video publication; ignores audio', () => {
        const post = vi.fn();
        const room = fakeRoom('me', [video('cam-1', 'video/H264'), { kind: 'audio', track: { mediaStreamID: 'mic' } }]);
        const off = installE2EESenderCodecPin(room, { postMessage: post });
        expect(post).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenLastCalledWith({ kind: 'updateCodec', data: { trackId: 'cam-1', codec: 'h264', participantIdentity: 'me' } });
        room.publish(video('share-1', 'video/VP9'));
        room.publish({ kind: 'audio', track: { mediaStreamID: 'mic2' } });
        expect(post).toHaveBeenCalledTimes(2);
        expect(post.mock.calls[1][0].data).toEqual({ trackId: 'share-1', codec: 'vp9', participantIdentity: 'me' });
        off();
        expect(room.listeners).toBe(0);
    });
    it('a make-before-break republish (new clone, new codec) is pinned too; a repeat is not re-posted', () => {
        const post = vi.fn();
        const room = fakeRoom('me');
        installE2EESenderCodecPin(room, { postMessage: post });
        room.publish(video('cam-1', 'video/H264'));
        room.publish(video('cam-1', 'video/H264'));        // LiveKit reconnect republish: same track
        room.publish(video('cam-2', 'video/H265'));        // H.265 swap: the clone
        room.publish(video('cam-1', 'video/VP8'));         // same track, codec changed
        expect(post.mock.calls.map(c => `${c[0].data.trackId}:${c[0].data.codec}`)).toEqual(['cam-1:h264', 'cam-2:h265', 'cam-1:vp8']);
    });
    it('no worker (E2EE off) → no-op; a throwing worker never breaks the call', () => {
        const room = fakeRoom('me', [video('cam-1', 'video/H264')]);
        expect(() => installE2EESenderCodecPin(room, null)()).not.toThrow();
        expect(room.listeners).toBe(0);
        const boom = { postMessage: () => { throw new Error('worker gone'); } };
        expect(() => installE2EESenderCodecPin(room, boom)).not.toThrow();
        expect(() => room.publish(video('cam-2', 'video/H264'))).not.toThrow();
    });
    it('uses the identity at publish time (it is empty until the Room connects)', () => {
        const post = vi.fn();
        const room = fakeRoom('');
        installE2EESenderCodecPin(room, { postMessage: post });
        room.publish(video('cam-1', 'video/H264'));
        expect(post).not.toHaveBeenCalled();
        room.localParticipant.identity = 'me';
        room.publish(video('cam-1', 'video/H264'));
        expect(post).toHaveBeenCalledTimes(1);
    });
});

describe('wiring', () => {
    const pane = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'CallPane.tsx'), 'utf8');
    it('CallPane mounts the pin inside the LiveKitRoom, on the Room\'s own E2EE worker', () => {
        expect(pane).toMatch(/installE2EESenderCodecPin\(\s*room as unknown as CodecPinRoom,\s*e2eeWorkerOf\(/);
        const room = pane.slice(pane.indexOf('<LiveKitRoom'), pane.indexOf('</LiveKitRoom>'));
        expect(room).toMatch(/<E2EESenderCodecPin \/>/);
    });
});
