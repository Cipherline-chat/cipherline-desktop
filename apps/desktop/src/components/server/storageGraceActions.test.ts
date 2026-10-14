import { describe, it, expect, vi } from 'vitest';
import { createStorageActionHandler, STORAGE_ACTION_LABELS, type StorageActionDeps } from './storageGraceActions';

function deps(over: Partial<StorageActionDeps> = {}) {
    const d = {
        subscriptionStatus: 'active' as string | null,
        openInAppCheckout: vi.fn(),
        setCancellation: vi.fn(async () => ({ ok: true })),
        openSettings: vi.fn(),
        openExplainer: vi.fn(),
        notify: vi.fn(),
        ...over,
    };
    return d;
}
const flush = () => new Promise(r => setTimeout(r, 0));

describe('storage-grace CTA wiring', () => {
    it('Keep Pro while a cancellation is pending = the existing resume call, never a new checkout', async () => {
        const d = deps({ subscriptionStatus: 'canceled_pending' });
        createStorageActionHandler(d)('keep_pro');
        await flush();
        expect(d.setCancellation).toHaveBeenCalledWith(false);
        expect(d.openInAppCheckout).not.toHaveBeenCalled();
        expect(d.notify).toHaveBeenCalledWith('success', expect.stringContaining('renew'));
    });

    it('Keep Pro reports a failed resume', async () => {
        const d = deps({ subscriptionStatus: 'canceled_pending', setCancellation: vi.fn(async () => ({ ok: false, message: 'Stripe said no' })) });
        createStorageActionHandler(d)('keep_pro');
        await flush();
        expect(d.notify).toHaveBeenCalledWith('error', 'Stripe said no');
    });

    it.each(['trial', 'active', null, undefined])('Keep Pro with status %s opens the in-app checkout', (s) => {
        const d = deps({ subscriptionStatus: s });
        createStorageActionHandler(d)('keep_pro');
        expect(d.openInAppCheckout).toHaveBeenCalledTimes(1);
        expect(d.setCancellation).not.toHaveBeenCalled();
    });

    it('Resubscribe opens the in-app checkout', () => {
        const d = deps({ subscriptionStatus: 'canceled_pending' });
        createStorageActionHandler(d)('resubscribe');
        expect(d.openInAppCheckout).toHaveBeenCalledTimes(1);
        expect(d.setCancellation).not.toHaveBeenCalled();
    });

    it('Transfer ownership opens Members filtered to Pro members', () => {
        const d = deps();
        createStorageActionHandler(d)('transfer');
        expect(d.openSettings).toHaveBeenCalledWith({ tab: 'members', proOnly: true });
    });

    it('Manage storage opens Server Settings -> Storage', () => {
        const d = deps();
        createStorageActionHandler(d)('manage_storage');
        expect(d.openSettings).toHaveBeenCalledWith({ tab: 'storage' });
    });

    it('Learn more opens the explainer and nothing else', () => {
        const d = deps();
        createStorageActionHandler(d)('learn_more');
        expect(d.openExplainer).toHaveBeenCalledTimes(1);
        expect(d.openSettings).not.toHaveBeenCalled();
        expect(d.openInAppCheckout).not.toHaveBeenCalled();
    });

    it('button labels', () => {
        expect(STORAGE_ACTION_LABELS).toEqual({
            keep_pro: 'Keep Pro', resubscribe: 'Resubscribe', transfer: 'Transfer ownership',
            manage_storage: 'Manage storage', learn_more: 'Learn more',
        });
    });
});
