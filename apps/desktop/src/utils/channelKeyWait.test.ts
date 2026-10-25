import { describe, it, expect, beforeEach } from 'vitest';
import {
    needsKeyWaitState, summarizeNewestPage, summarizeVisibleWindow, hasEncryptedRows, keyMissingRuns, keyMissingRunLabel,
    deriveKeyWaitStage, nextStageDeadline, stallAt, keyWaitGiveUpAt, isGiveUpRemembered,
    noteKeyRequestAcked, noteChannelKeyReceived, beginChannelPageDecrypt, beginChannelOpen, noteKeyWaitGaveUp, isOpening,
    getKeyWaitSignals, subscribeKeyWaitSignals, resetKeyWaitSignals, EMPTY_SIGNALS, KEY_WAIT_STALL_MS,
    KEY_WAIT_MIN_BEFORE_STALL_MS, KEY_RECEIVED_GRACE_MS, KEY_WAIT_COPY, KEY_WAIT_VISIBLE_ROWS, KEY_WAIT_STALLED_DWELL_MS,
    KEY_WAIT_GIVE_UP_MEMORY_MS, KEY_WAIT_BANNER_COPY, type KeyWaitSignals,
} from './channelKeyWait';
import { channelPlaceholderContent, type ChannelPlaceholderReason } from './channelDecryptFailure';

let n = 0;
const pill = (reason: ChannelPlaceholderReason = 'key_missing') => ({ id: `p${++n}`, content: channelPlaceholderContent(reason, 3), sender_device_id: 'd1' });
const legacyPill = () => ({ id: `l${++n}`, content: { type: 'system', kind: 'encrypted' }, sender_device_id: 'd1' });
const text = () => ({ id: `t${++n}`, content: { type: 'text', text: 'hi' }, sender_device_id: 'd1' });
const joined = () => ({ id: `sys_${++n}`, content: { type: 'system', kind: 'member_event', event: 'member_joined' }, sender_device_id: '' });
const many = <T,>(k: number, f: () => T) => Array.from({ length: k }, f);

describe('needsKeyWaitState — the key-loading view whenever what is on screen needs keys (2026-10-20)', () => {
    it('fresh join: a page of nothing but key_missing pills (legacy reason-less pills count too)', () => {
        expect(needsKeyWaitState(many(100, () => pill()))).toBe(true);
        expect(needsKeyWaitState([legacyPill(), legacyPill()])).toBe(true);
    });
    it('a single key_missing row is enough (a channel with one message)', () => {
        expect(needsKeyWaitState([pill()])).toBe(true);
    });
    it('not for a channel with no messages (the composer gate says what is missing)', () => {
        expect(needsKeyWaitState([])).toBe(false);
    });
    it('THE REPORT: newest epoch missing, older epochs held — a readable minority no longer cancels it', () => {
        // a joiner holding epoch 10 but not 20: older rows read, newest are pills
        expect(needsKeyWaitState([...many(60, text), ...many(40, () => pill())])).toBe(true);
        // even one readable row used to cancel the state for good
        expect(needsKeyWaitState([text(), ...many(99, () => pill())])).toBe(true);
    });
    it('newest epoch missing: the newest message alone is a pill on an otherwise readable screen', () => {
        expect(needsKeyWaitState([...many(99, text), pill()])).toBe(true);
    });
    it('the visible window mostly waiting, even when the newest row happens to read', () => {
        expect(needsKeyWaitState([...many(99, () => pill()), text()])).toBe(true);
        // half is not "mostly"
        const half = [...many(75, text), ...many(12, () => pill()), ...many(13, text)];
        expect(summarizeVisibleWindow(half)).toEqual({ total: KEY_WAIT_VISIBLE_ROWS, keyMissing: 12, newestWaiting: false });
        expect(needsKeyWaitState(half)).toBe(false);
        const over = [...many(75, text), ...many(13, () => pill()), ...many(12, text)];
        expect(needsKeyWaitState(over)).toBe(true);
    });
    it('history-only gap: older rows waiting, what is on screen reads → no view (feed + one collapsed row)', () => {
        expect(needsKeyWaitState([...many(70, () => pill()), ...many(30, text)])).toBe(false);
    });
    it('key_mismatch rows do not block it, but a page that is MOSTLY mismatched keeps its labels', () => {
        expect(needsKeyWaitState([...many(50, () => pill()), pill('key_mismatch')])).toBe(true);
        expect(needsKeyWaitState([...many(5, () => pill('key_mismatch')), pill()])).toBe(false);
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
        // the newest ENCRYPTED row is what counts: a join line under it changes nothing
        expect(needsKeyWaitState([...many(90, text), pill(), joined()])).toBe(true);
    });
    it('looks only at the newest page (100 rows): what is further up does not count', () => {
        const rows = [text(), ...many(100, () => pill())];
        expect(summarizeNewestPage(rows).readable).toBe(0);
        expect(needsKeyWaitState(rows)).toBe(true);
        // and pills above the newest page do not bring it up
        expect(needsKeyWaitState([...many(50, () => pill()), ...many(100, text)])).toBe(false);
    });
    it('newestKeyPending (asked while keyless) still widens a page with more waiting than readable', () => {
        // newest row reads, the window is under half, but the page is mostly waiting
        const rows = [...many(60, () => pill()), ...many(15, text), ...many(10, () => pill()), ...many(15, text)];
        expect(needsKeyWaitState(rows)).toBe(false);
        expect(needsKeyWaitState(rows, undefined, { newestKeyPending: true })).toBe(true);
    });
});

describe('hasEncryptedRows — what may latch the pane', () => {
    it('a thread of only local system lines says nothing yet (the joiner\'s own join line)', () => {
        expect(hasEncryptedRows([])).toBe(false);
        expect(hasEncryptedRows([joined()])).toBe(false);
        expect(hasEncryptedRows([joined(), text()])).toBe(true);
        expect(hasEncryptedRows([pill()])).toBe(true);
    });
});

describe('keyMissingRuns — consecutive waiting rows collapse into one', () => {
    it('a run of ≥ 2 key_missing rows: count on the first, 0 on the rest; singles stay as they are', () => {
        const a = pill(), b = pill(), c = pill(), t = text(), d = pill();
        const runs = keyMissingRuns([a, b, c, t, d]);
        expect(runs.get(a.id)).toBe(3);
        expect(runs.get(b.id)).toBe(0);
        expect(runs.get(c.id)).toBe(0);
        expect(runs.has(t.id)).toBe(false);
        expect(runs.has(d.id)).toBe(false);
    });
    it('other placeholder reasons break a run and keep their own label', () => {
        const a = pill(), r = pill('history_restricted'), b = pill(), c = pill();
        const runs = keyMissingRuns([a, r, b, c]);
        expect(runs.has(a.id)).toBe(false);
        expect(runs.has(r.id)).toBe(false);
        expect(runs.get(b.id)).toBe(2);
    });
    it('a history-gap marker breaks a run', () => {
        const a = pill(), b = pill(), c = pill(), d = pill();
        const runs = keyMissingRuns([a, b, c, d], id => id === c.id);
        expect(runs.get(a.id)).toBe(2);
        expect(runs.get(c.id)).toBe(2);
        expect(runs.get(d.id)).toBe(0);
    });
    it('label', () => {
        expect(keyMissingRunLabel(12)).toBe('12 messages waiting for this channel’s key');
    });
});

describe('give-up — never trap the user behind the layer', () => {
    const shown = 1_000_000;
    const s = (p: Partial<KeyWaitSignals>): KeyWaitSignals => ({ ...EMPTY_SIGNALS, ...p });
    it('the stalled copy is readable for a dwell, then the feed takes over', () => {
        expect(keyWaitGiveUpAt(s({}), shown)).toBe(shown + KEY_WAIT_STALL_MS + KEY_WAIT_STALLED_DWELL_MS);
        // a request filed long before the open: sooner, never before min + dwell
        expect(keyWaitGiveUpAt(s({ requestAckSeq: 1, firstRequestAckAt: shown - 600_000 }), shown))
            .toBe(shown + KEY_WAIT_MIN_BEFORE_STALL_MS + KEY_WAIT_STALLED_DWELL_MS);
    });
    it('a key arriving keeps the wait alive (progress is not a reason to give up)', () => {
        expect(keyWaitGiveUpAt(s({ keyReceivedSeq: 3, keyReceivedAt: shown + 20_000 }), shown)).toBe(shown + 20_000 + KEY_WAIT_STALL_MS);
    });
    it('remembered per channel until a key arrives or the memory lapses', () => {
        const gave = s({ keyReceivedSeq: 4, gaveUpAt: shown, gaveUpKeySeq: 4 });
        expect(isGiveUpRemembered(gave, shown + 1000)).toBe(true);
        expect(isGiveUpRemembered({ ...gave, keyReceivedSeq: 9 }, shown + 1000)).toBe(false);
        expect(isGiveUpRemembered(gave, shown + KEY_WAIT_GIVE_UP_MEMORY_MS)).toBe(false);
        expect(isGiveUpRemembered(s({}), shown)).toBe(false);
    });
    it('banner copy: the owner\'s words, one action', () => {
        expect(KEY_WAIT_BANNER_COPY.title).toBe('Waiting for someone with the keys to come online');
        expect(KEY_WAIT_BANNER_COPY.retry).toMatch(/again/i);
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
        expect(KEY_WAIT_COPY.stalled.detail).toMatch(/on their own/);
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
    it('channel opens nest and end exactly once', () => {
        const a = beginChannelOpen('c1');
        const b = beginChannelOpen('c1');
        expect(isOpening(getKeyWaitSignals('c1'))).toBe(true);
        a(); a();
        expect(isOpening(getKeyWaitSignals('c1'))).toBe(true);
        b();
        expect(isOpening(getKeyWaitSignals('c1'))).toBe(false);
        expect(isOpening(getKeyWaitSignals('c2'))).toBe(false);
    });
    it('a give-up remembers the key seq it happened at', () => {
        noteChannelKeyReceived('c1', 1000);
        noteKeyWaitGaveUp('c1', 2000);
        const s = getKeyWaitSignals('c1');
        expect(isGiveUpRemembered(s, 3000)).toBe(true);
        noteChannelKeyReceived('c1', 4000);
        expect(isGiveUpRemembered(getKeyWaitSignals('c1'), 5000)).toBe(false);
    });
});
