import { describe, it, expect } from 'vitest';
import { buildSettingsSnapshot, holdKeyFields } from './settingsSnapshot';
import { buildDiagnosticReport } from './bundle';
import { DIAGNOSTIC_CATEGORIES } from './reportTypes';

describe('push-to-talk in the problem report', () => {
    it('kind, token name, backend and watcher status; never the free text of an odd key', () => {
        const f = holdKeyFields(
            { pushToTalk: true, pushToTalkKey: 'mouse4', pushToMuteKey: 'shift+!' },
            {
                backend: 'win32', nativeWatcher: true, elevationCheck: true, foregroundBlocked: true, adminGame: 'unknown',
                pushToTalk: { status: 'ok', live: true },
                pushToMute: { status: 'focused-only', reason: 'unmapped-key', live: false },
            },
        );
        expect(f).toMatchObject({
            ptt_enabled: true, ptt_key_kind: 'mouse', ptt_key: 'mouse4',
            ptm_key_kind: 'combo', ptm_key: 'other',
            ptt_backend: 'win32', ptt_native_watcher: true, ptt_watcher: 'ok', ptt_watcher_live: true,
            ptm_watcher: 'focused-only', ptm_watcher_reason: 'unmapped-key',
            ptt_elevation_check: true, ptt_foreground_elevated: true, ptt_admin_game: 'unknown',
        });
    });

    it('nothing known yet: only the voice-setting part, nulls dropped from the snapshot', () => {
        const snap = buildSettingsSnapshot({ voice: { pushToTalk: false, pushToTalkKey: null } });
        expect(snap.general).toMatchObject({ ptt_enabled: false, ptt_key_kind: 'none' });
        expect(snap.general).not.toHaveProperty('ptt_backend');
    });

    it('rides in the general group, so EVERY category carries it', () => {
        const settings = buildSettingsSnapshot({
            voice: { pushToTalk: true, pushToTalkKey: 'numpad1' },
            holdKeys: { backend: 'x11', pushToTalk: { status: 'ok', live: false } },
        });
        for (const category of DIAGNOSTIC_CATEGORIES) {
            const r = buildDiagnosticReport({
                category, trigger: 'manual', now: Date.now(), settings,
                system: { app_version: '0.1.3', os: 'linux' } as never,
                scrub: { sensitiveTerms: [] },
            });
            expect(r.body.payload.settings, category).toMatchObject({ ptt_key: 'numpad1', ptt_backend: 'x11', ptt_watcher: 'ok' });
        }
    });
});
