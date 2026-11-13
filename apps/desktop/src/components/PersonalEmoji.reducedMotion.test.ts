// @vitest-environment jsdom
/**
 * A My Emoji that is animated, viewed with the OS "reduce motion" setting, must
 * never render as an <img> with no source (a blank box). It shows the loading
 * look while its first frame is decoded, then the frame; if the frame cannot
 * be decoded it falls back to the animation itself.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const state = { reduced: true, animated: true, bytes: new Uint8Array([1, 2, 3]) as Uint8Array | null };
const still = vi.fn<(...a: unknown[]) => Promise<string | null>>();

vi.mock('../hooks/usePersonalEmojis', () => ({
    usePersonalEmojiUrl: () => ({ status: 'ready', url: 'blob:animated' }),
    useIsInMyEmojis: () => false,
}));
vi.mock('../hooks/usePrefersReducedMotion', () => ({ usePrefersReducedMotion: () => state.reduced }));
vi.mock('../contexts/ToastContext', () => ({ useToast: () => ({ push: vi.fn() }) }));
// ONE store object: the component lists it as an effect dependency, as the real singleton is.
const store = { meta: () => ({ a: state.animated ? 1 : 0, m: 'image/webp' }), read: async () => state.bytes };
vi.mock('../utils/personalEmoji/service', () => ({ personalEmojis: () => ({ store }) }));
vi.mock('../utils/personalEmoji/stillFrame', () => ({ stillFrameUrl: (...a: unknown[]) => still(...a) }));

import { PersonalEmojiImage } from './PersonalEmoji';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const ID = 'p_' + 'a'.repeat(32);
const mount = async () => {
    await act(async () => { root.render(React.createElement(PersonalEmojiImage, { id: ID, name: 'wave' })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};

beforeEach(() => {
    state.reduced = true; state.animated = true; state.bytes = new Uint8Array([1, 2, 3]);
    still.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('PersonalEmojiImage while the window is not focused', () => {
    const setFocus = (v: boolean) => {
        vi.spyOn(document, 'hasFocus').mockReturnValue(v);
        return act(async () => {
            window.dispatchEvent(new Event(v ? 'focus' : 'blur'));
            await Promise.resolve(); await Promise.resolve();
        });
    };
    afterEach(() => { vi.restoreAllMocks(); });

    it('freezes on the first frame, with no placeholder flash, and plays again on return', async () => {
        state.reduced = false;
        let release: (u: string) => void = () => {};
        still.mockReturnValue(new Promise<string>(r => { release = r; }));
        await setFocus(true);
        await mount();
        expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:animated');
        await setFocus(false);
        expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:animated'); // still decoding: stays, no blank
        await act(async () => { release('blob:still'); await Promise.resolve(); await Promise.resolve(); });
        expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:still');
        await setFocus(true);
        expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:animated');
    });
});

describe('PersonalEmojiImage under reduced motion', () => {
    it('shows the decoded first frame', async () => {
        still.mockResolvedValue('blob:still');
        await mount();
        expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:still');
    });

    it('shows the loading look (not a blank <img>) while the frame is still being decoded', async () => {
        still.mockReturnValue(new Promise(() => { /* never settles */ }));
        await mount();
        expect(host.querySelector('img')).toBeNull();
        expect(host.querySelector('.animate-pulse')).not.toBeNull();
    });

    it('falls back to the animation when the first frame cannot be decoded', async () => {
        still.mockResolvedValue(null);
        await mount();
        expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:animated');
    });

    it('falls back to the animation when the bytes are unreadable', async () => {
        state.bytes = null;
        await mount();
        expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:animated');
    });

    it('a still image, or normal motion, is untouched', async () => {
        state.reduced = false;
        await mount();
        expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:animated');
        expect(still).not.toHaveBeenCalled();
    });
});
