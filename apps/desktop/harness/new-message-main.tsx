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
import { StartDMModal } from '../src/components/StartDMModal';
import { EncryptedAvatar } from '../src/components/EncryptedAvatar';

/**
 * The REAL StartDMModal over a dimmed, app-like backdrop (server rail + DM list + chat).
 * The only fakes are the network (axios adapter), useAuth and the avatar decrypt (vite aliases).
 *
 * Query: ?friends=none     no accepted friends (empty state)
 *        &fail=1           GET /friends fails (error state)
 *        &openfail=1       POST /conversations/dm fails
 *
 * window.__calls records every POST, window.__started / window.__group the callbacks the host got.
 */
loadWebFonts();

const q = new URLSearchParams(location.search);
const NO_FRIENDS = q.get('friends') === 'none';
const FAIL = q.get('fail') === '1';
const OPEN_FAIL = q.get('openfail') === '1';

const NOW = Date.now();
const MIN = 60_000, HR = 60 * MIN, DAY = 24 * HR;

const FRIENDS = [
    { user_id: 'u-mira', username: 'Mira', discriminator: 4821, avatar_url: 'img-mira' },
    { user_id: 'u-jun', username: 'Jun', discriminator: 77, avatar_url: 'img-jun' },
    { user_id: 'u-tobias', username: 'tobias.k', discriminator: 1290, avatar_url: null },
    { user_id: 'u-sana', username: 'Sana', discriminator: 3105, avatar_url: 'img-sana' },
    { user_id: 'u-okoye', username: 'Okoye', discriminator: 9002, avatar_url: 'img-okoye' },
    { user_id: 'u-leif', username: 'leif', discriminator: 18, avatar_url: null },
    { user_id: 'u-priya', username: 'Priya', discriminator: 6630, avatar_url: null },
    { user_id: 'u-marco', username: 'Marco', discriminator: 2411, avatar_url: 'img-marco' },
    { user_id: 'u-elena', username: 'Elena', discriminator: 5507, avatar_url: 'img-elena' },
    { user_id: 'u-kenji', username: 'kenji_', discriminator: 8164, avatar_url: 'img-kenji' },
    { user_id: 'u-ana', username: 'Ana', discriminator: 3390, avatar_url: null },
    { user_id: 'u-theo', username: 'Theo', discriminator: 1024, avatar_url: null },
    { user_id: 'u-zara', username: 'Zara', discriminator: 7341, avatar_url: 'img-zara' },
    { user_id: 'u-nils', username: 'Nils', discriminator: 245, avatar_url: null },
];

const STATUSES: Record<string, any> = {
    'u-mira': { status: 'online', custom_status_text: 'deep focus, ping if urgent', custom_status_emoji: '🎧', current_game: null },
    'u-jun': { status: 'online', custom_status_text: null, custom_status_emoji: null, current_game: 'Valorant' },
    'u-tobias': { status: 'away', custom_status_text: null, custom_status_emoji: null, current_game: null },
    'u-sana': { status: 'dnd', custom_status_text: 'in a meeting until 4', custom_status_emoji: '📅', current_game: null },
    'u-okoye': { status: 'online', custom_status_text: null, custom_status_emoji: null, current_game: null, on_mobile: true },
    'u-marco': { status: 'online', custom_status_text: null, custom_status_emoji: null, current_game: null },
    'u-kenji': { status: 'away', custom_status_text: null, custom_status_emoji: null, current_game: null },
};

const CONVERSATIONS = [
    { conversation_id: 'c-mira', type: 'dm', other_user_id: 'u-mira', title: 'Mira', avatar_url: 'img-mira' },
    { conversation_id: 'c-tobias', type: 'dm', other_user_id: 'u-tobias', title: 'tobias.k' },
    { conversation_id: 'c-jun', type: 'dm', other_user_id: 'u-jun', title: 'Jun', avatar_url: 'img-jun' },
    { conversation_id: 'c-elena', type: 'dm', other_user_id: 'u-elena', title: 'Elena', avatar_url: 'img-elena' },
    { conversation_id: 'c-leif', type: 'dm', other_user_id: 'u-leif', title: 'leif' },
    { conversation_id: 'g-crew', type: 'group', title: 'Weekend Crew' },
];
const LAST_ACTIVITY: Record<string, number> = {
    'c-mira': NOW - 4 * MIN,
    'c-tobias': NOW - 2 * HR,
    'c-jun': NOW - 26 * HR,
    'c-elena': NOW - 5 * DAY,
    'c-leif': NOW - 23 * DAY,
};

(window as any).__calls = [] as string[];
axios.defaults.adapter = async (config: any) => {
    const url = String(config.url);
    if (/\/friends$/.test(url)) {
        await new Promise(r => setTimeout(r, 120));
        if (FAIL) throw Object.assign(new Error('Network Error'), { config });
        return { data: { accepted: NO_FRIENDS ? [] : FRIENDS }, status: 200, statusText: 'OK', headers: {}, config };
    }
    if (/\/conversations\/dm$/.test(url)) {
        (window as any).__calls.push('POST ' + url.replace(/^.*\/v1/, '') + ' ' + String(config.data));
        await new Promise(r => setTimeout(r, 300));
        if (OPEN_FAIL) throw Object.assign(new Error('Request failed with status code 500'), { config, response: { status: 500, data: { message: 'Internal server error' } } });
        const other = JSON.parse(config.data).other_user_id;
        const existing = CONVERSATIONS.find(c => c.other_user_id === other);
        return { data: { conversation_id: existing?.conversation_id ?? 'c-new-' + other }, status: 201, statusText: 'Created', headers: {}, config };
    }
    throw new Error('unexpected ' + url);
};

/* ── App-like backdrop (static) ─────────────────────────────────────────── */
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
                        <EncryptedAvatar attachmentId={(c as any).avatar_url ?? null} userId={c.other_user_id ?? null} isGroup={c.type === 'group'} token="t" className="w-full h-full" fallbackSize={16} disableClickProfile />
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
                    ['Dawson', 'yep — the picker redesign is next', 'img-me'],
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

const App = () => {
    const [open, setOpen] = useState(true);
    return (
        <>
            <Backdrop />
            {open && (
                <StartDMModal
                    onClose={() => setOpen(false)}
                    existingConversations={CONVERSATIONS}
                    onDMStarted={(chat) => { (window as any).__started = chat; setOpen(false); }}
                    friendStatuses={STATUSES}
                    presence={{}}
                    lastActivityAt={LAST_ACTIVITY}
                    onStartGroup={(users) => { (window as any).__group = users; setOpen(false); }}
                />
            )}
            {!open && (
                <button id="reopen" onClick={() => setOpen(true)} style={{ position: 'fixed', top: 8, right: 8 }}>reopen</button>
            )}
        </>
    );
};

createRoot(document.getElementById('root')!).render(<App />);
