import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    UNDELIVERED_AFTER_MS, UNDELIVERED_LABEL, createSendClock, undeliveredMenu,
    markDelivered, wasDelivered, markCancelled, wasCancelled, clearCancelled,
} from './undeliveredSend';
import { applySendPatch, type SendMarked } from './pendingSend';

const row = (cid: string, send_state?: 'sending' | 'failed'): SendMarked => ({
    id: cid, content: { client_msg_id: cid }, ...(send_state ? { send_state } : {}),
});

/** A clock whose "now" the test drives. */
function harness() {
    let t = 1_000_000;
    const clock = createSendClock(() => t);
    return { clock, advance: (ms: number) => { t += ms; } };
}

describe('the 10 s undelivered clock', () => {
    it('a pending message is NOT flagged while it is fresh, and IS at exactly 10 s', () => {
        const { clock, advance } = harness();
        const thread = [row('a', 'sending')];
        clock.reconcile(thread);
        expect(clock.isUndelivered(thread[0])).toBe(false);
        advance(UNDELIVERED_AFTER_MS - 1);
        expect(clock.isUndelivered(thread[0])).toBe(false);
        advance(1);
        expect(clock.isUndelivered(thread[0])).toBe(true);
    });

    it('CONTROL: a delivered row (no marker) is never flagged, however old', () => {
        const { clock, advance } = harness();
        const thread = [row('a')];
        clock.reconcile(thread);
        advance(10 * UNDELIVERED_AFTER_MS);
        expect(clock.isUndelivered(thread[0])).toBe(false);
    });

    it('a definitive failure is flagged immediately, with no 10 s wait', () => {
        const { clock } = harness();
        const thread = [row('a', 'failed')];
        clock.reconcile(thread);
        expect(clock.isUndelivered(thread[0])).toBe(true);
    });

    it('CONTROL: a row that was never reconciled has no clock, so it is not flagged by accident', () => {
        const { clock, advance } = harness();
        advance(60_000);
        expect(clock.isUndelivered(row('ghost', 'sending'))).toBe(false);
    });

    it('a late confirmation clears the flag (the marker is removed from the row)', () => {
        const { clock, advance } = harness();
        let thread = [row('a', 'sending')];
        clock.reconcile(thread);
        advance(UNDELIVERED_AFTER_MS + 5_000);
        expect(clock.isUndelivered(thread[0])).toBe(true);
        // The same patch ChatPane applies when the POST finally returns.
        thread = applySendPatch(thread, 'a', { send_state: null });
        clock.reconcile(thread);
        expect(thread[0].send_state).toBeUndefined();
        expect(clock.isUndelivered(thread[0])).toBe(false);
    });

    it('late confirmation of a message that had already FAILED clears it too', () => {
        const { clock } = harness();
        let thread = [row('a', 'sending')];
        thread = applySendPatch(thread, 'a', { send_state: 'failed', send_error: 'No connection' });
        clock.reconcile(thread);
        expect(clock.isUndelivered(thread[0])).toBe(true);
        thread = applySendPatch(thread, 'a', { send_state: null });
        expect(clock.isUndelivered(thread[0])).toBe(false);
    });

    it('Retry: hidden while retrying, and the 10 s clock starts over', () => {
        const { clock, advance } = harness();
        let thread = [row('a', 'failed')];
        clock.reconcile(thread);
        expect(clock.isUndelivered(thread[0])).toBe(true);
        // ChatPane's retrySend: restart the clock, then flip the row back to 'sending'.
        clock.restart('a');
        thread = applySendPatch(thread, 'a', { send_state: 'sending' });
        clock.reconcile(thread);
        expect(clock.isUndelivered(thread[0])).toBe(false);
        advance(UNDELIVERED_AFTER_MS - 1);
        expect(clock.isUndelivered(thread[0])).toBe(false);
        advance(1);
        expect(clock.isUndelivered(thread[0])).toBe(true);
    });

    it('Retry of a timed-out (still sending) message also restarts the clock', () => {
        const { clock, advance } = harness();
        const thread = [row('a', 'sending')];
        clock.reconcile(thread);
        advance(UNDELIVERED_AFTER_MS + 1);
        expect(clock.isUndelivered(thread[0])).toBe(true);
        clock.restart('a');
        expect(clock.isUndelivered(thread[0])).toBe(false);
        advance(UNDELIVERED_AFTER_MS);
        expect(clock.isUndelivered(thread[0])).toBe(true);
    });

    it('CONTROL: without restart(), a retry that was never rendered as failed would keep its OLD start (why retrySend restarts explicitly)', () => {
        const { clock, advance } = harness();
        const thread = [row('a', 'sending')];
        clock.reconcile(thread);
        advance(UNDELIVERED_AFTER_MS + 1);
        // failed -> sending batched into one render: reconcile never saw 'failed'.
        clock.reconcile([row('a', 'sending')]);
        expect(clock.isUndelivered(thread[0])).toBe(true);
    });

    it('survives a remount: the same clock keeps counting a message across a conversation switch', () => {
        const { clock, advance } = harness();
        const thread = [row('a', 'sending')];
        clock.reconcile(thread);
        advance(6_000);
        clock.reconcile([]);           // pane unmounted / other conversation
        clock.reconcile(thread);       // back again
        advance(4_000);
        expect(clock.isUndelivered(thread[0])).toBe(true);
    });

    it('msUntilNextDue is the soonest pending message, and null when nothing is pending', () => {
        const { clock, advance } = harness();
        expect(clock.msUntilNextDue([row('x')])).toBeNull();
        const thread = [row('a', 'sending')];
        clock.reconcile(thread);
        advance(3_000);
        const both = [...thread, row('b', 'sending')];
        clock.reconcile(both);
        expect(clock.msUntilNextDue(both)).toBe(UNDELIVERED_AFTER_MS - 3_000);
        advance(UNDELIVERED_AFTER_MS - 1_000);
        // 'a' is due already; 'b' (started 3 s later) is the next one.
        expect(clock.msUntilNextDue(both)).toBe(1_000);
        expect(clock.msUntilNextDue([row('f', 'failed')])).toBeNull();
    });
});

describe('the right-click menu of an undelivered message', () => {
    it('is headed "Message not delivered" with Retry send and Discard first', () => {
        const onRetry = vi.fn(); const onDiscard = vi.fn();
        const { title, items } = undeliveredMenu({ onRetry, onDiscard });
        expect(title).toBe(UNDELIVERED_LABEL);
        const labels = items.map(i => ('label' in i ? i.label : '---'));
        expect(labels).toEqual(['Retry send', 'Discard']);
        const [retry, discard] = items as { onSelect: () => void; danger?: boolean }[];
        retry.onSelect(); expect(onRetry).toHaveBeenCalledTimes(1); expect(onDiscard).not.toHaveBeenCalled();
        discard.onSelect(); expect(onDiscard).toHaveBeenCalledTimes(1);
        expect(discard.danger).toBe(true);
    });

    it('offers Copy Text only when the handler is given (text messages), after a divider', () => {
        const withCopy = undeliveredMenu({ onRetry: () => {}, onDiscard: () => {}, onCopyText: () => {} }).items;
        expect(withCopy.map(i => ('divider' in i ? '---' : 'label' in i ? i.label : '?'))).toEqual(['Retry send', 'Discard', '---', 'Copy Text']);
    });
});

describe('delivery ledger (no duplicate POST after a late success, none after a discard)', () => {
    it('remembers a delivered id; a never-delivered id is unknown (control)', () => {
        markDelivered('d1');
        expect(wasDelivered('d1')).toBe(true);
        expect(wasDelivered('d2')).toBe(false);
    });
    it('a discard is remembered, and a Retry clears it (control: other ids unaffected)', () => {
        markCancelled('c1');
        expect(wasCancelled('c1')).toBe(true);
        expect(wasCancelled('c2')).toBe(false);
        clearCancelled('c1');
        expect(wasCancelled('c1')).toBe(false);
    });
});

describe('pending rows are not dimmed', () => {
    /** The old behaviour, as the source looked: a delayed opacity animation on 'sending' rows. */
    const dims = (css: string, tsx: string) =>
        /opacity:\s*0?\.55/.test(css) && css.includes('.cl-send-pending') && tsx.includes("' cl-send-pending'");
    const OLD_CSS = '@keyframes cl-send-pending { from { opacity: 1; } to { opacity: 0.55; } }\n.cl-send-pending { animation: cl-send-pending 300ms ease 700ms both; }';
    const OLD_TSX = "className={`x${msg.send_state === 'sending' ? ' cl-send-pending' : ''}`}";

    it('CONTROL: the detector flags the old dimming source', () => {
        expect(dims(OLD_CSS, OLD_TSX)).toBe(true);
    });

    it('the current stylesheet and ChatPane have no pending-dim styling', () => {
        const css = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');
        const tsx = readFileSync(join(__dirname, '..', 'components', 'ChatPane.tsx'), 'utf8');
        expect(dims(css, tsx)).toBe(false);
        expect(css).not.toContain('cl-send-pending');
        expect(tsx).not.toContain('cl-send-pending');
        expect(tsx).not.toMatch(/send_state === 'sending'[^\n]*(opacity|italic)/);
    });
});
