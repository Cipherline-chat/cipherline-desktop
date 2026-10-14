import { describe, it, expect } from 'vitest';
import { Permissions } from '@cipherline/shared';
import {
    canStartCallsIn,
    isJoinOnlyIn,
    isStartCallsDenied,
    START_CALLS_DENIED_MESSAGE,
} from './startCallsGate';

const { VIEW_CHANNEL, CONNECT, START_CALLS } = Permissions;
const bits = (b: bigint) => b.toString(10);

describe('canStartCallsIn — the Start button gate (UX mirror)', () => {
    it.each([
        // label, row, expected
        ['new API, allowed', { my_permissions: bits(VIEW_CHANNEL | CONNECT | START_CALLS), can_start_call: true }, true],
        ['new API, join-only', { my_permissions: bits(VIEW_CHANNEL | CONNECT), can_start_call: false }, false],
        ['new API says no even if the bit is somehow present', { my_permissions: bits(VIEW_CHANNEL | CONNECT | START_CALLS), can_start_call: false }, false],
        // An API that predates START_CALLS never sends the field or the bit:
        // the old rule (start == connect) must hold, or Start would be greyed
        // out for every member on that server.
        ['older API, can connect', { my_permissions: bits(VIEW_CHANNEL | CONNECT) }, true],
        ['older API, cannot connect', { my_permissions: bits(VIEW_CHANNEL) }, false],
        ['older API, cannot view', { my_permissions: bits(CONNECT) }, false],
        ['not loaded yet', { my_permissions: undefined }, true],
        ['garbage permissions', { my_permissions: 'nope' }, true],
    ] as const)('%s', (_label, row, expected) => {
        expect(canStartCallsIn(row)).toBe(expected);
    });

    it('unknown channel is optimistic — the server still decides', () => {
        expect(canStartCallsIn(undefined)).toBe(true);
    });
});

describe('isJoinOnlyIn — disabled-with-tooltip, not locked', () => {
    it('join-only = can connect, may not start', () => {
        expect(isJoinOnlyIn({ my_permissions: bits(VIEW_CHANNEL | CONNECT), can_start_call: false })).toBe(true);
    });
    it('cannot connect at all is the LOCK state, not join-only', () => {
        expect(isJoinOnlyIn({ my_permissions: bits(VIEW_CHANNEL), can_start_call: false })).toBe(false);
    });
    it('can start → not join-only; older API → never join-only', () => {
        expect(isJoinOnlyIn({ my_permissions: bits(VIEW_CHANNEL | CONNECT | START_CALLS), can_start_call: true })).toBe(false);
        expect(isJoinOnlyIn({ my_permissions: bits(VIEW_CHANNEL | CONNECT) })).toBe(false);
    });
    it('not loaded → not join-only', () => {
        expect(isJoinOnlyIn({ can_start_call: false })).toBe(false);
        expect(isJoinOnlyIn(undefined)).toBe(false);
    });
});

describe('isStartCallsDenied — recognises the server\'s 403', () => {
    const body = { statusCode: 403, error: 'Forbidden', code: 'missing_permission', permission: 'START_CALLS', message: START_CALLS_DENIED_MESSAGE };
    it('matches the exact contract', () => {
        expect(isStartCallsDenied({ response: { status: 403, data: body } })).toBe(true);
    });
    it.each([
        ['generic 403', { response: { status: 403, data: { message: 'You lack the required permission for this action' } } }],
        ['other permission', { response: { status: 403, data: { ...body, permission: 'CONNECT' } } }],
        ['wrong status', { response: { status: 400, data: body } }],
        ['no response (network)', new Error('timeout')],
        ['null', null],
    ])('%s → false', (_l, err) => {
        expect(isStartCallsDenied(err)).toBe(false);
    });
});
