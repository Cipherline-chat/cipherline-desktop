/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/settings-descent.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import React from 'react';
import { TrialEndingPromptView } from '../src/components/billing/TrialEndingPrompt';
import { trialPromptCopy } from '../src/components/billing/trialEndingPromptRule';
import { BillingTab } from '../src/components/billing/BillingTab';
import { UpgradePromptModal } from '../src/components/billing/UpgradePromptModal';

/**
 * Trial-ending prompt + Settings → Subscription harness. The prompt view, its copy builder,
 * BillingTab, FounderStatusPanel and the app stylesheets are the real ones; only the contexts
 * are stubbed (trial-prompt-stubs.tsx) and the billing status below is fixture data.
 *
 * ?scene=prompt&founder=open|closed&days=3|2|1
 * ?scene=billing&who=founder|trial|trial-closed|former
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'prompt';
const days = Number(q.get('days') ?? 2);

const founderBlock = (over: Record<string, unknown> = {}) => ({
    limit: 10000, claimed: 3842, remaining: 6158, open: true, number: null, price_locked: false, lock_ended_at: null, ...over,
});
const trialStatus = (over: Record<string, unknown> = {}) => ({
    subscription_status: 'trial', effective_status: 'active', is_comp: false, trial_days_left: days,
    trial_ends_at: new Date(Date.now() + days * 86_400_000 - 3_600_000).toISOString(), trial_extended: false,
    has_subscription: false, stripe_customer_id: null, current_period_end: null,
    plan_amount: 250, plan_currency: 'usd', founder: founderBlock(), ...over,
});
const closed = founderBlock({ claimed: 10000, remaining: 0, open: false });
// Yearly plans: founding $2.50/mo | $30/yr, regular $4.99/mo | $49.99/yr.
const FOUNDER_PRICES = { month: { amount: 250, currency: 'usd' }, year: { amount: 3000, currency: 'usd' } };
const REGULAR_PRICES = { month: { amount: 499, currency: 'usd' }, year: { amount: 4999, currency: 'usd' } };
const active = (over: Record<string, unknown> = {}) => ({
    subscription_status: 'active', effective_status: 'active', is_comp: false, trial_days_left: 0, trial_ends_at: null,
    trial_extended: true, has_subscription: true, stripe_customer_id: 'cus_h', current_period_end: '2027-11-12T12:00:00Z',
    plan_amount: 499, plan_currency: 'usd', founder: null,
    plan_interval: 'month', intervals_available: ['month', 'year'], plan_prices: REGULAR_PRICES, pending_interval: null, pending_interval_at: null, ...over,
});

const statuses: Record<string, any> = {
    trial: trialStatus({ trial_days_left: 5, trial_ends_at: new Date(Date.now() + 5 * 86_400_000 - 3_600_000).toISOString() }),
    'trial-closed': trialStatus({ trial_days_left: 5, trial_ends_at: new Date(Date.now() + 5 * 86_400_000 - 3_600_000).toISOString(), founder: closed }),
    'monthly-regular': active(),
    'yearly-founder': active({ plan_interval: 'year', plan_amount: 3000, plan_prices: FOUNDER_PRICES, founder: founderBlock({ number: 1234, member: true, price_locked: true }) }),
    'yearly-pending': active({ plan_interval: 'year', plan_amount: 3000, plan_prices: FOUNDER_PRICES, founder: founderBlock({ number: 1234, member: true, price_locked: true }), pending_interval: 'month', pending_interval_at: '2027-11-12T12:00:00Z' }),
    'trial-yearly': trialStatus({ trial_days_left: 5, trial_ends_at: new Date(Date.now() + 5 * 86_400_000 - 3_600_000).toISOString(), intervals_available: ['month', 'year'], plan_prices: FOUNDER_PRICES }),
    founder: {
        subscription_status: 'active', effective_status: 'active', is_comp: false, trial_days_left: 0, trial_ends_at: null,
        trial_extended: true, has_subscription: true, stripe_customer_id: 'cus_h', current_period_end: '2026-12-01T00:00:00Z',
        plan_amount: 250, plan_currency: 'usd', founder: founderBlock({ number: 1234, price_locked: true }),
    },
};

const Settings: React.FC = () => (
    <div style={{ minHeight: '100vh', background: 'var(--cl-abyss)', color: 'var(--cl-text)', fontFamily: 'var(--cl-font-body)', display: 'flex', justifyContent: 'center' }}>
        <div className="cl-kit" style={{ width: 720, padding: '36px 24px 48px' }}>
            <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--cl-faint)' }}>Settings</div>
                <h1 style={{ fontFamily: 'var(--cl-font-display)', fontWeight: 600, fontSize: 30, margin: '4px 0 0' }}>Subscription</h1>
            </div>
            <section>
                <BillingTab />
            </section>
        </div>
    </div>
);

const AppBehind: React.FC = () => (
    <div style={{ width: '100vw', height: '100vh', background: 'var(--cl-abyss)', display: 'flex' }}>
        <div style={{ width: 72, borderRight: '1px solid var(--cl-border)' }} />
        <div style={{ width: 260, borderRight: '1px solid var(--cl-border)', background: 'var(--cl-deep)' }} />
        <div style={{ flex: 1 }} />
    </div>
);

let el: React.ReactNode;
if (scene === 'billing') {
    (window as any).__sub = statuses[q.get('who') ?? 'founder'];
    el = <Settings />;
} else if (scene === 'upgrade') {
    (window as any).__sub = trialStatus({ trial_days_left: 0, effective_status: 'expired', intervals_available: ['month', 'year'], plan_prices: q.get('prices') === 'regular' ? REGULAR_PRICES : FOUNDER_PRICES });
    el = (<>
        <AppBehind />
        <UpgradePromptModal open reason="video" onClose={() => {}} />
    </>);
} else {
    const yearly = q.get('yearly');
    const st = trialStatus({
        ...(q.get('founder') === 'closed' ? { founder: closed } : {}),
        ...(yearly ? { intervals_available: ['month', 'year'], plan_prices: yearly === 'regular' ? REGULAR_PRICES : FOUNDER_PRICES } : {}),
        ...(yearly === 'regular' ? { plan_amount: 499 } : {}),
    });
    el = (<>
        <AppBehind />
        <TrialEndingPromptView open copy={trialPromptCopy(st as any)} onKeep={() => {}} onLater={() => {}} />
    </>);
}
createRoot(document.getElementById('root')!).render(el);
