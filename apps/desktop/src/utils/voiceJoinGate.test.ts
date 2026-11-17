import { describe, it, expect } from 'vitest';
import { Permissions } from '@cipherline/shared';
import { canJoinVoice } from './voiceJoinGate';

const p = (b: bigint) => ({ my_permissions: b.toString() });

describe('canJoinVoice', () => {
    it('allows VIEW_CHANNEL + CONNECT', () => {
        expect(canJoinVoice(p(Permissions.VIEW_CHANNEL | Permissions.CONNECT))).toBe(true);
    });
    it('denies view-only (the reported bug)', () => {
        expect(canJoinVoice(p(Permissions.VIEW_CHANNEL))).toBe(false);
    });
    it('denies CONNECT without VIEW_CHANNEL (server requires both)', () => {
        expect(canJoinVoice(p(Permissions.CONNECT))).toBe(false);
    });
    it('denies zero permissions', () => {
        expect(canJoinVoice(p(0n))).toBe(false);
    });
    it('ignores unrelated extra bits', () => {
        expect(canJoinVoice(p(Permissions.VIEW_CHANNEL | Permissions.CONNECT | Permissions.SEND_MESSAGES))).toBe(true);
    });
    it('is optimistic when permissions are not loaded / unknown channel', () => {
        expect(canJoinVoice(undefined)).toBe(true);
        expect(canJoinVoice(null)).toBe(true);
        expect(canJoinVoice({})).toBe(true);
        expect(canJoinVoice({ my_permissions: null })).toBe(true);
        expect(canJoinVoice({ my_permissions: '' })).toBe(true);
    });
    it('is optimistic on an unparsable value rather than hiding Join', () => {
        expect(canJoinVoice({ my_permissions: 'not-a-number' })).toBe(true);
    });
});
