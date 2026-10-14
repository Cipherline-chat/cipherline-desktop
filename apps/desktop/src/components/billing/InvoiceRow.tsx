import { formatMoney, invoiceRowView, type InvoiceView } from '@cipherline/shared';
import { ClButton } from '../cl';

/**
 * One payment-history row.
 *
 * "Receipt" is reserved for an invoice Stripe actually collected. An open
 * (unpaid) renewal reads "Unpaid" + "View invoice" with the amount DUE, so a
 * failed renewal never looks like a charge. Which invoices are listed at all
 * is decided server-side (`isUserVisibleInvoice`).
 */
export function InvoiceRow({
    inv, dateLabel, onOpen,
}: {
    inv: InvoiceView;
    dateLabel: string;
    onOpen: (url: string) => void;
}) {
    const view = invoiceRowView(inv);
    return (
        <div className="sd-row" data-testid="invoice-row">
            <div className="sd-rl">
                <b>{formatMoney(view.amountMinor, inv.currency)}</b>
                <span>
                    {dateLabel}
                    {view.chip && <> · <span className="sd-chip sd-chip--flash">{view.chip}</span></>}
                    {inv.number && ` · ${inv.number}`}
                </span>
            </div>
            <div className="sd-rc">
                {inv.hosted_invoice_url && (
                    <ClButton
                        type="button" variant="ghost" size="sm"
                        onClick={() => onOpen(inv.hosted_invoice_url!)}
                    >
                        {view.linkLabel}
                    </ClButton>
                )}
            </div>
        </div>
    );
}
