// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OverlayStatus } from '../utils/desktopAnnotationOverlay';

/**
 * The sharer's "Drawings won't show on your screen" (X11, no compositor), end to
 * end below SidebarConference: the overlay status the desktop overlay module
 * publishes -> useSharerOverlayNote (once per share) -> the queued notice slot.
 * SidebarConference itself is far too large to mount; its few wiring lines are
 * read from source.
 */
const h = vi.hoisted(() => ({
    listeners: new Set<(s: OverlayStatus) => void>(),
    events: [] as Array<{ kind: string; detail: unknown }>,
}));
vi.mock('../utils/desktopAnnotationOverlay', () => ({
    onOverlayStatusChange: (cb: (s: OverlayStatus) => void) => { h.listeners.add(cb); return () => { h.listeners.delete(cb); }; },
}));
vi.mock('../utils/callEventLog', () => ({ logCallEvent: (kind: string, detail: unknown) => { h.events.push({ kind, detail }); } }));
vi.mock('../utils/secureLocalStore', () => ({ default: { getItem: () => null, setItem: () => {} } }));

import { useSharerOverlayNote } from '../hooks/useSharerOverlayNote';
import { useQueuedCallOfferSlot } from '../hooks/useCallNoticeLayer';
import { acquireCallOfferSlot, releaseCallOfferSlot, callOfferSlotHolder, __resetCallOfferSlotForTests } from '../utils/performanceOffer';
import { SHARER_NO_COMPOSITOR_NOTE } from '../utils/sharerOverlayNotice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SC = readFileSync(join(__dirname, 'SidebarConference.tsx'), 'utf8');
const emit = (s: OverlayStatus) => act(() => { for (const l of [...h.listeners]) l(s); });
const NO_CM: OverlayStatus = { kind: 'off', reason: 'no_compositor' };

let root: Root;
let latest: { note: unknown; dismiss: () => void; up: boolean };
const Probe: React.FC<{ sharing: boolean }> = ({ sharing }) => {
    const { note, dismiss } = useSharerOverlayNote(sharing);
    const up = useQueuedCallOfferSlot('sharer-overlay-off', note !== null);
    // eslint-disable-next-line react-hooks/globals -- a test probe reporting what the hooks returned
    latest = { note, dismiss, up };
    return null;
};
const render = (sharing: boolean) => act(() => { root.render(React.createElement(Probe, { sharing })); });

beforeEach(() => {
    h.listeners.clear();
    h.events.length = 0;
    __resetCallOfferSlotForTests();
    (window as unknown as { electronAPI: { platform: string } }).electronAPI = { platform: 'linux' };
    root = createRoot(document.createElement('div'));
});
afterEach(() => {
    act(() => root.unmount());
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('useSharerOverlayNote: the sharer is told, once per share', () => {
    it('no compositor during a share: the note, one enum-only call event, and the card takes the slot', () => {
        render(true);
        expect(latest.note).toBeNull();
        emit(NO_CM);
        expect(latest.note).toBe(SHARER_NO_COMPOSITOR_NOTE);
        expect(latest.up).toBe(true);
        expect(callOfferSlotHolder()).toBe('sharer-overlay-off');
        expect(h.events).toEqual([{ kind: 'annot_overlay', detail: { result: 'told_sharer', reason: 'no_compositor' } }]);
    });

    it('once per share: dismissed, then the compositor drops again mid-share -> not told twice', () => {
        render(true);
        emit(NO_CM);
        act(() => latest.dismiss());
        expect(latest.note).toBeNull();
        expect(callOfferSlotHolder()).toBeNull();      // dismissing gives the slot back
        emit({ kind: 'idle' });
        emit(NO_CM);
        expect(latest.note).toBeNull();
        expect(h.events).toHaveLength(1);
    });

    it('a new share may tell again; the note goes (and frees the slot) when the share ends', () => {
        render(true);
        emit(NO_CM);
        render(false);
        expect(latest.note).toBeNull();
        expect(callOfferSlotHolder()).toBeNull();
        expect(h.listeners.size).toBe(0);              // not listening between shares
        render(true);
        emit(NO_CM);
        expect(latest.note).toBe(SHARER_NO_COMPOSITOR_NOTE);
        expect(h.events).toHaveLength(2);
    });

    it('queued, not dropped, behind a card already in the slot', () => {
        acquireCallOfferSlot('share-overload');
        render(true);
        emit(NO_CM);
        expect(latest.note).toBe(SHARER_NO_COMPOSITOR_NOTE);
        expect(latest.up).toBe(false);
        act(() => releaseCallOfferSlot('share-overload'));
        expect(latest.up).toBe(true);
        expect(callOfferSlotHolder()).toBe('sharer-overlay-off');
    });

    it('inert on Windows and macOS, and for other overlay states', () => {
        for (const platform of ['windows', 'mac']) {
            (window as unknown as { electronAPI: { platform: string } }).electronAPI = { platform };
            render(false);
            render(true);
            emit(NO_CM);
            expect(latest.note).toBeNull();
        }
        (window as unknown as { electronAPI: { platform: string } }).electronAPI = { platform: 'linux' };
        render(false);
        render(true);
        emit({ kind: 'off', reason: 'declined' });
        emit({ kind: 'idle' });
        expect(latest.note).toBeNull();
        expect(h.events).toEqual([]);
    });

    it('not sharing: never told', () => {
        render(false);
        emit(NO_CM);
        expect(latest.note).toBeNull();
    });
});

describe('SidebarConference wiring', () => {
    it('drives the hook from its own local share, through the queued notice slot', () => {
        expect(SC).toContain('const { note: sharerOverlayCard, dismiss: dismissSharerOverlayCard } = useSharerOverlayNote(!!localScreenShare);');
        expect(SC).toContain('const sharerOverlayCardUp = useQueuedCallOfferSlot(SHARER_OVERLAY_SLOT, sharerOverlayCard !== null);');
    });

    it('renders it as a notice card that asks nothing: "Got it", its own icon, no sound', () => {
        const at = SC.indexOf('{sharerOverlayCard && sharerOverlayCardUp && (');
        expect(at).toBeGreaterThan(0);
        const card = SC.slice(at, at + 600);
        expect(card).toContain('<ShareOverloadOffer');
        expect(card).toContain('cue={false}');
        expect(card).toContain('dismissLabel="Got it"');
        expect(card).toContain('icon={<PenOff size={17} />}');
        expect(card).not.toContain('onSwitch');
        expect(card).toContain('onDismiss={dismissSharerOverlayCard}');
    });

    it('the screen chooser is the prompt the notices yield to', () => {
        expect(SC).toMatch(/<ScreenChoiceDialog\s+choice=\{overlayStatus\.kind === 'choose'/);
        const dlg = readFileSync(join(__dirname, 'call/ScreenChoiceDialog.tsx'), 'utf8');
        expect(dlg).toContain("useHoldCallNotices(!!choice, 'screen-choice');");
        expect(dlg).toContain('overlayStyle={CALL_PROMPT_OVERLAY_STYLE}');
    });
});
