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
import { EncryptedAvatar } from '../src/components/EncryptedAvatar';
import { ToastProvider } from '../src/contexts/ToastContext';
import { ClModal, ClButton, ClConfirm } from '../src/components/cl';
import { AddFriendModal } from '../src/components/AddFriendModal';
import { CreateGroupModal } from '../src/components/CreateGroupModal';
import { AddGroupMembersModal } from '../src/components/AddGroupMembersModal';
import { AddToGroupModal } from '../src/components/AddToGroupModal';
import { SharedContentModal } from '../src/components/SharedContentModal';
import { CloseChatDialog } from '../src/components/CloseChatDialog';
import { SoloKickDialog } from '../src/components/call/SoloKickDialog';
import { CrashPrompt } from '../src/components/diagnostics/CrashPrompt';
import { GpuRestartPrompt } from '../src/components/diagnostics/GpuRestartPrompt';
import { PurgeConfirmModal } from '../src/components/PurgeControls';
import { DangerPane } from '../src/components/settings/panes/DangerPane';
import { useUnsavedChangesGuard } from '../src/hooks/useUnsavedChangesGuard';
import { ConfirmDialog } from '../src/components/primitives/ConfirmDialog';
import { showGpuRestartPrompt } from '../src/utils/gpuRecovery';

/**
 * Dialogs wave 1: the REAL dialogs, one per `?d=<id>`, over a dimmed app-like backdrop.
 * Fakes: the network (axios adapter), useAuth + avatar decrypt (vite aliases).
 *   ?d=addfriend | creategroup | addmembers | addtogroup | shared-links | shared-files | shared-media
 *      | closechat-dm | closechat-group | unsaved | solokick | crash | gpu | purge | purge-empty | purge-all
 *      | danger | clconfirm-danger | clconfirm-plain | clconfirm-body | confirmdialog | legacy
 * window.__calls records every non-GET request, window.__log every callback.
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const D = q.get('d') ?? 'addfriend';
(window as any).__calls = [] as string[];
(window as any).__log = [] as string[];
const log = (s: string) => { (window as any).__log.push(s); };

const FRIENDS = [
    { user_id: 'u-mira', username: 'Mira', discriminator: 4821, avatar_url: 'img-mira' },
    { user_id: 'u-jun', username: 'Jun', discriminator: 77, avatar_url: 'img-jun' },
    { user_id: 'u-tobias', username: 'tobias.k', discriminator: 1290, avatar_url: null },
    { user_id: 'u-sana', username: 'Sana', discriminator: 3105, avatar_url: 'img-sana' },
    { user_id: 'u-okoye', username: 'Okoye', discriminator: 9002, avatar_url: 'img-okoye' },
    { user_id: 'u-leif', username: 'leif', discriminator: 18, avatar_url: null },
    { user_id: 'u-priya', username: 'Priya', discriminator: 6630, avatar_url: null },
    { user_id: 'u-marco', username: 'Marco', discriminator: 2411, avatar_url: 'img-marco' },
];
const CONVERSATIONS = [
    { conversation_id: 'c-mira', type: 'dm', other_user_id: 'u-mira', title: 'Mira', avatar_url: 'img-mira' },
    { conversation_id: 'c-tobias', type: 'dm', other_user_id: 'u-tobias', title: 'tobias.k' },
    { conversation_id: 'c-jun', type: 'dm', other_user_id: 'u-jun', title: 'Jun', avatar_url: 'img-jun' },
    { conversation_id: 'g-crew', type: 'group', title: 'Weekend Crew' },
];
const GROUPS = [
    { conversation_id: 'g-crew', type: 'group', title: 'Weekend Crew' },
    { conversation_id: 'g-ops', type: 'group', title: 'Ops war room' },
    { conversation_id: 'g-book', type: 'group', title: 'Book club (spoilers!)' },
];

const reply = (config: any, data: any, status = 200) => ({ data, status, statusText: 'OK', headers: {}, config });
const reject = (config: any, status: number, message: string) => Promise.reject(Object.assign(new Error(message), { config, response: { status, data: { message } } }));
axios.defaults.adapter = async (config: any) => {
    const url = String(config.url);
    const m = (config.method || 'get').toUpperCase();
    if (m !== 'GET') (window as any).__calls.push(`${m} ${url.replace(/^.*\/v1/, '')} ${String(config.data ?? '')}`);
    await new Promise(r => setTimeout(r, 150));
    if (/\/friends$/.test(url)) return reply(config, { accepted: FRIENDS });
    if (/\/conversations\/group$/.test(url)) return reply(config, { conversation_id: 'g-new' }, 201);
    if (/\/invite$/.test(url)) {
        if (q.get('invitefail') === '1') return reject(config, 403, 'You can only add friends.');
        return reply(config, { ok: true });
    }
    if (/\/friends\/request$/.test(url)) {
        if (q.get('friendfail') === '1') return reject(config, 404, 'No user found with that tag.');
        return reply(config, { ok: true });
    }
    if (/totp\/status$/.test(url)) return reply(config, { enabled: q.get('totp') === '1' });
    if (/deletion-code$/.test(url)) return reply(config, { ok: true });
    if (/\/auth\/account$/.test(url)) { if (q.get('delfail') === '1') return reject(config, 401, 'Incorrect password.'); return reply(config, { ok: true }); }
    throw new Error('unexpected ' + m + ' ' + url);
};

const Backdrop = () => (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'Nunito, sans-serif', color: '#F4F7FF' }}>
        <div style={{ width: 72, background: '#070A15', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, paddingTop: 14 }}>
            {['#25E0C8', '#243056', '#243056', '#243056', '#243056'].map((c, i) => (
                <div key={i} style={{ width: 46, height: 46, borderRadius: i === 0 ? 16 : 23, background: c, opacity: i === 0 ? 1 : 0.9 }} />
            ))}
        </div>
        <div style={{ width: 268, background: '#0F1528', borderRight: '1px solid #1E2848', padding: '16px 10px' }}>
            <div style={{ height: 36, borderRadius: 10, background: '#1C2542', marginBottom: 18 }} />
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.08em', color: '#5E6B8F', textTransform: 'uppercase', padding: '0 8px 8px' }}>Direct messages</div>
            {CONVERSATIONS.map(c => (
                <div key={c.conversation_id} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '8px 10px', borderRadius: 12, background: c.conversation_id === 'c-mira' ? '#1C2542' : undefined }}>
                    <div style={{ width: 36, height: 36, borderRadius: '50%', overflow: 'hidden', flex: 'none' }}>
                        <EncryptedAvatar attachmentId={(c as any).avatar_url ?? null} userId={(c as any).other_user_id ?? null} isGroup={c.type === 'group'} token="t" className="w-full h-full" fallbackSize={16} disableClickProfile />
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#A7B3D4' }}>{c.title}</div>
                </div>
            ))}
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#0B0F1E' }}>
            <div style={{ height: 56, borderBottom: '1px solid #1E2848', display: 'flex', alignItems: 'center', padding: '0 20px', gap: 12 }}>
                <div style={{ width: 30, height: 30, borderRadius: '50%', overflow: 'hidden' }}><EncryptedAvatar attachmentId="img-mira" userId="u-mira" token="t" className="w-full h-full" disableClickProfile /></div>
                <div style={{ fontFamily: 'Fredoka, sans-serif', fontWeight: 600, fontSize: 16 }}>Mira</div>
            </div>
            <div style={{ flex: 1, padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
                {[
                    ['Mira', 'did you get the build working on the test PC?', 'img-mira'],
                    ['Dawson', 'yep — the dialogs are next', 'img-me'],
                    ['Mira', 'nice. send me the screenshots when you have them', 'img-mira'],
                ].map(([who, text, av], i) => (
                    <div key={i} style={{ display: 'flex', gap: 12 }}>
                        <div style={{ width: 36, height: 36, borderRadius: '50%', overflow: 'hidden', flex: 'none' }}><EncryptedAvatar attachmentId={av} userId={who === 'Mira' ? 'u-mira' : 'me'} token="t" className="w-full h-full" disableClickProfile /></div>
                        <div><div style={{ fontWeight: 800, fontSize: 14 }}>{who}</div><div style={{ color: '#A7B3D4', fontSize: 14 }}>{text}</div></div>
                    </div>
                ))}
            </div>
            <div style={{ margin: '0 20px 20px', height: 48, borderRadius: 14, background: '#131A30', border: '1px solid #2A3558' }} />
        </div>
    </div>
);

const NOW = Date.now();
const DAY = 86_400_000;
const SHARED_MESSAGES = [
    { id: 'm1', sender_user_id: 'u-mira', sent_at_client: new Date(NOW - 2 * DAY).toISOString(), content: { type: 'attachment', attachment_id: 'a1', file_key_b64: 'AAAA', file_nonce_b64: 'AAAA', mime: 'application/pdf', filename: 'Q3-roadmap-final.pdf', byte_size: 2_400_000 } },
    { id: 'm2', sender_user_id: 'me', sent_at_client: new Date(NOW - 5 * DAY).toISOString(), content: { type: 'attachment', attachment_id: 'a2', file_key_b64: 'AAAA', file_nonce_b64: 'AAAA', mime: 'application/zip', filename: 'screenshots.zip', byte_size: 18_900_000 } },
    { id: 'm3', sender_user_id: 'u-mira', sent_at_client: new Date(NOW - 1 * DAY).toISOString(), content: { type: 'attachment', attachment_id: 'a3', file_key_b64: 'AAAA', file_nonce_b64: 'AAAA', mime: 'audio/mpeg', filename: 'voice-note.mp3', byte_size: 640_000 } },
    { id: 'm4', sender_user_id: 'u-mira', sent_at_client: new Date(NOW - 3 * DAY).toISOString(), content: { type: 'text', text: 'docs here https://docs.cipherline.chat/getting-started and the repo https://github.com/Cipherline-chat/desktop' } },
    { id: 'm5', sender_user_id: 'me', sent_at_client: new Date(NOW - 9 * DAY).toISOString(), content: { type: 'text', text: 'look at https://example.org/a/very/long/path/that/keeps/going/and/going/index.html?ref=share' } },
];
const sharedNames = (id: string | null) => (id === 'me' ? 'You' : id === 'u-mira' ? 'Mira' : null);

const Host: React.FC<{ children: (close: () => void) => React.ReactNode }> = ({ children }) => {
    const [open, setOpen] = useState(true);
    return (<>{open && children(() => { log('close'); setOpen(false); })}{!open && <button id="reopen" onClick={() => setOpen(true)} style={{ position: 'fixed', top: 8, right: 8 }}>reopen</button>}</>);
};

const UnsavedDemo = () => {
    const g = useUnsavedChangesGuard('Your profile changes');
    React.useEffect(() => { g.setDirty(true); }, []);
    React.useEffect(() => { if (g.dirty) g.guard(() => log('discarded')); }, [g.dirty]);
    return <>{g.dialog}</>;
};

const CloseChatDemo: React.FC<{ group: boolean }> = ({ group }) => {
    const [chk, setChk] = useState(false);
    return <Host>{close => <CloseChatDialog state={{ id: 'c-mira', title: group ? 'Weekend Crew' : 'Mira', isGroup: group }} deleteDataChecked={chk} setDeleteDataChecked={setChk} onConfirm={() => log('confirm ' + chk)} onClose={close} />}</Host>;
};

const Subject = () => {
    switch (D) {
        case 'addfriend': return <Host>{close => <AddFriendModal onClose={close} />}</Host>;
        case 'creategroup': return <Host>{close => <CreateGroupModal onClose={close} onGroupCreated={g => log('created ' + JSON.stringify(g))} preSelectedUsers={q.get('pre') === '1' ? [{ user_id: 'u-mira', username: 'Mira' }, { user_id: 'u-jun', username: 'Jun' }] : undefined} />}</Host>;
        case 'addmembers': return <Host>{close => <AddGroupMembersModal conversationId="g-crew" conversationTitle="Weekend Crew" memberIds={['me', 'u-mira', 'u-jun']} onClose={close} onAdded={r => log('added ' + r.added.length + '/' + r.failedCount)} />}</Host>;
        case 'addtogroup': return <Host>{close => <AddToGroupModal targetUser={{ user_id: 'u-sana', username: 'Sana' }} myGroups={GROUPS} onClose={close} onGroupJoined={id => log('joined ' + id)} onCreateNew={() => log('createNew')} />}</Host>;
        case 'shared-links': case 'shared-files': case 'shared-media':
            return <Host>{close => <SharedContentModal open initialTab={D.replace('shared-', '') as any} onClose={close} messages={SHARED_MESSAGES} token="t" title="Mira" onJumpToMessage={id => log('jump ' + id)} resolveSenderName={sharedNames} />}</Host>;
        case 'closechat-dm': return <CloseChatDemo group={false} />;
        case 'closechat-group': return <CloseChatDemo group />;
        case 'unsaved': return <UnsavedDemo />;
        case 'solokick': return <Host>{close => <SoloKickDialog onClose={close} />}</Host>;
        case 'crash': return <CrashPrompt count={2} onReview={() => log('review')} onNotNow={() => log('notnow')} />;
        case 'gpu': { (window as any).electronAPI = { relaunchApp: async () => { log('relaunch'); } }; setTimeout(() => showGpuRestartPrompt({ inCall: true }), 0); return <GpuRestartPrompt inCall onBeforeRelaunch={async () => { log('beforeRelaunch'); }} />; }
        case 'purge': return <PurgeConfirmModal count={1284} label="1 month" convTitle="Mira" onConfirm={() => log('purge')} onCancel={() => log('cancel')} />;
        case 'purge-all': return <PurgeConfirmModal count={1} label="Everything" onConfirm={() => log('purge')} onCancel={() => log('cancel')} warning="Server history stays on the server; pinned messages are kept." />;
        case 'purge-empty': return <PurgeConfirmModal count={0} label="1 week" convTitle="Mira" onConfirm={() => log('purge')} onCancel={() => log('cancel')} />;
        case 'danger': return <div style={{ position: 'fixed', top: 16, left: 16, width: 560, zIndex: 1 }}><DangerPane onLogout={() => log('logout')} onCloseSettings={() => log('closeSettings')} /></div>;
        case 'clconfirm-danger': return <ClConfirm open onClose={() => log('close')} onConfirm={() => log('confirm')} title="Delete #general?" message="This permanently deletes the channel and its message history for everyone. This can't be undone." confirmLabel="Delete channel" danger />;
        case 'clconfirm-plain': return <ClConfirm open onClose={() => log('close')} onConfirm={() => log('confirm')} title="Remove Mira as a friend?" message="You'll stop seeing each other's status. You can add them again later." confirmLabel="Remove friend" />;
        case 'clconfirm-body': return <ClConfirm open onClose={() => log('close')} onConfirm={() => log('confirm')} title="Kick Okoye from the server?" message="They can rejoin with a new invite." confirmLabel="Kick" danger><div style={{ marginBottom: 14 }}><input placeholder="Reason (optional)" style={{ width: '100%', padding: 10, borderRadius: 10, background: '#0B0F1E', border: '1px solid #2A3558', color: '#F4F7FF' }} /></div></ClConfirm>;
        case 'confirmdialog': return <ConfirmDialog title="Discard changes" message="Your profile changes haven't been saved yet. Leave anyway and lose them?" confirmLabel="Discard changes" hint="Hold Shift to skip this next time." onConfirm={() => log('confirm')} onCancel={() => log('cancel')} />;
        case 'legacy': return <ClModal open onClose={() => log('close')} width={400} label="Legacy"><h4>Rename this thing</h4><p>An un-migrated ClModal keeps its own content; only the card chrome changes.</p><div className="mrow"><ClButton variant="ghost" size="sm" onClick={() => log('close')}>Cancel</ClButton><ClButton size="sm">Save</ClButton></div></ClModal>;
        default: return <div>unknown dialog {D}</div>;
    }
};

createRoot(document.getElementById('root')!).render(<ToastProvider><Backdrop /><Subject /></ToastProvider>);
