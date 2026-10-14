// @vitest-environment jsdom
/**
 * The sidebar's call-participant badges, out of call vs in call. The owner's
 * ask: "when people are screensharing or have their camera on I can see the
 * little icon next to their name in the call — I want to see those icons
 * whether I'm in a call or not."
 */
import { describe, it, expect, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ParticipantStatusIcons } from './ParticipantStatusIcons';
import { CallMediaSummary } from '../CallMediaSummary';
import { parseParticipantMetadata } from '../../utils/participantMetadata';
import {
    applyCallMediaEvent, clearCallMediaUser, describeCallMedia, huddleCallMediaKey, setCallMedia, __resetCallMediaPresence,
} from '../../utils/callMediaPresence';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

const CALL = 'call-1';
const KEY = huddleCallMediaKey(CALL);
const A = 'user-a';

function mount(el: React.ReactElement) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(el));
    return { host, rerender: (next: React.ReactElement) => act(() => root.render(next)), unmount: () => act(() => root.unmount()) };
}

const svgClasses = (host: HTMLElement) =>
    [...host.querySelectorAll('svg')].map(s => s.getAttribute('class') ?? '');
const has = (host: HTMLElement, lucide: string) => svgClasses(host).some(c => c.includes(`lucide-${lucide}`));

beforeEach(() => __resetCallMediaPresence());

describe('ParticipantStatusIcons — NOT in the call (server presence)', () => {
    it('shows the screen-share and camera icons from presence', () => {
        setCallMedia(KEY, A, { camera: true, screen_share: true });
        const m = mount(h(ParticipantStatusIcons, { userId: A, inThisCall: false, mediaKey: KEY, iconClass: 'w-3 h-3' }));
        expect(has(m.host, 'monitor')).toBe(true);
        expect(has(m.host, 'video')).toBe(true);
        m.unmount();
    });

    it('updates live on call:media_state and clears on leave', () => {
        const m = mount(h(ParticipantStatusIcons, { userId: A, inThisCall: false, mediaKey: KEY, iconClass: 'w-3 h-3' }));
        expect(m.host.querySelector('[data-testid="participant-status-icons"]')).toBeNull();

        act(() => applyCallMediaEvent({ channel_id: 'h', call_id: CALL, user_id: A, camera: false, screen_share: true }));
        expect(has(m.host, 'monitor')).toBe(true);
        expect(has(m.host, 'video')).toBe(false);

        act(() => clearCallMediaUser(KEY, A));
        expect(m.host.querySelector('[data-testid="participant-status-icons"]')).toBeNull();
        m.unmount();
    });

    it('does not show in-call-only state (stale LiveKit track / local mute) for a call I am not in', () => {
        const m = mount(h(ParticipantStatusIcons, {
            userId: A, inThisCall: false, mediaKey: KEY, iconClass: 'w-3 h-3',
            track: { hasCamera: true, hasScreenShare: true, isMuted: true }, localMuted: true,
        }));
        expect(svgClasses(m.host)).toEqual([]);
        m.unmount();
    });
});

describe('ParticipantStatusIcons — NOT in the call: self mute / deafen from presence', () => {
    const props = { userId: A, inThisCall: false, mediaKey: KEY, iconClass: 'w-3 h-3' };

    it('shows the self-mute icon (red-400 MicOff, same as in-call) for a muted participant', () => {
        setCallMedia(KEY, A, { muted: true });
        const m = mount(h(ParticipantStatusIcons, props));
        expect(svgClasses(m.host).some(c => c.includes('lucide-mic-off') && c.includes('text-red-400'))).toBe(true);
        expect(has(m.host, 'headphones')).toBe(false);
        m.unmount();
    });

    it('shows the self-deafen icon (same Headphones glyph as in-call) and suppresses the mute icon, as in-call', () => {
        setCallMedia(KEY, A, { muted: true, deafened: true });
        const m = mount(h(ParticipantStatusIcons, props));
        expect(svgClasses(m.host).some(c => c.includes('lucide-headphones') && c.includes('text-red-400'))).toBe(true);
        expect(has(m.host, 'mic-off')).toBe(false);
        m.unmount();
    });

    it('shows mute next to camera / screen share', () => {
        setCallMedia(KEY, A, { camera: true, screen_share: true, muted: true });
        const m = mount(h(ParticipantStatusIcons, props));
        expect(has(m.host, 'mic-off')).toBe(true);
        expect(has(m.host, 'video')).toBe(true);
        expect(has(m.host, 'monitor')).toBe(true);
        m.unmount();
    });

    it('updates live on call:media_state and clears on unmute / leave', () => {
        const m = mount(h(ParticipantStatusIcons, props));
        expect(m.host.querySelector('[data-testid="participant-status-icons"]')).toBeNull();
        act(() => applyCallMediaEvent({ channel_id: 'h', call_id: CALL, user_id: A, camera: false, screen_share: false, muted: true, deafened: false }));
        expect(has(m.host, 'mic-off')).toBe(true);
        act(() => applyCallMediaEvent({ channel_id: 'h', call_id: CALL, user_id: A, camera: false, screen_share: false, muted: false, deafened: false }));
        expect(m.host.querySelector('[data-testid="participant-status-icons"]')).toBeNull();
        act(() => setCallMedia(KEY, A, { deafened: true }));
        expect(has(m.host, 'headphones')).toBe(true);
        act(() => clearCallMediaUser(KEY, A));
        expect(m.host.querySelector('[data-testid="participant-status-icons"]')).toBeNull();
        m.unmount();
    });

    it("another participant's presence never leaks onto this row (negative control)", () => {
        setCallMedia(KEY, 'someone-else', { muted: true, deafened: true });
        const m = mount(h(ParticipantStatusIcons, props));
        expect(m.host.querySelector('[data-testid="participant-status-icons"]')).toBeNull();
        m.unmount();
    });

    it('never draws server-moderation badges out of a call (presence does not carry them)', () => {
        setCallMedia(KEY, A, { muted: true });
        const m = mount(h(ParticipantStatusIcons, {
            ...props, meta: parseParticipantMetadata(JSON.stringify({ server_muted_audio: true, server_deafened: true })),
        }));
        expect(svgClasses(m.host).some(c => c.includes('text-red-500'))).toBe(false);
        m.unmount();
    });

    it('the Home call summary ignores a muted-only call (deck badges unchanged)', () => {
        setCallMedia(KEY, A, { muted: true, deafened: true });
        const m = mount(h(CallMediaSummary, { mediaKey: KEY, participantIds: [A] }));
        expect(m.host.innerHTML).toBe('');
        m.unmount();
    });
});

describe('ParticipantStatusIcons — IN the call: self mute / deafen stay on live state', () => {
    const base = { userId: A, inThisCall: true, mediaKey: KEY, iconClass: 'w-3.5 h-3.5' };

    it('presence that says muted + deafened is ignored when live state says neither', () => {
        setCallMedia(KEY, A, { muted: true, deafened: true });
        const m = mount(h(ParticipantStatusIcons, {
            ...base,
            track: { hasCamera: false, hasScreenShare: false, isMuted: false },
            meta: parseParticipantMetadata(JSON.stringify({ deafened: false })),
        }));
        expect(svgClasses(m.host)).toEqual([]);
        m.unmount();
    });

    it('a live-muted mic draws MicOff even with no presence at all', () => {
        const m = mount(h(ParticipantStatusIcons, { ...base, track: { hasCamera: false, hasScreenShare: false, isMuted: true } }));
        expect(has(m.host, 'mic-off')).toBe(true);
        m.unmount();
    });

    it('live deafen draws the deafen icon and suppresses MicOff, as before', () => {
        const m = mount(h(ParticipantStatusIcons, {
            ...base,
            track: { hasCamera: false, hasScreenShare: false, isMuted: true },
            meta: parseParticipantMetadata(JSON.stringify({ deafened: true })),
        }));
        expect(has(m.host, 'headphones')).toBe(true);
        expect(has(m.host, 'mic-off')).toBe(false);
        m.unmount();
    });

    it('server-moderation badges still win over self-mute in the room', () => {
        const m = mount(h(ParticipantStatusIcons, {
            ...base,
            track: { hasCamera: false, hasScreenShare: false, isMuted: true },
            meta: parseParticipantMetadata(JSON.stringify({ server_muted_audio: true })),
        }));
        const cls = svgClasses(m.host);
        expect(cls.some(c => c.includes('lucide-mic-off') && c.includes('text-red-500'))).toBe(true);
        expect(cls.some(c => c.includes('lucide-mic-off') && c.includes('text-red-400'))).toBe(false);
        m.unmount();
    });
});

describe('ParticipantStatusIcons — IN the call (live LiveKit state, unchanged behaviour)', () => {
    it('uses the live track state and ignores presence', () => {
        setCallMedia(KEY, A, { camera: true, screen_share: false });
        const m = mount(h(ParticipantStatusIcons, {
            userId: A, inThisCall: true, mediaKey: KEY, iconClass: 'w-3.5 h-3.5',
            track: { hasCamera: false, hasScreenShare: true, isMuted: true },
        }));
        expect(has(m.host, 'monitor')).toBe(true);
        expect(has(m.host, 'video')).toBe(false);
        expect(has(m.host, 'mic-off')).toBe(true); // self-mute still shown in-call
        m.unmount();
    });

    it('shows the gray "hidden by me" variants and server-moderation badges as before', () => {
        const m = mount(h(ParticipantStatusIcons, {
            userId: A, inThisCall: true, mediaKey: KEY, iconClass: 'w-3.5 h-3.5',
            track: { hasCamera: true, hasScreenShare: true, isMuted: false },
            videoHidden: true, screenHidden: true,
            meta: parseParticipantMetadata(JSON.stringify({ server_muted_audio: true })),
        }));
        const cls = svgClasses(m.host);
        expect(cls.some(c => c.includes('lucide-video-off') && c.includes('text-cl-faint'))).toBe(true);
        expect(cls.some(c => c.includes('lucide-monitor-off') && c.includes('text-cl-faint'))).toBe(true);
        expect(cls.some(c => c.includes('lucide-mic-off') && c.includes('text-red-500'))).toBe(true);
        m.unmount();
    });
});

describe('CallMediaSummary (Home "Happening now")', () => {
    it('renders nothing when nobody listed has anything on', () => {
        setCallMedia(KEY, 'not-listed', { camera: true, screen_share: true });
        const m = mount(h(CallMediaSummary, { mediaKey: KEY, participantIds: [A] }));
        expect(m.host.innerHTML).toBe('');
        m.unmount();
    });

    it('marks sharing / camera with names in the accessible label, and updates live', () => {
        const m = mount(h(CallMediaSummary, { mediaKey: KEY, participantIds: [A], names: { [A]: 'Ada' } }));
        act(() => setCallMedia(KEY, A, { camera: true, screen_share: true }));
        const el = m.host.querySelector('[data-testid="call-media-summary"]');
        expect(el?.getAttribute('aria-label')).toBe('Ada is sharing a screen · Ada has a camera on');
        m.unmount();
    });

    it('describeCallMedia pluralises', () => {
        expect(describeCallMedia(['a', 'b'], [], { a: 'A', b: 'B' })).toBe('A, B are sharing a screen');
    });
});
