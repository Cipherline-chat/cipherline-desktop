/**
 * Instant reactions: the overlay + delivery logic behind the chip that changes
 * on click and turns red when the send does not go through. Pure logic, driven
 * with fake timers and a fake `send`; the DOM end of it is
 * components/ReactionFailure.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    createReactionStore, applyPendingReactions, reactionFailureReason,
    SETTLED_GRACE_MS, type ReactionStore, type ReactionSend, type ReactionIntent,
} from './pendingReactions';
import { UNDELIVERED_AFTER_MS } from './undeliveredSend';

const CONV = 'dev-1:channel:chan-1';
const ME = 'user-me';
const DEV = 'dev-1';
const MINE = [ME, DEV];
const MSG = 'msg-1';

type Deferred = { resolve: () => void; reject: (e: unknown) => void; signal: AbortSignal; intent: ReactionIntent };

/** A send whose every call stays open until the test settles it. */
function controllableSend() {
    const calls: Deferred[] = [];
    const send: ReactionSend = (intent, signal) => new Promise<void>((resolve, reject) => {
        calls.push({ resolve, reject, signal, intent });
        signal.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })));
    });
    return { send, calls };
}

/** What a user would see, given the confirmed reactions of the one message. */
const view = (store: ReactionStore, base: Record<string, string[]> | undefined) =>
    applyPendingReactions(base, store.forMessage(CONV, MSG), MINE, ME);

const toggle = (store: ReactionStore, send: ReactionSend, baseHas: boolean, emoji = '👍') =>
    store.toggle({ convKey: CONV, msgId: MSG, emoji, baseHas, send });

const keyOf = (store: ReactionStore, emoji = '👍') => store.forMessage(CONV, MSG)!.find(e => e.emoji === emoji)!.key;

let store: ReactionStore;
beforeEach(() => {
    vi.useFakeTimers();
    store = createReactionStore();
});
afterEach(() => { vi.useRealTimers(); });

describe('optimistic add', () => {
    it('the chip exists and counts me the moment of the click, before any answer', () => {
        const { send, calls } = controllableSend();
        // No reactions on the message at all.
        expect(view(store, undefined).reactions).toBeUndefined();
        toggle(store, send, false);
        const v = view(store, undefined);
        expect(v.reactions).toEqual({ '👍': [ME] });
        expect(v.failures).toEqual({});
        // ...and the request went out in the background.
        expect(calls).toHaveLength(1);
        expect(calls[0].intent).toBe('add');
    });

    it('piling onto someone else\'s reaction bumps the count by one', () => {
        const { send } = controllableSend();
        toggle(store, send, false);
        expect(view(store, { '👍': ['other'] }).reactions).toEqual({ '👍': ['other', ME] });
    });

    it('control: with nothing pending the confirmed state is returned untouched (the pre-change behaviour)', () => {
        const base = { '👍': ['other'] };
        expect(applyPendingReactions(base, undefined, MINE, ME).reactions).toBe(base);
        expect(applyPendingReactions(undefined, [], MINE, ME).reactions).toBeUndefined();
    });
});

describe('optimistic remove', () => {
    it('my reaction leaves the chip at once and the count drops', () => {
        const { send, calls } = controllableSend();
        const base = { '👍': ['other', ME] };
        toggle(store, send, true);
        expect(view(store, base).reactions).toEqual({ '👍': ['other'] });
        expect(calls[0].intent).toBe('remove');
    });

    it('removing the last reaction removes the chip', () => {
        const { send } = controllableSend();
        toggle(store, send, true);
        expect(view(store, { '👍': [ME] }).reactions).toEqual({});
    });

    it('also recognises my reaction stored under my device id', () => {
        const { send } = controllableSend();
        toggle(store, send, true);
        expect(view(store, { '👍': [DEV, 'other'] }).reactions).toEqual({ '👍': ['other'] });
    });
});

describe('success reconciliation (no flicker, no double count)', () => {
    it('HTTP answer then confirmed state: the entry retires only once msg.reactions shows it', async () => {
        const { send, calls } = controllableSend();
        toggle(store, send, false);
        calls[0].resolve();
        await store.idle();
        // Acknowledged, but the confirmed state has not landed yet: the chip must
        // STAY (no flicker back to the old state).
        expect(view(store, undefined).reactions).toEqual({ '👍': [ME] });
        expect(store.forMessage(CONV, MSG)![0].settled).toBe(true);
        // The confirmed state arrives: same chip, and the entry goes away.
        const confirmed = { '👍': [ME] };
        store.reconcile(CONV, () => true);
        expect(store.forMessage(CONV, MSG)).toBeUndefined();
        expect(view(store, confirmed).reactions).toEqual({ '👍': [ME] });
    });

    it('a server echo that beats the HTTP response does not double count', async () => {
        const { send, calls } = controllableSend();
        toggle(store, send, false);
        // Echo / local fold-in lands first: msg.reactions already has me.
        const confirmed = { '👍': ['other', ME] };
        expect(view(store, confirmed).reactions).toEqual({ '👍': ['other', ME] }); // 2, not 3
        store.reconcile(CONV, () => true);
        // Still pending (no HTTP answer): reconcile must not retire it...
        expect(store.forMessage(CONV, MSG)).toHaveLength(1);
        // ...and the late answer settles quietly.
        calls[0].resolve();
        await store.idle();
        expect(view(store, confirmed).reactions).toEqual({ '👍': ['other', ME] });
        store.reconcile(CONV, () => true);
        expect(store.forMessage(CONV, MSG)).toBeUndefined();
    });

    it('the echo being keyed by device id instead of user id is the same reaction', () => {
        const { send } = controllableSend();
        toggle(store, send, false);
        expect(view(store, { '👍': [DEV] }).reactions).toEqual({ '👍': [DEV] });
    });

    it('a removal: echo first, answer later, never reappears', async () => {
        const { send, calls } = controllableSend();
        toggle(store, send, true);
        const confirmed = { '👍': ['other'] }; // the server's remove already folded in
        expect(view(store, confirmed).reactions).toEqual({ '👍': ['other'] });
        calls[0].resolve();
        await store.idle();
        store.reconcile(CONV, () => false);
        expect(store.forMessage(CONV, MSG)).toBeUndefined();
    });

    it('an entry the confirmed state never catches up with is released after the grace period', async () => {
        const { send, calls } = controllableSend();
        toggle(store, send, false);
        calls[0].resolve();
        await store.idle();
        vi.advanceTimersByTime(SETTLED_GRACE_MS + 1);
        expect(store.forMessage(CONV, MSG)).toBeUndefined();
    });
});

describe('failure -> red -> Retry -> success', () => {
    it('a refused add stays on the chip, flagged, with the reason', async () => {
        const { send, calls } = controllableSend();
        toggle(store, send, false);
        calls[0].reject(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }));
        await store.idle();
        const v = view(store, undefined);
        expect(v.reactions).toEqual({ '👍': [ME] });              // still there, counted
        expect(v.failures['👍']).toMatchObject({ kind: 'add', reason: 'No connection' });
        expect(store.get(v.failures['👍'].key)!.state).toBe('failed');
    });

    it('Retry makes it pending again (not red), re-sends, and success settles it', async () => {
        const first = controllableSend();
        toggle(store, first.send, false);
        first.calls[0].reject(new Error('Network Error'));
        await store.idle();
        const key = keyOf(store);
        expect(view(store, undefined).failures['👍']).toBeDefined();

        const second = controllableSend();
        store.retry(key, second.send);
        expect(view(store, undefined).failures).toEqual({});     // no longer red
        expect(second.calls).toHaveLength(1);
        expect(second.calls[0].intent).toBe('add');
        second.calls[0].resolve();
        await store.idle();
        store.reconcile(CONV, () => true);
        expect(store.forMessage(CONV, MSG)).toBeUndefined();
    });

    it('a failed REMOVE restores the chip, flagged "remove"', async () => {
        const { send, calls } = controllableSend();
        const base = { '👍': ['other', ME] };
        toggle(store, send, true);
        expect(view(store, base).reactions).toEqual({ '👍': ['other'] }); // instant removal
        calls[0].reject(new Error('Network Error'));
        await store.idle();
        const v = view(store, base);
        expect(v.reactions).toEqual({ '👍': ['other', ME] });     // restored
        expect(v.failures['👍']).toMatchObject({ kind: 'remove', reason: 'No connection' });
    });

    it('a failed remove, retried, goes through', async () => {
        const first = controllableSend();
        toggle(store, first.send, true);
        first.calls[0].reject(new Error('Network Error'));
        await store.idle();
        const second = controllableSend();
        store.retry(keyOf(store), second.send);
        expect(second.calls[0].intent).toBe('remove');
        second.calls[0].resolve();
        await store.idle();
        store.reconcile(CONV, () => false);
        expect(store.forMessage(CONV, MSG)).toBeUndefined();
    });

    it('Remove on a failed add drops the local reaction entirely', async () => {
        const { send, calls } = controllableSend();
        toggle(store, send, false);
        calls[0].reject(new Error('Network Error'));
        await store.idle();
        store.discard(keyOf(store));
        expect(view(store, undefined).reactions).toBeUndefined();
        expect(store.forMessage(CONV, MSG)).toBeUndefined();
    });

    it('Keep on a failed remove leaves the confirmed reaction exactly as it was', async () => {
        const { send, calls } = controllableSend();
        const base = { '👍': [ME] };
        toggle(store, send, true);
        calls[0].reject(new Error('Network Error'));
        await store.idle();
        store.discard(keyOf(store));
        expect(view(store, base).reactions).toBe(base);
    });

    it('an attempt we gave up on that lands anyway clears the red by itself', async () => {
        const { send, calls } = controllableSend();
        toggle(store, send, false);
        calls[0].reject(new Error('Network Error'));
        await store.idle();
        expect(view(store, undefined).failures['👍']).toBeDefined();
        // The echo of the "failed" send shows up: the server has it.
        store.reconcile(CONV, () => true);
        expect(store.forMessage(CONV, MSG)).toBeUndefined();
    });

    it('a reaction on a message that is gone leaves nothing behind', async () => {
        const { send, calls } = controllableSend();
        toggle(store, send, false);
        calls[0].reject(new Error('boom'));
        await store.idle();
        store.reconcile(CONV, () => undefined);
        expect(store.forMessage(CONV, MSG)).toBeUndefined();
    });
});

describe('timeout', () => {
    it('a send that times out (axios ECONNABORTED) is a failure that reads "Timed out"', async () => {
        const { send, calls } = controllableSend();
        toggle(store, send, false);
        calls[0].reject(Object.assign(new Error('timeout of 20000ms exceeded'), { code: 'ECONNABORTED' }));
        await store.idle();
        expect(view(store, undefined).failures['👍']).toMatchObject({ kind: 'add', reason: 'Timed out' });
    });

    it('unanswered for 10 s -> red, same line as the message "!"; a late answer un-reds it', async () => {
        const { send, calls } = controllableSend();
        toggle(store, send, false);
        vi.advanceTimersByTime(UNDELIVERED_AFTER_MS - 1);
        expect(view(store, undefined).failures).toEqual({});
        vi.advanceTimersByTime(1);
        expect(view(store, undefined).failures['👍']).toMatchObject({ kind: 'add' });
        calls[0].resolve();
        await store.idle();
        expect(view(store, undefined).failures).toEqual({});
    });

    it('a slow chip whose echo already arrived stops being red before the HTTP answer', () => {
        const { send } = controllableSend();
        toggle(store, send, false);
        vi.advanceTimersByTime(UNDELIVERED_AFTER_MS);
        expect(view(store, undefined).failures['👍']).toBeDefined();
        store.reconcile(CONV, () => true);
        expect(view(store, { '👍': [ME] }).failures).toEqual({});
    });

    it('Retry on a stuck attempt abandons it (abort) and starts a fresh clock', () => {
        const first = controllableSend();
        toggle(store, first.send, false);
        vi.advanceTimersByTime(UNDELIVERED_AFTER_MS);
        const second = controllableSend();
        store.retry(keyOf(store), second.send);
        expect(first.calls[0].signal.aborted).toBe(true);
        expect(second.calls).toHaveLength(1);
        expect(view(store, undefined).failures).toEqual({});
        vi.advanceTimersByTime(UNDELIVERED_AFTER_MS - 1);
        expect(view(store, undefined).failures).toEqual({});
        vi.advanceTimersByTime(1);
        expect(view(store, undefined).failures['👍']).toBeDefined();
    });

    it('the abandoned attempt finishing later cannot clobber the retry', async () => {
        const first = controllableSend();
        toggle(store, first.send, false);
        const second = controllableSend();
        store.retry(keyOf(store), second.send);
        first.calls[0].reject(new Error('late failure of the old attempt'));
        await Promise.resolve();
        expect(view(store, undefined).failures).toEqual({});     // not red
        second.calls[0].resolve();
        await store.idle();
        expect(store.forMessage(CONV, MSG)![0].settled).toBe(true);
    });
});

describe('rate limit (429)', () => {
    const tooMany = (retryAfter?: string) => Object.assign(new Error('Request failed with status code 429'), {
        response: { status: 429, headers: retryAfter ? { 'retry-after': retryAfter } : {} },
    });

    it('is a failure with a reason and Retry', async () => {
        const { send, calls } = controllableSend();
        toggle(store, send, false);
        calls[0].reject(tooMany('4'));
        await store.idle();
        expect(view(store, undefined).failures['👍']).toMatchObject({ kind: 'add', reason: 'Sending too fast' });
    });

    it('Retry waits out Retry-After before the request goes out', async () => {
        const first = controllableSend();
        toggle(store, first.send, false);
        first.calls[0].reject(tooMany('4'));
        await store.idle();
        const second = controllableSend();
        store.retry(keyOf(store), second.send);
        expect(second.calls).toHaveLength(0);
        expect(view(store, undefined).failures).toEqual({});     // pending, not red, while waiting
        await vi.advanceTimersByTimeAsync(3999);
        expect(second.calls).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(second.calls).toHaveLength(1);
    });

    it('without a Retry-After header Retry goes out at once', async () => {
        const first = controllableSend();
        toggle(store, first.send, false);
        first.calls[0].reject(tooMany());
        await store.idle();
        const second = controllableSend();
        store.retry(keyOf(store), second.send);
        expect(second.calls).toHaveLength(1);
    });
});

describe('failure reasons', () => {
    it('maps what was thrown to a short reason', () => {
        expect(reactionFailureReason(Object.assign(new Error('x'), { response: { status: 403 } }))).toBe("You don't have permission to react here");
        expect(reactionFailureReason(Object.assign(new Error('x'), { response: { status: 500 } }))).toBe('Server problem');
        expect(reactionFailureReason(Object.assign(new Error('x'), { code: 'ECONNABORTED' }))).toBe('Timed out');
        expect(reactionFailureReason(new Error('weird'))).toBe('Not sent');
    });
});

describe('rapid toggling converges on the final intent', () => {
    it('add -> remove -> add while the first add is out: ONE request, ends added', async () => {
        const { send, calls } = controllableSend();
        toggle(store, send, false);       // add
        toggle(store, send, false);       // remove (baseHas ignored: entry exists)
        expect(view(store, undefined).reactions).toEqual({});                // instant, shows removed
        toggle(store, send, false);       // add again
        expect(view(store, undefined).reactions).toEqual({ '👍': [ME] });
        expect(calls).toHaveLength(1);    // never two in flight for one key
        calls[0].resolve();
        await store.idle();
        expect(calls).toHaveLength(1);    // nothing more to send: add == add
        expect(store.forMessage(CONV, MSG)![0]).toMatchObject({ intent: 'add', confirmed: 'add', settled: true });
    });

    it('add -> remove while the add is out: the remove follows once the add is acknowledged', async () => {
        const { send, calls } = controllableSend();
        toggle(store, send, false);
        toggle(store, send, false);
        expect(calls).toHaveLength(1);
        calls[0].resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toHaveLength(2);
        expect(calls[1].intent).toBe('remove');
        calls[1].resolve();
        await store.idle();
        expect(store.forMessage(CONV, MSG)![0]).toMatchObject({ intent: 'remove', confirmed: 'remove' });
    });

    it('add -> remove when the add FAILS: nothing to undo, the entry just goes away, no red', async () => {
        const { send, calls } = controllableSend();
        toggle(store, send, false);
        toggle(store, send, false);       // remove
        calls[0].reject(new Error('Network Error'));
        await store.idle();
        expect(calls).toHaveLength(1);
        expect(store.forMessage(CONV, MSG)).toBeUndefined();
        expect(view(store, undefined).reactions).toBeUndefined();
    });

    it('clicking a red chip\'s reaction back to the original state just drops the entry', async () => {
        const { send, calls } = controllableSend();
        toggle(store, send, false);
        calls[0].reject(new Error('Network Error'));
        await store.idle();
        toggle(store, send, false);       // flip: intent back to remove == server truth
        expect(calls).toHaveLength(1);    // no request
        expect(store.forMessage(CONV, MSG)).toBeUndefined();
    });

    it('different emoji on one message are independent', () => {
        const { send, calls } = controllableSend();
        toggle(store, send, false, '👍');
        toggle(store, send, false, '🎉');
        expect(calls).toHaveLength(2);
        expect(view(store, undefined).reactions).toEqual({ '👍': [ME], '🎉': [ME] });
    });

    it('fuzz: any click/answer interleaving ends with the server holding exactly the last intent, one request at a time', async () => {
        let seed = 12345;
        const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
        for (let round = 0; round < 200; round++) {
            const s = createReactionStore();
            const baseHad = rnd() < 0.5;
            let serverHas = baseHad;
            let inFlight = 0;
            let maxInFlight = 0;
            const pending: Array<() => void> = [];
            const send: ReactionSend = (intent) => new Promise<void>((resolve) => {
                inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
                pending.push(() => { serverHas = intent === 'add'; inFlight--; resolve(); });
            });
            let want = baseHad;
            const clicks = 1 + Math.floor(rnd() * 8);
            for (let i = 0; i < clicks; i++) {
                s.toggle({ convKey: CONV, msgId: MSG, emoji: '👍', baseHas: baseHad, send });
                want = !want;
                if (rnd() < 0.5 && pending.length) pending.shift()!();
                await Promise.resolve();
            }
            while (pending.length || s.forMessage(CONV, MSG)?.some(e => e.inFlight)) {
                if (pending.length) pending.shift()!();
                await vi.advanceTimersByTimeAsync(0);
            }
            expect(maxInFlight).toBeLessThanOrEqual(1);
            expect(serverHas).toBe(want);
            // And what the user sees is that same final state.
            const seen = applyPendingReactions(baseHad ? { '👍': [ME] } : undefined, s.forMessage(CONV, MSG), MINE, ME).reactions;
            expect(!!seen?.['👍']?.includes(ME)).toBe(want);
        }
    });
});

describe('store plumbing', () => {
    it('forMessage keeps its array identity while that message is untouched, and is scoped by conversation', () => {
        const { send } = controllableSend();
        toggle(store, send, false);
        const a = store.forMessage(CONV, MSG);
        store.toggle({ convKey: CONV, msgId: 'msg-2', emoji: '👍', baseHas: false, send });
        expect(store.forMessage(CONV, MSG)).toBe(a);
        expect(store.forMessage('other-conv', MSG)).toBeUndefined();
        expect(store.hasEntries(CONV)).toBe(true);
        expect(store.hasEntries('other-conv')).toBe(false);
    });

    it('notifies subscribers and bumps the version on every change', () => {
        const { send } = controllableSend();
        const fn = vi.fn();
        const off = store.subscribe(fn);
        const v0 = store.getVersion();
        toggle(store, send, false);
        expect(fn).toHaveBeenCalled();
        expect(store.getVersion()).toBeGreaterThan(v0);
        off();
        fn.mockClear();
        store.discard(keyOf(store));
        expect(fn).not.toHaveBeenCalled();
    });

    it('discarding an in-flight reaction abandons its request', () => {
        const { send, calls } = controllableSend();
        toggle(store, send, false);
        store.discard(keyOf(store));
        expect(calls[0].signal.aborted).toBe(true);
    });
});
