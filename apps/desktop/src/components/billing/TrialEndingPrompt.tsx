/**
 * TrialEndingPrompt — the one modal a trial gets before it ends.
 *
 * The rules (who, when, what) live in trialEndingPromptRule.ts and are unit-tested
 * there; this file renders them. Hosted once by the Dashboard, which passes
 * `blocked` while a call is live, ringing or starting, and while onboarding or
 * another celebration owns the screen.
 *
 * "Last shown" is device-local in secureLocalStore (never raw localStorage) and
 * is written when the prompt OPENS, so quitting with it on screen still counts
 * as today's appearance. The account's encrypted store is cold until
 * whenAccountReady(): reading it earlier would look like "never shown".
 */
import React, { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion, type Variants } from 'framer-motion';
import { Check, Clock, Award, ArrowRight } from 'lucide-react';
import { ClModal, ClButton } from '../cl';
import { useSubscription } from '../../contexts/SubscriptionContext';
import { useAuth } from '../../contexts/AuthContext';
import secureLocalStore from '../../utils/secureLocalStore';
import {
    trialPromptCopy, trialPromptToShow, recordTrialPromptShown, parseTrialPromptRecord,
    trialPromptKey, localDay, type TrialPromptCopy, type TrialPromptStatus,
} from './trialEndingPromptRule';

/** Let the app settle after boot (and after a call ends) before anything pops. */
const SETTLE_MS = 4000;

/* ── View ──────────────────────────────────────────────────────────────── */

export const TrialEndingPromptView: React.FC<{
    open: boolean;
    copy: TrialPromptCopy;
    onKeep: () => void;
    onLater: () => void;
}> = ({ open, copy, onKeep, onLater }) => {
    const reduced = useReducedMotion();
    const container: Variants = {
        hidden: {},
        show: { transition: reduced ? {} : { staggerChildren: 0.05, delayChildren: 0.05 } },
    };
    const rise: Variants = {
        hidden: { opacity: reduced ? 1 : 0, y: reduced ? 0 : 8 },
        show: { opacity: 1, y: 0, transition: reduced ? { duration: 0 } : { type: 'spring', stiffness: 320, damping: 26 } },
    };
    const founder = copy.variant === 'founder';
    // The founding offer has its own look (owner, 2026-11-12: "it looks like a
    // regular pop up"); the closed / no-data variant keeps the standard one.
    if (founder) return <FounderOfferView open={open} copy={copy} onKeep={onKeep} onLater={onLater} rise={rise} container={container} />;

    return (
        <ClModal open={open} onClose={onLater} width={440} label={copy.title} cardStyle={{ padding: 0, overflow: 'hidden' }}>
            <motion.div
                data-testid="trial-ending-prompt"
                data-variant={copy.variant}
                variants={container}
                initial="hidden"
                animate="show"
                style={{ padding: '24px 24px 20px' }}
            >
                {/* Header */}
                <motion.div variants={rise} className="flex items-center gap-2" style={{ marginBottom: 10 }}>
                    <span
                        className="inline-flex items-center gap-1.5"
                        style={{
                            fontSize: 11.5, fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase',
                            color: 'var(--cl-glow)', background: 'rgba(255,201,77,.10)', border: '1px solid rgba(255,201,77,.22)',
                            borderRadius: 999, padding: '3px 9px 3px 7px',
                        }}
                    >
                        <Clock size={12} aria-hidden /> {copy.eyebrow}
                    </span>
                </motion.div>
                <motion.h2
                    variants={rise}
                    style={{ fontFamily: 'var(--cl-font-display)', fontWeight: 600, fontSize: 22, lineHeight: 1.2, color: 'var(--cl-text)', margin: '0 0 16px' }}
                >
                    {copy.title}
                </motion.h2>

                {/* The offer */}
                <motion.div
                    variants={rise}
                    data-testid="trial-prompt-offer"
                    style={{
                        background: 'var(--cl-surface)',
                        border: `1px solid ${founder ? 'rgba(37,224,200,.32)' : 'var(--cl-border)'}`,
                        borderRadius: 16, padding: '16px 16px 14px',
                    }}
                >
                    {founder && (
                        <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--cl-lume)', marginBottom: 6 }}>
                            Founding price
                        </div>
                    )}
                    <div className="flex items-baseline gap-1.5" style={{ color: 'var(--cl-text)' }}>
                        <span data-testid="trial-prompt-price" style={{ fontFamily: 'var(--cl-font-display)', fontWeight: 600, fontSize: 34, lineHeight: 1 }}>
                            {copy.priceAmount}
                        </span>
                        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--cl-muted)' }}>{copy.priceSuffix}</span>
                    </div>
                    <p style={{ margin: '8px 0 0', fontSize: 13.5, lineHeight: 1.45, color: 'var(--cl-text)', fontWeight: 600 }}>
                        {copy.priceNote}
                    </p>
                    {copy.yearlyNote && (
                        <p data-testid="trial-prompt-yearly" style={{ margin: '4px 0 0', fontSize: 13, lineHeight: 1.45, color: 'var(--cl-muted)' }}>
                            {copy.yearlyNote.replace(/ \+ tax/g, ' + tax')}
                        </p>
                    )}
                    {copy.riseNote && (
                        <p data-testid="trial-prompt-rise" style={{ margin: '4px 0 0', fontSize: 13, lineHeight: 1.45, color: 'var(--cl-muted)' }}>
                            {/* keep "+ tax" on the price's line */}
                            {copy.riseNote.replace(/ \+ tax/g, '\u00a0+\u00a0tax')}
                        </p>
                    )}
                </motion.div>

                {/* What Pro keeps */}
                <motion.ul variants={rise} style={{ listStyle: 'none', padding: 0, margin: '14px 2px 18px' }}>
                    {copy.perks.map((p) => (
                        <li key={p} className="flex items-center gap-2" style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--cl-muted)', padding: '3px 0' }}>
                            <Check size={14} aria-hidden style={{ color: 'var(--cl-lume)', flexShrink: 0 }} />
                            {p}
                        </li>
                    ))}
                </motion.ul>

                <motion.div variants={rise} className="flex flex-col gap-2.5">
                    <span data-testid="trial-prompt-keep" style={{ display: 'block' }}>
                        <ClButton fullWidth onClick={onKeep}>{copy.primaryLabel}</ClButton>
                    </span>
                    <span data-testid="trial-prompt-later" style={{ display: 'block' }}>
                        <ClButton fullWidth variant="ghost" onClick={onLater}>{copy.secondaryLabel}</ClButton>
                    </span>
                </motion.div>
                <motion.p variants={rise} style={{ margin: '12px 2px 0', fontSize: 12, lineHeight: 1.45, color: 'var(--cl-faint)', textAlign: 'center' }}>
                    {copy.footnote}
                </motion.p>
            </motion.div>
        </ClModal>
    );
};

/* ── Founder-offer look ─────────────────────────────────────────────────
 * Warm gold "founder" palette (the Founder badge's colours) on the deep card,
 * a gold gradient border, a lit hero band with a gold medallion, the old price
 * struck through. Everything is STATIC: no shimmer or pulse at all, so there is
 * nothing for prefers-reduced-motion to switch off beyond the shared entrance
 * (already gated). Contrast (on --cl-deep #131A30): gold #FFC94D ~11:1, text
 * #F4F7FF ~16:1, warm muted #E8D9B8 ~12:1, muted #A7B3D4 ~8:1; button text
 * #3A2700 on #FFC94D ~10:1. No --cl-faint here (only ~3.3:1 at small sizes). */
const GOLD = '#FFC94D';
const GOLD_SOFT = '#E8D9B8';

const FounderOfferView: React.FC<{
    open: boolean;
    copy: TrialPromptCopy;
    onKeep: () => void;
    onLater: () => void;
    rise: Variants;
    container: Variants;
}> = ({ open, copy, onKeep, onLater, rise, container }) => (
    <ClModal
        open={open}
        onClose={onLater}
        width={460}
        label={copy.headline ?? copy.title}
        cardStyle={{
            padding: 0, overflow: 'hidden', borderRadius: 28,
            border: '1.5px solid transparent',
            background: 'linear-gradient(var(--cl-deep), var(--cl-deep)) padding-box, '
                + 'linear-gradient(155deg, #FFE08A 0%, #F2A93B 38%, rgba(255,201,77,.18) 72%, rgba(255,201,77,.45) 100%) border-box',
            boxShadow: '0 28px 80px -24px rgba(255,176,46,.38), 0 0 0 1px rgba(0,0,0,.25)',
        }}
    >
        <motion.div
            data-testid="trial-ending-prompt"
            data-variant="founder"
            variants={container}
            initial="hidden"
            animate="show"
        >
            {/* Hero band */}
            <div
                style={{
                    position: 'relative', textAlign: 'center', padding: '30px 26px 20px',
                    background: 'radial-gradient(120% 95% at 50% 0%, rgba(255,201,77,.24) 0%, rgba(255,201,77,0) 68%), '
                        + 'linear-gradient(180deg, #241F33 0%, var(--cl-deep) 100%)',
                }}
            >
                <motion.div variants={rise} style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
                    <span
                        data-testid="trial-prompt-medallion"
                        aria-hidden
                        style={{
                            width: 74, height: 74, borderRadius: '50%', display: 'grid', placeItems: 'center',
                            background: 'radial-gradient(circle at 34% 28%, #FFF0C2 0%, #FFC94D 42%, #D48F1C 100%)',
                            boxShadow: '0 0 0 6px rgba(255,201,77,.12), 0 0 0 7px rgba(255,201,77,.28), 0 12px 32px rgba(255,166,36,.35), inset 0 -3px 0 rgba(122,72,0,.35)',
                            color: '#4A3406',
                        }}
                    >
                        <Award size={36} strokeWidth={2.2} />
                    </span>
                </motion.div>
                <motion.div variants={rise}>
                    <span
                        data-testid="trial-prompt-eyebrow"
                        className="inline-flex items-center gap-1.5"
                        style={{
                            fontSize: 11.5, fontWeight: 800, letterSpacing: '.06em', textTransform: 'uppercase',
                            color: GOLD, background: 'rgba(255,201,77,.10)', border: '1px solid rgba(255,201,77,.30)',
                            borderRadius: 999, padding: '4px 10px 4px 8px',
                        }}
                    >
                        <Clock size={12} aria-hidden /> {copy.eyebrow}
                    </span>
                </motion.div>
                <motion.h2
                    variants={rise}
                    data-testid="trial-prompt-headline"
                    style={{ fontFamily: 'var(--cl-font-display)', fontWeight: 600, fontSize: 30, lineHeight: 1.1, color: 'var(--cl-text)', margin: '14px 0 6px' }}
                >
                    {copy.headline}
                </motion.h2>
                <motion.p variants={rise} data-testid="trial-prompt-qualifier" style={{ margin: 0, fontSize: 14.5, fontWeight: 700, color: GOLD_SOFT }}>
                    {copy.qualifier}
                </motion.p>

                {/* Price: the regular price struck through -> the founding price */}
                <motion.div
                    variants={rise}
                    data-testid="trial-prompt-price-row"
                    className="flex items-center justify-center"
                    style={{ gap: 14, marginTop: 18 }}
                >
                    <span style={{ fontFamily: 'var(--cl-font-display)', fontWeight: 600, fontSize: 24, color: 'var(--cl-muted)' }}>
                        <s data-testid="trial-prompt-was" style={{ textDecorationColor: 'rgba(255,107,94,.75)', textDecorationThickness: 2 }} aria-label={`was ${copy.wasPrice}`}>
                            {copy.wasPrice}
                        </s>
                    </span>
                    <ArrowRight size={20} aria-hidden style={{ color: GOLD_SOFT }} />
                    <span className="flex items-baseline" style={{ gap: 5 }}>
                        <span data-testid="trial-prompt-price" style={{ fontFamily: 'var(--cl-font-display)', fontWeight: 600, fontSize: 46, lineHeight: 1, color: GOLD }}>
                            {copy.priceAmount}
                        </span>
                        <span style={{ fontSize: 14.5, fontWeight: 800, color: GOLD_SOFT }}>{copy.priceSuffix}</span>
                    </span>
                </motion.div>
                <motion.p variants={rise} data-testid="trial-prompt-rise" style={{ margin: '12px auto 0', maxWidth: 340, fontSize: 13, lineHeight: 1.45, color: 'var(--cl-muted)' }}>
                    {/* keep "+ tax" on the price's line */}
                    {copy.riseNote?.replace(/ \+ tax/g, ' + tax')}
                </motion.p>
            </div>

            {copy.yearlyNote && (
                <p data-testid="trial-prompt-yearly" style={{ margin: '10px 26px 0', fontSize: 13, lineHeight: 1.45, color: 'var(--cl-muted)', textAlign: 'center' }}>
                    {copy.yearlyNote}
                </p>
            )}
            <div style={{ padding: '6px 26px 22px' }}>
                {/* Perks: the Founder badge leads */}
                <motion.ul variants={rise} style={{ listStyle: 'none', padding: '12px 14px', margin: '0 0 18px', borderRadius: 16, background: 'rgba(255,201,77,.06)', border: '1px solid rgba(255,201,77,.16)' }}>
                    {copy.perks.map((p, i) => (
                        <li key={p} className="flex items-center gap-2.5" style={{ fontSize: 13.5, fontWeight: i === 0 ? 800 : 600, color: i === 0 ? 'var(--cl-text)' : GOLD_SOFT, padding: '3px 0' }}>
                            {i === 0
                                ? <Award size={15} aria-hidden style={{ color: GOLD, flexShrink: 0 }} />
                                : <Check size={15} aria-hidden style={{ color: GOLD, flexShrink: 0 }} />}
                            {p}
                        </li>
                    ))}
                </motion.ul>

                <motion.div variants={rise} className="flex flex-col gap-2.5">
                    {/* Gold primary: the kit button, re-tinted through its own tokens. */}
                    <span
                        data-testid="trial-prompt-keep"
                        style={{
                            display: 'block',
                            ['--lume' as string]: GOLD, ['--lume-hi' as string]: '#FFD873',
                            ['--lume-press' as string]: '#E0A52A', ['--lume-deep' as string]: '#A8700F',
                            ['--on-lume' as string]: '#3A2700',
                        } as React.CSSProperties}
                    >
                        <ClButton fullWidth onClick={onKeep}>{copy.primaryLabel}</ClButton>
                    </span>
                    <span data-testid="trial-prompt-later" style={{ display: 'block' }}>
                        <ClButton fullWidth variant="ghost" onClick={onLater}>{copy.secondaryLabel}</ClButton>
                    </span>
                </motion.div>
                <motion.p variants={rise} data-testid="trial-prompt-footnote" style={{ margin: '12px 4px 0', fontSize: 12, lineHeight: 1.45, color: 'var(--cl-muted)', textAlign: 'center' }}>
                    {copy.priceNote} {copy.footnote}
                </motion.p>
            </div>
        </motion.div>
    </ClModal>
);

/* ── Host ──────────────────────────────────────────────────────────────── */

function readRecord(uid: string) {
    try { return parseTrialPromptRecord(secureLocalStore.getItem(trialPromptKey(uid))); } catch { return {}; }
}

export const TrialEndingPrompt: React.FC<{ blocked: boolean }> = ({ blocked }) => {
    const { status, openInAppCheckout } = useSubscription();
    const { userId } = useAuth();
    // The account's encrypted store is cold until whenAccountReady(); read at
    // render time, with a tick to re-render once it warms up.
    const [, setReadyTick] = useState(0);
    const storeReady = !!userId && secureLocalStore.isAccountReady(userId);
    /** The status the open prompt was built from: copy stays put while it is up. */
    const [shown, setShown] = useState<TrialPromptStatus | null>(null);
    const [open, setOpen] = useState(false);
    const shownRef = useRef(false);

    useEffect(() => {
        if (!userId || secureLocalStore.isAccountReady(userId)) return;
        let cancelled = false;
        void secureLocalStore.whenAccountReady().then(
            () => { if (!cancelled) setReadyTick(t => t + 1); },
            () => { /* store stays cold: the prompt simply never shows */ },
        );
        return () => { cancelled = true; };
    }, [userId]);

    // A call (or anything else that blocks) closes it; it is not shown again today.
    useEffect(() => {
        if (blocked && shownRef.current) { shownRef.current = false; setOpen(false); }
    }, [blocked]);

    useEffect(() => {
        if (!storeReady || !userId || blocked || shownRef.current) return;
        const t = setTimeout(() => {
            const record = readRecord(userId);
            const today = localDay();
            const stage = trialPromptToShow({ status, record, today, blocked: false });
            if (!stage || !status) return;
            try {
                secureLocalStore.setItem(trialPromptKey(userId), JSON.stringify(recordTrialPromptShown(record, stage, today)));
            } catch { return; /* can't record it -> don't show it (it would show on every launch) */ }
            shownRef.current = true;
            setShown(status);
            setOpen(true);
        }, SETTLE_MS);
        return () => clearTimeout(t);
    }, [storeReady, userId, status, blocked]);

    if (!shown) return null;
    // Close keeps the snapshot mounted so ClModal can play its exit.
    const close = () => { shownRef.current = false; setOpen(false); };
    return (
        <TrialEndingPromptView
            open={open}
            copy={trialPromptCopy(shown)}
            onKeep={() => { close(); openInAppCheckout(); }}
            onLater={close}
        />
    );
};

export default TrialEndingPrompt;
