/**
 * Signed-in handling of a friend's profile-share QR / referral link
 * (`cipherline://ref/<CODE>`, `https://cipherline.chat/ref/<CODE>`).
 *
 * Signed OUT, the code pre-fills the sign-up form (AuthScreen, untouched).
 * Signed IN, a referral is meaningless (you already have an account), but the
 * same code names a person: `GET /v1/friends/by-link/:code` resolves it so the
 * app can open their profile with its normal Add Friend button.
 *
 * Pure decision logic lives here so it can be unit tested without React.
 */

// Same shape as the server (^[A-Fa-f0-9]{8}$) and signupAttribution.normalizeReferralCode;
// duplicated so this pure module doesn't drag axios/secureLocalStore into unit tests.
function normalizeReferralCode(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const up = raw.trim().toUpperCase();
    return /^[A-F0-9]{8}$/.test(up) ? up : null;
}

export interface RefLinkLookupResponse {
    user_id: string;
    username: string;
    discriminator: number | null;
    is_self: boolean;
}

export type RefLinkOutcome =
    | { kind: 'open_profile'; userId: string }
    | { kind: 'self' }
    | { kind: 'not_found' }
    | { kind: 'error' };

export const REF_LINK_TOASTS = {
    self: { kind: 'info' as const, title: 'That’s your own code', message: 'Share it with a friend so they can add you.' },
    not_found: { kind: 'warning' as const, title: 'Link not recognised', message: 'That link doesn’t match an account.' },
    error: { kind: 'error' as const, title: 'Couldn’t look that up', message: 'Check your connection and try the link again.' },
};

function isLookupResponse(d: unknown): d is RefLinkLookupResponse {
    const r = d as Partial<RefLinkLookupResponse> | null;
    return !!r && typeof r === 'object' && typeof r.user_id === 'string' && r.user_id.length > 0
        && typeof r.is_self === 'boolean';
}

/** Map an HTTP result (status + body, or a thrown network error) to what the app should do. */
export function decideRefLinkOutcome(res: { status: number; data?: unknown } | { networkError: true }): RefLinkOutcome {
    if ('networkError' in res) return { kind: 'error' };
    if (res.status === 404) return { kind: 'not_found' };
    if (res.status === 200 && isLookupResponse(res.data)) {
        return res.data.is_self ? { kind: 'self' } : { kind: 'open_profile', userId: res.data.user_id };
    }
    return { kind: 'error' };
}

export type RefLinkFetcher = (code: string) => Promise<{ status: number; data?: unknown }>;

/** Normalise + look up. A malformed code never reaches the network (treated as not found). */
export async function resolveRefLink(rawCode: unknown, fetcher: RefLinkFetcher): Promise<RefLinkOutcome> {
    const code = normalizeReferralCode(rawCode);
    if (!code) return { kind: 'not_found' };
    try {
        return decideRefLinkOutcome(await fetcher(code));
    } catch {
        return decideRefLinkOutcome({ networkError: true });
    }
}
