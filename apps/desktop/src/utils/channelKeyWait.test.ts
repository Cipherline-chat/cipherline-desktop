import { describe, it, expect, beforeEach } from 'vitest';
import {
    needsKeyWaitState, summarizeNewestPage, deriveKeyWaitStage, nextStageDeadline, stallAt,
    noteKeyRequestAcked, noteChannelKeyReceived, beginChannelPageDecrypt, getKeyWaitSignals,
    subscribeKeyWaitSignals, resetKeyWaitSignals, EMPTY_SIGNALS, KEY_WAIT_STALL_MS,
    KEY_WAIT_MIN_BEFORE_STALL_MS, KEY_RECEIVED_GRACE_MS, KEY_WAIT_COPY, type KeyWaitSignals,
} from './channelKeyWait';
import { channelPlaceholderContent, type ChannelPlaceholderReason } from './channelDecryptFailure';

let n = 0;
const pill = (reason: ChannelPlaceholderReason = 'key_missing') => ({ id: `p${++n}`, content: channelPlaceholderContent(reason, 3), sender_device_id: 'd1' });
const legacyPill = () => ({ id: `l${++n}`, content: { type: 'system', kind: 'encrypted' }, sender_device_id: 'd1' });
const text = () => ({ id: `t${++n}`, content: { type: 'text', text: 'hi' }, sender_device_id: 'd1' });
const joined = () => ({ id: `sys_${++n}`, content: { type: 'system', text: 'ann joined the server.' }, sender_device_id: '' });
const many = <T,>(k: number, f: () => T) => Array.from({ length: k }, f);

describe('needsKeyWaitState — only when NO key for anything the newest page needs', () => {
    it('shows for a page of nothing but key_missing pills (legacy reason-less pills count too)', () => {
        expect(needsKeyWaitState(many(100, () => pill()))).toBe(true);
        expect(needsKeyWaitState([legacyPill(), legacyPill()])).toBe(true);
    });
    it('a single key_missing row is enough (a channel with one message)', () => {
        expect(needsKeyWaitState([pill()])).toBe(true);
    });
    it('not for a channel with no messages', () => {
        expect(needsKeyWaitState([])).toBe(false);
    });
    it('not when even one row of the newest page decrypted (some keys are held)', () => {
        expect(needsKeyWaitState([...many(99, () => pill()), text()])).toBe(false);
        expect(needsKeyWaitState([text(), ...many(99, () => pill())])).toBe(false);
    });
    it('not when a row failed with a key this device DOES hold (key_mismatch)', () => {
        expect(needsKeyWaitState([...many(50, () => pill()), pill('key_mismatch')])).toBe(false);
    });
    it('not for rows withheld by Read Message History (their own honest label)', () => {
        expect(needsKeyWaitState(many(20, () => pill('history_restricted')))).toBe(false);
        // mostly withheld, a couple of newest-epoch rows missing: keep the labels
        expect(needsKeyWaitState([...many(20, () => pill('history_restricted')), pill(), pill()])).toBe(false);
        // mostly missing, a few withheld: the wait is the honest picture
        expect(needsKeyWaitState([...many(3, () => pill('history_restricted')), ...many(30, () => pill())])).toBe(true);
    });
    it('not for unverifiable senders alone', () => {
        expect(needsKeyWaitState(many(4, () => pill('unverified')))).toBe(false);
    });
    it('local system lines ("X joined the server.") are neutral either way', () => {
        expect(needsKeyWaitState([...many(10, () => pill()), joined()])).toBe(true);
        expect(needsKeyWaitState([joined()])).toBe(false);
    });
    it('looks only at the newest page (100 rows): a readable row further up does not count', () => {
        const rows = [text(), ...many(100, () => pill())];
        expect(summarizeNewestPage(rows).readable).toBe(0);
        expect(needsKeyWaitState(rows)).toBe(true);
        // control: inside the page it does
        expect(needsKeyWaitState([text(), ...many(99, () => pill())])).toBe(false);
    });
});

const sig = (p: Partial<KeyWaitSignals>): KeyWaitSignals => ({ ...EMPTY_SIGNALS, ...p });

describe('deriveKeyWaitStage — copy follows real signals', () => {
    const shown = 1_000_000;
    it('asking → asked once a request was acknowledged', () => {
        expect(deriveKeyWaitStage(sig({}), shown, shown)).toBe('asking');
        expect(deriveKeyWaitStage(sig({ requestAckSeq: 3, firstRequestAckAt: shown }), shown, shown + 100)).toBe('asked');
    });
    it('received when a key landed and no decrypt after it has finished', () => {
        const s = sig({ requestAckSeq: 1, keyReceivedSeq: 5, keyReceivedAt: shown + 500 });
        expect(deriveKeyWaitStage(s, shown, shown + 600)).toBe('received');
        // a decrypt that started BEFORE the key and ended after it is not "the key failed"
        expect(deriveKeyWaitStage({ ...s, lastDoneDecryptSeq: 4 }, shown, shown + 600)).toBe('received');
    });
    it('building while a decrypt that started after the key runs', () => {
        const s = sig({ keyReceivedSeq: 5, keyReceivedAt: shown, activeDecrypts: [6] });
        expect(deriveKeyWaitStage(s, shown, shown + 10)).toBe('building');
        // control: a decrypt from before the key is not "building with it"
        expect(deriveKeyWaitStage({ ...s, activeDecrypts: [4] }, shown, shown + 10)).toBe('received');
    });
    it('never claims progress for a key that did not cover the page', () => {
        // decrypt 6 started after key 5, finished, and the layer is still up
        const s = sig({ requestAckSeq: 1, firstRequestAckAt: shown, keyReceivedSeq: 5, keyReceivedAt: shown, lastDoneDecryptSeq: 6 });
        expect(deriveKeyWaitStage(s, shown, shown + 1000)).toBe('asked');
        // nor for a key no decrypt ever picked up
        const idle = sig({ requestAckSeq: 1, firstRequestAckAt: shown, keyReceivedSeq: 5, keyReceivedAt: shown });
        expect(deriveKeyWaitStage(idle, shown, shown + KEY_RECEIVED_GRACE_MS - 1)).toBe('received');
        expect(deriveKeyWaitStage(idle, shown, shown + KEY_RECEIVED_GRACE_MS + 1)).toBe('asked');
    });
    it('stalled after ~18 s with nothing arriving (from the request, or from showing)', () => {
        const asked = sig({ requestAckSeq: 1, firstRequestAckAt: shown });
        expect(deriveKeyWaitStage(asked, shown, shown + KEY_WAIT_STALL_MS - 1)).toBe('asked');
        expect(deriveKeyWaitStage(asked, shown, shown + KEY_WAIT_STALL_MS)).toBe('stalled');
        expect(deriveKeyWaitStage(sig({}), shown, shown + KEY_WAIT_STALL_MS)).toBe('stalled');
    });
    it('a request filed long before the channel was opened stalls sooner — but never in the first seconds', () => {
        const old = sig({ requestAckSeq: 1, firstRequestAckAt: shown - 120_000 });
        expect(deriveKeyWaitStage(old, shown, shown + KEY_WAIT_MIN_BEFORE_STALL_MS - 1)).toBe('asked');
        expect(deriveKeyWaitStage(old, shown, shown + KEY_WAIT_MIN_BEFORE_STALL_MS)).toBe('stalled');
        expect(stallAt(old, shown)).toBe(shown + KEY_WAIT_MIN_BEFORE_STALL_MS);
    });
    it('a key arriving after the stall still moves on', () => {
        const s = sig({ requestAckSeq: 1, firstRequestAckAt: shown, keyReceivedSeq: 2, keyReceivedAt: shown + 60_000 });
        expect(deriveKeyWaitStage(s, shown, shown + 60_001)).toBe('received');
    });
    it('nextStageDeadline names the stall and the key grace, nothing else', () => {
        expect(nextStageDeadline(sig({}), shown, shown)).toBe(shown + KEY_WAIT_STALL_MS);
        expect(nextStageDeadline(sig({}), shown, shown + KEY_WAIT_STALL_MS + 1)).toBeNull();
        expect(nextStageDeadline(sig({ keyReceivedSeq: 1, keyReceivedAt: shown + 30_000 }), shown, shown + 30_000))
            .toBe(shown + 30_000 + KEY_RECEIVED_GRACE_MS);
    });
    it('copy: no percentages, the stalled line does not claim to know who is online', () => {
        for (const c of Object.values(KEY_WAIT_COPY)) {
            expect(c.title + c.detail).not.toMatch(/%|\d+ ?of ?\d+/);
        }
        expect(KEY_WAIT_COPY.stalled.title).toMatch(/answered yet/);
        expect(KEY_WAIT_COPY.stalled.detail).toMatch(/on its own/);
    });
});

describe('signal store', () => {
    beforeEach(() => resetKeyWaitSignals());
    it('records per channel, monotonic, and notifies subscribers', () => {
        let calls = 0;
        const off = subscribeKeyWaitSignals(() => { calls++; });
        noteKeyRequestAcked('c1', 1000);
        noteKeyRequestAcked('c1', 2000);
        noteChannelKeyReceived('c1', 3000);
        const s = getKeyWaitSignals('c1');
        expect(s.firstRequestAckAt).toBe(1000);
        expect(s.keyReceivedSeq).toBeGreaterThan(s.requestAckSeq);
        expect(s.keyReceivedAt).toBe(3000);
        expect(getKeyWaitSignals('c2')).toBe(EMPTY_SIGNALS);
        expect(calls).toBe(3);
        off();
        noteChannelKeyReceived('c1');
        expect(calls).toBe(3);
    });
    it('snapshots are stable between changes (useSyncExternalStore contract)', () => {
        noteKeyRequestAcked('c1');
        expect(getKeyWaitSignals('c1')).toBe(getKeyWaitSignals('c1'));
    });
    it('page decrypts nest and end exactly once', () => {
        const a = beginChannelPageDecrypt('c1');
        const b = beginChannelPageDecrypt('c1');
        expect(getKeyWaitSignals('c1').activeDecrypts).toHaveLength(2);
        a(); a();
        expect(getKeyWaitSignals('c1').activeDecrypts).toHaveLength(1);
        b();
        const s = getKeyWaitSignals('c1');
        expect(s.activeDecrypts).toHaveLength(0);
        expect(s.lastDoneDecryptSeq).toBeGreaterThan(0);
    });
    it('end to end: key then decrypt → received → building → (fruitless) back to waiting', () => {
        const shown = Date.now();
        noteKeyRequestAcked('c1', shown);
        expect(deriveKeyWaitStage(getKeyWaitSignals('c1'), shown, shown)).toBe('asked');
        noteChannelKeyReceived('c1', shown);
        expect(deriveKeyWaitStage(getKeyWaitSignals('c1'), shown, shown)).toBe('received');
        const end = beginChannelPageDecrypt('c1');
        expect(deriveKeyWaitStage(getKeyWaitSignals('c1'), shown, shown)).toBe('building');
        end();
        expect(deriveKeyWaitStage(getKeyWaitSignals('c1'), shown, shown)).toBe('asked');
    });
});
