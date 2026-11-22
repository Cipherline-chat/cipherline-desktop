/**
 * Gift Pro purchase: pick a friend and a length, pay once (Stripe Payment
 * Element, in-app), and the E2EE gift card goes into your DM with them.
 *
 * Same payment shape as InAppCheckout (read its header): a deferred-intent
 * Elements (`mode: 'payment'` here — a gift is a ONE-TIME charge, never a
 * subscription), and on Pay:
 *
 *   1. elements.submit()
 *   2. stripe.createConfirmationToken({ elements })
 *   3. POST /v1/billing/gifts            -> the PaymentIntent secret + the exact total
 *   4. total != quoted price (tax)        -> "Confirm $5.34" here; nothing charged yet
 *   5. stripe.confirmPayment({ redirect: 'if_required' })  (never a top-level redirect in Electron)
 *   6. POST /v1/billing/gifts/:id/confirm, re-asked every 2 s for ~30 s
 *   7. only on `paid`: celebrate, and send the card (sendGiftCard)
 *
 * Nothing celebrates before the server says `paid`. If it has not after ~30 s,
 * the honest "payment received, finishing up" state says where the gift will
 * appear (Settings -> Subscription -> Sent, which can send the card later).
 * Card + Link only, like every desktop checkout (checkoutPaymentMethods.ts).
 * No "continue in browser" fallback: a load failure offers a retry.
 *
 * Esc cannot abandon a charge in flight (InAppCheckout's busyRef pattern); the
 * X button is never blocked, so a hung 3-D Secure frame can't trap anyone. A
 * payment that completes after the modal was closed still sends the card.
 *
 * Mount it to open it; unmount (via onClose) to close it.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// `/pure`: no Stripe.js network load until loadStripe() is called (see InAppCheckout.tsx).
import { loadStripe } from '@stripe/stripe-js/pure';
import type { Stripe, StripeElementsOptions } from '@stripe/stripe-js';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { AlertTriangle, Check, Gift, Loader2, Lock, RefreshCw, Search, Send, ShieldCheck, X } from 'lucide-react';
import {
    TAX_LOCATION_REQUIRED_CODE,
    apiErrorMessage,
    formatMoney,
    formatTotalBreakdown,
    giftLengthLabel,
    type GiftConfig,
    type GiftPurchaseResult,
} from '@cipherline/shared';
import { ClButton, ClModal, ClSearch, ClSkeleton } from '../../cl';
import { STRIPE_FONTS } from '../stripeAppearance';
import { stripeAppearanceFor } from '../stripeThemeAppearance';
import { getTheme } from '../../../theme/engine';
import { DESKTOP_PAYMENT_ELEMENT_OPTIONS, desktopPaymentMethodTypes } from '../checkoutPaymentMethods';
import { GiftBox } from './GiftBox';
import { useGiftActions, type GiftFriend } from './GiftActionsContext';
import { EncryptedAvatar } from '../../EncryptedAvatar';
import { useAuth } from '../../../contexts/AuthContext';
import { useGiftsApi, type GiftsApi } from './giftsApi';
import { awaitGiftPaid, prepareGiftPurchase } from './giftPurchase';
import {
    avatarInitial,
    filterGiftFriends,
    friendDisplayName,
    friendTag,
    friendlyPaymentError,
    giftFinePrint,
    GIFT_REFUND_NOTICE,
    giftOffers,
    giftPayLabel,
    giftProductLine,
    offerPriceLabel,
    type GiftOffer,
} from './giftCopy';
import '../../../styles/checkout.css'; // .ckt-close (the X), shared with InAppCheckout
import '../../../styles/gifts.css';

export interface GiftProModalProps {
    onClose: () => void;
    /** Pre-select this friend (e.g. opened from a DM). */
    initialRecipientId?: string | null;
    /** A gift was paid (fires before the card is sent) — refresh lists. */
    onPurchased?: (giftId: string) => void;
}

type Step = 'pick' | 'pay' | 'slow' | 'success';
type CardSend = 'sending' | 'sent' | 'failed';

interface Recipient { userId: string; name: string; avatarUrl?: string | null }

/** Avatar fallback colours, picked by id so a friend keeps theirs. */
const AV_BG = ['#25E0C8', '#FFC94D', '#8FA8FF', '#4ADE80', '#FF9F7A', '#C9A7FF'];
function avatarBg(id: string): string {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return AV_BG[h % AV_BG.length];
}

/**
 * A friend's real profile picture (owner, 2026-11-18: the picker and the pay step
 * showed only a coloured circle). Encrypted avatars go through the same
 * EncryptedAvatar the friends list uses; no picture = the coloured initial.
 */
const GiftAvatarImage: React.FC<{ userId: string; avatarUrl: string }> = ({ userId, avatarUrl }) => {
    const { token } = useAuth();
    return <EncryptedAvatar attachmentId={avatarUrl} userId={userId} token={token} className="w-full h-full" fallbackSize={14} />;
};
const GiftAvatar: React.FC<{ userId: string; name: string; avatarUrl?: string | null }> = ({ userId, name, avatarUrl }) => (
    <span className="gft-av" style={avatarUrl ? { overflow: 'hidden' } : { background: avatarBg(userId) }} aria-hidden data-gift-avatar={avatarUrl ? 'image' : 'initial'}>
        {avatarUrl ? <GiftAvatarImage userId={userId} avatarUrl={avatarUrl} /> : avatarInitial(name)}
    </span>
);

export const GiftProModal: React.FC<GiftProModalProps> = ({ onClose, initialRecipientId, onPurchased }) => {
    const api = useGiftsApi();
    const { friends, nameFor, sendGiftCard } = useGiftActions();
    const [config, setConfig] = useState<GiftConfig | null>(null);
    const [configError, setConfigError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);
    const [step, setStep] = useState<Step>('pick');
    const [recipientId, setRecipientId] = useState<string | null>(initialRecipientId ?? null);
    const [months, setMonths] = useState<number | null>(null);
    const [paidGift, setPaidGift] = useState<{ giftId: string; recipient: Recipient; months: number } | null>(null);
    const [cardSend, setCardSend] = useState<CardSend>('sending');
    const stripeRef = useRef<{ key: string; promise: Promise<Stripe | null> } | null>(null);
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);

    useEffect(() => {
        let cancelled = false;
        setConfigError(null);
        api.config().then((cfg) => {
            if (cancelled) return;
            if (!cfg?.publishable_key || giftOffers(cfg).length === 0) {
                setConfigError('Gifts aren’t available right now.');
                return;
            }
            setConfig(cfg);
        }, (err) => {
            if (!cancelled) setConfigError(apiErrorMessage(err, 'Couldn’t load gift prices.'));
        });
        return () => { cancelled = true; };
    }, [api, attempt]);

    const offers = useMemo(() => giftOffers(config), [config]);
    // Default length: 1 month (the first offer); keep a valid choice if the config changes.
    useEffect(() => {
        if (offers.length && !offers.some((o) => o.months === months)) setMonths(offers[0].months);
    }, [offers, months]);
    const offer = offers.find((o) => o.months === months) ?? null;
    const automaticTax = config?.automatic_tax !== false;

    const recipientFriend = friends.find((f) => f.user_id === recipientId) ?? null;
    const recipient: Recipient | null = recipientId
        ? { userId: recipientId, name: recipientFriend ? friendDisplayName(recipientFriend, nameFor) : (nameFor(recipientId) ?? 'your friend'), avatarUrl: recipientFriend?.avatar_url ?? null }
        : null;

    // Esc must not abandon a charge in flight; the X button is never guarded.
    const busyRef = useRef(false);
    const onBusyChange = useCallback((b: boolean) => { busyRef.current = b; }, []);
    const requestClose = useCallback(() => { if (!busyRef.current) onClose(); }, [onClose]);

    const goPay = useCallback(() => {
        if (!config || !offer || !recipient) return;
        if (!stripeRef.current || stripeRef.current.key !== config.publishable_key) {
            stripeRef.current = { key: config.publishable_key, promise: loadStripe(config.publishable_key) };
        }
        setStep('pay');
    }, [config, offer, recipient]);

    /** Paid (server-confirmed). Runs to the end even if the modal has closed. */
    const handlePaid = useCallback(async (giftId: string, to: Recipient, len: number) => {
        onPurchased?.(giftId);
        if (alive.current) {
            setPaidGift({ giftId, recipient: to, months: len });
            setCardSend('sending');
            setStep('success');
        }
        const ok = await sendGiftCard(to.userId, giftId);
        if (alive.current) setCardSend(ok ? 'sent' : 'failed');
    }, [onPurchased, sendGiftCard]);

    const resendCard = useCallback(async () => {
        if (!paidGift || cardSend === 'sending') return;
        setCardSend('sending');
        const ok = await sendGiftCard(paidGift.recipient.userId, paidGift.giftId);
        if (alive.current) setCardSend(ok ? 'sent' : 'failed');
    }, [paidGift, cardSend, sendGiftCard]);

    const elementsOptions = useMemo<StripeElementsOptions | null>(() => (config && offer ? {
        mode: 'payment',
        amount: offer.amount,
        currency: offer.currency,
        // card + link on desktop, always explicit (see checkoutPaymentMethods.ts).
        paymentMethodTypes: desktopPaymentMethodTypes(config.payment_method_types),
        appearance: stripeAppearanceFor(getTheme()),
        fonts: STRIPE_FONTS,
    } : null), [config, offer]);

    let content: React.ReactNode;
    if (step === 'success' && paidGift) {
        content = <GiftSuccessPanel recipientName={paidGift.recipient.name} months={paidGift.months} cardSend={cardSend} onResend={() => { void resendCard(); }} onDone={onClose} />;
    } else if (step === 'slow') {
        content = <GiftSlowPanel onClose={onClose} />;
    } else if (step === 'pay' && offer && recipient && elementsOptions && stripeRef.current) {
        content = (
            <PayStep
                key={`${offer.months}-${recipient.userId}`}
                stripe={stripeRef.current.promise}
                publishableKey={stripeRef.current.key}
                options={elementsOptions}
                offer={offer}
                automaticTax={automaticTax}
                recipient={recipient}
                api={api}
                onBack={() => setStep('pick')}
                onBusyChange={onBusyChange}
                onEscape={requestClose}
                onPaid={(giftId) => { void handlePaid(giftId, recipient, offer.months); }}
                onSlow={() => { if (alive.current) setStep('slow'); }}
            />
        );
    } else {
        content = (
            <GiftPickStep
                friends={friends}
                nameFor={nameFor}
                recipientId={recipientId}
                onRecipient={setRecipientId}
                offers={offers}
                months={months}
                onMonths={setMonths}
                automaticTax={automaticTax}
                loading={!config && !configError}
                error={configError}
                onRetry={() => { setConfig(null); setAttempt((n) => n + 1); }}
                recipientName={recipient?.name ?? null}
                onContinue={goPay}
            />
        );
    }

    return (
        <GiftModalFrame onClose={requestClose} onCloseButton={onClose}>
            {content}
        </GiftModalFrame>
    );
};

/** The modal chrome (exported for the screenshot harness). */
export const GiftModalFrame: React.FC<{ onClose: () => void; onCloseButton?: () => void; children: React.ReactNode }> = ({ onClose, onCloseButton, children }) => {
    // ClModal restores focus when `open` flips; this is unmounted by its host
    // instead, so hand focus back to whatever opened it.
    useEffect(() => {
        const opener = document.activeElement;
        return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
    }, []);
    return (
        <ClModal
            open
            onClose={onClose}
            width={460}
            closeOnOverlay={false}
            cardClassName="gft-mcard"
            overlayStyle={{ zIndex: 2100, background: 'rgba(5,8,16,0.78)', backdropFilter: 'blur(6px)' }}
            label="Gift Cipherline Pro"
        >
            <button type="button" onClick={onCloseButton ?? onClose} className="ckt-close" aria-label="Close">
                <X size={18} aria-hidden />
            </button>
            <div className="gft-modal">{children}</div>
        </ClModal>
    );
};

const ModalHead: React.FC<{ title: string; sub: string }> = ({ title, sub }) => (
    <div className="gft-m-head">
        <GiftBox state="closed" size={52} />
        <div style={{ minWidth: 0, paddingRight: 28 }}>
            <div className="gft-m-title">{title}</div>
            <div className="gft-m-sub">{sub}</div>
        </div>
    </div>
);

// ── Step 1: who + how long ──────────────────────────────────────────────────

export interface GiftPickStepProps {
    friends: GiftFriend[];
    nameFor: (id: string | null | undefined) => string | null;
    recipientId: string | null;
    onRecipient: (id: string) => void;
    offers: GiftOffer[];
    months: number | null;
    onMonths: (m: number) => void;
    automaticTax: boolean;
    loading: boolean;
    error: string | null;
    onRetry: () => void;
    recipientName: string | null;
    onContinue: () => void;
}

export const GiftPickStep: React.FC<GiftPickStepProps> = ({
    friends, nameFor, recipientId, onRecipient, offers, months, onMonths, automaticTax, loading, error, onRetry, recipientName, onContinue,
}) => {
    const [query, setQuery] = useState('');
    const listRef = useRef<HTMLDivElement>(null);
    const shown = useMemo(() => filterGiftFriends(friends, query, (id) => nameFor(id)), [friends, query, nameFor]);
    const offer = offers.find((o) => o.months === months) ?? null;

    /** Up/Down/Home/End move between friends (radiogroup keyboard pattern). */
    const onListKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
        const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.gft-friend') ?? []);
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        let next = -1;
        if (e.key === 'ArrowDown') next = Math.min(items.length - 1, i + 1);
        else if (e.key === 'ArrowUp') next = Math.max(0, i - 1);
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = items.length - 1;
        if (next >= 0 && items[next]) { e.preventDefault(); items[next].focus(); }
    };

    return (
        <>
            <ModalHead title="Gift Cipherline Pro" sub="Pick a friend and a length. They open it from your DM, whenever they like." />
            <div className="gft-m-body">
                <div className="gft-m-label" id="gft-who">Who’s it for?</div>
                {friends.length > 6 && (
                    <ClSearch
                        icon={<Search size={15} aria-hidden />}
                        placeholder="Search friends"
                        aria-label="Search friends"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                )}
                <div className="gft-friends" role="radiogroup" aria-labelledby="gft-who" ref={listRef} onKeyDown={onListKey} data-testid="gift-friends">
                    {friends.length === 0 ? (
                        <div className="gft-friends-empty">Add a friend first — gifts can only go to friends.</div>
                    ) : shown.length === 0 ? (
                        <div className="gft-friends-empty">No friends match “{query.trim()}”.</div>
                    ) : shown.map((f) => {
                        const name = friendDisplayName(f, (id) => nameFor(id));
                        const tag = friendTag(f.discriminator);
                        const on = f.user_id === recipientId;
                        return (
                            <button
                                key={f.user_id}
                                type="button"
                                role="radio"
                                aria-checked={on}
                                className="gft-friend"
                                onClick={() => onRecipient(f.user_id)}
                            >
                                <GiftAvatar userId={f.user_id} name={name} avatarUrl={f.avatar_url} />
                                <span className="gft-name">{name}{tag && <span className="gft-tag"> {tag}</span>}</span>
                                <span className="gft-radio" aria-hidden>{on && <Check size={12} strokeWidth={3.5} />}</span>
                            </button>
                        );
                    })}
                </div>

                <div className="gft-m-label" id="gft-len">How long?</div>
                {error ? (
                    <div className="gft-alert" role="alert" style={{ alignItems: 'center' }}>
                        <AlertTriangle size={14} aria-hidden style={{ flexShrink: 0 }} />
                        <span style={{ flex: 1 }}>{error}</span>
                        <button type="button" className="gft-link" onClick={onRetry}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><RefreshCw size={13} aria-hidden /> Try again</span>
                        </button>
                    </div>
                ) : loading ? (
                    <div className="gft-len" aria-busy="true" aria-label="Loading prices">
                        <ClSkeleton style={{ height: 62, borderRadius: 14 }} />
                        <ClSkeleton style={{ height: 62, borderRadius: 14 }} />
                    </div>
                ) : (
                    <div className="gft-len" role="radiogroup" aria-labelledby="gft-len" data-count={offers.length} data-testid="gift-lengths">
                        {offers.map((o) => (
                            <button
                                key={o.months}
                                type="button"
                                role="radio"
                                aria-checked={o.months === months}
                                className="gft-len-opt"
                                onClick={() => onMonths(o.months)}
                            >
                                <b>{giftLengthLabel(o.months)}</b>
                                <span>{offerPriceLabel(o, automaticTax)}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
            <div className="gft-m-foot">
                <ClButton fullWidth size="lg" onClick={onContinue} disabled={!recipientId || !offer || !!error || loading}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <Gift size={16} aria-hidden /> {offer ? `Continue · ${offerPriceLabel(offer, automaticTax)}` : 'Continue'}
                    </span>
                </ClButton>
                <div className="gft-fine">{recipientId ? giftFinePrint(recipientName) : `One-time payment. Nothing renews. ${GIFT_REFUND_NOTICE}`}</div>
            </div>
        </>
    );
};

// ── Step 2: pay ─────────────────────────────────────────────────────────────

interface PayStepProps {
    stripe: Promise<Stripe | null>;
    /** For a retry after Stripe.js failed to load. */
    publishableKey: string;
    options: StripeElementsOptions;
    offer: GiftOffer;
    automaticTax: boolean;
    recipient: Recipient;
    api: GiftsApi;
    onBack: () => void;
    onBusyChange: (busy: boolean) => void;
    onEscape: () => void;
    onPaid: (giftId: string) => void;
    onSlow: (giftId: string) => void;
}

const PayStep: React.FC<PayStepProps> = (props) => {
    const [loadFailed, setLoadFailed] = useState(false);
    const [retry, setRetry] = useState(0);
    const [stripePromise, setStripePromise] = useState(props.stripe);
    useEffect(() => {
        let cancelled = false;
        stripePromise.then((s) => { if (!cancelled && !s) setLoadFailed(true); }, () => { if (!cancelled) setLoadFailed(true); });
        return () => { cancelled = true; };
    }, [stripePromise]);

    if (loadFailed) {
        return (
            <>
                <ModalHead title="Pay for your gift" sub={giftProductLine(props.offer.months)} />
                <div className="gft-m-body">
                    <div className="gft-wait" role="alert">
                        <b>The payment system couldn’t load</b>
                        <span>Check your connection and try again.</span>
                    </div>
                </div>
                <div className="gft-m-foot">
                    <ClButton fullWidth onClick={() => {
                        setLoadFailed(false);
                        setRetry((n) => n + 1);
                        setStripePromise(loadStripe(props.publishableKey).catch(() => null));
                    }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><RefreshCw size={16} aria-hidden /> Try again</span>
                    </ClButton>
                    <div style={{ marginTop: 8 }}>
                        <ClButton variant="ghost" fullWidth onClick={props.onBack}>Back</ClButton>
                    </div>
                </div>
            </>
        );
    }

    return (
        <Elements key={retry} stripe={stripePromise} options={props.options}>
            <PayForm {...props} />
        </Elements>
    );
};

type PayPhase = 'ready' | 'preparing' | 'confirm' | 'processing' | 'finishing' | 'error';

const PayForm: React.FC<PayStepProps> = ({ offer, automaticTax, recipient, api, onBack, onBusyChange, onEscape, onPaid, onSlow }) => {
    const stripe = useStripe();
    const elements = useElements();
    const [phase, setPhase] = useState<PayPhase>('ready');
    const [ready, setReady] = useState(false);
    const [complete, setComplete] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    /** `tax_location_required`: shown by the form, where the country/ZIP is. */
    const [taxMsg, setTaxMsg] = useState<string | null>(null);
    const [prepared, setPrepared] = useState<GiftPurchaseResult | null>(null);
    const closed = useRef(false);
    useEffect(() => () => { closed.current = true; }, []);

    const busy = phase === 'preparing' || phase === 'processing' || phase === 'finishing';
    useEffect(() => {
        onBusyChange(busy);
        return () => onBusyChange(false);
    }, [busy, onBusyChange]);

    const fail = useCallback((msg: string) => {
        if (closed.current) return;
        setErrorMsg(msg);
        setPhase('error');
    }, []);

    /** Charge, then wait for the server to say paid. Continues if the modal closes. */
    const charge = useCallback(async (quote: GiftPurchaseResult) => {
        if (!stripe || !elements) return;
        setPhase('processing');
        setErrorMsg(null);
        const { error, paymentIntent } = await stripe.confirmPayment({
            elements,
            clientSecret: quote.client_secret,
            redirect: 'if_required',
        });
        if (error) { fail(friendlyPaymentError(error.message)); return; }
        if (!paymentIntent || (paymentIntent.status !== 'succeeded' && paymentIntent.status !== 'processing')) {
            fail('Payment did not complete. Please try again.');
            return;
        }
        if (!closed.current) setPhase('finishing');
        const out = await awaitGiftPaid({
            confirm: () => api.confirm(quote.gift_id),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            now: () => Date.now(),
        });
        if (out.outcome === 'paid') onPaid(quote.gift_id);
        else if (out.outcome === 'slow') onSlow(quote.gift_id);
        else fail('This payment didn’t go through. Please try again.');
    }, [stripe, elements, api, fail, onPaid, onSlow]);

    const submit = useCallback(async () => {
        if (!stripe || !elements || busy) return;
        setPhase('preparing');
        setErrorMsg(null);
        setTaxMsg(null);
        const out = await prepareGiftPurchase({
            submit: () => elements.submit(),
            createToken: () => stripe.createConfirmationToken({ elements }),
            purchase: (tokenId) => api.purchase({ recipient_user_id: recipient.userId, months: offer.months, confirmation_token_id: tokenId }),
        }, { amount: offer.amount, currency: offer.currency });
        if (closed.current) return;
        if (out.kind === 'error') {
            if (out.code === TAX_LOCATION_REQUIRED_CODE) {
                setTaxMsg(out.message);
                setPhase('ready');
            } else {
                fail(out.message);
            }
            return;
        }
        setPrepared(out.result);
        if (out.needsConfirm) { setPhase('confirm'); return; }
        await charge(out.result);
    }, [stripe, elements, busy, api, recipient.userId, offer, charge, fail]);

    const confirmTotal = useCallback(async () => {
        if (!prepared || !elements) return;
        const { error } = await elements.submit();
        if (error) { fail(friendlyPaymentError(error.message)); return; }
        await charge(prepared);
    }, [prepared, elements, charge, fail]);

    const locked = busy || phase === 'confirm';
    const total = prepared ? formatMoney(prepared.amount_total, prepared.currency) : null;

    return (
        <>
            <ModalHead title="Pay for your gift" sub="A one-time payment. Nothing renews." />
            <div className="gft-m-body">
                <div className="gft-for" data-testid="gift-pay-summary">
                    <GiftAvatar userId={recipient.userId} name={recipient.name} avatarUrl={recipient.avatarUrl} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <b>{giftProductLine(offer.months)}</b>
                        <span>for {recipient.name} · {offerPriceLabel(offer, automaticTax)}</span>
                    </div>
                    <button type="button" className="gft-link" onClick={onBack} disabled={locked}>Change</button>
                </div>
                {phase === 'finishing' ? (
                    <div className="gft-wait" role="status">
                        <Loader2 size={22} className="animate-spin" style={{ color: 'var(--cl-lume-text)' }} aria-hidden />
                        <b>Payment received</b>
                        <span>Wrapping your gift…</span>
                    </div>
                ) : (
                    <>
                        {!ready && (
                            <div className="space-y-2.5" aria-busy="true" aria-label="Loading payment form">
                                <ClSkeleton style={{ height: 44, borderRadius: 12 }} />
                                <ClSkeleton style={{ height: 44, borderRadius: 12 }} />
                                <ClSkeleton style={{ height: 44, borderRadius: 12 }} />
                            </div>
                        )}
                        {/* Stays mounted (locked, not disabled) through the tax-confirm
                            step, so Back returns to what was typed and confirmPayment
                            still has its Elements. */}
                        <div style={{ opacity: locked ? 0.55 : 1, pointerEvents: locked ? 'none' : 'auto', transition: 'opacity .2s' }}>
                            <PaymentElement
                                options={DESKTOP_PAYMENT_ELEMENT_OPTIONS}
                                onReady={() => setReady(true)}
                                onChange={(e) => { setComplete(e.complete); if (taxMsg) setTaxMsg(null); }}
                                onEscape={onEscape}
                            />
                        </div>
                        {taxMsg && (
                            <div className="gft-alert" role="alert" style={{ marginTop: 10 }}>
                                <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0 }} aria-hidden /> {taxMsg}
                            </div>
                        )}
                    </>
                )}
            </div>
            <div className="gft-m-foot">
                {phase === 'error' && errorMsg && (
                    <div className="gft-alert" role="alert">
                        <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0 }} aria-hidden /> {errorMsg}
                    </div>
                )}
                {(phase === 'preparing' || phase === 'processing') && <div className="gft-meter" aria-hidden><i /></div>}
                {phase === 'confirm' && prepared ? (
                    <div data-testid="gift-tax-confirm">
                        <div className="gft-total">
                            <div>
                                <small>Your total</small>
                                <span>{formatTotalBreakdown(prepared)}</span>
                            </div>
                            <b>{total}</b>
                        </div>
                        <ClButton fullWidth size="lg" onClick={() => { void confirmTotal(); }}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Lock size={16} aria-hidden /> Confirm {total}</span>
                        </ClButton>
                        <div style={{ marginTop: 8 }}>
                            <ClButton variant="ghost" size="sm" fullWidth onClick={() => { setPhase('ready'); setPrepared(null); }}>Back</ClButton>
                        </div>
                    </div>
                ) : phase !== 'finishing' ? (
                    <ClButton
                        fullWidth
                        size="lg"
                        onClick={() => { void submit(); }}
                        disabled={!stripe || !ready || (!complete && phase === 'ready')}
                        loading={phase === 'preparing' || phase === 'processing'}
                    >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            <Lock size={16} aria-hidden /> {phase === 'error' ? 'Try again' : giftPayLabel(offer, automaticTax)}
                        </span>
                    </ClButton>
                ) : null}
                <div className="gft-fine">{giftFinePrint(recipient.name)}</div>
                <div className="gft-secured"><ShieldCheck size={12} aria-hidden /> Secured by Stripe · your card never touches our servers</div>
            </div>
        </>
    );
};

// ── Step 3: done ────────────────────────────────────────────────────────────

export interface GiftSuccessPanelProps {
    recipientName: string;
    months: number;
    cardSend: CardSend;
    onResend: () => void;
    onDone: () => void;
}

/** The celebration (exported for the screenshot harness). Only ever shown for a server-confirmed `paid` gift. */
export const GiftSuccessPanel: React.FC<GiftSuccessPanelProps> = ({ recipientName, months, cardSend, onResend, onDone }) => {
    const failed = cardSend === 'failed';
    const doneRef = useRef<HTMLDivElement>(null);
    // Hand focus to the panel's main action (Done / Resend) once it is
    // enabled, rather than leaving it on the X or on the Pay button that just unmounted.
    useEffect(() => {
        if (cardSend === 'sending') return;
        // Two frames: ClModal focuses its first focusable in a rAF of its own
        // when both mount together; this must land after it.
        let r2 = 0;
        const r1 = requestAnimationFrame(() => {
            r2 = requestAnimationFrame(() => {
                doneRef.current?.querySelector<HTMLButtonElement>('.gft-done-actions button:not([disabled])')?.focus();
            });
        });
        return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
    }, [cardSend]);
    return (
        <div className="gft-done" data-play="true" data-testid="gift-success" ref={doneRef}>
            <div className="gft-done-stage">
                <GiftBox state="tying" size={150} burst />
            </div>
            <div className="gft-done-copy" role="status" aria-live="polite">
                <h2>{failed ? 'Your gift is paid' : cardSend === 'sent' ? `Sent to ${recipientName}` : 'Gift paid!'}</h2>
                <div className="gft-done-sub">
                    {failed
                        ? <>We couldn’t send the card to {recipientName}. Your gift is safe — send the card again, or later from Settings → Subscription.</>
                        : cardSend === 'sent'
                            ? <>{giftLengthLabel(months)} of Cipherline Pro is waiting in your DM. {recipientName} can open it whenever they like.</>
                            : <>Sending the card to {recipientName}…</>}
                </div>
            </div>
            <div className="gft-done-actions" style={{ width: '100%', padding: '22px 0 20px' }}>
                {failed ? (
                    <>
                        <ClButton fullWidth size="lg" onClick={onResend}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Send size={16} aria-hidden /> Resend card</span>
                        </ClButton>
                        <div style={{ marginTop: 8 }}><ClButton variant="ghost" fullWidth onClick={onDone}>Close</ClButton></div>
                    </>
                ) : (
                    <ClButton fullWidth size="lg" onClick={onDone} loading={cardSend === 'sending'}>Done</ClButton>
                )}
            </div>
        </div>
    );
};

/** Paid at Stripe, not yet confirmed by the server after ~30 s. Honest, no celebration. */
export const GiftSlowPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => (
    <>
        <ModalHead title="Almost there" sub="Your gift is on its way through." />
        <div className="gft-m-body">
            <div className="gft-wait" role="status">
                <Loader2 size={22} className="animate-spin" style={{ color: 'var(--cl-glow-text)' }} aria-hidden />
                <b>Payment received, finishing up</b>
                <span>
                    It’ll appear under Sent gifts in Settings → Subscription, where you can send the card. Please don’t pay again.
                </span>
            </div>
        </div>
        <div className="gft-m-foot">
            <ClButton fullWidth onClick={onClose}>Close</ClButton>
        </div>
    </>
);

export default GiftProModal;
