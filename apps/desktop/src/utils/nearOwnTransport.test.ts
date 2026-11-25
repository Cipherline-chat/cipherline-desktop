import { describe, it, expect, vi } from 'vitest';
import { createOwnControlSender, deliverOwnNearControl, isNearOwnControl, type OwnSendDeps } from './nearOwnTransport';

const OFFER = { type: 'near_offer', v: 1, e_pub: 'A'.repeat(43), nonce: 'B'.repeat(22), ts: 1, to: 'dev-H' };

describe('incoming own-device control messages', () => {
    const base = { content: OFFER, userId: 'u1', deviceId: 'dev-H', senderUserId: 'u1', senderDeviceId: 'dev-N' };
    it('recognises exactly the three types', () => {
        for (const t of ['near_offer', 'near_answer', 'near_msg']) expect(isNearOwnControl({ type: t })).toBe(true);
        for (const t of ['text', 'call_key_request', 'near', 'near_offer2', undefined]) expect(isNearOwnControl({ type: t })).toBe(false);
        expect(isNearOwnControl(null)).toBe(false); expect(isNearOwnControl([OFFER])).toBe(false); expect(isNearOwnControl('near_offer')).toBe(false);
    });
    it('forwards a message from ANOTHER device of this account, with the verified ids and the device name', async () => {
        const nearOwnDeliver = vi.fn(async () => 'offer');
        expect(await deliverOwnNearControl({ ...base, deviceLabel: 'Laptop' }, { nearOwnDeliver })).toBe('delivered');
        expect(nearOwnDeliver).toHaveBeenCalledWith({ content: OFFER, fromDeviceId: 'dev-N', ownDeviceId: 'dev-H', deviceLabel: 'Laptop' });
    });
    it.each([
        ['a friend (another account)', { senderUserId: 'u2' }],
        ['this very device', { senderDeviceId: 'dev-H' }],
        ['an unverified author', { senderUserId: undefined }],
        ['no author device', { senderDeviceId: null }],
        ['not signed in', { userId: null }],
        ['an ordinary message', { content: { type: 'text', text: 'hi' } }],
    ])('never reaches the host from %s', async (_n, over) => {
        const nearOwnDeliver = vi.fn(async () => 'offer');
        expect(await deliverOwnNearControl({ ...base, ...over } as never, { nearOwnDeliver })).toBe('not_own');
        expect(nearOwnDeliver).not.toHaveBeenCalled();
    });
    it('says "unavailable" with no bridge and "failed" when the host throws; never throws itself', async () => {
        expect(await deliverOwnNearControl(base, {})).toBe('unavailable');
        expect(await deliverOwnNearControl(base, { nearOwnDeliver: async () => { throw new Error('x'); } })).toBe('failed');
    });
});

describe('outgoing own-device control messages', () => {
    const deps = (over: Partial<OwnSendDeps> = {}): OwnSendDeps & { posted: unknown[] } => {
        const posted: unknown[] = [];
        return {
            posted, userId: 'u1', deviceId: 'dev-N',
            selfConversationId: async () => 'conv-self',
            listDevices: async () => [
                { device_id: 'dev-N', spk_pub_b64: 's1', user_id: 'u1' }, { device_id: 'dev-H', spk_pub_b64: 's2', user_id: 'u1' }, { device_id: 'dev-F', spk_pub_b64: 's3', user_id: 'u2' },
            ],
            encryptAndAddress: async (_p, _u, devices) => ({ ciphertext_b64: 'CT', recipient_device_ids: devices.map(d => d.device_id) }),
            post: async b => { posted.push(b); },
            ...over,
        };
    };
    it('encrypts for exactly the ONE target device and posts it to the self conversation', async () => {
        const d = deps();
        const encrypt = vi.fn(d.encryptAndAddress);
        const send = createOwnControlSender({ ...d, encryptAndAddress: encrypt });
        expect(await send('dev-H', OFFER)).toBe(true);
        expect(encrypt.mock.calls[0][2].map(x => x.device_id)).toEqual(['dev-H']);
        expect(JSON.parse(encrypt.mock.calls[0][0])).toMatchObject({ type: 'near_offer', to: 'dev-H' });
        expect(d.posted).toEqual([expect.objectContaining({ conversation_id: 'conv-self', recipient_device_ids: ['dev-H'], envelope_type: 'signal_chat', ciphertext_b64: 'CT' })]);
    });
    it('refuses a target that is not another device of this account, or a message that is not addressed to it', async () => {
        const d = deps(); const send = createOwnControlSender(d);
        expect(await send('dev-F', { ...OFFER, to: 'dev-F' })).toBe(false); // another account's device
        expect(await send('dev-N', { ...OFFER, to: 'dev-N' })).toBe(false); // this device
        expect(await send('dev-H', { ...OFFER, to: 'dev-X' })).toBe(false); // `to` does not match
        expect(await send('dev-H', { type: 'text', to: 'dev-H' })).toBe(false); // not a near control message
        expect(d.posted).toEqual([]);
    });
    it('does not post when the device could not be wrapped, and never throws on a failing step', async () => {
        const d = deps({ encryptAndAddress: async () => ({ ciphertext_b64: 'CT', recipient_device_ids: [] }) });
        expect(await createOwnControlSender(d)('dev-H', OFFER)).toBe(false);
        expect(await createOwnControlSender(deps({ post: async () => { throw new Error('offline'); } }))('dev-H', OFFER)).toBe(false);
        expect(await createOwnControlSender(deps({ selfConversationId: async () => { throw new Error('x'); } }))('dev-H', OFFER)).toBe(false);
    });
    it('looks the self conversation up once', async () => {
        const find = vi.fn(async () => 'conv-self');
        const send = createOwnControlSender(deps({ selfConversationId: find }));
        await send('dev-H', OFFER); await send('dev-H', { ...OFFER, type: 'near_msg' });
        expect(find).toHaveBeenCalledTimes(1);
    });
});
