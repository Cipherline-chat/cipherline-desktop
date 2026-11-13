/**
 * Monthly / Yearly segmented choice at the top of the checkout's plan summary.
 * Presentational: InAppCheckout owns the interval and what changes with it.
 * Shown only when the API offers yearly. "2 months free" appears on the REGULAR
 * yearly price only (planInterval.yearlySavingsBadge); the founding yearly
 * price ($30/yr = 12 x $2.50) never carries a badge.
 */
import React from 'react';
import type { BillingInterval } from '@cipherline/shared';
import { intervalOptions, type IntervalPrices } from './planInterval';

export const IntervalPicker: React.FC<{
    prices: IntervalPrices;
    value: BillingInterval;
    onChange: (next: BillingInterval) => void;
    disabled?: boolean;
}> = ({ prices, value, onChange, disabled }) => {
    const options = intervalOptions(prices);
    return (
        <div className="ckt-interval" role="radiogroup" aria-label="Billing interval" data-testid="interval-picker">
            {options.map((o) => {
                const selected = o.interval === value;
                return (
                    <button
                        key={o.interval}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        data-testid={`interval-${o.interval}`}
                        className={`ckt-interval-opt${selected ? ' is-on' : ''}`}
                        disabled={disabled}
                        onClick={() => onChange(o.interval)}
                    >
                        <span className="ckt-interval-name">{o.label}</span>
                        <span className="ckt-interval-price">{o.priceLabel}</span>
                        {o.badge && <span className="ckt-interval-badge" data-testid="interval-badge">{o.badge}</span>}
                    </button>
                );
            })}
        </div>
    );
};

export default IntervalPicker;
