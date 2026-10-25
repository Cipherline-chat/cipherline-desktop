import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    acceptGuestCallKey, buildGuestCallKeyContent, deliverGuestCallKey, guestCallServerInfo, movedRecently,
    noteGuestMove, onGuestMove, parseGuestCallKeyContent, pickCallsRoomKey, shouldServeGuestKeyRequest,
    _resetGuestMoves, GUEST_MOVE_SERVE_WINDOW_MS, type GuestKeyEvent,
} from './guestCallKey';
import { deriveVoiceChannelKeyFromB64 } from './voiceChannelKey';

const CALL = '44444444-4444-4444-4444-444444444444';
const OTHER_CALL = '66666666-6666-6666-6666-666666666666';
const CH = '55555555-5555-5555-5555-555555555555';
const OTHER_CH = '22222222-2222-2222-2222-222222222222';
const KEY = 'A'.repeat(43) + '=';
const MOD = 'mod-user', GUEST = 'guest-user';

beforeEach(() => _resetGuestMoves());

describe('guest room-key content', () => {
    const good = JSON.stringify(buildGuestCallKeyContent({ callId: CALL, channelId: CH, epoch: 3, keyB64: KEY }));

    it('round-trips for the call and channel it names', () => {
        expect(parseGuestCallKeyContent(good, { callId: CALL, channelId: CH })).toEqual({ callId: CALL, channelId: CH, epoch: 3, keyB64: KEY });
    });

    it('is refused for any other call or channel (cannot be replayed into another room)', () => {
        expect(parseGuestCallKeyContent(good, { callId: OTHER_CALL, channelId: CH })).toBeNull();
        expect(parseGuestCallKeyContent(good, { callId: CALL, channelId: OTHER_CH })).toBeNull();
    });

    it('refuses malformed content', () => {
        const exp = { callId: CALL, channelId: CH };
        expect(parseGuestCallKeyContent('not json', exp)).toBeNull();
        expect(parseGuestCallKeyContent(JSON.stringify({ ...JSON.parse(good), type: 'channel_key' }), exp)).toBeNull();
        expect(parseGuestCallKeyContent(JSON.stringify({ ...JSON.parse(good), key_b64: 'short' }), exp)).toBeNull();
        expect(parseGuestCallKeyContent(JSON.stringify({ ...JSON.parse(good), epoch: 0 }), exp)).toBeNull();
        expect(parseGuestCallKeyContent(JSON.stringify({ ...JSON.parse(good), epoch: 1.5 }), exp)).toBeNull();
    });
});

describe('pickCallsRoomKey', () => {
    const guest = { callId: CALL, channelId: CH, epoch: 2, keyB64: KEY };

    it("prefers the member's own derived key for this channel", () => {
        const own = { status: 'ready' as const, keyB64: 'own', epoch: 5, channelId: CH };
        expect(pickCallsRoomKey(own, guest, CALL, CH)).toBe(own);
    });

    it('uses the guest key when waiting, bound to this call AND channel', () => {
        expect(pickCallsRoomKey({ status: 'waiting' }, guest, CALL, CH)).toEqual({ status: 'ready', keyB64: KEY, epoch: 2, channelId: CH });
    });

    it('never applies a guest key to another call or channel (fails closed to waiting)', () => {
        expect(pickCallsRoomKey({ status: 'waiting' }, guest, OTHER_CALL, CH)).toEqual({ status: 'waiting' });
        expect(pickCallsRoomKey({ status: 'waiting' }, guest, CALL, OTHER_CH)).toEqual({ status: 'waiting' });
        expect(pickCallsRoomKey({ status: 'waiting' }, null, CALL, CH)).toEqual({ status: 'waiting' });
    });
});

describe('serving a guest key request', () => {
    it('only from inside that call, or as the moderator who just moved them', () => {
        const base = { callId: CALL, guestUserId: GUEST, selfUserId: MOD };
        expect(shouldServeGuestKeyRequest({ ...base, activeCallId: CALL })).toBe(true);
        expect(shouldServeGuestKeyRequest({ ...base, activeCallId: OTHER_CALL })).toBe(false);
        expect(shouldServeGuestKeyRequest({ ...base, activeCallId: null })).toBe(false);
        noteGuestMove({ callId: CALL, huddleId: CH, serverId: 's', guestUserId: GUEST }, 1_000);
        expect(shouldServeGuestKeyRequest({ ...base, activeCallId: null, now: 1_000 + 10_000 })).toBe(true);
        expect(shouldServeGuestKeyRequest({ ...base, activeCallId: null, now: 1_000 + GUEST_MOVE_SERVE_WINDOW_MS + 1 })).toBe(false);
        // never for another guest / another call, never for yourself
        expect(shouldServeGuestKeyRequest({ ...base, guestUserId: 'x', activeCallId: null, now: 2_000 })).toBe(false);
        expect(shouldServeGuestKeyRequest({ ...base, guestUserId: MOD, activeCallId: CALL })).toBe(false);
    });

    it('noteGuestMove tells the listener (the Dashboard delivers the key)', () => {
        const seen: string[] = [];
        const off = onGuestMove(m => seen.push(m.guestUserId));
        noteGuestMove({ callId: CALL, huddleId: CH, serverId: 's', guestUserId: GUEST });
        off();
        noteGuestMove({ callId: CALL, huddleId: CH, serverId: 's', guestUserId: 'later' });
        expect(seen).toEqual([GUEST]);
        expect(movedRecently(CALL, GUEST)).toBe(true);
    });
});

describe('deliverGuestCallKey (holder side)', () => {
    const SENDER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));

    it('hands over the DERIVED room key for the current epoch, never the Sender Key', async () => {
        const post = vi.fn(async () => ({}));
        let wrapped = '';
        const out = await deliverGuestCallKey({ callId: CALL, huddleId: CH, serverId: 's', guestUserId: GUEST }, {
            keySource: { getLatestChannelEpoch: async () => 4, getChannelKey: async () => SENDER_KEY },
            getMemberDevices: async () => [{ device_id: 'd1' }],
            encrypt: async (json) => { wrapped = json; return 'ENV'; },
            post,
        });
        expect(out).toBe('sent');
        expect(post).toHaveBeenCalledWith(CALL, { user_id: GUEST, envelope_b64: 'ENV' });
        const content = JSON.parse(wrapped);
        const derived = new Uint8Array(await deriveVoiceChannelKeyFromB64(SENDER_KEY, CH, 4));
        expect(content).toMatchObject({ type: 'call_guest_key', call_id: CALL, channel_id: CH, epoch: 4 });
        expect(content.key_b64).toBe(btoa(String.fromCharCode(...derived)));
        expect(content.key_b64).not.toBe(SENDER_KEY);
        expect(wrapped).not.toContain(SENDER_KEY);
    });

    it('sends nothing without a key or devices', async () => {
        const post = vi.fn();
        const ports = { getMemberDevices: async () => [{}], encrypt: async () => 'E', post };
        expect(await deliverGuestCallKey({ callId: CALL, huddleId: CH, serverId: 's', guestUserId: GUEST }, {
            ...ports, keySource: { getLatestChannelEpoch: async () => null, getChannelKey: async () => null },
        })).toBe('no-key');
        expect(await deliverGuestCallKey({ callId: CALL, huddleId: CH, serverId: 's', guestUserId: GUEST }, {
            ...ports, getMemberDevices: async () => [], keySource: { getLatestChannelEpoch: async () => 1, getChannelKey: async () => SENDER_KEY },
        })).toBe('no-devices');
        expect(post).not.toHaveBeenCalled();
    });
});

describe('acceptGuestCallKey (guest side)', () => {
    const content = JSON.stringify(buildGuestCallKeyContent({ callId: CALL, channelId: CH, epoch: 2, keyB64: KEY }));
    const ev: GuestKeyEvent = { call_id: CALL, huddle_id: CH, sender_user_id: MOD, envelope_b64: 'ENV' };
    const guestOf = { callId: CALL, channelId: CH };
    const ports = (over: Partial<{ sender: string; trust: boolean; json: string }> = {}) => ({
        decrypt: async () => ({ contentJson: over.json ?? content, senderUserId: over.sender ?? MOD }),
        trustSender: async () => over.trust ?? true,
    });

    it('accepts a trusted holder’s key for this call', async () => {
        expect(await acceptGuestCallKey(ev, guestOf, ports())).toMatchObject({ callId: CALL, keyB64: KEY });
    });

    it('refuses: not a guest, another call, sender mismatch, distrusted sender', async () => {
        expect(await acceptGuestCallKey(ev, null, ports())).toBeNull();
        expect(await acceptGuestCallKey({ ...ev, call_id: OTHER_CALL }, guestOf, ports())).toBeNull();
        expect(await acceptGuestCallKey(ev, guestOf, ports({ sender: 'impostor' }))).toBeNull();
        expect(await acceptGuestCallKey(ev, guestOf, ports({ trust: false }))).toBeNull();
        const relabelled = JSON.stringify(buildGuestCallKeyContent({ callId: OTHER_CALL, channelId: CH, epoch: 2, keyB64: KEY }));
        expect(await acceptGuestCallKey(ev, guestOf, ports({ json: relabelled }))).toBeNull();
    });
});

describe('call header for a call in a channel we cannot see', () => {
    it('names the server and the call, says "Private channel", never needs the channel row', () => {
        const info = guestCallServerInfo(
            { callId: CALL, huddleId: CH, serverId: 'srv', callName: 'Staff call' },
            [{ server_id: 'srv', name: 'My Server' }],
        );
        expect(info).toMatchObject({ serverId: 'srv', serverName: 'My Server', channelName: 'Staff call · Private channel', guest: true });
    });

    it('falls back sensibly with no call name / unknown server, and is null without a server id', () => {
        expect(guestCallServerInfo({ callId: CALL, huddleId: CH, serverId: 'srv', callName: '' }, [])).toMatchObject({ serverName: null, channelName: 'Private channel' });
        expect(guestCallServerInfo({ callId: CALL, huddleId: CH, serverId: null, callName: 'x' }, [])).toBeNull();
    });
});
