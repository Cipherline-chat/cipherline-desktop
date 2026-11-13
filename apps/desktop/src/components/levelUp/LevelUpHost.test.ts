// @vitest-environment jsdom
/**
 * LevelUpHost mounted for real (with the real toast stack): fires once per
 * new level and only for levels this device caused, the first one big, never
 * replayed after a restart, never for levels the account already had on the
 * first run, reduced motion -> the still card, waits for a quiet moment (not
 * in a call), and the achievement toast underneath is not lost.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const kv = vi.hoisted(() => new Map<string, string>());
vi.mock('../../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => kv.get(k) ?? null,
        setItem: (k: string, v: string) => { kv.set(k, v); },
        removeItem: (k: string) => { kv.delete(k); },
        whenAccountReady: () => Promise.resolve(),
        isAccountReady: (u: string) => u === 'me',
    };
    return { default: api, secureLocalStore: api };
});

// The account: what /auth/me says, and refreshProfile() that re-reads it.
const auth = vi.hoisted(() => ({
    server: { level: 1, points: 2, next_level_points: 4, showcase_slots: 3 } as Record<string, unknown> | null,
    user: null as Record<string, unknown> | null,
    refreshes: 0,
    subs: new Set<() => void>(),
}));
vi.mock('../../contexts/AuthContext', async () => {
    const { useSyncExternalStore } = await import('react');
    const refreshProfile = async () => {
        auth.refreshes++;
        auth.user = { user_id: 'me', profile_level: auth.server ? { ...auth.server } : undefined };
        for (const s of auth.subs) s();
    };
    return {
        useAuth: () => {
            const user = useSyncExternalStore((fn: () => void) => { auth.subs.add(fn); return () => { auth.subs.delete(fn); }; }, () => auth.user);
            return { userId: 'me', token: 't', deviceId: 'd', user, refreshProfile };
        },
    };
});
// The art is not under test here (the harness covers it); keep the mascot and cosmetics out of jsdom.
vi.mock('../mascot/Keys', () => ({ Keys: () => null }));
vi.mock('../ProfileCosmetics', () => ({ AvatarDecoration: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('../../utils/notificationSounds', async (importOriginal) => ({ ...(await importOriginal<object>()), playSound: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let reduced = false;
window.matchMedia = ((q: string) => ({
    matches: reduced && /reduced-motion/.test(q), media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { LevelUpHost, LEVEL_UP_ACK_REFRESH_MS, LEVEL_UP_FALLBACK_REFRESH_MS } = await import('./LevelUpHost');
const { ToastProvider, useToast } = await import('../../contexts/ToastContext');
const { ACHIEVEMENT_UNLOCK_EVENT } = await import('../../utils/achievements/keys');
const { EGG_FOUND_EVENT } = await import('../../utils/eggProgress');
const { setHasActiveCall } = await import('../../utils/activeCallRegistry');
const { levelUpKey, LEVEL_UP_INTRO_MS, LEVEL_UP_EXIT_MS } = await import('../../utils/levelUp');
const { __resetToastHoldForTests, toastsHeld } = await import('../../utils/toastHold');

const KEY = levelUpKey('me');
let root: Root | null = null;
let host: HTMLDivElement;
const grab: { push: ReturnType<typeof useToast>['push'] } = { push: () => {} };
const ToastGrab: React.FC = () => {
    const { push } = useToast();
    React.useEffect(() => { grab.push = push; }, [push]);
    return null;
};

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const advance = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); await flush(); };
const overlay = () => document.querySelector<HTMLElement>('[data-testid="level-up"]');
const record = () => JSON.parse(kv.get(KEY) ?? 'null');

/** Boot the app: /auth/me answers with the current server level, then the host mounts. */
async function boot() {
    auth.user = { user_id: 'me', profile_level: auth.server ? { ...auth.server } : undefined };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(React.createElement(ToastProvider, null, React.createElement(ToastGrab), React.createElement(LevelUpHost)));
    });
    await flush();
}
async function quit() {
    await act(async () => { root?.unmount(); });
    root = null;
    host.remove();
}
/** What AchievementsHost does for one unlock: the event now, the server ack after its push. */
async function unlockOnThisDevice(serverAfter: Record<string, unknown>) {
    await act(async () => { window.dispatchEvent(new CustomEvent(ACHIEVEMENT_UNLOCK_EVENT, { detail: { id: 'msgs-1' } })); });
    auth.server = serverAfter;
    await act(async () => { window.dispatchEvent(new CustomEvent(ACHIEVEMENT_UNLOCK_EVENT, { detail: { id: null } })); });
    await advance(LEVEL_UP_ACK_REFRESH_MS + 10);
}
async function closeIt() {
    await act(async () => { overlay()?.querySelector<HTMLButtonElement>('[data-testid="level-up-continue"]')?.click(); });
    await advance(LEVEL_UP_EXIT_MS + 10);
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-11-12T12:00:00'));
    kv.clear();
    reduced = false;
    auth.server = { level: 1, points: 2, next_level_points: 4, showcase_slots: 3 };
    auth.refreshes = 0;
    setHasActiveCall(false);
    __resetToastHoldForTests();
});
afterEach(async () => {
    if (root) await quit();
    document.body.innerHTML = '';
    vi.useRealTimers();
});

describe('LevelUpHost', () => {
    it('first run: records the level the account already has, silently', async () => {
        auth.server = { level: 4, points: 17, next_level_points: 25, showcase_slots: 4 };
        await boot();
        expect(overlay()).toBeNull();
        expect(record()).toEqual({ level: 4, big: false });
    });

    it('a local unlock that levels up: re-reads /auth/me once after the ack and plays the BIG one (1 -> 2)', async () => {
        await boot();
        await unlockOnThisDevice({ level: 2, points: 5, next_level_points: 9, showcase_slots: 3 });
        expect(auth.refreshes).toBe(1);
        const el = overlay();
        expect(el).not.toBeNull();
        expect(el!.dataset.variant).toBe('big');
        expect(el!.dataset.motion).toBe('full');
        expect(el!.getAttribute('role')).toBe('dialog');
        expect(el!.textContent).toContain('Level 2!');
        expect(el!.textContent).toContain('Dive bezel');
        expect(record()).toEqual({ level: 2, big: true });
        expect(document.querySelector('[data-testid="level-up-live"]')!.textContent).toMatch(/profile level 2/);
    });

    it('fires once per level: the same level again never replays, the next one plays SHORT', async () => {
        await boot();
        await unlockOnThisDevice({ level: 2, points: 5, next_level_points: 9, showcase_slots: 3 });
        await closeIt();
        expect(overlay()).toBeNull();
        await unlockOnThisDevice({ level: 2, points: 6, next_level_points: 9, showcase_slots: 3 });
        expect(overlay()).toBeNull();
        await unlockOnThisDevice({ level: 3, points: 9, next_level_points: 16, showcase_slots: 4 });
        expect(overlay()?.dataset.variant).toBe('short');
        expect(record()).toEqual({ level: 3, big: true });
    });

    it('no replay after a restart', async () => {
        await boot();
        await unlockOnThisDevice({ level: 2, points: 5, next_level_points: 9, showcase_slots: 3 });
        expect(overlay()).not.toBeNull();
        await quit(); // quit mid-animation
        await boot(); // /auth/me says level 2 again
        await unlockOnThisDevice({ level: 2, points: 5, next_level_points: 9, showcase_slots: 3 });
        await advance(LEVEL_UP_FALLBACK_REFRESH_MS + 100);
        expect(overlay()).toBeNull();
    });

    it('a level lost and regained (a retired achievement) is not celebrated again', async () => {
        await boot();
        await unlockOnThisDevice({ level: 2, points: 5, next_level_points: 9, showcase_slots: 3 });
        await closeIt();
        await unlockOnThisDevice({ level: 1, points: 3, next_level_points: 4, showcase_slots: 3 });
        await unlockOnThisDevice({ level: 2, points: 4, next_level_points: 9, showcase_slots: 3 });
        expect(overlay()).toBeNull();
        expect(record()).toEqual({ level: 2, big: true });
    });

    it('positive control for the "once" rule: the same sequence DOES replay without the record to stop it', async () => {
        await boot();
        await unlockOnThisDevice({ level: 2, points: 5, next_level_points: 9, showcase_slots: 3 });
        await closeIt();
        await unlockOnThisDevice({ level: 1, points: 3, next_level_points: 4, showcase_slots: 3 });
        kv.set(KEY, JSON.stringify({ level: 1, big: false })); // what a host that forgot to persist would leave behind
        await unlockOnThisDevice({ level: 2, points: 4, next_level_points: 9, showcase_slots: 3 });
        expect(overlay()?.dataset.variant).toBe('big'); // so the "never replays" assertions can fail
    });

    it('growth this device did not cause (another device, an unrelated refresh) is adopted silently', async () => {
        kv.set(KEY, JSON.stringify({ level: 1, big: false }));
        auth.server = { level: 3, points: 10, next_level_points: 16, showcase_slots: 4 };
        await boot();
        expect(overlay()).toBeNull();
        expect(record()).toEqual({ level: 3, big: false });
    });

    it('an egg find arms it too: /auth/me is re-read after the fallback delay', async () => {
        await boot();
        await act(async () => { window.dispatchEvent(new CustomEvent(EGG_FOUND_EVENT, { detail: { id: 'konami' } })); });
        auth.server = { level: 2, points: 4, next_level_points: 9, showcase_slots: 3 };
        expect(auth.refreshes).toBe(0);
        await advance(LEVEL_UP_FALLBACK_REFRESH_MS + 10);
        expect(auth.refreshes).toBe(1);
        expect(overlay()?.dataset.variant).toBe('big');
    });

    it('reduced motion: the still card', async () => {
        reduced = true;
        await boot();
        await unlockOnThisDevice({ level: 2, points: 5, next_level_points: 9, showcase_slots: 3 });
        expect(overlay()?.dataset.motion).toBe('still');
        expect(overlay()?.dataset.phase).toBe('rest'); // no intro to sit through
    });

    it('waits for a quiet moment: never during a call, then plays when it ends', async () => {
        await boot();
        setHasActiveCall(true);
        await unlockOnThisDevice({ level: 2, points: 5, next_level_points: 9, showcase_slots: 3 });
        await advance(5000);
        expect(overlay()).toBeNull();
        expect(record()).toEqual({ level: 1, big: false }); // nothing spent while waiting
        setHasActiveCall(false);
        await advance(1100);
        expect(overlay()?.dataset.variant).toBe('big');
    });

    it('the achievement toast that came with it is held, and still there after it closes', async () => {
        await boot();
        await act(async () => { grab.push({ kind: 'success', title: 'Achievement unlocked', message: 'Message in a Bottle', durationMs: 8000 }); });
        await advance(2000);
        await unlockOnThisDevice({ level: 2, points: 5, next_level_points: 9, showcase_slots: 3 });
        expect(toastsHeld()).toBe(true);
        await advance(LEVEL_UP_INTRO_MS.big + 20_000); // the user takes their time
        expect(document.body.textContent).toContain('Achievement unlocked');
        await closeIt();
        expect(toastsHeld()).toBe(false);
        await advance(3000);
        expect(document.body.textContent).toContain('Achievement unlocked');
        await advance(4000); // ~5.6 s of its 8 s were left
        expect(document.body.textContent).not.toContain('Achievement unlocked');
    });
});
