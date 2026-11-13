// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});

/**
 * (Harness copied from ScreenSharePickerModal.audio.test.ts.)
 * The audio choice in the Linux picker.
 *
 *  - X11 (no portal): the picker enumerates, the user picks a source, and the audio is a box (a window's owning
 *    process is found from its id; a screen is "everything except Cipherline"). Unchanged.
 *  - Wayland (the portal): NOTHING is listed - a listing is the desktop's chooser, and the capture that follows
 *    opens it again (two dialogs for one choice, measured). The picker takes the quality and the audio, and
 *    "Choose what to share…" hands the share a placeholder id; the capture's own chooser is the one and only
 *    (electron/portal-source.ts). The audio is therefore named by what it IS: none, everything except Cipherline,
 *    or one app (the portal gives a window no process, and the picker cannot know window from screen yet).
 *  - Change source mid-share opens with the running share's audio (`initialAudio` / `initialAppAudio`): every
 *    source swap restarts the audio capture, so an unticked box meant "audio off" and a Linux tester's
 *    six-minute audio share lost its audio at the first swap (2026-11-04 reports).
 */
import { ScreenSharePickerModal, type ScreenShareOptions } from './ScreenSharePickerModal';
import { __resetDesktopSourceCacheForTests } from '../utils/desktopSourceCache';
import { resetCaptureViaPortalForTests } from '../utils/sharePlatformSupport';

type Src = { id: string; name: string; thumbnailDataUrl: string };
let root: Root;
let host: HTMLDivElement;
let getDesktopSources: ReturnType<typeof vi.fn>;

type App = { handle: string; name: string; binary: string };
function installApi(source: Src, opts: { viaPortal: boolean; apps?: App[] | (() => App[]) }) {
    getDesktopSources = vi.fn(async () => [source]);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
        ...(opts.apps ? { listAudioApps: vi.fn(async () => (typeof opts.apps === 'function' ? opts.apps() : opts.apps!)) } : {}),
        platform: 'linux',
        getDisplayRefreshRates: async () => [],
        getScreenCaptureAccess: async () => 'not-applicable',
        getShareCapturePath: async () => ({ viaPortal: opts.viaPortal }),
        isAudioCaptureSupported: async () => true,
        getDesktopSources,
    };
}

beforeEach(() => {
    __resetDesktopSourceCacheForTests();
    resetCaptureViaPortalForTests();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };
const buttonNamed = (label: string) => Array.from(document.body.querySelectorAll('button')).find(b => (b.textContent ?? '').trim() === label) as HTMLButtonElement | undefined;
const shareButton = () => buttonNamed('Share')!;
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 300)); }); // dismiss() answers after its 260 ms exit

async function open(
    source: Src, viaPortal: boolean, initialAudio?: boolean,
    extra: { apps?: App[] | (() => App[]); initialAppAudio?: { handle: string; name: string }; liveSourceId?: string; initialResolution?: ScreenShareOptions['resolution']; initialFrameRate?: ScreenShareOptions['frameRate'] } = {},
): Promise<ScreenShareOptions[]> {
    installApi(source, { viaPortal, apps: extra.apps });
    const picked: ScreenShareOptions[] = [];
    act(() => {
        root.render(React.createElement(ScreenSharePickerModal, {
            onSelect: (o: ScreenShareOptions | null) => { if (o) picked.push(o); },
            ...(initialAudio === undefined ? {} : { initialAudio }),
            ...(extra.initialAppAudio ? { initialAppAudio: extra.initialAppAudio } : {}),
            ...(extra.liveSourceId ? { liveSourceId: extra.liveSourceId } : {}),
            ...(extra.initialResolution ? { initialResolution: extra.initialResolution } : {}),
            ...(extra.initialFrameRate ? { initialFrameRate: extra.initialFrameRate } : {}),
        }));
    });
    await flush();
    return picked;
}

const SCREEN: Src = { id: 'screen:0:0', name: 'Screen', thumbnailDataUrl: '' };


/**
 * Owner, 2026-11-11, every platform: "when changing source on a screenshare it should remember the quality settings
 * you had selected from before". Change source opens with the running share's resolution / frame rate; a fresh
 * share starts at the defaults (1080p / 30).
 */
describe('ScreenSharePickerModal - Change source keeps the quality', () => {
    it('a fresh share starts at 1080p / 30', async () => {
        const picked = await open(SCREEN, false);
        await act(async () => { shareButton().click(); });
        await settle();
        expect(picked[0]).toMatchObject({ resolution: '1080p', frameRate: 30 });
    });
    it('Change source opens with the running share\'s quality and the pick keeps it', async () => {
        const picked = await open(SCREEN, false, false, { initialResolution: 'source', initialFrameRate: 60 });
        await act(async () => { shareButton().click(); });
        await settle();
        expect(picked[0]).toMatchObject({ sourceId: 'screen:0:0', resolution: 'source', frameRate: 60 });
    });
    it('a 1440p / 15 share keeps that too (not snapped to a preset)', async () => {
        const picked = await open(SCREEN, false, false, { initialResolution: '1440p', initialFrameRate: 15 });
        await act(async () => { shareButton().click(); });
        await settle();
        expect(picked[0]).toMatchObject({ resolution: '1440p', frameRate: 15 });
    });
    it('wiring: SidebarConference passes the running share\'s quality into the picker', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const sc = fs.readFileSync(path.resolve(__dirname, 'SidebarConference.tsx'), 'utf8');
        expect(sc).toContain('initialResolution={currentShare?.resolution} initialFrameRate={currentShare?.frameRate}');
    });
});
