/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import React from 'react';
import { ConnectionState, RoomEvent } from 'livekit-client';
import '../src/utils/clPhysics';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/layout-drift.css';
import { loadWebFonts } from '../src/utils/webFonts';
import { CallMilestones } from '../src/components/call/CallMilestones';

/**
 * The in-call milestones with a fake LiveKit room. The real clocks are hours long, so the harness skews
 * Date.now and asks the room to re-check:
 *   window.__jump(ms)        skip the clock forward
 *   window.__check()         make the milestones look now (what the 30 s poll does)
 *   window.__share(bool)     start/stop OUR screen share
 *   ?fullscreen=1            add the fullscreen call overlay's marker class, so the bucket takes the window corner
 */
loadWebFonts();
const q = new URLSearchParams(location.search);

let skew = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + skew;
(window as any).__jump = (ms: number) => { skew += ms; };

class FakeRoom {
    state = ConnectionState.Connected;
    localParticipant = { isScreenShareEnabled: false };
    remoteParticipants = new Map();
    private h = new Map<string, Set<() => void>>();
    on(e: string, f: () => void) { (this.h.get(e) ?? this.h.set(e, new Set()).get(e)!).add(f); return this; }
    off(e: string, f: () => void) { this.h.get(e)?.delete(f); return this; }
    emit(e: string) { this.h.get(e)?.forEach(f => f()); }
}
const room = new FakeRoom();
(window as any).__room = room;
(window as any).__check = () => room.emit(RoomEvent.ConnectionStateChanged);
(window as any).__share = (on: boolean) => { room.localParticipant.isScreenShareEnabled = on; room.emit(on ? RoomEvent.LocalTrackPublished : RoomEvent.LocalTrackUnpublished); };

const Scene: React.FC = () => (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', fontFamily: 'Nunito, sans-serif', color: '#8892B0' }}>
        <div style={{ height: 34, borderBottom: '1px solid #1E2848' }} />
        <nav style={{ position: 'absolute', left: 0, top: 34, bottom: 0, width: 72, borderRight: '1px solid #1E2848' }} />
        <div className="app-pane3" style={{ position: 'absolute', left: 72, top: 34, right: 0, bottom: 0, background: '#0E1428' }}>
            <div style={{ padding: 24 }}>The call stage (a shared screen would be here).</div>
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 72, borderTop: '1px solid #1E2848', display: 'grid', placeItems: 'center' }}>call controls</div>
        </div>
        {q.get('fullscreen') === '1' && <div className="fullscreen-overlay-enter" style={{ position: 'fixed', inset: 0, background: '#05070F', zIndex: 9999 }} />}
        <CallMilestones />
    </div>
);

createRoot(document.getElementById('root')!).render(<Scene />);
