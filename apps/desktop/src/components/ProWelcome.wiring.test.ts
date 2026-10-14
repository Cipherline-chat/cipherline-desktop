/**
 * Source-level wiring for the "you're Pro" celebration: there is ONE
 * celebration, raised by SubscriptionContext and rendered by Dashboard, and
 * the old per-device `cipherline_pro_welcomed_<uid>` gate (which replayed it
 * for an existing subscriber on every new device, and raced the in-app
 * checkout's status poll) is gone. Behaviour is covered by ProWelcome.test.ts
 * and contexts/SubscriptionContext.proCelebration.test.ts.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('Pro celebration wiring', () => {
    const dashboard = read('components/Dashboard.tsx');
    const checkout = read('components/billing/InAppCheckout.tsx');
    const ctx = read('contexts/SubscriptionContext.tsx');

    it('Dashboard renders ProWelcome from the context flag, outside onboarding, with the username', () => {
        expect(dashboard).toMatch(/const \{ proCelebration, dismissProCelebration \} = useSubscription\(\);/);
        expect(dashboard).toMatch(/showProWelcome && !onboarding\.active && \(\s*<ProWelcome onClose=\{dismissProCelebration\} name=\{user\?\.username\} \/>/);
    });

    it('the old per-device flag is not read or written anywhere', () => {
        for (const src of [dashboard, checkout, ctx]) expect(src).not.toContain('cipherline_pro_welcomed_');
    });

    it('the in-app checkout no longer plays a celebration of its own; it hands off once on success', () => {
        expect(checkout).not.toMatch(/SuccessCelebration|confetti\.map|COLORS\[/);
        expect(checkout).toMatch(/if \(phase !== 'success' \|\| handedOff\.current\) return;/);
    });

    it('SubscriptionContext raises it from the purchase paths that remain', () => {
        // in-app success
        expect(ctx).toMatch(/recordProPurchase\(secureLocalStore, userId\);[\s\S]{0,120}setProCelebration\(true\);/);
        // observed free → paid edge (website, trial → paid)
        expect(ctx).toMatch(/observeProStatus\(secureLocalStore, userId, status, false\)/);
    });

    it('the hosted-Checkout browser fallback is gone from the desktop', () => {
        expect(ctx).not.toMatch(/openCheckout|hostedCheckoutPending|checkoutFallbackError|onFallback/);
        expect(ctx).not.toContain('/billing/checkout');
        expect(checkout).not.toMatch(/onFallback|Continue in browser|checkout_url|createCheckoutSession/);
    });
});
