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
