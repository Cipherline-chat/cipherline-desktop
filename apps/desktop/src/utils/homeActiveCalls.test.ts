import { describe, it, expect } from 'vitest';
import {
    isLocalCallRow, resolvePinnedChannelAction,
    type HomeCallRow, type LocalCallSession,
} from './homeActiveCalls';

const NO_SESSION: LocalCallSession = { voiceChannelId: null, huddleCallId: null };

describe('isLocalCallRow — voice channels', () => {
    const row: HomeCallRow = { kind: 'voice', channelId: 'chan-general' };

    it('matches the voice channel this client is connected to', () => {
        expect(isLocalCallRow(row, { voiceChannelId: 'chan-general', huddleCallId: null })).toBe(true);
    });

    it('does not match a different voice channel', () => {
        expect(isLocalCallRow(row, { voiceChannelId: 'chan-lounge', huddleCallId: null })).toBe(false);
    });

    it('does not match when connected to nothing', () => {
        expect(isLocalCallRow(row, NO_SESSION)).toBe(false);
    });

    it('does not match a huddle call that happens to share the id', () => {
        // Different id spaces; a collision must never cross kinds.
        expect(isLocalCallRow(row, { voiceChannelId: null, huddleCallId: 'chan-general' })).toBe(false);
    });
});

describe('isLocalCallRow — huddle calls', () => {
    const row: HomeCallRow = { kind: 'huddle', callId: 'call-1', channelId: 'huddle-standup' };

    it('matches on the CALL id', () => {
        expect(isLocalCallRow(row, { voiceChannelId: null, huddleCallId: 'call-1' })).toBe(true);
    });

    it('does not match a sibling call under the same huddle channel', () => {
        // The regression this guards: matching on the huddle CHANNEL would mark
        // every call in that huddle as "you're in this one" and hide Join on
        // calls the user could genuinely join.
        const sibling: HomeCallRow = { kind: 'huddle', callId: 'call-2', channelId: 'huddle-standup' };
        expect(isLocalCallRow(sibling, { voiceChannelId: null, huddleCallId: 'call-1' })).toBe(false);
    });

    it('does not match when the huddle channel id is in the voice slot', () => {
        expect(isLocalCallRow(row, { voiceChannelId: 'huddle-standup', huddleCallId: null })).toBe(false);
    });

    it('does not match when connected to nothing', () => {
        expect(isLocalCallRow(row, NO_SESSION)).toBe(false);
    });
});

describe('isLocalCallRow — missing session', () => {
    it('treats null/undefined as "not in this call" so Join stays offered', () => {
        const row: HomeCallRow = { kind: 'voice', channelId: 'chan-general' };
        expect(isLocalCallRow(row, null)).toBe(false);
        expect(isLocalCallRow(row, undefined)).toBe(false);
    });

    it('never reports a match for empty-string ids', () => {
        const voice: HomeCallRow = { kind: 'voice', channelId: '' };
        expect(isLocalCallRow(voice, { voiceChannelId: '', huddleCallId: null })).toBe(false);
        const huddle: HomeCallRow = { kind: 'huddle', callId: '', channelId: '' };
        expect(isLocalCallRow(huddle, { voiceChannelId: null, huddleCallId: '' })).toBe(false);
    });
});

describe('isLocalCallRow — exactly one row can be mine', () => {
    it('marks only the connected row across a mixed deck', () => {
        const rows: HomeCallRow[] = [
            { kind: 'voice', channelId: 'vc-1' },
            { kind: 'voice', channelId: 'vc-2' },
            { kind: 'huddle', callId: 'call-a', channelId: 'hd-1' },
            { kind: 'huddle', callId: 'call-b', channelId: 'hd-1' },
        ];
        const session: LocalCallSession = { voiceChannelId: null, huddleCallId: 'call-b' };
        expect(rows.map(r => isLocalCallRow(r, session))).toEqual([false, false, false, true]);
    });

    it('a voice session marks only its own channel', () => {
        const rows: HomeCallRow[] = [
            { kind: 'voice', channelId: 'vc-1' },
            { kind: 'voice', channelId: 'vc-2' },
            { kind: 'huddle', callId: 'call-a', channelId: 'vc-1' },
        ];
        const session: LocalCallSession = { voiceChannelId: 'vc-1', huddleCallId: null };
        expect(rows.map(r => isLocalCallRow(r, session))).toEqual([true, false, false]);
    });
});

describe('resolvePinnedChannelAction', () => {
    it('always opens a text channel, regardless of call session', () => {
        expect(resolvePinnedChannelAction('text', 'chan-general', NO_SESSION)).toBe('open');
        expect(resolvePinnedChannelAction('text', 'chan-general', { voiceChannelId: 'chan-general', huddleCallId: null })).toBe('open');
        expect(resolvePinnedChannelAction('text', 'chan-general', null)).toBe('open');
    });

    it('joins a voice channel the client is not already in', () => {
        expect(resolvePinnedChannelAction('voice', 'chan-general', NO_SESSION)).toBe('join');
        expect(resolvePinnedChannelAction('voice', 'chan-general', { voiceChannelId: 'chan-lounge', huddleCallId: null })).toBe('join');
        expect(resolvePinnedChannelAction('voice', 'chan-general', null)).toBe('join');
        expect(resolvePinnedChannelAction('voice', 'chan-general', undefined)).toBe('join');
    });

    it('navigates instead of re-joining a voice channel the client is already in', () => {
        // This is the exact bug shape cd9a573b fixed for "Happening now":
        // onJoinVoiceChannel early-returns when already connected, so calling
        // it here would be a silent no-op. 'navigate' is the honest action.
        expect(resolvePinnedChannelAction('voice', 'chan-general', { voiceChannelId: 'chan-general', huddleCallId: null })).toBe('navigate');
    });

    it('does not cross id spaces: a huddle call id in the voice slot never matches a voice channel id', () => {
        expect(resolvePinnedChannelAction('voice', 'chan-general', { voiceChannelId: null, huddleCallId: 'chan-general' })).toBe('join');
    });

    it('always navigates for a huddle channel — there is no single call id to join at the channel level', () => {
        expect(resolvePinnedChannelAction('huddle', 'huddle-standup', NO_SESSION)).toBe('navigate');
        expect(resolvePinnedChannelAction('huddle', 'huddle-standup', { voiceChannelId: null, huddleCallId: 'call-1' })).toBe('navigate');
        expect(resolvePinnedChannelAction('huddle', 'huddle-standup', null)).toBe('navigate');
    });
});
