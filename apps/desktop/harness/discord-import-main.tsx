/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/theme-light-kit.css';
import '../src/styles/theme-light.css';
import '../src/styles/theme-midnight.css';
import '../src/styles/theme-contrast.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import * as engine from '../src/theme/engine';
import * as themes from '../src/theme/themes';
import React from 'react';
import axios from 'axios';
import { CreateServerModal } from '../src/components/server/CreateServerModal';
import { createDiscordImportHandlers } from '../electron/discord-import/ipc';
import { MOCK_GUILD_ID, mockApp, mockChannels, mockGuild, mockGuildList, mockMe } from '../electron/discord-import/__fixtures__/mock-guild';
// The REAL Cipherline API mapper, so the preview is exactly what the API would answer.
import { parseDiscordTemplate } from '../../api/src/servers/discord-template/discord-template.parse';
import { templateToBlueprint } from '../../api/src/servers/discord-template/discord-template.mapper';

/**
 * Create a Server -> "Import from a Discord server" over a MOCK Discord.
 *   ?theme=dark|light      ?run=hang  (the server create never returns: freezes the progress step)
 *   ?token=bad             (Discord answers 401 to every token)
 * The main-process handlers (electron/discord-import) run for real in the page against canned REST answers;
 * only `fetch` and the SecureStore are fake. window.__log records the calls the host received.
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const themeParam = q.get('theme') ?? 'dark';
{
    const setPref = (engine as any).setThemePreference as undefined | ((p: string, host: object) => Promise<void>);
    if (setPref) void setPref(themeParam, {});
    else engine.applyTheme(themes.resolveTheme(themeParam));
}
const log: any[] = ((window as any).__log = []);
const note = (...a: any[]) => { log.push(a); };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// `Buffer` exists in Electron main, not in a page: the image handler only needs base64 of bytes.
(globalThis as any).Buffer = { from: (u8: Uint8Array) => ({ toString: () => { let s = ''; u8.forEach(b => { s += String.fromCharCode(b); }); return btoa(s); } }) };

async function makePng(w: number, h: number, hue: number): Promise<Uint8Array> {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, `hsl(${hue} 80% 55%)`); grad.addColorStop(1, `hsl(${(hue + 80) % 360} 70% 40%)`);
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    const blob: Blob = await new Promise(r => c.toBlob(b => r(b!), 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
}
const ICON = await makePng(512, 512, 170);
const BANNER = await makePng(1024, 576, 260);
const EMOJI = await makePng(128, 128, 30);

const fakeFetch = async (url: string, init: any) => {
    const auth: string = init.headers.Authorization ?? '';
    note('discord', url.replace('https://discord.com/api/v10', '').replace('https://cdn.discordapp.com', 'cdn:'), auth ? 'auth' : 'noauth');
    await wait(60);
    const json = (status: number, body: unknown) => ({ status, headers: { get: () => null }, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
    if (url.startsWith('https://cdn.discordapp.com')) {
        const bytes = url.includes('/icons/') ? ICON : url.includes('/banners/') ? BANNER : EMOJI;
        return { status: 200, headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'image/png' : null) }, json: async () => ({}), arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer };
    }
    const path = url.replace('https://discord.com/api/v10', '');
    if (q.get('token') === 'bad' || /INVALID/.test(auth)) return json(401, { code: 0, message: '401: Unauthorized' });
    if (path === '/users/@me') return json(200, mockMe());
    if (path === '/oauth2/applications/@me') return json(200, mockApp());
    if (path.startsWith('/users/@me/guilds')) return json(200, q.get('guilds') === 'none' ? [] : mockGuildList());
    if (path === `/guilds/${MOCK_GUILD_ID}`) return json(200, mockGuild());
    if (path === `/guilds/${MOCK_GUILD_ID}/channels`) return json(200, mockChannels());
    return json(404, { code: 10004 });
};

const mem = new Map<string, string>();
const store = { status: () => 'ok', get: (k: string) => mem.get(k) ?? null, set: (k: string, v: string) => { mem.set(k, v); }, delete: (k: string) => { mem.delete(k); } };
const handlers = createDiscordImportHandlers({ store, clientOptions: { fetchFn: fakeFetch as any, sleep: async () => undefined } });
(window as any).electronAPI = {
    platform: 'windows',
    openExternal: async (u: string) => { note('open-external', u); },
    discordImport: {
        status: () => handlers.status(),
        connect: (token: string) => handlers.connect({ token }),
        checkApp: () => handlers.checkApp(),
        forget: () => handlers.forget(),
        listGuilds: () => handlers.listGuilds(),
        snapshot: (guildId: string) => handlers.snapshot({ guildId }),
        image: (req: any) => handlers.image(req),
        cancel: () => handlers.cancel(),
    },
};

const emojis: Array<{ name: string }> = [];
axios.defaults.adapter = async (config: any) => {
    const url = String(config.url).replace(/^.*\/v1/, '');
    await wait(80);
    note('http', config.method, url);
    const ok = (data: any) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
    if (/\/servers\/[^/]+\/emojis$/.test(url)) {
        if (config.method === 'post') { emojis.push({ name: JSON.parse(config.data).name }); return ok({}); }
        return ok(emojis);
    }
    return ok({});
};

const previewGuild = async (guild: Record<string, unknown>) => {
    note('preview-guild');
    await wait(120);
    const t = parseDiscordTemplate({ code: 'guild', name: guild.name, description: guild.description, serialized_source_guild: guild }, 'guild');
    return { template: { name: t.templateName, description: t.templateDescription }, blueprint: JSON.parse(JSON.stringify(templateToBlueprint(t))) } as any;
};

const Backdrop = () => (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'Nunito, sans-serif', color: 'var(--cl-text)', background: 'var(--cl-deep)' }}>
        <div style={{ width: 72, background: 'var(--cl-sink)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, paddingTop: 14 }}>
            {[0, 1, 2, 3].map(i => <div key={i} style={{ width: 46, height: 46, borderRadius: i === 0 ? 16 : 23, background: 'var(--cl-surface)' }} />)}
        </div>
        <div style={{ width: 268, borderRight: '1px solid var(--cl-border)', padding: '16px 14px' }}>
            {['general', 'announcements', 'off-topic'].map(n => <div key={n} style={{ padding: '7px 10px', fontWeight: 700, fontSize: 14, color: 'var(--cl-muted)' }}># {n}</div>)}
        </div>
        <div style={{ flex: 1 }} />
    </div>
);

createRoot(document.getElementById('root')!).render(
    <>
        <Backdrop />
        <CreateServerModal
            token="harness"
            initialMode={q.get('entry') === '1' ? 'scratch' : 'discord-guild'}
            onClose={() => note('close')}
            onCreateServer={async () => {}}
            onPreviewGuild={previewGuild}
            onImportGuild={async (req) => {
                note('import-guild', Object.keys(req).join(','));
                if (q.get('run') === 'hang') return new Promise(() => {});
                await wait(900);
                return { server_id: 'srv-1', name: req.name };
            }}
            onOpenImportedServer={async (id, n) => { note('open-server', id, n); }}
        />
    </>,
);
