/**
 * Judge the `POST /billing/cancellation` response against what was asked.
 *
 * A 2xx alone is not proof: Stripe must report `cancel_at_period_end` equal to
 * the request, otherwise the UI would announce "cancelled" while the
 * subscription still auto-renews. `settled` additionally requires our own
 * status row to have caught up, so the caller never claims a state the pane is
 * not showing.
 */
export type CancellationOutcome =
    | { ok: false; message: string }
    | { ok: true; settled: boolean };

export function cancellationOutcome(
    cancel: boolean,
    data: { cancel_at_period_end?: boolean; subscription_status?: string } | null | undefined,
): CancellationOutcome {
    if (data?.cancel_at_period_end !== cancel) {
        return {
            ok: false,
            message: cancel
                ? 'We could not confirm your cancellation, so your subscription will still renew. Please try again.'
                : 'We could not confirm that your subscription was resumed. Please try again.',
        };
    }
    return { ok: true, settled: data.subscription_status === (cancel ? 'canceled_pending' : 'active') };
}
