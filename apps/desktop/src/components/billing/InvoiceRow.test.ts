// @vitest-environment jsdom
/**
 * Payment-history rows. Backing out of checkout used to leave an OPEN $0
 * invoice that rendered as "$2.50 · open [Receipt]" - it looked like a charge.
 * "Receipt" is now only for a paid invoice; an open renewal reads Unpaid +
 * "View invoice" with the amount DUE.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { invoiceRowView, type InvoiceView } from '@cipherline/shared';
import { InvoiceRow } from './InvoiceRow';

// clPhysics (pulled in by ClButton) calls matchMedia at module load; jsdom has none.
vi.hoisted(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {},
        dispatchEvent: () => false,
    });
});

const inv = (over: Partial<InvoiceView>): InvoiceView => ({
    id: 'in_1', number: null, created: '2026-10-01T00:00:00.000Z',
    amount_paid: 0, amount_due: 250, currency: 'usd', status: 'open',
    hosted_invoice_url: 'https://invoice.stripe.test/i/1', invoice_pdf: null,
    ...over,
});

const render = (i: InvoiceView) =>
    renderToStaticMarkup(React.createElement(InvoiceRow, { inv: i, dateLabel: 'Oct 1, 2026', onOpen: () => {} }));

describe('invoiceRowView', () => {
    it('paid: Receipt, amount PAID, no chip', () => {
        expect(invoiceRowView(inv({ status: 'paid', amount_paid: 250, amount_due: 0 })))
            .toEqual({ paid: true, amountMinor: 250, chip: null, linkLabel: 'Receipt' });
    });
    it('a paid $0 invoice (100% coupon) shows $0, not the pre-discount due', () => {
        expect(invoiceRowView(inv({ status: 'paid', amount_paid: 0, amount_due: 250 })).amountMinor).toBe(0);
    });
    it('open renewal: Unpaid, amount DUE, View invoice', () => {
        expect(invoiceRowView(inv({ status: 'open', amount_paid: 0, amount_due: 250 })))
            .toEqual({ paid: false, amountMinor: 250, chip: 'Unpaid', linkLabel: 'View invoice' });
    });
    it('uncollectible reads Unpaid too', () => {
        expect(invoiceRowView(inv({ status: 'uncollectible' })).chip).toBe('Unpaid');
    });
});

describe('InvoiceRow rendering', () => {
    it('paid row: $2.50, "Receipt", no Unpaid chip', () => {
        const html = render(inv({ status: 'paid', amount_paid: 250, amount_due: 0 }));
        expect(html).toContain('$2.50');
        expect(html).toContain('Receipt');
        expect(html).not.toContain('Unpaid');
        expect(html).not.toContain('View invoice');
    });

    it('open renewal row: Unpaid chip, "View invoice", amount due, NO "Receipt"', () => {
        const html = render(inv({ status: 'open', amount_paid: 0, amount_due: 250 }));
        expect(html).toContain('Unpaid');
        expect(html).toContain('View invoice');
        expect(html).toContain('$2.50');
        expect(html).not.toContain('Receipt');
    });

    it('NEGATIVE CONTROL: the old row logic labelled an open invoice "Receipt" and "open"', () => {
        const old = (i: InvoiceView) => ({
            label: i.hosted_invoice_url ? 'Receipt' : null,
            status: i.status !== 'paid' ? ` · ${i.status}` : '',
        });
        expect(old(inv({ status: 'open' }))).toEqual({ label: 'Receipt', status: ' · open' });
        expect(render(inv({ status: 'open' }))).not.toContain('Receipt');
    });

    it('no hosted url -> no link at all', () => {
        const html = render(inv({ status: 'open', hosted_invoice_url: null }));
        expect(html).not.toContain('View invoice');
        expect(html).not.toContain('Receipt');
    });
});
