import { describe, it, expect } from 'vitest';
import {
    loginToggleLabel, loginToggleDesc, loginStateAfterSet,
    INITIAL_START_MINIMIZED, INITIAL_MINIMIZE_TO_TRAY,
} from './startupSettings';

describe('startup settings view', () => {
    it('labels follow the platform', () => {
        expect(loginToggleLabel('windows')).toBe('Start with Windows');
        expect(loginToggleLabel('mac')).toBe('Open at login');
        expect(loginToggleLabel('linux')).toBe('Start on login');
    });

    it('initial toggle values match the default-ON main process', () => {
        expect(INITIAL_START_MINIMIZED).toBe(true);
        expect(INITIAL_MINIMIZE_TO_TRAY).toBe(true);
    });

    it('explains an unsupported (dev) build and a macOS approval wait', () => {
        expect(loginToggleDesc('windows', { supported: false, enabled: false, needsApproval: false })).toMatch(/installed app/);
        expect(loginToggleDesc('mac', { supported: true, enabled: true, needsApproval: true })).toMatch(/Login Items/);
    });

    it('after a set, the toggle shows the OS re-read, not the request', () => {
        // Asked for ON, the OS says OFF (e.g. policy blocked it) → OFF.
        expect(loginStateAfterSet(true, { supported: true, enabled: false, needsApproval: false }, null).enabled).toBe(false);
        expect(loginStateAfterSet(true, { supported: true, enabled: true, needsApproval: true }, null))
            .toEqual({ supported: true, enabled: true, needsApproval: true });
    });

    it('an older main process (resolves void) falls back to the requested value', () => {
        expect(loginStateAfterSet(true, undefined, null)).toEqual({ supported: true, enabled: true, needsApproval: false });
        expect(loginStateAfterSet(false, undefined, { supported: true, enabled: true, needsApproval: false }).enabled).toBe(false);
    });
});
