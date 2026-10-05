import { describe, it, expect, vi } from 'vitest';
import {
    applyPresenceEvent,
    presenceBus,
    resolvePresence,
    normalizeStatus,
    type PresenceEvent,
} from './presenceState';
import type { FriendStatusEntry } from './userStatusModel';

const A = 'user-a';
const B = 'user-b';
const C = 'user-c';

const entry = (status: FriendStatusEntry['status'], o: Partial<FriendStatusEntry> = {}): FriendStatusEntry => ({
    status, custom_status_text: null, custom_status_emoji: null, current_game: null, on_mobile: false, ...o,
});

describe('applyPresenceEvent', () => {
    it('a BURST of changes all land — the one-slot state this replaces kept only the last', () => {
        // What a server deploy looks like to a client: many users flip in the
        // same instant. Applied through the reducer, in order, none is lost.
        const events: PresenceEvent[] = [
            { kind: 'changed', entry: { user_id: A, status: 'offline' } },
            { kind: 'changed', entry: { user_id: B, status: 'offline' } },
            { kind: 'changed', entry: { user_id: C, status: 'dnd' } },
        ];
        const start = { [A]: entry('online'), [B]: entry('online'), [C]: entry('online') };
        const end = events.reduce(applyPresenceEvent, start);
        expect(end[A].status).toBe('offline');
        expect(end[B].status).toBe('offline');
        expect(end[C].status).toBe('dnd');
    });

    it('carries on_mobile, and never for an offline entry', () => {
        let s = applyPresenceEvent({}, { kind: 'changed', entry: { user_id: A, status: 'online', on_mobile: true } });
        expect(s[A].on_mobile).toBe(true);
        s = applyPresenceEvent(s, { kind: 'changed', entry: { user_id: A, status: 'offline', on_mobile: true } });
        expect(s[A]).toEqual(entry('offline'));
    });

    it('an offline entry carries no custom status or game (nothing to show about someone who is not here)', () => {
        const s = applyPresenceEvent({}, {
            kind: 'changed',
            entry: { user_id: A, status: 'offline', custom_status_text: 'x', custom_status_emoji: 'y', game_name: 'z' },
        });
        expect(s[A]).toEqual(entry('offline'));
    });

    it('an older server (no on_mobile field) reads as not-on-mobile', () => {
        const s = applyPresenceEvent({}, { kind: 'changed', entry: { user_id: A, status: 'online' } });
        expect(s[A].on_mobile).toBe(false);
    });

    it('an unknown status string never renders as present', () => {
        expect(normalizeStatus('invisible')).toBe('offline');
        expect(normalizeStatus(undefined)).toBe('offline');
        const s = applyPresenceEvent({}, { kind: 'changed', entry: { user_id: A, status: 'invisible' } });
        expect(s[A].status).toBe('offline');
    });

    it('a complete snapshot marks everyone we know but it does not list as offline', () => {
        // B changed while our connection was down and we never heard; the
        // snapshot's silence about B is the correction.
        const prev = { [A]: entry('online'), [B]: entry('dnd'), [C]: entry('away') };
        const next = applyPresenceEvent(prev, {
            kind: 'snapshot', complete: true,
            entries: [{ user_id: A, status: 'online', on_mobile: true }, { user_id: C, status: 'away' }],
        });
        expect(next[A]).toEqual(entry('online', { on_mobile: true }));
        expect(next[B]).toEqual(entry('offline'));
        expect(next[C]).toEqual(entry('away'));
    });

    it('a snapshot that is NOT marked complete, and the friends batch, correct only who they list', () => {
        const prev = { [A]: entry('online'), [B]: entry('dnd') };
        const partial = applyPresenceEvent(prev, { kind: 'snapshot', complete: false, entries: [{ user_id: A, status: 'away' }] });
        expect(partial[B].status).toBe('dnd');
        const batch = applyPresenceEvent(prev, { kind: 'friends_batch', entries: [{ user_id: A, status: 'away' }] });
        expect(batch[A].status).toBe('away');
        expect(batch[B].status).toBe('dnd');
    });

    it('returns the SAME object when nothing changed, so React does not re-render', () => {
        const prev = { [A]: entry('online') };
        expect(applyPresenceEvent(prev, { kind: 'changed', entry: { user_id: A, status: 'online' } })).toBe(prev);
        expect(applyPresenceEvent(prev, { kind: 'snapshot', complete: true, entries: [{ user_id: A, status: 'online' }] })).toBe(prev);
    });
});

describe('presenceBus', () => {
    it('delivers every event of a synchronous burst, in order', () => {
        const seen: string[] = [];
        const off = presenceBus.subscribe(ev => { if (ev.kind === 'changed') seen.push(ev.entry.user_id); });
        presenceBus.emit({ kind: 'changed', entry: { user_id: A, status: 'online' } });
        presenceBus.emit({ kind: 'changed', entry: { user_id: B, status: 'online' } });
        presenceBus.emit({ kind: 'changed', entry: { user_id: C, status: 'online' } });
        off();
        presenceBus.emit({ kind: 'changed', entry: { user_id: 'after-unsubscribe', status: 'online' } });
        expect(seen).toEqual([A, B, C]);
    });

    it('one failing listener does not starve the others', () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const good = vi.fn();
        const off1 = presenceBus.subscribe(() => { throw new Error('boom'); });
        const off2 = presenceBus.subscribe(good);
        presenceBus.emit({ kind: 'changed', entry: { user_id: A, status: 'online' } });
        off1(); off2();
        expect(good).toHaveBeenCalledTimes(1);
        err.mockRestore();
    });
});

describe('resolvePresence', () => {
    it('a live entry wins over the roster', () => {
        expect(resolvePresence(entry('dnd', { on_mobile: true }), { status: 'online' }, false))
            .toEqual({ status: 'dnd', onMobile: true });
    });

    it('before any snapshot, the roster fallback is used (older servers)', () => {
        expect(resolvePresence(undefined, { status: 'online', on_mobile: true }, false))
            .toEqual({ status: 'online', onMobile: true });
    });

    it('after a complete snapshot, an unknown member is offline — a stale roster "online" is ignored', () => {
        expect(resolvePresence(undefined, { status: 'online', on_mobile: true }, true))
            .toEqual({ status: 'offline', onMobile: false });
    });

    it('on_mobile is never reported for an offline status', () => {
        expect(resolvePresence(entry('offline', { on_mobile: true }), undefined, true))
            .toEqual({ status: 'offline', onMobile: false });
        expect(resolvePresence(undefined, { status: 'offline', on_mobile: true }, false))
            .toEqual({ status: 'offline', onMobile: false });
    });
});
