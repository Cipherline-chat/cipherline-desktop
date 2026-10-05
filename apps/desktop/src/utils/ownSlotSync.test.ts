import { describe, it, expect } from 'vitest';
import {
    frameOwnSlot,
    parseOwnSlotFrame,
    envelopeRecipientIds,
    isSafeSyncId,
    isOwnSender,
    republishReason,
    bytesToBase64,
    base64ToBytes,
    OWN_SLOT_CONTAINER_VERSION,
    type SlotView,
} from './ownSlotSync';

const te = new TextEncoder();
const body = new Uint8Array(40).fill(7); // iv(12) + >= tag(16)

describe('own-slot framing', () => {
    it('round-trips header and body under its magic', () => {
        const bytes = frameOwnSlot('CLSAV1', { v: OWN_SLOT_CONTAINER_VERSION, key_envelope_b64: 'ENV' }, body);
        const { header, body: b } = parseOwnSlotFrame('CLSAV1', bytes);
        expect(header).toEqual({ v: 1, key_envelope_b64: 'ENV' });
        expect([...b]).toEqual([...body]);
    });

    it('lays bytes out as magic ‖ u32be headerLen ‖ header ‖ body (the wire format mobile must match)', () => {
        const bytes = frameOwnSlot('CLSAV1', { v: 1, key_envelope_b64: 'E' }, body);
        const header = JSON.stringify({ v: 1, key_envelope_b64: 'E' });
        expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe('CLSAV1');
        expect(new DataView(bytes.buffer).getUint32(6, false)).toBe(header.length);
        expect(new TextDecoder().decode(bytes.subarray(10, 10 + header.length))).toBe(header);
    });

    it('refuses another slot\'s magic — a GIF snapshot is never read as saves', () => {
        const bytes = frameOwnSlot('CLGIF1', { v: 1, key_envelope_b64: 'E' }, body);
        expect(() => parseOwnSlotFrame('CLSAV1', bytes)).toThrow(/Not a CLSAV1/);
    });

    it('fails cleanly on truncation and junk', () => {
        const good = frameOwnSlot('CLSAV1', { v: 1, key_envelope_b64: 'E' }, body);
        expect(() => parseOwnSlotFrame('CLSAV1', good.subarray(0, 8))).toThrow(/truncated/);
        expect(() => parseOwnSlotFrame('CLSAV1', good.subarray(0, 20))).toThrow(/truncated/);
        expect(() => parseOwnSlotFrame('CLSAV1', frameOwnSlot('CLSAV1', { v: 1, key_envelope_b64: 'E' }, new Uint8Array(5))))
            .toThrow(/body too short/);
        const badJson = new Uint8Array([...te.encode('CLSAV1'), 0, 0, 0, 2, 0x7b, 0x7b, ...body]);
        expect(() => parseOwnSlotFrame('CLSAV1', badJson)).toThrow(/not valid JSON/);
    });

    it('refuses an unknown container version or a missing key envelope', () => {
        expect(() => parseOwnSlotFrame('CLSAV1', frameOwnSlot('CLSAV1', { v: 2, key_envelope_b64: 'E' }, body)))
            .toThrow(/version 2/);
        expect(() => parseOwnSlotFrame('CLSAV1', frameOwnSlot('CLSAV1', { v: 1, key_envelope_b64: '' }, body)))
            .toThrow(/key envelope/);
    });
});

describe('envelopeRecipientIds', () => {
    const env = (o: unknown) => bytesToBase64(te.encode(JSON.stringify(o)));

    it('reads the addressed device ids of a v3 envelope, sorted, without decrypting', () => {
        expect(envelopeRecipientIds(env({ v: 3, recipients: { b: {}, a: {} } }))).toEqual(['a', 'b']);
    });

    it('is null (unknown), never [] (nobody), for anything that is not an envelope', () => {
        expect(envelopeRecipientIds('WRAPPED:{"k":"x"}')).toBeNull();
        expect(envelopeRecipientIds(env({ v: 3 }))).toBeNull();
        expect(envelopeRecipientIds(env('str'))).toBeNull();
    });
});

describe('isSafeSyncId', () => {
    it('accepts the ids clients mint', () => {
        for (const id of ['0f8fad5b-d9cb-469f-a165-70867728950e', 'gif-lx2k9-ab12cd3', 'local-abc_123']) {
            expect(isSafeSyncId(id)).toBe(true);
        }
    });
    it('rejects anything that could escape a directory or is not a string', () => {
        for (const id of ['', '../x', 'a/b', 'a\\b', '.', 'a.enc', 'x'.repeat(129), 5, null, undefined, {}]) {
            expect(isSafeSyncId(id)).toBe(false);
        }
    });
});

describe('isOwnSender', () => {
    const ids = [
        { device_id: 'dA', identity_key_pub_b64: 'PUB_A' },
        { device_id: 'dB', identity_key_pub_b64: 'PUB_B' },
    ];

    it('accepts one of my devices with its own identity key', () => {
        expect(isOwnSender({ senderUserId: 'me', senderDeviceId: 'dB', senderPub: 'PUB_B' }, 'me', ids)).toBe(true);
    });
    it('rejects another account, even with a key that matches', () => {
        expect(isOwnSender({ senderUserId: 'them', senderDeviceId: 'dB', senderPub: 'PUB_B' }, 'me', ids)).toBe(false);
    });
    it('rejects my user id with a key none of my devices has (a planted snapshot)', () => {
        expect(isOwnSender({ senderUserId: 'me', senderDeviceId: 'dB', senderPub: 'EVIL' }, 'me', ids)).toBe(false);
    });
    it('rejects a real key claimed by the wrong device of mine', () => {
        expect(isOwnSender({ senderUserId: 'me', senderDeviceId: 'dA', senderPub: 'PUB_B' }, 'me', ids)).toBe(false);
    });
    it('accepts a sender that predates senderDeviceId when its key is one of mine', () => {
        expect(isOwnSender({ senderUserId: 'me', senderPub: 'PUB_A' }, 'me', ids)).toBe(true);
        expect(isOwnSender({ senderUserId: 'me', senderPub: 'NOPE' }, 'me', ids)).toBe(false);
    });
    it('rejects a missing key', () => {
        expect(isOwnSender({ senderUserId: 'me', senderDeviceId: 'dA' }, 'me', ids)).toBe(false);
    });
});

/**
 * Decision table for republishReason. S is a set of strings; merge = union.
 */
describe('republishReason', () => {
    type S = string[];
    const base = {
        isEmpty: (s: S) => s.length === 0,
        merge: (a: S, b: S) => [...new Set([...a, ...b])].sort(),
        same: (a: S, b: S) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()),
        myDeviceId: 'me',
    };
    const view = (state: S | null, recipients: string[] | null = ['d2'], publisher: string | null = 'd1'): SlotView<S> =>
        ({ updatedAt: 't', recipients, publisher, state });

    it('empty slot + something local → slot-empty; empty slot + nothing → none', () => {
        expect(republishReason({ ...base, view: null, local: ['x'], ownDeviceIds: null })).toBe('slot-empty');
        expect(republishReason({ ...base, view: null, local: [], ownDeviceIds: null })).toBe('none');
    });
    it('a slot this device could not read is never republished over', () => {
        expect(republishReason({ ...base, view: view(null), local: ['x'], ownDeviceIds: ['me', 'd1', 'd9'] })).toBe('none');
    });
    it('local knows something the slot lacks → slot-behind', () => {
        expect(republishReason({ ...base, view: view(['a']), local: ['a', 'b'], ownDeviceIds: null })).toBe('slot-behind');
    });
    it('the slot knowing MORE than local is not a reason (no ping-pong between incomplete devices)', () => {
        expect(republishReason({ ...base, view: view(['a', 'b']), local: ['a'], ownDeviceIds: ['me', 'd1', 'd2'] })).toBe('none');
    });
    it('a current device neither addressed nor the publisher → device-missing', () => {
        expect(republishReason({ ...base, view: view(['a']), local: ['a'], ownDeviceIds: ['me', 'd1', 'd2', 'd3'] })).toBe('device-missing');
    });
    it('me and the publisher count as covered even though neither is addressed', () => {
        expect(republishReason({ ...base, view: view(['a']), local: ['a'], ownDeviceIds: ['me', 'd1', 'd2'] })).toBe('none');
    });
    it('unknown device list or unknown recipients → no device-missing verdict', () => {
        expect(republishReason({ ...base, view: view(['a']), local: ['a'], ownDeviceIds: null })).toBe('none');
        expect(republishReason({ ...base, view: view(['a'], null), local: ['a'], ownDeviceIds: ['me', 'zz'] })).toBe('none');
    });
});

describe('base64 helpers', () => {
    it('round-trip large buffers (chunked encode)', () => {
        const big = new Uint8Array(200_000).map((_, i) => i & 0xff);
        expect([...base64ToBytes(bytesToBase64(big))]).toEqual([...big]);
    });
});
