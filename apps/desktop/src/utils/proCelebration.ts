/**
 * When to play the "you're Pro" celebration (components/ProWelcome.tsx).
 *
 * The rule is "once per PURCHASE", and the app learns about a purchase in
 * three different ways:
 *
 *  1. In-app checkout — InAppCheckout confirms activation with the server
 *     itself, so SubscriptionContext celebrates the moment it reports success
 *     (no status round-trip needed, no race against the status poll).
 *  2. Hosted-checkout fallback — the payment happens in the system browser;
 *     the app notices when the status flips on the next focus refresh / poll.
 *  3. Paid somewhere else (the website account portal, another device), or
 *     trial → paid while the app was closed — likewise noticed on a status read.
 *
 * (2) and (3) are "observed transitions": this device last saw the account on
 * the free side, and now sees an active Stripe subscription. So we persist the
 * last tier this device SAW, per account, and celebrate only on a free → paid
 * edge. That is what the old `cipherline_pro_welcomed_<uid>` flag got wrong in
 * both directions: it fired for an existing subscriber the first time they
 * signed in on a NEW device (no flag there yet), and the in-app path wrote it
 * from a poll that raced the very status update that mounted the celebration.
 *
 * A device with no record yet (fresh install / first sign-in) records what it
 * sees without celebrating — unless this session itself started a hosted
 * checkout, in which case the paid status IS the purchase we were waiting for.
 *
 * Comps never trigger it: a complimentary grant has no Stripe subscription
 * (`has_subscription` is false), so it is not a purchase.
 */

export type ProTier = 'pro' | 'free';

/** The fields of GET /v1/billing/status this decision reads. */
export interface ProStatusLike {
    has_subscription: boolean;
    subscription_status: string;
}

/** Per-account, per-device record of the last tier this device observed. */
export const proSeenKey = (userId: string): string => `cipherline_pro_seen_${userId}`;

/**
 * A Stripe subscription that is being paid for. `canceled_pending` and
 * `past_due` count as Pro on purpose: resuming a pending cancellation or
 * fixing a failed card is not a new purchase and must not replay the
 * celebration when the status returns to `active`.
 */
export function proTierOf(status: ProStatusLike): ProTier {
    if (!status.has_subscription) return 'free';
    return status.subscription_status === 'active'
        || status.subscription_status === 'canceled_pending'
        || status.subscription_status === 'past_due'
        ? 'pro' : 'free';
}

/** True only for a fully active, Stripe-backed subscription. */
export function isActivePaid(status: ProStatusLike): boolean {
    return status.has_subscription && status.subscription_status === 'active';
}

export function parseProTier(raw: string | null | undefined): ProTier | null {
    return raw === 'pro' || raw === 'free' ? raw : null;
}

/**
 * Pure decision. `previous` is what this device last recorded (null = never),
 * `hostedCheckoutPending` is true when this session opened the browser
 * checkout and has not yet seen it complete.
 */
export function shouldCelebratePro(
    previous: ProTier | null,
    status: ProStatusLike,
    hostedCheckoutPending: boolean,
): boolean {
    if (!isActivePaid(status)) return false;
    if (previous === 'free') return true;
    if (previous === null) return hostedCheckoutPending;
    return false;
}

export interface ProSeenStore {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

/**
 * Read the record, decide, and write the new record back. Returns whether to
 * celebrate. Writing happens BEFORE the celebration mounts, so a reload or an
 * HMR remount mid-celebration can never replay it.
 */
export function observeProStatus(
    store: ProSeenStore,
    userId: string,
    status: ProStatusLike,
    hostedCheckoutPending: boolean,
): boolean {
    const key = proSeenKey(userId);
    let previous: ProTier | null = null;
    try { previous = parseProTier(store.getItem(key)); } catch { /* unreadable = no record */ }
    const celebrate = shouldCelebratePro(previous, status, hostedCheckoutPending);
    const next = proTierOf(status);
    if (next !== previous) {
        try { store.setItem(key, next); } catch { /* best effort */ }
    }
    return celebrate;
}

/** The in-app checkout already knows it succeeded: record Pro and celebrate. */
export function recordProPurchase(store: ProSeenStore, userId: string): void {
    try { store.setItem(proSeenKey(userId), 'pro'); } catch { /* best effort */ }
}
