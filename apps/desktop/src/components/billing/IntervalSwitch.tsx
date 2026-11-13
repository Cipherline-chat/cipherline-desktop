/**
 * Settings -> Subscription: switch between monthly and yearly billing.
 *
 * Shown only for an active, paid plan with no scheduled cancel on an API that
 * offers yearly (planInterval.canSwitchInterval). Nothing is changed by the
 * first click: it asks the server for a read-only preview and states EXACTLY
 * what will happen and when; only the confirm button sends the change.
 *
 *   monthly -> yearly  charged now (prorated), then the yearly price from <date>
 *   yearly -> monthly  nothing today, no refund; switches at the end of the paid year
 *   pending switch     "Switches to monthly on <date>" + Undo (re-requests the CURRENT interval)
 */
import React, { useCallback, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { ClButton } from '../cl';
import { useSubscription } from '../../contexts/SubscriptionContext';
import { useToast } from '../../contexts/ToastContext';
import { founderLockActive, type BillingInterval, type FounderStatus } from '@cipherline/shared';
import {
    pendingSwitchLine, switchActionLabel, switchConfirmCopy, switchResultMessage, targetInterval,
    type PlanIntervalView, type SwitchConfirmCopy,
} from './planInterval';

type Confirm =
    | { kind: 'loading'; target: BillingInterval }
    | { kind: 'ready'; target: BillingInterval; copy: SwitchConfirmCopy }
    | { kind: 'error'; target: BillingInterval; message: string };

export const IntervalSwitch: React.FC<{
    current: BillingInterval;
    plan: PlanIntervalView;
    founder: FounderStatus | null | undefined;
}> = ({ current, plan, founder }) => {
    const { previewIntervalChange, changeInterval } = useSubscription();
    const { push: pushToast } = useToast();
    const [confirm, setConfirm] = useState<Confirm | null>(null);
    const [busy, setBusy] = useState(false);
    const pending = pendingSwitchLine(plan);
    const isFounder = !!founder && founderLockActive(founder);

    const start = useCallback(async () => {
        const target = targetInterval(current);
        setConfirm({ kind: 'loading', target });
        const r = await previewIntervalChange(target);
        if (!r.ok || !r.preview) {
            setConfirm({ kind: 'error', target, message: r.message ?? 'Could not work out that change. Please try again.' });
            return;
        }
        const copy = switchConfirmCopy({ from: current, preview: r.preview, isFounder });
        setConfirm(copy
            ? { kind: 'ready', target, copy }
            : { kind: 'error', target, message: 'Could not work out the exact amount and date for that change. Please try again in a moment.' });
    }, [current, previewIntervalChange, isFounder]);

    /** Send a change: the confirmed target, or (Undo) the interval we are already on. */
    const send = useCallback(async (requested: BillingInterval, kind: 'switch' | 'undo') => {
        if (busy) return;
        setBusy(true);
        try {
            const r = await changeInterval(requested);
            if (r.ok && r.result) {
                pushToast({
                    kind: 'success',
                    message: switchResultMessage(kind, requested, r.result),
                });
                setConfirm(null);
            } else {
                pushToast({ kind: 'error', title: 'Billing interval', message: r.message ?? 'That didn’t work. Please try again.' });
            }
        } finally {
            setBusy(false);
        }
    }, [busy, changeInterval, pushToast]);

    return (
        <div data-testid="interval-switch" style={{ marginTop: 12 }}>
            {pending ? (
                <div className="flex flex-wrap items-center gap-3">
                    <span className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--cl-muted)' }} data-testid="interval-pending">
                        <CalendarClock size={14} aria-hidden style={{ color: 'var(--cl-warm, var(--cl-muted))' }} /> {pending}
                    </span>
                    <span data-testid="interval-undo">
                        <ClButton type="button" variant="ghost" size="sm" onClick={() => { void send(current, 'undo'); }} loading={busy}>
                            Undo
                        </ClButton>
                    </span>
                </div>
            ) : !confirm ? (
                <span data-testid="interval-switch-open">
                    <ClButton type="button" variant="ghost" onClick={() => { void start(); }}>
                        {switchActionLabel(current)}
                    </ClButton>
                </span>
            ) : (
                <div
                    className="rounded-xl p-4"
                    data-testid="interval-confirm"
                    style={{ background: 'var(--cl-surface)', border: '1px solid var(--cl-border)' }}
                >
                    {confirm.kind === 'loading' && (
                        <p className="text-[13px] m-0" style={{ color: 'var(--cl-muted)' }} role="status">Working out the details…</p>
                    )}
                    {confirm.kind === 'error' && (
                        <>
                            <p className="text-[13px] leading-relaxed m-0 mb-3" style={{ color: 'var(--cl-flash)' }} role="alert" data-testid="interval-confirm-error">{confirm.message}</p>
                            <ClButton type="button" variant="ghost" onClick={() => setConfirm(null)}>Close</ClButton>
                        </>
                    )}
                    {confirm.kind === 'ready' && (
                        <>
                            <b style={{ fontSize: 14 }} data-testid="interval-confirm-title">{confirm.copy.title}</b>
                            {confirm.copy.lines.map((l) => (
                                <p key={l} className="text-[13px] leading-relaxed" style={{ color: 'var(--cl-muted)', margin: '6px 0 12px' }} data-testid="interval-confirm-line">{l}</p>
                            ))}
                            <div className="flex flex-wrap items-center gap-2">
                                <span data-testid="interval-confirm-go">
                                    <ClButton type="button" variant="primary" onClick={() => { void send(confirm.target, 'switch'); }} loading={busy}>
                                        {confirm.copy.confirmLabel}
                                    </ClButton>
                                </span>
                                <ClButton type="button" variant="ghost" onClick={() => setConfirm(null)} disabled={busy}>
                                    Never mind
                                </ClButton>
                            </div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
};

export default IntervalSwitch;
