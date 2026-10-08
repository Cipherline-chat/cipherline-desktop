import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    applyCallMediaEvent,
    applyCallMediaSeed,
    callMediaEntriesFromCalls,
    callMediaEntriesFromSeed,
    clearCallMediaKey,
    clearCallMediaUser,
    getCallMedia,
    huddleCallMediaKey,
    resolveParticipantMedia,
    setCallMedia,
    subscribeCallMedia,
    summarizeCallMedia,
    voiceChannelMediaKey,
    __resetCallMediaPresence,
} from './callMediaPresence';

const CALL = 'call-1';
const OTHER_CALL = 'call-2';
const VOICE = 'voice-chan';
const A = 'user-a';
const B = 'user-b';
const OFF = { camera: false, screen_share: false };

beforeEach(() => __resetCallMediaPresence());

describe('callMediaPresence — live events', () => {
    it('applies a huddle call:media_state event keyed by call_id', () => {
        applyCallMediaEvent({ channel_id: 'huddle', call_id: CALL, user_id: A, camera: true, screen_share: false });
        expect(getCallMedia(huddleCallMediaKey(CALL), A)).toEqual({ camera: true, screen_share: false });
        // Positive isolation: another call / user is untouched.
        expect(getCallMedia(huddleCallMediaKey(OTHER_CALL), A)).toEqual(OFF);
        expect(getCallMedia(huddleCallMediaKey(CALL), B)).toEqual(OFF);
    });

    it('applies a voice-channel event (call_id null) keyed by channel', () => {
        applyCallMediaEvent({ channel_id: VOICE, call_id: null, user_id: A, camera: false, screen_share: true });
        expect(getCallMedia(voiceChannelMediaKey(VOICE), A)).toEqual({ camera: false, screen_share: true });
    });

    it('an all-off event removes the participant', () => {
        applyCallMediaEvent({ channel_id: 'h', call_id: CALL, user_id: A, camera: true, screen_share: true });
        applyCallMediaEvent({ channel_id: 'h', call_id: CALL, user_id: A, camera: false, screen_share: false });
        expect(getCallMedia(huddleCallMediaKey(CALL), A)).toEqual(OFF);
        expect(summarizeCallMedia(huddleCallMediaKey(CALL), [A])).toEqual({ camera: [], screen_share: [] });
    });

    it.each([
        ['null', null],
        ['no user', { call_id: CALL, camera: true, screen_share: true }],
        ['no ids', { user_id: A, camera: true, screen_share: true }],
        ['string flags are not true', { call_id: CALL, user_id: A, camera: 'true', screen_share: 1 }],
    ])('ignores / does not turn on for malformed event: %s', (_l, raw) => {
        applyCallMediaEvent(raw);
        expect(getCallMedia(huddleCallMediaKey(CALL), A)).toEqual(OFF);
    });

    it('join/leave clears that participant; destroy clears the call', () => {
        setCallMedia(CALL, A, { camera: true, screen_share: false });
        setCallMedia(CALL, B, { camera: false, screen_share: true });
        clearCallMediaUser(CALL, A);
        expect(getCallMedia(CALL, A)).toEqual(OFF);
        expect(getCallMedia(CALL, B)).toEqual({ camera: false, screen_share: true });
        clearCallMediaKey(CALL);
        expect(getCallMedia(CALL, B)).toEqual(OFF);
    });

    it('notifies only subscribers of the changed call, and only on a real change', () => {
        const onCall = vi.fn();
        const onOther = vi.fn();
        const u1 = subscribeCallMedia(CALL, onCall);
        const u2 = subscribeCallMedia(OTHER_CALL, onOther);
        setCallMedia(CALL, A, { camera: true, screen_share: false });
        setCallMedia(CALL, A, { camera: true, screen_share: false }); // no-op
        expect(onCall).toHaveBeenCalledTimes(1);
        expect(onOther).not.toHaveBeenCalled();
        u1(); u2();
    });

    it('returns a stable object between changes (useSyncExternalStore requirement)', () => {
        setCallMedia(CALL, A, { camera: true, screen_share: false });
        expect(getCallMedia(CALL, A)).toBe(getCallMedia(CALL, A));
        expect(getCallMedia(CALL, B)).toBe(getCallMedia(CALL, 'someone-else'));
    });
});

describe('callMediaPresence — seeds', () => {
    it('builds entries from the cross-server seed, including calls/channels with NO media (to clear them)', () => {
        const entries = callMediaEntriesFromSeed([
            {
                channels: [{ channel_id: VOICE, media: { [A]: { camera: true, screen_share: false } } }],
                huddles: [{ calls: [{ call_id: CALL, media: { [B]: { camera: false, screen_share: true } } }, { call_id: OTHER_CALL }] }],
            },
        ]);
        expect([...entries.keys()].sort()).toEqual([OTHER_CALL, CALL, voiceChannelMediaKey(VOICE)].sort());
    });

    it('a full seed (replaceAll) replaces everything, dropping calls it no longer lists', () => {
        setCallMedia(OTHER_CALL, A, { camera: true, screen_share: true }); // ended since
        setCallMedia(CALL, A, { camera: true, screen_share: false });      // turned off since
        applyCallMediaSeed(callMediaEntriesFromSeed([
            { huddles: [{ calls: [{ call_id: CALL, media: { [B]: { camera: true, screen_share: false } } }] }] },
        ]), { replaceAll: true });
        expect(getCallMedia(OTHER_CALL, A)).toEqual(OFF);
        expect(getCallMedia(CALL, A)).toEqual(OFF);
        expect(getCallMedia(CALL, B)).toEqual({ camera: true, screen_share: false });
    });

    it('a partial seed (one Calls channel\'s list) only touches the calls it covers', () => {
        setCallMedia(OTHER_CALL, A, { camera: true, screen_share: false });
        applyCallMediaSeed(callMediaEntriesFromCalls([{ call_id: CALL, media: { [B]: { camera: false, screen_share: true } } }]));
        expect(getCallMedia(OTHER_CALL, A)).toEqual({ camera: true, screen_share: false });
        expect(getCallMedia(CALL, B)).toEqual({ camera: false, screen_share: true });
    });

    it('an older API with no `media` field anywhere just means "nothing on"', () => {
        applyCallMediaSeed(callMediaEntriesFromSeed([
            { channels: [{ channel_id: VOICE }], huddles: [{ calls: [{ call_id: CALL }] }] },
        ]), { replaceAll: true });
        expect(getCallMedia(CALL, A)).toEqual(OFF);
        expect(getCallMedia(voiceChannelMediaKey(VOICE), A)).toEqual(OFF);
    });

    it('drops garbage inside a seed map without throwing', () => {
        applyCallMediaSeed(new Map<string, unknown>([[CALL, { [A]: 'cs', [B]: { camera: true, screen_share: 'yes' } }]]));
        expect(getCallMedia(CALL, A)).toEqual(OFF);
        expect(getCallMedia(CALL, B)).toEqual({ camera: true, screen_share: false });
    });
});

describe('summarizeCallMedia', () => {
    it('only counts listed participants (a stale flag for someone who left is not shown)', () => {
        setCallMedia(CALL, A, { camera: true, screen_share: true });
        setCallMedia(CALL, 'left-already', { camera: true, screen_share: false });
        expect(summarizeCallMedia(CALL, [A, B])).toEqual({ camera: [A], screen_share: [A] });
    });
});

describe('resolveParticipantMedia — in-call and out-of-call agree on one rule', () => {
    const presence = { camera: true, screen_share: false };
    it('in the call: live LiveKit state wins (presence ignored)', () => {
        expect(resolveParticipantMedia(true, { hasCamera: false, hasScreenShare: true }, presence))
            .toEqual({ hasCamera: false, hasScreenShare: true });
        expect(resolveParticipantMedia(true, undefined, presence)).toEqual({ hasCamera: false, hasScreenShare: false });
    });
    it('not in the call: server presence', () => {
        expect(resolveParticipantMedia(false, { hasCamera: false, hasScreenShare: true }, presence))
            .toEqual({ hasCamera: true, hasScreenShare: false });
    });
});
