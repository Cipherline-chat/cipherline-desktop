/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import React from 'react';
import axios from 'axios';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/settings-descent.css';
import { loadWebFonts } from '../src/utils/webFonts';
import { secureLocalStore } from '../src/utils/secureLocalStore';

/**
 * The REAL SettingsScreen (every pane) over a fake app backdrop.
 *   ?tab=<PaneId>     which pane opens first (default profile)
 *   ?open=<ids>       comma list of settings disclosure ids to force open (after-redesign only)
 * Fakes: network (axios adapter below), useAuth + avatar decrypt (vite aliases),
 * window.electronAPI (a permissive Proxy, installed AFTER secureLocalStore hydrates
 * so the store runs in its plain browser mode).
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const DAY = 24 * 3600 * 1000;
const iso = (d: number) => new Date(Date.now() - d * DAY).toISOString();

const reply = (config: any, data: any, status = 200) => ({ data, status, statusText: 'OK', headers: {}, config });
axios.defaults.adapter = async (config: any) => {
    const url = String(config.url).replace(/^.*\/v1/, '');
    await new Promise(r => setTimeout(r, 60));
    if (url.startsWith('/billing/status')) return reply(config, {
        subscription_status: 'active', effective_status: 'active', trial_ends_at: null, trial_extended: false,
        trial_days_left: 0, current_period_end: iso(-21), has_subscription: true, stripe_customer_id: 'cus_x',
        period_ends_in_days: 21, plan_amount: 250, plan_currency: 'usd', automatic_tax: false,
    });
    if (url.startsWith('/billing/payment-method')) return reply(config, { payment_method: { brand: 'visa', last4: '4242', exp_month: 8, exp_year: 2029 } });
    if (url.startsWith('/billing/invoices')) return reply(config, { invoices: [
        { id: 'in_1', number: 'CL-0003', created: iso(9), amount_paid: 250, amount_due: 250, currency: 'usd', status: 'paid', hosted_invoice_url: 'https://example.invalid' },
        { id: 'in_2', number: 'CL-0002', created: iso(39), amount_paid: 250, amount_due: 250, currency: 'usd', status: 'paid', hosted_invoice_url: 'https://example.invalid' },
    ] });
    if (url.startsWith('/billing/referral')) return reply(config, { code: 'DAWSON-7Q', url: 'https://cipherline.chat/ref/DAWSON-7Q', referred: 1, rewarded_days: 30 });
    if (url.startsWith('/devices/presence')) return reply(config, { devices: [{ device_id: 'dev-1', online: true }, { device_id: 'dev-2', online: true }] });
    if (url === '/devices') return reply(config, [
        { device_id: 'dev-1', device_name: 'Desk PC', platform: 'win32', created_at: iso(120), last_seen_at: iso(0) },
        { device_id: 'dev-2', device_name: 'Pixel 8', platform: 'android', created_at: iso(40), last_seen_at: iso(0.2) },
        { device_id: 'dev-3', device_name: 'Old laptop', platform: 'linux', created_at: iso(300), last_seen_at: iso(75) },
    ]);
    if (url.startsWith('/auth/2fa/totp/status')) return reply(config, { enabled: false, backup_codes_remaining: 0 });
    if (url.startsWith('/auth/me')) return reply(config, { user_id: 'u-me', username: 'Dawson', discriminator: 4821, display_name: 'Dawson', bio: 'Building the quiet internet.' });
    if (url.startsWith('/servers')) return reply(config, []);
    if (url.startsWith('/link/')) return reply(config, []);
    console.warn('[harness] unmocked', config.method, url);
    return reply(config, {});
};

function msgs(prefix: string, n: number, spread: number[], withFiles = 0) {
    const now = Date.now();
    return Array.from({ length: n }, (_, i) => ({
        id: `${prefix}${i}`,
        timestamp: now - spread[i % spread.length] * DAY,
        content: i < withFiles
            ? { type: 'attachment', attachment_id: `${prefix}-att-${i}`, filename: 'shot.png', byte_size: 340_000 + i * 11_000 }
            : { type: 'text', text: 'hello there '.repeat(1 + (i % 4)) },
    }));
}
const conversations = [
    { conversation_id: 'c1', type: 'dm', title: 'Mira', other_user_id: 'user-mira', avatar_url: 'img-mira' },
    { conversation_id: 'c2', type: 'group', title: 'Weekend crew', avatar_url: 'img-crew' },
    { conversation_id: 'c3', type: 'dm', title: 'Jonas', other_user_id: 'user-jonas', avatar_url: null },
];
const messagesState: Record<string, any[]> = {
    c1: msgs('d', 1240, [2, 5, 12, 40, 90, 200, 400], 30),
    c2: msgs('g', 460, [1, 3, 9, 25, 60, 150, 300], 12),
    c3: msgs('j', 210, [1, 9, 60, 200]),
};
const servers = [{ server_id: 'S1', name: 'Neon Guild' }, { server_id: 'S2', name: 'Design Team' }];
const serverStorage: any = {
    servers, serverChannels: { S1: [{ channel_id: 'n1', name: 'general' }], S2: [{ channel_id: 'd1', name: 'crit' }] },
    channelMessages: { n1: msgs('n1-', 900, [1, 4, 20, 100]), d1: msgs('d1-', 200, [2, 30, 200]) },
    leftServerChannels: {}, protectedIds: {}, token: 'harness-token', loading: false, error: false,
    onPurge: async () => ({ purged: 0, skippedChannels: 0 }),
};

function installElectronStub() {
    const values: Record<string, unknown> = {
        getAutoStart: false, getStartMinimized: false, getMinimizeToTray: true, getUpdateChannel: 'latest',
        getPlatform: 'win32', platform: 'win32', getAppVersion: '1.0.23',
        gdriveAuthStatus: { linked: false }, getDeviceName: 'DESK-PC',
        getRunningProcesses: ['hollow_knight.exe', 'steam.exe', 'obs64.exe', 'spotify.exe'],
    };
    // ?gaming=1: a main process that knows the startup flags, so Voice & Video
    // shows its "while gaming" row (it renders nothing without them).
    if (q.get('gaming') === '1') values.getStartupFlags = { platform: 'win32', saved: {}, active: {} };
    const excluded = new Set(['secureKvOpen', 'secureKvSeal', 'getLocalMasterKeyStatus', 'then']);
    (window as any).electronAPI = new Proxy({}, {
        get(_t, prop: string) {
            if (excluded.has(prop)) return undefined;
            if (prop === 'platform') return 'win32';
            if (/^on[A-Z]/.test(prop)) return () => () => {};
            return (..._args: unknown[]) => Promise.resolve(values[prop]);
        },
    });
}

/**
 * ?audio=1: a Windows-like device list (a headset that is the system default
 * both ways, a USB mic, the built-in speakers), the account bound so the
 * per-device audio profiles load, and two remembered devices that are NOT
 * plugged in (a Yeti mic, AirPods) so "Your audio devices" shows every state.
 * ?audio=fresh: the same devices with nothing remembered yet (first run).
 */
async function installAudioDevices() {
    const mode = q.get('audio');
    if (!mode) return;
    const d = (deviceId: string, label: string, groupId: string, kind: MediaDeviceKind) =>
        ({ deviceId, label, groupId, kind, toJSON: () => ({}) }) as MediaDeviceInfo;
    const list = [
        d('default', 'Default - Headset Microphone (Arctis Nova 7)', 'g-arctis', 'audioinput'),
        d('communications', 'Communications - Headset Microphone (Arctis Nova 7)', 'g-arctis', 'audioinput'),
        d('id-arctis-mic', 'Headset Microphone (Arctis Nova 7)', 'g-arctis', 'audioinput'),
        d('id-mv7', 'Microphone (Shure MV7)', 'g-mv7', 'audioinput'),
        d('default', 'Default - Headset Earphone (Arctis Nova 7)', 'g-arctis', 'audiooutput'),
        d('id-arctis-out', 'Headset Earphone (Arctis Nova 7)', 'g-arctis', 'audiooutput'),
        d('id-rt', 'Speakers (Realtek(R) Audio)', 'g-rt', 'audiooutput'),
    ];
    const md = navigator.mediaDevices;
    if (md) {
        md.enumerateDevices = async () => list;
        md.getUserMedia = async () => {
            const ctx = new AudioContext();
            const osc = ctx.createOscillator();
            const g = ctx.createGain(); g.gain.value = 0.02;
            const dst = ctx.createMediaStreamDestination();
            osc.connect(g).connect(dst); osc.start();
            return dst.stream;
        };
    }
    secureLocalStore.setItem('cipherline_user_id', 'u-me');
    await secureLocalStore.whenAccountReady();
    if (mode === 'fresh') return;
    const DAY = 86400000, now = Date.now();
    const input = (o: Record<string, unknown>) => ({
        micVolume: 100, noiseSuppression: true, noiseSuppressionMode: 'strong', voiceGate: true, voiceGateThreshold: -45,
        echoCancellation: false, volumeNormalization: true, eqEnabled: false, eqBands: [0, 0, 0, 0, 0], ...o,
    });
    secureLocalStore.setItem('cipherline_audio_device_profiles_u-me', JSON.stringify({ v: 1,
        input: {
            'headset microphone (arctis nova 7)': { label: 'Headset Microphone (Arctis Nova 7)', deviceId: 'id-arctis-mic', groupId: 'g-arctis', lastUsedAt: now - 60000, settings: input({ micVolume: 115, noiseSuppressionMode: 'light' }) },
            'microphone (shure mv7)': { label: 'Microphone (Shure MV7)', deviceId: 'id-mv7', groupId: 'g-mv7', lastUsedAt: now - 2 * DAY, settings: input({ micVolume: 140, noiseSuppression: false }) },
            'microphone (yeti stereo microphone)': { label: 'Microphone (Yeti Stereo Microphone)', deviceId: 'id-yeti', groupId: 'g-yeti', lastUsedAt: now - 9 * DAY, settings: input({ voiceGateThreshold: -38, echoCancellation: true }) },
        },
        output: {
            'headset earphone (arctis nova 7)': { label: 'Headset Earphone (Arctis Nova 7)', deviceId: 'id-arctis-out', groupId: 'g-arctis', lastUsedAt: now - 60000, settings: { speakerVolume: 70, normalizeIncomingVolume: true } },
            'speakers (realtek(r) audio)': { label: 'Speakers (Realtek(R) Audio)', deviceId: 'id-rt', groupId: 'g-rt', lastUsedAt: now - 5 * 3600000, settings: { speakerVolume: 130, normalizeIncomingVolume: true } },
            'airpods pro': { label: 'AirPods Pro', deviceId: 'id-airpods', groupId: 'g-airpods', lastUsedAt: now - 4 * DAY, settings: { speakerVolume: 55, normalizeIncomingVolume: false } },
        },
    }));
    // the live settings match the headset's profile (it was in use last session)
    secureLocalStore.setItem('cipherline_voice_settings', JSON.stringify({ micVolume: 115, noiseSuppression: true, noiseSuppressionMode: 'light', speakerVolume: 70 }));
}

async function boot() {
    await secureLocalStore.hydrate();
    await installAudioDevices();
    installElectronStub();
    const [{ SettingsScreen }, { ToastProvider }, { UpdateProvider }, { NotificationProvider }, { SubscriptionProvider },
        { useRetentionPolicy }, { useKeybinds }, { useVoiceSettings }, { useGameSettings }, { usePrivacySettings },
        { useScreenLock }, { useGifSettings }] = await Promise.all([
        import('../src/components/settings/SettingsScreen'),
        import('../src/contexts/ToastContext'),
        import('../src/contexts/UpdateContext'),
        import('../src/contexts/NotificationContext'),
        import('../src/contexts/SubscriptionContext'),
        import('../src/hooks/useRetentionPolicy'),
        import('../src/hooks/useKeybinds'),
        import('../src/hooks/useVoiceSettings'),
        import('../src/hooks/useGameSettings'),
        import('../src/hooks/usePrivacySettings'),
        import('../src/hooks/useScreenLock'),
        import('../src/hooks/useGifSettings'),
    ]);
    const noop = () => {};
    const Host: React.FC = () => {
        const retention = useRetentionPolicy('u-me');
        const keybinds = useKeybinds({});
        const voice = useVoiceSettings(q.get('audio') ? 'u-me' : null);
        const gameSettings = useGameSettings('u-me');
        const privacy = usePrivacySettings();
        const screenLock = useScreenLock();
        const gif = useGifSettings();
        const [open, setOpen] = React.useState(true);
        if (!open) return <button onClick={() => setOpen(true)} style={{ margin: 40 }}>Open settings</button>;
        return (
            <SettingsScreen
                initialTab={(q.get('tab') as any) ?? 'profile'}
                onClose={() => setOpen(false)}
                onLogout={noop}
                retention={retention}
                messagesState={messagesState}
                onClearAllMessages={noop}
                conversations={conversations}
                onPurgeConversation={noop}
                onPurgeTypeNow={noop}
                serverStorage={serverStorage}
                keybinds={keybinds}
                voice={voice}
                gameSettings={gameSettings}
                currentGame={q.get('game') === '0' ? null : 'Hollow Knight'}
                currentGameProcess={q.get('game') === '0' ? null : 'hollow_knight.exe'}
                onIgnoreCurrentGame={noop}
                privacy={privacy}
                screenLock={screenLock}
                gif={gif}
            />
        );
    };
    const FakeApp = () => (
        <div style={{ display: 'flex', height: '100vh', color: '#A7B3D4', font: '14px Nunito, sans-serif' }}>
            <div style={{ width: 72, background: '#131A30' }} />
            <div style={{ width: 240, background: '#1C2542', padding: 16 }}>
                {['general', 'random', 'design', 'voice-lounge'].map(c => <div key={c} style={{ padding: '6px 0' }}># {c}</div>)}
            </div>
            <div style={{ flex: 1, padding: 24 }}>
                {Array.from({ length: 8 }, (_, i) => <p key={i}>Message {i + 1} in the conversation…</p>)}
            </div>
        </div>
    );
    createRoot(document.getElementById('root')!).render(
        <ToastProvider>
            <UpdateProvider>
                <NotificationProvider>
                    <SubscriptionProvider>
                        <FakeApp />
                        <Host />
                    </SubscriptionProvider>
                </NotificationProvider>
            </UpdateProvider>
        </ToastProvider>,
    );
    (window as any).__booted = true;
}
boot();
