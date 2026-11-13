// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../ResetSlider', () => ({ ResetSlider: () => null }));
vi.mock('../moments/VolumeCeilingWatch', () => ({ VolumeCeilingWatch: () => null }));
vi.mock('../../utils/secureLocalStore', () => ({ default: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }));

import { PopoverMenu, SelfStreamMenu } from './PopoverMenu';

const rows = () => [...document.querySelectorAll('[role^="menuitem"]')].map(el => el.textContent ?? '');
const row = (label: string) => [...document.querySelectorAll('[role^="menuitem"]')].find(el => el.textContent === label) as HTMLElement | undefined;

let el: HTMLElement;
let root: Root;
const render = async (node: React.ReactElement) => { await act(async () => { root.render(node); }); };

beforeEach(() => {
    el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
});
afterEach(async () => {
    await act(async () => { root.unmount(); });
    el.remove();
});

const remote = (extra: Partial<React.ComponentProps<typeof PopoverMenu>>) => React.createElement(PopoverMenu, {
    displayName: 'Amy', volume: 1, isLocalMuted: false, onVolumeChange: () => {}, onMuteChange: () => {},
    popoverRef: React.createRef<HTMLDivElement>(), style: {},
    ...extra,
});
const self = (extra: Partial<React.ComponentProps<typeof SelfStreamMenu>>) => React.createElement(SelfStreamMenu, {
    displayName: 'Me', ownShare: null, popoverRef: React.createRef<HTMLDivElement>(), style: {}, onClose: () => {},
    ...extra,
});

describe('the fill row on someone else\'s tile', () => {
    it('is there only when fullscreen passes it, so no other surface gets it', async () => {
        await render(remote({}));
        expect(rows().some(r => /Fill/.test(r))).toBe(false);
        await render(remote({ onToggleFill: () => {} }));
        expect(rows()).toContain('Fill Entire Screen');
    });

    it('offers the way out while filled, and clicking it toggles', async () => {
        const onToggleFill = vi.fn();
        await render(remote({ onToggleFill, isFilled: true }));
        expect(rows()).toContain('Exit Fill Screen');
        expect(rows()).not.toContain('Fill Entire Screen');
        await act(async () => { row('Exit Fill Screen')!.click(); });
        expect(onToggleFill).toHaveBeenCalledTimes(1);
    });
});

describe('the menu on your own tile', () => {
    it('your share: Fill and Hide, and nothing aimed at another person', async () => {
        await render(self({ ownShare: 'hide', onHideOwnShareChange: () => {}, onToggleFill: () => {} }));
        expect(rows()).toEqual(['Fill Entire Screen', 'Hide Screen Share']);
    });

    it('Hide asks to hide, Show asks to show, and both close the menu', async () => {
        const onHide = vi.fn();
        const onClose = vi.fn();
        await render(self({ ownShare: 'hide', onHideOwnShareChange: onHide, onClose }));
        await act(async () => { row('Hide Screen Share')!.click(); });
        expect(onHide).toHaveBeenLastCalledWith(true);
        expect(onClose).toHaveBeenCalledTimes(1);
        await render(self({ ownShare: 'show', onHideOwnShareChange: onHide, onClose }));
        await act(async () => { row('Show Screen Share')!.click(); });
        expect(onHide).toHaveBeenLastCalledWith(false);
        expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('your camera with no hidden share: just Fill', async () => {
        await render(self({ ownShare: null, onToggleFill: () => {} }));
        expect(rows()).toEqual(['Fill Entire Screen']);
    });

    it('Fill closes the menu too', async () => {
        const onToggleFill = vi.fn();
        const onClose = vi.fn();
        await render(self({ ownShare: null, onToggleFill, onClose }));
        await act(async () => { row('Fill Entire Screen')!.click(); });
        expect(onToggleFill).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('Escape closes it', async () => {
        const onClose = vi.fn();
        await render(self({ ownShare: null, onClose }));
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

/** VideoTile and SidebarConference cannot be imported into a test (see useParticipantTrackState.ts), so these are pinned at the source. */
describe('wiring', () => {
    const read = (...p: string[]) => readFileSync(join(__dirname, ...p), 'utf8');
    const sidebar = read('..', 'SidebarConference.tsx');
    const tile = read('VideoTile.tsx');

    it('only fullscreen and the focused view give your own tile a menu: elsewhere a right-click still does nothing', () => {
        expect(tile).toContain('if (isLocal && !onToggleFill) return;');
        expect(read('FullscreenOverlay.tsx')).toContain('onToggleFill: () => setFill(');
        expect(read('FocusedStreamBanner.tsx')).toContain('onToggleFill={() => callCtx.requestFill(');
        expect(sidebar).not.toContain('onToggleFill');
    });

    it('a fill requested from the focused view enters fullscreen and is picked up there', () => {
        const ctx = readFileSync(join(__dirname, '..', '..', 'contexts', 'CallContext.tsx'), 'utf8');
        expect(ctx).toMatch(/setFillRequest\(stream\);\s*setIsFullscreen\(true\);/);
        const overlay = read('FullscreenOverlay.tsx');
        expect(overlay).toMatch(/setFill\(fillRequest\);\s*callCtx\.takeFillRequest\(\);/);
    });

    it('your own tile never renders the remote menu', () => {
        expect(tile).toContain('{showPopover && !isLocal && ReactDOM.createPortal(\n            <PopoverMenu');
        expect(tile).toContain('{showPopover && isLocal && ReactDOM.createPortal(\n            <SelfStreamMenu');
    });

    it('hiding your own share leaves before anything that touches the watch set or a publication', () => {
        const start = sidebar.indexOf('const toggleHideScreenShare = async');
        const body = sidebar.slice(start, sidebar.indexOf('\n    };', start));
        const ownBranch = body.indexOf('if (id === localParticipant?.identity)');
        const ownReturn = body.indexOf('return;', ownBranch);
        expect(ownBranch).toBeGreaterThan(-1);
        expect(ownReturn).toBeGreaterThan(ownBranch);
        expect(ownReturn).toBeLessThan(body.indexOf('handleStopWatchingScreenshare'));
        expect(ownReturn).toBeLessThan(body.indexOf('setSubscribed'));
        expect(body.slice(ownBranch, ownReturn)).not.toMatch(/setSubscribedScreenshares|setSubscribed\(|unsubscribeShareTracks/);
    });

    it('the hide flag on your own share is not pruned as if you were not sharing', () => {
        const start = sidebar.indexOf('const ownActiveShareId');
        const eff = sidebar.slice(start, sidebar.indexOf('}, [activeScreenShareIds, ownActiveShareId]);', start));
        expect(eff).toContain('activeSet.add(ownActiveShareId)');
        expect(eff).toContain('setHiddenScreenShareIds');
    });

    it('the docked view draws your share through the one pause, and honours the hide', () => {
        expect(sidebar).not.toContain('useWindowFocus');
        expect(sidebar).toContain("import { LocalScreenShareTile } from './call/LocalScreenShareTile';");
        const sites = [...sidebar.matchAll(/\{localShareTile && !isFocusedInSidebar\(localParticipant!\.identity, Track\.Source\.ScreenShare\) && \(/g)];
        expect(sites).toHaveLength(2);
    });

    it('so do the focused banner and fullscreen', () => {
        for (const file of ['FocusedStreamBanner.tsx', 'FullscreenOverlay.tsx']) {
            const src = read(file);
            expect(src).toContain("from './LocalScreenShareTile';");
            expect(src).not.toMatch(/<VideoTile\b/);
            expect(src).toMatch(/<CallStreamTile\b/);
        }
    });

    it('hiding your preview does not stop the desktop annotation overlay: it stays keyed on the share itself', () => {
        const call = sidebar.match(/useDesktopAnnotationOverlay\(([\s\S]*?)\);/)![1];
        expect(call).toContain('localScreenShare');
        expect(call).not.toContain('localShareTile');
    });
});
