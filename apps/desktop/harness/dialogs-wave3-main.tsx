/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import React, { useState } from 'react';
import axios from 'axios';

/**
 * Wave-3 dialogs, REAL components over a dimmed app-like backdrop. Fakes: the network (axios adapter),
 * useAuth / useToast / useSubscription, the history-transfer key checks and window.electronAPI (aliases +
 * stubs in dialogs-wave3-stubs.ts / the vite config). Stripe is never loaded (no billing dialogs here).
 *
 *   ?d=<name>[&...]   see DIALOGS below; extra params pick a state.
 * window.__log records every callback the host received.
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const name = q.get('d') ?? 'stepup';
const log: any[] = ((window as any).__log = []);
const note = (...a: any[]) => { log.push(a); };

// Deterministic fake 32-byte keys.
const fakeKey = (seed: number) => {
    const b = new Uint8Array(32); let s = seed;
    for (let i = 0; i < 32; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; b[i] = s & 255; }
    return btoa(String.fromCharCode(...b));
};

(window as any).electronAPI = {
    platform: q.get('platform') ?? 'windows',
    macOSMajor: q.get('platform') === 'darwin' ? 15 : undefined,
    getLocalIdentity: async () => fakeKey(1),
    getDisplayRefreshRates: async () => [144, 60],
    getScreenCaptureAccess: async () => (q.get('perm') === 'denied' ? 'denied' : 'granted'),
    openScreenRecordingSettings: () => {},
    quitAndInstall: async () => { if (q.get('quitfail')) throw new Error('x'); note('quitAndInstall'); },
    findWindowSourceByExe: async () => null,
    getDesktopSources: async (types: string[], opts?: { thumbnails?: boolean }) => {
        const thumbs = opts?.thumbnails !== false;
        const mk = (id: string, name: string, hue: number) => ({
            id, name,
            thumbnailDataUrl: thumbs ? 'data:image/svg+xml;utf8,' + encodeURIComponent(
                `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,22%)"/><stop offset="1" stop-color="hsl(${hue + 50},60%,38%)"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><rect x="18" y="16" width="120" height="10" rx="5" fill="rgba(255,255,255,.35)"/><rect x="18" y="38" width="200" height="8" rx="4" fill="rgba(255,255,255,.18)"/><rect x="18" y="54" width="170" height="8" rx="4" fill="rgba(255,255,255,.18)"/></svg>`) : '',
        });
        const out: any[] = [];
        if (types.includes('screen')) out.push(mk('screen:0', 'Screen 1', 200), mk('screen:1', 'Screen 2', 280));
        if (types.includes('window')) out.push(mk('window:1', 'Cipherline', 170), mk('window:2', 'Visual Studio Code', 215), mk('window:3', 'Firefox', 25), mk('window:4', 'Spotify', 140));
        return out;
    },
};

const FAIL = q.get('fail') === '1';
const jsonErr = (status: number, message: string, config: any) =>
    Object.assign(new Error('Request failed with status code ' + status), { config, isAxiosError: true, response: { status, data: { message } } });
axios.defaults.adapter = async (config: any) => {
    const url = String(config.url).replace(/^.*\/v1/, '');
    const ok = (data: any) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
    await new Promise(r => setTimeout(r, 60));
    note('http', config.method, url);
    if (/2fa\/totp\/status/.test(url)) return ok({ enabled: q.get('totp') === '1' });
    if (/request-password-change-code|request-setup-code/.test(url)) return ok({});
    if (/verify-change-code/.test(url)) return ok({ change_token: 'ct' });
    if (/change-password$/.test(url)) return ok({ access_token: 'a', refresh_token: 'r' });
    if (/2fa\/totp\/setup/.test(url)) {
        const qr = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#fff"/>' +
            Array.from({ length: 144 }, (_, i) => ((i * 7 + (i >> 3)) % 3 === 0 ? `<rect x="${(i % 12) * 16 + 4}" y="${Math.floor(i / 12) * 16 + 4}" width="14" height="14" fill="#111"/>` : '')).join('') + '</svg>');
        return ok({ qr_data_url: qr, qrDataUrl: qr, qr, secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', secret_b32: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', setup_token: 'st' });
    }
    if (/2fa\/totp\/enable/.test(url)) return ok({ backup_codes: ['A1B2-C3D4', 'E5F6-G7H8', 'J9K1-L2M3', 'N4P5-Q6R7', 'S8T9-U1V2', 'W3X4-Y5Z6', 'B7C8-D9E1', 'F2G3-H4J5', 'K6L7-M8N9', 'P1Q2-R3S4'] });
    if (/keys\/identity_keys\?user_id=me/.test(url)) return ok([{ device_id: 'dev-1', identity_key_pub_b64: fakeKey(1) }, { device_id: 'dev-2', identity_key_pub_b64: fakeKey(2) }]);
    if (/keys\/identity_keys/.test(url)) {
        if (FAIL) throw jsonErr(404, 'none', config);
        return ok([{ device_id: 'aaaa1111', identity_key_pub_b64: fakeKey(11) }, { device_id: 'bbbb2222', identity_key_pub_b64: fakeKey(12) }]);
    }
    if (/\/devices$/.test(url)) return ok([{ device_id: 'dev-1', device_name: 'Desktop', platform: 'windows' }, { device_id: 'dev-2', device_name: 'Pixel 8', platform: 'android' }]);
    if (/decline-history|deliver-history/.test(url)) return ok({});
    return ok({});
};

/* ── App-like backdrop ───────────────────────────────────────────────────── */
const Backdrop = () => (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'Nunito, sans-serif', color: '#F4F7FF' }}>
        <div style={{ width: 72, background: '#070A15', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, paddingTop: 14 }}>
            {['#25E0C8', '#243056', '#243056', '#243056'].map((c, i) => (
                <div key={i} style={{ width: 46, height: 46, borderRadius: i === 0 ? 16 : 23, background: c }} />
            ))}
        </div>
        <div style={{ width: 268, background: '#0F1528', borderRight: '1px solid #1E2848', padding: '16px 10px' }}>
            <div style={{ height: 36, borderRadius: 10, background: '#1C2542', marginBottom: 18 }} />
            {['Mira', 'tobias.k', 'Jun', 'Elena'].map(n => (
                <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '8px 10px' }}>
                    <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#243056' }} />
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#A7B3D4' }}>{n}</div>
                </div>
            ))}
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#0B0F1E' }}>
            <div style={{ height: 56, borderBottom: '1px solid #1E2848', display: 'flex', alignItems: 'center', padding: '0 20px', fontFamily: 'Fredoka, sans-serif', fontWeight: 600, fontSize: 16 }}>Mira</div>
            <div style={{ flex: 1, padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
                {['did you get the build working on the test PC?', 'yep — the picker redesign is next', 'nice. send me the screenshots'].map((t, i) => (
                    <div key={i} style={{ display: 'flex', gap: 12 }}>
                        <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#243056', flex: 'none' }} />
                        <div style={{ color: '#A7B3D4', fontSize: 14 }}>{t}</div>
                    </div>
                ))}
            </div>
        </div>
    </div>
);

const noop = () => {};
const REQ = {
    device_id: 'req-1', device_name: 'Dawson’s MacBook Pro', platform: 'mac',
    requested_at: new Date().toISOString(), expires_at: new Date(Date.now() + 14 * 60_000 + 34_000).toISOString(),
    reset_due_at: null, ip_hint: '203.0.113.0',
    identity_key_pub_b64: fakeKey(5), nonce_b64: 'bm9uY2U=',
};

const load = async () => {
    const C: Record<string, () => Promise<React.ReactElement>> = {
        stepup: async () => {
            const { StepUpModal } = await import('../src/components/StepUpModal');
            return <StepUpModal open method={(q.get('method') as any) ?? 'password'} busy={q.get('busy') === '1'} error={q.get('err') ? 'That code didn’t match. Try again.' : null}
                subject="your backup passphrase" onSubmit={(v) => note('submit', v)} onCancel={() => note('cancel')} />;
        },
        restore: async () => {
            const { RestorePasswordModal } = await import('../src/components/RestorePasswordModal');
            return <RestorePasswordModal open source={(q.get('source') as any) ?? 'local'} fileName="cipherline-backup-2026-10-12.enc" busy={q.get('busy') === '1'}
                progressLabel="Decrypting records…" error={q.get('err') ? 'Wrong password for this backup.' : null} currentPassword={q.get('cur') ? 'hunter2' : null}
                onSubmit={(p) => note('submit', p)} onCancel={() => note('cancel')} />;
        },
        stale: async () => {
            const { StaleBackupModal } = await import('../src/components/StaleBackupModal');
            return <StaleBackupModal warning={{ title: 'This backup is older than your last one', message: 'The file you picked was written before the last backup this device saved to this folder. Restoring it will roll your messages back to that earlier point.' } as any}
                onDecide={(ok) => note('decide', ok)} />;
        },
        storage: async () => {
            const { DeviceStorageSetupModal } = await import('../src/components/DeviceStorageSetupModal');
            return <DeviceStorageSetupModal open onSave={async (c, how) => { note('save', how); if (q.get('err')) throw new Error('Couldn’t save to this device’s secure storage.'); }} />;
        },
        upgradeRequired: async () => {
            const { default: UpgradeRequiredOverlay } = await import('../src/components/UpgradeRequiredOverlay');
            setTimeout(() => window.dispatchEvent(new CustomEvent('cipherline:upgrade-required', { detail: { minVersion: '1.0.22' } })), 50);
            return <UpgradeRequiredOverlay />;
        },
        changepw: async () => {
            const { ChangePasswordModal } = await import('../src/components/auth/ChangePasswordModal');
            return <ChangePasswordModal open onClose={() => note('close')} />;
        },
        totp: async () => {
            const { TotpSetupModal } = await import('../src/components/auth/TotpSetupModal');
            return <TotpSetupModal onClose={() => note('close')} onDone={() => note('done')} />;
        },
        safety: async () => {
            const { SafetyVerificationModal } = await import('../src/components/SafetyVerificationModal');
            return <SafetyVerificationModal isOpen onClose={() => note('close')} myUserId="me" myDeviceId="dev-1" remoteUserId="u-mira" remoteUsername="Mira" token="t"
                onSendCode={async () => {}} />;
        },
        devapprove: async () => {
            const { DeviceApprovalModal } = await import('../src/components/DeviceApprovalModal');
            return <DeviceApprovalModal request={q.get('reset') ? { ...REQ, reset_due_at: new Date(Date.now() + 86400000).toISOString() } as any : REQ as any}
                onClose={() => note('close')} onResolved={(...a) => note('resolved', ...a)} onNotMe={() => note('notme')} />;
        },
        devremoved: async () => {
            const { DeviceRemovedNotice } = await import('../src/components/DeviceApprovalModal');
            return <DeviceRemovedNotice deviceName="Dawson’s MacBook Pro" onChangePassword={() => note('changepw')} onLater={() => note('later')} />;
        },
        history: async () => {
            const { HistoryRequestModal } = await import('../src/components/HistoryRequestModal');
            return <HistoryRequestModal request={{ device_id: 'req-1', device_name: 'Pixel 8', platform: 'android', requested_at: new Date().toISOString(), capability_sig_b64: 'x', capability_ts: 1 } as any} onClose={() => note('close')} />;
        },
        screenlock: async () => {
            const { default: ScreenLockSettings } = await import('../src/components/ScreenLockSettings');
            const screenLock: any = {
                settings: { enabled: q.get('enabled') === '1', pinLength: 6, timeoutMinutes: 5, lockOnOsLock: true, verifier: null },
                isLocked: false, attempts: 0, lockedOutUntil: null, lockNow: noop, unlock: noop,
                setPin: async () => note('setPin'), changePin: async () => true, disable: async () => true, setTimeoutMinutes: noop, setLockOnOsLock: noop,
            };
            const keybinds: any = { binds: {} };
            return <div style={{ position: 'relative', zIndex: 0, padding: 40, maxWidth: 640 }}><ScreenLockSettings screenLock={screenLock} keybinds={keybinds} /></div>;
        },
        picker: async () => {
            const { ScreenSharePickerModal } = await import('../src/components/ScreenSharePickerModal');
            return <ScreenSharePickerModal initialTab={(q.get('tab') as any) ?? 'screen'} onSelect={(o) => note('select', o)} />;
        },
    };
    // Look the query-string name up in a Map, never as `C[name]`: a name such as
    // `constructor` or `__proto__` must not reach an inherited Object method.
    const render = new Map(Object.entries(C)).get(name);
    if (typeof render !== 'function') throw new Error(`unknown dialog "${name}"`);
    return render();
};

const App = () => {
    const [el, setEl] = useState<React.ReactElement | null>(null);
    React.useEffect(() => { load().then(setEl); }, []);
    return (<><Backdrop />{el}</>);
};
createRoot(document.getElementById('root')!).render(<App />);
