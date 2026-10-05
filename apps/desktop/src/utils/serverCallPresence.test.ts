import { describe, it, expect } from 'vitest';
import {
    deriveServerCallPresence,
    summarizeCallRoster,
    mergeVoiceUserName,
    mergeVoiceUserAvatarId,
    labelVoiceUsers,
    UNKNOWN_CALL_PARTICIPANT,
} from './serverCallPresence';

/** channel_id -> server_id, the shape Dashboard's `channelToServerId` has.
 *  `*-calls` entries are `kind='huddle'` Calls channels — in this product those
 *  are the ONLY kind a new server gets, so they carry most of the coverage. */
const CHANNELS: Record<string, string> = {
    'a-general': 'server-a',
    'a-gaming': 'server-a',
    'b-lounge': 'server-b',
    'a-calls': 'server-a',
    'b-calls': 'server-b',
};

/** One call under a Calls channel, as `huddleCalls[huddleId]` holds it. */
const call = (...participants: string[]) => ({ participants });

describe('deriveServerCallPresence', () => {
    it('groups occupied voice channels by server', () => {
        const out = deriveServerCallPresence(
            { 'a-general': ['u1', 'u2'], 'b-lounge': ['u3'] },
            CHANNELS,
        );

        expect(out.get('server-a')).toEqual({
            serverId: 'server-a', channelIds: ['a-general'], userIds: ['u1', 'u2'],
        });
        expect(out.get('server-b')).toEqual({
            serverId: 'server-b', channelIds: ['b-lounge'], userIds: ['u3'],
        });
    });

    it('merges multiple occupied channels of one server into a single entry', () => {
        const out = deriveServerCallPresence(
            { 'a-general': ['u1'], 'a-gaming': ['u2'] },
            CHANNELS,
        );

        expect(out.size).toBe(1);
        expect(out.get('server-a')!.channelIds.sort()).toEqual(['a-gaming', 'a-general']);
        expect(out.get('server-a')!.userIds.sort()).toEqual(['u1', 'u2']);
    });

    it('de-duplicates a user seen in two channels mid-hop', () => {
        // A channel hop briefly leaves the old entry in place; the badge must
        // not count that person twice.
        const out = deriveServerCallPresence(
            { 'a-general': ['u1'], 'a-gaming': ['u1', 'u2'] },
            CHANNELS,
        );

        expect(out.get('server-a')!.userIds).toEqual(['u1', 'u2']);
    });

    it('ignores channels whose participant list is empty', () => {
        // A leave event empties the array rather than deleting the key.
        const out = deriveServerCallPresence({ 'a-general': [], 'b-lounge': [] }, CHANNELS);

        expect(out.size).toBe(0);
    });

    // ── The security-relevant cases ───────────────────────────────────────────

    it('produces NO badge for a server whose only call is in a channel the user cannot see', () => {
        // This is the end-to-end property, observed at the client's edge: the
        // server never sent server-b's private channel — not in the seed (it
        // omits the whole server) and not as a voice_state event (the fan-out
        // is VIEW_CHANNEL-filtered). So `voiceParticipants` simply has no
        // b-lounge key, and server-b must be absent from the map entirely, not
        // present with an empty roster.
        const out = deriveServerCallPresence({ 'a-general': ['u1'] }, CHANNELS);

        expect(out.has('server-b')).toBe(false);
        expect([...out.keys()]).toEqual(['server-a']);
    });

    it('positive control: the same shape DOES badge server-b once the channel is visible', () => {
        // Without this, the assertion above would also pass if the function
        // simply never returned anything for server-b.
        const out = deriveServerCallPresence(
            { 'a-general': ['u1'], 'b-lounge': ['u9'] },
            CHANNELS,
        );

        expect(out.has('server-b')).toBe(true);
        expect(out.get('server-b')!.userIds).toEqual(['u9']);
    });

    it('fails closed on a channel it cannot attribute to a server', () => {
        // Belt-and-braces for the ordering window where a voice_state event for
        // a brand-new channel arrives before that server's channel list has
        // loaded: no guessing, no unattributed badge.
        const out = deriveServerCallPresence({ 'unknown-channel': ['u1'] }, CHANNELS);

        expect(out.size).toBe(0);
    });

    it('returns an empty map when nothing is happening', () => {
        expect(deriveServerCallPresence({}, CHANNELS).size).toBe(0);
        expect(deriveServerCallPresence({ 'a-general': ['u1'] }, {}).size).toBe(0);
    });
});

// ── Calls channels (kind='huddle') ───────────────────────────────────────────
// The regression these cover: the rail badge derived from `voiceParticipants`
// alone, which is permanently empty because `createServer` seeds a huddle and
// never a voice channel. Nobody ever saw a badge.

describe('deriveServerCallPresence — Calls (huddle) channels', () => {
    it('badges a server whose only live call is a huddle call', () => {
        const out = deriveServerCallPresence({}, CHANNELS, { 'a-calls': [call('u1', 'u2')] });

        expect(out.get('server-a')).toEqual({
            serverId: 'server-a', channelIds: ['a-calls'], userIds: ['u1', 'u2'],
        });
    });

    it('flattens sibling calls under one Calls channel into a single channel entry', () => {
        // Two people in two separate calls under the same Calls channel is one
        // badged channel and two people — not two channel entries.
        const out = deriveServerCallPresence({}, CHANNELS, {
            'a-calls': [call('u1'), call('u2')],
        });

        expect(out.get('server-a')!.channelIds).toEqual(['a-calls']);
        expect(out.get('server-a')!.userIds).toEqual(['u1', 'u2']);
    });

    it('de-duplicates a user appearing in two sibling calls mid-move', () => {
        const out = deriveServerCallPresence({}, CHANNELS, {
            'a-calls': [call('u1'), call('u1', 'u2')],
        });

        expect(out.get('server-a')!.userIds).toEqual(['u1', 'u2']);
    });

    it('ignores a Calls channel whose calls are all empty', () => {
        // A call row briefly outlives its last participant. An empty call is
        // not presence and must not badge the rail.
        const out = deriveServerCallPresence({}, CHANNELS, { 'a-calls': [call()] });

        expect(out.size).toBe(0);
    });

    it('ignores a Calls channel with no calls at all', () => {
        expect(deriveServerCallPresence({}, CHANNELS, { 'a-calls': [] }).size).toBe(0);
    });

    it('merges voice and huddle activity of one server into a single entry', () => {
        const out = deriveServerCallPresence(
            { 'a-general': ['u1'] },
            CHANNELS,
            { 'a-calls': [call('u2')] },
        );

        expect(out.size).toBe(1);
        expect(out.get('server-a')!.channelIds).toEqual(['a-general', 'a-calls']);
        expect(out.get('server-a')!.userIds).toEqual(['u1', 'u2']);
    });

    it('de-duplicates a user counted in both a voice channel and a huddle call', () => {
        const out = deriveServerCallPresence(
            { 'a-general': ['u1'] },
            CHANNELS,
            { 'a-calls': [call('u1')] },
        );

        expect(out.get('server-a')!.userIds).toEqual(['u1']);
    });

    it('produces NO badge for a Calls channel the user cannot see', () => {
        // Server-side VIEW_CHANNEL filtering means b-calls never reaches the
        // client at all, so server-b must be absent — not present and empty.
        const out = deriveServerCallPresence({}, CHANNELS, { 'a-calls': [call('u1')] });

        expect(out.has('server-b')).toBe(false);
        expect([...out.keys()]).toEqual(['server-a']);
    });

    it('positive control: the same shape DOES badge server-b once b-calls is visible', () => {
        const out = deriveServerCallPresence({}, CHANNELS, {
            'a-calls': [call('u1')],
            'b-calls': [call('u9')],
        });

        expect(out.has('server-b')).toBe(true);
        expect(out.get('server-b')!.userIds).toEqual(['u9']);
    });

    it('fails closed on a huddle it cannot attribute to a server', () => {
        const out = deriveServerCallPresence({}, CHANNELS, { 'unknown-huddle': [call('u1')] });

        expect(out.size).toBe(0);
    });

    it('defaults huddleCalls to empty, preserving the voice-only call shape', () => {
        // Two-argument callers must keep working unchanged.
        expect(deriveServerCallPresence({ 'a-general': ['u1'] }, CHANNELS).size).toBe(1);
        expect(deriveServerCallPresence({}, CHANNELS).size).toBe(0);
    });
});

describe('summarizeCallRoster', () => {
    it('shows everything when the roster fits', () => {
        expect(summarizeCallRoster(['a', 'b', 'c'], 5)).toEqual({ shown: ['a', 'b', 'c'], overflow: 0 });
    });

    it('shows exactly max with no overflow at the boundary', () => {
        expect(summarizeCallRoster(['a', 'b', 'c'], 3)).toEqual({ shown: ['a', 'b', 'c'], overflow: 0 });
    });

    it('never trades a name for a "+1 more" line', () => {
        // 4 entries capped at 3 → 2 names + "+2 more", not 3 names + "+1 more"
        // occupying a 4th line (which would be strictly worse than just showing
        // all four).
        expect(summarizeCallRoster(['a', 'b', 'c', 'd'], 3)).toEqual({ shown: ['a', 'b'], overflow: 2 });
    });

    it('overflows everything when max is zero or negative', () => {
        expect(summarizeCallRoster(['a', 'b'], 0)).toEqual({ shown: [], overflow: 2 });
        expect(summarizeCallRoster(['a', 'b'], -1)).toEqual({ shown: [], overflow: 2 });
    });

    it('handles an empty roster', () => {
        expect(summarizeCallRoster([], 5)).toEqual({ shown: [], overflow: 0 });
    });
});

/**
 * The "Someone" bug.
 *
 * `voiceUserNames` was populated by exactly ONE thing — the batched
 * `GET /v1/voice-participants` seed, which runs at boot and on reconnect.
 * Participant ids kept arriving live over `channel:voice_state` /
 * `huddle:participant`, and neither event carried a name, so anyone who joined
 * a call SINCE your last seed rendered as "Someone" in the rail's hover roster
 * until the next seed. Both events now carry `display_name`, and
 * `mergeVoiceUserName` is what folds it in as the id arrives.
 */
describe('mergeVoiceUserName — learning names from live join events', () => {
    it('adds a name the seed never covered (the bug)', () => {
        const seeded = { 'u-1': 'Alice' };
        const next = mergeVoiceUserName(seeded, 'u-2', 'Bob');
        expect(next).toEqual({ 'u-1': 'Alice', 'u-2': 'Bob' });
    });

    it('does not mutate the previous map', () => {
        const seeded = { 'u-1': 'Alice' };
        mergeVoiceUserName(seeded, 'u-2', 'Bob');
        expect(seeded).toEqual({ 'u-1': 'Alice' });
    });

    it('keeps the SAME reference when an older API sends no name', () => {
        // The backward-compatible path: the client is new, the API is not.
        // It must degrade to today's seed-only behaviour — no entry written,
        // and no needless re-render.
        const seeded = { 'u-1': 'Alice' };
        expect(mergeVoiceUserName(seeded, 'u-2', undefined)).toBe(seeded);
        expect(mergeVoiceUserName(seeded, 'u-2', '')).toBe(seeded);
    });

    it('keeps the SAME reference when the name is already known', () => {
        const seeded = { 'u-1': 'Alice' };
        expect(mergeVoiceUserName(seeded, 'u-1', 'Alice')).toBe(seeded);
    });

    it('lets a newer name win — a nickname changed since the boot seed', () => {
        const seeded = { 'u-1': 'Alice' };
        expect(mergeVoiceUserName(seeded, 'u-1', 'Ali')).toEqual({ 'u-1': 'Ali' });
    });

    it('ignores an empty user id', () => {
        const seeded = { 'u-1': 'Alice' };
        expect(mergeVoiceUserName(seeded, '', 'Bob')).toBe(seeded);
    });
});

/**
 * Home's "Happening now" deck rendered the colour placeholder for every
 * participant of a call in a server the user had not opened this session.
 * That was never a caching miss: `serverMemberAvatarMaps` is filled by
 * `ServerContextPanel` when its panel mounts, so for an unopened server the
 * client held NO avatar attachment id for those people at all and the avatar
 * pipeline was handed `null`. The seed and both JOIN events now carry
 * `avatar_url`; this is what folds it in.
 */
describe('mergeVoiceUserAvatarId — learning avatars from live join events', () => {
    it('adds an avatar id the seed never covered (the bug)', () => {
        expect(mergeVoiceUserAvatarId({ 'u-1': 'att-1' }, 'u-2', 'att-2'))
            .toEqual({ 'u-1': 'att-1', 'u-2': 'att-2' });
    });

    it('does not mutate the previous map', () => {
        const seeded = { 'u-1': 'att-1' };
        mergeVoiceUserAvatarId(seeded, 'u-2', 'att-2');
        expect(seeded).toEqual({ 'u-1': 'att-1' });
    });

    it('keeps the SAME reference when an older API sends no avatar', () => {
        // The desktop app and the API roll separately. An API that predates the
        // field must degrade to the placeholder, never write a non-string into
        // the map — that value would reach useEncryptedAvatar as an attachment
        // id and cost two requests for a guaranteed 404.
        const seeded = { 'u-1': 'att-1' };
        expect(mergeVoiceUserAvatarId(seeded, 'u-2', undefined)).toBe(seeded);
        expect(mergeVoiceUserAvatarId(seeded, 'u-2', '')).toBe(seeded);
    });

    it('keeps the SAME reference when the avatar is already known', () => {
        const seeded = { 'u-1': 'att-1' };
        expect(mergeVoiceUserAvatarId(seeded, 'u-1', 'att-1')).toBe(seeded);
    });

    it('lets a newer attachment win — the user changed their picture', () => {
        expect(mergeVoiceUserAvatarId({ 'u-1': 'att-old' }, 'u-1', 'att-new'))
            .toEqual({ 'u-1': 'att-new' });
    });

    it('ignores an empty user id', () => {
        const seeded = { 'u-1': 'att-1' };
        expect(mergeVoiceUserAvatarId(seeded, '', 'att-2')).toBe(seeded);
    });
});

describe('labelVoiceUsers — what the rail hover roster renders', () => {
    it('renders real names for everyone known', () => {
        expect(labelVoiceUsers(['u-1', 'u-2'], { 'u-1': 'Alice', 'u-2': 'Bob' }))
            .toEqual(['Alice', 'Bob']);
    });

    it('falls back to the neutral label for a genuinely unknown id', () => {
        expect(labelVoiceUsers(['u-1', 'u-9'], { 'u-1': 'Alice' }))
            .toEqual(['Alice', UNKNOWN_CALL_PARTICIPANT]);
        expect(UNKNOWN_CALL_PARTICIPANT).toBe('Someone');
    });

    it('tolerates an absent map (HomePanel passes voiceUserNames optionally)', () => {
        expect(labelVoiceUsers(['u-1'], undefined)).toEqual([UNKNOWN_CALL_PARTICIPANT]);
    });

    it('never renders a raw user id', () => {
        expect(labelVoiceUsers(['u-9'], {})).not.toContain('u-9');
    });
});

describe('end to end: seed then a live join, as the rail composes it', () => {
    /** Exactly the expression Dashboard uses for the rail tooltip. */
    const rosterNames = (uids: string[], names: Record<string, string>) =>
        labelVoiceUsers(summarizeCallRoster(uids, 5).shown, names);

    it('a person who joined after the seed shows their real name, not "Someone"', () => {
        // Boot seed covered Alice only.
        let names: Record<string, string> = { 'u-1': 'Alice' };
        // Bob joins the server's Calls channel; the live event carries his name.
        names = mergeVoiceUserName(names, 'u-2', 'Bob');

        const presence = deriveServerCallPresence(
            {}, CHANNELS, { 'a-calls': [call('u-1', 'u-2')] },
        );
        const srv = presence.get('server-a')!;

        expect(rosterNames(srv.userIds, names)).toEqual(['Alice', 'Bob']);
        expect(rosterNames(srv.userIds, names)).not.toContain(UNKNOWN_CALL_PARTICIPANT);
    });

    it('against an OLDER API the same join still degrades to "Someone" — no crash, no undefined', () => {
        let names: Record<string, string> = { 'u-1': 'Alice' };
        names = mergeVoiceUserName(names, 'u-2', undefined); // no display_name on the wire

        const presence = deriveServerCallPresence(
            {}, CHANNELS, { 'a-calls': [call('u-1', 'u-2')] },
        );
        const srv = presence.get('server-a')!;

        expect(rosterNames(srv.userIds, names)).toEqual(['Alice', UNKNOWN_CALL_PARTICIPANT]);
    });

    it('works on the voice-channel path too', () => {
        let names: Record<string, string> = {};
        names = mergeVoiceUserName(names, 'u-1', 'Alice');
        names = mergeVoiceUserName(names, 'u-2', 'Bob');

        const presence = deriveServerCallPresence({ 'a-general': ['u-1', 'u-2'] }, CHANNELS, {});
        const srv = presence.get('server-a')!;

        expect(rosterNames(srv.userIds, names)).toEqual(['Alice', 'Bob']);
    });
});
