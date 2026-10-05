import { describe, it, expect } from 'vitest';
import { pinKey, type PinnedHomeItem } from './homePins';

// pinKey is the identity used for BOTH dedupe (handlePinToHome) and removal
// (handleUnpinFromHome). If two different pins can ever produce the same key,
// pinning one silently refuses, or unpinning one removes the other.
describe('pinKey', () => {
    it('is stable for the same item', () => {
        const a: PinnedHomeItem = { type: 'channel', channelId: 'c1', serverId: 's1' };
        expect(pinKey(a)).toBe(pinKey({ ...a }));
    });

    it('does not collide across types that share an id', () => {
        // The realistic collision: a server and a conversation whose ids match,
        // or a channel pinned from the server with the same id string.
        const id = 'same-id';
        const keys = [
            pinKey({ type: 'conversation', id }),
            pinKey({ type: 'server', serverId: id }),
            pinKey({ type: 'channel', channelId: id, serverId: 'other' }),
        ];
        expect(new Set(keys).size).toBe(3);
    });

    it('ignores serverId for channel identity', () => {
        // A channel id is globally unique, and the pin is resolved by channel.
        // Keying on both would let the same channel be pinned twice if the
        // stored serverId ever drifted (e.g. a stale pin after a move).
        expect(pinKey({ type: 'channel', channelId: 'c1', serverId: 's1' }))
            .toBe(pinKey({ type: 'channel', channelId: 'c1', serverId: 's2' }));
    });

    it('distinguishes different items of the same type', () => {
        expect(pinKey({ type: 'server', serverId: 's1' }))
            .not.toBe(pinKey({ type: 'server', serverId: 's2' }));
        expect(pinKey({ type: 'conversation', id: 'a' }))
            .not.toBe(pinKey({ type: 'conversation', id: 'b' }));
    });

    it('supports dedupe and removal the way the handlers use it', () => {
        const list: PinnedHomeItem[] = [
            { type: 'server', serverId: 's1' },
            { type: 'conversation', id: 'conv-1' },
            { type: 'channel', channelId: 'chn-1', serverId: 's1' },
        ];
        const dup: PinnedHomeItem = { type: 'conversation', id: 'conv-1' };
        expect(list.some(p => pinKey(p) === pinKey(dup))).toBe(true);

        const removed = list.filter(p => pinKey(p) !== pinKey({ type: 'server', serverId: 's1' }));
        expect(removed).toHaveLength(2);
        expect(removed.some(p => p.type === 'server')).toBe(false);
    });
});
