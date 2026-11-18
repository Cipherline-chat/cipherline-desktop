/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import React from 'react';
import axios from 'axios';
import { motion } from 'framer-motion';
import { Pin, Users, Search, Hash, Lock, Mic, Paperclip, SendHorizontal, UserPlus, UserMinus, PhoneCall } from 'lucide-react';
import { systemRowTime } from '../src/utils/systemRowTime';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/settings-descent.css';
import '../src/styles/layout-drift.css';
import '../src/styles/formatting.css';
import '../src/styles/checkout.css';
import { ServerContextPanel } from '../src/components/server/ServerContextPanel';
import { ServerChannelList } from '../src/components/server/ServerChannelList';
import { CategoryFormDialog } from '../src/components/server/CategoryFormDialog';
import { CategoryDeleteDialog } from '../src/components/server/CategoryDeleteDialog';
import { ServerInviteEmbed } from '../src/components/server/ServerInviteEmbed';
import { EveryoneConfirmDialog } from '../src/components/composer/EveryoneConfirmDialog';
import { FormatToolbar } from '../src/components/composer/FormatToolbar';
import { RichComposer, type RichComposerHandle, type ActiveFormats } from '../src/components/composer/RichComposer';
import { ComposerCardSurface } from '../src/components/messageCard/ComposerCardSurface';
import { useMessageColumnWidth } from '../src/components/messageCard/messageColumn';
import { MessageCard } from '../src/components/messageCard/MessageCard';
import { renderFormatted } from '../src/components/formatting/FormattedText';
import { MESSAGE_BODY_CLASS, MESSAGE_BODY_LINE_HEIGHT, MESSAGE_BODY_PX } from '../src/utils/formatting/messageSize';
import { SuggestionMenu } from '../src/components/composer/SuggestionMenu';
import { detectChannelTrigger } from '../src/utils/channelRefs';
import { resolveCard, composerCardMode, cardTextColor, composerTextStyle } from '../src/utils/cardStyle/cardStyleReact';
import { cardStyleLabel } from '../src/utils/cardStyle/composerCardStyle';
import { CARD_STYLE_TEMPLATES } from '../src/utils/cardStyle/cardStyleTemplates';
import { parseCardStyleCss, type CardStyle } from '@cipherline/shared';
import { GiftActionsProvider, type GiftActions } from '../src/components/billing/gifts/GiftActionsContext';
import { GiftCardEmbed } from '../src/components/billing/gifts/GiftCardEmbed';
import { GiftProModal, GiftModalFrame, GiftSuccessPanel } from '../src/components/billing/gifts/GiftProModal';
import { ClButton } from '../src/components/ClButton';
import { ToastProvider } from '../src/contexts/ToastContext';
import secureLocalStore from '../src/utils/secureLocalStore';
import { memberGroupsCollapsedKey } from '../src/utils/memberGroupCollapse';
import { stripBareInviteLinks, inviteCodeFromUrl } from '../src/utils/formatting/inviteLinks';
import { embedUrlsOf } from '../src/utils/formatting/plainText';
import { fontStackFor } from '../src/utils/formatting/messageFont';
import { ECHO_PROMPT_COPY } from '../src/utils/echoPrompt';
import { GATE_CUT_PROMPT_COPY } from '../src/utils/gateCutPrompt';
import { ALL_PERMISSIONS, DEFAULT_EVERYONE_PERMISSIONS, type GiftConfig, type GiftView, type MessageFont } from '@cipherline/shared';
import type { ChannelInfo, CategoryInfo, DividerInfo, ServerInfo } from '../src/hooks/useServers';

/**
 * Window-size layout check for the 2026-11-17 staging round. The REAL
 * components, placed in a frame shaped like Dashboard: server rail (72) | channel
 * list | chat | context panel, with the pane widths Dashboard computes from the
 * window width at its default ratios (Dashboard.tsx leftWidth / rightWidth; see
 * useFocusLayout.ts for the same arithmetic): at the 1000 px minimum the chat
 * column is ~416 px wide. ?scene=
 *   member      member list (&state=open|collapsed|stalehidden)
 *   channels    channel list: category hierarchy, divider categories in the four
 *               label styles, sub-categories, dividers (one hidden from members)
 *   catform     Create Category (&edit=1: Edit; &look=divider: "Looks like" divider + colour picker)
 *   catdelete   delete-category dialog (&choice=only|everything)
 *   composer    the composer in the chat column (menus opened by the check script)
 *               &card=<template id|nudge|shadow>: the live card preview (ComposerCardSurface) for the next message,
 *               wired as ChatPane wires it (resolveCard + composerCardMode + cardTextColor, the FormatToolbar chip);
 *               &text=fmt|long: a formatted draft (heading, bold, list) / a long one past max-height;
 *               &motion=static: "Without animation"; &brokencard=1: the positive control (card forced 1600px wide)
 *   everyone    the @everyone confirm dialog
 *   invite      messages whose bare invite URL is hidden behind the invite card
 *   giftcards   the gift card in a DM in every state
 *   unwrap      one unopened gift card (Accept -> unwrap)
 *   giftpick    Gift Pro modal, first step (friend picker); the check script clicks on to the payment step
 *   giftsuccess the celebration
 *   call        the call sidebar's echo + gate-cut prompt pills (the pill JSX of SidebarConference)
 * Driven by harness/window-sizes-check.mjs.
 */
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'member';
const ME = 'me';
const LONG = q.get('long') === '1';

// ── Fake API ──────────────────────────────────────────────────────────────────
const SERVER = {
    server_id: 's1', name: LONG ? 'The Extremely Long Named Maker Collective & Friends Society' : 'Maker Collective', description: null,
    icon_attachment: null, icon_key_b64: null, icon_nonce_b64: null,
    banner_attachment: null, banner_key_b64: null, banner_nonce_b64: null, owner_user_id: ME, created_at: '',
} as ServerInfo;
const ch = (id: string, parent: string | null, position: number, kind: 'text' | 'voice' = 'text'): ChannelInfo => ({
    channel_id: id, server_id: 's1', kind, name: id, topic: null, icon_emoji: null, icon_name: null,
    position, parent_category_id: parent, active_call_session_id: null, member_limit: null, max_calls: null,
});
const cat = (id: string, name: string, position: number, parent: string | null = null, extra: Partial<CategoryInfo> = {}): CategoryInfo =>
    ({ category_id: id, server_id: 's1', name, position, kind: 'text', icon_name: null, parent_category_id: parent, ...extra });
const div = (id: string, parent: string | null, position: number, style: DividerInfo['style'], label: string | null, color: string | null = null): DividerInfo =>
    ({ divider_id: id, server_id: 's1', parent_category_id: parent, position, style, label, color });

const CATEGORIES: CategoryInfo[] = [
    cat('craft', 'Crafting and Making Things Together', 1000),
    cat('wood', 'Woodworking and joinery for beginners', 2000, 'craft'),
    cat('metal', 'Metalwork', 3000, 'craft'),
    cat('d-label', 'Community announcements board', 2000, null, { header_style: 'label', header_color: '#25e0c8' }),
    cat('d-header', 'Game Nights', 3000, null, { header_style: 'header', header_color: '#ffc94d' }),
    cat('tabletop', 'Tabletop', 1000, 'd-header'),
    cat('d-pill', 'Events and meetups', 4000, null, { header_style: 'pill', header_color: '#a78bfa' }),
    cat('d-text', 'Archive', 5000, null, { header_style: 'text', header_color: '#ff6b5e' }),
];
const CHANNELS: ChannelInfo[] = [
    ch('welcome', null, 1000), ch('general', null, 2000),
    ch('crafting-chat', 'craft', 1000),
    ch('joinery-and-finishing-techniques-for-hardwood-furniture', 'wood', 1000), ch('finishes', 'wood', 2000),
    ch('welding', 'metal', 1000),
    ch('announcements', 'd-label', 1000),
    ch('lfg', 'd-header', 1000), ch('game-chat', 'd-header', 2000),
    ch('dnd-tuesday', 'tabletop', 1000),
    ch('build-nights', 'd-pill', 1000),
    ch('old-projects', 'd-text', 1000),
    ch('Lounge', null, 3000, 'voice'),
];
const DIVIDERS: DividerInfo[] = [
    div('dv-label', 'craft', 1500, 'label', 'Show and tell for finished pieces'),
    div('dv-line', 'd-header', 1500, 'line', null),
    div('dv-dots', 'd-pill', 1500, 'dots', null),
    div('dv-space', 'd-text', 500, 'space', null),
    // Nothing below it in Archive: hidden from members (eye-off + tooltip for managers).
    div('dv-hidden', 'd-text', 9000, 'pill', 'Nothing under me'),
];

const roles = [
    { role_id: 'ev', name: '@everyone', position: 0, is_everyone: true, hoisted: false, color: -1, permissions: DEFAULT_EVERYONE_PERMISSIONS.toString() },
    { role_id: 'mods', name: LONG ? 'Moderators of the Extremely Long Role Name' : 'Moderators', position: 5, is_everyone: false, hoisted: true, color: 0x25e0c8, permissions: '0' },
    { role_id: 'artists', name: 'Artists', position: 3, is_everyone: false, hoisted: true, color: 0xa78bfa, permissions: '0' },
];
let n = 0;
const member = (name: string, status: string, role_ids: string[] = []) => ({
    user_id: name === 'Dawson' ? ME : `u${++n}`, username: name, discriminator: 1000 + n, nickname: null, avatar_url: null,
    status, joined_at: '2026-01-01T00:00:00Z', muted_until: null, role_ids,
});
const members = [
    member('Dawson', 'online', ['mods']), member('Riley', 'online', ['mods']), member('Sam', 'idle', ['mods']), member('Noor', 'dnd', ['mods']),
    member('Ari', 'online', ['artists']), member(LONG ? 'Maximilian_the_extremely_long_username_42' : 'Kit', 'online', ['artists']),
    member('Jules', 'online'), member('Mika', 'online'), member('Pat', 'idle'), member('Quinn', 'online'),
    member('Avery', 'offline'), member('Blake', 'offline', ['mods']), member('Casey', 'offline'), member('Devon', 'offline', ['artists']),
    member('Emery', 'offline'), member('Finley', 'offline'),
];

const gid = (k: number) => `11111111-1111-4111-8111-${String(k).padStart(12, '0')}`;
const G = { unopened: gid(1), openedTime: gid(3), openedCredit: gid(4), sentWaiting: gid(5), sentAccepted: gid(6), refunded: gid(7), missing: gid(8), broken: gid(9), loading: gid(10), expired: gid(11) };
const gbase = (over: Partial<GiftView>): GiftView => ({
    gift_id: gid(0), months: 1, status: 'paid', role: 'recipient', other_user_id: 'u-alex',
    created_at: '2026-11-17T15:00:00Z', paid_at: '2026-11-17T15:00:04Z', redeemed_at: null, redemption_kind: null,
    amount_subtotal: null, amount_tax: null, amount_total: null, currency: null,
    grant_end: null, credit_amount: null, ended_reason: null, ...over,
});
const giftViews: Record<string, GiftView> = {
    [G.unopened]: gbase({ gift_id: G.unopened, months: 12 }),
    [G.openedTime]: gbase({ gift_id: G.openedTime, status: 'redeemed', redemption_kind: 'time', grant_end: '2026-12-17T15:00:00Z', redeemed_at: '2026-11-17T16:00:00Z' }),
    [G.openedCredit]: gbase({ gift_id: G.openedCredit, months: 12, status: 'redeemed', redemption_kind: 'credit', credit_amount: 4999, currency: 'usd' }),
    [G.sentWaiting]: gbase({ gift_id: G.sentWaiting, role: 'sender', other_user_id: 'u-sam', amount_subtotal: 499, amount_tax: 35, amount_total: 534, currency: 'usd' }),
    [G.sentAccepted]: gbase({ gift_id: G.sentAccepted, role: 'sender', other_user_id: 'u-sam', months: 12, status: 'redeemed', amount_subtotal: 4999, amount_tax: 350, amount_total: 5349, currency: 'usd' }),
    [G.refunded]: gbase({ gift_id: G.refunded, status: 'void', ended_reason: 'refunded' }),
    [G.expired]: gbase({ gift_id: G.expired, status: 'void', ended_reason: 'expired' }),
};
const giftConfig: GiftConfig = {
    enabled: true, refund_after_days: 90, publishable_key: 'pk_test_harness',
    offers: [{ months: 1, amount: 499, currency: 'usd' }, { months: 12, amount: 4999, currency: 'usd' }],
    automatic_tax: true, payment_method_types: ['card', 'link'],
};

const ok = (config: any, data: unknown) => Promise.resolve({ data, status: 200, statusText: 'OK', headers: {}, config } as any);
const fail = (status: number, data: unknown) => Promise.reject(Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } }));
axios.defaults.adapter = (config: any) => {
    const url = String(config.url ?? '').replace(/^.*\/v1/, '');
    const method = String(config.method ?? 'get').toLowerCase();
    if (/\/servers\/s1\/members$/.test(url)) return ok(config, members);
    if (/\/servers\/s1\/roles$/.test(url)) return ok(config, roles);
    if (/\/me\/permissions$/.test(url)) return ok(config, { permissions: ALL_PERMISSIONS.toString() });
    if (/\/overrides$/.test(url)) return ok(config, []);
    if (/^\/invites\/[^/]+\/preview$/.test(url)) {
        const code = url.split('/')[2];
        if (code === 'gone') return fail(404, { message: 'Invite not found' });
        return ok(config, {
            server_id: 's9', server_name: code === 'longname' ? 'The Unreasonably Long Server Name For Testing Wrapping Behaviour' : 'Woodshop Friends',
            server_description: 'Weekly builds, show and tell, and a lot of sawdust. Everyone is welcome — bring a project or just hang out.',
            server_icon: null, server_icon_key_b64: null, server_icon_nonce_b64: null, member_count: 1284, expires_at: null,
        });
    }
    if (url === '/billing/gifts/config') return ok(config, giftConfig);
    if (url === '/billing/gifts' && method === 'get') return ok(config, { sent: [], received: [], pro_until: null });
    const m = url.match(/^\/billing\/gifts\/([0-9a-f-]{36})(\/redeem|\/confirm)?$/);
    if (m) {
        const id = m[1];
        if (id === G.loading) return new Promise(() => {});
        if (id === G.broken) return Promise.reject(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }));
        const v = giftViews[id];
        if (!v) return fail(404, { code: 'gift_not_found', message: 'Not found' });
        if (m[2] === '/redeem') {
            const next: GiftView = { ...v, status: 'redeemed', redemption_kind: 'time', grant_end: '2026-12-17T15:00:00Z', redeemed_at: '2026-11-17T16:00:00Z' };
            giftViews[id] = next;
            return ok(config, { gift: next, outcome: 'time', pro_until: next.grant_end, credit_amount: null, already: false });
        }
        return ok(config, v);
    }
    if (method !== 'get') return ok(config, { ok: true });
    return ok(config, []);
};

const friends = [
    { user_id: 'u-alex', username: 'alex', discriminator: 7 },
    { user_id: 'u-sam', username: 'sam.k', discriminator: 1204 },
    { user_id: 'u-jo', username: 'jo', discriminator: 42 },
    { user_id: 'u-mira', username: 'mira', discriminator: 88 },
    { user_id: 'u-ola', username: 'ola', discriminator: 3 },
    { user_id: 'u-bex', username: 'bex', discriminator: 911 },
    { user_id: 'u-nik', username: 'nikolai_the_extremely_long_named_friend_of_everyone', discriminator: 5 },
    { user_id: 'u-tess', username: 'tess', discriminator: 61 },
    { user_id: 'u-uma', username: 'uma', discriminator: 14 },
    { user_id: 'u-vic', username: 'vic', discriminator: 15 },
];
const NAMES: Record<string, string> = { 'u-alex': 'Alex', 'u-sam': 'Sam', 'u-jo': 'Jo', 'u-mira': 'Mira' };
const giftActions: GiftActions = { friends, nameFor: (uid) => (uid ? NAMES[uid] ?? null : null), sendGiftCard: async () => true };

// ── Dashboard-shaped frame ──────────────────────────────────────────────────
/** Dashboard.tsx: SIDEBAR_MIN_PX 200, RIGHT_PANEL_MIN_PX 240, sidebarMaxPx, default ratios .18 / .20. */
function paneWidths(W: number) {
    const max = Math.max(500, Math.round(W * 0.35));
    return { left: Math.max(200, Math.min(max, 0.18 * W)), right: Math.max(240, Math.min(max, 0.2 * W)) };
}
function useWindowWidth() {
    const [w, setW] = React.useState(window.innerWidth);
    React.useEffect(() => { const f = () => setW(window.innerWidth); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
    return w;
}
const card: React.CSSProperties = { background: 'var(--cl-deep)', borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 };

const Dash: React.FC<{ left?: React.ReactNode; header?: React.ReactNode; feed?: React.ReactNode; composer?: React.ReactNode; right?: React.ReactNode | null; overlay?: React.ReactNode }> =
({ left, header, feed, composer, right, overlay }) => {
    const W = useWindowWidth();
    const { left: lw, right: rw } = paneWidths(W);
    return (
        <div id="dash" style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', background: 'var(--cl-abyss)', color: 'var(--cl-text)' }}>
            <nav style={{ width: 72, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, paddingTop: 12 }}>
                {[0, 1, 2, 3].map(i => <span key={i} style={{ width: 44, height: 44, borderRadius: 14, background: i === 1 ? '#25E0C8' : 'var(--cl-raise)' }} />)}
            </nav>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', padding: '6px 10px 10px 2px' }}>
                <aside id="pane-left" style={{ ...card, width: lw, flex: 'none' }}>{left ?? <ChannelList />}</aside>
                <div style={{ width: 10, flex: 'none' }} />
                <main id="chat" className="chat-pane-root" style={{ ...card, flex: 1, minWidth: 0, position: 'relative', background: 'var(--cl-abyss)' }}>
                    {header ?? <ChannelHeader />}
                    <div id="feed" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '8px 8px 8px 0' }}>{feed}</div>
                    <div id="composer-host" style={{ padding: '0 16px 16px', position: 'relative' }}>{composer ?? <ComposerStandIn />}</div>
                </main>
                {right !== null && <div style={{ width: 10, flex: 'none' }} />}
                {right !== null && <aside id="panel" style={{ ...card, width: rw, flex: 'none', overflowY: 'auto' }}>{right ?? <MemberPanel />}</aside>}
            </div>
            {overlay}
        </div>
    );
};

const noop = () => {};
const NONE: never[] = [];
const EMPTY = {};
const SET = new Set<string>();

const ChannelList: React.FC = () => {
    const [active, setActive] = React.useState<string | null>('general');
    return (
        <ServerChannelList
            server={SERVER} channels={CHANNELS} categories={CATEGORIES} dividers={DIVIDERS} loading={false}
            activeChannelId={active} onSelectChannel={(c) => setActive(c.channel_id)}
            token={null} userId={ME} myPermissions={ALL_PERMISSIONS}
            unreadCounts={{ 'dnd-tuesday': 4, lfg: 2 }} mentionCounts={{ 'build-nights': 1 }} serverNotifMode="all"
            onDeleteCategoryApi={async () => {}} onDeleteCategoryWithContentsApi={async () => {}}
        />
    );
};

/** The channel header's right-hand buttons exactly as ChatPane renders them for a server channel. */
const ChannelHeader: React.FC =
() => (
    <div id="hdr" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--cl-border)', minWidth: 0 }}>
        <Hash size={18} style={{ flex: 'none', color: 'var(--cl-faint)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
            <h3 className="truncate" style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>{LONG ? 'joinery-and-finishing-techniques-for-hardwood-furniture' : 'general'}</h3>
        </div>
        <span className="shrink-0 flex" style={{ color: 'var(--cl-lume)' }}><Lock size={13} strokeWidth={2.4} /></span>
        <div className="cl-hdr-actions flex items-center gap-0.5 relative">
            <ClButton icon onClick={noop} tooltip="Pinned messages" variant="ghost" active={false}><Pin className="w-5 h-5" /></ClButton>
        </div>
    </div>
);

/** A chat row like ChatPane's (avatar, name, time, body). */
const Row: React.FC<{ who: string; hue?: string; children: React.ReactNode; id?: string }> = ({ who, hue = '#25E0C8', children, id }) => (
    <div data-row={id} className="group relative flex gap-3 py-0.5 pr-2 pl-3 mt-3">
        <div className="w-10 h-10 shrink-0 mt-0.5 rounded-full ring-1 ring-white/5" style={{ background: `linear-gradient(135deg, ${hue}, #1C2542)` }} />
        <div className="relative flex flex-col min-w-0 flex-1">
            <div className="flex items-baseline gap-2 mb-0.5">
                <span className="text-[14px] font-semibold leading-tight">{who}</span>
                <span className="text-[11px] text-cl-faint leading-tight">Today at 4:20 PM</span>
            </div>
            {children}
        </div>
    </div>
);
const Body: React.FC<{ text: string }> = ({ text }) => (
    <div className={MESSAGE_BODY_CLASS} style={{ fontSize: 15, lineHeight: 'normal', wordBreak: 'break-word' }}>{text}</div>
);
const FEED = (
    <>
        <Row who="Riley" hue="#25E0C8"><Body text="anyone up for build night?" /></Row>
        <Row who="Ari" hue="#a78bfa"><Body text="yes! bringing the new printer" /></Row>
        <Row who="Jules" hue="#FFC94D"><Body text="same time as last week?" /></Row>
    </>
);
const FEED_ROWS: React.FC = () => FEED;
/** The posted message exactly as ChatPane draws a styled text body: MessageCard around the row body div. */
const SentStyled: React.FC = () => {
    const st = harnessCardStyle(q.get('card'));
    const text = DRAFTS[q.get('text') ?? ''] ?? '';
    const card = resolveCard(st, composerCardMode({ user: q.get('motion') === 'static' ? 'static' : 'all', server: 'on', reducedMotion: false }));
    const color = cardTextColor(card);
    return (
        <Row who="You" hue="#8B5CF6" id="sent">
            <MessageCard resolved={card}>
                <div data-sent-body="" className={MESSAGE_BODY_CLASS}
                    style={{ fontSize: `${MESSAGE_BODY_PX}px`, lineHeight: MESSAGE_BODY_LINE_HEIGHT, wordBreak: 'break-word', fontFamily: fontStackFor(null), ...(color ? { color } : {}) }}>
                    {renderFormatted(text, { renderLeaf: (leaf: string) => leaf })}
                </div>
            </MessageCard>
        </Row>
    );
};
const ComposerStandIn: React.FC = () => (
    <div className="cl-composer" style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'var(--cl-surface)', border: '1.5px solid var(--cl-border)', borderRadius: 26, padding: '6px 6px 6px 8px', minHeight: 46 }}>
        <span className="cmp-ico"><Paperclip className="w-[18px] h-[18px]" /></span>
        <span style={{ flex: 1, color: 'var(--cl-faint)', fontSize: 15, padding: '2px 4px' }} className="truncate">Message #general</span>
        <span className="cmp-ico cmp-ico--send"><SendHorizontal className="w-[18px] h-[18px]" /></span>
    </div>
);

const MemberPanel: React.FC<{ voice?: boolean; extra?: React.ReactNode }> =
({ voice = false, extra }) => (
    <>
        {extra}
        <ServerContextPanel
            server={SERVER} channel={CHANNELS[1]} token="harness" userId={ME}
            myPermissions={DEFAULT_EVERYONE_PERMISSIONS}
            allChannels={voice ? CHANNELS : CHANNELS.filter(c => c.kind === 'text')} categories={NONE} dividers={NONE}
            voiceParticipants={EMPTY} friendStatuses={EMPTY} presenceAuthoritative={false}
            myStatus="online" myCurrentGame={null}
            globalFriends={null} conversations={NONE} sentFriendRequests={SET} setSentFriendRequests={noop}
            huddleCalls={EMPTY} searchableMessages={NONE} channelPermissionsMap={EMPTY}
            onOpenProfile={noop} onStartChat={noop} onOpenDMWithUser={async () => {}} onStartCall={noop} onBlock={noop}
        />
    </>
);


/** callhover: the Calls + Voice sections of the server panel with live participants (hover-shift measurement). */
const CALL_CATS: CategoryInfo[] = [
    cat('hc1', 'Game Nights', 1000, null, { kind: 'huddle' } as Partial<CategoryInfo>),
    cat('hc2', 'Work', 2000, null, { kind: 'huddle' } as Partial<CategoryInfo>),
];
const CALL_CHANNELS: ChannelInfo[] = [
    ch('lounge', 'hc1', 1000, 'huddle' as 'voice'), ch('standup', 'hc2', 1000, 'huddle' as 'voice'),
    ch('General Voice', null, 5000, 'voice'), ch('AFK', null, 6000, 'voice'),
];
const CALL_PEOPLE = members.filter(m => m.user_id !== ME).slice(0, 3).map(m => m.user_id);
const CALLS = {
    lounge: [{ call_id: 'c1', huddle_id: 'lounge', name: 'Call 1', spawner_user_id: CALL_PEOPLE[0], spawned_at: '2026-11-18T00:00:00Z', participants: CALL_PEOPLE }],
    standup: [{ call_id: 'c2', huddle_id: 'standup', name: 'Call 1', spawner_user_id: CALL_PEOPLE[0], spawned_at: '2026-11-18T00:00:00Z', participants: CALL_PEOPLE.slice(0, 2) }],
};
const CallHoverScene: React.FC = () => (
    <Dash right={
        <ServerContextPanel
            server={SERVER} channel={CHANNELS[1]} token="harness" userId={ME}
            myPermissions={ALL_PERMISSIONS}
            allChannels={CALL_CHANNELS} categories={CALL_CATS} dividers={NONE}
            voiceParticipants={{ 'General Voice': CALL_PEOPLE }} friendStatuses={EMPTY} presenceAuthoritative={false}
            myStatus="online" myCurrentGame={null}
            globalFriends={null} conversations={NONE} sentFriendRequests={SET} setSentFriendRequests={noop}
            huddleCalls={CALLS} searchableMessages={NONE} channelPermissionsMap={EMPTY}
            onOpenProfile={noop} onStartChat={noop} onOpenDMWithUser={async () => {}} onStartCall={noop} onBlock={noop}
            membersHidden={false} onShowMembers={noop}
        />
    } />
);

// ── Scenes ───────────────────────────────────────────────────────────────────
const MemberScene: React.FC = () => {
    return <Dash header={<ChannelHeader />} feed={FEED} right={<MemberPanel />} />;
};

const CatFormScene: React.FC = () => {
    const edit = q.get('edit') === '1';
    const base = CATEGORIES.find(c => c.category_id === (q.get('look') === 'divider' ? 'd-header' : 'craft'))!;
    return (
        <Dash feed={FEED} overlay={
            <CategoryFormDialog
                serverId="s1" token={null} kind="text" ownerUserId={ME} currentUserId={ME}
                category={edit ? base : null} categories={CATEGORIES}
                onClose={noop} onSaved={noop}
            />
        } />
    );
};

const CatDeleteScene: React.FC = () => (
    <Dash feed={FEED} overlay={
        <CategoryDeleteDialog
            name={LONG ? 'Crafting and Making Things Together With Friends' : 'Game Nights'} isSub={false}
            only={{ title: `Delete "${LONG ? 'Crafting and Making Things Together With Friends' : 'Game Nights'}"?`, message: 'Channels inside will become uncategorized; its sub-categories become categories.' }}
            contents={{ channels: 4, subcategories: 1, dividers: 2 }}
            initialChoice={q.get('choice') === 'everything' ? 'everything' : 'only'}
            onConfirm={noop} onCancel={noop}
        />
    } />
);

const DRAFTS: Record<string, string> = {
    fmt: '# Server rules\n**Be kind.** No spam, no slurs, no *drama*.\n- Keep it on topic\n- Use `#help` for questions',
    yo: 'Yo All!',
    sentence: 'Game night moves to Friday at 8 PM, bring snacks and a controller.',
    wrap: 'Heads up everyone: the build server is going down tonight for maintenance, so please push anything you need before 10 PM and expect the nightly builds to be late tomorrow morning.',
    long: ['# Patch notes', ...Array.from({ length: 22 }, (_, i) => `- line ${i + 1}: **fixed** the thing that was *slightly* broken`), 'Last line: the end'].join('\n'),
};
const HARNESS_CHANNELS = ['general', 'gaming', 'gear-talk', 'design'];
/** Card styles the composer preview cases use: the built-in templates by id, plus two edge cases. */
function harnessCardStyle(id: string | null): CardStyle | null {
    if (!id) return null;
    if (id === 'nudge') return parseCardStyleCss('background: #131a30; color: #1c2542; border: 1px solid #2a3560; border-radius: 10px').style ?? null;
    if (id === 'shadow') return parseCardStyleCss('background: linear-gradient(135deg, #1a2a55, #2a1a45); box-shadow: 0 6px 16px 4px rgba(0,0,0,.6); border-radius: 14px').style ?? null;
    return CARD_STYLE_TEMPLATES.find(t => t.id === id)?.style ?? null;
}

const Composer: React.FC = () => {
    const [bar, setBar] = React.useState(q.get('bar') === '1');
    const [font, setFont] = React.useState<MessageFont | null>(null);
    const [formats, setFormats] = React.useState<ActiveFormats | null>(null);
    const [value, setValue] = React.useState(DRAFTS[q.get('text') ?? ''] ?? '');
    const [cardOverride, setCardOverride] = React.useState<{ style: CardStyle } | null>(() => { const st = harnessCardStyle(q.get('card')); return st ? { style: st } : null; });
    const [channels, setChannels] = React.useState<{ items: string[]; start: number; end: number } | null>(null);
    const ed = React.useRef<RichComposerHandle>(null);
    // ChatPane: composerCard = gate && canSend && cardOverride ? resolveCard(style, composerCardMode(cardCtx)) : null
    const composerCard = cardOverride ? resolveCard(cardOverride.style, composerCardMode({ user: q.get('motion') === 'static' ? 'static' : 'all', server: 'on', reducedMotion: false })) : null;
    // ChatPane: the widest a posted card gets = the feed's message column (useMessageColumnWidth(feedRef)).
    const feedRef = React.useRef<HTMLElement | null>(null);
    React.useLayoutEffect(() => { feedRef.current = document.getElementById('feed'); }, []);
    const columnW = useMessageColumnWidth(feedRef, !!composerCard);
    // ChatPane: attach + Aa (+ chip) before the box normally; under the card while a preview is on.
    const leftControls = (
        <>
            <button type="button" className="cmp-ico" title="Attach File"><Paperclip className="w-[18px] h-[18px]" /></button>
            <FormatToolbar open={bar} onOpenChange={setBar} active={formats} font={font} onFontChange={setFont}
                size={formats?.size ?? null} onSizeChange={(sz) => { ed.current?.applySize(sz); }} isMac={false}
                focusComposer={() => ed.current?.focus()} onAction={(a) => { ed.current?.applyFormat(a); }}
                card={q.get('card') !== null ? {
                    label: cardStyleLabel(cardOverride?.style), preview: resolveCard(cardOverride?.style, 'static'),
                    onOpen: noop, onClear: () => setCardOverride(null),
                } : undefined} />
        </>
    );
    (window as any).__composerCard = { clear: () => setCardOverride(null), set: (id: string) => { const st = harnessCardStyle(id); setCardOverride(st ? { style: st } : null); } };
    return (
        <form className="cl-composer" data-card-preview={composerCard ? '' : undefined} onSubmit={e => e.preventDefault()} style={{
            position: 'relative', display: 'flex', alignItems: 'center', gap: 4,
            background: 'var(--cl-surface)', border: '1.5px solid var(--cl-lume)', borderRadius: 26, padding: composerCard ? '10px 8px 6px 10px' : '6px 6px 6px 8px',
        }}>
            {!composerCard && leftControls}
            <ComposerCardSurface resolved={composerCard} columnWidth={columnW}>
                <RichComposer ref={ed} value={value} placeholder="Message #general" onFormats={setFormats}
                    onChange={(v, { plain, caret }) => {
                        setValue(v);
                        // The # channel autocomplete, read from the PLAIN text as ChatPane does.
                        const t = ed.current?.caretInCode() ? null : detectChannelTrigger(plain.slice(0, caret));
                        const items = t ? HARNESS_CHANNELS.filter(c => c.startsWith(t.query)) : [];
                        setChannels(t && items.length ? { items, start: t.start, end: caret } : null);
                    }}
                    onKeyDown={(e) => {
                        if (channels && (e.key === 'Enter' || e.key === 'Tab')) {
                            e.preventDefault();
                            ed.current!.replaceRange(channels.start, channels.end, `#${channels.items[0]} `);
                            setChannels(null);
                        }
                    }}
                    dataFont={font ?? undefined} fontFamily={fontStackFor(font)} maxLength={100000}
                    className="flex-1 min-w-0 bg-transparent font-medium text-white/90"
                    style={composerTextStyle(composerCard, { padding: '2px 4px' })} />
            </ComposerCardSurface>
            {channels && ed.current?.element && (
                <SuggestionMenu anchorEl={ed.current.element} sectionLabel="Channels" selectedIndex={0}
                    items={channels.items.map(c => ({ key: c, icon: <Hash className="w-4 h-4 text-cl-faint" aria-hidden="true" />, label: c, onSelect: () => {} }))} />
            )}
            {q.get('brokencard') === '1' && <style>{'.cl-msg-card--composer{width:1600px !important;max-width:none !important;flex:none}'}</style>}
            {q.get('brokenwys') === '1' && <style>{'.cl-msg-card--composer{width:auto !important;padding:3px 6px !important}'}</style>}
            {composerCard && <div className="cmp-preview-controls">{leftControls}</div>}
            <button type="submit" className="cmp-ico cmp-ico--send"><SendHorizontal className="w-[18px] h-[18px]" /></button>
        </form>
    );
};

const INVITE_MSGS = [
    'Come build with us this weekend! https://cipherline.chat/invite/wood42 see you there',
    'https://cipherline.chat/invite/longname',
    'Two servers worth a look:\nhttps://cipherline.chat/invite/wood42\nhttps://cipherline.chat/invite/gone',
    'And a long non-invite link that must wrap: https://example.com/a/really/long/path/that/keeps/going/and/going/without/any/breaks/at/all/whatsoever?with=query&and=more',
];
// System rows with the hover time (2026-11-18). Markup mirrors ChatPane's member-event, plain system and call pills;
// `hover` forces the hovered state so every row's label is laid out at once.
const SysPill: React.FC<{ kind: 'join' | 'leave' | 'call'; text: string; hover: boolean; ms: number }> = ({ kind, text, hover, ms }) => {
    const t = systemRowTime(ms, new Date(2026, 10, 18, 15, 0));
    const Icon = kind === 'join' ? UserPlus : kind === 'leave' ? UserMinus : PhoneCall;
    const tone = kind === 'join' ? 'bg-blue-500/[0.07] border-blue-500/20 text-blue-400/80'
        : kind === 'call' ? 'bg-cl-ok/[0.08] border-cl-ok/20 text-cl-ok' : 'bg-white/[0.03] border-white/[0.06] text-cl-faint';
    return (
        <div className="group flex items-center gap-3 my-2 px-4 select-none" data-sys-kind={kind}>
            <div className="flex-1 h-px bg-white/[0.05]" />
            <div title={t?.full} className={`flex min-w-0 max-w-full items-center gap-1.5 px-3 py-1 rounded-full border text-[11px] font-medium ${tone}`}>
                <Icon className="w-3 h-3 flex-shrink-0" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{text}{t && <> <span data-system-row-time className={`${hover ? 'inline' : 'hidden'} group-hover:inline whitespace-nowrap tabular-nums opacity-70`}>· {t.label}</span></>}</span>
            </div>
            <div className="flex-1 h-px bg-white/[0.05]" />
        </div>
    );
};
const SysRows: React.FC<{ hover: boolean; long: boolean }> = ({ hover, long }) => {
    const n = long ? 'Bartholomew_the_Extraordinarily_Long_Named' : 'Mara';
    const m = long ? 'Moderator_With_A_Very_Long_Display_Name' : 'Riley';
    return (
        <div>
            <SysPill kind="join" text={`${n} joined the server`} hover={hover} ms={new Date(2026, 10, 18, 9, 41).getTime()} />
            <SysPill kind="leave" text={`${n} was kicked by ${m}`} hover={hover} ms={new Date(2026, 10, 17, 22, 5).getTime()} />
            <SysPill kind="leave" text={`${n} left the server`} hover={hover} ms={new Date(2026, 9, 2, 8, 30).getTime()} />
            <SysPill kind="call" text={`${n} started a call · 12:41`} hover={hover} ms={new Date(2026, 10, 18, 14, 2).getTime()} />
        </div>
    );
};

const InviteRow: React.FC<{ text: string; i: number }> = ({ text, i }) => {
    const shown = stripBareInviteLinks(text);
    const codes = embedUrlsOf(text).map(u => inviteCodeFromUrl(u)).filter((c): c is string => !!c).slice(0, 3);
    return (
        <Row who={i % 2 ? 'Ari' : 'Riley'} hue={i % 2 ? '#a78bfa' : '#25E0C8'} id={`inv-${i}`}>
            {shown.trim() !== '' && <Body text={shown} />}
            {codes.length > 0 && (
                <div className="flex flex-col gap-1 w-full items-start">
                    {codes.map((c, k) => <ServerInviteEmbed key={k} code={c} token="harness" servers={NONE} onJoin={noop} />)}
                </div>
            )}
        </Row>
    );
};

const GIFT_ROWS: [string, string, boolean, string][] = [
    ['unopened', G.unopened, false, 'Alex'], ['opened-time', G.openedTime, false, 'Alex'], ['opened-credit', G.openedCredit, false, 'Alex'],
    ['sent-waiting', G.sentWaiting, true, 'Dawson'], ['sent-accepted', G.sentAccepted, true, 'Dawson'], ['refunded', G.refunded, false, 'Alex'],
    ['expired', G.expired, false, 'Alex'], ['missing', G.missing, false, 'Mallory'], ['broken', G.broken, false, 'Alex'], ['loading', G.loading, false, 'Alex'],
];

const CallPills: React.FC = () => (
    <div id="call-sidebar" style={{ display: 'flex', flexDirection: 'column', paddingTop: 8 }}>
        {/* Tile area stand-in: the real SidebarConference needs a LiveKit room. */}
        <div style={{ margin: '0 12px 8px', aspectRatio: '16 / 9', borderRadius: 12, background: 'var(--cl-raise)' }} />
        {/* The two pills, verbatim from SidebarConference (echo prompt, then gate-cut prompt). */}
        <motion.div role="status" data-testid="echo-prompt" className="mx-3 mb-1 flex flex-wrap items-center gap-2 px-3 py-2 bg-cl-deep border border-cl-flash/40 rounded-xl text-[11px] text-cl-muted">
            <Mic className="w-3 h-3 text-cl-flash shrink-0" />
            <span className="text-cl-text flex-1 min-w-[10rem]"><strong>{ECHO_PROMPT_COPY.title}</strong> — {ECHO_PROMPT_COPY.body}</span>
            <ClButton size="sm" onClick={noop}>{ECHO_PROMPT_COPY.turnOn}</ClButton>
            <ClButton size="sm" variant="ghost" onClick={noop}>{ECHO_PROMPT_COPY.dismiss}</ClButton>
            <ClButton size="sm" variant="ghost" onClick={noop}>{ECHO_PROMPT_COPY.never}</ClButton>
        </motion.div>
        <motion.div role="status" data-testid="gate-cut-prompt" className="mx-3 mb-1 flex flex-wrap items-center gap-2 px-3 py-2 bg-cl-deep border border-cl-flash/40 rounded-xl text-[11px] text-cl-muted">
            <Mic className="w-3 h-3 text-cl-flash shrink-0" />
            <span className="text-cl-text flex-1 min-w-[10rem]"><strong>{GATE_CUT_PROMPT_COPY.title}</strong> — {GATE_CUT_PROMPT_COPY.body(-45)}</span>
            <ClButton size="sm" onClick={noop}>{GATE_CUT_PROMPT_COPY.lower(-52)}</ClButton>
            <ClButton size="sm" variant="ghost" onClick={noop}>{GATE_CUT_PROMPT_COPY.turnOff}</ClButton>
            <ClButton size="sm" variant="ghost" onClick={noop}>{GATE_CUT_PROMPT_COPY.dismiss}</ClButton>
            <ClButton size="sm" variant="ghost" onClick={noop}>{GATE_CUT_PROMPT_COPY.never}</ClButton>
        </motion.div>
    </div>
);

const GiftPick: React.FC = () => {
    const [open, setOpen] = React.useState(true);
    return <Dash feed={FEED} right={<div />} overlay={open && <GiftProModal onClose={() => setOpen(false)} initialRecipientId={q.get('pre') === '1' ? 'u-alex' : null} />} />;
};

function Scene() {
    React.useEffect(() => { (window as any).__ready = true; }, []);
    switch (scene) {
        case 'member': return <MemberScene />;
        case 'channels': return <Dash feed={FEED} />;
        case 'catform': return <CatFormScene />;
        case 'catdelete': return <CatDeleteScene />;
        case 'composer': return <Dash feed={FEED} composer={<Composer />} />;
        // WYSIWYG side by side (2026-11-18): the SENT message (ChatPane's row markup + MessageCard + the row body) in the
        // feed and the composer preview of the same style and text below it. &card=<id> &text=<draft id>.
        case 'wysiwyg': return <Dash feed={<><FEED_ROWS /><SentStyled /></>} composer={<Composer />} />;
        case 'everyone': return <Dash feed={FEED} overlay={<EveryoneConfirmDialog kind={q.get('kind') === 'here' ? 'here' : 'everyone'} memberCount={1284} onConfirm={noop} onCancel={noop} />} />;
        case 'invite': return <Dash feed={INVITE_MSGS.map((t, i) => <InviteRow key={i} text={t} i={i} />)} />;
        case 'giftcards': return <Dash right={<div />} header={<ChannelHeader />} feed={GIFT_ROWS.map(([k, id, mine, who]) => (
            <Row key={k} id={`gift-${k}`} who={who} hue={mine ? '#8B5CF6' : '#FFC94D'}><GiftCardEmbed giftId={id} isMine={mine} senderName={who} /></Row>
        ))} />;
        case 'unwrap': return <Dash right={<div />} feed={<Row id="gift-unwrap" who="Alex" hue="#FFC94D"><GiftCardEmbed giftId={G.unopened} isMine={false} senderName="Alex" /></Row>} />;
        case 'giftpick': return <GiftPick />;
        case 'giftsuccess': return <Dash feed={FEED} right={<div />} overlay={
            <GiftModalFrame onClose={noop}><GiftSuccessPanel recipientName={LONG ? 'nikolai_the_extremely_long_named_friend_of_everyone' : 'Alex'} months={12} cardSend={(q.get('card') ?? 'sent') as 'sent'} onResend={noop} onDone={noop} /></GiftModalFrame>
        } />;
        case 'call': return <Dash feed={FEED} right={<><CallPills /><MemberPanel hidden onShow={noop} voice /></>} />;
        case 'callhover': return <CallHoverScene />;
        case 'sysrows': return <Dash feed={<SysRows hover={q.get('hover') === '1'} long={q.get('long') === '1'} />} />;
        case 'broken': return (
            /* The check's positive control: a deliberately broken layout (a fixed-width
               toolbar wider than the chat column, and a popover hanging off the window). */
            <Dash feed={FEED} header={
                <div id="hdr" style={{ display: 'flex', gap: 8, padding: 10, whiteSpace: 'nowrap', width: 900 }}>
                    {Array.from({ length: 12 }, (_, i) => <ClButton key={i} size="sm" onClick={noop}>Button {i + 1}</ClButton>)}
                </div>
            } overlay={<div role="dialog" data-testid="off-screen" style={{ position: 'fixed', right: -120, top: 40, width: 300, height: 200, background: 'var(--cl-surface)' }}>Off screen</div>} />
        );
        default: return <div>unknown scene {scene}</div>;
    }
}

(async () => {
    try { await secureLocalStore.hydrate(); } catch { /* a cold store is fine for a harness */ }
    secureLocalStore.setItem('cipherline_user_id', ME);
    try { await secureLocalStore.whenAccountReady(); } catch { /* */ }
    // legacy hide flag from the removed switch: the list must show regardless
    if (q.get('state') === 'stalehidden') secureLocalStore.setItem(`cipherline_member_list_hidden_${ME}`, '1');
    if (q.get('state') === 'collapsed') secureLocalStore.setItem(memberGroupsCollapsedKey(ME, 's1'), JSON.stringify(['role:mods', 'offline']));
    loadWebFonts();
    createRoot(document.getElementById('root')!).render(
        <ToastProvider><GiftActionsProvider value={giftActions}><Scene /></GiftActionsProvider></ToastProvider>,
    );
})();
