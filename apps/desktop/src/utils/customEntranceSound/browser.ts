/**
 * The browser-only half of custom entrance sounds: decoding with WebAudio and
 * encoding Opus. Everything that is math lives in ./process.ts (tested in
 * node); this file is the thin glue to the platform APIs, verified in a real
 * Chromium (see the report for the harness).
 *
 * ── Encoder choice ─────────────────────────────────────────────────────────
 * PRIMARY: WebCodecs `AudioEncoder` (codec 'opus', mono, 48 kHz) + our own
 * minimal WebM muxer (./webm.ts). Electron 43's Chromium ships it (software
 * libopus, no platform codec involved), it runs faster than real time, the
 * bitrate is exact, and the output is the same bytes for the same input, so
 * the content id is stable. The renderer is a secure context (WebCrypto is
 * used everywhere), which WebCodecs requires.
 * FALLBACK: `MediaRecorder('audio/webm;codecs=opus')` on a
 * MediaStreamAudioDestinationNode, only if AudioEncoder is missing or refuses
 * the config. It works everywhere Chromium does, but records in real time
 * (2.5 s for a 2.5 s clip) and is not deterministic.
 * Either way the result is checked: WebM magic, <= MAX_ENCODED_BYTES (retried
 * at lower bitrates), and that it decodes.
 */

import {
    MAX_ENCODED_BYTES, MAX_INPUT_BYTES, MAX_SOURCE_SECONDS, OPUS_BITRATE, OPUS_FALLBACK_BITRATES, SAMPLE_RATE,
    ACCEPTED_EXTENSIONS, ACCEPTED_MIME_TYPES, hasEbmlMagic,
} from './constants';
import { downmix } from './process';
import { muxOpusWebm, type OpusPacket } from './webm';
import type { DecodedAudio } from './receiver';

export type InputRejection = 'type' | 'size' | 'empty';

/** Cheap checks before reading the file at all. */
export function checkInputFile(file: { name: string; type: string; size: number }): InputRejection | null {
    if (file.size === 0) return 'empty';
    if (file.size > MAX_INPUT_BYTES) return 'size';
    const ext = file.name.toLowerCase().split('.').pop() ?? '';
    const typeOk = !file.type || (ACCEPTED_MIME_TYPES as readonly string[]).includes(file.type.toLowerCase().split(';')[0]);
    const extOk = (ACCEPTED_EXTENSIONS as readonly string[]).includes(ext);
    // A known extension with a matching (or empty) type. Files dragged out of
    // some apps carry no type, so the extension decides then.
    return extOk && typeOk ? null : 'type';
}

/** Decode the whole file at 48 kHz (the OfflineAudioContext resamples), downmixed to mono. */
export async function decodeToMono48k(bytes: ArrayBuffer): Promise<{ mono: Float32Array; seconds: number }> {
    const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
    const buf = await ctx.decodeAudioData(bytes.slice(0));
    if (buf.duration > MAX_SOURCE_SECONDS) throw new Error('too_long');
    const chans: Float32Array[] = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    const mono = downmix(chans);
    if (mono.length === 0) throw new Error('empty');
    return { mono, seconds: mono.length / SAMPLE_RATE };
}

/** Decode encoded sound bytes (receive side / measuring). */
export async function decodeSound(bytes: Uint8Array): Promise<DecodedAudio | null> {
    try {
        const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
        const buf = await ctx.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
        const channels: Float32Array[] = [];
        for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
        return { channels, sampleRate: buf.sampleRate };
    } catch {
        return null;
    }
}

// ── WebCodecs ───────────────────────────────────────────────────────────────

type AudioEncoderCtor = {
    new (init: { output: (chunk: { byteLength: number; timestamp: number; copyTo(dst: Uint8Array): void }, meta?: { decoderConfig?: { description?: BufferSource } }) => void; error: (e: Error) => void }): {
        configure(c: Record<string, unknown>): void;
        encode(d: unknown): void;
        flush(): Promise<void>;
        close(): void;
    };
    isConfigSupported(c: Record<string, unknown>): Promise<{ supported?: boolean }>;
};
type AudioDataCtor = new (init: Record<string, unknown>) => { close(): void };

const opusConfig = (bitrate: number) => ({
    codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate, bitrateMode: 'variable',
    opus: { frameDuration: 20_000, complexity: 10, application: 'audio' },
});

async function encodeWebCodecs(pcm: Float32Array, bitrate: number): Promise<Uint8Array | null> {
    const g = globalThis as unknown as { AudioEncoder?: AudioEncoderCtor; AudioData?: AudioDataCtor };
    if (!g.AudioEncoder || !g.AudioData) return null;
    const config = opusConfig(bitrate);
    try {
        const ok = await g.AudioEncoder.isConfigSupported(config);
        if (!ok.supported) return null;
    } catch { return null; }

    const packets: OpusPacket[] = [];
    let head: Uint8Array | null = null;
    let failure: Error | null = null;
    const encoder = new g.AudioEncoder({
        output: (chunk, meta) => {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            packets.push({ data, timestampUs: chunk.timestamp });
            const d = meta?.decoderConfig?.description;
            if (d && !head) head = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array((d as ArrayBufferView).buffer.slice(0));
        },
        error: e => { failure = e; },
    });
    try {
        encoder.configure(config);
        const frame = new g.AudioData({
            format: 'f32-planar', sampleRate: SAMPLE_RATE, numberOfFrames: pcm.length, numberOfChannels: 1,
            timestamp: 0, data: pcm,
        });
        encoder.encode(frame);
        frame.close();
        await encoder.flush();
    } finally {
        try { encoder.close(); } catch { /* already closed */ }
    }
    if (failure || packets.length === 0) return null;
    packets.sort((a, b) => a.timestampUs - b.timestampUs);
    return muxOpusWebm({ packets, opusHead: head, durationMs: (pcm.length / SAMPLE_RATE) * 1000 });
}

// ── MediaRecorder fallback ─────────────────────────────────────────────────

async function encodeMediaRecorder(pcm: Float32Array, bitrate: number): Promise<Uint8Array | null> {
    const mime = 'audio/webm;codecs=opus';
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported(mime)) return null;
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    try {
        await ctx.resume();
        const buffer = ctx.createBuffer(1, pcm.length, SAMPLE_RATE);
        buffer.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const dest = ctx.createMediaStreamDestination();
        dest.channelCount = 1;
        src.connect(dest);
        const rec = new MediaRecorder(dest.stream, { mimeType: mime, audioBitsPerSecond: bitrate });
        const parts: Blob[] = [];
        rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
        const stopped = new Promise<void>(resolve => { rec.onstop = () => resolve(); });
        rec.start();
        src.start();
        await new Promise<void>(resolve => { src.onended = () => resolve(); });
        await new Promise(r => setTimeout(r, 60)); // let the last frame reach the recorder
        rec.stop();
        await stopped;
        return new Uint8Array(await new Blob(parts).arrayBuffer());
    } finally {
        void ctx.close().catch(() => { /* ignore */ });
    }
}

export interface EncodedSound { bytes: Uint8Array; encoder: 'webcodecs' | 'mediarecorder'; bitrate: number }

/**
 * Encode processed mono PCM to Opus-in-WebM under MAX_ENCODED_BYTES. Throws
 * 'encode_failed' / 'too_large'.
 */
export async function encodeSound(pcm: Float32Array): Promise<EncodedSound> {
    for (const bitrate of [OPUS_BITRATE, ...OPUS_FALLBACK_BITRATES]) {
        let bytes = await encodeWebCodecs(pcm, bitrate).catch(() => null);
        let encoder: EncodedSound['encoder'] = 'webcodecs';
        if (!bytes) { bytes = await encodeMediaRecorder(pcm, bitrate).catch(() => null); encoder = 'mediarecorder'; }
        if (!bytes || !hasEbmlMagic(bytes)) throw new Error('encode_failed');
        if (bytes.length <= MAX_ENCODED_BYTES) {
            // Must play back before we keep it.
            const check = await decodeSound(bytes);
            if (!check || check.channels[0].length === 0) throw new Error('encode_failed');
            return { bytes, encoder, bitrate };
        }
    }
    throw new Error('too_large');
}
