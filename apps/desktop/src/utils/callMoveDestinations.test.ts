import { describe, it, expect } from 'vitest';
import { listMoveDestinations, PRIVATE_HINT, type MoveDestinationInput } from './callMoveDestinations';

// Owner rule (2026-10-24): a moderator may move someone into any call the
// MODERATOR can join — the target's own access is not consulted.

const PUB = 'pub', PRIV = 'priv', EMPTY_PRIV = 'empty-priv', EMPTY_PUB = 'empty-pub', LOCKED = 'locked';
const T = 'target', X = 'someone';

function input(over: Partial<MoveDestinationInput> = {}): MoveDestinationInput {
    const calls = [
        { call_id: 'c-src', huddle_id: PUB, name: 'Lobby', participants: [T] },
        { call_id: 'c-priv', huddle_id: PRIV, name: 'Staff', participants: [X] },
        { call_id: 'c-locked', huddle_id: LOCKED, name: 'Board', participants: [X] },
    ];
    return {
        targetUserId: T,
        calls,
        channels: [
            { channel_id: PUB, name: 'General', kind: 'huddle', view_scope: 'all' },
            { channel_id: PRIV, name: 'Mods', kind: 'huddle', view_scope: 'restricted' },
            { channel_id: EMPTY_PRIV, name: 'Quiet room', kind: 'huddle', view_scope: 'restricted' },
            { channel_id: EMPTY_PUB, name: 'Open room', kind: 'huddle', view_scope: 'all' },
            { channel_id: LOCKED, name: 'Board', kind: 'huddle', view_scope: 'restricted' },
            { channel_id: 'txt', name: 'chat', kind: 'text' },
        ],
        callsByChannel: { [PUB]: [calls[0]], [PRIV]: [calls[1]], [LOCKED]: [calls[2]] },
        // The viewer can join everything except LOCKED.
        canConnect: id => id !== LOCKED,
        canStartCalls: () => true,
        ...over,
    };
}

describe('listMoveDestinations', () => {
    it('lists every call and empty Calls channel the VIEWER can join, private ones included', () => {
        const d = listMoveDestinations(input());
        expect(d.map(x => (x.kind === 'call' ? x.callId : `new:${x.huddleId}`))).toEqual([
            'c-priv', `new:${EMPTY_PRIV}`, `new:${EMPTY_PUB}`,
        ]);
    });

    it('is not filtered by the target — the input carries no target permissions at all', () => {
        // Same result whoever is moved: the function has no way to ask about
        // the target's access, by construction. Moving X instead of T changes
        // only which call is the SOURCE.
        const forT = listMoveDestinations(input()).map(x => x.label);
        const forX = listMoveDestinations(input({ targetUserId: X })).map(x => x.label);
        expect(forT).toContain(`Staff · Mods ${PRIVATE_HINT}`);
        expect(forX).toContain(`Lobby · General`);
    });

    it('marks private (restricted) channels with a hint, and only those', () => {
        const d = listMoveDestinations(input());
        expect(d.find(x => x.kind === 'call' && x.callId === 'c-priv')).toMatchObject({ restricted: true, label: `Staff · Mods ${PRIVATE_HINT}` });
        expect(d.find(x => x.kind === 'huddle' && x.huddleId === EMPTY_PRIV)).toMatchObject({ restricted: true, label: `New call in Quiet room ${PRIVATE_HINT}` });
        expect(d.find(x => x.kind === 'huddle' && x.huddleId === EMPTY_PUB)).toMatchObject({ restricted: false, label: 'New call in Open room' });
    });

    it('omits channels the VIEWER cannot join, and empty channels where they cannot start a call', () => {
        const d = listMoveDestinations(input({ canStartCalls: id => id !== EMPTY_PRIV }));
        expect(d.some(x => x.kind === 'call' && x.callId === 'c-locked')).toBe(false);
        expect(d.some(x => x.kind === 'huddle' && x.huddleId === EMPTY_PRIV)).toBe(false);
        expect(d.some(x => x.kind === 'huddle' && x.huddleId === EMPTY_PUB)).toBe(true);
    });

    it('never offers the call they are already in, nor a channel that already has a call', () => {
        const d = listMoveDestinations(input());
        expect(d.some(x => x.kind === 'call' && x.callId === 'c-src')).toBe(false);
        expect(d.some(x => x.kind === 'huddle' && x.huddleId === PUB)).toBe(false);
    });

    it('returns nothing for someone who is not in a call', () => {
        expect(listMoveDestinations(input({ targetUserId: 'nobody' }))).toEqual([]);
    });
});
