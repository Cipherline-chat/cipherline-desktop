/**
 * UpdateCardModal — change the card on file, without leaving the app.
 *
 * A SetupIntent rather than a PaymentIntent: nothing is charged, we are only
 * saving a card for future renewals. The card details go straight from the
 * Stripe Elements iframe to Stripe and never touch our renderer or our server,
 * which is what keeps this out of PCI scope.
 *
 * Two-step by necessity, and the gap between the steps is the interesting part:
 *   1. Elements confirms the SetupIntent  → the card is ATTACHED to the customer
 *   2. POST /billing/payment-method       → it becomes the DEFAULT that renewals charge
 *
 * If the app dies between them the user has a saved card that will never be
 * charged, and the first they'd hear of it is a failed renewal. The server
 * heals that on the next read of GET /billing/payment-method (it promotes an
 * attached-but-not-default card), so this component's job is just to be honest
 * about which step failed rather than claiming success after step 1.
 */
import React, { useCallback, useEffect, useState } from 'react';
// `/pure` — see the long note in InAppCheckout.tsx. The default '@stripe/stripe-js'
// entry fetches js.stripe.com as an import side effect; `/pure` waits until
// loadStripe() is called. Payment behaviour is identical.
// `Stripe` is a type-only import from the root package (erased at compile time,
// so no script load); only the loader comes from `/pure`. See InAppCheckout.tsx.
import { loadStripe } from '@stripe/stripe-js/pure';
import type { Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import axios from 'axios';
import { CreditCard, Lock, ShieldCheck, AlertTriangle } from 'lucide-react';
import { API_BASE } from '../../constants';
import { useAuth } from '../../contexts/AuthContext';
import { ClButton } from '../ClButton';
import { ClModal } from '../cl';
import { STRIPE_APPEARANCE, STRIPE_CARD_ONLY_ELEMENT_OPTIONS, STRIPE_FONTS } from './stripeAppearance';

export interface UpdateCardModalProps {
    open: boolean;
    onClose: () => void;
    /** Fired once the new card is confirmed AND promoted to default. */
    onUpdated: () => void;
}

type Phase = 'ready' | 'saving' | 'error' | 'attached_not_default';

/** Map Stripe's decline codes to something a person can act on. */
function friendlyError(message?: string, code?: string): string {
    if (code === 'card_declined') return 'That card was declined. Try a different one.';
    if (code === 'expired_card') return 'That card has expired.';
    if (code === 'incorrect_cvc') return "That security code doesn't match.";
    if (code === 'processing_error') return 'Your bank had trouble processing that. Try again in a moment.';
    return message || 'Something went wrong saving that card.';
}

const CardForm: React.FC<{ onUpdated: () => void; onClose: () => void }> = ({ onUpdated, onClose }) => {
    const stripe = useStripe();
    const elements = useElements();
    const { token } = useAuth();
    const [phase, setPhase] = useState<Phase>('ready');
    const [error, setError] = useState('');

    const submit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!stripe || !elements || phase === 'saving') return;
        setPhase('saving');
        setError('');

        // redirect: 'if_required' is mandatory in Electron — there is no
        // top-level navigation to come back from, so a 3DS challenge has to
        // resolve inside Stripe's own iframe (the CSP allows hooks.stripe.com
        // for exactly this).
        const { error: confirmErr, setupIntent } = await stripe.confirmSetup({
            elements,
            redirect: 'if_required',
        });

        if (confirmErr) {
            setError(friendlyError(confirmErr.message, confirmErr.code));
            setPhase('error');
            return;
        }
        if (!setupIntent || setupIntent.status !== 'succeeded') {
            setError('That card was not confirmed. Please try again.');
            setPhase('error');
            return;
        }

        // Step 2 — promote it to the default. Sending the SETUP INTENT id, not
        // the payment method: the server re-reads the intent and checks it
        // belongs to this customer, so a client can't name someone else's card.
        try {
            await axios.post(
                `${API_BASE}/billing/payment-method`,
                { setup_intent_id: setupIntent.id },
                { headers: { Authorization: `Bearer ${token}` } },
            );
            onUpdated();
        } catch (err: unknown) {
            // The card IS saved at this point — say so precisely instead of
            // "it failed", which would send the user to re-enter a card that
            // Stripe already has.
            console.warn('[UpdateCardModal] promote-to-default failed', err);
            setPhase('attached_not_default');
        }
    }, [stripe, elements, phase, token, onUpdated]);

    if (phase === 'attached_not_default') {
        return (
            <div style={{ display: 'grid', gap: 14 }}>
                <div className="sd-tile sd-tile--warm" style={{ width: 38, height: 38 }}>
                    <AlertTriangle size={18} />
                </div>
                <div>
                    <b style={{ fontSize: 15 }}>Your card was saved</b>
                    <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--cl-muted)', lineHeight: 1.5 }}>
                        We couldn't finish switching your renewals over to it just now. Reopen this
                        page in a moment and it'll be sorted automatically — nothing to re-enter.
                    </p>
                </div>
                <ClButton fullWidth onClick={onClose}>Done</ClButton>
            </div>
        );
    }

    return (
        <form onSubmit={submit} style={{ display: 'grid', gap: 16 }}>
            <PaymentElement options={STRIPE_CARD_ONLY_ELEMENT_OPTIONS} />
            {error && (
                <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--cl-flash)', fontWeight: 600 }}>
                    {error}
                </p>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
                <ClButton variant="ghost" type="button" onClick={onClose} disabled={phase === 'saving'}>
                    Cancel
                </ClButton>
                <ClButton
                    type="submit"
                    fullWidth
                    loading={phase === 'saving'}
                    disabled={!stripe || phase === 'saving'}
                >
                    Save card
                </ClButton>
            </div>
            <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--cl-faint)' }}>
                <Lock size={11} /> Your card details go straight to Stripe — they never touch Cipherline.
            </p>
        </form>
    );
};

export const UpdateCardModal: React.FC<UpdateCardModalProps> = ({ open, onClose, onUpdated }) => {
    const { token } = useAuth();
    const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null);
    const [clientSecret, setClientSecret] = useState('');
    const [loadError, setLoadError] = useState('');

    useEffect(() => {
        if (!open || !token) return;
        let cancelled = false;

        (async () => {
            try {
                // Reset inside the async body rather than synchronously in the
                // effect: same effect, no cascading re-render on mount.
                setLoadError('');
                setClientSecret('');
                const res = await axios.post(`${API_BASE}/billing/payment-method/setup-intent`, {}, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (cancelled) return;
                const { client_secret, publishable_key } = res.data ?? {};
                if (!client_secret || !publishable_key) throw new Error('Incomplete setup intent');
                setStripePromise(loadStripe(publishable_key));
                setClientSecret(client_secret);
            } catch (err: unknown) {
                if (cancelled) return;
                const msg = (axios.isAxiosError(err) ? err.response?.data?.message : undefined)
                    || "Couldn't start a card update. Please try again.";
                setLoadError(msg);
            }
        })();

        return () => { cancelled = true; };
    }, [open, token]);

    return (
        <ClModal
            open={open}
            onClose={onClose}
            width={460}
            label="Update payment method"
            // Stripe's iframe decides its own height, so this card is the one
            // we can't size ourselves — cap it and let it scroll.
            cardClassName="mcard--scroll"
        >
            <div style={{ display: 'grid', gap: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className="sd-tile" style={{ width: 38, height: 38 }}><CreditCard size={18} /></span>
                    <div>
                        <b style={{ fontSize: 15.5 }}>Update payment method</b>
                        <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--cl-muted)' }}>
                            Your next renewal will use this card.
                        </p>
                    </div>
                </div>

                {loadError && (
                    <div style={{ display: 'grid', gap: 12 }}>
                        <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--cl-flash)', fontWeight: 600 }}>
                            {loadError}
                        </p>
                        <ClButton variant="ghost" fullWidth onClick={onClose}>Close</ClButton>
                    </div>
                )}

                {!loadError && (!clientSecret || !stripePromise) && (
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--cl-muted)' }}>Getting things ready…</p>
                )}

                {!loadError && clientSecret && stripePromise && (
                    <Elements
                        stripe={stripePromise}
                        options={{ clientSecret, appearance: STRIPE_APPEARANCE, fonts: STRIPE_FONTS }}
                    >
                        <CardForm onUpdated={onUpdated} onClose={onClose} />
                    </Elements>
                )}

                <p style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--cl-faint)' }}>
                    <ShieldCheck size={11} /> Encrypted end to end by Stripe. We only ever see the last four digits.
                </p>
            </div>
        </ClModal>
    );
};

export default UpdateCardModal;
