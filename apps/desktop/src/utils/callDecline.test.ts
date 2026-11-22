import { describe, it, expect, vi } from 'vitest';
import { declineCallOnServer } from './callDecline';

describe('declineCallOnServer', () => {
    it('posts the decline with the bearer token and this device id', () => {
        const post = vi.fn(async (_u: string, _b: unknown, _c: { headers: Record<string, string> }) => ({}));
        declineCallOnServer({ post }, '/v1/calls/abc/decline', 'tok', 'dev-1');
        expect(post).toHaveBeenCalledWith('/v1/calls/abc/decline', {}, { headers: { Authorization: 'Bearer tok', 'x-device-id': 'dev-1' } });
    });
    it('omits the device header when there is no device id', () => {
        const post = vi.fn(async (_u: string, _b: unknown, _c: { headers: Record<string, string> }) => ({}));
        declineCallOnServer({ post }, '/u', 'tok', null);
        expect(post.mock.calls[0][2].headers).toEqual({ Authorization: 'Bearer tok' });
    });
    it('sends nothing without a token', () => {
        const post = vi.fn(async (_u: string, _b: unknown, _c: { headers: Record<string, string> }) => ({}));
        declineCallOnServer({ post }, '/u', null, 'd');
        expect(post).not.toHaveBeenCalled();
    });
    it('a rejected request (offline, 403, an old server) is swallowed', async () => {
        const post = vi.fn(async (_u: string, _b: unknown, _c: { headers: Record<string, string> }): Promise<unknown> => { throw new Error('404'); });
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        declineCallOnServer({ post }, '/u', 't', 'd');
        await new Promise((r) => setTimeout(r, 10));
        process.off('unhandledRejection', unhandled);
        expect(post).toHaveBeenCalled();
        expect(unhandled).not.toHaveBeenCalled();
    });
});
