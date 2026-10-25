// @vitest-environment jsdom
/**
 * TrialBanner on the shared ClBanner primitive. The redesign is visual and
 * structural only, so these pin the OLD behaviour: when it appears, which
 * handler each control calls, and the dismissal persistence keys.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});

const { kv, sub, cardModal } = vi.hoisted(() => ({
    kv: new Map<string, string>(),
    sub: {
        status: null as null | Record<string, unknown>,
        extendTrial: vi.fn(async () => ({ ok: true as boolean, message: undefined as string | undefined })),
        openInAppCheckout: vi.fn(),
        refresh: vi.fn(async () => {}),
    },
    cardModal: { open: false },
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ userId: 'u1' }) }));
vi.mock('../../contexts/SubscriptionContext', () => ({ useSubscription: () => sub }));
vi.mock('../../utils/secureLocalStore', () => ({
    default: { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => { kv.set(k, v); } },
}));
vi.mock('./UpdateCardModal', () => ({
    UpdateCardModal: (p: { open: boolean }) => { cardModal.open = p.open; return null; },
}));

import { TrialBanner } from './TrialBanner';

const h = React.createElement;
let host: HTMLDivElement;
let root: Root;
const render = () => act(() => { root.render(h(TrialBanner)); });
const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector(sel) as T | null;
const click = (sel: string) => act(() => { q<HTMLButtonElement>(sel)!.click(); });
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };

const trial = (over: Record<string, unknown> = {}) => ({
    subscription_status: 'trial', effective_status: 'active', trial_days_left: 3, trial_extended: false,
    plan_amount: 250, plan_currency: 'usd', ...over,
});

const localDay = () => {
    const d = new Date();
    return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
};

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    kv.clear();
    sub.status = trial();
    sub.extendTrial.mockClear(); sub.extendTrial.mockResolvedValue({ ok: true, message: undefined });
    sub.openInAppCheckout.mockClear();
    sub.refresh.mockClear();
    cardModal.open = false;
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('TrialBanner: trial ending', () => {
    it('shows in the last 3 days with the new copy, the price, and Upgrade as the primary action', () => {
        render();
        expect(q('.cl-banner')).not.toBeNull();
        expect(q('.cl-banner__title')?.textContent).toBe('3 days left in your trial');
        expect(q('.cl-banner__desc')?.textContent).toContain('Keep video, screen share and 2 GB uploads with Pro');
        expect(q('[data-action="price"]')?.textContent).toMatch(/\$2\.50\/mo \+ tax/);
        expect(q('[data-action="upgrade"] button')?.textContent).toBe('Upgrade');
        // The price is secondary text, not crammed into the button.
        expect(q('[data-action="upgrade"]')?.textContent).not.toMatch(/\$/);
        expect(q('[data-action="extend"] button')?.textContent).toBe('+3 days');
        expect(q('.cl-banner__x')?.getAttribute('aria-label')).toBe('Dismiss until tomorrow');
    });

    it('title wording at 2, 1 and 0 days; the last day is a warning, earlier is info', () => {
        sub.status = trial({ trial_days_left: 2 }); render();
        expect(q('.cl-banner__title')?.textContent).toBe('2 days left in your trial');
        expect(q('.cl-banner')?.getAttribute('data-banner-tone')).toBe('info');
        sub.status = trial({ trial_days_left: 1 }); render();
        expect(q('.cl-banner__title')?.textContent).toBe('Your trial ends tomorrow');
        expect(q('.cl-banner')?.getAttribute('data-banner-tone')).toBe('warning');
        sub.status = trial({ trial_days_left: 0 }); render();
        expect(q('.cl-banner__title')?.textContent).toBe('Your trial ends today');
    });

    it('Upgrade calls openInAppCheckout', () => {
        render();
        click('[data-action="upgrade"] button');
        expect(sub.openInAppCheckout).toHaveBeenCalledTimes(1);
    });

    it('+3 days calls extendTrial; a refusal shows its message beside the copy', async () => {
        sub.extendTrial.mockResolvedValue({ ok: false, message: 'Already extended elsewhere.' });
        render();
        click('[data-action="extend"] button');
        await flush();
        expect(sub.extendTrial).toHaveBeenCalledTimes(1);
        expect(q('.cl-banner')?.textContent).toContain('Already extended elsewhere.');
    });

    it('NEGATIVE: an already-extended trial has no +3 days action', () => {
        sub.status = trial({ trial_extended: true });
        render();
        expect(q('[data-action="extend"]')).toBeNull();
        expect(q('[data-action="upgrade"]')).not.toBeNull();
    });

    it('Dismiss persists TODAY under the unchanged key and hides the banner', () => {
        render();
        click('.cl-banner__x');
        expect(kv.get('cipherline_trial_banner_dismissed_u1')).toBe(localDay());
        expect(q('.cl-banner')).toBeNull();
    });

    it('NEGATIVE: not shown when dismissed today, but returns when the stored day is yesterday', () => {
        kv.set('cipherline_trial_banner_dismissed_u1', localDay());
        render();
        expect(q('.cl-banner')).toBeNull();
        kv.set('cipherline_trial_banner_dismissed_u1', '2000-01-01');
        render();
        expect(q('.cl-banner')).not.toBeNull();
    });

    it.each([
        ['more than 3 days left', trial({ trial_days_left: 4 })],
        ['an expired trial (status stays trial forever)', trial({ effective_status: 'expired' })],
        ['an admin-comped account', trial({ is_comp: true })],
        ['a paid subscription', trial({ subscription_status: 'active' })],
        ['no status yet', null],
    ])('NEGATIVE: renders nothing for %s', (_n, status) => {
        sub.status = status as Record<string, unknown> | null;
        render();
        expect(host.innerHTML).toBe('');
    });
});

describe('TrialBanner: payment failed', () => {
    const pastDue = () => ({ subscription_status: 'past_due', effective_status: 'active', trial_days_left: 0, trial_extended: true });

    it('is a danger (assertive) banner that outranks the trial copy and opens the card modal', () => {
        sub.status = pastDue();
        render();
        const b = q('.cl-banner')!;
        expect(b.getAttribute('data-banner-tone')).toBe('danger');
        expect(b.getAttribute('role')).toBe('alert');
        expect(q('.cl-banner__title')?.textContent).toBe('Your last payment failed');
        expect(cardModal.open).toBe(false);
        click('[data-action="update-payment"] button');
        expect(cardModal.open).toBe(true);
    });

    it('dismissal counts under the unchanged key and stops after 3 appearances', () => {
        sub.status = pastDue();
        render();
        click('.cl-banner__x');
        expect(kv.get('cipherline_pastdue_banner_shows_u1')).toBe('1');
        // The tick re-rendered it with the persisted count; two more dismissals end it.
        click('.cl-banner__x');
        expect(kv.get('cipherline_pastdue_banner_shows_u1')).toBe('2');
        click('.cl-banner__x');
        expect(kv.get('cipherline_pastdue_banner_shows_u1')).toBe('3');
        expect(q('.cl-banner')).toBeNull();
    });

    it('NEGATIVE: already shown 3 times, nothing renders', () => {
        sub.status = pastDue();
        kv.set('cipherline_pastdue_banner_shows_u1', '3');
        render();
        expect(q('.cl-banner')).toBeNull();
    });
});
