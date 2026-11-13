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
import { ClConfirm } from '../src/components/cl';
import { Trash2, Crown } from 'lucide-react';
import { ReportModal } from '../src/components/ReportModal';
import { AnimatedImageDialog } from '../src/components/settings/panes/AnimatedImageDialog';
import { ChannelTopicDialog } from '../src/components/server/ChannelTopicDialog';
import { TotpSettingsCard } from '../src/components/auth/TotpSettingsCard';
import { EncryptedAvatar } from '../src/components/EncryptedAvatar';
import { LegacyBlock, LegacyChatConfirm, LegacyNativeConfirm, LegacyDeleteServer, LegacyTransfer, LegacyRename, LegacyNickname } from './dialogs-restyle-legacy';

/**
 * Block-user + sibling dialogs, REAL components over a dimmed app-like backdrop (network, auth, toasts,
 * avatars stubbed). Query: d=<scene>  v=old|new  plus per-scene state params (see SCENES).
 *
 *  v=new  the migrated component (needs the working tree that has it).
 *  v=old  what shipped before: the component itself where it still existed (report, animated image, topic,
 *         totp, friends-pane confirm) or the verbatim legacy copy of the removed inline dialog.
 *
 * window.__log records every callback the host received.
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const name = q.get('d') ?? 'block';
const OLD = q.get('v') === 'old';
const log: any[] = ((window as any).__log = []);
const note = (...a: any[]) => { log.push(a); };

// Optional modules: absent in the "before" checkout, present after.
const mods = import.meta.glob([
    '../src/components/FriendActionDialog.tsx',
    '../src/components/dialog/PasswordConfirmDialog.tsx',
    '../src/components/server/ServerTextPromptDialogs.tsx',
], { eager: true }) as Record<string, any>;
const pick = (suffix: string, key: string) => {
    const hit = Object.entries(mods).find(([p]) => p.endsWith(suffix));
    return hit ? hit[1][key] : undefined;
};
const FriendActionDialog = pick('FriendActionDialog.tsx', 'FriendActionDialog') as React.FC<any> | undefined;
const PasswordConfirmDialog = pick('PasswordConfirmDialog.tsx', 'PasswordConfirmDialog') as React.FC<any> | undefined;
const RenameCallDialog = pick('ServerTextPromptDialogs.tsx', 'RenameCallDialog') as React.FC<any> | undefined;
const NicknameDialog = pick('ServerTextPromptDialogs.tsx', 'NicknameDialog') as React.FC<any> | undefined;

(window as any).electronAPI = { platform: 'windows' };

const jsonErr = (status: number, message: string, config: any) =>
    Object.assign(new Error('Request failed with status code ' + status), { config, isAxiosError: true, response: { status, data: { message } } });
axios.defaults.adapter = async (config: any) => {
    const url = String(config.url).replace(/^.*\/v1/, '');
    const ok = (data: any) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
    await new Promise(r => setTimeout(r, 60));
    note('http', config.method, url);
    if (/totp\/status/.test(url)) return ok({ enabled: true, enabled_at: '2026-09-01T00:00:00Z', backup_codes_remaining: 7 });
    if (/request-disable-code|request-regen-code/.test(url)) return ok({});
    if (/regenerate-backup-codes/.test(url)) return ok({ backup_codes: ['A1B2-C3D4', 'E5F6-G7H8', 'J9K1-L2M3', 'N4P5-Q6R7', 'S8T9-U1V2', 'W3X4-Y5Z6', 'B7C8-D9E1', 'F2G3-H4J5', 'K6L7-M8N9', 'P1Q2-R3S4'] });
    if (/\/reports$/.test(url)) { if (q.get('fail') === '1') throw jsonErr(500, 'Failed to submit report. Please try again.', config); return ok({}); }
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
            {[['Mira', 'img-mira'], ['tobias.k', 'img-okoye'], ['Jun', 'img-jun'], ['Elena', 'img-elena']].map(([n, av]) => (
                <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '8px 10px' }}>
                    <div style={{ width: 36, height: 36, borderRadius: '50%', overflow: 'hidden', flex: 'none' }}><EncryptedAvatar attachmentId={av} userId={'u-' + n} token="t" className="w-full h-full" disableClickProfile /></div>
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

const LONG = q.get('s') === 'long';
const NAME = LONG ? 'Alexandrina the Magnificent of Westmarch#1234' : 'Mira';

// A tiny animated-looking file for AnimatedImageDialog (a GIF header is enough for an <img> blob preview).
const gifBytes = Uint8Array.from(atob('R0lGODlhAQABAIAAAKm3lQAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='), c => c.charCodeAt(0));
const svgFile = () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f857a6"/><stop offset="1" stop-color="#25E0C8"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/><circle cx="200" cy="170" r="70" fill="#0b0f1e" opacity=".7"/></svg>`;
    return new File([svg], 'cat-dance.svg', { type: 'image/svg+xml' });
};
void gifBytes;

const SCENES: Record<string, () => React.ReactElement | null> = {
    // Block from any sidebar / profile / member menu (Dashboard) and the DM header menu (ChatPane).
    block: () => OLD
        ? <LegacyBlock username={NAME} onCancel={() => note('cancel')} onConfirm={() => note('confirm')} />
        : <FriendActionDialog kind="block" userId="u-mira" username={NAME} avatarUrl="img-mira" token="t" onConfirm={() => note('confirm')} onClose={() => note('close')} />,
    'block-dm': () => OLD
        ? <LegacyChatConfirm title="Block User" message={`Are you sure you want to block ${NAME}? You will no longer receive messages from them.`} confirmLabel="Block" onCancel={() => note('cancel')} onConfirm={() => note('confirm')} />
        : <FriendActionDialog kind="block" userId="u-mira" username={NAME} avatarUrl="img-mira" token="t" onConfirm={() => note('confirm')} onClose={() => note('close')} />,
    // Remove friend: Dashboard menus had NO confirmation at all (v=old shows the Friends-tab ClConfirm they never had).
    unfriend: () => OLD
        ? <ClConfirm open danger title="Remove Friend" confirmLabel="Remove" message={`Remove ${NAME} as a friend? You'll no longer be able to send messages, but your chat history will remain visible.`} onClose={() => note('close')} onConfirm={() => note('confirm')} />
        : <FriendActionDialog kind="unfriend" userId="u-mira" username={NAME} avatarUrl="img-mira" token="t" onConfirm={() => note('confirm')} onClose={() => note('close')} />,
    'devices-remove': () => OLD
        ? <LegacyNativeConfirm message="Remove this device? It will be signed out immediately and any pending messages for it will be deleted." onCancel={() => note('cancel')} onConfirm={() => note('confirm')} />
        : <ClConfirm open danger title="Remove this device?" confirmLabel="Remove device" message="It will be signed out immediately and any pending messages for it will be deleted." onClose={() => note('close')} onConfirm={() => note('confirm')} />,
    'devices-others': () => OLD
        ? <LegacyNativeConfirm message="Sign out every other device on your account? This device stays signed in." onCancel={() => note('cancel')} onConfirm={() => note('confirm')} />
        : <ClConfirm open danger title="Sign out every other device?" confirmLabel="Sign out others" message="Every other device on your account is signed out. This device stays signed in." onClose={() => note('close')} onConfirm={() => note('confirm')} />,
    'delete-server': () => OLD
        ? <LegacyDeleteServer name="Game night" error={q.get('err') ? 'Incorrect password' : undefined} onCancel={() => note('cancel')} />
        : <DeleteServerScene />,
    transfer: () => OLD
        ? <LegacyTransfer server="Game night" member="Mira" onCancel={() => note('cancel')} />
        : <TransferScene />,
    report: () => <ReportModal targetUserId="u-mira" targetUsername={NAME} token="t" initialSnippet={q.get('snippet') ? 'you are all idiots and I will find you' : undefined} onClose={() => note('close')} />,
    animated: () => <AnimatedImageDialog target={{ kind: (q.get('kind') as any) ?? 'avatar', file: svgFile() }} onCancel={() => note('cancel')} onConfirm={() => note('confirm')} />,
    topic: () => <ChannelTopicDialog channelName="game-night-planning" topic={'Weekly sessions every Thursday at 9pm CET.\nBring snacks. New players welcome: ask in #newcomers first.\n\nRules: be kind, no spoilers for the campaign.'} onClose={() => note('close')} />,
    rename: () => OLD
        ? <LegacyRename name="Thursday strategy" onCancel={() => note('cancel')} />
        : <RenameScene />,
    nickname: () => OLD
        ? <LegacyNickname onCancel={() => note('cancel')} />
        : <NicknameDialog open isSelf displayName="Alexandrina" value="Alexandrina" onChange={() => {}} error={q.get('err') ? 'That nickname is not allowed' : null} onSubmit={() => note('save')} onClose={() => note('close')} overlayStyle={{ zIndex: 10020 }} />,
    totp: () => <TotpSettingsCard bare />,
};

const DeleteServerScene = () => {
    const [pw, setPw] = useState(q.get('pw') ? 'hunter2hunter2' : '');
    return <PasswordConfirmDialog open onClose={() => note('close')} onSubmit={() => note('submit', pw)} overlayStyle={{ zIndex: 1100 }}
        label="Delete Game night" icon={<Trash2 size={18} strokeWidth={2.2} />} title="Delete “Game night”?" subtitle="This can't be undone."
        password={pw} onPasswordChange={setPw} error={q.get('err') ? 'Incorrect password' : null} busy={q.get('busy') === '1'}
        submitLabel="Delete server" busyLabel="Deleting…" hint="Deleted for everyone">
        <div className="dlg-text">This permanently deletes all channels, messages, roles, and members. It <strong>cannot be undone</strong>.</div>
    </PasswordConfirmDialog>;
};
const TransferScene = () => {
    const [pw, setPw] = useState(q.get('pw') ? 'hunter2hunter2' : '');
    return <PasswordConfirmDialog open onClose={() => note('close')} onSubmit={() => note('submit', pw)} overlayStyle={{ zIndex: 1100 }}
        label="Transfer ownership" tone="warn" icon={<Crown size={18} strokeWidth={2.2} />} title="Transfer ownership to Mira?" subtitle="You become a regular member of Game night."
        password={pw} onPasswordChange={setPw} submitLabel="Transfer ownership" busyLabel="Transferring…" submitVariant="primary" hint="Only they can transfer it back">
        <div className="dlg-text">You are about to transfer ownership of <strong>Game night</strong> to <strong>Mira</strong>. Only Mira can transfer it back.</div>
    </PasswordConfirmDialog>;
};
const RenameScene = () => {
    const [d, setD] = useState('Thursday strategy');
    return <RenameCallDialog open draft={d} onDraftChange={setD} onSubmit={() => note('rename', d)} onClose={() => note('close')} />;
};

const App = () => {
    const [mounted, setMounted] = useState(true);
    const scene = new Map(Object.entries(SCENES)).get(name);
    if (!scene) throw new Error(`unknown scene "${name}"`);
    // Reopen support for the behaviour checks: the host unmounts on close like the real call sites do.
    (window as any).__remount = () => setMounted(false);
    React.useEffect(() => { if (!mounted) setMounted(true); }, [mounted]);
    return <><Backdrop />{mounted && scene()}<button id="reopen" onClick={() => setMounted(false)} style={{ position: 'fixed', top: 8, right: 8, opacity: 0.01 }}>reopen</button></>;
};

createRoot(document.getElementById('root')!).render(<App />);
