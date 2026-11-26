import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    AUTO_READ_MAX_IDLE_MS, IDLE_READING_STALE_MS, computeInputIdleMs, freshIdleSeconds, getInputIdleMs, hasRecentInput,
    noteLocalInput, publishOsIdleReading, resetInputRecency, subscribeInputRecency,
} from './inputRecency';
import { buildMessageReadData, readReceiptToSend } from './readReceipt';

const T = 10_000_000;
const A = '0a0a0a0a-1111-4222-8333-444455556666';
const B = '0b0b0b0b-1111-4222-8333-444455556666';

beforeEach(() => resetInputRecency());

describe('freshIdleSeconds / computeInputIdleMs', () => {
    it('a reading older than 2 poll intervals, never read, or invalid is unknown (+Infinity)', () => {
        expect(freshIdleSeconds(0, T, T + 1000)).toBe(0);
        expect(freshIdleSeconds(0, T, T + IDLE_READING_STALE_MS)).toBe(0);
        expect(freshIdleSeconds(0, T, T + IDLE_READING_STALE_MS + 1)).toBe(Infinity);
        expect(freshIdleSeconds(0, 0, T)).toBe(Infinity);
        expect(freshIdleSeconds(NaN, T, T)).toBe(Infinity);
        expect(freshIdleSeconds(-3, T, T)).toBe(Infinity);
    });
    it('adds the reading age (errs toward idle) and takes the newer of OS and window input', () => {
        const s = { osIdleSeconds: 5, osReadAt: T, lastLocalInputAt: -Infinity };
        expect(computeInputIdleMs(s, T + 10_000)).toBe(15_000);
        expect(computeInputIdleMs({ ...s, lastLocalInputAt: T + 9_000 }, T + 10_000)).toBe(1_000);
        expect(computeInputIdleMs({ ...s, osIdleSeconds: Infinity }, T + 10_000)).toBeUndefined();
        expect(computeInputIdleMs({ ...s, osIdleSeconds: Infinity, lastLocalInputAt: T + 9_000 }, T + 10_000)).toBe(1_000);
    });
    it('caps at the 24 h the server accepts', () => {
        expect(computeInputIdleMs({ osIdleSeconds: 10 ** 9, osReadAt: T, lastLocalInputAt: -Infinity }, T)).toBe(86_400_000);
    });
});

describe('hasRecentInput (the auto-read window)', () => {
    it('is false when nothing is known, true within 120 s, false after', () => {
        expect(hasRecentInput(T)).toBe(false);
        publishOsIdleReading(30, T);
        expect(hasRecentInput(T)).toBe(true);
        expect(hasRecentInput(T + 90_000 - 1)).toBe(false); // reading stale after 60 s -> unknown
        publishOsIdleReading(200, T + 10_000);
        expect(hasRecentInput(T + 10_000)).toBe(false);
        expect(AUTO_READ_MAX_IDLE_MS).toBe(120_000);
    });
    it('window input counts even when the OS clock is unknown', () => {
        publishOsIdleReading(Infinity, T);
        noteLocalInput(T + 1000);
        expect(hasRecentInput(T + 2000)).toBe(true);
        expect(hasRecentInput(T + 1000 + AUTO_READ_MAX_IDLE_MS + 1)).toBe(false);
    });
    it('notifies on the not-recent -> recent edge only', () => {
        const fn = vi.fn();
        subscribeInputRecency(fn);
        publishOsIdleReading(Infinity, T);
        noteLocalInput(T + 1);
        noteLocalInput(T + 2);
        noteLocalInput(T + 3);
        expect(fn).toHaveBeenCalledTimes(1);
    });
});

/** The ChatPane effect, reduced: what goes out at each moment, given the same inputs. */
function chatPaneEffect(state: { lastSent: string | null }, lastId: string, now: number, gate = true) {
    const send = readReceiptToSend({
        lastId, lastSentId: state.lastSent, attended: true,
        recentInput: gate ? hasRecentInput(now) : true, showReadReceipts: true,
    });
    if (send) state.lastSent = send.id;
    return send;
}

describe('auto read-receipt gate', () => {
    it('withheld while idle > 120 s with the window focused, sent the moment input returns', () => {
        const st = { lastSent: A as string | null };
        publishOsIdleReading(1800, T); // 30 min idle, chat focused and visible
        expect(chatPaneEffect(st, B, T + 1000)).toBeNull();
        expect(st.lastSent).toBe(A); // NOT marked sent, so it can still go out
        expect(chatPaneEffect(st, B, T + 20_000)).toBeNull();
        noteLocalInput(T + 30_000); // the user touches the mouse
        expect(chatPaneEffect(st, B, T + 30_100)).toEqual({ id: B, selfOnly: false });
        expect(chatPaneEffect(st, B, T + 30_200)).toBeNull(); // once
    });
    it('POSITIVE CONTROL: with the gate removed the idle read goes out (this is the bug)', () => {
        const st = { lastSent: A as string | null };
        publishOsIdleReading(1800, T);
        expect(chatPaneEffect(st, B, T + 1000, false)).toEqual({ id: B, selfOnly: false });
    });
    it('a window that is not attended is still never read, input or not', () => {
        publishOsIdleReading(1, T);
        expect(readReceiptToSend({ lastId: B, lastSentId: A, attended: false, recentInput: true, showReadReceipts: true })).toBeNull();
    });
    it('an explicit open (click = input, or mark-as-read passing recentInput:true) reads immediately even from idle', () => {
        publishOsIdleReading(1800, T);
        noteLocalInput(T + 5000); // the click that opens the chat is itself input
        expect(hasRecentInput(T + 5001)).toBe(true);
        expect(readReceiptToSend({ lastId: B, lastSentId: null, attended: true, recentInput: true, showReadReceipts: true })).toEqual({ id: B, selfOnly: false });
    });
});

describe('idle_ms on read events', () => {
    it('is present (integer) when known and omitted when unknown', () => {
        publishOsIdleReading(7, T);
        const idle = getInputIdleMs(T + 3000);
        expect(idle).toBe(10_000);
        expect(buildMessageReadData(A, B, undefined, idle, 5)).toEqual({ conversation_id: A, last_read_message_id: B, read_at: 5, idle_ms: 10_000 });
        expect(buildMessageReadData(A, B, { selfOnly: true }, idle, 5)).toMatchObject({ self_only: true, idle_ms: 10_000 });
        expect(buildMessageReadData(A, B, undefined, undefined, 5)).not.toHaveProperty('idle_ms');
        expect(buildMessageReadData(A, B, undefined, -1, 5)).not.toHaveProperty('idle_ms');
        expect(buildMessageReadData(A, B, undefined, 1.5, 5)).not.toHaveProperty('idle_ms');
    });
});
