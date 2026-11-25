// @vitest-environment jsdom
/**
 * The image viewer a linked image opens in (ChatPane ImageLinkEmbed) offers
 * "Open original" and "Save" (docs/plans/embeds.md §6). Save uses the bytes
 * already loaded (a blob: URL) through the shared save path; it is not
 * offered for a remote src. Other viewers (attachments, avatars) pass no
 * externalUrl and are unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const saved = vi.hoisted(() => {
    // The button kit reads matchMedia at import; jsdom has none.
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
    return [] as [string, unknown][];
});
vi.mock('./executableDownloadGuard', () => ({
    saveReceivedFile: vi.fn(async (url: string, name: unknown) => { saved.push([url, name]); return true; }),
}));

import { ImageLightbox } from './ImageLightbox';
import { ToastProvider } from '../contexts/ToastContext';
import { confirmLeave, getLeaveSnapshot, registerLeaveHost } from '../utils/externalLinks/leaveGate';
import { setUserGestureProbeForTests } from '../utils/externalLinks/shellOpen';

/** A real click carries a user gesture; the leaving-Cipherline dialog host is
 *  mounted app-wide. Returns the URL the gate asked about, then "presses Visit". */
function viaLeaveDialog(click: () => void): string | null {
    setUserGestureProbeForTests(() => true);
    const off = registerLeaveHost();
    try {
        click();
        const req = getLeaveSnapshot();
        if (!req) return null;
        confirmLeave(req.id);
        return req.model.href;
    } finally {
        off();
        setUserGestureProbeForTests(null);
    }
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
let root: Root | null = null;
let host: HTMLDivElement;
let openExternal: ReturnType<typeof vi.fn>;

const btn = (label: string) => document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

function mount(props: Partial<React.ComponentProps<typeof ImageLightbox>>) {
    act(() => {
        root!.render(h(ToastProvider, null, h(ImageLightbox, { src: 'blob:x', onClose: () => {}, ...props })));
    });
}

beforeEach(() => {
    saved.length = 0;
    openExternal = vi.fn(async () => {});
    (window as unknown as { electronAPI: unknown }).electronAPI = { openExternal };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host.remove();
});

describe('ImageLightbox link actions', () => {
    it('a linked, loaded image: Open original opens the link; Save saves the loaded bytes', () => {
        mount({ src: 'blob:http://localhost/abc', externalUrl: 'https://media.tenor.com/x/cat.gif', filename: 'cat.gif' });
        // Through the leaving-Cipherline dialog: nothing opens until Visit.
        expect(viaLeaveDialog(() => act(() => { btn('Open original')!.click(); }))).toBe('https://media.tenor.com/x/cat.gif');
        expect(openExternal).toHaveBeenCalledWith('https://media.tenor.com/x/cat.gif');
        act(() => { btn('Save image')!.click(); });
        expect(saved).toEqual([['blob:http://localhost/abc', 'cat.gif']]);
    });

    it('a remote src gets Open original but no Save', () => {
        mount({ src: 'https://static.klipy.com/x.gif', externalUrl: 'https://static.klipy.com/x.gif' });
        expect(btn('Open original')).not.toBeNull();
        expect(btn('Save image')).toBeNull();
    });

    it('no externalUrl (attachments, avatars): unchanged, no link actions', () => {
        mount({ src: 'blob:http://localhost/abc' });
        expect(btn('Open original')).toBeNull();
        expect(btn('Save image')).toBeNull();
    });
});
