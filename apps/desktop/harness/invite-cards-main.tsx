/* eslint-disable -- visual harness, not shipped */
// Invite cards harness: the REAL ChatPane feed (server channel or DM) holding
// server-invite messages, with the invite preview endpoint faked per code.
//   ?scene=sender   your own invite-only messages next to someone else's (default)
//   ?scene=states   one card per state: valid, loading, couldn't load, expired
//   ?scene=long     80 invite cards, a 60-a-minute server budget (429 past it)
//   ?view=dm        the same in a DM instead of a server channel
// Preview codes: okOther (200, not a member), okGuild (200, your own server S1 →
// "already in"), gone404, exp400, boom500, rate429 (always 429), slow (never answers).
// window.__previewCalls counts preview requests by code; window.__send(text)
// types into the real composer and presses Enter (the real send path).
import { createRoot } from 'react-dom/client';
import React from 'react';
import axios from 'axios';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/settings-descent.css';
import '../src/styles/layout-drift.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import { secureLocalStore } from '../src/utils/secureLocalStore';

loadWebFonts();
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'sender';
const view = q.get('view') ?? 'server';

const calls: Record<string, number> = {};
(window as any).__previewCalls = calls;
// ?scene=long: 50 of the 60 already spent (earlier browsing), so scrolling hits the limit.
const budget: number[] = scene === 'long' ? Array.from({ length: 50 }, () => Date.now()) : [];
const BUDGET = 60;

const reply = (config: any, data: any, status = 200, headers: Record<string, string> = {}) => {
    if (status >= 400) {
        const err: any = new Error(`Request failed with status code ${status}`);
        err.response = { data, status, statusText: String(status), headers, config };
        err.config = config;
        err.isAxiosError = true;
        return Promise.reject(err);
    }
    return Promise.resolve({ data, status, statusText: 'OK', headers, config });
};

const PREVIEWS: Record<string, any> = {
    okOther: { server_id: 'S9', server_name: 'Pixel Garden', server_description: 'Pixel art, palettes and weekly prompts.', server_icon: null, server_icon_key_b64: null, server_icon_nonce_b64: null, member_count: 214, expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString(), uses: 3, max_uses: 25 },
    okGuild: { server_id: 'S1', server_name: 'Neon Guild', server_description: 'Raids, patch notes and general chatter.', server_icon: null, server_icon_key_b64: null, server_icon_nonce_b64: null, member_count: 38, expires_at: null, uses: 0, max_uses: null },
};
const longPreview = (code: string) => ({ server_id: `SX-${code}`, server_name: `Server ${code.slice(1)}`, server_description: null, server_icon: null, server_icon_key_b64: null, server_icon_nonce_b64: null, member_count: 10 + Number(code.slice(1)), expires_at: null, uses: 0, max_uses: null });

axios.defaults.adapter = async (config: any) => {
    const url = String(config.url).replace(/^.*\/v1/, '');
    const pv = url.match(/^\/invites\/([^/]+)\/preview/);
    if (pv) {
        const code = decodeURIComponent(pv[1]);
        calls[code] = (calls[code] ?? 0) + 1;
        if (scene === 'long') {
            // The server's per-user bucket: 60 a minute, then 429 + Retry-After.
            const now = Date.now();
            while (budget.length && now - budget[0] > 60_000) budget.shift();
            if (budget.length >= BUDGET) {
                const wait = Math.max(1, Math.ceil((60_000 - (now - budget[0])) / 1000));
                return reply(config, { statusCode: 429, message: 'ThrottlerException: Too Many Requests' }, 429, { 'retry-after': String(wait) });
            }
            budget.push(now);
            return reply(config, longPreview(code));
        }
        await new Promise(r => setTimeout(r, 120));
        if (code === 'slow') return new Promise(() => {});
        if (code === 'gone404') return reply(config, { message: 'Invite not found' }, 404);
        if (code === 'exp400') return reply(config, { message: 'Invite expired' }, 400);
        if (code === 'boom500') return reply(config, { message: 'Internal server error' }, 500);
        if (code === 'rate429') return reply(config, { message: 'ThrottlerException: Too Many Requests' }, 429, { 'retry-after': '30' });
        if (PREVIEWS[code]) return reply(config, PREVIEWS[code]);
        return reply(config, { message: 'Invite not found' }, 404);
    }
    if (/^\/channels\/[^/]+\/messages$/.test(url) && config.method === 'post') {
        return reply(config, { id: `srv-${crypto.randomUUID()}`, sender_user_id: 'u-me', created_at: new Date().toISOString() });
    }
    if (url.startsWith('/messages/send')) return reply(config, { received_at_server: new Date().toISOString() });
    if (url.startsWith('/billing/status')) return reply(config, { subscription_status: 'active', effective_status: 'active', trial_ends_at: null, trial_extended: false, trial_days_left: 0, current_period_end: null, has_subscription: true, stripe_customer_id: 'cus_x', period_ends_in_days: 21, plan_amount: 250, plan_currency: 'usd', automatic_tax: false });
    if (url.startsWith('/auth/me')) return reply(config, { user_id: 'u-me', username: 'Dawson', discriminator: 4821, display_name: 'Dawson' });
    if (/^\/conversations\/[^/]+\/devices/.test(url)) return reply(config, [{ device_id: 'dev-mira', user_id: 'user-mira', spk_pub_b64: 'x' }]);
    if (url.startsWith('/devices')) return reply(config, []);
    if (url.startsWith('/servers')) return reply(config, []);
    if (/\/members/.test(url)) return reply(config, []);
    if (url.startsWith('/friends/status/')) return reply(config, { status: 'accepted' });
    const who = url.match(/^\/auth\/users\/user-([a-z]+)/);
    if (who) return reply(config, { user_id: `user-${who[1]}`, username: who[1][0].toUpperCase() + who[1].slice(1) });
    return reply(config, {});
};

function installElectronStub() {
    const values: Record<string, unknown> = {
        getAutoStart: false, getStartMinimized: false, getMinimizeToTray: true, getUpdateChannel: 'latest',
        getPlatform: 'win32', platform: 'win32', getAppVersion: '1.0.23', gdriveAuthStatus: { linked: false },
        getDeviceName: 'DESK-PC', getRunningProcesses: [],
        encryptChannelMessage: { epoch: 1, nonce_b64: 'bm9uY2U=', ciphertext_b64: 'Y3Q=', signature_b64: 'c2ln' },
    };
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

const NOW = Date.now();
const MIN = 60_000;
const t = (m: number) => new Date(NOW - m * MIN).toISOString();
const inv = (code: string) => `https://cipherline.chat/invite/${code}`;
const myServers = [{ server_id: 'S1', name: 'Neon Guild', description: null, icon_attachment: null, icon_key_b64: null, icon_nonce_b64: null, banner_attachment: null, banner_key_b64: null, banner_nonce_b64: null, owner_user_id: 'u-me', created_at: t(9000) }];

function sceneMessages(): any[] {
    if (scene === 'states') {
        return [
            { id: 'a1', sender_user_id: 'user-mira', timestamp: t(40), content: { type: 'server_invite', code: 'okOther' } },
            { id: 'a2', sender_user_id: 'user-jonas', timestamp: t(30), content: { type: 'server_invite', code: 'slow' } },
            { id: 'a3', sender_user_id: 'user-priya', timestamp: t(20), content: { type: 'server_invite', code: 'boom500' } },
            { id: 'a4', sender_user_id: 'user-mira', timestamp: t(10), content: { type: 'server_invite', code: 'gone404' } },
        ];
    }
    if (scene === 'long') {
        return Array.from({ length: 80 }, (_, i) => ({
            id: `l${i}`, sender_user_id: i % 3 === 0 ? 'u-me' : 'user-mira', timestamp: t(200 - i * 2),
            content: i % 2 ? { type: 'text', text: inv(`L${i}`) } : { type: 'server_invite', code: `L${i}` },
        }));
    }
    // sender: your own invite-only messages, each failing in a different way
    const mine = (id: string, m: number, content: any) => ({ id, sender_user_id: 'u-me', sender_device_id: 'dev-1', timestamp: t(m), content });
    return [
        { id: 's1', sender_user_id: 'user-priya', timestamp: t(60), content: { type: 'text', text: 'Anyone have an invite to that pixel art server?' } },
        mine('s2', 50, { type: 'server_invite', code: 'okOther' }),
        mine('s3', 40, { type: 'text', text: inv('okGuild') + '/' }),
        mine('s4', 30, { type: 'server_invite', code: 'boom500' }),
        mine('s5', 20, { type: 'text', text: inv('slow') }),
        mine('s6', 10, { type: 'server_invite', code: 'gone404' }),
        { id: 's7', sender_user_id: 'user-mira', timestamp: t(5), content: { type: 'server_invite', code: 'okOther' } },
    ];
}
const noop = () => {};

const Shell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div data-layout="drift" className="w-screen h-screen flex flex-col bg-cl-abyss text-white overflow-hidden font-sans relative">
        <div className="drag-region h-[34px] w-full shrink-0 flex items-center px-3 bg-cl-abyss">
            <span className="text-cl-faint" style={{ fontFamily: 'var(--cl-font-display)', fontSize: 13, fontWeight: 600 }}>cipherline</span>
        </div>
        <div className="flex flex-1 overflow-hidden app-mainrow">
            <nav className="shrink-0 app-rail" style={{ width: 72, flex: 'none', background: 'var(--cl-abyss)', borderRight: '1px solid var(--cl-border)' }} />
            <div className="select-none app-pane2" style={{ width: 240, flexShrink: 0 }}>
                <aside className="app-pane2-sheet w-full h-full bg-cl-deep rounded-l-2xl border-l border-white/[0.04]" style={{ padding: 16 }}>
                    <div className="text-cl-text font-display" style={{ fontSize: 17, fontWeight: 600 }}>{view === 'dm' ? 'Direct messages' : 'Neon Guild'}</div>
                </aside>
            </div>
            <div className="app-div1" style={{ width: 10, flexShrink: 0 }} />
            {children}
        </div>
    </div>
);

async function boot() {
    await secureLocalStore.hydrate();
    installElectronStub();
    const [{ ToastProvider }, { UpdateProvider }, { NotificationProvider }, { SubscriptionProvider }, { default: ChatPane }, { useRetentionPolicy }] = await Promise.all([
        import('../src/contexts/ToastContext'), import('../src/contexts/UpdateContext'),
        import('../src/contexts/NotificationContext'), import('../src/contexts/SubscriptionContext'),
        import('../src/components/ChatPane'), import('../src/hooks/useRetentionPolicy'),
    ]);
    const Chat: React.FC = () => {
        const retention = useRetentionPolicy('u-me');
        const [msgs, setMsgs] = React.useState<any[]>(sceneMessages);
        const append = React.useCallback((m: any) => setMsgs(prev => prev.some(x => x.id === m.id || (m.content?.client_msg_id && x.content?.client_msg_id === m.content.client_msg_id)) ? prev : [...prev, { sender_user_id: 'u-me', ...m }]), []);
        const patch = React.useCallback((_k: string, _c: string, clientMsgId: string, p: any) => setMsgs(prev => prev.map(x => x.content?.client_msg_id === clientMsgId || x.id === clientMsgId ? { ...x, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) } : x)), []);
        (window as any).__msgs = msgs;
        return (
            <Shell>
                <div className="app-pane3" style={{ flex: 1, minWidth: 280, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderTopRightRadius: '1rem' }}>
                    <main className="app-pane3-sheet w-full h-full bg-cl-abyss flex flex-col relative" style={{ overflow: 'hidden', flex: 1, minHeight: 0 }}>
                        <ChatPane
                            bundleReady
                            activeChat={view === 'dm'
                                ? { id: 'c1', title: 'Mira', type: 'dm', other_user_id: 'user-mira', avatar_url: 'img-mira' }
                                : { id: 'n1', title: 'general', type: 'channel' }}
                            activeChannel={view === 'dm' ? null : { channel_id: 'n1', name: 'general', topic: 'Raids, patch notes and general chatter', server_id: 'S1', my_permissions: '8' }}
                            messages={msgs as any}
                            onMessageSent={append} onChannelMessageSent={append} onPatchSentMessage={patch as any}
                            typingUsers={new Set<string>()} sendTypingEvent={noop}
                            activeCall={null} onCallChange={noop}
                            retention={retention as any}
                            pinnedMsgIds={[]} onPinMessage={noop} onUnpinMessage={noop}
                            pinnedSidebarExpanded={false} onTogglePinnedSidebar={noop} onOpenPinnedCallOverlay={noop}
                            pinnedSearchQuery="" myUserId="u-me"
                            friendStatuses={{}}
                            servers={myServers as any}
                            onInviteJoin={noop}
                            {...({ memberNames: { 'user-mira': 'Mira', 'user-jonas': 'Jonas', 'user-priya': 'Priya', 'u-me': 'Dawson' } } as any)}
                        />
                    </main>
                </div>
            </Shell>
        );
    };
    createRoot(document.getElementById('root')!).render(
        <ToastProvider><UpdateProvider><NotificationProvider><SubscriptionProvider>
            <Chat />
        </SubscriptionProvider></NotificationProvider></UpdateProvider></ToastProvider>,
    );
    (window as any).__booted = true;
}
boot();
