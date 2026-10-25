/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import React from 'react';
import { ClBanner, ClBannerStack } from '../src/components/ClBanner';
import { TrialBanner } from '../src/components/billing/TrialBanner';
import { AnnouncementBanners } from '../src/components/AnnouncementBanners';
import { CallRejoinBanner } from '../src/components/CallRejoinBanner';
import { ServerStorageBannerView } from '../src/components/server/ServerStorageBanner';
import { OwnDeviceAlert } from '../src/components/OwnDeviceAlert';
import { KeyProtectionNotice } from '../src/components/KeyProtectionNotice';
import { EncryptionAtRestNotice } from '../src/components/EncryptionAtRestNotice';
import { RendererHangBanner } from '../src/components/RendererHangBanner';
import { DeviceResetBanner } from '../src/components/DeviceResetBanner';
import { buildStorageBannerModel } from '../src/utils/serverStorageGrace';
import { SubOverride } from './banners-stubs';
import { Home, Users, Settings, Phone, Video, Pin, Search, Plus } from 'lucide-react';

/**
 * Banner redesign harness. The banners, ClBanner, ClButton and the app stylesheets are the real ones;
 * only the contexts they read are stubbed (banners-stubs.tsx).
 *
 * ?scene=dashboard   the top of the Dashboard as the owner sees it: rail, titlebar, TrialBanner, DM list + chat header
 * ?scene=gallery     every banner type and tone, the stack cap, the overlay layers and the narrow widths
 * &days=3 &extended=1 &stack=1 (dashboard: add a second banner so the stack shows two)
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'dashboard';
const days = Number(q.get('days') ?? 3);

const trialStatus = (d: number, over: Record<string, unknown> = {}) => ({
    subscription_status: 'trial', effective_status: 'active', trial_days_left: d, trial_extended: q.get('extended') === '1',
    plan_amount: 250, plan_currency: 'usd', ...over,
});
(window as any).__sub = trialStatus(days);
(window as any).__keyring = 'absent';
(window as any).electronAPI = {
    // The renderer-hang banner subscribes on mount; fire its signal right away so the gallery shows it.
    onRendererUnresponsive: (cb: () => void) => { setTimeout(cb, 0); return () => {}; },
    onRendererResponsive: () => () => {},
    getKeyProtection: async () => ({ showNotice: true, level: 'plaintext', reason: 'no_keystore' }),
    ackKeyProtectionNotice: async () => {},
};

const DAY = 86_400_000;
const storageStatus = (days: number, over: Record<string, unknown> = {}): any => {
    const deadline = new Date(Date.now() + days * DAY).toISOString();
    return {
        server_id: 's', audience: 'owner', state: 'grace', usage_bytes: 48 * 1048576, limit_bytes: 25 * 1048576,
        target_bytes: 25 * 1048576, pro_ends_at: null, grace_started_at: null, grace_deadline: deadline,
        days_left: days, transfer: { pro_member_count: 1, pro_member_ids: ['u9'] }, prune_summary: null,
        resolved_reason: null, resolved_at: null, pruned_at: null, notice_id: `grace:${deadline}`, dismissible: false, ...over,
    };
};
const storageView = (days: number, over: Record<string, unknown> = {}) => (
    <ServerStorageBannerView model={buildStorageBannerModel(storageStatus(days, over), 'Gamers')!} onAction={() => {}} onDismiss={() => {}} />
);
const noop = () => {};

/* ── scene: the owner's screenshot, redone ─────────────────────────────── */
const Avatar: React.FC<{ c: string; ch: string; s?: number }> = ({ c, ch, s = 36 }) => (
    <div style={{ width: s, height: s, borderRadius: '50%', background: c, display: 'grid', placeItems: 'center', color: 'var(--cl-on-lume)', fontWeight: 800, fontSize: s * 0.42, flexShrink: 0 }}>{ch}</div>
);

const DashboardMock: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div style={{ width: 1280, height: 520, display: 'flex', background: 'var(--cl-abyss)', color: 'var(--cl-text)', fontFamily: 'var(--cl-font-body)', overflow: 'hidden', border: '1px solid var(--cl-border)' }}>
        <nav style={{ width: 72, borderRight: '1px solid var(--cl-border)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, paddingTop: 44 }}>
            <div style={{ width: 44, height: 44, borderRadius: 14, background: 'var(--cl-lume-tint)', color: 'var(--cl-lume)', display: 'grid', placeItems: 'center' }}><Home size={20} /></div>
            <Avatar c="#6C7BFF" ch="G" s={44} /><Avatar c="var(--cl-flash)" ch="W" s={44} /><Avatar c="var(--cl-glow)" ch="D" s={44} />
            <div style={{ width: 44, height: 44, borderRadius: 14, border: '1.5px dashed var(--cl-border)', color: 'var(--cl-faint)', display: 'grid', placeItems: 'center' }}><Plus size={18} /></div>
            <span style={{ marginTop: 'auto' }} />
            <div style={{ color: 'var(--cl-muted)', padding: 10 }}><Users size={19} /></div>
            <div style={{ color: 'var(--cl-muted)', padding: 10, marginBottom: 14 }}><Settings size={19} /></div>
        </nav>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ height: 34, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 22, paddingRight: 16, color: 'var(--cl-faint)', fontSize: 13, flexShrink: 0 }}>
                <span>&minus;</span><span>&#9633;</span><span>&times;</span>
            </div>
            {children}
            <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
                <aside style={{ width: 268, background: 'var(--cl-deep)', borderRight: '1px solid var(--cl-border)', padding: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--cl-sink)', borderRadius: 10, padding: '8px 10px', color: 'var(--cl-faint)', fontSize: 13, marginBottom: 8 }}><Search size={14} /> Find or start a conversation</div>
                    {[['Mira', '#25E0C8', 'M', true], ['Jun', '#6C7BFF', 'J', false], ['Weekend crew', '#FFC94D', 'W', false], ['Sana', '#FF6B5E', 'S', false]].map(([n, c, ch, a]: any) => (
                        <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 12, background: a ? 'var(--cl-surface)' : 'transparent' }}>
                            <Avatar c={c} ch={ch} s={32} /><span style={{ fontWeight: 700, fontSize: 14 }}>{n}</span>
                        </div>
                    ))}
                </aside>
                <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <header style={{ height: 56, display: 'flex', alignItems: 'center', gap: 12, padding: '0 18px', borderBottom: '1px solid var(--cl-border)' }}>
                        <Avatar c="#25E0C8" ch="M" s={32} />
                        <div style={{ fontFamily: 'var(--cl-font-display)', fontWeight: 600, fontSize: 17 }}>Mira</div>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--cl-ok)' }} />
                        <span style={{ marginLeft: 'auto', display: 'flex', gap: 18, color: 'var(--cl-muted)' }}><Phone size={18} /><Video size={18} /><Pin size={18} /></span>
                    </header>
                    <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
                        <div style={{ display: 'flex', gap: 12 }}><Avatar c="#25E0C8" ch="M" s={36} /><div><b style={{ fontSize: 14 }}>Mira</b> <span style={{ color: 'var(--cl-faint)', fontSize: 12 }}>Today 9:41</span><div style={{ fontSize: 14, color: 'var(--cl-text)' }}>did the new build ship yet? the keys screen looks so good</div></div></div>
                        <div style={{ display: 'flex', gap: 12 }}><Avatar c="#6C7BFF" ch="D" s={36} /><div><b style={{ fontSize: 14 }}>Dawson</b> <span style={{ color: 'var(--cl-faint)', fontSize: 12 }}>Today 9:43</span><div style={{ fontSize: 14 }}>almost. one last pass on the banners</div></div></div>
                    </div>
                </main>
            </div>
        </div>
    </div>
);

const Dashboard: React.FC = () => (
    <div style={{ padding: 0, background: 'var(--cl-abyss)', width: 1280 }}>
        <DashboardMock>
            <ClBannerStack>
                <TrialBanner />
                {q.get('stack') === '1' && <ClBanner tone="warning" title="No system keyring" description="Local data on this computer is stored unencrypted." onDismiss={noop} />}
            </ClBannerStack>
        </DashboardMock>
    </div>
);

/* ── scene: gallery ─────────────────────────────────────────────────────── */
const Sec: React.FC<{ title: string; width?: number; children: React.ReactNode; fixedHeight?: number; id?: string }> = ({ title, width = 1100, children, fixedHeight, id }) => (
    <section id={id} style={{ width, marginBottom: 26 }}>
        <div style={{ font: '800 11px var(--cl-font-body)', letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--cl-faint)', margin: '0 0 6px 12px' }}>{title}</div>
        <div style={{ background: 'var(--cl-abyss)', border: '1px dashed var(--cl-border)', borderRadius: 14, padding: '4px 0', transform: 'translateZ(0)', minHeight: fixedHeight }}>{children}</div>
    </section>
);

const resetReq: any = {
    device_id: 'pending-1', device_name: 'NEW-PC', platform: 'windows',
    identity_key_pub_b64: 'AAAA', nonce_b64: 'AAAA',
    requested_at: new Date().toISOString(), expires_at: new Date(Date.now() + 21 * 3600_000).toISOString(),
    reset_due_at: new Date(Date.now() + 20 * 3600_000).toISOString(), ip_hint: null,
};

const ownAlert: any = { device_id: 'dev-77aa', pub: 'PUB', kind: 'new', first_seen: Date.now() - 12 * 60_000, gone: false };

const Trial: React.FC<{ s: any }> = ({ s }) => <SubOverride.Provider value={s}><TrialBanner /></SubOverride.Provider>;

const Gallery: React.FC = () => {
    const [mounted, setMounted] = React.useState(false);
    React.useEffect(() => {
        (window as any).__sub = trialStatus(3);
        (window as any).__anns = [
            { id: 'n', title: null, body: 'Welcome to the beta. Say hi in the community server.', icon: null, color: 'neutral', dismissible: true, ends_at: null },
            { id: 'i', title: 'New: Keys screen', body: 'See every device on your account at a glance.', icon: 'sparkles', color: 'info', dismissible: true, ends_at: null },
            { id: 'w', title: 'Scheduled maintenance', body: 'Sunday 02:00 UTC, about 10 minutes.', icon: null, color: 'warn', dismissible: true, ends_at: new Date(Date.now() + 2 * DAY).toISOString() },
            { id: 'd', title: 'Calls are degraded', body: 'We are looking into it. Messages are unaffected.', icon: null, color: 'danger', dismissible: false, ends_at: null },
        ];
        setMounted(true);
    }, []);
    if (!mounted) return null;
    return (
        <div style={{ padding: 28, background: '#080b17', width: 1156, fontFamily: 'var(--cl-font-body)', color: 'var(--cl-text)' }}>
            <h1 style={{ font: '600 22px var(--cl-font-display)', margin: '0 0 18px' }}>ClBanner: every banner, every tone</h1>

            <Sec title="Trial ending (info, 3 days)"><div style={{ padding: '8px 12px' }}><Trial s={trialStatus(3)} /></div></Sec>
            <Sec title="Trial last day (warning, already extended so no +3 days)"><div style={{ padding: '8px 12px' }}><Trial s={trialStatus(1, { trial_extended: true })} /></div></Sec>
            <Sec title="Payment failed (danger)"><div style={{ padding: '8px 12px' }}><Trial s={{ subscription_status: 'past_due', effective_status: 'active', trial_days_left: 0, trial_extended: true }} /></div></Sec>

            <Sec title="Announcements: neutral / info (titled, with icon) / warning (ends in) / danger (not dismissible)">
                <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}><AnnouncementBanners wsConnectCount={1} /></div>
            </Sec>

            <Sec title="Crash recovery: rejoin call (success)">
                <div style={{ padding: '8px 12px' }}><CallRejoinBanner offer={{ v: 1, kind: 'dm', sessionId: 's', conversationId: 'c', title: 'Mira' } as any} busy={false} onRejoin={noop} onDismiss={noop} /></div>
            </Sec>

            <Sec title="Server storage: calm / amber / red / pruned (dismissible) / neutral">
                <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {storageView(30)}{storageView(9)}{storageView(2)}
                    {storageView(0, { state: 'pruned', days_left: null, grace_deadline: null, transfer: null, pruned_at: '2026-10-10T09:00:00.000Z', notice_id: 'pruned:x', dismissible: true, audience: 'owner' })}
                </div>
            </Sec>

            <Sec title="Ghost-device alarm (danger, with rows) and first-run review (info)">
                <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <OwnDeviceAlert alerts={[ownAlert, { ...ownAlert, device_id: 'dev-90bc', kind: 'key_changed' }]} selfKeyMismatch={false} unreviewedBaseline={[]} names={{ 'dev-77aa': { device_name: 'Studio PC', platform: 'windows' }, 'dev-90bc': { device_name: 'MacBook Air', platform: 'macos' } }} onConfirm={noop} onReject={noop} onReviewed={noop} onManage={noop} />
                    <OwnDeviceAlert alerts={[]} selfKeyMismatch={false} unreviewedBaseline={['dev-77aa']} names={{ 'dev-77aa': { device_name: 'Studio PC', platform: 'windows' } }} onConfirm={noop} onReject={noop} onReviewed={noop} onManage={noop} />
                </div>
            </Sec>

            <Sec title="Keyring notices (info, warning)">
                <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}><KeyProtectionNotice /><EncryptionAtRestNotice /></div>
            </Sec>

            <Sec title="Overlay layers (float above any pane): renderer hang (warning) and device reset (danger, assertive)" fixedHeight={170}>
                <div style={{ position: 'relative', height: 170 }}>
                    <div style={{ position: 'absolute', inset: 0, display: 'contents' }}>
                        <div className="gal-overlay" style={{ position: 'absolute', top: 0, left: 0, right: 0 }}>
                            <style>{`.gal-overlay .cl-banner-overlay{position:static;transform:none;width:auto;padding:8px 12px}`}</style>
                            <RendererHangBanner />
                            <DeviceResetBanner requests={[resetReq]} onResolved={noop} />
                        </div>
                    </div>
                </div>
            </Sec>

            <Sec title="Stack of four: top two by priority, the rest behind +N more">
                <ClBannerStack>
                    <ClBanner tone="info" title="Info banner" description="Lowest priority, folded." />
                    <ClBanner tone="warning" title="Warning banner" description="Second by priority." onDismiss={noop} />
                    <ClBanner tone="danger" title="Danger banner" description="Highest priority, always first." onDismiss={noop} />
                    <ClBanner tone="success" title="Success banner" description="Folded." />
                </ClBannerStack>
            </Sec>

            <Sec title="Inline (auth card / settings pane)" width={520}>
                <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <ClBanner inline tone="danger" description="That password isn't right. Try again." />
                    <ClBanner inline tone="info" description="We sent a code to your email." />
                    <ClBanner inline tone="warning" title="Restart Cipherline to apply." actions={[{ key: 'r', label: 'Restart', onClick: noop }]} />
                </div>
            </Sec>

            <Sec title="Narrow, 700px: trial, storage (red), ghost-device alarm" width={700}>
                <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <Trial s={trialStatus(3)} />
                    {storageView(2)}
                    <OwnDeviceAlert alerts={[ownAlert]} selfKeyMismatch={false} unreviewedBaseline={[]} names={{ 'dev-77aa': { device_name: 'Studio PC', platform: 'windows' } }} onConfirm={noop} onReject={noop} onReviewed={noop} onManage={noop} />
                </div>
            </Sec>

            <Sec title="Narrow, 420px" width={420}>
                <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <Trial s={trialStatus(3)} />
                    <ClBanner tone="danger" title="Your last payment failed" description="Update your card to keep your subscription active." actions={[{ key: 'u', label: 'Update payment', variant: 'danger', onClick: noop }]} onDismiss={noop} />
                </div>
            </Sec>
        </div>
    );
};

// index.css pins html/body/#root to the viewport with hidden overflow (the app scrolls inside panes);
// the gallery is a long page, so let it flow.
const flow = document.createElement('style');
flow.textContent = 'html,body,#root{height:auto!important;min-height:0!important;overflow:visible!important;position:static!important}';
document.head.appendChild(flow);
createRoot(document.getElementById('root')!).render(scene === 'gallery' ? <Gallery /> : <Dashboard />);
