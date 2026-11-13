// @vitest-environment jsdom
/**
 * Owner: "animated server icons are still playing when I am not in the server".
 * Hover a rail tile, click it (`animate` turns on under the pointer), then move
 * to another server. The icon must not stay stuck playing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FULL = 'blob:full-gif';
const STILL = 'blob:still';

vi.mock('../../hooks/useEncryptedAvatar', () => ({
    useEncryptedAvatar: () => FULL,
    avatarUrlMime: () => 'image/gif',
}));
vi.mock('../../utils/safeMediaUrl', () => ({ safeImageSrc: (u: string | null) => u }));
vi.hoisted(() => {
    const g = globalThis as Record<string, unknown>;
    g.fetch = async () => ({ blob: async () => new Blob(['x']) });
    g.createImageBitmap = async () => ({ width: 8, height: 8, close() {} });
    HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {} })) as never;
    HTMLCanvasElement.prototype.toBlob = function (cb: (b: Blob | null) => void) { cb(new Blob(['x'], { type: 'image/png' })); };
});

import { ServerIcon } from './ServerIcon';

describe('ServerIcon', () => {
    let host: HTMLDivElement, root: Root;
    const render = (animate: boolean) => act(async () => {
        root.render(React.createElement(ServerIcon, {
            serverId: 's', name: 'Server', attachmentId: 'a', keyB64: 'k', nonceB64: 'n', token: 't', animate,
        }));
    });
    const src = () => host.querySelector('img')?.getAttribute('src');
    const mouse = (type: 'mouseover' | 'mouseout') => act(async () => {
        host.querySelector('img')!.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: document.body }));
    });
    const focus = (v: boolean) => {
        vi.spyOn(document, 'hasFocus').mockReturnValue(v);
        return act(async () => { window.dispatchEvent(new Event(v ? 'focus' : 'blur')); });
    };

    beforeEach(async () => {
        (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => STILL;
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await focus(true);
        await render(false);
        await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    });
    afterEach(() => {
        act(() => root.unmount());
        host.remove();
        vi.restoreAllMocks();
    });

    it('shows the first frame when you are not in the server', () => {
        expect(src()).toBe(STILL);
    });

    it('hover, click it open, leave it, move to another server: not stuck playing', async () => {
        await mouse('mouseover');
        expect(src()).toBe(FULL);
        await render(true);        // clicked: you are in this server now
        expect(src()).toBe(FULL);
        await mouse('mouseout');   // the pointer moves on to another tile
        expect(src()).toBe(FULL);  // still in this server
        await render(false);       // you went to that other server
        expect(src()).toBe(STILL);
    });

    it('nothing plays while the window is not focused: not open, not hovered', async () => {
        await render(true);
        expect(src()).toBe(FULL);
        await focus(false);
        expect(src()).toBe(STILL);
        await render(false);
        await mouse('mouseover');
        expect(src()).toBe(STILL);
        await focus(true);
        expect(src()).toBe(FULL);  // still hovered, window back
        await mouse('mouseout');
        expect(src()).toBe(STILL);
    });
});
