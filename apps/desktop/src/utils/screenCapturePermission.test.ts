import { describe, it, expect } from 'vitest';
import {
    screenSourcesVerdict,
    isScreenAccessRefused,
    showMacPickerBypassNote,
    MACOS_SCREEN_RECORDING_SETTINGS_URL,
    type MediaAccessStatus,
    type ScreenCaptureAccess,
} from './screenCapturePermission';

// Every status string Electron's getMediaAccessStatus documents, plus the
// synthetic 'not-applicable' the main process returns off macOS.
const MAC_STATUSES: MediaAccessStatus[] = ['not-determined', 'granted', 'denied', 'restricted', 'unknown'];
const UNGRANTED: MediaAccessStatus[] = ['not-determined', 'denied', 'restricted', 'unknown'];

describe('screenSourcesVerdict', () => {
    it('shows the grid whenever there is anything to share, on every platform and status', () => {
        for (const platform of ['windows', 'mac', 'linux'] as const) {
            for (const access of [...MAC_STATUSES, 'not-applicable'] as ScreenCaptureAccess[]) {
                for (const fetchFailed of [false, true]) {
                    expect(screenSourcesVerdict({ platform, access, sourceCount: 1, fetchFailed })).toBe('sources');
                }
            }
        }
    });

    it('never blames permissions off macOS — Windows and Linux keep the plain empty state', () => {
        for (const platform of ['windows', 'linux'] as const) {
            for (const access of [...MAC_STATUSES, 'not-applicable'] as ScreenCaptureAccess[]) {
                for (const fetchFailed of [false, true]) {
                    expect(screenSourcesVerdict({ platform, access, sourceCount: 0, fetchFailed })).toBe('empty');
                }
            }
        }
    });

    it('explains the TCC gate on macOS for every status that is not granted', () => {
        for (const access of UNGRANTED) {
            // Electron 43 REJECTS getSources() when the grant is missing, but
            // an empty resolve must land in the same place.
            expect(screenSourcesVerdict({ platform: 'mac', access, sourceCount: 0, fetchFailed: true }))
                .toBe('macos-permission-required');
            expect(screenSourcesVerdict({ platform: 'mac', access, sourceCount: 0, fetchFailed: false }))
                .toBe('macos-permission-required');
        }
    });

    it('does NOT blame permissions on macOS when access is granted and the call succeeded', () => {
        // Empty-with-permission is a different bug; the picker must not send
        // the user to System Settings for a toggle that is already on.
        expect(screenSourcesVerdict({ platform: 'mac', access: 'granted', sourceCount: 0 })).toBe('empty');
    });

    it('asks for a relaunch when macOS says granted but the enumeration still failed', () => {
        // CGRequestScreenCaptureAccess caches its refusal for the life of the
        // process, so a grant made after launch cannot take effect until the
        // app is quit and reopened. Pointing this user at System Settings
        // again would be a dead end.
        expect(screenSourcesVerdict({ platform: 'mac', access: 'granted', sourceCount: 0, fetchFailed: true }))
            .toBe('macos-relaunch-required');
    });

    it('treats a main process that reports not-applicable as a plain empty list', () => {
        // Belt and braces for an older preload without the status IPC.
        expect(screenSourcesVerdict({ platform: 'mac', access: 'not-applicable', sourceCount: 0 })).toBe('empty');
        expect(screenSourcesVerdict({ platform: 'mac', access: 'not-applicable', sourceCount: 0, fetchFailed: true })).toBe('empty');
    });

    it('defaults fetchFailed to false when the caller omits it', () => {
        expect(screenSourcesVerdict({ platform: 'mac', access: 'granted', sourceCount: 0 })).toBe('empty');
    });
});

describe('isScreenAccessRefused', () => {
    it('is true only for an active refusal or a policy restriction', () => {
        expect(isScreenAccessRefused('denied')).toBe(true);
        expect(isScreenAccessRefused('restricted')).toBe(true);
    });

    it('is false while the decision is still open or already granted', () => {
        expect(isScreenAccessRefused('not-determined')).toBe(false);
        expect(isScreenAccessRefused('granted')).toBe(false);
        expect(isScreenAccessRefused('unknown')).toBe(false);
        expect(isScreenAccessRefused('not-applicable')).toBe(false);
    });
});

describe('MACOS_SCREEN_RECORDING_SETTINGS_URL', () => {
    it('targets the Screen Recording pane via the System Settings scheme', () => {
        expect(MACOS_SCREEN_RECORDING_SETTINGS_URL)
            .toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    });

    it('is not an https/mailto URL, i.e. it cannot be smuggled through shell:open-external', () => {
        // The generic open-external IPC allows only https: and mailto:. This
        // link therefore has to go through its own dedicated, argument-free
        // main-process handler.
        expect(MACOS_SCREEN_RECORDING_SETTINGS_URL.startsWith('https:')).toBe(false);
        expect(MACOS_SCREEN_RECORDING_SETTINGS_URL.startsWith('mailto:')).toBe(false);
    });
});

describe('showMacPickerBypassNote (macOS 15+ "bypass the private window picker" consent)', () => {
    it('macOS 15 and later: shown (boundary at Sequoia)', () => {
        expect(showMacPickerBypassNote('mac', 14)).toBe(false);
        expect(showMacPickerBypassNote('mac', 15)).toBe(true);
        expect(showMacPickerBypassNote('mac', 27)).toBe(true);
    });
    it('unknown macOS version (older preload / unreadable): shown rather than leave the dialog unexplained', () => {
        expect(showMacPickerBypassNote('mac', null)).toBe(true);
        expect(showMacPickerBypassNote('mac', undefined)).toBe(true);
    });
    it('never on Windows or Linux, whatever version is passed', () => {
        for (const p of ['windows', 'linux'] as const) {
            expect(showMacPickerBypassNote(p, 27)).toBe(false);
            expect(showMacPickerBypassNote(p, null)).toBe(false);
        }
    });
});
