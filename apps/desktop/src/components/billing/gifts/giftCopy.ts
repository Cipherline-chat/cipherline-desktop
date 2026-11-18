/**
 * Gift Pro — every piece of copy and every state decision the gift UI shows,
 * as pure functions so they are unit-tested (giftCopy.test.ts) and the three
 * components (chat card, Settings section, purchase modal) cannot drift.
 *
 * Nothing here decides money or entitlement: the server does (see
 * packages/shared/gifts.ts). These only map what the API returned to words.
 */
import {
    GIFT_MONTH_OPTIONS,
    PLAN_TAX_SUFFIX,
    formatBillingDate,
    formatMoney,
    giftLengthLabel,
    type GiftConfig,
    type GiftMonths,
    type GiftView,
} from '@cipherline/shared';

// ── The chat card ───────────────────────────────────────────────────────────

/** Everything a gift card in a DM can look like. */
export type GiftCardKind =
    | 'loading'
    /** Network / server trouble: offer a retry. */
    | 'error'
    /** 404: not the buyer or recipient, or the gift does not exist. */
    | 'unavailable'
    /** Recipient, paid, not yet accepted: the wrapped box + Accept. */
    | 'unopened'
    /** Recipient, accepted. */
    | 'opened'
    /** Sender, paid, waiting for the recipient. */
    | 'sent_waiting'
    /** Sender, the recipient accepted. */
    | 'sent_accepted'
    /** Refunded / disputed (void or revoked), either side. */
    | 'refunded'
    /** Refunded automatically: not opened within 90 days. */
    | 'expired'
    /** The buyer's payment has not settled yet. */
    | 'processing';

export interface GiftFetchState {
    view: GiftView | null;
    loading: boolean;
    /** The read 404'd. */
    notFound: boolean;
    /** The read failed for any other reason. */
    failed: boolean;
}

export function giftCardKind(s: GiftFetchState): GiftCardKind {
    if (s.notFound) return 'unavailable';
    const v = s.view;
    if (!v) return s.failed ? 'error' : 'loading';
    switch (v.status) {
        case 'void':
        case 'revoked':
            return v.ended_reason === 'expired' ? 'expired' : 'refunded';
        case 'redeemed':
            return v.role === 'recipient' ? 'opened' : 'sent_accepted';
        case 'paid':
            return v.role === 'recipient' ? 'unopened' : 'sent_waiting';
        case 'pending':
            // A recipient should never see a gift before it is paid (the card is
            // only sent afterwards); if one does, it is not openable yet.
            return 'processing';
        default:
            return 'unavailable';
    }
}

/** "Pro until Dec 17, 2026" / "$5.00 off your renewals" / null when the server sent neither. */
export function redeemedOutcomeLine(
    v: Pick<GiftView, 'grant_end' | 'credit_amount' | 'currency' | 'redemption_kind'>,
    fallbackCurrency = 'usd',
): string | null {
    if (v.redemption_kind === 'credit' || (v.redemption_kind == null && v.credit_amount != null && !v.grant_end)) {
        if (v.credit_amount != null) return `${formatMoney(v.credit_amount, v.currency || fallbackCurrency)} off your renewals`;
        return 'Added as credit to your renewals';
    }
    const until = formatBillingDate(v.grant_end);
    return until ? `Pro until ${until}` : null;
}

export interface GiftCardCopy {
    /** Small caps line above the title: what the gift is. */
    eyebrow: string;
    /** The state, in words. */
    title: string;
    /** Context under the title, or null. */
    detail: string | null;
    /** Does the card dim (refunded / unavailable)? */
    muted: boolean;
}

export interface GiftCardNames {
    /** Display name of whoever sent the DM message (the buyer, on the recipient's side). */
    senderName: string | null | undefined;
    /** Display name of the OTHER party according to the gift (recipient for the buyer). */
    otherName: string | null | undefined;
}

const clean = (s: string | null | undefined): string | null => {
    const t = typeof s === 'string' ? s.trim() : '';
    return t ? t : null;
};

export function giftCardCopy(kind: GiftCardKind, view: GiftView | null, names: GiftCardNames): GiftCardCopy {
    const length = view ? giftLengthLabel(view.months) : null;
    const eyebrow = length ? `Gift · ${length} of Pro` : 'Gift';
    const buyer = clean(names.otherName) ?? clean(names.senderName) ?? 'A friend';
    const recipient = clean(names.otherName);
    switch (kind) {
        case 'loading':
            return { eyebrow: 'Gift', title: 'Opening the gift card…', detail: null, muted: false };
        case 'error':
            return { eyebrow: 'Gift', title: 'Couldn’t load this gift', detail: 'Check your connection and try again.', muted: true };
        case 'unavailable':
            return { eyebrow: 'Gift', title: 'This gift isn’t available', detail: null, muted: true };
        case 'unopened':
            return { eyebrow, title: `${buyer} sent you Cipherline Pro`, detail: 'Open it to add it to your account.', muted: false };
        case 'opened': {
            const line = view ? redeemedOutcomeLine(view) : null;
            return { eyebrow, title: 'Accepted', detail: line ?? `From ${buyer}`, muted: false };
        }
        case 'sent_waiting':
            return { eyebrow, title: 'Gift sent', detail: `Waiting for ${recipient ?? 'your friend'} to open it`, muted: false };
        case 'sent_accepted':
            return { eyebrow, title: 'Accepted', detail: `${recipient ?? 'Your friend'} opened your gift`, muted: false };
        case 'refunded':
            return { eyebrow, title: 'This gift was refunded', detail: null, muted: true };
        case 'expired':
            return view?.role === 'sender'
                ? { eyebrow, title: 'Refunded — not opened in 90 days', detail: 'The payment went back to your card.', muted: true }
                : { eyebrow, title: 'This gift expired and was refunded', detail: null, muted: true };
        case 'processing':
            return { eyebrow, title: 'Payment processing', detail: 'It can be opened once the payment clears.', muted: true };
    }
}

/** What the box art shows for a card kind (before any local animation). */
export type GiftArtState = 'idle' | 'closed' | 'open' | 'muted';

export function giftArtFor(kind: GiftCardKind): GiftArtState {
    switch (kind) {
        case 'unopened': return 'idle';
        case 'opened':
        case 'sent_accepted': return 'open';
        case 'sent_waiting': return 'closed';
        default: return 'muted';
    }
}

// ── Settings → Subscription list ────────────────────────────────────────────

export type GiftChipTone = 'warm' | 'lume' | 'muted';

export interface GiftChip {
    label: string;
    tone: GiftChipTone;
}

export function giftStatusChip(v: Pick<GiftView, 'status' | 'role'> & { ended_reason?: GiftView['ended_reason'] }): GiftChip {
    if ((v.status === 'void' || v.status === 'revoked') && v.ended_reason === 'expired') {
        return { label: v.role === 'sender' ? 'Refunded — not opened in 90 days' : 'Expired and refunded', tone: 'muted' };
    }
    if ((v.status === 'void' || v.status === 'revoked') && v.ended_reason === 'recipient_deleted') {
        return { label: 'Refunded — account closed', tone: 'muted' };
    }
    switch (v.status) {
        case 'paid':
            return v.role === 'sender'
                ? { label: 'Waiting to be opened', tone: 'warm' }
                : { label: 'Not opened yet', tone: 'warm' };
        case 'redeemed':
            return { label: 'Accepted', tone: 'lume' };
        case 'void':
        case 'revoked':
            return { label: 'Refunded', tone: 'muted' };
        case 'pending':
        default:
            return { label: 'Processing', tone: 'muted' };
    }
}

/** "To Alex" / "From Alex". */
export function giftRowTitle(v: Pick<GiftView, 'role'>, name: string | null | undefined): string {
    const who = clean(name) ?? 'a friend';
    return v.role === 'sender' ? `To ${who}` : `From ${who}`;
}

/** The sub-line of a list row: length, plus what was paid (sent) or what it became (received). */
export function giftRowDetail(v: GiftView): string {
    const parts: string[] = [giftLengthLabel(v.months)];
    if (v.role === 'sender') {
        if (v.amount_total != null && v.currency) parts.push(formatMoney(v.amount_total, v.currency));
    } else if (v.status === 'redeemed') {
        const line = redeemedOutcomeLine(v);
        if (line) parts.push(line);
    }
    return parts.join(' · ');
}

/** "Gifted Pro until Dec 17, 2026", or null. */
export function giftedProUntilLine(proUntil: string | null | undefined): string | null {
    const d = formatBillingDate(proUntil);
    return d ? `Gifted Pro until ${d}` : null;
}

/** A paid gift the buyer can (re)send the card for. */
export function canResendCard(v: Pick<GiftView, 'status' | 'role'>): boolean {
    return v.role === 'sender' && v.status === 'paid';
}

// ── Purchase modal ──────────────────────────────────────────────────────────

export interface GiftOffer {
    months: GiftMonths;
    amount: number;
    currency: string;
}

/** The lengths actually on sale, 1 month first. A length the server could not
 *  price (amount/currency null) or does not sell is left out. */
export function giftOffers(cfg: Pick<GiftConfig, 'offers'> | null | undefined): GiftOffer[] {
    const out: GiftOffer[] = [];
    for (const o of cfg?.offers ?? []) {
        if (!o || !(GIFT_MONTH_OPTIONS as readonly number[]).includes(o.months)) continue;
        if (typeof o.amount !== 'number' || !Number.isFinite(o.amount) || o.amount <= 0 || !o.currency) continue;
        if (out.some((x) => x.months === o.months)) continue;
        out.push({ months: o.months, amount: o.amount, currency: o.currency.toLowerCase() });
    }
    return out.sort((a, b) => a.months - b.months);
}

/** "$5.00 + tax" (no suffix when the server says it adds no tax). */
export function offerPriceLabel(o: Pick<GiftOffer, 'amount' | 'currency'>, automaticTax = true): string {
    const money = formatMoney(o.amount, o.currency);
    return automaticTax ? `${money} ${PLAN_TAX_SUFFIX}` : money;
}

/** "Pay $5.00 + tax". */
export function giftPayLabel(o: Pick<GiftOffer, 'amount' | 'currency'>, automaticTax = true): string {
    return `Pay ${offerPriceLabel(o, automaticTax)}`;
}

/** Owner 2026-11-17: told to the buyer at purchase. */
export const GIFT_REFUND_NOTICE = 'If it isn’t opened within 90 days, you’ll be refunded automatically.';

/** The fine print under Pay. */
export function giftFinePrint(recipientName: string | null | undefined): string {
    return `One-time payment. Nothing renews. ${clean(recipientName) ?? 'Your friend'} can accept it from your DM. ${GIFT_REFUND_NOTICE}`;
}

/** "Cipherline Pro · 12 months". */
export function giftProductLine(months: number): string {
    return `Cipherline Pro · ${giftLengthLabel(months)}`;
}

/** Display name for a friend row: what the client knows, else the username. */
export function friendDisplayName(
    f: { user_id: string; username?: string | null },
    nameFor?: (id: string) => string | null,
): string {
    return clean(nameFor?.(f.user_id)) ?? clean(f.username) ?? 'Friend';
}

/** "#0042" for a discriminator, or null. */
export function friendTag(discriminator: number | null | undefined): string | null {
    if (typeof discriminator !== 'number' || !Number.isInteger(discriminator) || discriminator < 0) return null;
    return `#${String(discriminator).padStart(4, '0')}`;
}

/** One letter for the avatar fallback. */
export function avatarInitial(name: string | null | undefined): string {
    const t = clean(name);
    if (!t) return '?';
    const first = Array.from(t)[0] ?? '?';
    return first.toLocaleUpperCase();
}

/** Friends matching a search, alphabetical by display name. */
export function filterGiftFriends<F extends { user_id: string; username?: string | null }>(
    friends: readonly F[],
    query: string,
    nameFor?: (id: string) => string | null,
): F[] {
    const q = query.trim().toLocaleLowerCase();
    const named = friends.map((f) => ({ f, name: friendDisplayName(f, nameFor) }));
    const hits = q
        ? named.filter(({ f, name }) => name.toLocaleLowerCase().includes(q) || (f.username ?? '').toLocaleLowerCase().includes(q))
        : named;
    return hits
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .map(({ f }) => f);
}

/** Stripe's card errors in this app's voice (same mapping as InAppCheckout). */
export function friendlyPaymentError(msg?: string | null): string {
    if (!msg) return 'That card got shy — try another?';
    if (/declin/i.test(msg)) return 'Your card was declined — try another card?';
    if (/expired/i.test(msg)) return 'That card looks expired — try another?';
    if (/insufficient/i.test(msg)) return 'Insufficient funds — try a different card?';
    return msg;
}
