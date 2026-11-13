// @vitest-environment jsdom
/**
 * Owner: "animated profiles should not play unless hovered on, when viewing a
 * profile, or when speaking in a call - otherwise they should not animate."
 *
 * Drives the REAL chain (EncryptedAvatar -> useEncryptedAvatar -> persistent
 * cache in IndexedDB -> still gate), with only the browser image APIs stubbed.
 * The avatar is put in the persistent cache the way a previous session left it,
 * then rendered cold: the situation every returning user is in, and the one
 * where the blob used to come back untyped and play natively.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Blob as NodeBlob } from 'node:buffer';

// jsdom's Blob has no arrayBuffer()/slice-with-type, which the real cache code
// needs; Electron's renderer has the real thing, so use Node's equivalent here.
(globalThis as { Blob: unknown }).Blob = NodeBlob;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY_B64 = Buffer.from(new Uint8Array(32).fill(5)).toString('base64');
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0x3b]);

vi.mock('../contexts/HydrationContext', () => ({ useHydrationGeneration: () => 0 }));
vi.mock('axios', () => ({ default: { get: () => Promise.reject(new Error('no network in this test')) } }));

const bitmap = vi.hoisted(() => ({ fail: false }));
vi.hoisted(() => {
    const g = globalThis as Record<string, unknown>;
    g.fetch = async () => ({ blob: async () => new Blob(['x']) });
    g.createImageBitmap = async () => { if (bitmap.fail) throw new Error('cannot decode'); return { width: 8, height: 8, close() {} }; };
    HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {} })) as never;
    HTMLCanvasElement.prototype.toBlob = function (cb: (b: Blob | null) => void) { cb(new Blob(['x'], { type: 'image/png' })); };
});

let n = 0;
const urlKind = new Map<string, string>();
async function wipeDb(): Promise<void> {
    await new Promise<void>(resolve => {
        const req = indexedDB.deleteDatabase('cipherline');
        req.onsuccess = () => resolve(); req.onerror = () => resolve(); req.onblocked = () => resolve();
    });
}

let root: Root;
let host: HTMLDivElement;
let focused = true;

type Mods = {
    EncryptedAvatar: typeof import('./EncryptedAvatar').EncryptedAvatar;
};
let mods: Mods;

beforeEach(async () => {
    vi.resetModules();
    n = 0; urlKind.clear(); bitmap.fail = false; focused = true;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
        const u = `blob:${b.type.startsWith('image/png') ? 'still' : 'full'}-${++n}`;
        urlKind.set(u, b.type);
        return u;
    };
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    const g = globalThis as unknown as { window: { electronAPI?: unknown } };
    g.window.electronAPI = { getBlobCacheKey: vi.fn(async () => ({ status: 'ok' as const, keyB64: KEY_B64 })) };
    await wipeDb();
    // A previous session left the animated avatar in the persistent cache.
    const cache = await import('../utils/attachmentCache');
    await cache.putAvatarBlob('att-1', new Blob([GIF], { type: 'image/gif' }));
    mods = { EncryptedAvatar: (await import('./EncryptedAvatar')).EncryptedAvatar };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
});

const settle = async () => {
    for (let i = 0; i < 30; i++) await act(async () => { await new Promise((r) => setTimeout(r, 2)); });
};
const render = async (props: Record<string, unknown> = {}) => {
    await act(async () => {
        root.render(React.createElement(mods.EncryptedAvatar, { attachmentId: 'att-1', token: 't', ...props }));
    });
    await settle();
};
const img = () => host.querySelector('img') as HTMLImageElement | null;
const isStill = (src: string | null | undefined) => !!src && src.startsWith('blob:still');
const isFull = (src: string | null | undefined) => !!src && src.startsWith('blob:full');

describe('an animated avatar that came back from the persistent cache', () => {
    it('shows the FIRST FRAME by default - it does not play', async () => {
        await render();
        expect(img()).not.toBeNull();
        expect(isStill(img()!.getAttribute('src'))).toBe(true);
    });

    it('plays on hover and returns to the first frame on leave', async () => {
        await render();
        act(() => { img()!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
        expect(isFull(img()!.getAttribute('src'))).toBe(true);
        act(() => { img()!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); });
        expect(isStill(img()!.getAttribute('src'))).toBe(true);
    });

    it('plays in an opened profile (animate) while Cipherline is in front, and freezes when it is not', async () => {
        await render({ animate: true });
        expect(isFull(img()!.getAttribute('src'))).toBe(true);
        focused = false;
        await act(async () => { window.dispatchEvent(new Event('blur')); });
        expect(isStill(img()!.getAttribute('src'))).toBe(true);
    });

    it('plays while the person is talking in a call', async () => {
        await render({ speaking: true });
        expect(isFull(img()!.getAttribute('src'))).toBe(true);
    });

    it('plays when a parent row says so, and not otherwise', async () => {
        await render({ playing: true });
        expect(isFull(img()!.getAttribute('src'))).toBe(true);
        await render({ playing: false });
        expect(isStill(img()!.getAttribute('src'))).toBe(true);
    });

    it('when the first frame cannot be made it shows the static fallback, never the animation', async () => {
        bitmap.fail = true;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await render({ userId: 'u1' });
        expect(img()).toBeNull();                       // the initials/colour fallback instead
        expect(host.querySelector('div')).not.toBeNull();
        expect(warn).toHaveBeenCalled();                // and the failure is logged
    });
});
