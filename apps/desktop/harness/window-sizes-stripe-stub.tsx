/* eslint-disable -- harness stub, not shipped */
// Stand-in for @stripe/react-stripe-js and @stripe/stripe-js/pure in the window-sizes
// harness: Stripe.js is a cross-origin iframe the harness cannot load, so the Payment
// Element is replaced by a block of about the height the real card form takes
// (card number, expiry + CVC, country + ZIP, ~250 px) so the pay step's layout is real.
import React from 'react';
const fakeStripe = { createConfirmationToken: async () => ({}), confirmPayment: async () => ({}) };
export const loadStripe = async () => fakeStripe as any;
export const Elements = ({ children }: { children: React.ReactNode }) => <>{children}</>;
export const useStripe = () => fakeStripe as any;
export const useElements = () => ({ submit: async () => ({}) }) as any;
const field = (label: string) => (
    <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: 'var(--cl-muted)', margin: '0 0 6px' }}>{label}</div>
        <div style={{ height: 44, borderRadius: 12, border: '1.5px solid var(--cl-border)', background: 'var(--cl-surface)' }} />
    </div>
);
export const PaymentElement = ({ onReady }: { onReady?: () => void }) => {
    React.useEffect(() => { onReady?.(); }, []);
    return (
        <div data-testid="fake-payment-element" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {field('Card number')}
            <div style={{ display: 'flex', gap: 12 }}>{field('Expiration date')}{field('Security code')}</div>
            <div style={{ display: 'flex', gap: 12 }}>{field('Country')}{field('ZIP code')}</div>
        </div>
    );
};
