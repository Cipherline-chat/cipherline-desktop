/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/settings-descent.css';
import '../src/styles/layout-drift.css';
import '../src/styles/night-dive.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import React from 'react';

/**
 * Screen-share notices, REAL components over a dimmed app-like backdrop. Query:
 *   s=picker|bar|conf   which surface (picker modal / call-bar quality popover / in-call share notice)
 *   hz=<n>              display refresh rate the (stubbed) main process reports (default 144)
 *   ceil=<n>            capturer fps ceiling (Wayland: 60)
 *   plat=windows|mac|linux
 *   tone=info|warn, text=<s>   (s=conf only)
 * The playwright script drives the frame-rate control.
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const scene = q.get('s') ?? 'picker';
const plat = (q.get('plat') ?? 'windows') as 'windows' | 'mac' | 'linux';
const hz = Number(q.get('hz') ?? 144);
const ceil = Number(q.get('ceil') ?? 0);

const wide = q.get('wide') === '1';   // an ultra-wide (Surround / Eyefinity) display: adds the "Ultra-wide display" chooser
const thumb = (c: string) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${wide ? 960 : 320}" height="180"><rect width="${wide ? 960 : 320}" height="180" fill="${c}"/></svg>`);
(window as any).electronAPI = {
    platform: plat,
    macOSMajor: plat === 'mac' ? 15 : null,
    // Linux asks for one combined portal request and, with a single source back, goes straight to its settings step.
    getDesktopSources: async () => [
        { id: 'screen:0', name: 'Screen 1', thumbnailDataUrl: thumb('#24406b') },
        ...(plat === 'linux' ? [] : [{ id: 'screen:1', name: 'Screen 2', thumbnailDataUrl: thumb('#3b2a5e') }]),
    ],
    getDisplayRefreshRates: async () => [{ id: '0', displayFrequency: hz, isPrimary: true, captureFpsCeiling: ceil || null }],
    getScreenCaptureAccess: async () => 'granted',
    onShowScreensharePicker: () => () => {},
};

const Backdrop: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div style={{ minHeight: '100vh', background: '#0B1022', position: 'relative' }}>{children}</div>
);

(async () => {
    const root = createRoot(document.getElementById('root')!);
    if (scene === 'picker') {
        const { ScreenSharePickerModal } = await import('../src/components/ScreenSharePickerModal');
        root.render(<Backdrop><ScreenSharePickerModal onSelect={() => {}} /></Backdrop>);
    } else if (scene === 'bar') {
        const { ControlBar } = await import('../src/components/call/ControlBar');
        root.render(
            <Backdrop>
                <div style={{ position: 'absolute', left: 520, bottom: 24 }}>
                    <ControlBar
                        localParticipant={{ isScreenShareEnabled: true, isMicrophoneEnabled: true, isCameraEnabled: false }}
                        isLocalDeafened={false}
                        onToggleMic={() => {}} onToggleDeafen={() => {}} onToggleCamera={() => {}}
                        onToggleScreenshare={() => {}} onOpenScreenSharePicker={() => {}}
                        onAdjustScreenShareQuality={() => {}}
                        onToggleScreenShareAudio={() => {}}
                        currentShareResolution="1080p" currentShareFrameRate={(Number(q.get('fps') ?? 30)) as any}
                        currentShareAudio={false}
                        onLeave={() => {}}
                    />
                </div>
            </Backdrop>,
        );
    } else {
        const globbed = import.meta.glob('../src/components/ShareNotice.tsx');
        const mod: any = Object.values(globbed)[0] ? await Object.values(globbed)[0]() : null;
        const tone = (q.get('tone') ?? 'warn') as 'info' | 'warn';
        const text = q.get('text') ?? 'Your graphics card’s video encoder keeps failing, so viewers may not see your screen. Try a lower resolution or frame rate, or another codec in Settings → Advanced.';
        root.render(
            <Backdrop>
                <div style={{ width: Number(q.get('w') ?? 300), paddingTop: 12 }} data-testid="conf-col">
                    {mod?.ShareNotice && q.get('legacy') !== '1'
                        ? <div className="mx-3 mb-1"><mod.ShareNotice tone={tone} onDismiss={() => {}}>{text}</mod.ShareNotice></div>
                        : <LegacyConfNotice tone={tone} text={text} />}
                </div>
            </Backdrop>,
        );
    }
})();

/** Verbatim copy of what SidebarConference rendered before the notices were unified (the "before"). */
import { motion } from 'framer-motion';
import { ScreenShare } from 'lucide-react';
import { ClButton } from '../src/components/cl';
const LegacyConfNotice: React.FC<{ tone: 'info' | 'warn'; text: string }> = ({ tone, text }) => (
    <div
        className="mx-3 mb-1 flex items-start gap-2 px-3 py-2 rounded-xl text-[11px] border"
        style={{
            background:  tone === 'warn' ? 'rgba(234,179,8,0.08)' : 'rgba(14,165,233,0.08)',
            borderColor: tone === 'warn' ? 'rgba(234,179,8,0.35)' : 'rgba(14,165,233,0.35)',
            color:       tone === 'warn' ? 'rgb(252,211,77)'      : 'rgb(125,211,252)',
        }}
    >
        <ScreenShare className="w-3 h-3 shrink-0 mt-[1px]" />
        <span className="leading-snug">{text}</span>
        <ClButton icon variant="ghost" size="sm" onClick={() => {}} className="ml-auto">✕</ClButton>
    </div>
);
