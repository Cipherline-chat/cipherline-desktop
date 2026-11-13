import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * SidebarConference cannot be mounted under vitest; this pins the WIRING of
 * the camera codec-drift watch (the camera twin of the share's, see
 * shareStallDrift.wiring.test.ts). The decisions are tested where they live:
 * shareCodecDrift.test.ts (watch, paused) and cameraPublish.test.ts
 * (handleCameraDrift: republish fresh, rate limit, muted).
 */
const SC = fs.readFileSync(path.resolve(__dirname, 'SidebarConference.tsx'), 'utf8');
const CP = fs.readFileSync(path.resolve(__dirname, '../utils/cameraPublish.ts'), 'utf8');
const LOG = fs.readFileSync(path.resolve(__dirname, '../utils/callEventLog.ts'), 'utf8');
const CRUMBS = fs.readFileSync(path.resolve(__dirname, '../utils/crashBreadcrumbs.ts'), 'utf8');

const block = (src: string, from: string, len = 2500) => {
    const i = src.indexOf(from);
    expect(i, from).toBeGreaterThan(-1);
    return src.slice(i, i + len);
};

describe('camera codec drift: wiring', () => {
    it('a drift watch follows the camera publication (by sid) and hands a confirmed drift to handleCameraDrift', () => {
        expect(SC).toContain('const camTrackSid = useLocalPublicationSid(localParticipant, Track.Source.Camera);');
        const body = block(SC, 'const watch = new CodecDriftWatch({', 1200);
        expect(body).toContain('getStats: () => sender.getStats(),');
        expect(body).toContain('handleCameraDrift(');
        expect(body).toContain('cameraDriftGateRef.current');
        expect(body).toContain('[localParticipant, camTrackSid, cameraStartOptions]');
    });

    it('the watch stands down while the camera is muted or a deliberate republish is in flight', () => {
        const body = block(SC, 'const watch = new CodecDriftWatch({', 700);
        expect(body).toContain('paused: () => !!pub.isMuted || !!track.isMuted || isCameraRepublishing(lp),');
    });

    it('software (VP8) cameras are not watched (no better encoder to move to)', () => {
        expect(block(SC, 'const published = asCameraCodec(track?.publishOptions?.videoCodec);', 300)).toContain("published === 'vp8'");
    });

    it('the notice reuses the share notice banner as a warning', () => {
        expect(block(SC, 'const watch = new CodecDriftWatch({', 1200)).toContain("setScreenShareNotice({ tone: 'warn', text })");
    });

    it('handleCameraDrift republishes through the fresh-sender path with the codec marked failed, rate-limited, with numbers-only telemetry', () => {
        const start = CP.indexOf('export async function handleCameraDrift(');
        expect(start).toBeGreaterThan(-1);
        const body = CP.slice(start, CP.indexOf('// ── Mid-call changes', start));
        expect(body).toContain('DRIFT_REPUBLISH_COOLDOWN_MS');
        expect(body).toContain("logCallEvent('camera_codec_drift', {");
        expect(body).toContain("published, sent: d.sent, layers: d.layers, enc: d.encoder ?? '',");
        expect(body).toContain("if (published === 'h265') markHevcFailed(); else markHwCameraFailed();");
        expect(body).toContain("await fallBackFromHardwareCamera(lp, track, opts, 'drift');");
        // never a hot swap / in-place retune: those keep the broken sender
        expect(body).not.toContain('retuneCamera');
        expect(body).not.toContain('replaceTrack');
    });

    it('camera_codec_drift is a registered call-event kind and a crash breadcrumb', () => {
        expect(LOG).toContain("'camera_codec_drift'");
        expect(CRUMBS).toContain("'camera_codec_drift'");
    });

    it('the share watch is untouched', () => {
        expect(SC).toContain('const watch = new ShareCodecDriftWatch({');
        expect(SC).toContain("logCallEvent('share_codec_drift'");
    });
});
