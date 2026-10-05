import { describe, it, expect } from 'vitest';
import { compareRecent, pickRecent } from './homeRecents';

/** Minimal rankable with a label so assertions read as order, not objects. */
const item = (id: string, attention: number, activity: number) => ({ id, attention, activity });

describe('compareRecent', () => {
    it('ranks attention above recency', () => {
        const stale = item('mentioned-you-last-week', 2, 1);
        const fresh = item('quiet-but-just-now', 0, 9_999);
        expect([fresh, stale].sort(compareRecent)[0]).toBe(stale);
    });

    it('falls back to recency within an attention tier', () => {
        const older = item('older', 1, 100);
        const newer = item('newer', 1, 200);
        expect([older, newer].sort(compareRecent)[0]).toBe(newer);
    });
});

describe('pickRecent', () => {
    it('the decisive case: servers still appear when conversations could fill the grid', () => {
        // 12 busy conversations against 3 servers the user has not opened this
        // session (activity 0, because no channel messages are cached). A
        // straight top-8 of the union puts zero servers on screen — which is
        // exactly how "Pick back up" ended up listing no servers at all.
        const convs = Array.from({ length: 12 }, (_, i) => item(`conv${i}`, 1, 1_000 - i));
        const servers = Array.from({ length: 3 }, (_, i) => item(`srv${i}`, 0, 0));

        const picked = pickRecent(convs, servers);
        expect(picked).toHaveLength(8);
        expect(picked.filter(p => p.id.startsWith('srv'))).toHaveLength(3);
        expect(picked.filter(p => p.id.startsWith('conv'))).toHaveLength(5);
    });

    it('never reserves more than half the grid for servers', () => {
        const convs = Array.from({ length: 8 }, (_, i) => item(`conv${i}`, 0, 100 - i));
        const servers = Array.from({ length: 20 }, (_, i) => item(`srv${i}`, 0, 50 - i));

        const picked = pickRecent(convs, servers);
        expect(picked).toHaveLength(8);
        expect(picked.filter(p => p.id.startsWith('srv'))).toHaveLength(4);
    });

    it('hands unclaimed server slots back to conversations', () => {
        const convs = Array.from({ length: 10 }, (_, i) => item(`conv${i}`, 0, 100 - i));
        const picked = pickRecent(convs, [item('srv0', 0, 5)]);
        expect(picked).toHaveLength(8);
        expect(picked.filter(p => p.id.startsWith('conv'))).toHaveLength(7);
    });

    it('orders the survivors together, not conversations-then-servers', () => {
        const convs = [item('quiet-conv', 0, 10)];
        const servers = [item('server-that-mentioned-you', 2, 1)];
        expect(pickRecent(convs, servers).map(p => p.id))
            .toEqual(['server-that-mentioned-you', 'quiet-conv']);
    });

    it('does not mutate the input arrays', () => {
        const convs = [item('b', 0, 1), item('a', 0, 2)];
        const servers = [item('d', 0, 1), item('c', 0, 2)];
        pickRecent(convs, servers);
        expect(convs.map(c => c.id)).toEqual(['b', 'a']);
        expect(servers.map(s => s.id)).toEqual(['d', 'c']);
    });

    it('handles an empty deck', () => {
        expect(pickRecent([], [])).toEqual([]);
    });
});
