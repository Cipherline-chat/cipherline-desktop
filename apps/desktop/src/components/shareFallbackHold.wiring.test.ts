import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * SidebarConference cannot be mounted under vitest; this pins the WIRING of the 90 fps ultrawide fix
 * (report 07939bfa / c4baccf6, 2026-11-21). The decisions live in shareQualityPlan.ts and
 * shareCodecDrift.ts and are tested there.
 */
const SC = fs.readFileSync(path.resolve(__dirname, 'SidebarConference.tsx'), 'utf8');
const REPUB = fs.readFileSync(path.resolve(__dirname, '../utils/shareRepublish.ts'), 'utf8');

const block = (from: string, len = 2500) => {
    const i = SC.indexOf(from);
    expect(i, from).toBeGreaterThan(-1);
    return SC.slice(i, i + len);
};

describe('the frame-rate hold applies ONLY after the app took the hardware encoder away', () => {
    it('the hold is gated on a recorded involuntary fallback AND a software codec', () => {
        const body = block('const shareHoldActive = (sourceId: string, codec: ScreenShareCodec): boolean => {', 500);
        expect(body).toContain('shareFallbackHoldRef.current');
        expect(body).toContain('hold.sourceId === sourceId');
        expect(body).toContain('!isHardwareShareCodec(codec,');
    });

    it('every sender-params application of a share carries the budget while the hold is active', () => {
        const body = block('const shareSenderParamOpts = (codec: ScreenShareCodec, options: ScreenShareOptions): {', 900);
        expect(body).toContain('...(shareHoldActive(options.sourceId, codec) ? { pixelRateBudget: SOFTWARE_HOLD_PX_RATE } : {}),');
    });

    it('the hold is recorded by exactly the three involuntary paths: viewer cannot decode, drift, no frames', () => {
        expect(SC.match(/noteShareFallback\(/g)?.length).toBe(2); // the two swap call sites (the drift path records it directly)
        const neg = block('if (shareFix && share) {', 2200);
        expect(neg).toContain('const cause = liveShareHevc ? null : causeForHevcSwitch(reason);');
        expect(neg).toContain('if (liveShareHevc) shareFallbackHoldRef.current = null;');
        expect(neg).toContain('...(holdBudget ? { pixelRateBudget: holdBudget } : {}),');
        const noFrames = block("logCallEvent('share_fallback', { from: 'h265', to: decision.codec, reason: 'no-frames' });", 1500);
        expect(noFrames).toContain("noteShareFallback(cur.sourceId, 'hw_encoder_no_frames', 'h265', decision.codec)");
        const drift = block('const watch = new ShareCodecDriftWatch({', 3500);
        expect(drift).toContain("shareFallbackHoldRef.current = { sourceId: cur.sourceId, cause: 'hw_encoder_failed', from: published };");
    });

    it('a share of another source starts without a hold (the owner rule: a chosen setting is never lowered by itself)', () => {
        expect(SC).toContain('if (shareFallbackHoldRef.current && shareFallbackHoldRef.current.sourceId !== options.sourceId) shareFallbackHoldRef.current = null;');
    });

    it('a deliberate stop (button / quick-share keybind) ends the hold', () => {
        expect(SC.match(/shareFallbackHoldRef\.current = null; \/\/ the next share is the person's own choice again/g)?.length).toBe(1);
        const quick = block("'keybind:quick-screenshare':  () => {", 1200);
        expect(quick).toContain('shareFallbackHoldRef.current = null;');
    });

    it('the sharer is told and the report says so (share_quality) after each path', () => {
        expect(SC.match(/announceShareFallback\(/g)?.length).toBe(3); // post-publish (drift republish) + the two swaps
        const body = block('const announceShareFallback = (', 1200);
        expect(body).toContain('logShareQuality(shareQualityEvent(');
        expect(body).toContain('softwareHoldNotice(');
    });

    it('the codec swap hands the budget to the new sender', () => {
        expect(REPUB).toContain('...(deps.pixelRateBudget ? { pixelRateBudget: deps.pixelRateBudget } : {})');
    });
});

describe('drift republish and diagnostics', () => {
    it('the drift cooldown is per source AND codec (a second, different codec drift republishes)', () => {
        const body = block('const watch = new ShareCodecDriftWatch({', 3500);
        expect(body).toContain('driftRepublishAllowed(driftRepublishRef.current, cur.sourceId, published, now, DRIFT_REPUBLISH_COOLDOWN_MS)');
        expect(body).toContain('driftRepublishRef.current = { sourceId: cur.sourceId, at: now, codec: published };');
    });

    it('share_encoder logs what the sender really encodes when it changes', () => {
        const body = block('const watch = new ShareCodecDriftWatch({', 1500);
        expect(body).toContain("logCallEvent('share_encoder', {");
        expect(body).toContain('sentEncoderKey(published, sent)');
    });

    it('share_codec says whether the fallback codec is hardware and whether this publish is a hold', () => {
        const body = block("logCallEvent('share_codec', {\n            codec, profile: h264High", 700);
        expect(body).toContain('base_hw: shareBaseHwRef.current, hold: shareHoldActive(options.sourceId, codec),');
    });
});
