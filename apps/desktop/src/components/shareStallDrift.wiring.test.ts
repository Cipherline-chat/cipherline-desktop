import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * SidebarConference cannot be mounted under vitest; this pins the WIRING of
 * the 2026-10-25 screen-share fixes (reports e951243d + 83da3af8). The
 * decisions are tested where they live: shareCodecDrift.test.ts,
 * shareNoFrames.test.ts, shareCrop.test.ts, rxDeadShare.test.ts.
 */
const SC = fs.readFileSync(path.resolve(__dirname, 'SidebarConference.tsx'), 'utf8');
const CEM = fs.readFileSync(path.resolve(__dirname, 'call/CallEventMonitor.tsx'), 'utf8');

const block = (from: string, len = 2500) => {
    const i = SC.indexOf(from);
    expect(i, from).toBeGreaterThan(-1);
    return SC.slice(i, i + len);
};

describe('a fallback that must change the encoder republishes FRESH (never the retune / hot swap that keep the sender)', () => {
    it('startScreenShareFrom skips the in-place retune and the hot swap when asked for a fresh publication', () => {
        const body = block('const startScreenShareFrom = async (', 9000);
        expect(body).toMatch(/const fresh = !!startOpts\?\.fresh\s*\|\|/);
        expect(body).toContain('if (!fresh && await applyLiveSelection(');
        expect(body).toMatch(/if \(\s*!fresh\s*&& localParticipant\.isScreenShareEnabled/);
        expect(SC).toContain('outcome = await startScreenShareFrom(options, () => tracker.settle(attempt, \'published\', true), startOpts, republishRun);');
        expect(SC).toContain('republishShareRef.current = (o: ScreenShareOptions, opts?: { fresh?: boolean }) => { void handleScreenShareSelect(o, opts); };');
    });

    it('a RESOLUTION change on a live hardware encoder is fresh too (report 45a5e136: in-place re-open crashed the renderer)', () => {
        const body = block('const startScreenShareFrom = async (', 9000);
        expect(body).toMatch(/resolutionChangeNeedsFresh\(currentShareRef\.current, options, liveShareIsHardware\(\),\s*!!currentShareRef\.current && liveFrameUnchangedFor\(currentShareRef\.current, options\)\)/);
        const applier = block('const liveShareApplier = (): LiveShareApplier => ({', 600);
        expect(applier).toContain('hardwareEncoder: liveShareIsHardware,');
        const hw = block('const liveShareIsHardware = (): boolean => {', 500);
        expect(hw).toContain("codec === 'h265' || (codec === 'h264' && shareHwH264Ref.current)");
    });

    it('a SOURCE swap on a live hardware encoder is fresh too (reports abb0f871 crash, dd3e84e3 H.265 -> H.264 drift)', () => {
        const body = block('const startScreenShareFrom = async (', 9000);
        expect(body).toMatch(/sourceSwapNeedsFresh\(currentShareRef\.current, options, liveShareIsHardware\(\)\)/);
        // both rules feed the same `fresh`, which the hot swap is gated on
        const fresh = body.slice(body.indexOf('const fresh = '), body.indexOf('const tStart'));
        expect(fresh).toContain('resolutionChangeNeedsFresh(');
        expect(fresh).toContain('sourceSwapNeedsFresh(');
    });

    it('every fallback passes { fresh: true }: none of them changes the user\'s resolution or frame rate by itself', () => {
        const calls = [...SC.matchAll(/republishShareRef\.current\?\.\(([^;]*)\);/g)].map(m => m[1]);
        expect(calls.length).toBe(5);
        // The software guard's clamp / step-down used to be the two non-fresh ones (a lower frame rate or a smaller
        // picture, republished by itself). They are gone: a slow CPU encoder is the overload SUGGESTION's business.
        expect(calls.filter(c => !c.includes('{ fresh: true }'))).toEqual([]);
        expect(calls.some(c => /frameRate:|resolution:/.test(c))).toBe(false);
    });
});

describe('codec drift: the sender silently switched codec, viewers get nothing', () => {
    it('a drift watch runs for every share publication and republishes with the failed codec marked', () => {
        const body = block('const watch = new ShareCodecDriftWatch({', 2200);
        expect(body).toContain("logCallEvent('share_codec_drift'");
        expect(body).toContain("if (published === 'h265') markHevcFailed();");
        expect(body).toContain('else if (high) markH264HighFailed();');
        expect(body).toContain('republishShareRef.current?.({ ...cur }, { fresh: true });');
        expect(body).toContain('DRIFT_REPUBLISH_COOLDOWN_MS');
        expect(SC).toContain('const published = asScreenShareCodec(track?.codec) ?? shareParamsCtxRef.current?.codec;');
    });

    it('the software-encoder guard stands down on a drift and judges the CURRENT frame rate', () => {
        expect(SC).toContain('new ShareSoftwareGuard({ ...swCtx.ctx, targetFps: share.frameRate })');
        const body = block('const onEncoderSample = (hw: boolean | null, stats?: EncoderSampleStats) => {', 400);
        expect(body).toContain('if (shareDriftRef.current) return;');
    });
});

describe('"no frames" is diagnosed before anything is blamed', () => {
    it('the H.265 and H.264 High start checks ask whether the capture delivered anything before marking a codec failed', () => {
        const h265 = block("logCallEvent('share_start_check', { codec: 'h265', verdict: result });", 900);
        expect(h265.indexOf('diagnoseShareNoFrames')).toBeLessThan(h265.indexOf('markHevcFailed()'));
        expect(h265).toContain("if (d.cause === 'capture') { handleCaptureStall(options, codec, d, 'h265'); return; }");
        const high = block("logCallEvent('share_start_check', { codec: 'h264', profile: 'high', verdict: result });", 1200);
        expect(high.indexOf('diagnoseShareNoFrames')).toBeLessThan(high.indexOf('markH264HighFailed()'));
        expect(high).toContain("if (d.cause === 'capture') { handleCaptureStall(options, codec, d, 'h264_high'); return; }");
    });

    it('the black-screen watchdog too, before stepping the resolution down', () => {
        const wd = block('const armEncoderWatchdog = (', 900);
        expect(wd).toContain("if (d.cause === 'capture') handleCaptureStall(options, codec, d, 'watchdog');");
        expect(wd).toContain('else handleEncoderStall(options, codec, info);');
    });

    it('a capture stall on a single screen falls back once to the whole display; it logs share_capture_stall', () => {
        const body = block('const handleCaptureStall = (', 1800);
        expect(body).toContain("logCallEvent('share_capture_stall'");
        expect(body).toContain('republishShareRef.current?.({ ...cur, layout: undefined }, { fresh: true });');
        expect(body).toContain('captureStallWholeRef.current = cur.sourceId;');
    });

    it('a cropped share reports where its crop runs and the frames through it (share_crop)', () => {
        expect(SC).toContain("logCallEvent('share_crop', {");
    });
});

describe('viewer side: a share that never starts is visible, and freezes say why', () => {
    it('freeze_start carries bg + rx; share_rx_dead is logged for screen shares', () => {
        expect(CEM).toContain("logCallEvent('freeze_start', { track: name, bg: isWindowBackground(), rx: rxSince(st.packets, packets) });");
        expect(CEM).toContain("logCallEvent('share_rx_dead', {");
        expect(CEM).toContain('source === Track.Source.ScreenShare ? new RxDeadShareWatch() : null');
    });
});
