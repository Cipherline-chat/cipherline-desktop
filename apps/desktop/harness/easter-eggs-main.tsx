/* eslint-disable -- visual harness, not shipped */
import './easter-eggs-clock';
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/settings-descent.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import React, { useState } from 'react';
import axios from 'axios';
import { secureLocalStore } from '../src/utils/secureLocalStore';
import { useLateNightPlaceholder } from '../src/hooks/useEasterEggs';
import { VersionTapEgg } from '../src/components/settings/VersionTapEgg';
import { DepthGauge } from '../src/components/settings/DepthGauge';
import { AppearancePane } from '../src/components/settings/panes/AppearancePane';
import { StatusPicker } from '../src/components/StatusPicker';
import { Keys } from '../src/components/mascot/Keys';
import { CreateGroupModal } from '../src/components/CreateGroupModal';
import { AloneEcho } from '../src/components/call/AloneEcho';
import { EggLayer } from '../src/components/EggLayer';
import { EncryptedAvatar } from '../src/components/EncryptedAvatar';

/**
 * Easter-egg harness. Real components; the only fakes are the network (axios adapter), useAuth and
 * the avatar decrypt (vite aliases). Pick a scene with ?scene=…, freeze the clock with ?date=…
 *
 *   ?scene=keys           Keys in his costumes (witch / party / none) at three sizes
 *   ?scene=gauge           settings depth gauge: ?date=2026-10-31T12:00:00 (Halloween) or 2027-04-30T12:00:00 (birthday); type octopus / abyss
 *   ?scene=appearance      Settings → Appearance (the master switch row)
 *   ?scene=status          the status picker (click the avatar, then flip status 6 times)
 *   ?scene=version         Advanced → This build, version row; click #chip 7 times
 *   ?scene=composer        the composer's idle placeholder (&date=…T03:30:00 for the late-night line)
 *   ?scene=alone           the call sidebar pill row (use page.clock to skip the 4-minute wait)
 *   ?scene=konami          the global EggLayer over an app backdrop; press ↑↑↓↓←→←→BA
 *   ?scene=group-of-two   the real CreateGroupModal with one friend preselected; submit it to see the egg
 *                         (&openfail=1 makes POST /conversations/dm fail)
 *
 * &eggs=off  flips the Appearance switch off before render.
 * window.__calls records every POST; window.__opened / window.__created the callbacks the host got.
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'keys';

const FRIENDS = [
    { user_id: 'u-mira', username: 'Mira', discriminator: 4821, avatar_url: 'img-mira' },
    { user_id: 'u-jun', username: 'Jun', discriminator: 77, avatar_url: 'img-jun' },
    { user_id: 'u-sana', username: 'Sana', discriminator: 3105, avatar_url: 'img-sana' },
    { user_id: 'u-okoye', username: 'Okoye', discriminator: 9002, avatar_url: 'img-okoye' },
];

(window as any).__calls = [] as string[];
axios.defaults.adapter = async (config: any) => {
    const url = String(config.url);
    if (/\/friends$/.test(url)) {
        await new Promise(r => setTimeout(r, 80));
        return { data: { accepted: FRIENDS }, status: 200, statusText: 'OK', headers: {}, config };
    }
    if (/\/conversations\/dm$/.test(url)) {
        (window as any).__calls.push('POST dm ' + String(config.data));
        await new Promise(r => setTimeout(r, 250));
        if (q.get('openfail') === '1') throw Object.assign(new Error('Network Error'), { config });
        return { data: { conversation_id: 'c-dm-new' }, status: 201, statusText: 'Created', headers: {}, config };
    }
    if (/\/conversations\/group$/.test(url)) {
        (window as any).__calls.push('POST group ' + String(config.data));
        return { data: { conversation_id: 'g-new' }, status: 201, statusText: 'Created', headers: {}, config };
    }
    throw new Error('unexpected ' + url);
};

const Stage: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div style={{ minHeight: '100vh', padding: 32, fontFamily: 'Nunito, sans-serif', color: '#F4F7FF', background: '#0B0F1E' }}>{children}</div>
);

const KeysScene = () => (
    <Stage>
        <div style={{ display: 'flex', gap: 56, alignItems: 'flex-end' }}>
            {([['none', null], ['witch', 'witch'], ['party', 'party']] as const).map(([label, c]) => (
                <div key={label} id={`k-${label}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24, paddingTop: 40 }}>
                    <Keys size={150} costume={c} waveOnMount={false} interactive={false} />
                    <Keys size={64} costume={c} waveOnMount={false} interactive={false} />
                    <Keys size={40} costume={c} waveOnMount={false} interactive={false} />
                    <span style={{ fontSize: 12, color: '#5E6B8F' }}>{label}</span>
                </div>
            ))}
        </div>
    </Stage>
);

const Backdrop = () => (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'Nunito, sans-serif', color: '#F4F7FF' }}>
        <div style={{ width: 72, background: '#070A15' }} />
        <div style={{ width: 268, background: '#0F1528', borderRight: '1px solid #1E2848', padding: '16px 10px' }}>
            <div style={{ height: 36, borderRadius: 10, background: '#1C2542', marginBottom: 18 }} />
            {['Mira', 'Jun', 'Weekend Crew'].map(t => (
                <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '8px 10px' }}>
                    <div style={{ width: 36, height: 36, borderRadius: '50%', overflow: 'hidden' }}>
                        <EncryptedAvatar attachmentId={t === 'Mira' ? 'img-mira' : t === 'Jun' ? 'img-jun' : null} userId={null} token="t" className="w-full h-full" fallbackSize={16} disableClickProfile />
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#A7B3D4' }}>{t}</div>
                </div>
            ))}
        </div>
        <div style={{ flex: 1, background: '#0B0F1E' }} />
    </div>
);

const GroupOfTwoScene = () => {
    const [open, setOpen] = useState(true);
    return (
        <>
            <Backdrop />
            {open && (
                <CreateGroupModal
                    onClose={() => setOpen(false)}
                    preSelectedUsers={[{ user_id: 'u-mira', username: 'Mira', avatar_url: 'img-mira' }]}
                    onOpenDm={(chat) => { (window as any).__opened = chat; setOpen(false); }}
                    onGroupCreated={(g) => { (window as any).__created = g; setOpen(false); }}
                />
            )}
        </>
    );
};

const KonamiScene = () => (
    <>
        <Backdrop />
        <EggLayer />
    </>
);

/** The call sidebar's pill row, with a stand-in self tile under it. */
const AloneScene = () => (
    <Stage>
        <div style={{ width: 340, background: '#0F1528', border: '1px solid #1E2848', borderRadius: 16, padding: '14px 0' }}>
            <div style={{ padding: '0 14px 10px', fontFamily: 'Fredoka, sans-serif', fontWeight: 600, fontSize: 14 }}>Voice · Lounge</div>
            <AloneEcho alone sessionId="harness-call" />
            <div style={{ margin: '6px 12px 0', height: 64, borderRadius: 12, background: '#131A30', border: '1px solid #2A3558', display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px' }}>
                <div style={{ width: 34, height: 34, borderRadius: '50%', overflow: 'hidden' }}>
                    <EncryptedAvatar attachmentId="img-me" userId="me" token="t" className="w-full h-full" disableClickProfile />
                </div>
                <span style={{ fontWeight: 700, fontSize: 13 }}>Dawson</span>
            </div>
        </div>
    </Stage>
);

/** The composer's idle hint (the real ChatPane is too large to boot here; this is its textarea slot). */
const ComposerScene = () => {
    const late = useLateNightPlaceholder();
    return (
        <Stage>
            <div style={{ maxWidth: 640, margin: '120px auto 0', display: 'flex', alignItems: 'center', gap: 10, height: 52, padding: '0 16px', borderRadius: 16, background: '#131A30', border: '1px solid #2A3558' }}>
                <textarea
                    data-chat-input
                    placeholder={late ?? 'Message…'}
                    rows={1}
                    className="placeholder-white/25"
                    style={{ flex: 1, background: 'transparent', border: 0, outline: 0, resize: 'none', color: '#F4F7FF', font: '500 14.5px/22px Nunito, sans-serif' }}
                />
            </div>
        </Stage>
    );
};

/** The "This build" card's version row (the real chip lives in AdvancedSettings; same wrapper). */
const VersionScene = () => (
    <Stage>
        <div className="sd-card" style={{ maxWidth: 640, margin: '60px auto 0' }}>
            <h3>This build</h3>
            <div className="sd-row" style={{ borderTop: 'none' }}>
                <div className="sd-rl">
                    <b>App version</b>
                    <span>Auto-updates in the background; installs on next quit.</span>
                </div>
                <div className="sd-rc">
                    <VersionTapEgg>
                        <button id="chip" type="button" className="sd-mono" style={{ fontSize: 12.5, color: 'var(--cl-muted)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>v1.0.22</button>
                    </VersionTapEgg>
                </div>
            </div>
        </div>
    </Stage>
);

/** The settings depth gauge (nav + Keys footer) — Halloween / birthday via ?date, the search eggs by typing. */
const GaugeScene = () => (
    <Stage>
        <div className="sd-root sd-arrived" style={{ position: 'relative', inset: 'auto', width: 300, height: 780, background: '#0B0F1E', borderRadius: 16, display: 'flex' }}>
            <DepthGauge active="profile" onSelect={() => {}} appVersion="1.0.22" />
        </div>
    </Stage>
);

/** Settings → Appearance, the real pane (the OS-toggle card needs Electron, so it is absent here). */
const AppearanceScene = () => (
    <Stage>
        <div style={{ maxWidth: 760, margin: '0 auto' }}>
            <AppearancePane gif={{ settings: { autoPlayGifs: true }, setAutoPlayGifs: () => {} } as any} />
        </div>
    </Stage>
);

/** The rail's status picker (real component), popover open. */
const StatusScene = () => {
    const [s, setS] = useState<'online' | 'away' | 'dnd' | 'offline'>('online');
    return (
        <Stage>
            <div style={{ width: 72, paddingTop: 280 }}>
                <StatusPicker myStatus={s} onSetStatus={setS} username="Dawson" avatarAttachmentId="img-me" userId="me" token="t" />
            </div>
        </Stage>
    );
};

const SCENES: Record<string, React.FC> = {
    'gauge': GaugeScene,
    'appearance': AppearanceScene,
    'status': StatusScene,
    'version': VersionScene,
    'composer': ComposerScene,
    'alone': AloneScene,
    'konami': KonamiScene,
    'keys': KeysScene,
    'group-of-two': GroupOfTwoScene,
};
const Scene = SCENES[scene] ?? KeysScene;
(async () => {
    // main.tsx hydrates the encrypted store before first paint; the eggs read their switch and ledger from it.
    await secureLocalStore.hydrate();
    if (q.get('eggs') === 'off') secureLocalStore.setItem('cipherline_easter_eggs', '0');
    createRoot(document.getElementById('root')!).render(<Scene />);
})();
