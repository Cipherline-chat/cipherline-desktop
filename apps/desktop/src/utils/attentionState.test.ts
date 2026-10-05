import { describe, it, expect } from 'vitest';
import { computeIsAttentive, IDLE_THRESHOLD_SECONDS } from './attentionState';

/**
 * The attention state machine's one decision, tested per the continuity
 * spec's own acceptance list: "focused+recent input → true; blurred →
 * immediate false; idle past threshold → false."
 */
describe('computeIsAttentive', () => {
    it('focused with recent input → true', () => {
        expect(computeIsAttentive(true, 0)).toBe(true);
        expect(computeIsAttentive(true, 5)).toBe(true);
    });

    it('blurred (not focused) → false, regardless of idle time', () => {
        expect(computeIsAttentive(false, 0)).toBe(false);
        expect(computeIsAttentive(false, 0, 999_999)).toBe(false);
    });

    it('idle past the threshold → false, even while focused', () => {
        expect(computeIsAttentive(true, IDLE_THRESHOLD_SECONDS)).toBe(false);
        expect(computeIsAttentive(true, IDLE_THRESHOLD_SECONDS + 1)).toBe(false);
    });

    it('idle just under the threshold → true while focused', () => {
        expect(computeIsAttentive(true, IDLE_THRESHOLD_SECONDS - 1)).toBe(true);
    });

    it('uses the real default threshold (300s) when none is passed', () => {
        expect(computeIsAttentive(true, 299)).toBe(true);
        expect(computeIsAttentive(true, 300)).toBe(false);
    });

    it('an unknown/invalid idle reading fails conservative (not attentive), never true', () => {
        expect(computeIsAttentive(true, NaN)).toBe(false);
        expect(computeIsAttentive(true, -1)).toBe(false);
        expect(computeIsAttentive(true, Infinity)).toBe(false);
    });

    it('a custom threshold is honored (test-only override)', () => {
        expect(computeIsAttentive(true, 10, 5)).toBe(false);
        expect(computeIsAttentive(true, 4, 5)).toBe(true);
    });
});

/**
 * A hidden, minimised or unfocused window must NEVER report `active: true`
 * (orchestrator, 2026-09-24; the server's push routing — "don't wake the phone
 * while the user is active elsewhere" — reads exactly this flag). The hook used
 * to send a cached ref that only focus/blur EVENTS updated, so a missed event
 * (a tray hide on a platform that fires no blur, a window hidden while already
 * unfocused, a throttled idle poll) left `true` on the wire from a window
 * nobody could see. The verdict is now recomputed from the live window state
 * at the moment every heartbeat is sent.
 */
describe('isWindowAttendable — live window state, read at send time', () => {
    it('visible and focused (both by event and by the document) → attendable', async () => {
        const { isWindowAttendable } = await import('./attentionState');
        expect(isWindowAttendable({ focusedByEvent: true, documentHasFocus: true, visibilityState: 'visible' })).toBe(true);
    });

    it.each([
        ['hidden (tray)', { focusedByEvent: true, documentHasFocus: true, visibilityState: 'hidden' }],
        ['minimised (Chromium reports hidden)', { focusedByEvent: true, documentHasFocus: false, visibilityState: 'hidden' }],
        ['unfocused, blur event missed', { focusedByEvent: true, documentHasFocus: false, visibilityState: 'visible' }],
        ['unfocused by event', { focusedByEvent: false, documentHasFocus: true, visibilityState: 'visible' }],
        ['unknown visibility', { focusedByEvent: true, documentHasFocus: true, visibilityState: undefined }],
    ])('%s → never attendable', async (_label, state) => {
        const { isWindowAttendable, computeIsAttentive } = await import('./attentionState');
        const attendable = isWindowAttendable(state as Parameters<typeof isWindowAttendable>[0]);
        expect(attendable).toBe(false);
        // …so even zero idle time cannot make it attentive.
        expect(computeIsAttentive(attendable, 0)).toBe(false);
    });
});

describe('the heartbeat on the wire', () => {
    it('is exactly { event: "presence:heartbeat", data: { active } }', async () => {
        const { heartbeatPayload } = await import('./attentionState');
        expect(JSON.parse(heartbeatPayload(true))).toEqual({ event: 'presence:heartbeat', data: { active: true } });
        expect(JSON.parse(heartbeatPayload(false))).toEqual({ event: 'presence:heartbeat', data: { active: false } });
    });

    it('useRealtime sends every heartbeat through it, recomputing attention from the live window', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const src = readFileSync(join(__dirname, '..', 'hooks', 'useRealtime.ts'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
        // No hand-built heartbeat left, and no cached verdict sent as-is.
        expect(src).not.toMatch(/event:\s*'presence:heartbeat'/);
        expect(src).not.toContain('active: attentiveRef.current');
        // Connect + periodic heartbeats read the live state; loss events send false.
        expect(src.match(/ws\.send\(heartbeatPayload\(currentAttention\(\)\)\)/g)?.length).toBe(2);
        expect(src).toContain('heartbeatPayload(active)');
        // Hiding the window (tray, minimise, any platform) reports at once.
        expect(src).toContain("document.visibilityState === 'hidden'");
        expect(src).toContain('onWindowHide');
    });
});
