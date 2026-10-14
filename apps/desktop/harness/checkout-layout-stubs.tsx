/* eslint-disable -- harness stub, not shipped. Stands in for @stripe/stripe-js/pure, @stripe/react-stripe-js and axios. */
import React, { useEffect, useState } from 'react';

const q = new URLSearchParams(location.search);

/* ── @stripe/stripe-js/pure ── */
const fakeStripe = {
    createConfirmationToken: async () => ({ confirmationToken: { id: 'ctoken_h' } }),
    confirmPayment: async () => ({ paymentIntent: { status: 'succeeded' } }),
};
export const loadStripe = async () => fakeStripe;

/* ── @stripe/react-stripe-js ── */
export const Elements = ({ children, options }: any) => { (window as any).__elementsOptions = options; return <>{children}</>; };
export const useStripe = () => fakeStripe;
export const useElements = () => ({ submit: async () => ({}) });

const input = (label: string, value: string): React.ReactNode => (
    <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ font: '600 12px Nunito, sans-serif', color: '#9AA4B8', marginBottom: 4 }}>{label}</div>
        <div style={{ height: 40, boxSizing: 'border-box', borderRadius: 12, background: '#0F1424', border: '1px solid rgba(255,255,255,0.08)', padding: '0 12px', display: 'flex', alignItems: 'center', font: '400 15px Nunito, sans-serif', color: '#E8ECF4' }}>{value}</div>
    </div>
);

/** A block sized like the real Payment Element iframe (card + Link; no Bank tab):
 *  Link row, one Card tab, number / expiry+CVC / country+ZIP, mandate, and
 *  Link's "Save my information" box, which grows when opened. */
export const PaymentElement = ({ onReady, onChange, onFocus, onBlur, onEscape }: any) => {
    const [expanded, setExpanded] = useState(q.get('link') === 'expanded');
    useEffect(() => {
        (window as any).__stripeStub = { escape: () => onEscape?.() };
        onReady?.({ focus: () => { (document.getElementById('stub-card') as HTMLElement | null)?.focus(); } });
        onChange?.({ complete: true });
    }, []); // eslint-disable-line
    return (
        <div data-testid="stripe-stub" style={{ display: 'flex', flexDirection: 'column', gap: 14, font: '400 14px Nunito, sans-serif', color: '#E8ECF4' }}>
            <div style={{ borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)', background: '#0F1424', padding: '12px 14px' }}>
                <div style={{ font: '700 13px Nunito, sans-serif', marginBottom: 8 }}>Secure, fast checkout with Link</div>
                {input('Email', 'dawson@example.com')}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ height: 54, width: 96, boxSizing: 'border-box', borderRadius: 12, border: '1px solid #25E0C8', boxShadow: '0 0 0 1px #25E0C8', background: '#0F1424', padding: 10, font: '700 13px Nunito, sans-serif' }}>Card</div>
            </div>
            <div tabIndex={0} id="stub-card" onFocus={onFocus} onBlur={onBlur} style={{ outline: 'none' }}>{input('Card number', '4242 4242 4242 4242')}</div>
            <div style={{ display: 'flex', gap: 10 }}>{input('Expiration date', '12 / 34')}{input('Security code', '123')}</div>
            <div style={{ display: 'flex', gap: 10 }}>{input('Country', 'United States')}{input('ZIP code', '12345')}</div>
            <div style={{ font: '400 12px/1.4 Nunito, sans-serif', color: '#9AA4B8' }}>By providing your card information, you allow Cipherline to charge your card for future payments in accordance with their terms.</div>
            <label style={{ display: 'flex', gap: 10, alignItems: 'center', borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)', background: '#0F1424', padding: '12px 14px', cursor: 'pointer' }}>
                <input type="checkbox" checked={expanded} onChange={(e) => setExpanded(e.target.checked)} />
                <span style={{ font: '700 13px Nunito, sans-serif' }}>Save my information for faster checkout</span>
            </label>
            {expanded && (
                <div data-testid="stub-link-expanded" style={{ display: 'flex', flexDirection: 'column', gap: 10, borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)', background: '#0F1424', padding: '12px 14px' }}>
                    {input('Email', 'dawson@example.com')}
                    {input('Mobile number', '(555) 555-0100')}
                    <div style={{ font: '400 11px/1.4 Nunito, sans-serif', color: '#9AA4B8' }}>Pay faster at Cipherline and everywhere Link is accepted.</div>
                </div>
            )}
        </div>
    );
};

/* ── axios ── */
const taxed = q.get('tax') !== '0';
const route = async (url: string) => {
    if (url.endsWith('/billing/checkout-config')) return { data: { publishable_key: 'pk_test_harness', amount: 250, currency: 'usd', automatic_tax: true, payment_method_types: ['card', 'link'] } };
    if (url.endsWith('/billing/subscribe')) return { data: { client_secret: 'pi_h', subscription_id: 'sub_h', amount_subtotal: 250, amount_tax: taxed ? 18 : 0, amount_total: taxed ? 268 : 250, currency: 'usd' } };
    return { data: { subscription_status: 'active' } };
};
const axios = { get: (url: string) => route(url), post: (url: string) => route(url), isAxiosError: () => false };
export default axios;
