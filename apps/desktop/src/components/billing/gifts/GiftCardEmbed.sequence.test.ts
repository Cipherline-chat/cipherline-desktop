// @vitest-environment jsdom
/**
 * Accept -> unwrap -> Pro welcome ORDERING on the recipient's gift card.
 *
 * Owner 2026-11-18 (watching an accept on a machine with animations off): it
 * "went straight to the welcome to pro card". The welcome must follow a
 * finished unwrap, always:
 *
 *   full motion     welcome only after the unwrap's LAST keyframe ends
 *                   (animationend), with a safety fallback slightly longer than
 *                   the animation so it can never hang
 *   reduced motion  a motion-safe unwrap step first (opacity cross-fade), then
 *                   the welcome
 *   window hidden   the welcome waits for the window to be visible again
 *   already         (accepted elsewhere / a retry) no unwrap, no welcome
 *   announcements   "Gift accepted" is in the live region before the welcome
 *
 * The welcome itself is `celebratePro()` (SubscriptionContext); refresh() is
 * the shared status re-read. Neither's behaviour is under test here — only
 * WHEN the card calls them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GIFT = '11111111-1111-4111-8111-000000000001';
const motion = vi.hoisted(() => {
    // jsdom has no matchMedia; the cl kit reads it at import time.
    const w = window as unknown as { matchMedia?: unknown };
    if (typeof w.matchMedia !== 'function') {
        w.matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    }
    return { reduced: false };
});
const calls = vi.hoisted(() => ({
    log: [] as string[],
    refresh: 0,
    celebrate: 0,
    announcedAtCelebrate: null as string | null,
    already: false,
    outcome: 'time' as 'time' | 'credit',
}));

vi.mock('../../../utils/a11y/motionPrefs', async (orig) => ({
    ...(await orig<typeof import('../../../utils/a11y/motionPrefs')>()),
    useCelebrationReduced: () => motion.reduced,
}));
vi.mock('framer-motion', async (orig) => ({
    ...(await orig<typeof import('framer-motion')>()),
    useReducedMotion: () => motion.reduced,
}));
vi.mock('../../../contexts/SubscriptionContext', () => ({
    useSubscription: () => ({
        refresh: async () => { calls.refresh++; calls.log.push('refresh'); },
        celebratePro: () => {
            calls.celebrate++;
            calls.log.push('welcome');
            calls.announcedAtCelebrate = document.querySelector('[role="status"]')?.textContent ?? null;
        },
    }),
}));
const view = (status: 'paid' | 'redeemed') => ({
    gift_id: GIFT, months: 1, status, role: 'recipient', other_user_id: 'u-alex',
    created_at: '2026-11-17T15:00:00Z', paid_at: '2026-11-17T15:00:04Z',
    redeemed_at: status === 'redeemed' ? '2026-11-18T16:00:00Z' : null,
    redemption_kind: status === 'redeemed' ? 'time' : null,
    amount_subtotal: null, amount_tax: null, amount_total: null, currency: null,
    grant_end: status === 'redeemed' ? '2026-12-18T16:00:00Z' : null, credit_amount: null, ended_reason: null,
});
vi.mock('./giftsApi', () => {
    const api = {
        get: async () => view('paid'),
        redeem: async () => {
            calls.log.push('redeem');
            return { gift: view('redeemed'), outcome: calls.outcome, pro_until: '2026-12-18T16:00:00Z', credit_amount: null, already: calls.already };
        },
    };
    return { useGiftsApi: () => api, isGiftNotFound: () => false };
});

import { GiftCardEmbed } from './GiftCardEmbed';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let visibility: DocumentVisibilityState = 'visible';

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const advance = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); await flush(); };
const box = () => host!.querySelector<HTMLElement>('.gb')!;
const card = () => host!.querySelector<HTMLElement>('[data-testid="gift-card"]')!;
const status = () => host!.querySelector('[role="status"]')?.textContent ?? '';

async function mount() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root!.render(React.createElement(GiftCardEmbed, { giftId: GIFT, isMine: false, senderName: 'Alex' }));
    });
    await flush();
}
async function accept() {
    const btn = host!.querySelector<HTMLButtonElement>('.gft-actions button');
    expect(btn, 'Accept button').toBeTruthy();
    await act(async () => { btn!.click(); });
    await flush();
}
/** What the browser does when a CSS animation on `selector` inside the box ends. */
async function animationEnd(name: string, selector: string) {
    const el = box().querySelector(selector) ?? box();
    const ev = new Event('animationend', { bubbles: true });
    Object.defineProperty(ev, 'animationName', { value: name });
    await act(async () => { el.dispatchEvent(ev); });
    await flush();
}
async function setVisibility(v: DocumentVisibilityState) {
    visibility = v;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
}

beforeEach(() => {
    vi.useFakeTimers();
    motion.reduced = false;
    calls.log = []; calls.refresh = 0; calls.celebrate = 0; calls.announcedAtCelebrate = null;
    calls.already = false; calls.outcome = 'time';
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility === 'hidden' });
});
afterEach(() => {
    act(() => { root?.unmount(); });
    host?.remove();
    root = null; host = null;
    vi.useRealTimers();
});

describe('gift card: the Pro welcome follows a finished unwrap', () => {
    it('full motion: no welcome while unwrapping, not even at the nominal end, only once the last keyframe ends', async () => {
        await mount();
        await accept();
        expect(box().dataset.state).toBe('unwrapping');
        expect(calls.celebrate).toBe(0);
        // The nominal animation length has passed, but the browser has not said
        // the unwrap ended (a late-starting animation is still on screen).
        await advance(1300);
        expect(calls.celebrate, 'welcome must not be guessed from a timer that can fire early').toBe(0);
        expect(card().dataset.kind).toBe('unopened');
        // An EARLIER keyframe ending is not the end of the unwrap.
        await animationEnd('gb-lid-off', '.gb-lid');
        expect(calls.celebrate).toBe(0);
        await animationEnd('gb-halo-in', '.gb-halo');
        expect(calls.celebrate).toBe(1);
        expect(box().dataset.state).toBe('open');
        expect(card().dataset.kind).toBe('opened');
        expect(calls.log).toEqual(['redeem', 'refresh', 'welcome']);
        // More animation events and time change nothing.
        await animationEnd('gb-halo-in', '.gb-halo');
        await advance(10_000);
        expect(calls.celebrate).toBe(1);
        expect(calls.refresh).toBe(1);
    });

    it('full motion: the safety fallback plays the welcome when animationend never fires (slightly after the animation)', async () => {
        await mount();
        await accept();
        await advance(1500);
        expect(calls.celebrate).toBe(0);
        await advance(400);
        expect(calls.celebrate).toBe(1);
        expect(box().dataset.state).toBe('open');
        await advance(10_000);
        expect(calls.celebrate).toBe(1);
    });

    it('window hidden during the unwrap: the welcome is neither lost nor shown first — it waits for the window', async () => {
        await mount();
        await accept();
        await setVisibility('hidden');
        await advance(10_000);
        expect(calls.celebrate).toBe(0);
        expect(calls.refresh).toBe(0);
        await setVisibility('visible');
        // Back on screen: the (time-based) animation has finished; its end
        // event or the short grace after becoming visible completes it.
        await advance(1000);
        expect(calls.celebrate).toBe(1);
        expect(calls.log).toEqual(['redeem', 'refresh', 'welcome']);
    });

    it('an animationend while hidden still waits for the window to be visible', async () => {
        await mount();
        await accept();
        await setVisibility('hidden');
        await animationEnd('gb-halo-in', '.gb-halo');
        expect(calls.celebrate).toBe(0);
        await setVisibility('visible');
        await advance(1000);
        expect(calls.celebrate).toBe(1);
    });

    it('reduced motion: a motion-safe fade step plays first, then the welcome', async () => {
        motion.reduced = true;
        await mount();
        await accept();
        // Not the instant jump to "open" the owner saw.
        expect(box().dataset.state).toBe('unwrapping');
        expect(box().dataset.motion).toBe('fade');
        expect(calls.celebrate).toBe(0);
        expect(calls.refresh).toBe(0);
        await advance(500);
        expect(calls.celebrate).toBe(0);
        await animationEnd('gb-xfade-in', '.gb-crown');
        expect(calls.celebrate).toBe(1);
        expect(box().dataset.state).toBe('open');
        expect(box().dataset.motion).toBe('still');
        expect(calls.log).toEqual(['redeem', 'refresh', 'welcome']);
    });

    it('reduced motion: the fallback also completes the fade step if animationend never fires', async () => {
        motion.reduced = true;
        await mount();
        await accept();
        await advance(900);
        expect(calls.celebrate).toBe(0);
        await advance(500);
        expect(calls.celebrate).toBe(1);
    });

    it('already redeemed (another device / a retry): no unwrap replay and no welcome', async () => {
        calls.already = true;
        await mount();
        await accept();
        expect(box().dataset.state).toBe('open');
        await advance(10_000);
        expect(calls.celebrate).toBe(0);
        expect(calls.refresh).toBe(1);
    });

    it('a credit outcome (existing subscriber) unwraps but plays no welcome', async () => {
        calls.outcome = 'credit';
        await mount();
        await accept();
        expect(box().dataset.state).toBe('unwrapping');
        await animationEnd('gb-halo-in', '.gb-halo');
        await advance(10_000);
        expect(calls.celebrate).toBe(0);
        expect(calls.refresh).toBe(1);
    });

    it('screen readers hear "Gift accepted" before the welcome', async () => {
        await mount();
        await accept();
        expect(status()).toMatch(/^Gift accepted\./);
        await animationEnd('gb-halo-in', '.gb-halo');
        expect(calls.announcedAtCelebrate).toMatch(/^Gift accepted\./);
    });
});
