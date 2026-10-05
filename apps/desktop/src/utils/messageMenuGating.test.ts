import { describe, it, expect } from 'vitest';
import {
    canPinMessage,
    canServerSaveMessage,
    serverSaveAction,
    canReplyToMessage,
    canReactToMessage,
    canEditMessage,
    canDeleteMessage,
    isTextLikeMessageType,
} from './messageMenuGating';

describe('canPinMessage', () => {
    it('always allows pinning in a DM/group regardless of MANAGE_MESSAGES', () => {
        expect(canPinMessage({ isChannelMessage: false, canManageMessages: false })).toBe(true);
        expect(canPinMessage({ isChannelMessage: false, canManageMessages: true })).toBe(true);
    });

    it('requires MANAGE_MESSAGES in a server channel', () => {
        expect(canPinMessage({ isChannelMessage: true, canManageMessages: true })).toBe(true);
        expect(canPinMessage({ isChannelMessage: true, canManageMessages: false })).toBe(false);
    });
});

describe('canReplyToMessage', () => {
    it('mirrors canCompose exactly', () => {
        expect(canReplyToMessage({ canCompose: true })).toBe(true);
        expect(canReplyToMessage({ canCompose: false })).toBe(false);
    });
});

describe('canReactToMessage', () => {
    it('requires BOTH canCompose and canReact — full truth table', () => {
        expect(canReactToMessage({ canCompose: true, canReact: true })).toBe(true);
        expect(canReactToMessage({ canCompose: true, canReact: false })).toBe(false);
        expect(canReactToMessage({ canCompose: false, canReact: true })).toBe(false);
        expect(canReactToMessage({ canCompose: false, canReact: false })).toBe(false);
    });
});

describe('canEditMessage', () => {
    it('allows editing your own text message while composable', () => {
        expect(canEditMessage({ canCompose: true, isOwnMessage: true, isTextMessage: true })).toBe(true);
    });

    it('refuses to edit someone else\'s message even if it is text and composable', () => {
        expect(canEditMessage({ canCompose: true, isOwnMessage: false, isTextMessage: true })).toBe(false);
    });

    it('refuses to edit a non-text own message (attachment/invite/etc.)', () => {
        expect(canEditMessage({ canCompose: true, isOwnMessage: true, isTextMessage: false })).toBe(false);
    });

    it('refuses to edit anything once the chat is no longer composable', () => {
        expect(canEditMessage({ canCompose: false, isOwnMessage: true, isTextMessage: true })).toBe(false);
    });
});

describe('canDeleteMessage', () => {
    it('own message: deletable while composable, regardless of moderation rights', () => {
        expect(canDeleteMessage({ canCompose: true, isOwnMessage: true, canManageMessages: false })).toBe(true);
        expect(canDeleteMessage({ canCompose: true, isOwnMessage: true, canManageMessages: true })).toBe(true);
    });

    it('someone else\'s message: only deletable with MANAGE_MESSAGES', () => {
        expect(canDeleteMessage({ canCompose: true, isOwnMessage: false, canManageMessages: true })).toBe(true);
        expect(canDeleteMessage({ canCompose: true, isOwnMessage: false, canManageMessages: false })).toBe(false);
    });

    it('DM/group has no moderation concept — canManageMessages is always false there, so only own messages are deletable', () => {
        // Simulates a DM: canManageMessages is hard-wired false by the caller.
        expect(canDeleteMessage({ canCompose: true, isOwnMessage: true, canManageMessages: false })).toBe(true);
        expect(canDeleteMessage({ canCompose: true, isOwnMessage: false, canManageMessages: false })).toBe(false);
    });

    it('nothing is deletable once the chat is no longer composable, even your own message', () => {
        expect(canDeleteMessage({ canCompose: false, isOwnMessage: true, canManageMessages: true })).toBe(false);
    });

    // ── Positive control ────────────────────────────────────────────────────
    // Every assertion above would also pass a version of the function that
    // ignored `canManageMessages` and just returned `isOwnMessage`. Prove the
    // moderator branch is actually read.
    it('POSITIVE CONTROL: a moderator-only branch is reachable independent of ownership', () => {
        expect(canDeleteMessage({ canCompose: true, isOwnMessage: false, canManageMessages: true })).toBe(true);
    });
});

describe('isTextLikeMessageType', () => {
    it('treats text, server_invite and klipy_gif as text-like (pin / save / report / retention)', () => {
        expect(isTextLikeMessageType('text')).toBe(true);
        expect(isTextLikeMessageType('server_invite')).toBe(true);
        expect(isTextLikeMessageType('klipy_gif')).toBe(true);
    });

    it('treats attachment, call_key, system, and unset as NOT text-like', () => {
        expect(isTextLikeMessageType('attachment')).toBe(false);
        expect(isTextLikeMessageType('call_key')).toBe(false);
        expect(isTextLikeMessageType('system')).toBe(false);
        expect(isTextLikeMessageType(undefined)).toBe(false);
        expect(isTextLikeMessageType(null)).toBe(false);
    });
});

describe('canServerSaveMessage', () => {
    it('is channel-only — never offered in a DM/group, even with the bit', () => {
        expect(canServerSaveMessage({ isChannelMessage: false, canSaveMessages: true })).toBe(false);
        expect(canServerSaveMessage({ isChannelMessage: false, canSaveMessages: false })).toBe(false);
    });

    it('requires SAVE_MESSAGES in a channel', () => {
        expect(canServerSaveMessage({ isChannelMessage: true, canSaveMessages: true })).toBe(true);
        expect(canServerSaveMessage({ isChannelMessage: true, canSaveMessages: false })).toBe(false);
    });
});

describe('serverSaveAction', () => {
    const base = { isChannelMessage: true, canSaveMessages: true, isServerSaved: false, isPinned: false };

    it('offers Save for an unsaved channel message', () => {
        expect(serverSaveAction(base)).toBe('save');
    });

    it('offers Remove for a saved, unpinned message', () => {
        expect(serverSaveAction({ ...base, isServerSaved: true })).toBe('unsave');
    });

    it('locks a pinned message as "Saved (pinned)" — the API would 409 an unsave', () => {
        expect(serverSaveAction({ ...base, isServerSaved: true, isPinned: true })).toBe('pinned');
    });

    it('treats pinned as saved even if the saved list has not caught up yet', () => {
        expect(serverSaveAction({ ...base, isServerSaved: false, isPinned: true })).toBe('pinned');
    });

    it('is hidden without SAVE_MESSAGES — including on a pinned message (a pin-only moderator sees Pin/Unpin only)', () => {
        for (const isPinned of [false, true]) {
            for (const isServerSaved of [false, true]) {
                expect(serverSaveAction({ ...base, canSaveMessages: false, isPinned, isServerSaved })).toBe('hidden');
            }
        }
    });

    it('is hidden in a DM/group whatever else is true', () => {
        expect(serverSaveAction({ isChannelMessage: false, canSaveMessages: true, isServerSaved: true, isPinned: true })).toBe('hidden');
    });
});
