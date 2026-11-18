/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import React, { useState } from 'react';
import axios from 'axios';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/settings-descent.css';
import '../src/styles/checkout.css';
import { loadWebFonts } from '../src/utils/webFonts';
import type { GiftConfig, GiftListResponse, GiftView } from '@cipherline/shared';
import { GiftActionsProvider, type GiftActions } from '../src/components/billing/gifts/GiftActionsContext';
import { GiftCardEmbed } from '../src/components/billing/gifts/GiftCardEmbed';
import { GiftsSection } from '../src/components/billing/gifts/GiftsSection';
import { GiftProModal, GiftModalFrame, GiftSuccessPanel, GiftSlowPanel } from '../src/components/billing/gifts/GiftProModal';
import { emitGiftUpdated } from '../src/components/billing/gifts/giftEvents';
import { ProWelcome } from '../src/components/ProWelcome';

/**
 * Gift Pro UI in isolation. ?scene=
 *   cards     every chat-card state, recipient and sender side
 *   unwrap    one unopened card (Accept -> unwrap)        ?side=sender for the buyer's card
 *             ?welcome=1 mounts the real ProWelcome when the card calls celebratePro()
 *             (as Dashboard does), inside a stand-in chat column
 *   section   Settings -> Subscription -> Gift Pro        ?data=empty|error|loading
 *   pick      the purchase modal's first step (real GiftProModal; Stripe is never reached)
 *   success   the celebration                             ?card=sent|failed|sending
 *   slow      "payment received, finishing up"
 * window.__gifts: { seek(ms, rootSelector?), redeemCalls, sendCalls, emit(id) }
 */
const q = new URLSearchParams(location.search);
loadWebFonts();

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const G = {
    unopened: id(1), unopened12: id(2), openedTime: id(3), openedCredit: id(4),
    sentWaiting: id(5), sentAccepted: id(6), refunded: id(7), missing: id(8), broken: id(9), loading: id(10),
    expired: id(11), expiredSent: id(12),
};
const base = (over: Partial<GiftView>): GiftView => ({
    gift_id: id(0), months: 1, status: 'paid', role: 'recipient', other_user_id: 'u-alex',
    created_at: '2026-11-17T15:00:00Z', paid_at: '2026-11-17T15:00:04Z', redeemed_at: null, redemption_kind: null,
    amount_subtotal: null, amount_tax: null, amount_total: null, currency: null,
    grant_end: null, credit_amount: null, ended_reason: null, ...over,
});
const views: Record<string, GiftView> = {
    [G.unopened]: base({ gift_id: G.unopened }),
    [G.unopened12]: base({ gift_id: G.unopened12, months: 12 }),
    [G.openedTime]: base({ gift_id: G.openedTime, status: 'redeemed', redemption_kind: 'time', grant_end: '2026-12-17T15:00:00Z', redeemed_at: '2026-11-17T16:00:00Z' }),
    [G.openedCredit]: base({ gift_id: G.openedCredit, months: 12, status: 'redeemed', redemption_kind: 'credit', credit_amount: 4999, currency: 'usd' }),
    [G.sentWaiting]: base({ gift_id: G.sentWaiting, role: 'sender', other_user_id: 'u-sam', amount_subtotal: 499, amount_tax: 35, amount_total: 534, currency: 'usd' }),
    [G.sentAccepted]: base({ gift_id: G.sentAccepted, role: 'sender', other_user_id: 'u-sam', months: 12, status: 'redeemed', amount_subtotal: 4999, amount_tax: 350, amount_total: 5349, currency: 'usd' }),
    [G.refunded]: base({ gift_id: G.refunded, status: 'void', ended_reason: 'refunded' }),
    // Automatic refund after 90 days unopened (owner 2026-11-17).
    [G.expired]: base({ gift_id: G.expired, status: 'void', ended_reason: 'expired' }),
    [G.expiredSent]: base({ gift_id: G.expiredSent, role: 'sender', other_user_id: 'u-sam', status: 'void', ended_reason: 'expired', amount_total: 534, currency: 'usd' }),
};
const config: GiftConfig = {
    enabled: true,
    refund_after_days: 90,
    publishable_key: 'pk_test_harness',
    offers: [{ months: 1, amount: 499, currency: 'usd' }, { months: 12, amount: 4999, currency: 'usd' }],
    automatic_tax: true,
    payment_method_types: ['card', 'link'],
};
const list: GiftListResponse = {
    sent: [views[G.sentWaiting], views[G.sentAccepted], views[G.expiredSent], base({ gift_id: id(20), role: 'sender', other_user_id: 'u-jo', status: 'void', ended_reason: 'refunded', amount_total: 534, currency: 'usd' })],
    received: [views[G.openedTime], views[G.unopened12]],
    pro_until: '2026-12-17T15:00:00Z',
};

const h = window as any;
h.__gifts = { redeemCalls: 0, sendCalls: 0, emit: (gid: string) => emitGiftUpdated(gid),
    seek(ms: number, root?: string) {
        const scope = root ? document.querySelector(root) : null;
        for (const a of document.getAnimations()) {
            const t = (a.effect as KeyframeEffect | null)?.target as Element | null;
            if (scope && !(t && scope.contains(t))) continue;
            a.pause(); a.currentTime = ms;
        }
    },
};

const fail = (status: number, data: unknown) => Promise.reject(Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } }));
const ok = (config: any, data: unknown) => Promise.resolve({ data, status: 200, statusText: 'OK', headers: {}, config });
axios.defaults.adapter = (cfg: any) => {
    const url = String(cfg.url).replace(/^.*\/v1/, '');
    const method = String(cfg.method).toLowerCase();
    if (url === '/billing/gifts/config') return ok(cfg, new URLSearchParams(location.search).get('gifts') === 'off' ? { ...config, enabled: false, offers: [] } : config);
    if (url === '/billing/gifts' && method === 'get') {
        if (q.get('data') === 'error') return fail(503, { code: 'unavailable', message: 'Billing is having a moment. Try again shortly.' });
        if (q.get('data') === 'loading') return new Promise(() => {});
        return ok(cfg, q.get('data') === 'empty' ? { sent: [], received: [], pro_until: null } : list);
    }
    const m = url.match(/^\/billing\/gifts\/([0-9a-f-]{36})(\/redeem|\/confirm)?$/);
    if (m) {
        const gid = m[1];
        if (gid === G.loading) return new Promise(() => {});
        if (gid === G.broken) return Promise.reject(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }));
        const v = views[gid];
        if (!v) return fail(404, { code: 'gift_not_found', message: 'Not found' });
        if (m[2] === '/redeem') {
            h.__gifts.redeemCalls++;
            const already = v.status === 'redeemed';
            const next: GiftView = { ...v, status: 'redeemed', redemption_kind: 'time', grant_end: '2026-12-17T15:00:00Z', redeemed_at: '2026-11-17T16:00:00Z' };
            views[gid] = next;
            return ok(cfg, { gift: next, outcome: 'time', pro_until: next.grant_end, credit_amount: null, already });
        }
        return ok(cfg, v);
    }
    return fail(404, { message: `harness: no mock for ${method} ${url}` });
};

const friends = [
    { user_id: 'u-alex', username: 'alex', discriminator: 7 },
    { user_id: 'u-sam', username: 'sam.k', discriminator: 1204 },
    { user_id: 'u-jo', username: 'jo', discriminator: 42 },
    { user_id: 'u-mira', username: 'mira', discriminator: 88 },
    { user_id: 'u-ola', username: 'ola', discriminator: 3 },
    { user_id: 'u-bex', username: 'bex', discriminator: 911 },
    { user_id: 'u-nik', username: 'nikolai_the_long_named_friend', discriminator: 5 },
    { user_id: 'u-tess', username: 'tess', discriminator: 61 },
];
const NAMES: Record<string, string> = { 'u-alex': 'Alex', 'u-sam': 'Sam', 'u-jo': 'Jo', 'u-mira': 'Mira' };
const actions: GiftActions = {
    friends,
    nameFor: (uid) => (uid ? NAMES[uid] ?? null : null),
    sendGiftCard: async () => { h.__gifts.sendCalls++; return q.get('send') !== 'fail'; },
};

/** A stand-in chat message: avatar, name, time, then the card. */
const Msg: React.FC<{ who: string; mine?: boolean; children: React.ReactNode; note?: string }> = ({ who, mine, children, note }) => (
    <div style={{ display: 'flex', gap: 12, padding: '10px 0' }} data-note={note}>
        <span style={{ flex: 'none', width: 38, height: 38, borderRadius: '50%', background: mine ? '#25E0C8' : '#FFC94D', color: '#06251F', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--cl-font-display)', fontWeight: 600 }}>{who[0]}</span>
        <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--cl-text)', marginBottom: 6 }}>
                {who} <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--cl-faint)', marginLeft: 6 }}>Today at 4:20 PM</span>
                {note && <span style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--cl-lume)', marginLeft: 10, letterSpacing: '.06em', textTransform: 'uppercase' }}>{note}</span>}
            </div>
            {children}
        </div>
    </div>
);

const Cards = () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 400px)', gap: '6px 28px', padding: 24 }}>
        <Msg who="Alex" note="unopened"><GiftCardEmbed giftId={G.unopened} isMine={false} senderName="Alex" /></Msg>
        <Msg who="Alex" note="opened · time"><GiftCardEmbed giftId={G.openedTime} isMine={false} senderName="Alex" /></Msg>
        <Msg who="Alex" note="opened · credit"><GiftCardEmbed giftId={G.openedCredit} isMine={false} senderName="Alex" /></Msg>
        <Msg who="Robin" mine note="sender · waiting"><GiftCardEmbed giftId={G.sentWaiting} isMine senderName="Robin" /></Msg>
        <Msg who="Robin" mine note="sender · accepted"><GiftCardEmbed giftId={G.sentAccepted} isMine senderName="Robin" /></Msg>
        <Msg who="Alex" note="refunded"><GiftCardEmbed giftId={G.refunded} isMine={false} senderName="Alex" /></Msg>
        <Msg who="Mallory" note="third party / 404"><GiftCardEmbed giftId={G.missing} isMine={false} senderName="Mallory" /></Msg>
        <Msg who="Alex" note="network error"><GiftCardEmbed giftId={G.broken} isMine={false} senderName="Alex" /></Msg>
        <Msg who="Alex" note="loading"><GiftCardEmbed giftId={G.loading} isMine={false} senderName="Alex" /></Msg>
        <Msg who="Alex" note="expired (90 days)"><GiftCardEmbed giftId={G.expired} isMine={false} senderName="Alex" /></Msg>
        <Msg who="Robin" mine note="sender · expired"><GiftCardEmbed giftId={G.expiredSent} isMine senderName="Robin" /></Msg>
    </div>
);

/** The Pro welcome layer, mounted when the card asks for it (gifts-stubs.ts). */
const WelcomeLayer = () => {
    const [open, setOpen] = useState(false);
    React.useEffect(() => {
        const on = () => setOpen(true);
        window.addEventListener('harness:celebrate', on);
        return () => window.removeEventListener('harness:celebrate', on);
    }, []);
    return open ? <ProWelcome name="robin" onClose={() => setOpen(false)} /> : null;
};

const UnwrapCard = () => (q.get('side') === 'sender'
    ? <Msg who="Robin" mine><GiftCardEmbed giftId={G.sentWaiting} isMine senderName="Robin" /></Msg>
    : <Msg who="Alex"><GiftCardEmbed giftId={G.unopened} isMine={false} senderName="Alex" /></Msg>);

const Unwrap = () => (q.get('welcome') === '1' ? (
    // A stand-in of the app around the card, so the welcome covers something real-sized.
    <div style={{ position: 'fixed', inset: 0, display: 'flex', background: '#0B0F1E' }}>
        <nav style={{ width: 72, borderRight: '1px solid #2A3558', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {Array.from({ length: 6 }, (_, i) => <i key={i} style={{ width: 48, height: 48, borderRadius: 16, background: '#1C2542' }} />)}
        </nav>
        <aside style={{ width: 240, background: '#131A30', borderRight: '1px solid #2A3558', padding: '18px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {Array.from({ length: 9 }, (_, i) => <b key={i} style={{ height: 14, borderRadius: 7, background: '#1C2542', width: `${60 + (i * 17) % 40}%` }} />)}
        </aside>
        <main style={{ flex: 1, minWidth: 0, padding: '18px 28px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
            <Msg who="Alex"><span style={{ fontSize: 14.5, color: 'var(--cl-text)' }}>happy birthday!! 🎁</span></Msg>
            <UnwrapCard />
        </main>
        <WelcomeLayer />
    </div>
) : (
    <div style={{ padding: '18px 24px' }}>
        <UnwrapCard />
    </div>
));

const Section = () => (
    <div style={{ padding: 28, maxWidth: 760 }}>
        <GiftsSection />
    </div>
);

const Pick = () => {
    const [open, setOpen] = useState(true);
    return (
        <div style={{ position: 'fixed', inset: 0, background: '#0B0F1E' }}>
            <div style={{ padding: 28, maxWidth: 760, opacity: 0.6 }}><GiftsSection /></div>
            {open && <GiftProModal onClose={() => setOpen(false)} />}
        </div>
    );
};

const Success = () => {
    const card = (q.get('card') ?? 'sent') as 'sent' | 'failed' | 'sending';
    return (
        <div style={{ position: 'fixed', inset: 0, background: '#0B0F1E' }}>
            <GiftModalFrame onClose={() => {}}>
                {q.get('scene') === 'slow'
                    ? <GiftSlowPanel onClose={() => {}} />
                    : <GiftSuccessPanel recipientName="Alex" months={12} cardSend={card} onResend={() => {}} onDone={() => {}} />}
            </GiftModalFrame>
        </div>
    );
};

const scene = q.get('scene') ?? 'cards';
const App = () => (
    <GiftActionsProvider value={actions}>
        {scene === 'cards' ? <Cards />
            : scene === 'unwrap' ? <Unwrap />
            : scene === 'section' ? <Section />
            : scene === 'pick' ? <Pick />
            : <Success />}
    </GiftActionsProvider>
);

createRoot(document.getElementById('root')!).render(<App />);
