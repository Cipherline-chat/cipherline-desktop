/**
 * The in-app checkout's layout: a plan summary beside (or, in a narrow window,
 * above) the payment panel. Presentational only — InAppCheckout owns every
 * piece of state and payment logic and hands this the pieces.
 *
 *   wide  (>= CHECKOUT_WIDE_MIN_PX)   [ summary | title + scrolling form + sticky footer ]
 *   narrow                            [ compact summary / title / form / sticky footer ]  (one scroll)
 *
 * Scrolling contract (checkout.css): the modal card is capped to the viewport
 * and never clips. Wide: only `.ckt-scroll` scrolls; the footer (Pay + fine
 * print) is a fixed row under it. Narrow: the whole body scrolls and the footer
 * is `position: sticky; bottom: 0`. Either way Pay is always reachable and
 * Stripe's iframe can grow (Link's "Save my info") without pushing it off.
 */
import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, MonitorUp, ShieldCheck, Sparkles, Upload, Video, HardDrive } from 'lucide-react';
import { formatConfirmedTotal, formatTotalBreakdown, type SubscribeResult } from '@cipherline/shared';
import { Keys, type KeysSignal } from '../mascot/Keys';
import { FREE_UPLOAD_LIMIT_LABEL, PRO_UPLOAD_LIMIT_LABEL } from '../../utils/uploadLimitCopy';
import '../../styles/checkout.css';

/** What Pro adds over the free tier. Mirrors UpgradePromptModal's PERKS,
 *  ProWelcome and BillingService.getEntitlements: video + screen share, the
 *  upload cap, the per-server saved-storage quota. */
export const CHECKOUT_FEATURES = [
    { key: 'video', Icon: Video, title: 'HD video calls', detail: 'Camera on in any call' },
    { key: 'screen', Icon: MonitorUp, title: 'Screen sharing', detail: 'Share your screen live' },
    { key: 'upload', Icon: Upload, title: `${PRO_UPLOAD_LIMIT_LABEL} file uploads`, detail: `Up from ${FREE_UPLOAD_LIMIT_LABEL}` },
    { key: 'storage', Icon: HardDrive, title: 'Bigger saved storage', detail: 'Grows with your server' },
] as const;

export const UNLOCK_LINE = 'Everything unlocks the moment this goes through.';

/** The speech pill under Keys. Keyed on its text so a change animates. */
export const KeysBubble: React.FC<{ text: string; announce?: boolean }> = ({ text, announce = true }) => (
    <AnimatePresence mode="wait">
        <motion.div
            key={text}
            className="ckt-bubble"
            // role=status announces progress ("Working out your total…"); an
            // error is announced by the form's own role=alert, so it is hidden
            // from assistive tech here rather than read twice.
            {...(announce ? { role: 'status' } : { 'aria-hidden': true })}
            initial={{ opacity: 0, y: 6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 320, damping: 22 }}
        >
            {text}
        </motion.div>
    </AnimatePresence>
);

export interface CheckoutSummaryProps {
    wide: boolean;
    /** "$2.50/mo + tax" */
    priceLabel: string;
    /** The server's exact quote once known; replaces the "+ tax" label. */
    total?: SubscribeResult | null;
    signal: KeysSignal;
    bubble: string;
    /** False when the bubble repeats an error shown elsewhere. */
    announceBubble?: boolean;
}

export const CheckoutSummary: React.FC<CheckoutSummaryProps> = ({ wide, priceLabel, total, signal, bubble, announceBubble = true }) => (
    <aside className="ckt-summary" data-testid="checkout-summary" aria-labelledby="ckt-plan-title">
        <div className="ckt-brand">
            <div className="ckt-keys">
                <Keys size={wide ? 88 : 56} signal={signal} interactive={false} waveOnMount={false} />
            </div>
            <div className="ckt-plan">
                <h2 id="ckt-plan-title" className="ckt-plan-title">Cipherline Pro</h2>
                <div className="ckt-price" data-testid="checkout-price">
                    {total ? formatConfirmedTotal(total) : priceLabel}
                </div>
                {total && <div className="ckt-price-sub">{formatTotalBreakdown(total)}</div>}
            </div>
        </div>

        <KeysBubble text={bubble} announce={announceBubble} />

        {wide && (
            <>
                <ul className="ckt-features" data-testid="checkout-features">
                    {CHECKOUT_FEATURES.map(({ key, Icon, title, detail }) => (
                        <li key={key}>
                            <span className="ckt-feat-ico"><Icon size={16} aria-hidden /></span>
                            <span>
                                <span className="ckt-feat-title">{title}</span>
                                <span className="ckt-feat-detail">{detail}</span>
                            </span>
                        </li>
                    ))}
                </ul>
                <ul className="ckt-reassure" data-testid="checkout-reassure">
                    <li><Check size={13} aria-hidden /> Cancel anytime in Settings → Billing</li>
                    <li><ShieldCheck size={13} aria-hidden /> Card details go straight to Stripe, never to our servers</li>
                    <li><Check size={13} aria-hidden /> Text, audio calls and servers stay free</li>
                </ul>
            </>
        )}

        <p className="ckt-unlock" data-testid="checkout-unlock">
            <Sparkles size={13} aria-hidden /> {UNLOCK_LINE}
        </p>
    </aside>
);

export interface CheckoutShellProps {
    wide: boolean;
    /** Rendered without the modal card (the wizard hosts it): static footer. Callers also force wide=false. */
    inline?: boolean;
    summary: React.ReactNode;
    /** Heading of the payment panel. */
    title: string;
    /** Pinned under the scrolling body: errors, Pay / Confirm, fine print. */
    footer?: React.ReactNode;
    children: React.ReactNode;
}

export const CheckoutShell: React.FC<CheckoutShellProps> = ({ wide, inline, summary, title, footer, children }) => (
    <div
        className="ckt"
        data-testid="checkout-layout"
        data-layout={wide ? 'wide' : 'narrow'}
        data-inline={inline ? 'true' : undefined}
    >
        {summary}
        <section className="ckt-pay" aria-label={title}>
            <h3 className="ckt-title">{title}</h3>
            <div className="ckt-scroll" data-testid="checkout-scroll">
                <div className="ckt-form">{children}</div>
            </div>
            {footer && (
                <div className="ckt-footer" data-testid="checkout-footer">
                    <div className="ckt-form">{footer}</div>
                </div>
            )}
        </section>
    </div>
);
