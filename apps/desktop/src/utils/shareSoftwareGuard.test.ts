import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    ShareSoftwareGuard, decideSoftwareShareAction, softwareShareNotice,
    SOFTWARE_SAMPLES_TO_ACT, CLAMP_FPS, type ShareSoftwareContext,
} from './shareSoftwareGuard';

// The owner's staging.174 share: CB decided as hardware, OpenH264 in reality.
const OWNER_CB: ShareSoftwareContext = { codec: 'h264', profile: 'cb', targetFps: 60, highHw: true, highFailed: false };

describe('decideSoftwareShareAction', () => {
    it.each<[string, ShareSoftwareContext, string | null]>([
        ['CB in software, High is HW → switch to High', OWNER_CB, 'switch-high'],
        ['CB in software, High already failed, 60 fps → clamp', { ...OWNER_CB, highFailed: true }, 'clamp'],
        ['CB in software, no High HW, 90 fps → clamp', { ...OWNER_CB, highHw: false, targetFps: 90 }, 'clamp'],
        ['VP8 software at 60 → clamp', { codec: 'vp8', targetFps: 60, highHw: false, highFailed: false }, 'clamp'],
        ['VP8 software at 30 → nothing (what a GPU-less PC always did)', { codec: 'vp8', targetFps: 30, highHw: false, highFailed: false }, null],
        ['High reported software at 30 → nothing', { codec: 'h264', profile: 'high', targetFps: 30, highHw: true, highFailed: false }, null],
        ['High reported software at 90 → clamp (never "switch to High" from High)', { codec: 'h264', profile: 'high', targetFps: 90, highHw: true, highFailed: false }, 'clamp'],
    ])('%s', (_l, ctx, kind) => {
        expect(decideSoftwareShareAction(ctx)?.kind ?? null).toBe(kind);
    });

    it('clamps to exactly CLAMP_FPS', () => {
        const a = decideSoftwareShareAction({ codec: 'vp8', targetFps: 90, highHw: false, highFailed: false });
        expect(a).toEqual({ kind: 'clamp', fps: CLAMP_FPS, reason: 'vp8_software' });
    });
});

describe('ShareSoftwareGuard', () => {
    it(`acts only after ${SOFTWARE_SAMPLES_TO_ACT} consecutive software samples, and only once`, () => {
        const g = new ShareSoftwareGuard(OWNER_CB);
        expect(g.observe(false)).toBeNull();
        const a = g.observe(false);
        expect(a?.kind).toBe('switch-high');
        expect(g.hasActed).toBe(true);
        expect(g.observe(false)).toBeNull();
        expect(g.observe(false)).toBeNull();
    });

    it('a hardware sample resets the run; unknown (null) neither counts nor resets', () => {
        const g = new ShareSoftwareGuard(OWNER_CB);
        g.observe(false);
        g.observe(true);
        expect(g.observe(false)).toBeNull();
        expect(g.observe(null)).toBeNull();
        expect(g.observe(undefined)).toBeNull();
        expect(g.observe(false)?.kind).toBe('switch-high');
    });

    it('a hardware share never acts', () => {
        const g = new ShareSoftwareGuard(OWNER_CB);
        for (let i = 0; i < 10; i++) expect(g.observe(true)).toBeNull();
    });

    it('nothing to do (software at 30) does not latch: still nothing later', () => {
        const g = new ShareSoftwareGuard({ codec: 'vp8', targetFps: 30, highHw: false, highFailed: false });
        for (let i = 0; i < 5; i++) expect(g.observe(false)).toBeNull();
        expect(g.hasActed).toBe(false);
    });

    it('tells the user in plain words', () => {
        expect(softwareShareNotice({ kind: 'switch-high', reason: 'x' })).toMatch(/graphics card/);
        expect(softwareShareNotice({ kind: 'clamp', fps: 30, reason: 'x' })).toMatch(/30 fps/);
    });
});

describe('wiring (SidebarConference)', () => {
    const src = readFileSync(join(__dirname, '../components/SidebarConference.tsx'), 'utf8');
    it('feeds every share_fps encoder sample to the guard and acts on it', () => {
        expect(src).toMatch(/onEncoderSample\(typeof d\.hw === 'boolean' \? d\.hw : null\)/);
        expect(src).toMatch(/new ShareSoftwareGuard\(/);
        expect(src).toMatch(/markH264CbSoftware\(\);\s*republishShareRef\.current\?\.\(\{ \.\.\.cur \}\)/);
        expect(src).toMatch(/republishShareRef\.current\?\.\(\{ \.\.\.cur, frameRate: act\.fps/);
    });
    it('the codec decision is told about a CB share that ran in software', () => {
        expect(src).toMatch(/decideScreenShareCodec\(codecPref, hwEncoders, mainDiag\?\.gpus, \{[^}]*cbSoftware: hasH264CbSoftware\(\)/);
    });
});
