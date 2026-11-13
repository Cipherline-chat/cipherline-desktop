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
import { CreateServerModal } from '../src/components/server/CreateServerModal';
import { JoinServerModal, InvitePreviewModal } from '../src/components/server/JoinServerModal';
import { ServerInviteModal } from '../src/components/server/ServerInviteModal';
import PREVIEW from '../src/utils/__fixtures__/discordTemplatePreview.BX8.json';

/**
 * Create a Server / Discord import / Join a Server / invite preview / Invite People, the REAL components over a
 * dimmed app-like backdrop (network, auth, toasts, avatars stubbed).
 *   d = create | import | join | preview | invite      s = state (see each scene)      long=1  long names
 * window.__log records every callback the host received. Works against both the old and the migrated markup.
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const name = q.get('d') ?? 'create';
const state = q.get('s') ?? '';
const LONG = q.get('long') === '1';
const log: any[] = ((window as any).__log = (window as any).__log ?? []);
const note = (...a: any[]) => { log.push(a); };
(window as any).electronAPI = { platform: 'windows', writeClipboard: async (t: string) => { note('clipboard', t); } };

const never = <T,>() => new Promise<T>(() => {});
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const rejection = (status: number, message?: string) =>
    Object.assign(new Error('Request failed with status code ' + status), { isAxiosError: true, response: { status, data: message ? { message } : {}, headers: {} } });

const LONG_NAME = 'The Absolutely Magnificent Westmarch Adventurers Guild';
const LONG_DESC = 'A friendly community for tabletop roleplayers across every timezone. We run weekly one-shots, long campaigns, and a monthly open table for newcomers who have never rolled a die. Everyone is welcome, snacks are encouraged.';
const preview = (): any => ({
    server_id: 's-1', server_name: LONG ? LONG_NAME : 'Game night', server_description: LONG ? LONG_DESC : 'Weekly board games, co-op nights and the occasional campaign.',
    server_icon: 'img-elena', server_icon_key_b64: 'k', server_icon_nonce_b64: 'n', member_count: LONG ? 12840 : 27, expires_at: null,
});

axios.defaults.adapter = async (config: any) => {
    const url = String(config.url).replace(/^.*\/v1/, '');
    const ok = (data: any) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
    await wait(40);
    note('http', config.method, url);
    if (/\/invites\/[^/]+\/preview$/.test(url)) {
        if (state === 'loading') return never();
        if (state === 'invalid') throw Object.assign(rejection(404), { config });
        if (state === 'error') throw Object.assign(rejection(500), { config, response: { status: 500, data: {}, headers: { 'retry-after': '0.05' } } });
        return ok(preview());
    }
    if (/\/invites\/[^/]+\/accept$/.test(url)) {
        if (state === 'joining') return never();
        if (state === 'join-error') throw Object.assign(rejection(403, 'This invite has expired or reached its usage limit'), { config });
        return ok({});
    }
    if (/\/servers\/[^/]+\/members$/.test(url)) return ok(state === 'member' ? [{ user_id: 'u-jun' }, { user_id: 'u-okoye' }] : []);
    if (/\/servers\/[^/]+\/roles$/.test(url)) return ok([]);
    if (/\/servers\/[^/]+\/invites\/[^/]+$/.test(url) && config.method === 'delete') return ok({ ok: true });
    if (/\/servers\/[^/]+\/invites$/.test(url)) {
        if (config.method === 'get') {
            if (state === 'loading') return never();
            if (state === 'error') throw Object.assign(rejection(403), { config });
            return ok([{ code: 'AbCd1234', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 7 * 864e5).toISOString(), max_uses: null, uses: 3 }]);
        }
        if (state === 'error') throw Object.assign(rejection(500, 'Could not create an invite link.'), { config });
        if (state === 'updating') return never();   // the regenerate POST never lands: freeze on "Updating link…"
        return ok({ code: 'ZyXw9876', created_at: new Date().toISOString(), expires_at: null, max_uses: 10, uses: 0 });
    }
    return ok({});
};

const Backdrop = () => (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'Nunito, sans-serif', color: '#F4F7FF' }}>
        <div style={{ width: 72, background: '#070A15', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, paddingTop: 14 }}>
            {['#25E0C8', '#243056', '#243056', '#243056', '#1C2542'].map((c, i) => (
                <div key={i} style={{ width: 46, height: 46, borderRadius: i === 0 ? 16 : 23, background: c }} />
            ))}
        </div>
        <div style={{ width: 268, background: '#0F1528', borderRight: '1px solid #1E2848', padding: '16px 14px' }}>
            <div style={{ height: 36, borderRadius: 10, background: '#1C2542', marginBottom: 18 }} />
            {['general', 'announcements', 'game-night', 'off-topic'].map(n => (
                <div key={n} style={{ padding: '7px 10px', fontWeight: 700, fontSize: 14, color: '#A7B3D4' }}># {n}</div>
            ))}
        </div>
        <div style={{ flex: 1, background: '#0B0F1E' }}>
            <div style={{ height: 56, borderBottom: '1px solid #1E2848', display: 'flex', alignItems: 'center', padding: '0 20px', fontFamily: 'Fredoka, sans-serif', fontWeight: 600, fontSize: 16 }}># general</div>
            <div style={{ padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
                {['did you get the build working on the test PC?', 'yep, the picker redesign is next', 'nice. send me the screenshots'].map((t, i) => (
                    <div key={i} style={{ display: 'flex', gap: 12 }}>
                        <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#243056', flex: 'none' }} />
                        <div style={{ color: '#A7B3D4', fontSize: 14 }}>{t}</div>
                    </div>
                ))}
            </div>
        </div>
    </div>
);

const SERVER: any = {
    server_id: 's-1', name: LONG ? LONG_NAME : 'Game night', description: null, icon_attachment: null, icon_key_b64: null, icon_nonce_b64: null,
    banner_attachment: null, banner_key_b64: null, banner_nonce_b64: null, owner_user_id: 'me', created_at: new Date().toISOString(),
};

const onClose = () => note('close');

/* Invite People's friend list: a mix of "just added" and "chatted recently" friends (no-op for the old markup, which ignores these props). */
const NOWMS = Date.now();
const H = 3_600_000;
const iso = (agoMs: number) => new Date(NOWMS - agoMs).toISOString();
const mkFriend = (id: string, username: string, discriminator: number, avatar: string | null, sinceAgo: number) =>
    ({ user_id: id, username, discriminator, avatar_url: avatar, friends_since: iso(sinceAgo) });
const FRIEND_PROPS = {
    friends: [
        mkFriend('u-mira', 'Mira', 4821, 'img-mira', 2 * 24 * H),
        mkFriend('u-jun', 'Jun', 77, 'img-jun', 0.4 * H),
        mkFriend('u-sana', LONG ? 'Sana the Extraordinarily Long-Named Cartographer' : 'Sana', 1203, 'img-sana', 200 * 24 * H),
        mkFriend('u-okoye', 'Okoye', 9, 'img-okoye', 90 * 24 * H),
        mkFriend('u-elena', 'Elena', 3310, 'img-elena', 150 * 24 * H),
        mkFriend('u-kenji', 'Kenji', 150, 'img-kenji', 300 * 24 * H),
        mkFriend('u-zara', 'Zara', 8842, null, 400 * 24 * H),
    ],
    conversations: [
        { conversation_id: 'c-mira', type: 'dm', other_user_id: 'u-mira' },
        { conversation_id: 'c-sana', type: 'dm', other_user_id: 'u-sana' },
        { conversation_id: 'c-okoye', type: 'dm', other_user_id: 'u-okoye' },
    ],
    lastActivityAt: { 'c-mira': NOWMS - 6 * 60_000, 'c-sana': NOWMS - 3 * H, 'c-okoye': NOWMS - 26 * H } as Record<string, number>,
    blockedIds: new Set<string>(),
    myUserId: 'u-me',
    onSendInvite: async (userId: string, code: string) => {
        note('send', userId, code);
        await wait(state === 'sending' ? 60_000 : 500);
        return state !== 'send-error';
    },
};
const SCENES: Record<string, () => React.ReactElement> = {
    create: () => <CreateServerModal
        token="t" onClose={onClose}
        onCreateServer={async (n) => {
            note('create', n);
            if (state === 'loading') return never();
            if (state === 'api-error') throw rejection(409, 'You own too many servers');
        }}
        onPreviewTemplate={async (link) => { note('preview', link); await wait(80); return PREVIEW as any; }}
        onImportTemplate={async (req) => { note('import', req); }}
    />,
    import: () => <CreateServerModal
        token="t" onClose={onClose} initialMode="discord"
        onCreateServer={async () => {}}
        onPreviewTemplate={async (link) => {
            note('preview', link);
            if (state === 'loading') return never();
            if (state === 'preview-error') throw { response: { status: 404, data: { code: 'TEMPLATE_NOT_FOUND' } } };
            const p: any = JSON.parse(JSON.stringify(PREVIEW));
            if (LONG) p.blueprint.server.name = LONG_NAME.slice(0, 50);
            if (LONG) p.template.name = 'The Absolutely Magnificent Westmarch Adventurers Guild Starter Template';
            return p;
        }}
        onImportTemplate={async (req) => {
            note('import', req);
            if (state === 'creating') return never();
            if (state === 'import-error') throw { response: { status: 429, data: {} } };
        }}
    />,
    join: () => <JoinServerModal onClose={onClose} onJoinServer={async (code) => {
        note('join', code);
        if (state === 'loading') return never();
        if (state === 'error') throw rejection(400, 'This invite has expired or reached its usage limit');
    }} />,
    preview: () => <InvitePreviewModal code="AbCd1234" token="t" servers={state === 'joined' ? [SERVER] : []} arrival={q.get('arrival') === '1'}
        onJoin={(id, n) => note('joined', id, n)} onClose={onClose} />,
    invite: () => <ServerInviteModal server={SERVER} token="t" onClose={onClose} {...(q.get('f') === '0' ? {} : FRIEND_PROPS)} />,
};

const App = () => {
    const [mounted, setMounted] = useState(true);
    const scene = SCENES[name];
    if (!scene) throw new Error(`unknown scene "${name}"`);
    (window as any).__remount = () => setMounted(false);
    React.useEffect(() => { if (!mounted) setMounted(true); }, [mounted]);
    return <><Backdrop />{mounted && scene()}</>;
};

createRoot(document.getElementById('root')!).render(<App />);
