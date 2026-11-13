/* eslint-disable -- harness stubs, not shipped */
// Stand-ins for the contexts/hooks the trial prompt and BillingTab read, in this harness only.
// TrialEndingPromptView, BillingTab, FounderStatusPanel, ClModal/ClButton and every stylesheet are REAL.
declare global { interface Window { __sub?: any } }

export const useAuth = () => ({ token: 'harness-token', userId: 'u-me', deviceId: 'dev-1' });
// Callback identities MUST be stable: BillingTab's effects depend on them, and a
// fresh function per render re-runs its fetch effect forever (it starved input).
const sub = {
    refresh: async () => {}, extendTrial: async () => ({ ok: true }), openInAppCheckout: () => {},
    setCancellation: async () => { (window as any).__cancelCalls = ((window as any).__cancelCalls ?? 0) + 1; return { ok: true }; },
    fetchPaymentMethod: async () => ({ ok: true, paymentMethod: window.__sub?.stripe_customer_id ? { id: 'pm', type: 'card', brand: 'visa', last4: '4242', exp_month: 8, exp_year: 2028 } : null }),
    fetchInvoices: async () => ({ ok: true, invoices: window.__sub?.stripe_customer_id ? [
        { id: 'in_2', number: 'B1C2-0002', created: '2026-11-01T00:00:00Z', amount_paid: 268, amount_due: 268, currency: 'usd', status: 'paid', hosted_invoice_url: 'https://example.invalid', invoice_pdf: null },
        { id: 'in_1', number: 'B1C2-0001', created: '2026-10-01T00:00:00Z', amount_paid: 268, amount_due: 268, currency: 'usd', status: 'paid', hosted_invoice_url: 'https://example.invalid', invoice_pdf: null },
    ] : [] }),
};
// Interval switch (yearly plans): read-only preview + change, shaped like the API's replies.
const END = '2027-11-12T12:00:00Z';
const previewIntervalChange = async (i: string) => ({ ok: true, preview: i === 'year'
    ? { interval: 'year', effective: 'now', amount_due_now: window.__sub?.founder?.price_locked ? 1500 : 2400, currency: 'usd', new_price: window.__sub?.plan_prices?.year?.amount ?? 4999, effective_at: END }
    : { interval: 'month', effective: 'period_end', amount_due_now: 0, currency: 'usd', new_price: window.__sub?.plan_prices?.month?.amount ?? 499, effective_at: END } });
const changeInterval = async () => ({ ok: true, result: { plan_interval: 'year', pending_interval: null, pending_interval_at: null, current_period_end: END } });
export const useSubscription = () => ({ status: window.__sub ?? null, statusError: null, ...sub, previewIntervalChange, changeInterval, openInAppCheckout: sub.openInAppCheckout });
const toast = { push: () => {} };
const storage = { overCount: 0 };
export const useToast = () => toast;
export const useOwnedServersOverFreeStorage = () => storage;
export const nudges = { notify: () => {}, dismiss: () => {} };
export const UpdateCardModal = () => null;

const kv = new Map<string, string>();
export const secureLocalStore = {
    getItem: (k: string) => kv.get(k) ?? null,
    setItem: (k: string, v: string) => { kv.set(k, v); },
    removeItem: (k: string) => { kv.delete(k); },
    isAccountReady: () => true,
    whenAccountReady: async () => {},
};

const referral = { referral_code: 'K7QX2M', referrals_count: 2, rewards_claimed: 2, max_referrals: 5, days_per_referral: 7 };
const axios = { get: async () => ({ data: referral }), post: async () => ({ data: {} }), isAxiosError: () => false };
// One default export serves both default imports this harness aliases here (axios, secureLocalStore).
export default { ...axios, ...secureLocalStore } as any;
