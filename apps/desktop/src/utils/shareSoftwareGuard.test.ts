import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    ShareSoftwareGuard, decideSoftwareShareAction, softwareShareNotice,
    SOFTWARE_SAMPLES_TO_ACT, type ShareSoftwareContext,
} from './shareSoftwareGuard';

// The owner's staging.174 share: CB decided as hardware, OpenH264 in reality.
const OWNER_CB: ShareSoftwareContext = { codec: 'h264', profile: 'cb', targetFps: 60, highHw: true, highFailed: false };
// The CachyOS reports of 2026-11-05: VP8 in software, Source / 1440p at 90 fps, no hardware encoder at all.
const CACHY_VP8: ShareSoftwareContext = { codec: 'vp8', targetFps: 90, highHw: false, highFailed: false };

describe('decideSoftwareShareAction: the only automatic action is the CB -> High encoder switch', () => {
    it('CB in software with a hardware High encoder that has not failed -> switch to High (same resolution, same frame rate)', () => {
        expect(decideSoftwareShareAction(OWNER_CB)).toEqual({ kind: 'switch-high', reason: 'cb_software' });
        expect(decideSoftwareShareAction({ ...OWNER_CB, targetFps: 30 })).toEqual({ kind: 'switch-high', reason: 'cb_software' });
    });
    it('NEVER a frame-rate clamp or a step down, at any target, on any codec (the user\'s choice stands)', () => {
        const cases: ShareSoftwareContext[] = [
            { ...OWNER_CB, highFailed: true, targetFps: 60 },
            { ...OWNER_CB, highHw: false, targetFps: 90 },
            { codec: 'vp8', targetFps: 60, highHw: false, highFailed: false },
            { codec: 'h264', profile: 'high', targetFps: 90, highHw: true, highFailed: false },
            CACHY_VP8,
        ];
        for (const c of cases) expect(decideSoftwareShareAction(c)).toBeNull();
    });
    it('the action type has no resolution or frame-rate field to apply', () => {
        const a = decideSoftwareShareAction(OWNER_CB) as Record<string, unknown>;
        expect(Object.keys(a).sort()).toEqual(['kind', 'reason']);
    });
});

describe('ShareSoftwareGuard', () => {
    it(`switches only after ${SOFTWARE_SAMPLES_TO_ACT} consecutive software samples, and only once`, () => {
        const g = new ShareSoftwareGuard(OWNER_CB);
        expect(g.observe(false)).toBeNull();
        expect(g.observe(false)).toEqual({ kind: 'switch-high', reason: 'cb_software' });
        expect(g.hasActed).toBe(true);
        expect(g.observe(false)).toBeNull();
        expect(g.observe(false)).toBeNull();
    });
    it('a hardware sample resets the run; unknown (null) neither counts nor resets', () => {
        const g = new ShareSoftwareGuard(OWNER_CB);
        expect(g.observe(false)).toBeNull();
        expect(g.observe(true)).toBeNull();
        expect(g.observe(false)).toBeNull();
        expect(g.observe(null)).toBeNull();
        expect(g.observe(undefined)).toBeNull();
        expect(g.observe(false)).toEqual({ kind: 'switch-high', reason: 'cb_software' });
    });
    it('a hardware share never acts', () => {
        const g = new ShareSoftwareGuard(OWNER_CB);
        for (let i = 0; i < 20; i++) expect(g.observe(true)).toBeNull();
        expect(g.hasActed).toBe(false);
    });

    it('the CachyOS case: software VP8 at 90 fps, however badly the encoder lags, is NEVER acted on - 100 samples', () => {
        const g = new ShareSoftwareGuard(CACHY_VP8);
        // 48-53 fps encoded from a 65 fps capture, then 18-21 fps from 60, then limit=cpu: the worst numbers in the reports
        const worst = [
            { encFps: 50, srcFps: 65 }, { encFps: 19, srcFps: 60 }, { encFps: 12, srcFps: 59, limit: 'cpu' }, { encFps: 3, srcFps: 1, limit: 'cpu' },
        ];
        for (let i = 0; i < 100; i++) expect(g.observe(false, worst[i % worst.length])).toBeNull();
        expect(g.hasActed).toBe(false); // so the encoder-overload watch is NOT held back by it (SidebarConference `suppressed`)
    });
    it('negative control (the old ladder): a clamp at 90 fps after two behind-the-capture samples is exactly what this must not do', () => {
        const g = new ShareSoftwareGuard({ codec: 'h264', profile: 'cb', targetFps: 90, highHw: false, highFailed: false });
        expect(g.observe(false, { encFps: 20, srcFps: 60 })).toBeNull();
        expect(g.observe(false, { encFps: 20, srcFps: 60 })).toBeNull();
        expect(g.observe(false, { encFps: 20, srcFps: 60, limit: 'cpu' })).toBeNull();
    });
    it('Windows is unchanged where it matters: the same CB -> High switch with the same two-sample rule, same fps', () => {
        const g = new ShareSoftwareGuard({ ...OWNER_CB, targetFps: 90 });
        expect(g.observe(false)).toBeNull();
        const act = g.observe(false);
        expect(act).toEqual({ kind: 'switch-high', reason: 'cb_software' });
    });
    it('tells the user in plain words (the switch is about the encoder, and says nothing about quality dropping)', () => {
        const text = softwareShareNotice({ kind: 'switch-high', reason: 'cb_software' });
        expect(text).toMatch(/graphics card/);
        expect(text).not.toMatch(/limited to|fps|lower/i);
    });
});

describe('wiring (SidebarConference)', () => {
    const src = readFileSync(join(__dirname, '../components/SidebarConference.tsx'), 'utf8');
    it('feeds every share_fps encoder sample to the guard and acts on it', () => {
        expect(src).toMatch(/onEncoderSample\(typeof d\.hw === 'boolean' \? d\.hw : null, \{ encFps: enc_fps, srcFps: src_fps, limit \}\)/);
        expect(src).toMatch(/new ShareSoftwareGuard\(/);
        // Fresh: the switch to High must replace the CB sender, not hot-swap the capture under it.
        expect(src).toMatch(/markH264CbSoftware\(\);[^;]*?republishShareRef\.current\?\.\(\{ \.\.\.cur \}, \{ fresh: true \}\)/);
    });
    it('the automatic software-encoder ladder is gone: no clamp, no step down, no frame-rate or resolution in any guard republish', () => {
        expect(src).not.toMatch(/planSoftwareStepDown|softwareStepDownNotice|stepDown/);
        expect(src).not.toMatch(/republishShareRef\.current\?\.\(\{ \.\.\.cur, (frameRate|resolution)/);
        expect(src).not.toMatch(/`fps_\$\{act\.fps\}`/);
    });
    it('a slow CPU encoder is left to the encoder-overload SUGGESTION, which changes nothing until a click', () => {
        // the suggestion's accept path is the only caller that changes the quality
        expect(src).toMatch(/logCallEvent\('share_encoder_overload', overloadEventDetail\('accepted'[\s\S]{0,200}adjustScreenShareQualityRef\.current\?\.\(sug\.resolution/);
        expect(src).toMatch(/onDismiss: \(\) => \{\s*overload\.dismiss\(v\.key\);/);
    });
    it('the codec decision is told about a CB share that ran in software', () => {
        expect(src).toMatch(/decideScreenShareCodec\(codecPref, hwEncoders, mainDiag\?\.gpus, \{[^}]*cbSoftware: hasH264CbSoftware\(\)/);
    });
});
