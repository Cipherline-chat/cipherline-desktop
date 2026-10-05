import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The two preload lanes, as promises rather than as an app.
 *
 * What is pinned here is the stuff that stops warming from turning into a boot
 * request storm, and the stuff that stops it from slowing down the thing it
 * exists to speed up:
 *   - the 6-at-a-time cap is process-wide, not per `preloadAvatars` call;
 *   - the same avatar asked for twice is one network pass;
 *   - background work joins foreground work, but never the other way round;
 *   - the rate budget is claimed only when a load really goes to the network.
 */

// ── Controllable network ─────────────────────────────────────────────────────
// One id can legitimately have MORE than one request outstanding (that is the
// whole point of the priority-inversion test), so this holds a LIST per id —
// keeping a single deferred silently stranded the first caller forever.
const pendingKeyRequests = new Map<string, Array<(v: unknown) => void>>();
let keyUrls: string[] = [];
/** ids whose /key call should hang until the test releases it. */
const hangingKeys = new Set<string>();

const idFromUrl = (u: string) => u.split('/attachments/')[1]?.split('/')[0] ?? '';

const axiosGet = vi.fn(async (u: string) => {
    if (u.includes('/key')) {
        keyUrls.push(u);
        const id = idFromUrl(u);
        if (hangingKeys.has(id)) {
            await new Promise(res => {
                const waiters = pendingKeyRequests.get(id) ?? [];
                waiters.push(res);
                pendingKeyRequests.set(id, waiters);
            });
        }
        return { data: { file_key_b64: 'K', file_nonce_b64: 'N' } };
    }
    if (u.includes('/download')) return { data: { download_url: 'https://media/x', mime_type: 'image/png' } };
    if (u.startsWith('https://media')) return { data: new Blob(['cipher']) };
    throw new Error('unexpected ' + u);
});
vi.mock('axios', () => ({ default: { get: (...a: unknown[]) => axiosGet(...(a as [string])) } }));

vi.mock('../utils/avatarKeyStore', () => ({
    loadAvatarKey: async () => null,
    saveAvatarKey: async () => true,
    deleteAvatarKey: async () => {},
}));

// ── Controllable IndexedDB tier ──────────────────────────────────────────────
const idbHits = new Set<string>();
vi.mock('../utils/attachmentCache', () => ({
    getAvatarBlob: async (id: string) => (idbHits.has(id) ? new Blob(['plain']) : null),
    putAvatarBlob: async () => {},
    deleteAvatarBlob: async () => {},
}));

vi.mock('../utils/crypto', () => ({
    importKeyFromBase64: async () => ({}),
    decryptBlob: async () => new Blob(['plain']),
}));

vi.mock('../contexts/HydrationContext', () => ({ useHydrationGeneration: () => 0 }));

import {
    preloadAvatars,
    preloadAvatarsBackground,
    preloadAvatar,
    __preloadInFlightCount,
    __warmNetworkClaims,
    __preloadTuning,
} from './useEncryptedAvatar';

const TOKEN = 't';
/** Let queued microtasks and the mocked async cache reads settle. */
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };
const keyCallsFor = (id: string) => keyUrls.filter(u => idFromUrl(u) === id).length;
const releaseKey = (id: string) => {
    const waiters = pendingKeyRequests.get(id) ?? [];
    pendingKeyRequests.set(id, []);
    for (const resolve of waiters) resolve(undefined);
};

beforeEach(() => {
    keyUrls = [];
    pendingKeyRequests.clear();
    hangingKeys.clear();
    idbHits.clear();
    axiosGet.mockClear();
    (globalThis as { URL: typeof URL }).URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`);
    (globalThis as { URL: typeof URL }).URL.revokeObjectURL = vi.fn();
});

describe('the 6-at-a-time cap is process-wide', () => {
    it('two concurrent preloadAvatars calls share ONE pool of 6, not six each', async () => {
        const batchA = ['A1', 'A2', 'A3', 'A4', 'A5'];
        const batchB = ['B1', 'B2', 'B3', 'B4', 'B5'];
        for (const id of [...batchA, ...batchB]) hangingKeys.add(id);

        const a = preloadAvatars(batchA, TOKEN, 60_000);
        const b = preloadAvatars(batchB, TOKEN, 60_000);
        await settle();

        // The pre-change worker pool was per call: this was 10.
        expect(keyUrls).toHaveLength(__preloadTuning.MAX_CONCURRENT_PRELOADS);
        expect(__preloadInFlightCount()).toBe(__preloadTuning.MAX_CONCURRENT_PRELOADS);

        for (const id of [...batchA, ...batchB]) releaseKey(id);
        await settle();
        for (const id of [...batchA, ...batchB]) releaseKey(id);
        await Promise.all([a, b]);

        // Everything still gets done — the cap delays, it never drops work.
        expect(keyUrls).toHaveLength(10);
        expect(__preloadInFlightCount()).toBe(0);
    });
});

describe('deduplication', () => {
    it('the same id requested twice concurrently is ONE network pass', async () => {
        hangingKeys.add('DUP1');
        const first = preloadAvatar('DUP1', TOKEN);
        const second = preloadAvatar('DUP1', TOKEN);
        await settle();
        expect(keyCallsFor('DUP1')).toBe(1);
        releaseKey('DUP1');
        await Promise.all([first, second]);
        expect(keyCallsFor('DUP1')).toBe(1);
    });

    it('a background warm JOINS an in-flight foreground load instead of racing it', async () => {
        hangingKeys.add('JOIN1');
        const claimsBefore = __warmNetworkClaims();

        const foreground = preloadAvatar('JOIN1', TOKEN);
        await settle();
        const background = preloadAvatarsBackground(['JOIN1'], TOKEN);
        await settle();

        expect(keyCallsFor('JOIN1')).toBe(1);
        // And it did not spend a rate token for a request it never made.
        expect(__warmNetworkClaims()).toBe(claimsBefore);

        releaseKey('JOIN1');
        await Promise.all([foreground, background]);
        expect(keyCallsFor('JOIN1')).toBe(1);
    });

    it('a foreground load does NOT join an in-flight background warm', async () => {
        // The priority inversion this prevents: a background warm can be parked
        // in the rate budget for seconds by design. An avatar that just mounted
        // must not inherit that wait, even at the cost of fetching it twice.
        hangingKeys.add('INV1');
        const background = preloadAvatarsBackground(['INV1'], TOKEN);
        await settle();
        expect(keyCallsFor('INV1')).toBe(1);

        const foreground = preloadAvatar('INV1', TOKEN);
        await settle();
        expect(keyCallsFor('INV1')).toBe(2);

        releaseKey('INV1');
        await settle();
        releaseKey('INV1');
        await Promise.all([background, foreground]);
    });
});

describe('the background rate budget is charged only for real requests', () => {
    it('an IndexedDB hit warms for free; only the cold one claims a token', async () => {
        idbHits.add('CACHED1');
        idbHits.add('CACHED2');
        const claimsBefore = __warmNetworkClaims();

        await preloadAvatarsBackground(['CACHED1', 'CACHED2', 'COLD1'], TOKEN);

        expect(__warmNetworkClaims()).toBe(claimsBefore + 1);
        expect(keyCallsFor('CACHED1')).toBe(0);
        expect(keyCallsFor('CACHED2')).toBe(0);
        expect(keyCallsFor('COLD1')).toBe(1);
    });

    it('a foreground preload is never rate-paced', async () => {
        const claimsBefore = __warmNetworkClaims();
        await preloadAvatars(['FG1', 'FG2'], TOKEN, 60_000);
        expect(__warmNetworkClaims()).toBe(claimsBefore);
        expect(keyCallsFor('FG1')).toBe(1);
    });

    it('an id already in the session memory cache costs nothing on either lane', async () => {
        await preloadAvatars(['MEM1'], TOKEN, 60_000);
        expect(keyCallsFor('MEM1')).toBe(1);
        const claimsBefore = __warmNetworkClaims();

        await preloadAvatars(['MEM1'], TOKEN, 60_000);
        await preloadAvatarsBackground(['MEM1'], TOKEN);

        expect(keyCallsFor('MEM1')).toBe(1);
        expect(__warmNetworkClaims()).toBe(claimsBefore);
    });
});

describe('input guards', () => {
    it('ignores blob:, data: and remote URLs — they are not attachment ids', async () => {
        await preloadAvatars(['blob:x', 'data:image/png;base64,AA', 'https://example.com/a.png'], TOKEN, 60_000);
        expect(axiosGet).not.toHaveBeenCalled();
    });

    it('does nothing without a token', async () => {
        await preloadAvatars(['NOTOKEN1'], '', 60_000);
        await preloadAvatarsBackground(['NOTOKEN2'], '');
        expect(axiosGet).not.toHaveBeenCalled();
    });
});
