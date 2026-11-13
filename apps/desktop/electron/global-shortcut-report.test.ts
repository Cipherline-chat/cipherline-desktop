import { describe, it, expect } from 'vitest';
import { buildGlobalShortcutsReport } from './global-shortcut-report';

describe('buildGlobalShortcutsReport', () => {
    it('no sync yet: nothing to report', () => {
        expect(buildGlobalShortcutsReport(null)).toBeNull();
    });
    it('Wayland portal: mode, reason, desktop, appId, bound and notBound, per-action outcome', () => {
        const r = buildGlobalShortcutsReport({
            status: { mode: 'portal', reason: 'wayland-portal', desktop: 'KDE', appId: 'chat.cipherline.Cipherline', portal: { bound: ['toggle-mute'], notBound: ['toggle-camera'] } },
            map: { 'CommandOrControl+Shift+M': 'toggle-mute', 'CommandOrControl+Shift+F10': 'toggle-camera' },
            failed: ['toggle-camera'],
        });
        expect(r).toEqual({
            mode: 'portal', reason: 'wayland-portal', desktop: 'KDE', app_id: 'chat.cipherline.Cipherline',
            bound: ['toggle-mute'], not_bound: ['toggle-camera'],
            actions: [
                { action: 'toggle-mute', accelerator: 'CommandOrControl+Shift+M', state: 'registered' },
                { action: 'toggle-camera', accelerator: 'CommandOrControl+Shift+F10', state: 'failed' },
            ],
        });
    });
    it('native mode has no portal fields', () => {
        const r = buildGlobalShortcutsReport({ status: { mode: 'native', reason: 'native-os', desktop: '' }, map: { 'CommandOrControl+Shift+M': 'toggle-mute' }, failed: [] });
        expect(r).not.toHaveProperty('bound');
        expect(r).not.toHaveProperty('app_id');
        expect(r!.actions[0].state).toBe('registered');
    });
});
