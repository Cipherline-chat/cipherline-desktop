/**
 * The codec × E2EE matrix the call stack relies on, pinned against the
 * livekit-client that is actually installed (2.18.8). If an upgrade changes
 * any of it, this fails before a call does.
 *
 *   VP8   — encrypted with a clear VP8 header (1/3/10 bytes)            ✓ camera, share
 *   H.264 — NALU-aware (clear NAL headers, emulation prevention)       ✓ camera, share
 *   H.265 — same NALU path as H.264 (2-byte HEVC NAL header)           ✓ negotiated only
 *   VP9   — 0 clear bytes (SFU reads the RTP descriptor)               ✓ share (Intel HW)
 *   AV1   — THROWS "not yet supported for end to end encryption"       ✗ never offered
 *
 * And: under E2EE LiveKit skips backup codecs, which is why H.265 must be
 * negotiated room-wide (hevcNegotiation.ts) rather than simulcast-with-backup.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideCameraCodec, CAMERA_CODEC_PREFS } from './cameraQuality';
import { decideScreenShareCodec } from './screenShare';
import { parseCodecPref } from './streamDiagnosticsPrefs';

function livekitPath(rel: string): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
        const p = join(dir, 'node_modules', 'livekit-client', 'src', rel);
        if (existsSync(p)) return p;
        dir = dirname(dir);
    }
    throw new Error(`livekit-client source not found: ${rel}`);
}
const naluPath = livekitPath('e2ee/worker/naluUtils.ts');

function livekitSrc(rel: string): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
        const p = join(dir, 'node_modules', 'livekit-client', 'src', rel);
        if (existsSync(p)) return readFileSync(p, 'utf8');
        dir = dirname(dir);
    }
    throw new Error(`livekit-client source not found: ${rel}`);
}

describe('livekit-client E2EE (installed source)', () => {
    const cryptor = livekitSrc('e2ee/worker/FrameCryptor.ts');
    const nalu = livekitSrc('e2ee/worker/naluUtils.ts');
    const lp = livekitSrc('room/participant/LocalParticipant.ts');
    const pkg = JSON.parse(livekitSrc('../package.json'));

    it('is the version this matrix was verified on', () => {
        expect(pkg.version).toBe('2.18.8');
    });
    it('AV1 throws (so we never publish AV1)', () => {
        expect(cryptor).toMatch(/if \(detectedCodec === 'av1'\) \{\s*throw new Error\(`\$\{detectedCodec\} is not yet supported for end to end encryption`\)/);
    });
    it('VP8 keeps its clear header; VP9 keeps none', () => {
        expect(cryptor).toMatch(/if \(detectedCodec === 'vp8'\) \{\s*return \{ unencryptedBytes: UNENCRYPTED_BYTES\[frame\.type\]/);
        expect(cryptor).toMatch(/if \(detectedCodec === 'vp9'\) \{\s*return \{ unencryptedBytes: 0/);
    });
    it('H.264 and H.265 take the NALU-aware path', () => {
        expect(cryptor).toMatch(/detectedCodec === 'h264' \|\| detectedCodec === 'h265' \? detectedCodec : undefined/);
        expect(cryptor).toMatch(/processNALUsForEncryption\(new Uint8Array\(frame\.data\), knownCodec\)/);
        for (const t of ['IDR_W_RADL', 'CRA_NUT', 'TRAIL_R']) expect(nalu).toMatch(new RegExp(`\\b${t}\\b`));
    });

    it('H.265 keyframe through the REAL NALU code: VPS/SPS/PPS and the slice header stay clear, the slice payload is encrypted', async () => {
        const mod = await import(/* @vite-ignore */ naluPath) as {
            processNALUsForEncryption(d: Uint8Array, c?: 'h264' | 'h265'): { unencryptedBytes: number; detectedCodec: string; requiresNALUProcessing: boolean };
        };
        const sc = [0, 0, 0, 1];
        const vps = [...sc, 0x40, 0x01, 0x0c, 0x01];          // nal_unit_type 32
        const sps = [...sc, 0x42, 0x01, 0x01, 0x60];          // 33
        const pps = [...sc, 0x44, 0x01, 0xc1, 0x73];          // 34
        const idr = [...sc, 0x26, 0x01, 0xaf, 0x09, 0x40, 0x12, 0x34, 0x56];   // 19 IDR_W_RADL
        const frame = new Uint8Array([...vps, ...sps, ...pps, ...idr]);
        const r = mod.processNALUsForEncryption(frame, 'h265');
        const idrHeaderAt = vps.length + sps.length + pps.length + sc.length;
        expect(r.requiresNALUProcessing).toBe(true);
        expect(r.detectedCodec).toBe('h265');
        expect(r.unencryptedBytes).toBe(idrHeaderAt + 2);       // 2-byte HEVC NAL header clear
        expect(r.unencryptedBytes).toBeLessThan(frame.length);  // the slice data is encrypted
        // Auto-detection (no codec hint) recognises it too.
        expect(mod.processNALUsForEncryption(frame).detectedCodec).toBe('h265');
    });
    it('backup codecs are skipped under E2EE (hence the room-wide H.265 negotiation)', () => {
        expect(lp).toMatch(/TODO remove this once e2ee is supported for backup codecs/);
    });
});

describe('our codec choices never leave the matrix', () => {
    const hwAll = { h264: true, h264High: true, vp8: true, vp9: true };
    const E2EE_OK = new Set(['vp8', 'h264', 'h265', 'vp9']);
    it('camera: every preference × hardware combination is VP8 / H.264 (H.265 only via negotiation)', () => {
        for (const pref of CAMERA_CODEC_PREFS) {
            for (const hw of [null, hwAll, { h264: false, vp8: false }]) {
                const c = decideCameraCodec(pref, hw, [{ vendor: 'NVIDIA' }]).codec;
                expect(['vp8', 'h264']).toContain(c);
            }
        }
    });
    it('share: never AV1, never H.265 from a preference', () => {
        for (const raw of ['auto', 'h264', 'vp9', 'vp8', 'av1', 'h265']) {
            const pref = parseCodecPref(raw);
            expect(pref).not.toBe('av1');
            expect(pref).not.toBe('h265');
            const c = decideScreenShareCodec(pref, hwAll, [{ vendor: 'Intel' }]).codec;
            expect(E2EE_OK.has(c)).toBe(true);
        }
    });
});
