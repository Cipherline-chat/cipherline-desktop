// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Session restore at boot has two branches. The one taken when the stored
// token is within a day of expiry used to restore the session with a BLANK
// profile and never fetch the real one - no own avatar all session. These
// tests render the real provider against a mocked store and API and assert
// that BOTH branches end with the profile (avatar_url) loaded.
const store = new Map<string, string>();
vi.mock('../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
    };
    return { default: api, secureLocalStore: api };
});
const post = vi.fn(); const get = vi.fn();
vi.mock('axios', () => ({ default: {
    post: (...a: unknown[]) => post(...a),
    get: (...a: unknown[]) => get(...a),
    isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean } | null)?.isAxiosError,
} }));

import { AuthProvider, useAuth } from './AuthContext';
import { BOOT_REFRESH_WAIT_MS } from '../utils/bootRefresh';

const jwt = (expInSeconds: number) => `h.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expInSeconds }))}.s`;
let latest: ReturnType<typeof useAuth> | null = null;
// eslint-disable-next-line react-hooks/globals -- test probe: the whole point is to read the hook's value from outside
const Probe: React.FC = () => { latest = useAuth(); return null; };
let root: Root | null = null;
const mount = async () => {
    root = createRoot(document.createElement('div'));
    await act(async () => { root!.render(React.createElement(AuthProvider, null, React.createElement(Probe))); });
};
const settle = async () => {
    for (let i = 0; i < 40 && (latest?.initializing || !latest?.user?.avatar_url); i++) {
        await act(async () => { await new Promise(r => setTimeout(r, 25)); });
    }
};
const calls = (fn: ReturnType<typeof vi.fn>, path: string) => (fn.mock.calls as unknown[][]).filter(c => String(c[0]).includes(path)).length;

beforeEach(() => {
    store.clear(); post.mockReset(); get.mockReset(); latest = null;
    store.set('cipherline_user_id', 'u1'); store.set('cipherline_device_id', 'd1'); store.set('cipherline_refresh_token', 'r0');
    get.mockImplementation(async (u: string) => {
        if (u.includes('/auth/me')) return { data: { user_id: 'u1', username: 'dawson', email: null, discriminator: 7, bio: null, avatar_url: 'att-1', banner_url: null } };
        throw new Error('unexpected GET ' + u);
    });
    post.mockImplementation(async (u: string) => {
        if (u.includes('/auth/refresh')) return { data: { access_token: jwt(7 * 86400), refresh_token: 'r1' } };
        throw new Error('unexpected POST ' + u);
    });
});
afterEach(async () => { await act(async () => { root?.unmount(); }); root = null; });

describe('session restore at boot loads the profile on BOTH branches', () => {
    it('token within a day of expiry: refreshes, then fetches the profile', async () => {
        store.set('cipherline_token', jwt(3600));
        await mount(); await settle();
        expect(latest!.initializing).toBe(false);
        expect(latest!.isAuthenticated).toBe(true);
        expect(calls(post, '/auth/refresh')).toBe(1);
        expect(calls(get, '/auth/me')).toBeGreaterThanOrEqual(1);
        expect(latest!.user?.avatar_url).toBe('att-1');     // the bug: this stayed null
        expect(latest!.token).toBe(store.get('cipherline_token'));
    });

    it('healthy token: fetches the profile without refreshing', async () => {
        store.set('cipherline_token', jwt(5 * 86400));
        await mount(); await settle();
        expect(calls(post, '/auth/refresh')).toBe(0);
        expect(latest!.user?.avatar_url).toBe('att-1');
    });

    it('refresh fails on the network but the token is still valid: keeps the session and still fetches the profile', async () => {
        store.set('cipherline_token', jwt(3600));
        post.mockImplementation(async () => { throw Object.assign(new Error('offline'), { isAxiosError: true, code: 'ERR_NETWORK', response: undefined }); });
        await mount(); await settle();
        expect(latest!.isAuthenticated).toBe(true);
        expect(latest!.user?.avatar_url).toBe('att-1');
    });
});

describe('a hung token refresh never holds the app on the loading screen (wake → open app)', () => {
    it('still-valid token: the app opens after BOOT_REFRESH_WAIT_MS with the existing token', async () => {
        const old = jwt(3600);
        store.set('cipherline_token', old);
        post.mockImplementation(() => new Promise(() => { /* the network is still coming back */ }));
        const t0 = Date.now();
        await mount();
        for (let i = 0; i < 200 && latest?.initializing !== false; i++) {
            await act(async () => { await new Promise(r => setTimeout(r, 25)); });
        }
        const waited = Date.now() - t0;
        expect(latest!.initializing).toBe(false);
        expect(latest!.isAuthenticated).toBe(true);
        expect(latest!.token).toBe(old);
        expect(waited).toBeGreaterThanOrEqual(BOOT_REFRESH_WAIT_MS - 50);
        expect(waited).toBeLessThan(BOOT_REFRESH_WAIT_MS + 2000);   // was the refresh's full 15 s timeout
    }, 15_000);

    it('EXPIRED token: never opens on the dead token while the refresh is pending', async () => {
        store.set('cipherline_token', jwt(-60));
        post.mockImplementation(() => new Promise(() => {}));
        await mount();
        for (let i = 0; i < 180; i++) await act(async () => { await new Promise(r => setTimeout(r, 25)); });
        expect(latest!.initializing).toBe(true);
    }, 15_000);
});
