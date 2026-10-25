import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
    ShareAvSyncController, applyShareVideoDelay,
    MAX_TARGET_MS, MIN_APPLY_MS, STEP_MS, MIN_CHANGE_GAP_MS, SENDER_AUDIO_LEAD_MS,
} from './shareAvSync';

const S = (audioPathMs: number, decodeMs = 5, renderMs = 30) => ({ audioPathMs, decodeMs, renderMs });

describe('ShareAvSyncController', () => {
    it('targets the video jitter buffer so video meets the share audio (audio path − decode − render + sender lead)', () => {
        const c = new ShareAvSyncController();
        // Report 2026-10-23: share audio path 176 ms on the element path.
        expect(c.observe(S(176), 0)).toBe(176 - 5 - 30 + SENDER_AUDIO_LEAD_MS);
    });

    it(`is bounded: never more than ${MAX_TARGET_MS} ms, never negative`, () => {
        const c = new ShareAvSyncController();
        expect(c.observe(S(5_000), 0)).toBe(MAX_TARGET_MS);
        const d = new ShareAvSyncController();
        expect(d.observe(S(-500), 0)).toBeNull(); // 0 wanted, 0 applied: nothing to do
        expect(d.targetMs).toBe(0);
    });

    it(`dead band: a wanted delay under ${MIN_APPLY_MS} ms sets nothing`, () => {
        const c = new ShareAvSyncController();
        expect(c.observe(S(MIN_APPLY_MS - SENDER_AUDIO_LEAD_MS + 35 - 1 - 1), 0)).toBeNull();
        expect(c.targetMs).toBe(0);
    });

    it(`hysteresis: moves only by ≥ ${STEP_MS} ms and at most every ${MIN_CHANGE_GAP_MS / 1000} s`, () => {
        const c = new ShareAvSyncController();
        const first = c.observe(S(200), 0)!;
        expect(first).toBeGreaterThan(0);
        // Too soon, even for a big change.
        expect(c.observe(S(400), 1000)).toBeNull();
        // Small wobble after the gap: ignored.
        const d = new ShareAvSyncController();
        const t0 = d.observe(S(200), 0)!;
        let t = 0;
        for (let i = 0; i < 20; i++) { t += 3000; expect(d.observe(S(200 + (i % 2 ? 10 : -10)), t)).toBeNull(); }
        expect(d.targetMs).toBe(t0);
    });

    it('is smoothed: one outlier sample does not swing the target', () => {
        const c = new ShareAvSyncController();
        const base = c.observe(S(200), 0)!;
        const after = c.observe(S(1_500), MIN_CHANGE_GAP_MS + 1);
        expect(after === null || after - base < 1_500 - 200).toBe(true);
        expect(c.targetMs).toBeLessThan(MAX_TARGET_MS);
    });

    it('settles back to 0 once the audio path is fast again', () => {
        const c = new ShareAvSyncController();
        c.observe(S(250), 0);
        let t = 0;
        for (let i = 0; i < 30; i++) { t += MIN_CHANGE_GAP_MS; c.observe(S(0), t); }
        expect(c.targetMs).toBe(0);
    });

    it('ignores non-finite samples', () => {
        const c = new ShareAvSyncController();
        expect(c.observe(null, 0)).toBeNull();
        expect(c.observe(S(NaN), 0)).toBeNull();
    });
});

describe('applyShareVideoDelay — screen-share VIDEO only', () => {
    const rx = () => ({ jitterBufferTarget: null as number | null });
    it('sets jitterBufferTarget on the screen_share video receiver (0 clears it)', () => {
        const r = rx();
        expect(applyShareVideoDelay({ source: 'screen_share', kind: 'video', track: { receiver: r } }, 180)).toBe(true);
        expect(r.jitterBufferTarget).toBe(180);
        expect(applyShareVideoDelay({ source: 'screen_share', kind: 'video', track: { receiver: r } }, 0)).toBe(true);
        expect(r.jitterBufferTarget).toBeNull();
    });
    it('falls back to playoutDelayHint (seconds)', () => {
        const r = { playoutDelayHint: null as number | null };
        expect(applyShareVideoDelay({ source: 'screen_share', kind: 'video', track: { receiver: r } }, 200)).toBe(true);
        expect(r.playoutDelayHint).toBeCloseTo(0.2);
    });
    it('clamps to the max', () => {
        const r = rx();
        applyShareVideoDelay({ source: 'screen_share', kind: 'video', track: { receiver: r } }, 10_000);
        expect(r.jitterBufferTarget).toBe(MAX_TARGET_MS);
    });
    it.each([
        ['microphone', 'audio'],
        ['screen_share_audio', 'audio'],
        ['camera', 'video'],
        ['screen_share', 'audio'],
    ])('NEVER touches %s (%s)', (source, kind) => {
        const r = { jitterBufferTarget: null as number | null, playoutDelayHint: null as number | null };
        expect(applyShareVideoDelay({ source, kind, track: { receiver: r } }, 200)).toBe(false);
        expect(r.jitterBufferTarget).toBeNull();
        expect(r.playoutDelayHint).toBeNull();
    });
});

describe('no playout delay is ever set on a microphone (or any other) receiver anywhere in the app', () => {
    const root = join(__dirname, '..');
    const files: string[] = [];
    const walk = (d: string) => {
        for (const f of readdirSync(d)) {
            const p = join(d, f);
            if (statSync(p).isDirectory()) { if (f !== 'node_modules') walk(p); continue; }
            if (/\.(ts|tsx|js)$/.test(f) && !/\.test\.tsx?$/.test(f)) files.push(p);
        }
    };
    walk(root);
    it('jitterBufferTarget / playoutDelayHint are written only by shareAvSync.applyShareVideoDelay', () => {
        const writers = files.filter(f => /\.(jitterBufferTarget|playoutDelayHint)\s*=(?!=)/.test(readFileSync(f, 'utf8')));
        expect(writers.map(f => f.slice(root.length + 1))).toEqual(['utils/shareAvSync.ts']);
    });
    it('the in-call component feeds it only the screen_share / screen_share_audio pair', () => {
        const src = readFileSync(join(root, 'components/call/ShareAvSync.tsx'), 'utf8');
        expect(src).toMatch(/getTrackPublication\(Track\.Source\.ScreenShare\)/);
        expect(src).toMatch(/getTrackPublication\(Track\.Source\.ScreenShareAudio\)/);
        expect(src).not.toMatch(/Track\.Source\.(Microphone|Camera)/);
        expect(src).toMatch(/applyShareVideoDelay\(video, target\)/);
        expect(readFileSync(join(root, 'components/CallPane.tsx'), 'utf8')).toMatch(/<ShareAvSync \/>/);
    });
});
