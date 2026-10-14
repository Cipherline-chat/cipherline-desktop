/**
 * What each storage-grace button DOES. Shared by the server banner and Server
 * Settings -> Storage so the two can't drift, and kept free of React so the
 * wiring is tested directly (storageGraceActions.test.ts).
 *
 * Everything routes into flows that already exist:
 *   - Keep Pro: while a cancellation is pending, the existing "resume" call
 *     (`setCancellation(false)`, the same one BillingTab's Resume button makes);
 *     otherwise the in-app checkout.
 *   - Resubscribe: the in-app checkout (the owner is on the free plan by then).
 *   - Transfer ownership: Server Settings -> Members, filtered to Pro members —
 *     the existing transfer dialog (password step-up included) does the rest.
 *   - Manage storage: Server Settings -> Storage.
 *   - Learn more: the in-app explainer.
 */
import type { StorageBannerAction } from '../../utils/serverStorageGrace';

export type StorageSettingsTarget =
    | { tab: 'storage' }
    | { tab: 'members'; proOnly: boolean };

export interface StorageActionDeps {
    /** `subscription_status` from the billing status, if loaded. */
    subscriptionStatus: string | null | undefined;
    openInAppCheckout: () => void;
    setCancellation: (cancel: boolean) => Promise<{ ok: boolean; message?: string }>;
    openSettings: (target: StorageSettingsTarget) => void;
    openExplainer: () => void;
    notify: (kind: 'success' | 'error', message: string) => void;
}

export function createStorageActionHandler(deps: StorageActionDeps): (action: StorageBannerAction) => void {
    return (action) => {
        switch (action) {
            case 'keep_pro':
                if (deps.subscriptionStatus === 'canceled_pending') {
                    void deps.setCancellation(false).then(
                        (r) => r.ok
                            ? deps.notify('success', 'Welcome back! Your subscription will renew as normal.')
                            : deps.notify('error', r.message ?? 'That didn’t work. Please try again.'),
                        () => deps.notify('error', 'That didn’t work. Please try again.'),
                    );
                } else {
                    deps.openInAppCheckout();
                }
                return;
            case 'resubscribe':
                deps.openInAppCheckout();
                return;
            case 'transfer':
                deps.openSettings({ tab: 'members', proOnly: true });
                return;
            case 'manage_storage':
                deps.openSettings({ tab: 'storage' });
                return;
            case 'learn_more':
                deps.openExplainer();
                return;
        }
    };
}

export const STORAGE_ACTION_LABELS: Record<StorageBannerAction, string> = {
    keep_pro: 'Keep Pro',
    resubscribe: 'Resubscribe',
    transfer: 'Transfer ownership',
    manage_storage: 'Manage storage',
    learn_more: 'Learn more',
};
