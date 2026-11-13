import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SETTINGS_INDEX, searchSettingsIndex } from './settingsSearchIndex';

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), 'utf8');

describe('Security lives on the Security & devices page, not under Profile', () => {
    const devices = read('panes', 'DevicesPane.tsx');
    const profile = read('panes', 'ProfilePane.tsx');

    it('the Devices pane renders 2FA, the recovery key and change-password', () => {
        expect(devices).toMatch(/<TotpSettingsCard bare \/>/);
        expect(devices).toMatch(/<RecoveryKeyCard \/>/);
        expect(devices).toMatch(/Change password/);
        expect(devices).toMatch(/<ChangePasswordModal open=\{changePw\}/);
    });

    it('the Profile pane no longer has a Security tab or any of those cards', () => {
        expect(profile).not.toMatch(/id: 'security'/);
        expect(profile).not.toMatch(/TotpSettingsCard|RecoveryKeyCard|ChangePasswordModal/);
    });

    it('the pane keeps its id (deep links) but is titled Security & devices', () => {
        expect(read('SettingsScreen.tsx')).toMatch(/devices:\s+\{ title: 'Security & devices'/);
        expect(read('DepthGauge.tsx')).toMatch(/id: 'devices',\s+label: 'Security & devices'/);
    });

    it('settings search points the security entries at the devices pane, and nowhere on profile', () => {
        const profileLabels = SETTINGS_INDEX.profile.map(e => e.label);
        for (const l of ['Two-factor authentication', 'Recovery key', 'Change password']) {
            expect(profileLabels).not.toContain(l);
            expect(SETTINGS_INDEX.devices.map(e => e.label)).toContain(l);
        }
        expect(searchSettingsIndex('2fa').devices).toContain('Two-factor authentication');
        expect(searchSettingsIndex('password').devices).toContain('Change password');
        expect(searchSettingsIndex('2fa').profile).toBeUndefined();
    });

    it('the onboarding 2FA step opens the Devices pane', () => {
        expect(read('..', 'OnboardingChecklist.tsx')).toMatch(/if \(!twoFaDone\) onOpenSettings\('devices'\)/);
    });
});
