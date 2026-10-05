import { describe, it, expect } from 'vitest';
import { Permissions, DEFAULT_EVERYONE_PERMISSIONS } from '@cipherline/shared';
import {
    canOpenServerSettings,
    serverSettingsTabVisibility,
    type ServerSettingsTab,
} from './serverSettingsAccess';

const NOT_OWNER = false;

describe('canOpenServerSettings', () => {
    it('is false for a default member — the regression this file exists for', () => {
        // DEFAULT_EVERYONE_PERMISSIONS includes CREATE_INVITE, and the old
        // hand-maintained gate in Dashboard listed CREATE_INVITE. No tab is
        // keyed on it, so every ordinary member of every server saw the gear,
        // opened it to zero tabs, and fell through to the editable Overview
        // form with the server name and description in it.
        expect(canOpenServerSettings(DEFAULT_EVERYONE_PERMISSIONS, NOT_OWNER)).toBe(false);
    });

    it('is false for CREATE_INVITE alone', () => {
        // Inviting is reachable from the dedicated "Invite People" button; it
        // grants nothing inside Server Settings.
        expect(canOpenServerSettings(Permissions.CREATE_INVITE, NOT_OWNER)).toBe(false);
    });

    it('is false for MANAGE_CHANNELS alone', () => {
        // Channel/category creation, editing, and permission overrides all
        // live in the channel sidebar's own right-click menus now — the
        // Channels tab that used to be keyed on this bit is gone, and
        // nothing else in Server Settings is. MANAGE_CHANNELS still gates
        // those sidebar menus (ServerChannelList.tsx); it just grants
        // nothing HERE anymore.
        expect(canOpenServerSettings(Permissions.MANAGE_CHANNELS, NOT_OWNER)).toBe(false);
    });

    it('is false for no permissions at all', () => {
        expect(canOpenServerSettings(0n, NOT_OWNER)).toBe(false);
    });

    it('is true for the owner even with an empty permission set', () => {
        expect(canOpenServerSettings(0n, true)).toBe(true);
    });

    it('is true for ADMINISTRATOR', () => {
        expect(canOpenServerSettings(Permissions.ADMINISTRATOR, NOT_OWNER)).toBe(true);
    });

    it.each([
        ['MANAGE_SERVER',    Permissions.MANAGE_SERVER],
        ['MANAGE_ROLES',     Permissions.MANAGE_ROLES],
        ['KICK_MEMBERS',     Permissions.KICK_MEMBERS],
        ['BAN_MEMBERS',      Permissions.BAN_MEMBERS],
        ['MUTE_MEMBERS',     Permissions.MUTE_MEMBERS],
        ['MANAGE_NICKNAMES', Permissions.MANAGE_NICKNAMES],
        ['VIEW_AUDIT_LOG',   Permissions.VIEW_AUDIT_LOG],
        ['MANAGE_EMOJIS',    Permissions.MANAGE_EMOJIS],
    ])('is true for %s alone', (_label, bit) => {
        expect(canOpenServerSettings(bit, NOT_OWNER)).toBe(true);
    });
});

describe('the entry point and the tabs cannot disagree', () => {
    /**
     * The actual invariant. The original bug was not a wrong permission bit —
     * it was two lists maintained independently. Assert the property directly
     * so any future edit to either side that breaks the correspondence fails
     * here rather than in someone's server.
     */
    const EVERY_BIT = Object.values(Permissions);

    it('offers the entry point exactly when at least one tab is visible', () => {
        for (const bit of EVERY_BIT) {
            for (const isOwner of [false, true]) {
                const tabs = serverSettingsTabVisibility(bit, isOwner);
                const anyTab = Object.values(tabs).some(Boolean);
                expect(canOpenServerSettings(bit, isOwner)).toBe(anyTab);
            }
        }
    });

    it('never shows the entry point with nothing behind it, for any single permission', () => {
        for (const bit of EVERY_BIT) {
            if (!canOpenServerSettings(bit, NOT_OWNER)) continue;
            const visible = Object.entries(serverSettingsTabVisibility(bit, NOT_OWNER))
                .filter(([, v]) => v)
                .map(([k]) => k as ServerSettingsTab);
            expect(visible.length).toBeGreaterThan(0);
        }
    });
});

describe('serverSettingsTabVisibility', () => {
    it('gives the owner every tab', () => {
        const tabs = serverSettingsTabVisibility(0n, true);
        expect(Object.values(tabs).every(Boolean)).toBe(true);
    });

    it('scopes a single permission to just its own tab', () => {
        // BAN_MEMBERS reaches Bans, and Members (banning is a member action) —
        // but must not unlock Overview, i.e. the server name/description.
        const tabs = serverSettingsTabVisibility(Permissions.BAN_MEMBERS, NOT_OWNER);
        expect(tabs.bans).toBe(true);
        expect(tabs.members).toBe(true);
        expect(tabs.overview).toBe(false);
        expect(tabs.roles).toBe(false);
        expect(tabs.audit).toBe(false);
    });

    it('scopes MANAGE_EMOJIS to just its own tab', () => {
        const tabs = serverSettingsTabVisibility(Permissions.MANAGE_EMOJIS, NOT_OWNER);
        expect(tabs.emojis).toBe(true);
        expect(tabs.overview).toBe(false);
        expect(tabs.roles).toBe(false);
        expect(tabs.members).toBe(false);
        expect(tabs.bans).toBe(false);
        expect(tabs.audit).toBe(false);
    });

    it('keeps Overview behind MANAGE_SERVER specifically', () => {
        // Overview is the server name / description / icon / banner form.
        for (const bit of [
            Permissions.MANAGE_ROLES,
            Permissions.MANAGE_CHANNELS,
            Permissions.KICK_MEMBERS,
            Permissions.BAN_MEMBERS,
            Permissions.MUTE_MEMBERS,
            Permissions.MANAGE_NICKNAMES,
            Permissions.VIEW_AUDIT_LOG,
            Permissions.CREATE_INVITE,
        ]) {
            expect(serverSettingsTabVisibility(bit, NOT_OWNER).overview).toBe(false);
        }
        expect(serverSettingsTabVisibility(Permissions.MANAGE_SERVER, NOT_OWNER).overview).toBe(true);
    });
});
