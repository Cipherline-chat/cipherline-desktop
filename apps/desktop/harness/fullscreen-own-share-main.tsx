/* eslint-disable -- harness, not shipped */
// REAL here: FullscreenOverlay, VideoTile, LocalScreenShareTile, PopoverMenu, ParticipantCard,
// ControlBar, CallProvider, the escape stack and every stylesheet. Stood in for: the SFU and the
// participants (canvas tracks) and the few lines of SidebarConference that keep the hide state.
import React from 'react';
import ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Track } from 'livekit-client';
import '../src/utils/clPhysics';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/layout-drift.css';
import { loadWebFonts } from '../src/utils/webFonts';
import { CallProvider, useCallContext } from '../src/contexts/CallContext';
import { FullscreenOverlay } from '../src/components/call/FullscreenOverlay';
import { ControlBar } from '../src/components/call/ControlBar';

loadWebFonts();
const SS = Track.Source.ScreenShare;
const CAM = Track.Source.Camera;

// ── Pictures ────────────────────────────────────────────────────────────────

function desktopCanvas(w: number, h: number, title: string, accent: string) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    let n = 0;
    setInterval(() => {
        n++;
        g.fillStyle = '#10243d'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#17324f'; g.fillRect(0, 0, w, h * .06);
        g.fillStyle = 'rgba(255,255,255,.85)'; g.font = `600 ${Math.round(h * .026)}px sans-serif`;
        g.fillText(title, w * .02, h * .04);
        g.fillStyle = '#0b1a2c'; g.fillRect(w * .04, h * .11, w * .56, h * .8);
        for (let i = 0; i < 14; i++) {
            g.fillStyle = i % 3 === 0 ? accent : 'rgba(255,255,255,.22)';
            g.fillRect(w * .06, h * (.14 + i * .054), w * (.14 + ((i * 41) % 31) / 100), h * .018);
        }
        g.fillStyle = '#0b1a2c'; g.fillRect(w * .63, h * .11, w * .33, h * .38);
        g.fillStyle = accent;
        g.beginPath(); g.arc(w * .795 + Math.sin(n / 18) * w * .08, h * .3 + Math.cos(n / 22) * h * .1, h * .05, 0, 7); g.fill();
        g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(w * .63, h * .52, w * .33, h * .39);
    }, 66);
    return c;
}

function faceCanvas(w: number, h: number, bg: string, skin: string) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    let n = 0;
    setInterval(() => {
        n++;
        const grad = g.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, bg); grad.addColorStop(1, '#0e1420');
        g.fillStyle = grad; g.fillRect(0, 0, w, h);
        const x = w / 2 + Math.sin(n / 30) * 8;
        g.fillStyle = skin;
        g.beginPath(); g.arc(x, h * .42, h * .17, 0, 7); g.fill();
        g.beginPath(); g.ellipse(x, h * .98, h * .34, h * .34, 0, 0, 7); g.fill();
    }, 66);
    return c;
}

// ── Participants ────────────────────────────────────────────────────────────

class FakeParticipant {
    attributes: Record<string, string> = {};
    metadata = '';
    isLocal = false;
    isSpeaking = false;
    isScreenShareEnabled = false;
    isCameraEnabled = false;
    isMicrophoneEnabled = true;
    pubs = new Map<string, unknown>();
    handlers = new Map<string, Set<(...a: unknown[]) => void>>();
    constructor(public identity: string, public name: string) {}
    on(e: string, f: (...a: unknown[]) => void) { (this.handlers.get(e) ?? this.handlers.set(e, new Set()).get(e)!).add(f); return this; }
    off(e: string, f: (...a: unknown[]) => void) { this.handlers.get(e)?.delete(f); return this; }
    getTrackPublication(s: string) { return this.pubs.get(s); }
    get trackPublications() { return this.pubs; }
    setStream(source: string, canvas: HTMLCanvasElement | null) {
        if (!canvas) { this.pubs.delete(source); }
        else {
            const stream = canvas.captureStream(15);
            const track = {
                attach: (el: HTMLVideoElement) => { el.srcObject = stream; void el.play().catch(() => {}); return el; },
                detach: (el: HTMLVideoElement) => { el.srcObject = null; return el; },
                mediaStreamTrack: stream.getVideoTracks()[0],
            };
            this.pubs.set(source, { source, track, isSubscribed: true, isMuted: false, isEnabled: true, trackSid: `${this.identity}-${source}`, dimensions: { width: canvas.width, height: canvas.height } });
        }
        if (source === SS) this.isScreenShareEnabled = !!canvas;
        if (source === CAM) this.isCameraEnabled = !!canvas;
        this.handlers.get('localTrackPublished')?.forEach(f => f());
        this.handlers.get('trackPublished')?.forEach(f => f());
    }
}

const listeners = new Set<() => void>();
const me = new FakeParticipant('me', 'Dawson'); me.isLocal = true;
const bob = new FakeParticipant('bob', 'Bob');
const amy = new FakeParticipant('amy', 'Amy');
const cat = new FakeParticipant('cat', 'Cat');
const q = new URLSearchParams(location.search);
me.setStream(SS, desktopCanvas(1920, 1080, 'My screen: what you are sending', '#25e0c8'));
if (q.get('mycam') === '1') me.setStream(CAM, faceCanvas(1280, 720, '#31465f', '#d9a98a'));
if (q.get('bobshare') !== '0') bob.setStream(SS, desktopCanvas(2560, 1080, "Bob's screen", '#ff8a5c'));
amy.setStream(CAM, faceCanvas(1280, 720, '#3a2d4f', '#c98f6f'));

(window as any).__call = {
    participants: [me, bob, amy, cat],
    local: me,
    room: { on() { return this; }, off() { return this; }, localParticipant: me, remoteParticipants: new Map(), state: 'connected' },
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
};
const refresh = () => listeners.forEach(f => f());

// ── Surface ─────────────────────────────────────────────────────────────────

const EMPTY = new Set<string>();
const NOOP = () => {};

function Surface() {
    const ctx = useCallContext();
    const [hidden, setHidden] = React.useState<Set<string>>(new Set());
    const onHide = (id: string, hide: boolean) => setHidden(prev => {
        const next = new Set(prev);
        if (hide) next.add(id); else next.delete(id);
        return next;
    });
    const H = (window as any).H;
    H.fullscreen = (on: boolean) => ctx.setIsFullscreen(on);
    H.focus = (identity: string | null, source: string = SS) => ctx.setFocusedStream(identity ? { identity, source } as never : null);
    H.state = () => ({ fullscreen: ctx.isFullscreen, focused: ctx.focusedStream, hidden: [...hidden] });
    H.setBob = (on: boolean) => { bob.setStream(SS, on ? desktopCanvas(2560, 1080, "Bob's screen", '#ff8a5c') : null); refresh(); };
    const controlsRoot = document.getElementById('call-fullscreen-controls-root');
    const ownHidden = hidden.has('me');
    return (
        <>
            {React.createElement(FullscreenOverlay as unknown as React.FC<Record<string, unknown>>, {
                token: 't', isLocalDeafened: false, localMutedParticipantIds: EMPTY, onToggleLocalMute: NOOP,
                hiddenVideoIds: EMPTY, hiddenScreenShareIds: hidden, onHideVideoChange: NOOP, onHideScreenShareChange: onHide,
                subscribedScreenshares: new Set(['bob']), onSubscribeScreenshare: NOOP, onStopWatchingScreenshare: NOOP,
            })}
            {ctx.isFullscreen && controlsRoot && ReactDOM.createPortal(
                React.createElement(ControlBar as unknown as React.FC<Record<string, unknown>>, {
                    localParticipant: me, isLocalDeafened: false,
                    onToggleMic: NOOP, onToggleDeafen: NOOP, onToggleCamera: NOOP, onToggleScreenshare: NOOP,
                    onOpenScreenSharePicker: NOOP, onAdjustScreenShareQuality: NOOP, onToggleScreenShareAudio: NOOP,
                    currentShareResolution: '1080p', currentShareFrameRate: 30, currentShareAudio: false,
                    onLeave: NOOP, showFullscreenButton: true,
                    localPreviewHidden: ownHidden, onToggleLocalPreview: () => onHide('me', !ownHidden),
                }),
                controlsRoot,
            )}
        </>
    );
}

(window as any).H = {};
createRoot(document.getElementById('root')!).render(<CallProvider><Surface /></CallProvider>);
