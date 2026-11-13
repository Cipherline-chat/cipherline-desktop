import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    DEFAULT_IDLE_TIMEOUT_MINUTES, IDLE_THRESHOLD_SECONDS, IDLE_TIMEOUT_CHOICES_MINUTES,
    getIdleThresholdSeconds, normalizeIdleTimeoutMinutes, setIdleTimeoutMinutes,
} from './idleThreshold';

/**
 * The user's "Idle timeout" is ONE value (owner rule R2): auto-Away, the
 * listening-share idle state and the attention heartbeat all read it through
 * getIdleThresholdSeconds(). Default behaviour stays 300 s.
 */
describe('idle timeout setting', () => {
    afterEach(() => setIdleTimeoutMinutes(DEFAULT_IDLE_TIMEOUT_MINUTES));

    it('defaults to 5 minutes = 300 s, unchanged from the old constant', () => {
        expect(DEFAULT_IDLE_TIMEOUT_MINUTES).toBe(5);
        expect(IDLE_THRESHOLD_SECONDS).toBe(300);
        expect(getIdleThresholdSeconds()).toBe(300);
    });

    it('offers exactly 1, 2, 5, 10, 15, 30 minutes, and the default is one of them', () => {
        expect([...IDLE_TIMEOUT_CHOICES_MINUTES]).toEqual([1, 2, 5, 10, 15, 30]);
        expect(IDLE_TIMEOUT_CHOICES_MINUTES).toContain(DEFAULT_IDLE_TIMEOUT_MINUTES);
    });

    it.each(IDLE_TIMEOUT_CHOICES_MINUTES.map(m => [m]))('choice %i min is applied as m*60 seconds', (m) => {
        setIdleTimeoutMinutes(m);
        expect(getIdleThresholdSeconds()).toBe(m * 60);
    });

    it.each([
        ['NaN', NaN], ['zero', 0], ['negative', -5], ['off-menu', 7], ['huge', 1e9],
        ['a numeric string', '10'], ['null', null], ['undefined', undefined], ['Infinity', Infinity],
    ])('a bad stored value (%s) falls back to the default instead of being trusted', (_label, bad) => {
        expect(normalizeIdleTimeoutMinutes(bad)).toBe(DEFAULT_IDLE_TIMEOUT_MINUTES);
        setIdleTimeoutMinutes(bad);
        expect(getIdleThresholdSeconds()).toBe(300);
    });

    it('a later valid value replaces an earlier one (the settings change takes effect live)', () => {
        setIdleTimeoutMinutes(30);
        expect(getIdleThresholdSeconds()).toBe(1800);
        setIdleTimeoutMinutes(1);
        expect(getIdleThresholdSeconds()).toBe(60);
    });
});

/**
 * ONE source of truth: no consumer may keep a private idle number. Source
 * scans, because the hooks cannot load under vitest's node environment.
 */
describe('every idle consumer reads the same live value', () => {
    const read = (rel: string) =>
        readFileSync(join(__dirname, '..', rel), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

    it('hooks/useListeningShare.ts has no idle cut-off at all (staging design: watching a video is not touching the mouse)', () => {
        // Merged 2026-11-07: this branch was cut before staging made "Listening
        // to" event-driven and dropped its idle withdraw. If an idle rule ever
        // comes back here, it must use the live value, never the bare constant.
        const src = read('hooks/useListeningShare.ts');
        expect(src).not.toMatch(/IDLE_THRESHOLD_SECONDS/);
        if (/getSystemIdleTime/.test(src)) expect(src).toContain('getIdleThresholdSeconds()');
    });

    it.each([
        ['hooks/useUserStatus.ts'],
        // hooks/useRealtime.ts is pinned in attentionState.test.ts.
    ])('%s compares against getIdleThresholdSeconds(), not the bare default constant', (file) => {
        const src = read(file);
        expect(src).toContain('getIdleThresholdSeconds()');
        // The old bare constant must not decide anything in live code. (useUserStatus
        // still re-exports it for readability, which is not a use.)
        const uses = src.replace(/export \{[^}]*\} from[^;]*;/g, '');
        expect(uses).not.toMatch(/>=\s*IDLE_THRESHOLD_SECONDS|<\s*IDLE_THRESHOLD_SECONDS|,\s*IDLE_THRESHOLD_SECONDS\)/);
    });

    it('NotificationContext mirrors the saved pref into the shared module, and snaps bad stored values', () => {
        const src = read('contexts/NotificationContext.tsx');
        expect(src).toContain('idle_timeout_minutes: DEFAULT_IDLE_TIMEOUT_MINUTES');
        expect(src).toContain('setIdleTimeoutMinutes(prefs.idle_timeout_minutes)');
        expect(src).toContain('normalizeIdleTimeoutMinutes(merged.idle_timeout_minutes)');
    });

    it('Settings > Notifications has the Idle timeout row wired to the pref and the menu', () => {
        const src = read('components/NotificationsTab.tsx');
        expect(src).toContain('label="Idle timeout"');
        expect(src).toContain("set('idle_timeout_minutes'");
        expect(src).toContain('IDLE_TIMEOUT_CHOICES_MINUTES.map');
    });
});
