/**
 * A screen share must never sit on a SOFTWARE video encoder at a high frame
 * rate without anyone saying so.
 *
 * Owner report 2026-10-24 (staging.174, RTX 2080 Ti + Radeon Pro WX 2100,
 * BeamNG running): the share was decided as "auto: HW H.264" Constrained
 * Baseline, but every share_fps sample for the whole share said
 * `enc: OpenH264, hw: false` — 1080p60 encoded on the CPU next to a game,
 * encoded fps sagging to 18-21 while the capture delivered 60. Nothing reacted:
 * the start check only asks "are frames coming out?", and they were.
 *
 * This guard watches the share's own encoder reports (the share_fps sampler,
 * ~every 10 s) and, once the encoder has said "software" on
 * SOFTWARE_SAMPLES_TO_ACT consecutive samples, says what to do — once per
 * share:
 *   - 'switch-high': it is a CB share and this machine has a hardware H.264
 *     High encoder that has not failed this session → republish as High
 *     (the codec decision stops trusting "CB is hardware" for the session);
 *   - 'clamp': no hardware alternative and the share asks for more than
 *     CLAMP_FPS → republish at CLAMP_FPS and tell the user why;
 *   - nothing otherwise (already ≤ CLAMP_FPS: software at 30 fps is what a
 *     GPU-less PC has always done).
 * `hw: null` (unknown) never counts either way.
 */

export const SOFTWARE_SAMPLES_TO_ACT = 2;
export const CLAMP_FPS = 30;

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

export type ShareSoftwareAction =
    | { kind: 'switch-high'; reason: string }
    | { kind: 'clamp'; fps: number; reason: string };

export class ShareSoftwareGuard {
    private softRun = 0;
    private acted = false;

    private readonly ctx: ShareSoftwareContext;

    constructor(ctx: ShareSoftwareContext) { this.ctx = ctx; }

    get hasActed(): boolean { return this.acted; }

    /** One encoder sample: `hw` true / false / null (unknown). */
    observe(hw: boolean | null | undefined): ShareSoftwareAction | null {
        if (this.acted) return null;
        if (hw === true) { this.softRun = 0; return null; }
        if (hw !== false) return null;
        this.softRun++;
        if (this.softRun < SOFTWARE_SAMPLES_TO_ACT) return null;
        const action = decideSoftwareShareAction(this.ctx);
        if (action) this.acted = true;
        return action;
    }
}

export function decideSoftwareShareAction(ctx: ShareSoftwareContext): ShareSoftwareAction | null {
    if (ctx.codec === 'h264' && (ctx.profile ?? 'cb') === 'cb' && ctx.highHw && !ctx.highFailed) {
        return { kind: 'switch-high', reason: 'cb_software' };
    }
    if (Number.isFinite(ctx.targetFps) && ctx.targetFps > CLAMP_FPS) {
        return { kind: 'clamp', fps: CLAMP_FPS, reason: `${ctx.codec}_software` };
    }
    return null;
}

/** What the share notice says for an action (user-facing copy). */
export function softwareShareNotice(action: ShareSoftwareAction): string {
    return action.kind === 'switch-high'
        ? 'Your screen share was being encoded by the CPU instead of the graphics card. Switching it to the graphics card’s encoder.'
        : `No hardware video encoder is available for this share, so it is limited to ${action.fps} fps to keep your PC and the call’s audio responsive.`;
}
