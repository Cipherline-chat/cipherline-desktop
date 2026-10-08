import { describe, it, expect } from 'vitest';
import {
    buildDescriptor,
    decideRejoinOffer,
    describeRejoinTarget,
    isDescriptorFresh,
    parseDescriptor,
    DESCRIPTOR_VERSION,
    MAX_DESCRIPTOR_AGE_MS,
    MAX_CLOCK_SKEW_MS,
    STATUS_GRACE_MS,
    type ActiveCallSnapshot,
    type CallRejoinDescriptor,
} from './callRejoinPolicy';

const NOW = 1_700_000_000_000;

const dm: CallRejoinDescriptor = {
    v: DESCRIPTOR_VERSION, kind: 'dm', sessionId: 's1', conversationId: 'c1',
    title: 'Sam', callKeyB64: 'a2V5', startedAt: NOW - 60_000, lastSeen: NOW - 5_000,
};
const voice: CallRejoinDescriptor = {
    v: DESCRIPTOR_VERSION, kind: 'voice', sessionId: 's2', channelId: 'ch1',
    title: 'General', startedAt: NOW - 60_000, lastSeen: NOW - 5_000,
};
const huddle: CallRejoinDescriptor = { ...voice, kind: 'huddle', sessionId: 's3' };

describe('parseDescriptor', () => {
    it('round-trips each valid kind', () => {
        for (const d of [dm, voice, huddle]) expect(parseDescriptor(JSON.stringify(d))).toEqual(d);
    });

    it('returns null for empty / non-JSON / non-object input instead of throwing', () => {
        expect(parseDescriptor(null)).toBeNull();
        expect(parseDescriptor(undefined)).toBeNull();
        expect(parseDescriptor('')).toBeNull();
        expect(parseDescriptor('{not json')).toBeNull();
        expect(parseDescriptor('"a string"')).toBeNull();
        expect(parseDescriptor('[1,2]')).toBeNull();
        expect(parseDescriptor('null')).toBeNull();
    });

    it('rejects a different version', () => {
        expect(parseDescriptor(JSON.stringify({ ...dm, v: 2 }))).toBeNull();
        expect(parseDescriptor(JSON.stringify({ ...dm, v: undefined }))).toBeNull();
    });

    it('rejects an unknown kind, a missing/oversized session id, and non-finite times', () => {
        expect(parseDescriptor(JSON.stringify({ ...dm, kind: 'phone' }))).toBeNull();
        expect(parseDescriptor(JSON.stringify({ ...dm, sessionId: '' }))).toBeNull();
        expect(parseDescriptor(JSON.stringify({ ...dm, sessionId: 'x'.repeat(129) }))).toBeNull();
        expect(parseDescriptor(JSON.stringify({ ...dm, lastSeen: 'yesterday' }))).toBeNull();
        expect(parseDescriptor(JSON.stringify({ ...dm, startedAt: null }))).toBeNull();
    });

    it('a DM/group record without its key or conversation is unusable and rejected', () => {
        expect(parseDescriptor(JSON.stringify({ ...dm, callKeyB64: undefined }))).toBeNull();
        expect(parseDescriptor(JSON.stringify({ ...dm, callKeyB64: '' }))).toBeNull();
        expect(parseDescriptor(JSON.stringify({ ...dm, conversationId: undefined }))).toBeNull();
    });

    it('a Calls-channel record must NEVER carry a key — one present means it did not come from us', () => {
        expect(parseDescriptor(JSON.stringify({ ...voice, callKeyB64: 'a2V5' }))).toBeNull();
        expect(parseDescriptor(JSON.stringify({ ...huddle, callKeyB64: 'a2V5' }))).toBeNull();
    });

    it('a voice/huddle record without a channel is rejected', () => {
        expect(parseDescriptor(JSON.stringify({ ...voice, channelId: undefined }))).toBeNull();
    });

    it('drops unknown fields and clamps an oversized title', () => {
        const parsed = parseDescriptor(JSON.stringify({ ...voice, livekit_token: 'SECRET', extra: 1, title: 'T'.repeat(500) }));
        expect(parsed).not.toBeNull();
        expect(parsed).not.toHaveProperty('livekit_token');
        expect(parsed).not.toHaveProperty('extra');
        expect(parsed!.title.length).toBe(120);
    });

    it('tolerates a missing title (empty string) rather than rejecting the record', () => {
        const noTitle: Record<string, unknown> = { ...voice };
        delete noTitle.title;
        expect(parseDescriptor(JSON.stringify(noTitle))!.title).toBe('');
    });
});

describe('isDescriptorFresh', () => {
    it('fresh within the max age, stale beyond it (boundary inclusive)', () => {
        expect(isDescriptorFresh({ ...dm, lastSeen: NOW - 1 }, NOW)).toBe(true);
        expect(isDescriptorFresh({ ...dm, lastSeen: NOW - MAX_DESCRIPTOR_AGE_MS }, NOW)).toBe(true);
        expect(isDescriptorFresh({ ...dm, lastSeen: NOW - MAX_DESCRIPTOR_AGE_MS - 1 }, NOW)).toBe(false);
    });

    it('tolerates a small backwards clock step but not a far-future timestamp', () => {
        expect(isDescriptorFresh({ ...dm, lastSeen: NOW + 5_000 }, NOW)).toBe(true);
        expect(isDescriptorFresh({ ...dm, lastSeen: NOW + MAX_CLOCK_SKEW_MS }, NOW)).toBe(true);
        expect(isDescriptorFresh({ ...dm, lastSeen: NOW + MAX_CLOCK_SKEW_MS + 1 }, NOW)).toBe(false);
    });
});

describe('buildDescriptor', () => {
    const base = (over: Partial<ActiveCallSnapshot> = {}, call: Partial<ActiveCallSnapshot['call']> = {}): ActiveCallSnapshot => ({
        call: { id: 'sess', ...call },
        activeVoiceChannelId: null,
        activeHuddleCallId: null,
        deliveredCallKeyB64: '',
        conversationTitle: '',
        ...over,
    });

    it('DM/group: persists with the delivered key and conversation', () => {
        const d = buildDescriptor(base({ deliveredCallKeyB64: 'a2V5', conversationTitle: 'Sam' }, { conversation_id: 'c1' }), NOW, null);
        expect(d).toEqual({ v: 1, kind: 'dm', sessionId: 'sess', conversationId: 'c1', title: 'Sam', callKeyB64: 'a2V5', startedAt: NOW, lastSeen: NOW });
    });

    it('DM/group: does NOT persist while the key has not arrived yet', () => {
        expect(buildDescriptor(base({ deliveredCallKeyB64: '' }, { conversation_id: 'c1' }), NOW, null)).toBeNull();
    });

    it('DM/group: needs a conversation id', () => {
        expect(buildDescriptor(base({ deliveredCallKeyB64: 'a2V5' }), NOW, null)).toBeNull();
    });

    it('voice channel: keyed by channel, never carries a key even if one is passed', () => {
        const d = buildDescriptor(
            base({ activeVoiceChannelId: 'ch1', deliveredCallKeyB64: 'a2V5' }, { callsChannelId: 'ch1', voiceChannelName: 'General' }),
            NOW, null,
        );
        expect(d).toMatchObject({ kind: 'voice', channelId: 'ch1', title: 'General' });
        expect(d).not.toHaveProperty('callKeyB64');
    });

    it('huddle: identified by the huddle call id', () => {
        const d = buildDescriptor(
            base({ activeHuddleCallId: 'sess' }, { callsChannelId: 'hud1', voiceChannelName: 'Standup' }),
            NOW, null,
        );
        expect(d).toMatchObject({ kind: 'huddle', sessionId: 'sess', channelId: 'hud1', title: 'Standup' });
        expect(d).not.toHaveProperty('callKeyB64');
    });

    it('a Calls-channel call whose kind cannot be established is not persisted', () => {
        expect(buildDescriptor(base({}, { callsChannelId: 'ch1' }), NOW, null)).toBeNull();
        // Voice id pointing at a DIFFERENT channel than the call's is not a match either.
        expect(buildDescriptor(base({ activeVoiceChannelId: 'other' }, { callsChannelId: 'ch1' }), NOW, null)).toBeNull();
    });

    it('keeps startedAt across heartbeats of the same call, resets it for a different call', () => {
        const first = buildDescriptor(base({ activeVoiceChannelId: 'ch1' }, { callsChannelId: 'ch1' }), NOW, null)!;
        const beat = buildDescriptor(base({ activeVoiceChannelId: 'ch1' }, { callsChannelId: 'ch1' }), NOW + 30_000, first)!;
        expect(beat.startedAt).toBe(NOW);
        expect(beat.lastSeen).toBe(NOW + 30_000);
        const next = buildDescriptor(base({ activeVoiceChannelId: 'ch1' }, { id: 'sess2', callsChannelId: 'ch1' }), NOW + 60_000, first)!;
        expect(next.startedAt).toBe(NOW + 60_000);
    });

    it('everything it builds survives its own parser (writer and reader cannot drift)', () => {
        const built = [
            buildDescriptor(base({ deliveredCallKeyB64: 'a2V5', conversationTitle: 'Sam' }, { conversation_id: 'c1' }), NOW, null),
            buildDescriptor(base({ activeVoiceChannelId: 'ch1' }, { callsChannelId: 'ch1', voiceChannelName: 'General' }), NOW, null),
            buildDescriptor(base({ activeHuddleCallId: 'sess' }, { callsChannelId: 'hud1', voiceChannelName: 'Standup' }), NOW, null),
        ];
        for (const d of built) {
            expect(d).not.toBeNull();
            expect(parseDescriptor(JSON.stringify(d))).toEqual(d);
        }
    });
});

describe('decideRejoinOffer', () => {
    it('offers on an explicit active answer, discards on an explicit inactive one', () => {
        expect(decideRejoinOffer({ active: true }, 0)).toBe('offer');
        expect(decideRejoinOffer({ active: false }, 0)).toBe('discard');
    });

    it('an explicit answer decides even long after the grace window', () => {
        expect(decideRejoinOffer({ active: true }, STATUS_GRACE_MS * 10)).toBe('offer');
    });

    it('a failed check retries inside the grace window and discards (never offers) after it', () => {
        expect(decideRejoinOffer(null, 0)).toBe('retry');
        expect(decideRejoinOffer(null, STATUS_GRACE_MS - 1)).toBe('retry');
        expect(decideRejoinOffer(null, STATUS_GRACE_MS)).toBe('discard');
    });

    it('honours a custom grace window', () => {
        expect(decideRejoinOffer(null, 5_000, 4_000)).toBe('discard');
        expect(decideRejoinOffer(null, 3_000, 4_000)).toBe('retry');
    });
});

describe('describeRejoinTarget', () => {
    it('reads naturally per kind, with and without a title', () => {
        expect(describeRejoinTarget({ kind: 'dm', title: 'Sam' })).toBe('a call with Sam');
        expect(describeRejoinTarget({ kind: 'dm', title: '  ' })).toBe('a call');
        expect(describeRejoinTarget({ kind: 'voice', title: 'General' })).toBe('the voice channel General');
        expect(describeRejoinTarget({ kind: 'voice', title: '' })).toBe('a voice channel');
        expect(describeRejoinTarget({ kind: 'huddle', title: 'Standup' })).toBe('the call in Standup');
        expect(describeRejoinTarget({ kind: 'huddle', title: '' })).toBe('a call');
    });
});
