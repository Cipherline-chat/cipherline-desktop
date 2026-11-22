/* eslint-disable -- harness, not shipped */
/**
 * Discord HISTORY import over a MOCK Discord, against an ISOLATED local API (real Postgres, Redis, MinIO; never the
 * shared dev stack, staging or prod). Everything Cipherline-side is REAL: the wizard, the history runner, the import
 * routes, the server's ordering/marks/caps, the bulk save, the post-import popup, then ChatPane + the Pins panel
 * reading the rows back through GET /channels/:cid/messages and the same ingest gates the app uses.
 *
 * Only two things are stand-ins, and both are outside what this feature changes:
 *   - Discord: the REAL main-process handlers (electron/discord-import) answer from canned REST fixtures in the page;
 *   - the sender-key engine (electron/e2ee-engine.ts, Node crypto in Electron main): a per-channel AES-GCM key held in
 *     the page. The API only ever sees ciphertext either way.
 *
 * Boot: #<base64 JSON from discord-history-setup.mjs>. ?theme=dark|light  ?view=wizard|chat
 */
import { createRoot } from 'react-dom/client';
import React from 'react';
import axios from 'axios';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/formatting.css';
import '../src/styles/theme-light-kit.css';
import '../src/styles/theme-light.css';
import * as engine from '../src/theme/engine';
import * as themes from '../src/theme/themes';
import ChatPane from '../src/components/ChatPane';
import { ToastProvider } from '../src/contexts/ToastContext';
import { useRetentionPolicy } from '../src/hooks/useRetentionPolicy';
import secureLocalStore from '../src/utils/secureLocalStore';
import { API_BASE } from '../src/constants';
import { CreateServerModal } from '../src/components/server/CreateServerModal';
import { takeSealedFranking } from '../src/utils/franking';
import { createDiscordImportHandlers } from '../electron/discord-import/ipc';
import { MOCK_GUILD_ID, mockChannels, mockGuild, mockGuildList, mockMe } from '../electron/discord-import/__fixtures__/mock-guild';
import { MOCK_TEXT_CHANNEL, mockChannelMessages, mockPins } from '../electron/discord-import/__fixtures__/mock-history';
import { ALL_PERMISSIONS, gateImportedFrom, importMarkOf } from '@cipherline/shared';

loadWebFonts();
const q = new URLSearchParams(location.search);
const themeParam = q.get('theme') ?? 'dark';
{
    const setPref = (engine as any).setThemePreference as undefined | ((p: string, host: object) => Promise<void>);
    if (setPref) void setPref(themeParam, {}); else engine.applyTheme(themes.resolveTheme(themeParam));
}
const log: any[] = ((window as any).__log = []);
const note = (...a: any[]) => { log.push(a); };

// ── Safety: the isolated local API or nothing ────────────────────────────
const cfg = JSON.parse(atob(decodeURIComponent(location.hash.slice(1))));
if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(API_BASE) || API_BASE !== cfg.api) {
    document.body.textContent = `REFUSING TO START: API_BASE is ${API_BASE}, expected the isolated local API ${cfg.api}`;
    throw new Error('wrong API target');
}
(window as any).__HARNESS = cfg;
(window as any).__apiBase = API_BASE;
const ME = cfg.importer;
axios.defaults.headers.common.Authorization = `Bearer ${ME.token}`;
const api = async (method: string, path: string, body?: unknown, who = ME) => {
    const r = await fetch(API_BASE + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${who.token}`, 'x-device-id': who.device_id }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j: any; try { j = JSON.parse(t); } catch { j = t; }
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 200)}`);
    return j;
};

// ── Mock Discord (the real main-process handlers, canned REST) ───────────
async function makePng(w: number, h: number, hue: number, label = ''): Promise<Uint8Array> {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, `hsl(${hue} 80% 58%)`); grad.addColorStop(1, `hsl(${(hue + 70) % 360} 70% 38%)`);
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    if (label) { g.fillStyle = 'rgba(255,255,255,.9)'; g.font = `bold ${Math.round(h / 5)}px sans-serif`; g.textAlign = 'center'; g.fillText(label, w / 2, h / 2 + h / 14); }
    const blob: Blob = await new Promise(r => c.toBlob(b => r(b!), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
}
const AV_ALEX = await makePng(128, 128, 200);
const AV_RILEY = await makePng(128, 128, 320);
const PUMPKINS = await makePng(480, 300, 25, 'pumpkins.png');
const NOW = Date.now();
// Two applications the owner has (fake tokens, credentials for nothing). ?preseed=other puts his OTHER bot in the
// server first: the exact state of the owner's report. ?intents=off turns both privileged intents off on the importer.
const BOTH_INTENTS = (1 << 15) | (1 << 19);
const APPS = [
    { appId: '800000000000000900', botId: '800000000000000900', name: 'Cipherline Importer', token: ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GabcDE', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.'), flags: q.get('intents') === 'off' ? 0 : BOTH_INTENTS },
    { appId: '700000000000000111', botId: '700000000000000111', name: 'My Music Bot', token: ['NzAwMDAwMDAwMDAwMDAwMTEx', 'Gother', 'otherotherotherotherotherother12'].join('.'), flags: 0 },
];
const appByAuth = (auth: string) => APPS.find(a => auth === `Bot ${a.token}`);
/** bot id -> permissions it was invited with. */
const inGuild = new Map<string, string>(
    q.get('preseed') === 'other' ? [['700000000000000111', '8']] : q.get('preseed') === 'importer' ? [['800000000000000900', '8']] : [],
);
/** What Discord does when the owner authorises an invite link: adds THAT client_id's bot, ~1 s later. */
function authorize(link: string) {
    const u = new URL(link);
    if (u.origin !== 'https://discord.com' || u.pathname !== '/oauth2/authorize') return;
    const a = APPS.find(x => x.appId === u.searchParams.get('client_id'));
    note('authorize', u.searchParams.get('client_id'), u.searchParams.get('permissions'), a ? 'ok' : 'unknown-app');
    if (a) setTimeout(() => inGuild.set(a.botId, u.searchParams.get('permissions') ?? '0'), 1000);
}
(window as any).__clipboard = [] as string[];
if (q.get('clip') === 'fail') {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    (document as any).execCommand = () => false;
}
const fakeFetch = async (url: string, init: any) => {
    note('discord', url.replace('https://discord.com/api/v10', '').replace(/https:\/\/cdn\.discordapp\.com/, 'cdn:').split('?')[0], init.headers.Authorization ? 'auth' : 'noauth');
    const json = (status: number, body: unknown) => ({ status, headers: { get: () => null }, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
    const bytes = (b: Uint8Array) => ({ status: 200, headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'image/png' : null) }, json: async () => ({}), arrayBuffer: async () => b.buffer.slice(0) as ArrayBuffer });
    if (url.startsWith('https://cdn.discordapp.com')) {
        if (url.includes('/avatars/')) return bytes(url.includes('900000000000000003') ? AV_RILEY : AV_ALEX);
        return bytes(PUMPKINS);
    }
    const path = url.replace('https://discord.com/api/v10', '');
    // Applications, tokens and membership are modelled (wizard v2): the list depends on WHICH bot the token is.
    const app = appByAuth(init.headers.Authorization ?? '');
    if (!app) return json(401, { code: 0, message: '401: Unauthorized' });
    if (path === '/users/@me') return json(200, { ...mockMe(), id: app.botId, username: app.name });
    if (path === '/oauth2/applications/@me') return json(200, { id: app.appId, name: app.name, flags: app.flags, bot_public: true });
    if (path.startsWith('/users/@me/guilds')) {
        if (q.get('discord') === 'down') return json(503, { message: 'upstream' });
        return json(200, inGuild.has(app.botId) ? [{ ...mockGuildList()[0], owner: false, permissions: inGuild.get(app.botId) }] : []);
    }
    if (path.startsWith('/guilds/') && !inGuild.has(app.botId)) return json(403, { code: 50001, message: 'Missing Access' });
    if (path === `/guilds/${MOCK_GUILD_ID}`) return json(200, mockGuild());
    if (path === `/guilds/${MOCK_GUILD_ID}/channels`) return json(200, mockChannels());
    if (path.startsWith(`/channels/${MOCK_TEXT_CHANNEL}/messages/pins`)) return json(200, mockPins(NOW));
    if (path.startsWith(`/channels/${MOCK_TEXT_CHANNEL}/messages`)) return json(200, path.includes('before=') ? [] : mockChannelMessages(NOW));
    if (/\/channels\/\d+\/messages\/pins/.test(path)) return json(200, { items: [], has_more: false });
    if (/\/channels\/\d+\/messages/.test(path)) return json(200, []);
    return json(404, { code: 10004 });
};
(globalThis as any).Buffer = { from: (u8: Uint8Array) => ({ toString: () => { let s = ''; u8.forEach(b => { s += String.fromCharCode(b); }); return btoa(s); } }) };
const mem = new Map<string, string>();
const store = { status: () => 'ok', get: (k: string) => mem.get(k) ?? null, set: (k: string, v: string) => { mem.set(k, v); }, delete: (k: string) => { mem.delete(k); } };
const handlers = createDiscordImportHandlers({ store, clientOptions: { fetchFn: fakeFetch as any, sleep: async () => undefined } });

// ── Stand-in sender-key engine: one AES-GCM key per channel, in this page ──
const keys = new Map<string, CryptoKey>();
const b64 = (u: Uint8Array) => { let s = ''; u.forEach(b => { s += String.fromCharCode(b); }); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function keyFor(cid: string) {
    let k = keys.get(cid);
    if (!k) { k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']); keys.set(cid, k); }
    return k;
}
async function seal(json: string, cid: string) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(cid), new TextEncoder().encode(json)));
    return { epoch: 1, nonce_b64: b64(iv), ciphertext_b64: b64(ct), signature_b64: b64(crypto.getRandomValues(new Uint8Array(64))) };
}
async function open(row: any, cid: string) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(row.nonce_b64) }, await keyFor(cid), unb64(row.ciphertext_b64));
    return new TextDecoder().decode(pt);
}
(window as any).electronAPI = {
    platform: 'linux',
    openExternal: async (u: string) => { note('open-external', u); authorize(u); },
    // Stands in for main's clipboard module (the app's tier-1 copy path).
    writeClipboard: async (t: string) => { if (q.get('clip') === 'fail') throw new Error('refused'); (window as any).__clipboard.push(t); },
    encryptChannelMessage: (json: string, cid: string) => seal(json, cid),
    discordImport: {
        status: () => handlers.status(), connect: (token: string) => handlers.connect({ token }), forget: () => handlers.forget(),
        checkApp: () => handlers.checkApp(),
        listGuilds: () => handlers.listGuilds(), snapshot: (guildId: string) => handlers.snapshot({ guildId }),
        image: (req: any) => handlers.image(req), cancel: () => handlers.cancel(),
        history: (req: any) => handlers.history(req), media: (req: any) => handlers.media(req),
    },
};

// ── After the run: a member called "sam" joins, then FORGES a normal message claiming an imported author ──
let refs: Record<string, string> = {};
let serverId = '';
async function afterImport() {
    const cid = refs['c:1'];
    const inv = await api('POST', `/servers/${serverId}/invites`, {});
    await api('POST', `/invites/${inv.code ?? inv.invite?.code}/accept`, {}, cfg.sam);
    // #rules is read-only for @everyone (copied from Discord): let sam post there, so the forged message sits
    // right next to the imported history it pretends to belong to.
    await api('PATCH', `/servers/${serverId}/channels/${cid}/overrides`, { target_kind: 'member', target_id: cfg.sam.user_id, allow_bits: String(1n << 17n), deny_bits: '0' });
    const rows: any[] = await api('GET', `/channels/${cid}/messages?limit=100`);
    const imported = rows.find(r => r.import_author_id);
    const forged = { client_msg_id: crypto.randomUUID(), type: 'text', text: 'Totally me, Alex. Trust this message.',
        imported_from: { v: 1, source: 'discord', author_ref: imported?.import_author_id, kind: 'user', name: 'Alex', username: 'alex_92', original_ts: new Date(NOW - 86400000).toISOString() } };
    const sealed = await seal(JSON.stringify(forged), cid);
    await api('POST', `/channels/${cid}/messages`, { sender_device_id: cfg.sam.device_id, ...sealed }, cfg.sam);
    note('forged-posted');
}

async function loadChannel(cid: string) {
    const raw: any[] = await api('GET', `/channels/${cid}/messages?limit=100`);
    const out: any[] = [];
    for (const r of raw) {
        if (r.kind === 'system' || r.deleted) continue;
        let content: any;
        try { content = takeSealedFranking(JSON.parse(await open(r, cid))).content; } catch { continue; }
        const mark = importMarkOf(r);
        out.push({ id: r.id, content: gateImportedFrom(content, mark), sender_user_id: r.sender_user_id, sender_device_id: r.sender_device_id,
            timestamp: r.created_at, conversation_id: cid, ...(mark ? { import_mark: mark } : {}) });
    }
    out.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
    const pins: any[] = await api('GET', `/channels/${cid}/pins`);
    const saves: any[] = await api('GET', `/channels/${cid}/saves`);
    (window as any).__chat = { rows: raw.length, marked: raw.filter(r => r.import_id).length, messages: out.length, pins: pins.length };
    return { messages: out, pinned: pins.map(p => p.message_id), saved: saves.map(s => s.message_id) };
}

const Chat: React.FC<{ cid: string; data: Awaited<ReturnType<typeof loadChannel>>; pinsOpen: boolean }> = ({ cid, data, pinsOpen }) => {
    const retention = useRetentionPolicy(ME.user_id);
    const names = { [ME.user_id]: ME.name, [cfg.sam.user_id]: 'sam' };
    const channel = { channel_id: cid, name: 'rules', topic: 'Be kind', server_id: serverId, my_permissions: ALL_PERMISSIONS.toString() };
    return (
        <div id="dash" style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', background: 'var(--cl-abyss)', color: 'var(--cl-text)' }}>
            <nav style={{ width: 72, flex: 'none' }} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', padding: '6px 10px 10px 2px', gap: 10 }}>
                <main id="chat" style={{ flex: 1, minWidth: 0, position: 'relative', background: 'var(--cl-abyss)', borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                    <ChatPane
                        bundleReady activeChat={{ id: cid }} activeChannel={channel} emojisChangedEvent={null}
                        serverChannels={[{ channel_id: cid, name: 'rules', server_id: serverId, kind: 'text' } as any]} serverCategories={[]} onNavigateToChannel={() => {}}
                        messages={data.messages} messagesFetching={false} onMessageSent={() => {}} onChannelMessageSent={() => {}} onPatchSentMessage={() => {}}
                        typingUsers={new Set()} sendTypingEvent={() => {}} readReceipts={{}} sendReadReceipt={() => {}} showReadReceipts
                        activeCall={null} onCallChange={() => {}} friendStatuses={{}} retention={retention}
                        serverSavedIds={data.saved} pinnedMsgIds={data.pinned} onPinMessage={() => {}} onUnpinMessage={() => {}}
                        onServerSaveMessage={() => {}} onServerUnsaveMessage={() => {}}
                        pinnedSidebarExpanded={pinsOpen} onTogglePinnedSidebar={() => {}} channelSearchOpen={false} onOpenPinnedCallOverlay={() => {}}
                        pinnedSearchQuery="" onOpenProfile={(id: string) => note('open-profile', id)} avatarUpdatedEvent={null} memberRoleColors={{}} serverMemberNicknames={names}
                        convType="server" servers={[{ id: serverId, server_id: serverId, name: 'Pixel Farm Co-op', owner_id: ME.user_id } as any]} onInviteJoin={() => {}} onInviteCodeClick={() => {}}
                        channelPermissions={ALL_PERMISSIONS} channelKeyMissing={false} channelKeyCoolingOff={false}
                        historyGaps={[]} historyStart onFillHistoryGap={async () => ({ shown: 0, progressed: false })}
                        myUserId={ME.user_id} onReport={(...a: any[]) => note('report', a[0])}
                    />
                </main>
                {pinsOpen && <aside id="pinned-panel-root" style={{ width: 340, flex: 'none', background: 'var(--cl-deep)', borderRadius: 16, overflow: 'hidden' }} />}
            </div>
        </div>
    );
};

const Wizard: React.FC<{ onOpened: () => void }> = ({ onOpened }) => (
    <div style={{ height: '100vh', background: 'var(--cl-deep)' }}>
        <CreateServerModal
            token={ME.token}
            initialMode="discord-guild"
            onClose={() => note('close')}
            onCreateServer={async () => {}}
            onPreviewGuild={async (guild) => (await axios.post(`${API_BASE}/server-templates/discord/preview-guild`, { guild })).data}
            onImportGuild={async (req) => {
                const srv = (await axios.post(`${API_BASE}/server-templates/discord/import-guild`, req)).data;
                refs = srv.channel_refs ?? {}; serverId = srv.server_id;
                note('import-guild', srv.server_id, Object.keys(refs).length);
                return { server_id: srv.server_id, name: srv.name, channel_refs: refs };
            }}
            historyDeps={{
                userId: ME.user_id, deviceId: ME.device_id, maxFileBytes: 100 * 1024 * 1024,
                prepareChannelKeys: async (_sid, cids) => {
                    for (const cid of cids) { await keyFor(cid); await api('POST', `/channels/${cid}/epoch`, { epoch: 1, rotation_reason: 'create' }); }
                    note('keys', cids.length);
                },
            }}
            onOpenImportedServer={async () => { note('open-server'); onOpened(); }}
        />
    </div>
);

const App: React.FC = () => {
    const [view, setView] = React.useState<'wizard' | 'chat'>('wizard');
    const [data, setData] = React.useState<Awaited<ReturnType<typeof loadChannel>> | null>(null);
    const [pinsOpen, setPinsOpen] = React.useState(false);
    (window as any).__showChat = async (opts: { pins?: boolean } = {}) => {
        if (!(window as any).__forged) { await afterImport(); (window as any).__forged = true; }
        setData(await loadChannel(refs['c:1'])); setPinsOpen(!!opts.pins); setView('chat');
    };
    (window as any).__state = () => ({ serverId, refs });
    return view === 'chat' && data ? <Chat cid={refs['c:1']} data={data} pinsOpen={pinsOpen} /> : <Wizard onOpened={() => { (window as any).__opened = true; }} />;
};

(async () => {
    try { await secureLocalStore.hydrate(); } catch { /* a cold store is fine for a harness */ }
    secureLocalStore.setItem('cipherline_user_id', ME.user_id);
    try { await secureLocalStore.whenAccountReady(); } catch { /* */ }
    createRoot(document.getElementById('root')!).render(<ToastProvider><App /></ToastProvider>);
    (window as any).__booted = true;
})();
