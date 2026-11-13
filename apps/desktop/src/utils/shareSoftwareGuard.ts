/**
 * A screen share on a SOFTWARE video encoder: what the app does about it, and what it never does.
 *
 * What it never does (owner, 2026-11-05, "make Linux stable"): change the user's RESOLUTION or FRAME RATE by itself.
 * It used to. After two software samples at a target above 30 fps it republished the share at 30 fps, or - once it had
 * measured the encoder - stepped the picture down (`share_fallback`, reason `software-encoder`). A CachyOS
 * report (Ryzen 5 5600X, RTX 5070 - no hardware encode on Linux, VP8) went 1440p@90 -> 1080p@90 -> 30 fps -> 1440p@60
 * inside 80 s, and the user complained "stream auto went down to 1080p even though I set 1440p". Each of those steps
 * was also a republish, which stalls the capture (portalCapturePlan.ts). The ladder is gone, for every platform: a
 * slow CPU encoder is exactly what the encoder-overload suggestion (shareEncoderOverload.ts, `share_encoder_overload`)
 * exists for - it measures the TOP layer, says once per setting what the encoder cannot keep up with and what it
 * could sustain, and changes nothing until the user clicks. Dismissed means left alone.
 *
 * What it still does: the H.264 Constrained Baseline -> High switch ('switch-high'). That changes the ENCODER, not
 * the user's setting: a share the codec decision believed was hardware (CB) that ran in OpenH264, on a machine whose
 * probe says a hardware H.264 High encoder exists and has not failed this session, is republished as High at the
 * same resolution and frame rate (the decision then stops trusting "CB is hardware" for the session; owner report
 * 2026-10-24, staging.174: 1080p60 encoded on the CPU next to a game). It acts once per share after
 * SOFTWARE_SAMPLES_TO_ACT consecutive software samples; `hw: null` (unknown) never counts either way.
 *
 * The guard also feeds the Linux hardware-encode failure ledger (a sender that was hardware and became software).
 */
import { noteShareEncoderSample, noteLinuxHwEncodeFailure } from './linuxHwEncode';

export const SOFTWARE_SAMPLES_TO_ACT = 2;

/** The numbers of one share_fps sample. Carried for callers; the guard no longer judges by them (see the header). */
export interface EncoderSampleStats {
    /** Frames encoded per second. */
    encFps?: number;
    /** What the capturer delivered per second. */
    srcFps?: number;
    /** qualityLimitationReason. */
    limit?: string;
}

export interface ShareSoftwareContext {
    codec: string;
    /** For codec 'h264'. */
    profile?: 'cb' | 'high';
    targetFps: number;
    /** The probe said H.264 High is a hardware encoder. */
    highHw: boolean;
    /** A High encoder already failed to start this session. */
    highFailed: boolean;
}

export type ShareSoftwareAction = { kind: 'switch-high'; reason: string };

export class ShareSoftwareGuard {
    private softRun = 0;
    private acted = false;

    private readonly ctx: ShareSoftwareContext;

    constructor(ctx: ShareSoftwareContext) { this.ctx = ctx; }

    get hasActed(): boolean { return this.acted; }

    /**
     * One encoder sample: `hw` true / false / null (unknown). The only action is the CB -> High switch; a software
     * encoder that merely runs slowly is the encoder-overload suggestion's business and is never acted on here.
     * `_stats` is accepted for the caller's convenience and not judged.
     */
    observe(hw: boolean | null | undefined, _stats?: EncoderSampleStats): ShareSoftwareAction | null {
        this.trackHardware(hw);
        if (this.acted) return null;
        if (hw === true) { this.softRun = 0; return null; }
        if (hw !== false) return null;
        this.softRun++;
        if (this.softRun < SOFTWARE_SAMPLES_TO_ACT) return null;
        const action = decideSoftwareShareAction(this.ctx);
        if (action) this.acted = true;
        return action;
    }

    /** The encoder was hardware for a sample and software for the next ones: libwebrtc swapped in its software fallback (Linux VA-API; linuxHwEncode.ts). */
    private sawHardware = false;
    private lostRun = 0;
    private trackHardware(hw: boolean | null | undefined): void {
        noteShareEncoderSample(hw);
        if (hw === true) { this.sawHardware = true; this.lostRun = 0; return; }
        if (hw === false && this.sawHardware) {
            this.lostRun++;
            if (this.lostRun === SOFTWARE_SAMPLES_TO_ACT) void noteLinuxHwEncodeFailure('hw_lost', { codec: this.ctx.codec });
        }
    }
}

/**
 * The one automatic action: a CB share the decision believed was hardware, running in software, on a machine with a
 * hardware High encoder that has not failed. Never a resolution or frame-rate change (see the header).
 */
export function decideSoftwareShareAction(ctx: ShareSoftwareContext): ShareSoftwareAction | null {
    if (ctx.codec === 'h264' && (ctx.profile ?? 'cb') === 'cb' && ctx.highHw && !ctx.highFailed) {
        return { kind: 'switch-high', reason: 'cb_software' };
    }
    return null;
}

/** What the share notice says for an action (user-facing copy). */
export function softwareShareNotice(_action: ShareSoftwareAction): string {
    return 'Your screen share was being encoded by the CPU instead of the graphics card. Switching it to the graphics card’s encoder.';
}
