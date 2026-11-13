import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The sharer's side: Spotify only, only with a known non-empty audience,
 * uploaded only when the picture (or the key) changes, never re-tried against
 * an API that predates covers, and what goes up is ciphertext a friend with
 * the key can open.
 */
const mem = new Map<string, string>();
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
};
vi.mock('../secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

const P = await import('./coverPublisher');
const K = await import('./activityKeys');
const { b64ToBytes, decryptCover } = await import('./activityCover');
const { putListening, toPublishBody } = await import('./nowPlaying');
type NowPlaying = import('./nowPlaying').NowPlaying;

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const ART_A = 'data:image/png;base64,AAAA';
const ART_B = 'data:image/png;base64,BBBB';
let t = 1_800_000_000_000;

const playing = (o: Partial<NowPlaying> = {}): NowPlaying => ({
    kind: 'listening', source: 'spotify', title: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine',
    durationMs: 300_000, positionMs: 1000, art: ART_A, player: 'Spotify', ...o,
});

function deps(over: Partial<import('./coverPublisher').CoverPublisherDeps> = {}) {
    const uploads: Array<{ id: string; blob: Uint8Array }> = [];
    const d: import('./coverPublisher').CoverPublisherDeps = {
        upload: async (id, b64) => { uploads.push({ id, blob: b64ToBytes(b64)! }); return 'ok'; },
        downscale: vi.fn(async () => JPEG),
        audience: () => [BOB],
        now: () => t,
        ...over,
    };
    return { d, uploads };
}

beforeEach(() => { mem.clear(); P.resetCoverPublisher(); t += 10 * 60_000; });

describe('what is shared', () => {
    it('Spotify music with a cover: uploads ciphertext a friend holding the key decrypts to the downscaled JPEG', async () => {
        const { d, uploads } = deps();
        const id = await P.prepareCover(playing(), ALICE, d);
        expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(uploads).toHaveLength(1);
        expect(uploads[0].id).toBe(id);
        const key = K.currentActivityKey(ALICE, [BOB], t);
        const out = await decryptCover({ sharerUserId: ALICE, coverId: id!, blob: uploads[0].blob, keyFor: k => (k === key.kid ? key.keyB64 : null) });
        expect(out?.bytes).toEqual(JPEG);
        expect(d.downscale).toHaveBeenCalledWith(ART_A);
    });

    it('nothing for another player, a browser, a video, or no cover', async () => {
        const { d, uploads } = deps();
        for (const p of [playing({ source: 'apple_music' }), playing({ source: 'browser' }), playing({ kind: 'watching', source: 'youtube' }), playing({ art: null })]) {
            expect(await P.prepareCover(p, ALICE, d)).toBeNull();
        }
        expect(uploads).toEqual([]);
    });

    it('nothing while the audience is unknown (friends not loaded) or empty', async () => {
        for (const audience of [() => null, () => []]) {
            const { d, uploads } = deps({ audience });
            expect(await P.prepareCover(playing(), ALICE, d)).toBeNull();
            expect(uploads).toEqual([]);
        }
    });
});

describe('when it uploads', () => {
    it('the same picture is not uploaded again while the server holds it; a new album is', async () => {
        const { d, uploads } = deps();
        const a = await P.prepareCover(playing(), ALICE, d);
        P.confirmCover(a, { listening: { cover_id: a } }, t);
        t += 60_000;
        expect(await P.prepareCover(playing({ title: 'Angel' }), ALICE, d)).toBe(a); // same album, same art
        expect(uploads).toHaveLength(1);
        const b = await P.prepareCover(playing({ art: ART_B }), ALICE, d);
        expect(b).not.toBe(a);
        expect(uploads).toHaveLength(2);
    });

    it('after a lapse longer than the record lifetime it uploads again (the blob may have expired)', async () => {
        const { d, uploads } = deps();
        await P.prepareCover(playing(), ALICE, d);
        t += P.COVER_REUSE_MS;
        await P.prepareCover(playing(), ALICE, d);
        expect(uploads).toHaveLength(2);
    });

    it('the API dropping the id (blob gone) makes the next publish upload again', async () => {
        const { d, uploads } = deps();
        const a = await P.prepareCover(playing(), ALICE, d);
        P.confirmCover(a, { ok: true, listening: { track: 'Teardrop' } }, t);
        await P.prepareCover(playing(), ALICE, d);
        expect(uploads).toHaveLength(2);
    });

    it('a key rotation (a friend removed) re-encrypts under the new key', async () => {
        let audience = [BOB, CAROL];
        const { d, uploads } = deps({ audience: () => audience });
        await P.prepareCover(playing(), ALICE, d);
        // Carol had the key delivered.
        await K.shareActivityKey(ALICE, [BOB, CAROL], [{ userId: CAROL, conversationId: 'c' }], {
            send: async () => 'sent', now: () => t, sleep: async () => {}, newId: () => 'x',
        });
        const before = K.currentActivityKey(ALICE, audience, t).kid;
        audience = [BOB];
        await P.prepareCover(playing(), ALICE, d);
        expect(uploads).toHaveLength(2);
        expect(K.currentActivityKey(ALICE, audience, t).kid).not.toBe(before);
    });

    it('an API from before covers (404 on upload): nothing more is tried this session', async () => {
        const upload = vi.fn(async () => 'gone' as const);
        const { d } = deps({ upload });
        expect(await P.prepareCover(playing(), ALICE, d)).toBeNull();
        expect(await P.prepareCover(playing({ art: ART_B }), ALICE, d)).toBeNull();
        expect(upload).toHaveBeenCalledTimes(1);
        P.resetCoverPublisher();
        await P.prepareCover(playing(), ALICE, d);
        expect(upload).toHaveBeenCalledTimes(2);
    });

    it('a failed upload or an image that cannot be re-encoded: no cover id (the publish goes out without one)', async () => {
        expect(await P.prepareCover(playing(), ALICE, deps({ upload: async () => 'failed' }).d)).toBeNull();
        expect(await P.prepareCover(playing(), ALICE, deps({ downscale: async () => null }).d)).toBeNull();
    });
});

describe('publishing to an OLDER API', () => {
    const err = (status: number) => Object.assign(new Error('x'), { response: { status } });

    it('a 400 on cover_id resends the same body without it and stops sending it', async () => {
        const bodies: Array<Record<string, unknown>> = [];
        const send = async (b: object) => { bodies.push({ ...b }); if ('cover_id' in b) throw err(400); };
        const flags = { artIdRefused: false, watchingRefused: false, mediaIdRefused: false, coverIdRefused: false };
        const body = { ...toPublishBody(playing({ mediaId: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC' })), cover_id: 'AbCdEfGhIjKlMnOpQrStUv' };
        expect(await putListening(send, body, flags)).toEqual({ ok: true });
        expect(flags).toMatchObject({ coverIdRefused: true, mediaIdRefused: false });
        expect(bodies[1]).not.toHaveProperty('cover_id');
        expect(bodies[1]).toHaveProperty('media_id');
        // Next time it is never sent.
        bodies.length = 0;
        await putListening(send, body, flags);
        expect(bodies).toHaveLength(1);
        expect(bodies[0]).not.toHaveProperty('cover_id');
    });

    it('toPublishBody never adds cover_id itself (the cover is never sent as part of the record)', () => {
        expect(toPublishBody(playing())).not.toHaveProperty('cover_id');
        expect(JSON.stringify(toPublishBody(playing()))).not.toContain('data:image');
    });
});
