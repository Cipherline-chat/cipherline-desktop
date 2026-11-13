/**
 * RenewalConsent: the auto-renewal disclosure and the affirmative consent box
 * that sit directly above the Pay button in the desktop checkout.
 *
 * The WORDING is not written here: it is `renewalDisclosure()` in
 * @cipherline/shared, the same function the API recomputes (and hashes) to
 * record exactly what the customer was shown, and the same text the website
 * checkout renders. The price comes from the API's checkout-config, so a founder
 * sees the founder price.
 *
 * Body-size text in the normal text colour (not a faint footnote) and an
 * initially UNCHECKED box: both are the point (California ARL style). The box
 * gates the Pay button in the parent; the SERVER independently refuses a
 * subscription without a consent, so this is UX, not enforcement.
 */
import React, { useId, useMemo } from 'react';
import { renewalDisclosure, type BillingInterval } from '@cipherline/shared';

export interface RenewalConsentProps {
    amount: number;
    currency: string;
    /** Billing interval the shown price is for. Default monthly. A consent is per interval. */
    interval?: BillingInterval;
    checked: boolean;
    onChange: (checked: boolean) => void;
    /** Locked while a charge is being prepared or a total is being confirmed. */
    disabled?: boolean;
}

export const RenewalConsent: React.FC<RenewalConsentProps> = ({ amount, currency, interval, checked, onChange, disabled }) => {
    const id = useId();
    const d = useMemo(() => renewalDisclosure({ priceMinor: amount, currency, interval }), [amount, currency, interval]);
    return (
        <div className="ckt-consent" data-testid="renewal-consent">
            <p className="ckt-consent-text" data-testid="renewal-disclosure">{d.renewalLine}</p>
            <p className="ckt-consent-text">{d.cancelLine}</p>
            <label className="ckt-consent-check" htmlFor={id}>
                <input
                    id={id}
                    type="checkbox"
                    data-testid="renewal-consent-checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={(e) => onChange(e.target.checked)}
                />
                <span>{d.consentLabel}</span>
            </label>
        </div>
    );
};

export default RenewalConsent;
