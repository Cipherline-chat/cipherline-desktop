// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The REAL `QrSignInPanel`, mounted the way the app mounts
 * it: inside `<StrictMode>` (main.tsx).
 *
 * The bug this pins: the panel (and the since-removed QR history-transfer
 * panel) used to build their controller DURING RENDER
 * (`if (!ref.current) ref.current = new Controller(...)`) and dispose it in the
 * mount effect's cleanup. React's development StrictMode mounts, unmounts and
 * re-mounts every component once — the ref survives that, the cleanup does
 * not undo itself — so the one and only controller was disposed before the
 * user could touch it, and every later `set()` was a silent no-op. "Show a
 * code" did nothing at all. Production builds skip the double mount, so the
 * staging installer worked while the Tier-1 dev renderer (Vite dev server,
 * React development build) was dead on arrival.
 *
 * The controller-level suite (`QrSignInPanel.test.ts`) cannot see this: they `new` the controller
 * themselves and never let React own its lifetime. Only mounting the real
 * component under StrictMode can.
 */

// ClButton's physics module reads matchMedia at import time; jsdom has none.
vi.hoisted(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null,
        addListener: () => {}, removeListener: () => {},
        addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    });
});

const post = vi.fn();
const get = vi.fn();
const del = vi.fn();
// The pending-session revoke deliberately uses a FRESH instance (no global
// interceptors) — `create` hands back this separate `post` so the tests can
// tell the two apart.
const isolatedPost = vi.fn();
const create = vi.fn((..._a: unknown[]) => ({ post: (...a: unknown[]) => isolatedPost(...a) }));
vi.mock('axios', () => ({
    default: {
        create: (...a: unknown[]) => create(...a),
        post: (...a: unknown[]) => post(...a),
        get: (...a: unknown[]) => get(...a),
        delete: (...a: unknown[]) => del(...a),
        isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean } | null)?.isAxiosError,
    },
}));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async (text: string) => `data:image/png;base64,${btoa(text)}`) } }));

const login = vi.fn(async () => {});
vi.mock('../../contexts/AuthContext', () => ({
    useAuth: () => ({ login, token: 'TOKEN', deviceId: 'DEVICE-1' }),
}));
const registerOrReuseDevice = vi.fn(async () => ({ deviceId: 'NEW-DEVICE', requiresPairing: false }));
// The desktop's CURRENTLY signed-in session (as if another account were
// signed in) — the revoke must never touch it.
const currentRefresh = vi.fn((): string | null => 'CURRENT-SIGNED-IN-REFRESH');
vi.mock('../../utils/secureLocalStore', () => ({
    secureLocalStore: { getItem: (k: string) => (k === 'cipherline_refresh_token' ? currentRefresh() : null) },
}));
vi.mock('../../utils/deviceRegistration', () => ({
    registerOrReuseDevice: (...a: unknown[]) => registerOrReuseDevice(...(a as [])),
}));

import QrSignInPanel from './QrSignInPanel';

const LINK_ID = 'LiNK1234567890abcdEF-_';

const electronAPI = {
    linkBegin: vi.fn(async () => ({ ekPubB64: 'A'.repeat(43) + '=', fingerprint: 'ABCD-EFGH' })),
    linkBind: vi.fn(async () => {}),
    linkOpen: vi.fn(async () => ({
        type: 'link_grant', v: 1, link_id: LINK_ID, user_id: 'USER-1',
        access_token: 'NEW-ACCESS', refresh_token: 'NEW-REFRESH',
        approved_by_device_id: 'PHONE', approved_by_device_name: 'Pixel',
        issued_at: new Date().toISOString(),
    })),
    linkEnd: vi.fn(async () => {}),
    linkSeal: vi.fn(async () => 'SEALED'),
    getDeviceName: vi.fn(async () => 'TEST-PC'),
    // Read (not called) by the sign-in panel's `getPlatform` dep; kept out of
    // the `mockClear` loop below by being a plain string.
    platform: 'windows' as const,
};

let root: Root | null = null;
let container: HTMLDivElement;

async function mount(el: React.ReactElement) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root!.render(React.createElement(StrictMode, null, el)); });
}

async function flush(ms = 0) {
    await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

function button(label: string): HTMLButtonElement {
    const found = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
    if (!found) throw new Error(`no "${label}" button; rendered: ${container.textContent}`);
    return found as HTMLButtonElement;
}

async function click(label: string) {
    await act(async () => { button(label).click(); });
    await flush(10);
}

const qrImg = () => container.querySelector('img[src^="data:image/png"]');

beforeEach(() => {
    vi.useRealTimers();
    post.mockReset(); get.mockReset(); del.mockReset();
    isolatedPost.mockReset(); create.mockClear();
    login.mockClear(); registerOrReuseDevice.mockClear();
    Object.values(electronAPI).forEach((f) => { if (typeof f === 'function') f.mockClear(); });
    (window as unknown as { electronAPI: unknown }).electronAPI = electronAPI;
});

afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = null;
    container?.remove();
});

describe('QrSignInPanel under StrictMode', () => {
    it('"Show a code" actually shows a code (the controller survives the StrictMode double mount)', async () => {
        post.mockResolvedValue({ data: { link_id: LINK_ID, ttl_s: 120, expires_at: new Date(Date.now() + 120_000).toISOString() } });
        get.mockResolvedValue({ data: { state: 'pending', expires_in_s: 118 } });

        await mount(React.createElement(QrSignInPanel));
        await click('Show a code');

        expect(post).toHaveBeenCalledTimes(1);
        expect(String(post.mock.calls[0][0])).toMatch(/\/link\/sessions$/);
        expect(electronAPI.linkBind).toHaveBeenCalledWith(LINK_ID);
        const img = qrImg();
        expect(img).not.toBeNull();
        // The rendered QR carries the server's id and the IPC-returned key, nothing else.
        expect(atob(img!.getAttribute('src')!.split(',')[1])).toBe(`cipherline://link/1?i=${LINK_ID}&k=${'A'.repeat(43)}`);
        expect(container.textContent).toContain('ABCD-EFGH');
        // Vitest runs with import.meta.env.DEV, like the Tier-1 Vite dev server:
        // the "this code lives on THIS build's server" note must be visible.
        expect(import.meta.env.DEV).toBe(true);
        expect(container.querySelector('[data-testid="qr-dev-server-note"]')).not.toBeNull();
    });

    it('runs the whole sign-in: poll → granted → confirm the account → login', async () => {
        post.mockResolvedValue({ data: { link_id: LINK_ID, ttl_s: 120, expires_at: new Date(Date.now() + 120_000).toISOString() } });
        get.mockImplementation(async (url: string) => {
            if (url.endsWith('/auth/me')) return { data: { username: 'dawson', discriminator: 7 } };
            return { data: { state: 'granted', envelope_b64: 'ENVELOPE' } };
        });
        del.mockResolvedValue({ data: { success: true } });

        await mount(React.createElement(QrSignInPanel));
        await click('Show a code');
        // One 2s poll tick.
        await flush(2_100);

        expect(electronAPI.linkOpen).toHaveBeenCalledWith('ENVELOPE', LINK_ID);
        expect(container.textContent).toContain('@dawson#0007');
        expect(login).not.toHaveBeenCalled(); // QR-1: nothing persisted before the human confirms

        await click('Continue');
        expect(registerOrReuseDevice).toHaveBeenCalledWith('USER-1', 'NEW-ACCESS', 'QR');
        expect(login).toHaveBeenCalledWith('NEW-ACCESS', 'USER-1', 'NEW-DEVICE', false, 'NEW-REFRESH');
    }, 10_000);

    it('"This isn\'t my account" revokes the PENDING pair via /auth/logout on an isolated client, with no Authorization header', async () => {
        post.mockResolvedValue({ data: { link_id: LINK_ID, ttl_s: 120, expires_at: new Date(Date.now() + 120_000).toISOString() } });
        get.mockImplementation(async (url: string) => {
            if (url.endsWith('/auth/me')) return { data: { username: 'stranger', discriminator: 9 } };
            return { data: { state: 'granted', envelope_b64: 'ENVELOPE' } };
        });
        // Offline: the revoke never settles — the UI must not wait for it.
        isolatedPost.mockImplementation(() => new Promise(() => {}));

        await mount(React.createElement(QrSignInPanel));
        await click('Show a code');
        await flush(2_100);
        expect(container.textContent).toContain('@stranger#0009');

        await click("This isn't my account");

        expect(container.textContent).toContain('Sign-in failed');
        expect(isolatedPost).toHaveBeenCalledTimes(1);
        const [url, body, config] = isolatedPost.mock.calls[0] as [string, unknown, { headers?: Record<string, string> } | undefined];
        expect(url).toMatch(/\/auth\/logout$/);
        expect(body).toEqual({ refresh_token: 'NEW-REFRESH' });
        expect(config?.headers?.Authorization).toBeUndefined();
        // The global (interceptor-carrying) client was never used for it.
        expect(post.mock.calls.some(c => String(c[0]).endsWith('/auth/logout'))).toBe(false);
        expect(JSON.stringify(isolatedPost.mock.calls)).not.toContain('CURRENT-SIGNED-IN-REFRESH');
        expect(login).not.toHaveBeenCalled();
    }, 10_000);

    it('closing the panel on the confirm screen revokes the pending pair too', async () => {
        post.mockResolvedValue({ data: { link_id: LINK_ID, ttl_s: 120, expires_at: new Date(Date.now() + 120_000).toISOString() } });
        get.mockImplementation(async (url: string) => {
            if (url.endsWith('/auth/me')) return { data: { username: 'dawson', discriminator: 7 } };
            return { data: { state: 'granted', envelope_b64: 'ENVELOPE' } };
        });
        isolatedPost.mockRejectedValue(Object.assign(new Error('429'), { isAxiosError: true, response: { status: 429 } }));

        await mount(React.createElement(QrSignInPanel));
        await click('Show a code');
        await flush(2_100);
        expect(container.textContent).toContain('@dawson#0007');

        await act(async () => { root!.unmount(); });
        root = null;
        await flush(10);

        expect(isolatedPost).toHaveBeenCalledTimes(1);
        expect(isolatedPost.mock.calls[0][1]).toEqual({ refresh_token: 'NEW-REFRESH' });
    }, 10_000);

    it('after "Continue" signs in, unmounting revokes nothing', async () => {
        post.mockResolvedValue({ data: { link_id: LINK_ID, ttl_s: 120, expires_at: new Date(Date.now() + 120_000).toISOString() } });
        get.mockImplementation(async (url: string) => {
            if (url.endsWith('/auth/me')) return { data: { username: 'dawson', discriminator: 7 } };
            return { data: { state: 'granted', envelope_b64: 'ENVELOPE' } };
        });
        del.mockResolvedValue({ data: { success: true } });

        await mount(React.createElement(QrSignInPanel));
        await click('Show a code');
        await flush(2_100);
        await click('Continue');
        expect(login).toHaveBeenCalled();

        await act(async () => { root!.unmount(); });
        root = null;
        await flush(10);
        expect(isolatedPost).not.toHaveBeenCalled();
    }, 10_000);

    it('unmounting still discards the main-process key', async () => {
        await mount(React.createElement(QrSignInPanel));
        electronAPI.linkEnd.mockClear();
        await act(async () => { root!.unmount(); });
        root = null;
        expect(electronAPI.linkEnd).toHaveBeenCalled();
    });
});
