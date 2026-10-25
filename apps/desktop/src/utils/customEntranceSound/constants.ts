/**
 * Custom entrance sound: the limits and the id format, shared by every part of
 * the feature (processing, storage, the in-call transfer, playback).
 *
 * Owner decision (2026-10-24): a custom sound is NEVER stored on the server.
 * The server keeps only `custom:<id>` in `entrance_sound`, so the others in a
 * call know to expect one. The audio itself lives encrypted on the owner's own
 * devices and reaches the others in a call device to device, encrypted under
 * the call's key (./wire.ts).
 *
 * `<id>` is the first 32 hex chars of SHA-256 over the encoded bytes (./identity.ts),
 * mirrored by apps/api/src/call-personalization/call-personalization.rules.ts
 * (CUSTOM_ENTRANCE_SOUND); constants.test.ts reads that file and fails on drift.
 */

export const CUSTOM_ENTRANCE_PREFIX = 'custom:';
/** Mirrors the API's CUSTOM_ENTRANCE_SOUND. */
export const CUSTOM_ENTRANCE_SOUND_RE = /^custom:[0-9a-f]{32}$/;
export const CUSTOM_SOUND_CONTENT_ID_RE = /^[0-9a-f]{32}$/;

// ── input ────────────────────────────────────────────────────────────────────
/** Biggest file the picker accepts. */
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
/**
 * Longest source the editor will decode. Decoding happens in full before the
 * trim (stereo 48 kHz float is ~23 MB a minute), so a whole album in a 20 MB
 * file must not be able to exhaust the renderer.
 */
export const MAX_SOURCE_SECONDS = 6 * 60;
export const ACCEPTED_EXTENSIONS = ['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'webm'] as const;
export const ACCEPTED_MIME_TYPES = [
    'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/opus', 'audio/wav', 'audio/x-wav', 'audio/wave',
    'audio/vnd.wave', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/webm', 'video/webm',
] as const;
/** `accept=` for the file input. */
export const FILE_ACCEPT = [...ACCEPTED_EXTENSIONS.map(e => `.${e}`), ...ACCEPTED_MIME_TYPES].join(',');

// ── clip ─────────────────────────────────────────────────────────────────────
export const SAMPLE_RATE = 48_000;
export const MAX_CLIP_SECONDS = 2.5;
export const MIN_CLIP_SECONDS = 0.25;
export const MAX_CLIP_SAMPLES = Math.round(MAX_CLIP_SECONDS * SAMPLE_RATE);

// ── loudness ─────────────────────────────────────────────────────────────────
/** Integrated loudness every custom sound is normalized to. */
export const TARGET_LUFS = -16;
/**
 * True-peak ceiling after the limiter. 0.5 dB under the -1 dBTP the spec asks
 * for, as headroom for the Opus encode (a lossy codec can overshoot by a few
 * tenths of a dB); the listener-side cap re-measures what was actually decoded.
 */
export const TRUE_PEAK_CEILING_DB = -1.5;
/** Fade in and out, so a cut in the middle of a waveform never clicks. */
export const FADE_MS = 15;
/** Never amplify more than this (a near-silent clip would just be noise). */
export const MAX_NORMALIZE_GAIN_DB = 36;

// ── encoded result ──────────────────────────────────────────────────────────
/** Hard cap on the encoded sound, checked after encoding, on store, on send and on receive. */
export const MAX_ENCODED_BYTES = 64 * 1024;
/**
 * Opus bitrate. 2.5 s at 64 kbps is ~20 KB plus a few hundred bytes of WebM,
 * a third of the cap even with VBR overshoot; if an encoder ever lands over
 * the cap anyway, encoding is retried at the fallback rates below.
 */
export const OPUS_BITRATE = 64_000;
export const OPUS_FALLBACK_BITRATES = [48_000, 32_000] as const;

/** WebM / Matroska: the EBML header's magic. */
export const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3] as const;

export function isCustomEntranceSoundId(v: unknown): v is string {
    return typeof v === 'string' && CUSTOM_ENTRANCE_SOUND_RE.test(v);
}

/** `custom:<id>` -> `<id>`, or null for anything else. */
export function customContentId(v: unknown): string | null {
    return isCustomEntranceSoundId(v) ? v.slice(CUSTOM_ENTRANCE_PREFIX.length) : null;
}

export function customEntranceSoundValue(contentId: string): string {
    if (!CUSTOM_SOUND_CONTENT_ID_RE.test(contentId)) throw new Error('bad content id');
    return `${CUSTOM_ENTRANCE_PREFIX}${contentId}`;
}

export function hasEbmlMagic(b: Uint8Array): boolean {
    return b.length >= 4 && EBML_MAGIC.every((v, i) => b[i] === v);
}
