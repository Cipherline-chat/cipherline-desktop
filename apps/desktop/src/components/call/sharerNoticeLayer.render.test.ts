// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OverlayScreenChoice } from '../../utils/annotationOverlayTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The Linux-lab bug, with the real components: the "can't keep up" card and the
 * "Which screen are you sharing?" chooser open at the same moment. The card used
 * to sit on top of the chooser (z 9500 over a modal at z 1000) and swallow the
 * clicks meant for it. Now the chooser is on the prompt layer and the card waits
 * off screen until it is answered, then comes back on its own.
 */
const playSound = vi.fn();
vi.mock('../../utils/notificationSounds', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/notificationSounds')>()),
    playSound: (...a: unknown[]) => playSound(...a),
}));
vi.mock('../../utils/secureLocalStore', () => ({ default: { getItem: () => null, setItem: () => {} } }));

let ScreenChoiceDialog: typeof import('./ScreenChoiceDialog').ScreenChoiceDialog;
let ShareOverloadOffer: typeof import('./ShareOverloadOffer').ShareOverloadOffer;
let layer: typeof import('../../utils/callNoticeLayer');
beforeAll(async () => {
    // ClButton -> clPhysics reads matchMedia at import time; jsdom has none.
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
    ({ ScreenChoiceDialog } = await import('./ScreenChoiceDialog'));
    ({ ShareOverloadOffer } = await import('./ShareOverloadOffer'));
    layer = await import('../../utils/callNoticeLayer');
}, 60_000);

const CHOICE: OverlayScreenChoice = {
    displays: [
        { id: 1, x: 0, y: 0, width: 1920, height: 1080, primary: true },
        { id: 2, x: 1920, y: 0, width: 1920, height: 1080, primary: false },
    ],
    candidates: [1, 2],
};

let host: HTMLDivElement;
let root: Root;
const onPick = vi.fn();
const onSwitch = vi.fn();

function Scene({ choice, card }: { choice: OverlayScreenChoice | null; card: boolean }) {
    return React.createElement(React.Fragment, null,
        React.createElement(ScreenChoiceDialog, { choice, onPick, onDecline: () => {} }),
        card ? React.createElement(ShareOverloadOffer, { current: 'Source at 90 fps', suggested: '1440p at 90 fps', onSwitch, onDismiss: () => {} }) : null,
    );
}
const render = (choice: OverlayScreenChoice | null, card = true) => act(() => { root.render(React.createElement(Scene, { choice, card })); });
const flushFrames = () => act(async () => { await new Promise(r => setTimeout(r, 50)); });

const cardWrapper = () => document.querySelector<HTMLElement>('[data-testid="call-notice-wrapper"]');
const modalOverlay = () => document.querySelector<HTMLElement>('.mod');

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    playSound.mockReset();
    onPick.mockReset();
    onSwitch.mockReset();
});
afterEach(async () => {
    act(() => root.unmount());
    host.remove();
    await new Promise(r => setTimeout(r, 300));     // ClModal's exit timer
    layer.__resetCallNoticeHoldsForTests();
});

describe('sharer notices and the screen chooser, open together', () => {
    it('the chooser sits on the prompt layer, above the card layer', async () => {
        render(CHOICE);
        await flushFrames();
        const overlay = modalOverlay();
        const wrapper = cardWrapper();
        expect(overlay).not.toBeNull();
        expect(wrapper).not.toBeNull();
        expect(Number(overlay!.style.zIndex)).toBe(layer.CALL_PROMPT_Z);
        expect(Number(wrapper!.style.zIndex)).toBe(layer.CALL_NOTICE_Z);
        expect(Number(overlay!.style.zIndex)).toBeGreaterThan(Number(wrapper!.style.zIndex));
    });

    it('while the chooser is open the card waits off screen (not dismissed), and makes no sound', async () => {
        render(CHOICE);
        await flushFrames();
        expect(cardWrapper()!.style.display).toBe('none');
        expect(playSound).not.toHaveBeenCalled();
        // The chooser's own buttons are reachable: picking a screen reaches its handler.
        act(() => { document.querySelector<HTMLButtonElement>('[data-testid="screen-choice-1"]')!.click(); });
        expect(onPick).toHaveBeenCalledWith(1);
    });

    it('answered: the card comes back where it was, and cues now that it can be seen', async () => {
        render(CHOICE);
        await flushFrames();
        render(null);
        await flushFrames();
        const wrapper = cardWrapper()!;
        expect(wrapper.style.display).toBe('');
        expect(playSound).toHaveBeenCalledTimes(1);
        expect(playSound.mock.calls[0][0]).toBe('call_prompt');
        // ...and its own buttons work again.
        act(() => { [...wrapper.querySelectorAll('button')].find(b => b.textContent === 'Switch')!.click(); });
        expect(onSwitch).toHaveBeenCalledTimes(1);
    });

    it('no chooser: the card shows at once, exactly as before', async () => {
        render(null);
        await flushFrames();
        expect(cardWrapper()!.style.display).toBe('');
        expect(playSound).toHaveBeenCalledTimes(1);
    });

    it('a card with cue={false} (a note that asks nothing) never makes a sound', async () => {
        act(() => {
            root.render(React.createElement(ShareOverloadOffer, { title: 'Drawings won’t show on your screen', body: 'x', dismissLabel: 'Got it', cue: false, onDismiss: () => {} }));
        });
        await flushFrames();
        expect(cardWrapper()!.textContent).toContain('Drawings won’t show on your screen');
        expect(playSound).not.toHaveBeenCalled();
    });
});
