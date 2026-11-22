import { describe, it, expect, vi, beforeEach } from 'vitest';

const logged = vi.hoisted(() => [] as { kind: string; detail: Record<string, unknown> }[]);
vi.mock('./callEventLog', () => ({
    logCallEvent: (kind: string, detail: Record<string, unknown>) => { logged.push({ kind, detail }); },
}));

import {
    SOFTWARE_HOLD_PX_RATE, SOFTWARE_HOLD_MIN_SHORT_SIDE, planSoftwareHold, isHardwareShareCodec, causeForHevcSwitch,
    softwareHoldNotice, shareQualityEvent, logShareQuality,
} from './shareQualityPlan';
import { applyScreenShareSenderParams, decideScreenShareCodec } from './screenShare';
import { hevcSwitchReason } from './hevcNegotiation';

/** A sender whose track reports `settings`, with `encodings` as LiveKit left them. */
function sender(encodings: RTCRtpEncodingParameters[], settings?: { width?: number; height?: number }) {
    let params = { encodings } as RTCRtpSendParameters;
    const setParameters = vi.fn(async (p: RTCRtpSendParameters) => { params = p; });
    const s = {
        getParameters: () => params, setParameters,
        track: settings ? { getSettings: () => settings } : undefined,
    } as unknown as RTCRtpSender;
    return { s, applied: () => setParameters.mock.calls.at(-1)![0] as RTCRtpSendParameters };
}

beforeEach(() => { logged.length = 0; });

describe('planSoftwareHold - frame rate first on a software encoder the app fell back to', () => {
    it('the reported case: 3440x1440 @ 90 (446 Mpx/s) is held to 1816x760 @ 90, within the 1080p60 budget', () => {
        expect(SOFTWARE_HOLD_PX_RATE).toBe(1920 * 1080 * 60);
        const p = planSoftwareHold(3440, 1440, 90);
        expect(p.width).toBe(1816);
        expect(p.height).toBe(760);
        expect(p.width % 2).toBe(0);
        expect(p.height % 2).toBe(0);
        expect(p.pxRate).toBe(1816 * 760 * 90);
        expect(p.pxRate).toBeLessThanOrEqual(SOFTWARE_HOLD_PX_RATE);
        expect(p.fits).toBe(true);
        expect(p.scale).toBeGreaterThan(1.89);
        expect(p.scale).toBeLessThan(1.9);
        // aspect preserved (43:18) within rounding
        expect(Math.abs(p.width / p.height - 3440 / 1440)).toBeLessThan(0.01);
    });

    it('the same screen at 60 fps keeps more resolution (2224x930-ish), still within budget', () => {
        const p = planSoftwareHold(3440, 1440, 60);
        expect(p.pxRate).toBeLessThanOrEqual(SOFTWARE_HOLD_PX_RATE);
        expect(p.width).toBeGreaterThan(2200);
        expect(p.fits).toBe(true);
    });

    it('a capture already inside the budget is untouched (1080p60 exactly, 720p90)', () => {
        expect(planSoftwareHold(1920, 1080, 60)).toMatchObject({ scale: 1, width: 1920, height: 1080, fits: true });
        expect(planSoftwareHold(1280, 720, 90)).toMatchObject({ scale: 1, width: 1280, height: 720, fits: true });
    });

    it('never below a 720 px short side: 5120x1440 @ 90 stops at 2560x720 and says it may not fit', () => {
        const p = planSoftwareHold(5120, 1440, 90);
        expect(p.width).toBe(2560);
        expect(p.height).toBe(SOFTWARE_HOLD_MIN_SHORT_SIDE);
        expect(p.fits).toBe(false);
    });

    it('a capture whose short side is already <= 720 is never scaled, even over budget', () => {
        const p = planSoftwareHold(3840, 720, 90); // 249 Mpx/s
        expect(p.scale).toBe(1);
        expect(p.fits).toBe(false);
    });

    it('unknown / invalid input is scale 1, never a throw', () => {
        for (const [w, h, f] of [[undefined, 1440, 90], [3440, undefined, 90], [0, 0, 90], [3440, 1440, 0], [NaN, 1440, 90]] as const) {
            expect(planSoftwareHold(w as number | undefined, h as number | undefined, f).scale).toBe(1);
        }
    });

    it('boundary: one pixel row over the budget scales; exactly the budget does not', () => {
        expect(planSoftwareHold(1920, 1080, 60).scale).toBe(1);
        expect(planSoftwareHold(1920, 1082, 60).scale).toBeGreaterThan(1);
    });
});

describe('isHardwareShareCodec', () => {
    const none = { h264Hardware: false, vp9Hardware: false };
    it('H.265 is always hardware (Chromium has no software HEVC); VP8 never', () => {
        expect(isHardwareShareCodec('h265', none)).toBe(true);
        expect(isHardwareShareCodec('vp8', { h264Hardware: true, vp9Hardware: true })).toBe(false);
    });
    it('H.264 / VP9 follow what the start-of-share decision knew', () => {
        expect(isHardwareShareCodec('h264', { ...none, h264Hardware: true })).toBe(true);
        expect(isHardwareShareCodec('h264', none)).toBe(false);
        expect(isHardwareShareCodec('vp9', { ...none, vp9Hardware: true })).toBe(true);
        expect(isHardwareShareCodec('vp9', none)).toBe(false);
    });
});

describe('causeForHevcSwitch - only an INVOLUNTARY loss of the hardware encoder is held', () => {
    it('maps hevcSwitchReason words: a viewer who cannot decode, a failed encoder, a GPU reset', () => {
        expect(causeForHevcSwitch(hevcSwitchReason(false, '', 'incapable'))).toBe('viewer_cannot_decode');
        expect(causeForHevcSwitch(hevcSwitchReason(false, 'failed_earlier', 'all'))).toBe('hw_encoder_failed');
        expect(causeForHevcSwitch(hevcSwitchReason(false, 'gpu_lost', 'all'))).toBe('hw_encoder_failed');
    });
    it('the setting turned off, no H.265 encoder, an empty room, a move TO H.265: no hold', () => {
        expect(causeForHevcSwitch(hevcSwitchReason(false, 'setting_off', 'all'))).toBeNull();
        expect(causeForHevcSwitch(hevcSwitchReason(false, 'no_hw_encode', 'all'))).toBeNull();
        expect(causeForHevcSwitch(hevcSwitchReason(false, '', 'alone'))).toBeNull();
        expect(causeForHevcSwitch(hevcSwitchReason(true, '', 'all'))).toBeNull();
    });
});

describe('the fallback decision for the reported machine shapes (what a move off H.265 lands on)', () => {
    const gpus = (v: string[]) => v.map(vendor => ({ vendor }));
    it('NVIDIA with hardware High: H.264 High - hardware, no hold', () => {
        const d = decideScreenShareCodec('auto', { h264: true, vp9: false, vp8: false, h264High: true }, gpus(['NVIDIA']));
        expect(d).toMatchObject({ codec: 'h264', h264Profile: 'high' });
        expect(isHardwareShareCodec(d.codec, { h264Hardware: true, vp9Hardware: false })).toBe(true);
    });
    it('NVIDIA whose High failed earlier this session: VP8 - software, so the hold applies', () => {
        const d = decideScreenShareCodec('auto', { h264: true, vp9: false, vp8: false, h264High: true }, gpus(['NVIDIA']), { h264HighFailed: true });
        expect(d.codec).toBe('vp8');
        expect(isHardwareShareCodec(d.codec, { h264Hardware: false, vp9Hardware: false })).toBe(false);
        expect(planSoftwareHold(3440, 1440, 90)).toMatchObject({ width: 1816, height: 760, fits: true });
    });
    it('AMD / Intel with hardware CB: H.264 CB - hardware, no hold', () => {
        const d = decideScreenShareCodec('auto', { h264: true, vp9: false, vp8: false, h264High: true }, gpus(['AMD']));
        expect(d).toMatchObject({ codec: 'h264', h264Profile: 'cb' });
    });
});

describe('softwareHoldNotice - tells the sharer what happened and why', () => {
    const plan = planSoftwareHold(3440, 1440, 90);
    it('a viewer who cannot decode H.265', () => {
        const t = softwareHoldNotice({ cause: 'viewer_cannot_decode', from: 'h265', fps: 90, plan });
        expect(t).toContain('can’t decode H.265');
        expect(t).toContain('no other hardware video encoder');
        expect(t).toContain('1816×760');
        expect(t).toContain('keep 90 fps');
    });
    it('a failed hardware encoder', () => {
        const t = softwareHoldNotice({ cause: 'hw_encoder_failed', from: 'h265', fps: 90, plan });
        expect(t).toContain('H.265 encoder stopped working');
        expect(t).toContain('CPU');
    });
    it('a hold that cannot fit the budget does not promise the frame rate', () => {
        const t = softwareHoldNotice({ cause: 'hw_encoder_no_frames', from: 'h264', fps: 90, plan: planSoftwareHold(5120, 1440, 90) });
        expect(t).toContain('may still drop below 90 fps');
        expect(t).toContain('H.264');
    });
    it('no scale possible: says it may not hold', () => {
        const t = softwareHoldNotice({ cause: 'hw_encoder_failed', from: 'h265', fps: 90, plan: planSoftwareHold(1280, 720, 90) });
        expect(t).toContain('may not hold 90 fps');
    });
});

describe('share_quality diagnostics', () => {
    it('carries cause, codecs, hardware, capture pixel rate and the held size (no more than 11 keys)', () => {
        const f = shareQualityEvent({
            cause: 'viewer_cannot_decode', from: 'h265', to: 'vp8', hardware: false, fps: 90,
            capture: { width: 3440, height: 1440 }, plan: planSoftwareHold(3440, 1440, 90),
        });
        expect(f).toMatchObject({
            phase: 'fallback', cause: 'viewer_cannot_decode', from: 'h265', to: 'vp8', hardware: false, fps: 90,
            cap_res: '3440x1440', cap_mpx_s: 445.8, hold_res: '1816x760', holds: true,
        });
        expect(Object.keys(f).length).toBeLessThanOrEqual(11);
        logShareQuality(f);
        expect(logged).toEqual([{ kind: 'share_quality', detail: f }]);
    });
    it('a hardware landing has no hold size and holds = true', () => {
        const f = shareQualityEvent({ cause: 'hw_encoder_failed', from: 'h265', to: 'h264', hardware: true, fps: 90 });
        expect(f).toMatchObject({ hardware: true, hold_res: '', hold_scale: 1, holds: true, cap_res: '' });
    });
});

describe('applyScreenShareSenderParams({ pixelRateBudget }) - the sender side of the hold', () => {
    it('3440x1440 @ 90 VP8 with the budget: full layer scaled ~1.89, frame rate kept at 90, maintain-framerate', async () => {
        const { s, applied } = sender([{}], { width: 3440, height: 1440 });
        await applyScreenShareSenderParams(s, 90, 20_000_000, { codec: 'vp8', pixelRateBudget: SOFTWARE_HOLD_PX_RATE });
        const enc = applied().encodings![0];
        expect(enc.maxFramerate).toBe(90);
        expect(enc.scaleResolutionDownBy).toBeGreaterThan(1.89);
        expect(enc.scaleResolutionDownBy).toBeLessThan(1.9);
        expect((3440 / enc.scaleResolutionDownBy!) * (1440 / enc.scaleResolutionDownBy!) * 90).toBeLessThanOrEqual(SOFTWARE_HOLD_PX_RATE);
        expect(applied().degradationPreference).toBe('maintain-framerate');
    });
    it('without the budget the person\'s setting is encoded as chosen (no scale) - the owner rule for a share that STARTED on software', async () => {
        const { s, applied } = sender([{}], { width: 3440, height: 1440 });
        await applyScreenShareSenderParams(s, 90, 20_000_000, { codec: 'vp8' });
        expect(applied().encodings![0].scaleResolutionDownBy).toBeUndefined();
    });
    it('composes with the codec limit clamp: 7680x1440 H.264 is limit-scaled 2x, then held from 3840x720 (short side floor => no more)', async () => {
        const { s, applied } = sender([{}], { width: 7680, height: 1440 });
        await applyScreenShareSenderParams(s, 90, 20_000_000, { codec: 'h264', pixelRateBudget: SOFTWARE_HOLD_PX_RATE });
        expect(applied().encodings![0].scaleResolutionDownBy).toBe(2);
    });
});
