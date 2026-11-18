import { describe, expect, it } from 'vitest';
import type { GiftView } from '@cipherline/shared';
import {
    avatarInitial,
    canResendCard,
    filterGiftFriends,
    friendDisplayName,
    friendTag,
    friendlyPaymentError,
    giftArtFor,
    giftCardCopy,
    giftCardKind,
    giftFinePrint,
    giftOffers,
    giftPayLabel,
    giftProductLine,
    giftRowDetail,
    giftRowTitle,
    giftStatusChip,
    giftedProUntilLine,
    offerPriceLabel,
    redeemedOutcomeLine,
    type GiftCardKind,
} from './giftCopy';

const ID = '0f8e3c2a-1b4d-4c6e-8f9a-0b1c2d3e4f5a';

function view(over: Partial<GiftView> = {}): GiftView {
    return {
        gift_id: ID,
        months: 1,
        status: 'paid',
        role: 'recipient',
        other_user_id: 'u-buyer',
        created_at: '2026-11-17T10:00:00Z',
        paid_at: '2026-11-17T10:00:05Z',
        redeemed_at: null,
        redemption_kind: null,
        amount_subtotal: null,
        amount_tax: null,
        amount_total: null,
        currency: null,
        grant_end: null,
        credit_amount: null,
        ended_reason: null,
        ...over,
    };
}

const fetched = (v: GiftView | null, o: { loading?: boolean; notFound?: boolean; failed?: boolean } = {}) => ({
    view: v, loading: !!o.loading, notFound: !!o.notFound, failed: !!o.failed,
});

describe('giftCardKind — state transition table', () => {
    const cases: Array<[string, ReturnType<typeof fetched>, GiftCardKind]> = [
        ['first load', fetched(null, { loading: true }), 'loading'],
        ['404', fetched(null, { notFound: true }), 'unavailable'],
        ['404 wins over a stale view', fetched(view(), { notFound: true }), 'unavailable'],
        ['network error, nothing yet', fetched(null, { failed: true }), 'error'],
        ['network error keeps the last good view', fetched(view(), { failed: true }), 'unopened'],
        ['recipient + paid', fetched(view()), 'unopened'],
        ['recipient + redeemed', fetched(view({ status: 'redeemed' })), 'opened'],
        ['sender + paid', fetched(view({ role: 'sender' })), 'sent_waiting'],
        ['sender + redeemed', fetched(view({ role: 'sender', status: 'redeemed' })), 'sent_accepted'],
        ['void (recipient)', fetched(view({ status: 'void' })), 'refunded'],
        ['revoked (sender)', fetched(view({ role: 'sender', status: 'revoked' })), 'refunded'],
        ['pending is never openable', fetched(view({ status: 'pending' })), 'processing'],
        ['unknown status from a newer API', fetched(view({ status: 'weird' as never })), 'unavailable'],
    ];
    it.each(cases)('%s', (_n, s, kind) => {
        expect(giftCardKind(s)).toBe(kind);
    });
});

describe('giftCardCopy', () => {
    const names = { senderName: 'Robin', otherName: 'Alex' };

    it('recipient, unopened: names the buyer and the length', () => {
        const c = giftCardCopy('unopened', view({ months: 12 }), names);
        expect(c.title).toBe('Alex sent you Cipherline Pro');
        expect(c.eyebrow).toBe('Gift · 12 months of Pro');
        expect(c.muted).toBe(false);
    });

    it('falls back to the message sender, then to "A friend"', () => {
        expect(giftCardCopy('unopened', view(), { senderName: 'Robin', otherName: null }).title).toBe('Robin sent you Cipherline Pro');
        expect(giftCardCopy('unopened', view(), { senderName: '  ', otherName: undefined }).title).toBe('A friend sent you Cipherline Pro');
    });

    it('opened (time): Accepted + Pro until <date>', () => {
        const c = giftCardCopy('opened', view({ status: 'redeemed', redemption_kind: 'time', grant_end: '2026-12-17T12:00:00Z' }), names);
        expect(c.title).toBe('Accepted');
        expect(c.detail).toMatch(/^Pro until .*2026/);
    });

    it('opened (credit): Accepted + <credit> off your renewals', () => {
        const c = giftCardCopy('opened', view({ status: 'redeemed', redemption_kind: 'credit', credit_amount: 499, currency: 'usd' }), names);
        expect(c.detail).toBe('$4.99 off your renewals');
    });

    it('sender, waiting / accepted name the recipient', () => {
        expect(giftCardCopy('sent_waiting', view({ role: 'sender' }), names).detail).toBe('Waiting for Alex to open it');
        expect(giftCardCopy('sent_accepted', view({ role: 'sender', status: 'redeemed' }), names).detail).toBe('Alex opened your gift');
        expect(giftCardCopy('sent_waiting', view({ role: 'sender' }), { senderName: null, otherName: null }).detail).toBe('Waiting for your friend to open it');
    });

    it('refunded / unavailable / error are muted and never celebratory', () => {
        for (const k of ['refunded', 'unavailable', 'error'] as const) {
            const c = giftCardCopy(k, k === 'refunded' ? view({ status: 'void' }) : null, names);
            expect(c.muted).toBe(true);
            expect(c.title).not.toMatch(/sent you|Accepted/);
        }
        expect(giftCardCopy('refunded', view({ status: 'void' }), names).title).toBe('This gift was refunded');
        expect(giftCardCopy('unavailable', null, names).title).toBe('This gift isn’t available');
    });

    it('every kind produces non-empty copy', () => {
        const kinds: GiftCardKind[] = ['loading', 'error', 'unavailable', 'unopened', 'opened', 'sent_waiting', 'sent_accepted', 'refunded', 'processing'];
        for (const k of kinds) {
            const c = giftCardCopy(k, view(), names);
            expect(c.title.length).toBeGreaterThan(0);
            expect(c.eyebrow.length).toBeGreaterThan(0);
        }
    });
});

describe('giftArtFor', () => {
    it('only the unopened card idles (shimmer + wiggle)', () => {
        expect(giftArtFor('unopened')).toBe('idle');
        expect(giftArtFor('sent_waiting')).toBe('closed');
        expect(giftArtFor('opened')).toBe('open');
        expect(giftArtFor('sent_accepted')).toBe('open');
        for (const k of ['refunded', 'unavailable', 'error', 'processing', 'loading'] as const) expect(giftArtFor(k)).toBe('muted');
    });
});

describe('redeemedOutcomeLine', () => {
    it('time without a date says nothing rather than a placeholder', () => {
        expect(redeemedOutcomeLine({ redemption_kind: 'time', grant_end: null, credit_amount: null, currency: null })).toBeNull();
    });
    it('credit without an amount still reads as a sentence', () => {
        expect(redeemedOutcomeLine({ redemption_kind: 'credit', grant_end: null, credit_amount: null, currency: null })).toBe('Added as credit to your renewals');
    });
    it('infers credit from the fields when the kind is missing', () => {
        expect(redeemedOutcomeLine({ redemption_kind: null, grant_end: null, credit_amount: 4999, currency: 'usd' })).toBe('$49.99 off your renewals');
    });
    it('an unparseable date is null', () => {
        expect(redeemedOutcomeLine({ redemption_kind: 'time', grant_end: 'not a date', credit_amount: null, currency: null })).toBeNull();
    });
});

describe('Settings list', () => {
    it('status chips (decision table)', () => {
        expect(giftStatusChip({ status: 'paid', role: 'sender' })).toEqual({ label: 'Waiting to be opened', tone: 'warm' });
        expect(giftStatusChip({ status: 'paid', role: 'recipient' })).toEqual({ label: 'Not opened yet', tone: 'warm' });
        expect(giftStatusChip({ status: 'redeemed', role: 'sender' })).toEqual({ label: 'Accepted', tone: 'lume' });
        expect(giftStatusChip({ status: 'redeemed', role: 'recipient' })).toEqual({ label: 'Accepted', tone: 'lume' });
        expect(giftStatusChip({ status: 'void', role: 'sender' })).toEqual({ label: 'Refunded', tone: 'muted' });
        expect(giftStatusChip({ status: 'revoked', role: 'recipient' })).toEqual({ label: 'Refunded', tone: 'muted' });
        expect(giftStatusChip({ status: 'pending', role: 'sender' })).toEqual({ label: 'Processing', tone: 'muted' });
    });

    it('row titles', () => {
        expect(giftRowTitle({ role: 'sender' }, 'Alex')).toBe('To Alex');
        expect(giftRowTitle({ role: 'recipient' }, 'Alex')).toBe('From Alex');
        expect(giftRowTitle({ role: 'sender' }, null)).toBe('To a friend');
    });

    it('sent rows show what was paid (tax included)', () => {
        expect(giftRowDetail(view({ role: 'sender', months: 12, amount_total: 5349, currency: 'usd' }))).toBe('12 months · $53.49');
        expect(giftRowDetail(view({ role: 'sender', amount_total: null }))).toBe('1 month');
    });

    it('received rows show what the gift became, once accepted', () => {
        expect(giftRowDetail(view())).toBe('1 month');
        expect(giftRowDetail(view({ status: 'redeemed', redemption_kind: 'credit', credit_amount: 499, currency: 'usd' }))).toBe('1 month · $4.99 off your renewals');
        expect(giftRowDetail(view({ status: 'redeemed', redemption_kind: 'time', grant_end: '2027-01-02T00:00:00Z' }))).toMatch(/^1 month · Pro until .*2027/);
    });

    it('gifted-Pro banner only with a real date', () => {
        expect(giftedProUntilLine(null)).toBeNull();
        expect(giftedProUntilLine('')).toBeNull();
        expect(giftedProUntilLine('2026-12-17T00:00:00Z')).toMatch(/^Gifted Pro until /);
    });

    it('only a paid gift the caller SENT can have its card resent', () => {
        expect(canResendCard({ role: 'sender', status: 'paid' })).toBe(true);
        expect(canResendCard({ role: 'sender', status: 'redeemed' })).toBe(false);
        expect(canResendCard({ role: 'sender', status: 'pending' })).toBe(false);
        expect(canResendCard({ role: 'sender', status: 'void' })).toBe(false);
        expect(canResendCard({ role: 'recipient', status: 'paid' })).toBe(false);
    });
});

describe('purchase copy', () => {
    it('giftOffers keeps sellable lengths only, 1 month first, lower-cased currency', () => {
        expect(giftOffers({ offers: [
            { months: 12, amount: 4999, currency: 'USD' },
            { months: 1, amount: 499, currency: 'usd' },
        ] })).toEqual([{ months: 1, amount: 499, currency: 'usd' }, { months: 12, amount: 4999, currency: 'usd' }]);
    });

    it('a 12-month offer that is absent or unpriced is not offered', () => {
        expect(giftOffers({ offers: [{ months: 1, amount: 499, currency: 'usd' }] }).map((o) => o.months)).toEqual([1]);
        expect(giftOffers({ offers: [{ months: 1, amount: 499, currency: 'usd' }, { months: 12, amount: null, currency: null }] }).map((o) => o.months)).toEqual([1]);
    });

    it('rejects junk: unknown lengths, zero/negative/NaN, duplicates, nothing', () => {
        expect(giftOffers({ offers: [
            { months: 3 as never, amount: 999, currency: 'usd' },
            { months: 1, amount: 0, currency: 'usd' },
            { months: 1, amount: -5, currency: 'usd' },
            { months: 1, amount: Number.NaN, currency: 'usd' },
            { months: 1, amount: 499, currency: 'usd' },
            { months: 1, amount: 599, currency: 'usd' },
        ] })).toEqual([{ months: 1, amount: 499, currency: 'usd' }]);
        expect(giftOffers(null)).toEqual([]);
        expect(giftOffers({ offers: [] })).toEqual([]);
    });

    it('prices say "+ tax" unless the server adds none', () => {
        expect(offerPriceLabel({ amount: 499, currency: 'usd' })).toBe('$4.99 + tax');
        expect(offerPriceLabel({ amount: 499, currency: 'usd' }, false)).toBe('$4.99');
        expect(giftPayLabel({ amount: 4999, currency: 'usd' })).toBe('Pay $49.99 + tax');
    });

    it('fine print: one-time, nothing renews, names the friend', () => {
        expect(giftFinePrint('Alex')).toBe('One-time payment. Nothing renews. Alex can accept it from your DM. If it isn’t opened within 90 days, you’ll be refunded automatically.');
        expect(giftFinePrint(null)).toBe('One-time payment. Nothing renews. Your friend can accept it from your DM. If it isn’t opened within 90 days, you’ll be refunded automatically.');
    });

    it('product line', () => {
        expect(giftProductLine(12)).toBe('Cipherline Pro · 12 months');
        expect(giftProductLine(1)).toBe('Cipherline Pro · 1 month');
    });
});

describe('friend picker helpers', () => {
    const friends = [
        { user_id: 'b', username: 'bea' },
        { user_id: 'a', username: 'alex' },
        { user_id: 'c', username: null },
        { user_id: 'z', username: 'zed' },
    ];
    const nameFor = (id: string) => (id === 'z' ? 'Ada Lovelace' : null);

    it('display name prefers what the client knows, then the username', () => {
        expect(friendDisplayName(friends[3], nameFor)).toBe('Ada Lovelace');
        expect(friendDisplayName(friends[0], nameFor)).toBe('bea');
        expect(friendDisplayName(friends[2], nameFor)).toBe('Friend');
    });

    it('sorts alphabetically by display name', () => {
        expect(filterGiftFriends(friends, '', nameFor).map((f) => f.user_id)).toEqual(['z', 'a', 'b', 'c']);
    });

    it('searches display name and username, case-insensitively, trimming', () => {
        expect(filterGiftFriends(friends, '  ADA ', nameFor).map((f) => f.user_id)).toEqual(['z']);
        expect(filterGiftFriends(friends, 'zed', nameFor).map((f) => f.user_id)).toEqual(['z']);
        expect(filterGiftFriends(friends, 'nobody', nameFor)).toEqual([]);
    });

    it('tags and initials', () => {
        expect(friendTag(42)).toBe('#0042');
        expect(friendTag(null)).toBeNull();
        expect(friendTag(-1)).toBeNull();
        expect(friendTag(1.5)).toBeNull();
        expect(avatarInitial('alex')).toBe('A');
        expect(avatarInitial('  ')).toBe('?');
        expect(avatarInitial('😀 smile')).toBe('😀');
    });
});

describe('friendlyPaymentError', () => {
    it('maps Stripe card wording, passes the rest through', () => {
        expect(friendlyPaymentError('Your card was declined.')).toBe('Your card was declined — try another card?');
        expect(friendlyPaymentError('Your card has expired.')).toBe('That card looks expired — try another?');
        expect(friendlyPaymentError('insufficient_funds')).toBe('Insufficient funds — try a different card?');
        expect(friendlyPaymentError('Enter your ZIP.')).toBe('Enter your ZIP.');
        expect(friendlyPaymentError(undefined)).toBe('That card got shy — try another?');
    });
});

describe('automatic refunds (owner 2026-11-17)', () => {
    const base = (over: Record<string, unknown>) => ({
        gift_id: 'g', months: 1, status: 'void', role: 'recipient', other_user_id: 'u', created_at: '2026-01-01T00:00:00Z',
        paid_at: null, redeemed_at: null, redemption_kind: null, amount_subtotal: null, amount_tax: null, amount_total: null,
        currency: 'usd', grant_end: null, credit_amount: null, ended_reason: null, ...over,
    }) as any;
    const fetchedView = (v: any) => ({ view: v, loading: false, notFound: false, failed: false });

    it('the recipient\'s card says the gift expired and was refunded', () => {
        const v = base({ ended_reason: 'expired' });
        const kind = giftCardKind(fetchedView(v));
        expect(kind).toBe('expired');
        expect(giftCardCopy(kind, v, { senderName: 'Alex', otherName: 'Alex' }).title).toBe('This gift expired and was refunded');
        expect(giftArtFor(kind)).toBe('muted');
    });
    it('the sender sees "Refunded — not opened in 90 days" in Settings and on the card', () => {
        const v = base({ role: 'sender', ended_reason: 'expired' });
        expect(giftStatusChip(v).label).toBe('Refunded — not opened in 90 days');
        expect(giftCardCopy(giftCardKind(fetchedView(v)), v, { senderName: null, otherName: 'Sam' }).title).toBe('Refunded — not opened in 90 days');
    });
    it('a refund because the recipient closed their account says so', () => {
        expect(giftStatusChip(base({ role: 'sender', ended_reason: 'recipient_deleted' })).label).toBe('Refunded — account closed');
    });
    it('an ordinary refund / dispute keeps the plain wording', () => {
        expect(giftStatusChip(base({ role: 'sender', ended_reason: 'refunded' })).label).toBe('Refunded');
        expect(giftCardKind(fetchedView(base({ ended_reason: 'disputed' })))).toBe('refunded');
    });
});
