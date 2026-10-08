import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    selectNotificationAvatarId, getNotificationIconDataUrl, createToastSequencer,
    __resetNotificationIconCache, NOTIF_ICON_SIZE, NOTIF_ICON_CACHE_MAX,
    type NotifAvatarSelectionInput, type NotifIconDeps,
} from './notificationAvatar';

const FRIEND = 'u-friend';
const STRANGER = 'u-stranger';
const ME = 'u-me';
const ids: Record<string, string> = { [FRIEND]: 'att-friend', [STRANGER]: 'att-stranger', [ME]: 'att-me' };
const gate = (uid: string) => uid === FRIEND || uid === ME;

const sel = (over: Partial<NotifAvatarSelectionInput> = {}) => selectNotificationAvatarId({
    showPreview: 'full',
    showSenderAvatar: true,
    senderUserId: FRIEND,
    lookupAvatarId: uid => ids[uid] ?? null,
    isFriendOrSelf: gate,
    ...over,
});

describe('selectNotificationAvatarId — privacy & fallback', () => {
    it('positive control: a friend with a known avatar under full preview', () => {
        expect(sel()).toBe('att-friend');
    });

    it('sender_only preview shows NO avatar (owner: message content off → no picture)', () => {
        expect(sel({ showPreview: 'sender_only' })).toBeNull();
    });

    it('only the full preview carries the avatar', () => {
        expect(sel({ showPreview: 'full' })).toBe('att-friend');
        expect(sel({ showPreview: 'hidden' })).toBeNull();
    });

    it('hidden preview hides the avatar, like the sender name', () => {
        expect(sel({ showPreview: 'hidden' })).toBeNull();
    });

    it('the user can switch avatars off independently', () => {
        expect(sel({ showSenderAvatar: false })).toBeNull();
    });

    it('a prefs blob that predates the toggle (undefined) behaves as on', () => {
        expect(sel({ showSenderAvatar: undefined })).toBe('att-friend');
    });

    it('strangers (incl. blocked users, who are not friends) get no avatar', () => {
        expect(sel({ senderUserId: STRANGER })).toBeNull();
    });

    it('fails closed when no friend gate is available', () => {
        expect(sel({ isFriendOrSelf: null })).toBeNull();
        expect(sel({ isFriendOrSelf: undefined })).toBeNull();
    });

    it('unknown sender → no avatar', () => {
        expect(sel({ senderUserId: null })).toBeNull();
        expect(sel({ senderUserId: undefined })).toBeNull();
        expect(sel({ senderUserId: '' })).toBeNull();
    });

    it('a friend with no avatar → no avatar (app icon)', () => {
        expect(sel({ lookupAvatarId: () => null })).toBeNull();
    });

    it('a caller-supplied hint wins over the lookup, but never bypasses the gate', () => {
        expect(sel({ avatarIdHint: 'att-hint' })).toBe('att-hint');
        expect(sel({ senderUserId: STRANGER, avatarIdHint: 'att-hint' })).toBeNull();
        expect(sel({ showPreview: 'hidden', avatarIdHint: 'att-hint' })).toBeNull();
    });

    it('non-attachment ids (remote URLs, data:, blob:) are refused', () => {
        for (const v of ['https://x.example/a.png', 'http://x/a', 'data:image/png;base64,AAAA', 'blob:abc']) {
            expect(sel({ avatarIdHint: v })).toBeNull();
            expect(sel({ lookupAvatarId: () => v })).toBeNull();
        }
    });

    it('own messages pass the gate (self) — harmless, own toasts are silenced upstream', () => {
        expect(sel({ senderUserId: ME })).toBe('att-me');
    });
});

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function deps(over: Partial<NotifIconDeps> = {}) {
    const calls = { peek: 0, disk: 0, raster: 0 };
    const memory = new Map<string, string>();
    const d: NotifIconDeps = {
        peek: id => { calls.peek++; return memory.get(id) ?? null; },
        warmFromDisk: async () => { calls.disk++; },
        rasterize: async (_url, size) => { calls.raster++; expect(size).toBe(NOTIF_ICON_SIZE); return PNG; },
        ...over,
    };
    return { d, calls, memory };
}

describe('getNotificationIconDataUrl — caches only, bounded wait', () => {
    beforeEach(() => { __resetNotificationIconCache(); vi.useRealTimers(); });

    it('positive control: a memory-cache hit is rasterised to a PNG data URL', async () => {
        const { d, calls, memory } = deps();
        memory.set('a1', 'blob:mem-a1');
        await expect(getNotificationIconDataUrl('a1', d)).resolves.toBe(PNG);
        expect(calls.disk).toBe(0);
    });

    it('a memory miss tries the (network-free) disk cache once, then succeeds', async () => {
        const { d, calls, memory } = deps();
        d.warmFromDisk = async (id) => { calls.disk++; memory.set(id, 'blob:disk'); };
        await expect(getNotificationIconDataUrl('a1', d)).resolves.toBe(PNG);
        expect(calls.disk).toBe(1);
    });

    it('a miss everywhere resolves null (→ app icon) and never rasterises', async () => {
        const { d, calls } = deps();
        await expect(getNotificationIconDataUrl('a1', d)).resolves.toBeNull();
        expect(calls.raster).toBe(0);
    });

    it('the deps are the ONLY sources — no fetch/XHR is ever made', async () => {
        const fetchSpy = vi.fn();
        const g = globalThis as unknown as { fetch: unknown };
        const prev = g.fetch;
        g.fetch = fetchSpy;
        try {
            const { d } = deps();
            await getNotificationIconDataUrl('a1', d);
        } finally { g.fetch = prev; }
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('a second toast for the same avatar is served from the icon cache', async () => {
        const { d, calls, memory } = deps();
        memory.set('a1', 'blob:x');
        await getNotificationIconDataUrl('a1', d);
        await getNotificationIconDataUrl('a1', d);
        expect(calls.raster).toBe(1);
    });

    it('does not block: resolves null after the wait, but the late result is kept for next time', async () => {
        const { d, calls, memory } = deps();
        memory.set('a1', 'blob:x');
        let release!: (v: string) => void;
        d.rasterize = () => { calls.raster++; return new Promise<string>(r => { release = r; }); };
        const t0 = Date.now();
        await expect(getNotificationIconDataUrl('a1', d, 30)).resolves.toBeNull();
        expect(Date.now() - t0).toBeLessThan(1000);
        release(PNG);
        await new Promise(r => setTimeout(r, 0));
        await expect(getNotificationIconDataUrl('a1', d, 30)).resolves.toBe(PNG);
        expect(calls.raster).toBe(1);
    });

    it('a rasteriser failure or a non-PNG result resolves null', async () => {
        const a = deps(); a.memory.set('a1', 'blob:x');
        a.d.rasterize = async () => { throw new Error('decode failed'); };
        await expect(getNotificationIconDataUrl('a1', a.d)).resolves.toBeNull();
        __resetNotificationIconCache();
        const b = deps(); b.memory.set('a1', 'blob:x');
        b.d.rasterize = async () => 'data:image/jpeg;base64,AAAA';
        await expect(getNotificationIconDataUrl('a1', b.d)).resolves.toBeNull();
    });

    it('the icon cache is bounded (oldest evicted)', async () => {
        const { d, calls, memory } = deps();
        for (let i = 0; i <= NOTIF_ICON_CACHE_MAX; i++) {
            memory.set(`a${i}`, 'blob:x');
            await getNotificationIconDataUrl(`a${i}`, d);
        }
        expect(calls.raster).toBe(NOTIF_ICON_CACHE_MAX + 1);
        await getNotificationIconDataUrl(`a${NOTIF_ICON_CACHE_MAX}`, d); // newest: hit
        expect(calls.raster).toBe(NOTIF_ICON_CACHE_MAX + 1);
        await getNotificationIconDataUrl('a0', d); // oldest: evicted → re-rendered
        expect(calls.raster).toBe(NOTIF_ICON_CACHE_MAX + 2);
    });
});

describe('createToastSequencer', () => {
    it('only the latest ticket per id is current', () => {
        const take = createToastSequencer();
        const first = take('notif_c1');
        const other = take('notif_c2');
        expect(first()).toBe(true);
        const second = take('notif_c1');
        expect(first()).toBe(false);   // a slow avatar toast must not replace the newer one
        expect(second()).toBe(true);
        expect(other()).toBe(true);    // other conversations are independent
    });
});
