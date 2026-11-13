// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Animated server icons / banners (GIF, animated WebP), rendered for real:
 * the SAME rule as animated avatars - a list shows the first frame and plays on
 * hover; a surface that is the open server (`animate`) plays, but only while
 * Cipherline is the window in front; a static icon is never touched.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FULL = 'blob:full-animation';
const STILL = 'blob:first-frame';
const mime = vi.hoisted(() => ({ value: 'image/webp' as string | null }));

vi.mock('../../hooks/useEncryptedAvatar', () => ({
    useEncryptedAvatar: () => 'blob:full-animation',
    avatarUrlMime: () => mime.value,
}));
// jsdom has no fetch / createImageBitmap / canvas encoder, which is what the first-frame
// extraction (utils/animatedImage getStill) uses: stub just those, and let the REAL gate
// (useStillGate / pickDisplayUrl / useAppInFront) decide what is shown.
vi.hoisted(() => {
    const g = globalThis as Record<string, unknown>;
    g.fetch = async () => ({ blob: async () => new Blob(['x']) });
    g.createImageBitmap = async () => ({ width: 8, height: 8, close() {} });
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:first-frame';
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {} })) as never;
    HTMLCanvasElement.prototype.toBlob = function (cb: (b: Blob | null) => void) { cb(new Blob(['x'], { type: 'image/png' })); };
});
vi.mock('../../utils/safeMediaUrl', () => ({ safeImageSrc: (u: string | null) => u ?? undefined }));

import { ServerIcon } from './ServerIcon';

let root: Root;
let host: HTMLDivElement;
let focused = true;
beforeEach(() => {
    focused = true;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
    mime.value = 'image/webp';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
});

/** Renders and lets the (stubbed) first-frame extraction settle. */
const render = async (props: { animate?: boolean; playing?: boolean } = {}) => {
    await act(async () => {
        root.render(React.createElement(ServerIcon, {
            serverId: 's1', name: 'Night Owls', attachmentId: 'a1', keyB64: 'k', nonceB64: 'n', token: 't', ...props,
        }));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const img = () => host.querySelector('img') as HTMLImageElement;

describe('ServerIcon: animated icons and banners', () => {
    it('a list shows the FIRST FRAME by default', async () => {
        await render();
        expect(img().getAttribute('src')).toBe(STILL);
    });

    it('plays on hover and returns to the still when the pointer leaves', async () => {
        await render();
        act(() => { img().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
        expect(img().getAttribute('src')).toBe(FULL);
        act(() => { img().dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); });
        expect(img().getAttribute('src')).toBe(STILL);
    });

    it('plays when a parent says so (the rail tile around it is hovered)', async () => {
        await render({ playing: true });
        expect(img().getAttribute('src')).toBe(FULL);
    });

    it('the open server (`animate`) plays while the app is in front ...', async () => {
        await render({ animate: true });
        expect(img().getAttribute('src')).toBe(FULL);
    });

    it('... and freezes on the first frame when the app is NOT in front', async () => {
        focused = false;
        // a window blur is what useAppInFront listens for
        await render({ animate: true });
        act(() => { window.dispatchEvent(new Event('blur')); });
        expect(img().getAttribute('src')).toBe(STILL);
        focused = true;
        act(() => { window.dispatchEvent(new Event('focus')); });
        expect(img().getAttribute('src')).toBe(FULL);
    });

    it('a static icon is never swapped for anything', async () => {
        mime.value = 'image/jpeg';
        await render();
        expect(img().getAttribute('src')).toBe(FULL);
        act(() => { img().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
        expect(img().getAttribute('src')).toBe(FULL);
    });
});
