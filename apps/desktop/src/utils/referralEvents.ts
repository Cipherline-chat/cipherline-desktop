import type { ReferralRedeemedEventData } from '@cipherline/shared';

/**
 * `referral:redeemed` — "someone signed up with MY referral link".
 *
 * The API sends this WebSocket event to the referrer when a new account finishes
 * signup with their code (AuthService.finalize -> RealtimeGateway.notifyReferralRedeemed).
 * The payload is only the new person's public tag + a timestamp.
 *
 * `useRealtime` validates and re-emits it here; anything that wants to react
 * subscribes — the "your friend joined" moment in onboarding, the first-week
 * nudges ("Sam joined with your link"), the built-in toast. A bus (rather than
 * more state threaded through useRealtime) keeps every consumer decoupled from
 * the socket, the same shape as `presenceBus`.
 *
 * An event is only delivered to whoever is subscribed when it arrives. A referrer
 * who was offline gets the same information from `GET /v1/billing/referral`
 * (`recent_referrals`) — see `fetchMyReferral` in utils/signupAttribution.
 */

export type ReferralRedeemedEvent = ReferralRedeemedEventData;

type Listener = (ev: ReferralRedeemedEvent) => void;
const listeners = new Set<Listener>();

/**
 * Shape-check a raw WS `data` value. Returns null for anything that is not a
 * well-formed event, so a malformed or hostile frame is dropped, never
 * half-delivered.
 */
export function parseReferralRedeemed(data: unknown): ReferralRedeemedEvent | null {
    if (!data || typeof data !== 'object') return null;
    const d = data as Record<string, unknown>;
    if (typeof d.username !== 'string' || d.username.length === 0 || d.username.length > 64) return null;
    const disc = d.discriminator;
    if (disc !== null && !(typeof disc === 'number' && Number.isInteger(disc) && disc >= 0 && disc <= 9999)) return null;
    if (typeof d.redeemed_at !== 'string' || Number.isNaN(Date.parse(d.redeemed_at))) return null;
    return { username: d.username, discriminator: (disc as number | null) ?? null, redeemed_at: d.redeemed_at };
}

export const referralRedeemedBus = {
    emit(ev: ReferralRedeemedEvent): void {
        for (const l of Array.from(listeners)) {
            try { l(ev); } catch (e) { console.error('[referralRedeemedBus] listener failed:', e); }
        }
    },
    subscribe(l: Listener): () => void {
        listeners.add(l);
        return () => { listeners.delete(l); };
    },
};
