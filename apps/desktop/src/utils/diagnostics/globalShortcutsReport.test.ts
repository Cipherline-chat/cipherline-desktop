import { describe, it, expect } from 'vitest';
import { addUnboundShortcuts, parseSystemInfoReply } from './ipc';
import { createScrubber, scrubDeep, DEFAULT_DEEP_LIMITS } from './scrub';
import { DIAGNOSTIC_VERBATIM_KEYS } from './reportTypes';
import { migrateCameraKeybind, unboundGlobalActions } from '../../hooks/useKeybinds';

const parse = (system: Record<string, unknown>) => parseSystemInfoReply({ system }, '1.0.0', 'abc1234').system;

describe('system.global_shortcuts', () => {
    const gs = {
        mode: 'portal', reason: 'wayland-portal', desktop: 'KDE', app_id: 'chat.cipherline.Cipherline',
        bound: ['toggle-mute'], not_bound: ['toggle-camera'],
        actions: [{ action: 'toggle-camera', accelerator: 'CommandOrControl+Shift+F10', state: 'failed' }],
    };
    it('passes through as ids, combos and fixed words', () => {
        expect(parse({ platform: 'linux', global_shortcuts: gs }).global_shortcuts).toEqual(gs);
    });
    it('hostile values are dropped, not copied', () => {
        const out = parse({
            global_shortcuts: {
                mode: 'portal', reason: '/home/me', desktop: 'KDE; rm', app_id: 'a b', bound: ['ok-id', '/etc/passwd'],
                actions: [{ action: '/home/me', accelerator: 'x', state: 'registered' }, { action: 'toggle-camera', accelerator: 'has space', state: 'weird' }],
            },
        }).global_shortcuts;
        expect(out).toEqual({ mode: 'portal', reason: '', desktop: 'KDErm', bound: ['ok-id'], actions: [{ action: 'toggle-camera', accelerator: '', state: 'failed' }] });
        expect(parse({ global_shortcuts: { mode: 'nope' } }).global_shortcuts).toBeUndefined();
    });
    it('addUnboundShortcuts appends actions with no key, and does nothing without a sync', () => {
        const withUnbound = addUnboundShortcuts(parse({ platform: 'linux', global_shortcuts: gs }), ['toggle-camera', 'leave-call']);
        expect(withUnbound.global_shortcuts!.actions).toEqual([...gs.actions, { action: 'leave-call', accelerator: '', state: 'unbound' }]);
        const none = parse({ platform: 'linux' });
        expect(addUnboundShortcuts(none, ['leave-call'])).toBe(none);
    });
});

describe('scrubbing keeps the key combos', () => {
    it('a long Electron accelerator is not blanked as a base64 blob, an email-shaped one still is', () => {
        const scrubbed = scrubDeep(
            { actions: [{ action: 'toggle-camera', accelerator: 'CommandOrControl+Shift+F10' }, { action: 'x', accelerator: 'a@b.co' }] },
            createScrubber(), DEFAULT_DEEP_LIMITS, DIAGNOSTIC_VERBATIM_KEYS,
        ) as { actions: Array<{ accelerator: string }> };
        expect(scrubbed.actions[0].accelerator).toBe('CommandOrControl+Shift+F10');
        expect(scrubbed.actions[1].accelerator).toBe('<invalid>');
    });
});

describe('camera migration fallback and unbound reporting', () => {
    it('F10 taken: the camera gets the next free fallback instead of being left unbound', () => {
        const out = migrateCameraKeybind({ 'toggle-camera': 'ctrl+shift+v', 'leave-call': 'ctrl+shift+f10' }, false) as Record<string, string>;
        expect(out['toggle-camera']).toBe('ctrl+shift+f11');
    });
    it('every candidate taken: UNBOUND is the last resort', () => {
        const out = migrateCameraKeybind({
            'toggle-camera': 'ctrl+shift+v', 'leave-call': 'ctrl+shift+f10', 'toggle-mute': 'ctrl+shift+f11',
            'toggle-deafen': 'ctrl+shift+f8', 'lock-screen': 'ctrl+alt+f10',
        }, false) as Record<string, string>;
        expect(out['toggle-camera']).toBe('');
    });
    it('unboundGlobalActions lists global actions without a accelerator, never the armed-only or local ones', () => {
        const out = unboundGlobalActions({ 'toggle-mute': 'ctrl+shift+m', 'toggle-camera': '' });
        expect(out).toContain('toggle-camera');
        expect(out).not.toContain('toggle-mute');
        expect(out).not.toContain('approve-annotation-request');
        expect(out).not.toContain('open-settings');
    });
});
