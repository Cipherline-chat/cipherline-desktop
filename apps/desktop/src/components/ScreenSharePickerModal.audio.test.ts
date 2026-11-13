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
import { isPortalSourceId } from '../utils/portalSource';
import { getCallEvents, clearCallEvents } from '../utils/callEventLog';

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
const audioBox = () => document.body.querySelector('[data-testid="share-audio-toggle"] [role="checkbox"]') as HTMLButtonElement | null;
const buttonNamed = (label: string) => Array.from(document.body.querySelectorAll('button')).find(b => (b.textContent ?? '').trim() === label) as HTMLButtonElement | undefined;
const shareButton = () => buttonNamed('Share')!;
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 300)); }); // dismiss() answers after its 260 ms exit

async function open(
    source: Src, viaPortal: boolean, initialAudio?: boolean,
    extra: { apps?: App[] | (() => App[]); initialAppAudio?: { handle: string; name: string }; liveSourceId?: string } = {},
): Promise<ScreenShareOptions[]> {
    installApi(source, { viaPortal, apps: extra.apps });
    const picked: ScreenShareOptions[] = [];
    act(() => {
        root.render(React.createElement(ScreenSharePickerModal, {
            onSelect: (o: ScreenShareOptions | null) => { if (o) picked.push(o); },
            ...(initialAudio === undefined ? {} : { initialAudio }),
            ...(extra.initialAppAudio ? { initialAppAudio: extra.initialAppAudio } : {}),
            ...(extra.liveSourceId ? { liveSourceId: extra.liveSourceId } : {}),
        }));
    });
    await flush();
    return picked;
}

const SCREEN: Src = { id: 'screen:0:0', name: 'Screen', thumbnailDataUrl: '' };
const WINDOW: Src = { id: 'window:7:0', name: 'Some window', thumbnailDataUrl: '' };

describe('ScreenSharePickerModal - the audio box (X11: the picker enumerates)', () => {
    it('a fresh share starts with the box off', async () => {
        const picked = await open(SCREEN, false);
        expect(audioBox()?.getAttribute('aria-checked')).toBe('false');
        await act(async () => { shareButton().click(); });
        await settle();
        expect(picked[0]?.audio).toBe(false);
    });

    it('Change source opens ticked when the running share has audio, and the pick keeps it', async () => {
        const picked = await open(SCREEN, false, true);
        expect(audioBox()?.getAttribute('aria-checked')).toBe('true');
        await act(async () => { shareButton().click(); });
        await settle();
        expect(picked[0]).toMatchObject({ sourceId: 'screen:0:0', audio: true });
    });

    it('the seeded box can still be switched off', async () => {
        const picked = await open(SCREEN, false, true);
        await act(async () => { audioBox()!.click(); });
        await act(async () => { shareButton().click(); });
        await settle();
        expect(picked[0]?.audio).toBe(false);
    });

    it('a window on X11 can carry audio: the owning process is found from the window id', async () => {
        const picked = await open(WINDOW, false, true);
        const box = audioBox()!;
        expect(box.disabled).toBe(false);
        expect(box.getAttribute('aria-checked')).toBe('true');
        expect(document.body.textContent).not.toContain('Share the whole screen to include audio');
        await act(async () => { shareButton().click(); });
        await settle();
        expect(picked[0]).toMatchObject({ sourceId: 'window:7:0', audio: true });
    });

    it('X11 windows keep the automatic pid route (a box, no app chooser)', async () => {
        await open(WINDOW, false, true, { apps: [{ handle: 'aa_firefox', name: 'Firefox', binary: 'firefox' }] });
        expect(document.body.querySelector('[data-testid="share-audio-app"]')).toBeNull();
        expect(document.body.querySelector('[data-testid="share-audio-portal"]')).toBeNull();
        expect(audioBox()).not.toBeNull();
    });
});

// ── Wayland (the portal): nothing is listed; "Choose what to share…" is the capture ───────────────────
const FIREFOX: App = { handle: 'aa_firefox', name: 'Firefox', binary: 'firefox' };
const SPOTIFY: App = { handle: 'aa_spotify', name: 'Spotify', binary: 'spotify' };
const APPS = [FIREFOX, SPOTIFY];

const portalBox = () => document.body.querySelector('[data-testid="share-audio-portal"]') as HTMLElement | null;
const modeTrigger = () => portalBox()!.querySelector('button') as HTMLButtonElement;
const modeItems = () => Array.from(portalBox()!.querySelectorAll('[data-dropdown-list] button')) as HTMLButtonElement[];
const appBox = () => document.body.querySelector('[data-testid="share-audio-app"]') as HTMLElement | null;
const appTrigger = () => appBox()!.querySelector('button') as HTMLButtonElement;
const appItems = () => Array.from(appBox()!.querySelectorAll('[data-dropdown-list] button')) as HTMLButtonElement[];
const chooseButton = () => buttonNamed('Choose what to share…') as HTMLButtonElement;
async function chooseNow(picked: ScreenShareOptions[]) {
    await act(async () => { chooseButton().click(); });
    await settle();
    return picked[picked.length - 1];
}
async function setMode(label: string) {
    await act(async () => { modeTrigger().click(); });
    await act(async () => { modeItems().find(b => b.textContent === label)!.click(); });
}

describe('ScreenSharePickerModal - through the Wayland portal', () => {
    it('lists nothing and opens no chooser: no source request is made, whatever it is shown', async () => {
        await open(SCREEN, true);
        expect(getDesktopSources).not.toHaveBeenCalled();
        expect(document.body.querySelector('[data-testid="share-portal-step"]')).not.toBeNull();
        expect(chooseButton().textContent).toContain('Choose what to share');
    });

    it('"Choose what to share…" hands the share a placeholder id, with the quality as set (the capture is the chooser)', async () => {
        const picked = await open(SCREEN, true);
        const out = await chooseNow(picked);
        expect(isPortalSourceId(out.sourceId)).toBe(true);
        expect(out).toMatchObject({ resolution: '1080p', frameRate: 30, audio: false });
        expect(out.appAudio).toBeUndefined();
        expect(getDesktopSources).not.toHaveBeenCalled();
    });

    it('every choice is a NEW placeholder: that difference is how the share code knows it is another capture', async () => {
        const a = await chooseNow(await open(SCREEN, true));
        act(() => { root.unmount(); });
        root = createRoot(host);
        const b = await chooseNow(await open(SCREEN, true));
        expect(a.sourceId).not.toBe(b.sourceId);
    });

    it('a fresh share starts with no audio; the mode dropdown offers none / everything except Cipherline / one app', async () => {
        await open(SCREEN, true, undefined, { apps: APPS });
        expect(modeTrigger().textContent).toContain('None');
        await act(async () => { modeTrigger().click(); });
        expect(modeItems().map(b => b.textContent)).toEqual(['None', 'Everything except Cipherline', 'One app']);
    });

    it('without a way to list apps the "one app" choice is not offered', async () => {
        await open(SCREEN, true);
        await act(async () => { modeTrigger().click(); });
        expect(modeItems().map(b => b.textContent)).toEqual(['None', 'Everything except Cipherline']);
    });

    it('everything except Cipherline: audio on, no app', async () => {
        const picked = await open(SCREEN, true, undefined, { apps: APPS });
        await setMode('Everything except Cipherline');
        expect(appBox()).toBeNull();
        const out = await chooseNow(picked);
        expect(out.audio).toBe(true);
        expect(out.appAudio).toBeUndefined();
    });

    it('one app: the chooser appears, "None" until one is picked, and the pick travels as the handle', async () => {
        const picked = await open(SCREEN, true, undefined, { apps: APPS });
        await setMode('One app');
        expect(appBox()).not.toBeNull();
        expect(appTrigger().textContent).toContain('None');
        await act(async () => { appTrigger().click(); });
        expect(appItems().map(b => b.textContent)).toEqual(['None', 'Firefox', 'Spotify']);
        await act(async () => { appItems()[2].click(); });
        expect(appTrigger().textContent).toContain('Spotify');
        expect(await chooseNow(picked)).toMatchObject({ audio: true, appAudio: { handle: 'aa_spotify', name: 'Spotify' } });
    });

    it('"one app" with no app picked shares without audio - never a silent guess', async () => {
        const picked = await open(SCREEN, true, undefined, { apps: APPS });
        await setMode('One app');
        const out = await chooseNow(picked);
        expect(out.audio).toBe(false);
        expect(out.appAudio).toBeUndefined();
    });

    it('with nothing playing it says so and offers only None', async () => {
        await open(SCREEN, true, undefined, { apps: [] });
        await setMode('One app');
        expect(document.body.querySelector('[data-testid="share-audio-app-hint"]')?.textContent).toMatch(/No app is playing audio/);
        await act(async () => { appTrigger().click(); });
        expect(appItems().map(b => b.textContent)).toEqual(['None']);
    });

    it('Change source opens with the running share\'s audio: system audio stays ticked, and a chosen app is kept', async () => {
        const sys = await open(SCREEN, true, true);
        expect(modeTrigger().textContent).toContain('Everything except Cipherline');
        expect((await chooseNow(sys)).audio).toBe(true);
        act(() => { root.unmount(); });
        root = createRoot(host);
        const app = await open(SCREEN, true, true, { apps: [FIREFOX], initialAppAudio: { handle: 'aa_spotify', name: 'Spotify' } });
        expect(modeTrigger().textContent).toContain('One app');
        // an app that is not playing right now is still shown, labelled, and kept
        expect(appTrigger().textContent).toContain('Spotify (not playing right now)');
        expect(await chooseNow(app)).toMatchObject({ audio: true, appAudio: { handle: 'aa_spotify' } });
    });

    it('mid-share, "Apply to current share" keeps the running capture: the same placeholder, new quality / audio, no new chooser', async () => {
        const live = 'screen:portal-abc123:0';
        const picked = await open(SCREEN, true, false, { liveSourceId: live });
        await act(async () => { buttonNamed('Apply to current share')!.click(); });
        await settle();
        expect(picked[0]).toMatchObject({ sourceId: live, audio: false });
        // and "Choose what to share…" beside it is still a NEW capture
        act(() => { root.unmount(); });
        root = createRoot(host);
        const again = await open(SCREEN, true, false, { liveSourceId: live });
        expect((await chooseNow(again)).sourceId).not.toBe(live);
    });

    it('there is no "Apply to current share" for a first share', async () => {
        await open(SCREEN, true);
        expect(buttonNamed('Apply to current share')).toBeUndefined();
    });

    it('logs a COUNT and how the app was chosen - never a name', async () => {
        clearCallEvents();
        const picked = await open(SCREEN, true, undefined, { apps: APPS });
        await setMode('One app');
        await act(async () => { appTrigger().click(); });
        await act(async () => { appItems()[1].click(); });
        await chooseNow(picked);
        const ev = getCallEvents().find(e => e.kind === 'share_audio' && e.detail?.step === 'picked')!;
        expect(ev.detail).toMatchObject({ step: 'picked', mode: 'app', apps: 2, how: 'manual' });
        expect(JSON.stringify(getCallEvents())).not.toMatch(/Firefox|Spotify|firefox|spotify|aa_/);
    });
});
