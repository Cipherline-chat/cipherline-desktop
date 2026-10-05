import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-level wiring guards for the "your free trial was withheld" fix.
 *
 * `POST /auth/finalize` returns `trial_granted: false` when the P2-BILL-6
 * anti-farming quota denied a brand-new account's trial (see
 * apps/api/src/auth/auth.service.ts). Before this fix that fact reached
 * nowhere: the account was silently created as `subscription_status:
 * 'expired'` and the user hit "Start your Cipherline Pro trial" in
 * onboarding only to be told it had already expired.
 *
 * These pin *plumbing*, not visual output — the class of bug where a value
 * is computed correctly on the server and then dropped on the floor by one
 * of the three hops it needs to cross (AuthScreen -> RegistrationWizard ->
 * FeatureShowcase) before it reaches anything the user sees. AuthScreen.tsx
 * and RegistrationWizard.tsx have no render harness (this app's vitest
 * config runs in a `node` environment with no DOM/testing-library — see
 * recovery-key-gate.test.ts and the other `*Wiring.test.ts` files for the
 * same approach and the same reason), so a mount-and-assert-on-text test
 * isn't available; this is the next best thing.
 */

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');
const authScreen = read('AuthScreen.tsx');
const wizard = read('RegistrationWizard.tsx');

describe('trial_granted survives the hop from the finalize response to AuthScreen state', () => {
    it('reads trial_granted off the /auth/finalize response', () => {
        const at = authScreen.indexOf('axios.post(`${API_BASE}/auth/finalize`');
        expect(at, 'finalize call site missing — did the endpoint move?').toBeGreaterThan(-1);
        const nearby = authScreen.slice(at, at + 1500);
        expect(nearby, 'must destructure trial_granted from finRes.data').toContain('trial_granted');
    });

    it('stores it as a real boolean, not a truthy-string or the raw field name', () => {
        // A withheld trial must read as `false`, never merely "falsy" (an
        // empty string / undefined from an older API build must NOT be
        // reported to the wizard as "withheld" — see the next describe block).
        expect(authScreen).toMatch(/typeof trial_granted === 'boolean'/);
    });

    it('passes it into the wizard as trialGranted', () => {
        const at = authScreen.indexOf('<RegistrationWizard');
        expect(at, 'RegistrationWizard render site missing').toBeGreaterThan(-1);
        const jsx = authScreen.slice(at, authScreen.indexOf('/>', at));
        expect(jsx, 'must pass trialGranted').toMatch(/trialGranted=\{pendingRegPayload\?\.trialGranted\}/);
    });
});

describe('trialGranted reaches the feature-showcase step and only flips withheld on an explicit false', () => {
    it('RegistrationWizard destructures trialGranted from its props', () => {
        expect(wizard).toMatch(/username, onComplete, onEnter, trialGranted,/);
    });

    it('passes trialWithheld={trialGranted === false} to FeatureShowcase — not `!trialGranted`', () => {
        // `!trialGranted` would also fire for `undefined` (an older API build,
        // or any caller that simply never wires the prop), which is exactly
        // the "say nothing, don't invent a claim" case this must NOT treat as
        // withheld. Only a literal `false` — the server explicitly saying so —
        // may show the withheld copy.
        expect(wizard).toContain('trialWithheld={trialGranted === false}');
    });

    it('FeatureShowcase renders distinct, honest copy for the withheld case — not the normal trial CTA', () => {
        const sig = "const FeatureShowcase: React.FC<{ subscribed: boolean; trialWithheld: boolean; onStart: () => void }>";
        expect(wizard, 'FeatureShowcase signature missing trialWithheld').toContain(sig);
        const body = wizard.slice(wizard.indexOf(sig));
        const withheldBlock = body.slice(body.indexOf('if (trialWithheld)'), body.indexOf('if (trialWithheld)') + 2000);
        // Says what happened, non-accusatory.
        expect(withheldBlock).toMatch(/didn.t start this time/);
        // Never claims the normal, actually-started trial exists.
        expect(withheldBlock).not.toContain('Start your free 7-day trial');
        // Offers the real forward paths: a referral code overriding the block,
        // and subscribing directly — no invented retry/re-request button.
        expect(withheldBlock).toMatch(/referral code/i);
        expect(withheldBlock).toMatch(/subscribe/i);
        expect(withheldBlock, 'must not invent a client-side retry').not.toMatch(/try again|retry|request.*trial/i);
        // Still just advances the wizard — the decision was already made server-side.
        expect(withheldBlock).toContain('onClick={onStart}');
    });
});
