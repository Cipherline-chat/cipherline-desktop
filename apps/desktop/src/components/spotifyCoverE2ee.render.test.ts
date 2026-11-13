// @vitest-environment jsdom
/**
 * Friends' END-TO-END ENCRYPTED Spotify covers on the profile surfaces:
 *  - a friend's Spotify record shows THEIR cover, fetched as ciphertext and
 *    decrypted on this device, and it can be reported (with the evidence);
 *  - another player, or no key on this device: the catalogue cover, as before;
 *  - list surfaces (the status line) never fetch an encrypted cover.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { webcrypto, createHash } from 'node:crypto';

// jsdom's crypto has no SubtleCrypto: use Node's real WebCrypto (the same AES-GCM the app runs).
if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto);

const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('../utils/secureLocalStore', () => {
    const s = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } };
    return { default: s, secureLocalStore: s };
});
const net = vi.hoisted(() => ({ calls: [] as string[], cover: null as Uint8Array | null }));
const CATALOGUE = vi.hoisted(() => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]));
vi.mock('axios', () => {
    const get = async (url: string) => {
        net.calls.push(url);
        const ab = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        if (url.includes('/listening/cover') && net.cover) return { data: ab(net.cover) };
        if (url.includes('/listening/art')) return { data: ab(CATALOGUE) };
        throw Object.assign(new Error('nf'), { response: { status: 404 } });
    };
    return { default: { get, isAxiosError: () => false } };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let urls = 0;
const made = new Map<string, Blob>();
URL.createObjectURL = ((b: Blob) => { const u = `blob:test-${++urls}`; made.set(u, b); return u; }) as typeof URL.createObjectURL;
URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;

const { useIntegrationActivity } = await import('../hooks/useIntegrationActivity');
const { ProfileActivityRow } = await import('./profile/ProfileActivityRow');
const { StatusLine } = await import('./StatusLine');
const { ReportOpenContext } = await import('../contexts/ReportOpenContext');
const { listeningStore } = await import('../utils/integrations/listening');
const { setListeningArtToken } = await import('../utils/integrations/listeningArt');
const { setFriendCoverSession, __resetFriendCovers } = await import('../utils/integrations/friendCover');
const { fileFriendActivityKey } = await import('../utils/integrations/activityKeys');
const { encryptCover, newActivityKey, newCoverId } = await import('../utils/integrations/activityCover');
type Listening = import('../utils/integrations/listening').Listening;

const h = React.createElement as (...a: unknown[]) => React.ReactElement;
const ME = '11111111-1111-4111-8111-111111111111';
const ALICE = '22222222-2222-4222-8222-222222222222';
const RG = 'mb:rg:6f9f6899-c0d3-311d-ae87-a10ae6bc53a9';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);

const rec = (o: Partial<Listening> = {}): Listening => ({
    kind: 'listening', source: 'spotify', track: 'Teardrop', artist: 'Massive Attack', album: 'Mezzanine',
    startedAt: Date.now(), durationMs: 300_000, endsAt: Date.now() + 120_000, artRef: RG, ...o,
});

async function aliceShares(withKey = true) {
    const key = newActivityKey();
    const coverId = newCoverId();
    net.cover = (await encryptCover({ sharerUserId: ALICE, coverId, kid: key.kid, keyB64: key.keyB64, image: JPEG }))!;
    if (withKey) fileFriendActivityKey(ME, ALICE, key.kid, key.keyB64, Date.now());
    return { key, coverId };
}

const report = vi.fn();
function Profile({ userId }: { userId: string }) {
    const acts = useIntegrationActivity({ userId, token: 'tok', steamId: null, liveGame: null, offline: false, username: 'alice' });
    return h(ProfileActivityRow, { activities: acts, variant: 'full' });
}

let root: Root;
let host: HTMLDivElement;
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise(r => setTimeout(r, 5)); }); };
const img = () => host.querySelector('.pfa-art img') as HTMLImageElement | null;

beforeEach(() => {
    mem.clear(); net.calls = []; net.cover = null; report.mockReset(); made.clear();
    __resetFriendCovers(); setFriendCoverSession({ token: 'tok', userId: ME }); setListeningArtToken('tok');
    listeningStore.clear();
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); listeningStore.clear(); setListeningArtToken(null); });

const mount = async (userId = ALICE) => {
    await act(async () => { root.render(h(ReportOpenContext.Provider, { value: report }, h(Profile, { userId }))); });
    await flush();
};

describe('profile view: a friend playing Spotify', () => {
    it('shows THEIR cover, decrypted on this device from the ciphertext our API holds', async () => {
        const { coverId } = await aliceShares();
        listeningStore.set(ALICE, rec({ coverId }));
        await mount();
        expect(net.calls.some(u => u.endsWith(`/friends/${ALICE}/listening/cover`))).toBe(true);
        const src = img()?.getAttribute('src') ?? '';
        expect(src).toMatch(/^blob:test-/);
        const blob = made.get(src)!;
        expect(blob.type).toBe('image/jpeg');
        const bytes = await new Promise<ArrayBuffer>((res) => { const r = new FileReader(); r.onload = () => res(r.result as ArrayBuffer); r.readAsArrayBuffer(blob); });
        expect(new Uint8Array(bytes)).toEqual(JPEG);
    });

    it('offers "Report this cover" on right-click (no visible button); it opens the report flow with the decrypted cover as evidence', async () => {
        const { coverId } = await aliceShares();
        listeningStore.set(ALICE, rec({ coverId }));
        await mount();
        expect(host.querySelector('.pfa-report')).toBeNull();
        const row = host.querySelector('[data-testid="profile-activity-reportable"]') as HTMLElement;
        expect(row).not.toBeNull();
        await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); });
        const item = [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.includes('Report this cover')) as HTMLElement;
        expect(item).toBeTruthy();
        await act(async () => { item.click(); });
        // The menu flashes the picked row (170 ms) before the action runs.
        await act(async () => { await new Promise(r => setTimeout(r, 250)); });
        await flush();
        expect(report).toHaveBeenCalledTimes(1);
        const [uid, name, snippet, evidence] = report.mock.calls[0];
        expect([uid, name, snippet]).toEqual([ALICE, 'alice', undefined]);
        expect(evidence.text).toContain('Track: Teardrop');
        expect(evidence.text).toContain(createHash('sha256').update(JPEG).digest('hex'));
        expect(evidence.imageSrc).toMatch(/^blob:test-/);
    });

    it('no key on this device yet: the catalogue cover, no report button (nothing of theirs is shown)', async () => {
        const { coverId } = await aliceShares(false);
        listeningStore.set(ALICE, rec({ coverId }));
        await mount();
        const src = img()?.getAttribute('src') ?? '';
        expect(made.get(src)?.type).toBe('image/png');
        expect(host.querySelector('[data-testid="profile-activity-reportable"]')).toBeNull();
    });

    it('a record without the field (an older sharer): the catalogue cover, the cover route is never asked', async () => {
        listeningStore.set(ALICE, rec());
        await mount();
        expect(made.get(img()?.getAttribute('src') ?? '')?.type).toBe('image/png');
        expect(net.calls.some(u => u.includes('/listening/cover'))).toBe(false);
    });
});

describe('another player: catalogue fallback', () => {
    it('Deezer (even if a cover id were smuggled in): the server-picked cover, never the encrypted route', async () => {
        const { coverId } = await aliceShares();
        listeningStore.set(ALICE, rec({ source: 'deezer', coverId }));
        await mount();
        expect(net.calls.some(u => u.includes('/listening/art'))).toBe(true);
        expect(net.calls.some(u => u.includes('/listening/cover'))).toBe(false);
        expect(made.get(img()?.getAttribute('src') ?? '')?.type).toBe('image/png');
    });
});

describe('list surfaces and your own profile', () => {
    it('the status line never fetches an encrypted cover', async () => {
        const { coverId } = await aliceShares();
        listeningStore.set(ALICE, rec({ coverId }));
        const entry = { status: 'online', custom_status_text: null, custom_status_emoji: null, custom_status_expires_at: null, current_game: null, on_mobile: false } as never;
        await act(async () => { root.render(h(StatusLine, { entry, userId: ALICE })); });
        await flush();
        expect(host.querySelector('[data-testid="status-line-listening"]')).not.toBeNull();
        expect(net.calls.some(u => u.includes('/listening/cover'))).toBe(false);
    });

    it('your own profile shows the cover your device read; nothing is fetched, nothing to report', async () => {
        const own = 'data:image/jpeg;base64,/9j/4AAQ';
        listeningStore.set(ME, rec({ art: own, coverId: newCoverId() }));
        await mount(ME);
        expect(img()?.getAttribute('src')).toBe(own);
        expect(net.calls.some(u => u.includes('/listening/'))).toBe(false);
        expect(host.querySelector('[data-testid="profile-activity-reportable"]')).toBeNull();
    });
});
