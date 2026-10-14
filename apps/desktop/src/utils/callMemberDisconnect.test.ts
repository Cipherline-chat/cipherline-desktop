import { describe, it, expect, vi } from 'vitest';
import { Permissions } from '@cipherline/shared';
import {
    canOfferDisconnect,
    disconnectConfirmCopy,
    disconnectErrorToast,
    disconnectPath,
    hasManageCallMembers,
    hasModerateCallMedia,
    requestDisconnect,
} from './callMemberDisconnect';

/**
 * "Disconnect" in a call participant's right-click menu. The client gate is a
 * UX mirror (the server re-checks the permission and the role hierarchy), so
 * these pin what the menu OFFERS, how it ASKS, and where it POSTs.
 */

const ME = 'user-me';
const THEM = 'user-them';

describe('permission gates (bits unchanged by the rename)', () => {
    it('Manage Call Members is bit 12 (the old MOVE_MEMBERS) and gates move + disconnect', () => {
        expect(hasManageCallMembers(1n << 12n)).toBe(true);
        expect(hasManageCallMembers(Permissions.MOVE_MEMBERS)).toBe(true); // deprecated alias, same bit
        expect(hasManageCallMembers(0n)).toBe(false);
    });

    it('ADMINISTRATOR implies both', () => {
        expect(hasManageCallMembers(Permissions.ADMINISTRATOR)).toBe(true);
        expect(hasModerateCallMedia(Permissions.ADMINISTRATOR)).toBe(true);
    });

    it('the two are independent: media moderation alone does not offer Disconnect, and vice versa', () => {
        expect(hasManageCallMembers(Permissions.MODERATE_CALL_MEDIA)).toBe(false);
        expect(hasModerateCallMedia(Permissions.MANAGE_CALL_MEMBERS)).toBe(false);
        expect(hasModerateCallMedia(1n << 11n)).toBe(true); // the old DEAFEN_MEMBERS bit
        expect(hasModerateCallMedia(Permissions.DEAFEN_MEMBERS)).toBe(true);
    });

    it('unrelated moderation bits do not grant it (negative control)', () => {
        const others = Permissions.KICK_MEMBERS | Permissions.BAN_MEMBERS | Permissions.MUTE_MEMBERS | Permissions.MANAGE_CHANNELS;
        expect(hasManageCallMembers(others)).toBe(false);
        expect(hasModerateCallMedia(others)).toBe(false);
    });
});

describe('canOfferDisconnect — the menu item', () => {
    const base = { canManageCallMembers: true, targetUserId: THEM, selfUserId: ME, targetInCall: true };

    it('is offered for someone else in a call when the viewer holds the permission', () => {
        expect(canOfferDisconnect(base)).toBe(true);
    });

    it('is NOT offered without the permission', () => {
        expect(canOfferDisconnect({ ...base, canManageCallMembers: false })).toBe(false);
    });

    it('is NOT offered on yourself', () => {
        expect(canOfferDisconnect({ ...base, targetUserId: ME })).toBe(false);
    });

    it('is NOT offered for someone who is not in a call', () => {
        expect(canOfferDisconnect({ ...base, targetInCall: false })).toBe(false);
    });

    it('is NOT offered when we do not know who we are (no self id to compare against)', () => {
        expect(canOfferDisconnect({ ...base, selfUserId: null })).toBe(false);
        expect(canOfferDisconnect({ ...base, selfUserId: undefined })).toBe(false);
    });

    it('wired to the real gate: a Manage-Call-Members holder sees it, a Moderate-Call-Media-only holder does not', () => {
        const offer = (perms: bigint) => canOfferDisconnect({ ...base, canManageCallMembers: hasManageCallMembers(perms) });
        expect(offer(Permissions.MANAGE_CALL_MEMBERS)).toBe(true);
        expect(offer(Permissions.MODERATE_CALL_MEDIA)).toBe(false);
        expect(offer(0n)).toBe(false);
    });
});

describe('confirm copy and endpoints', () => {
    it('asks "Disconnect <name> from the call?" with a Disconnect button', () => {
        expect(disconnectConfirmCopy('Alex')).toEqual({
            title: 'Disconnect Alex?',
            message: 'Disconnect Alex from the call?',
            confirmLabel: 'Disconnect',
        });
    });

    it('survives a blank name', () => {
        expect(disconnectConfirmCopy('   ').message).toBe('Disconnect this member from the call?');
    });

    it('a Calls-channel call POSTs to the huddle route; a legacy voice channel to the channel route', () => {
        expect(disconnectPath({ kind: 'huddle', callId: 'c1' }, 'u1')).toBe('/huddles/calls/c1/participants/u1/disconnect');
        expect(disconnectPath({ kind: 'voice', channelId: 'v1' }, 'u1')).toBe('/channels/v1/participants/u1/disconnect');
    });

    it('encodes ids into the path (no path injection from a hostile id)', () => {
        expect(disconnectPath({ kind: 'huddle', callId: 'a/b' }, '../x')).toBe('/huddles/calls/a%2Fb/participants/..%2Fx/disconnect');
    });
});

describe('requestDisconnect', () => {
    it('sends nothing until called, then one authorised POST with an empty body', async () => {
        const post = vi.fn(async () => ({}));
        await requestDisconnect(post, 'https://api/v1', 'tok', { kind: 'huddle', callId: 'c1' }, THEM);
        expect(post).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledWith(
            'https://api/v1/huddles/calls/c1/participants/user-them/disconnect', {},
            { headers: { Authorization: 'Bearer tok' }, timeout: 15000 },
        );
    });

    it('lets a rejection through so the caller can explain it', async () => {
        const post = vi.fn(async () => { throw new Error('403'); });
        await expect(requestDisconnect(post, 'b', 't', { kind: 'voice', channelId: 'v' }, THEM)).rejects.toThrow('403');
    });
});

describe('disconnectErrorToast', () => {
    it('uses the server\'s reason when it gave one (e.g. the hierarchy guard)', () => {
        const t = disconnectErrorToast({ response: { data: { message: 'Cannot moderate a member with an equal or higher role' } } });
        expect(t).toEqual({ kind: 'error', title: "Couldn't disconnect them", message: 'Cannot moderate a member with an equal or higher role' });
    });

    it('falls back to a generic line otherwise', () => {
        expect(disconnectErrorToast(new Error('network')).message).toMatch(/rejected|left the call/);
        expect(disconnectErrorToast(null).kind).toBe('error');
        expect(disconnectErrorToast({ response: { data: { message: 42 } } }).message).toMatch(/rejected|left the call/);
    });
});
