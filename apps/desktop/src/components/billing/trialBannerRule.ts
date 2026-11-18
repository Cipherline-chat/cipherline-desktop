/**
 * Whether the "N days left in your free trial" banner applies.
 *
 * Keyed off the server's verdict, not the raw subscription_status enum: a
 * lapsed trial keeps status 'trial' forever (so effective_status must be
 * 'active'), and an admin-comped account must never see a trial countdown even
 * if its raw status was ever left at 'trial' (the referral-bonus bug did exactly
 * that to three comped accounts). The server now also reports a live comp as
 * 'active', so this is the client half of the same guarantee for builds talking
 * to a server that predates it.
 */
export interface TrialBannerStatus {
    subscription_status: string;
    effective_status: string;
    is_comp?: boolean;
    /** A running gifted Pro period (a friend paid for it). */
    gift_pro_until?: string | null;
}

export function isTrialBannerEligible(s: TrialBannerStatus): boolean {
    if (s.is_comp === true) return false;
    // A gifted account is on Pro a friend paid for, not on a trial countdown:
    // its raw status can still read 'trial' (a lapsed trial, or a gift stacked
    // after a live one), and "0 days left" / "subscribe" nags would be wrong.
    if (s.gift_pro_until) return false;
    return s.subscription_status === 'trial' && s.effective_status === 'active';
}
