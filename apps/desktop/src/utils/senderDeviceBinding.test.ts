/**
 * F4 — a sender's claimed device id (`sd`) is the sender's own choice, so it
 * must not decide authorship, display identity or reaction attribution.
 *
 * Negative: a group member who names another member's device id cannot edit,
 * delete or react as them, and is flagged by the directory.
 * Positive: genuine authors (including the same user from another device, and
 * my own devices' self-fan-out) still edit/delete their own messages.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { applyIncomingDmMessages, isSameAuthor, bindSenderDeviceId, deletedDmTargets } from './dmInbound';
import * as deviceDirectory from './deviceDirectory';

const ALICE = 'aaaaaaaa-0000-4000-8000-000000000001';
const MALLORY = 'aaaaaaaa-0000-4000-8000-000000000002';
const ME = 'aaaaaaaa-0000-4000-8000-000000000003';
const ALICE_DEV = 'dddddddd-0000-4000-8000-0000000000a1';
const ALICE_DEV2 = 'dddddddd-0000-4000-8000-0000000000a2';
const MAL_DEV = 'dddddddd-0000-4000-8000-0000000000b1';
const MY_DEV = 'dddddddd-0000-4000-8000-0000000000c1';

// Thread rows are loosely typed in the reducer.
const row = (over: any) => ({ id: 'm1', timestamp: 't', conversation_id: 'c', ...over });

beforeEach(() => deviceDirectory._reset());

describe('isSameAuthor — user id decides when both sides have one', () => {
    it('refuses a different user who names the author\'s device id (audit PoC)', () => {
        expect(isSameAuthor(
            { sender_user_id: ALICE, sender_device_id: ALICE_DEV },
            { sender_user_id: MALLORY, sender_device_id: ALICE_DEV },
        )).toBe(false);
    });
    it('accepts the same user from another of their devices', () => {
        expect(isSameAuthor(
            { sender_user_id: ALICE, sender_device_id: ALICE_DEV },
            { sender_user_id: ALICE, sender_device_id: ALICE_DEV2 },
        )).toBe(true);
    });
    it('my own locally-written row (no user id) still matches my own action', () => {
        expect(isSameAuthor({ sender_device_id: MY_DEV }, { sender_user_id: ME, sender_device_id: MY_DEV })).toBe(true);
    });
    it('empty device ids never match', () => {
        expect(isSameAuthor({ sender_device_id: '' }, { sender_device_id: '' })).toBe(false);
    });
});

describe('applyIncomingDmMessages — group edit/delete/reaction authorization', () => {
    const aliceMsg = row({ sender_user_id: ALICE, sender_device_id: ALICE_DEV, content: { type: 'text', text: 'I love this plan', client_msg_id: 'm1' } });

    it('a forged edit naming Alice\'s device is refused (was the PoC)', () => {
        const forged = row({ id: 'm2', sender_user_id: MALLORY, sender_device_id: ALICE_DEV, content: { type: 'edit', target_id: 'm1', text: 'I hate this plan' } });
        const out = applyIncomingDmMessages({ c: [aliceMsg] }, { c: [forged] });
        expect(out.c[0].content.text).toBe('I love this plan');
    });
    it('a forged delete naming Alice\'s device is refused', () => {
        const forged = row({ id: 'm2', sender_user_id: MALLORY, sender_device_id: ALICE_DEV, content: { type: 'delete', target_id: 'm1' } });
        expect(applyIncomingDmMessages({ c: [aliceMsg] }, { c: [forged] }).c).toHaveLength(1);
        expect(deletedDmTargets({ c: [aliceMsg] }, { c: [forged] })).toEqual([]);
    });
    it('positive control: Alice edits and deletes her own message from her second device', () => {
        const edit = row({ id: 'm2', sender_user_id: ALICE, sender_device_id: ALICE_DEV2, content: { type: 'edit', target_id: 'm1', text: 'updated' } });
        expect(applyIncomingDmMessages({ c: [aliceMsg] }, { c: [edit] }).c[0].content.text).toBe('updated');
        const del = row({ id: 'm3', sender_user_id: ALICE, sender_device_id: ALICE_DEV, content: { type: 'delete', target_id: 'm1' } });
        expect(applyIncomingDmMessages({ c: [aliceMsg] }, { c: [del] }).c).toHaveLength(0);
    });
    it('positive control: my edit from another device of mine (self-fan-out) applies to my row', () => {
        const mine = row({ sender_device_id: MY_DEV, content: { type: 'text', text: 'typo' } });
        const edit = row({ id: 'm2', sender_user_id: ME, sender_device_id: MY_DEV, content: { type: 'edit', target_id: 'm1', text: 'fixed' } });
        expect(applyIncomingDmMessages({ c: [mine] }, { c: [edit] }).c[0].content.text).toBe('fixed');
    });
});

describe('bindSenderDeviceId — ingest-time binding of sd to su', () => {
    const bind = (su: string, sd: string | null, mine: string[] = [MY_DEV]) => bindSenderDeviceId({
        senderUserId: su,
        senderDeviceId: sd,
        myDeviceIds: new Set(mine),
        deviceOwner: deviceDirectory.deviceOwner,
        isKnownUserId: deviceDirectory.isKnownUserId,
    });
    beforeEach(() => {
        deviceDirectory.record([
            { user_id: ALICE, device_id: ALICE_DEV, identity_pub_b64: 'A1' },
            { user_id: MALLORY, device_id: MAL_DEV, identity_pub_b64: 'M1' },
        ]);
    });
    it('drops another member\'s device id', () => expect(bind(MALLORY, ALICE_DEV)).toBe(''));
    it('drops one of MY device ids claimed by someone else', () => expect(bind(MALLORY, MY_DEV)).toBe(''));
    it('drops a user id posing as a device id', () => {
        expect(bind(MALLORY, ALICE)).toBe('');
        expect(bind(MALLORY, MALLORY)).toBe('');
    });
    it('keeps the sender\'s own listed device', () => expect(bind(MALLORY, MAL_DEV)).toBe(MAL_DEV));
    it('keeps an unknown (e.g. newly added) device of the sender', () => {
        expect(bind(ALICE, 'dddddddd-0000-4000-8000-0000000000ff')).toBe('dddddddd-0000-4000-8000-0000000000ff');
    });
    it('a missing sd stays unknown', () => expect(bind(ALICE, null)).toBe(''));
});

describe('deviceDirectory.status — sd must be bound to su', () => {
    beforeEach(() => {
        deviceDirectory.record([
            { user_id: ALICE, device_id: ALICE_DEV, identity_pub_b64: 'A1' },
            { user_id: MALLORY, device_id: MAL_DEV, identity_pub_b64: 'M1' },
        ]);
    });
    it('mismatch when the claimed device belongs to another user', () => {
        expect(deviceDirectory.status(MALLORY, 'M1', ALICE_DEV)).toBe('mismatch');
    });
    it('mismatch when the key is the sender\'s but listed under another device id', () => {
        expect(deviceDirectory.status(MALLORY, 'M1', 'dddddddd-0000-4000-8000-0000000000ee')).toBe('mismatch');
    });
    it('positive controls: exact device match, and an omitted sd with a published key', () => {
        expect(deviceDirectory.status(MALLORY, 'M1', MAL_DEV)).toBe('match');
        expect(deviceDirectory.status(ALICE, 'A1')).toBe('match');
    });
});
