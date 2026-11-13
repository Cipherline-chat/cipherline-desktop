import { describe, it, expect, vi, beforeEach } from 'vitest';

// The API's catalog, as an older or newer server would have it.
const server = { known: new Set<string>(), puts: [] as string[][] };

vi.mock('axios', () => {
    const put = vi.fn(async (_url: string, body: { ids: string[] }) => {
        server.puts.push(body.ids);
        if (body.ids.some(id => !server.known.has(id))) {
            throw Object.assign(new Error('400'), { isAxiosError: true, response: { status: 400 } });
        }
        return { data: { unlocked: body.ids.map(id => ({ id, month: '2026-11' })) } };
    });
    return { default: { put, isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError } };
});
vi.mock('../utils/secureLocalStore', () => ({ default: { getItem: () => null, setItem: () => undefined }, secureLocalStore: { getItem: () => null, setItem: () => undefined } }));

const { pushUnlockedIds } = await import('./achievementsSyncEnv');

describe('pushUnlockedIds against an API that predates the starter achievements', () => {
    beforeEach(() => { server.puts = []; });

    it('a current API takes the whole set in one request', async () => {
        server.known = new Set(['voice-100h', 'msgs-10', 'profile-custom']);
        const got = await pushUnlockedIds('t', ['voice-100h', 'msgs-10', 'profile-custom']);
        expect(got?.map(u => u.id)).toEqual(['voice-100h', 'msgs-10', 'profile-custom']);
        expect(server.puts).toHaveLength(1);
    });

    it('an older API (400 on the starters) still gets the older ids, and only the starters are held back', async () => {
        server.known = new Set(['voice-100h', 'fleet']);
        const got = await pushUnlockedIds('t', ['voice-100h', 'msgs-10', 'fleet', 'profile-custom']);
        expect(server.puts).toEqual([['voice-100h', 'msgs-10', 'fleet', 'profile-custom'], ['voice-100h', 'fleet']]);
        expect(got?.map(u => u.id)).toEqual(['voice-100h', 'fleet']);
    });

    it('only starters, older API: one request, null (nothing to fall back to, retried later)', async () => {
        server.known = new Set(['voice-100h']);
        expect(await pushUnlockedIds('t', ['msgs-10'])).toBeNull();
        expect(server.puts).toHaveLength(1);
    });

    it('a 400 that is not about the starters is not retried', async () => {
        server.known = new Set([]);
        expect(await pushUnlockedIds('t', ['voice-100h', 'fleet'])).toBeNull();
        expect(server.puts).toHaveLength(1);
    });
});
