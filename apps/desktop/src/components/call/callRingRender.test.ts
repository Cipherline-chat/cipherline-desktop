// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Behavioural twin of callRingSurfaces.test.ts (which reads source text): this
 * one RENDERS the speaking-ring surfaces that the normal (non-fullscreen) call
 * view is made of - the voice-channel / call list row, the camera-off tile,
 * and the server roster's SpeakingRing - and checks the inline box-shadow
 * carries the SPEAKER'S chosen colour, follows a later change of it, and falls
 * back to the stock green when nothing is chosen.
 *
 * The heavy children (avatar decryption, the LiveKit-bound hooks re-exported
 * from VideoTile) are stubbed; the ring logic under test is the real code.
 */
vi.mock('../EncryptedAvatar', () => ({ EncryptedAvatar: () => null }));
vi.mock('./AnnotationGrantBadge', () => ({ AnnotationGrantBadge: () => null }));
vi.mock('./VideoTile', () => ({
    usePersistentVolume: () => 1,
    usePersistentNsEnabled: () => false,
    useParticipantMetadata: () => null,
    useFastIsSpeaking: () => false,
    useParticipantTrackState: () => ({}),
    useIsMicMuted: () => false,
}));

import {
    setOwnCallPersonalization, clearCallPersonalization, bindCallPersonalizationTransport, __flushPersonalizationForTests,
} from '../../utils/callPersonalizationStore';
import { setCallParticipantSpeaking, clearCallSpeaking } from '../../utils/callSpeakingStore';
import { DEFAULT_RING_COLOR } from '../../utils/callPersonalizationStyle';

const UID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CORAL = '#ff6b5e';

let ParticipantRowShell: typeof import('./ParticipantCard').ParticipantRowShell;
let ParticipantTileShell: typeof import('./ParticipantCard').ParticipantTileShell;
let SpeakingRing: typeof import('./SpeakingRing').SpeakingRing;

beforeAll(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // clPhysics (pulled in by the shells) reads matchMedia at import time.
    if (!window.matchMedia) {
        window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as unknown as typeof window.matchMedia;
    }
    ({ ParticipantRowShell, ParticipantTileShell } = await import('./ParticipantCard'));
    ({ SpeakingRing } = await import('./SpeakingRing'));
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
    await act(async () => { root?.unmount(); });
    host?.remove();
    root = null; host = null;
    bindCallPersonalizationTransport(null);
    clearCallPersonalization();
    clearCallSpeaking();
});

async function mount(node: React.ReactElement): Promise<HTMLElement> {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(node); });
    return host;
}

/** Every inline box-shadow in the rendered tree, joined. */
function shadows(el: HTMLElement): string {
    return [...el.querySelectorAll<HTMLElement>('[style]')].map(n => n.style.boxShadow).filter(Boolean).join(' | ');
}
const hasColour = (css: string, hex: string) => css.toLowerCase().includes(hex.toLowerCase());
const asRgb = (hex: string) => {
    const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
    return `rgba(${n(1)},${n(3)},${n(5)}`;
};

const rowProps = (speaking: boolean) => ({ userId: UID, displayName: 'x', avatarId: null, token: 't', speaking, silenced: false });
const tileProps = (speaking: boolean) => ({ userId: UID, displayName: 'x', avatarId: null, token: 't', sizeMode: 'normal' as const, compact: false, speaking, dimmed: false });

describe('normal-view speaking surfaces draw the SPEAKER\'s colour', () => {
    it('ParticipantRowShell (voice / call list row)', async () => {
        setOwnCallPersonalization(UID, { ring_color: CORAL });
        const el = await mount(React.createElement(ParticipantRowShell, rowProps(true)));
        const css = shadows(el);
        expect(hasColour(css, CORAL)).toBe(true);
        expect(hasColour(css, DEFAULT_RING_COLOR)).toBe(false);
    });

    it('ParticipantTileShell (camera-off avatar tile)', async () => {
        setOwnCallPersonalization(UID, { ring_color: CORAL });
        const el = await mount(React.createElement(ParticipantTileShell, tileProps(true)));
        const css = shadows(el);
        expect(hasColour(css, CORAL)).toBe(true);
        expect(hasColour(css, DEFAULT_RING_COLOR)).toBe(false);
    });

    it('SpeakingRing (server voice / Calls rosters), driven by the speaking store', async () => {
        setOwnCallPersonalization(UID, { ring_color: CORAL });
        const el = await mount(React.createElement(SpeakingRing, { uid: UID, className: 'x', glow: 6, glowAlpha: 0.5, children: null }));
        expect(shadows(el)).toBe('');
        await act(async () => { setCallParticipantSpeaking(UID, true); });
        const css = shadows(el);
        expect(hasColour(css, CORAL)).toBe(true);
        expect(css).toContain(asRgb(CORAL));
    });

    it('each person gets their OWN colour, not the viewer\'s', async () => {
        setOwnCallPersonalization(UID, { ring_color: CORAL });
        setOwnCallPersonalization(OTHER, { ring_color: '#a7b3d4' });
        const el = await mount(React.createElement(React.Fragment, null,
            React.createElement(ParticipantRowShell, rowProps(true)),
            React.createElement(ParticipantRowShell, { ...rowProps(true), userId: OTHER }),
        ));
        const css = shadows(el);
        expect(hasColour(css, CORAL)).toBe(true);
        expect(hasColour(css, '#a7b3d4')).toBe(true);
    });

    it('a later change of the speaker\'s colour re-renders the ring', async () => {
        const el = await mount(React.createElement(ParticipantRowShell, rowProps(true)));
        expect(hasColour(shadows(el), DEFAULT_RING_COLOR)).toBe(true);
        await act(async () => { setOwnCallPersonalization(UID, { ring_color: CORAL }); });
        expect(hasColour(shadows(el), CORAL)).toBe(true);
        expect(hasColour(shadows(el), DEFAULT_RING_COLOR)).toBe(false);
    });

    it('nobody chose a colour: the stock green, unchanged', async () => {
        const el = await mount(React.createElement(React.Fragment, null,
            React.createElement(ParticipantRowShell, rowProps(true)),
            React.createElement(ParticipantTileShell, tileProps(true)),
        ));
        const css = shadows(el);
        expect(hasColour(css, DEFAULT_RING_COLOR)).toBe(true);
        expect(css).toContain('rgba(34,197,94');
    });

    it('not speaking: no coloured shadow at all', async () => {
        setOwnCallPersonalization(UID, { ring_color: CORAL });
        const el = await mount(React.createElement(React.Fragment, null,
            React.createElement(ParticipantRowShell, rowProps(false)),
            React.createElement(ParticipantTileShell, tileProps(false)),
        ));
        expect(shadows(el)).toBe('');
    });

    it('a REMOTE speaker nobody has cached is fetched through the transport and then drawn in their colour', async () => {
        const read = vi.fn(async (ids: readonly string[]) => Object.fromEntries(ids.map(id => [id, { ring_color: CORAL, entrance_sound: null, theme: null }])));
        bindCallPersonalizationTransport({ read, save: async () => ({ ring_color: null, entrance_sound: null }) });
        const el = await mount(React.createElement(React.Fragment, null,
            React.createElement(ParticipantRowShell, rowProps(true)),
            React.createElement(ParticipantTileShell, { ...tileProps(true), userId: OTHER }),
        ));
        expect(hasColour(shadows(el), DEFAULT_RING_COLOR)).toBe(true); // before the answer arrives
        await act(async () => { __flushPersonalizationForTests(); await Promise.resolve(); await Promise.resolve(); });
        expect(read).toHaveBeenCalledTimes(1);
        expect([...(read.mock.calls[0][0])].sort()).toEqual([UID, OTHER].sort());
        const css = shadows(el);
        expect(hasColour(css, CORAL)).toBe(true);
        expect(hasColour(css, DEFAULT_RING_COLOR)).toBe(false);
    });
});
