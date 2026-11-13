import React, { useEffect, useRef } from 'react';
import { AlertTriangle, Award } from 'lucide-react';
import { ClButton, ClModal, ClSlideConfirm } from '../cl';
import type { FounderCancelPrompt as FounderCancelCopy } from '@cipherline/shared';

/**
 * The big cancel confirmation for a founding member whose price lock is still
 * in force (owner, 2026-11-12: "a big prompt with like a slide to cancel that
 * says they will lose their founder price"). Copy and the "is this a locked
 * founder?" decision come from `founderCancelPrompt` in
 * packages/shared/billing.ts, so the website account portal says the same.
 *
 * Replaces the ordinary two-step "Cancel your subscription?" panel for those
 * accounts only. "Keep my founding price" is the primary action and takes the
 * default focus; it, Escape and the overlay all send nothing. Only a COMPLETED
 * slide on ClSlideConfirm (drag to the end, hold Enter/Space, or arrow to the
 * end) calls `onCancel`.
 *
 * `children` is the ordinary panel's body (what happens to Pro until the paid
 * period ends, the server-storage notes) so a founder sees everything a
 * non-founder does.
 */
export const FounderCancelPrompt: React.FC<{
    open: boolean;
    copy: FounderCancelCopy;
    busy?: boolean;
    /** Keep the subscription: closes the modal, makes NO cancel call. */
    onKeep: () => void;
    /** A completed slide: go through with the cancel. */
    onCancel: () => void;
    children?: React.ReactNode;
}> = ({ open, copy, busy, onKeep, onCancel, children }) => {
    const keepRef = useRef<HTMLSpanElement>(null);
    useKeepFocus(open, keepRef);
    return (
    <ClModal
        open={open}
        onClose={() => { if (!busy) onKeep(); }}
        width={480}
        label={copy.title}
        cardStyle={{ padding: 0 }}
    >
        <div data-testid="founder-cancel-prompt" style={{ padding: '24px 24px 22px' }}>
            <span
                aria-hidden
                style={{
                    width: 44, height: 44, borderRadius: 14, display: 'grid', placeItems: 'center', marginBottom: 14,
                    background: 'rgba(255,107,94,.12)', border: '1px solid rgba(255,107,94,.28)', color: 'var(--cl-flash)',
                }}
            >
                <AlertTriangle size={20} />
            </span>
            <h2
                data-testid="founder-cancel-title"
                style={{ fontFamily: 'var(--cl-font-display)', fontWeight: 600, fontSize: 22, lineHeight: 1.2, color: 'var(--cl-text)', margin: '0 0 14px' }}
            >
                {copy.title}
            </h2>

            {/* Now vs. coming back later */}
            <div className="flex gap-2.5" style={{ marginBottom: 14 }}>
                <div data-testid="founder-cancel-now" style={{ flex: 1, minWidth: 0, borderRadius: 14, padding: '11px 13px', background: 'var(--cl-lume-tint)', border: '1px solid rgba(37,224,200,.30)' }}>
                    <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--cl-lume)' }}>Your founding price</div>
                    <div style={{ marginTop: 3, fontWeight: 800, fontSize: 15.5, color: 'var(--cl-text)' }}>{copy.nowPrice}</div>
                </div>
                <div data-testid="founder-cancel-later" style={{ flex: 1, minWidth: 0, borderRadius: 14, padding: '11px 13px', background: 'var(--cl-surface)', border: '1px solid var(--cl-border)' }}>
                    <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--cl-muted)' }}>If you come back later</div>
                    <div style={{ marginTop: 3, fontWeight: 800, fontSize: 15.5, color: 'var(--cl-muted)' }}>{copy.laterPrice}</div>
                </div>
            </div>

            <p data-testid="founder-cancel-warning" style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--cl-text)', margin: '0 0 4px' }}>
                {copy.warning}
            </p>
            {children}
            <p data-testid="founder-cancel-reassurance" className="flex items-start gap-2" style={{ fontSize: 13, fontWeight: 700, color: 'var(--cl-text)', margin: '0 0 18px' }}>
                <Award size={15} aria-hidden style={{ color: 'var(--cl-glow)', flexShrink: 0, marginTop: 1 }} />
                <span>{copy.reassurance}</span>
            </p>

            <div className="flex flex-col gap-3">
                {/* First focusable in the card, so ClModal gives it the default focus. */}
                <span ref={keepRef} data-testid="founder-cancel-keep" style={{ display: 'block' }}>
                    <ClButton type="button" variant="primary" fullWidth onClick={onKeep} disabled={busy}>
                        {copy.keepLabel}
                    </ClButton>
                </span>
                <ClSlideConfirm
                    data-testid="founder-cancel-slide"
                    label={copy.slideLabel}
                    ariaLabel={copy.slideAriaLabel}
                    busy={busy}
                    busyLabel="Cancelling…"
                    onConfirm={onCancel}
                />
            </div>
        </div>
    </ClModal>
    );
};

/**
 * Default focus on "Keep my founding price". ClModal focuses its first
 * focusable in one rAF after mounting, which races the card's own mount when
 * the modal starts closed (seen in real Chromium); this makes the safe action
 * the focused one regardless, retrying for a few frames until it exists.
 */
function useKeepFocus(open: boolean, ref: React.RefObject<HTMLSpanElement | null>) {
    useEffect(() => {
        if (!open) return;
        let tries = 0;
        let raf = 0;
        const go = () => {
            const btn = ref.current?.querySelector('button');
            if (btn) { if (!btn.contains(document.activeElement)) btn.focus(); return; }
            if (++tries < 20) raf = requestAnimationFrame(go);
        };
        raf = requestAnimationFrame(() => { raf = requestAnimationFrame(go); });
        return () => cancelAnimationFrame(raf);
    }, [open, ref]);
}
