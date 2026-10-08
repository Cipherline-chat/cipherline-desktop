import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOnboardingMarker } from '../utils/onboardingProgress';

/**
 * Source-level wiring guards for the "your free trial was withheld" fix.
 *
 * `POST /auth/finalize` returns `trial_granted: false` when the P2-BILL-6
 * anti-farming quota denied a brand-new account's trial (see
 * apps/api/src/auth/auth.service.ts). Before that fix the fact reached
 * nowhere: the account was silently created as `subscription_status:
 * 'expired'` and onboarding presented a trial that did not exist.
 *
 * Since onboarding round 6 the value crosses these hops before anything the
 * user sees: AuthScreen (finalize response) -> the resume marker
 * (utils/onboardingProgress.ts) -> OnboardingHost (deps.trialGranted) -> the
 * ending's trial beat. These pin the PLUMBING (this app's vitest runs in a
 * `node` environment with no DOM, hence source-level checks — the same
 * approach as the other `*Wiring.test.ts` files). The ending's copy for the
 * withheld case is pinned in ending/endingTrial.test.ts.
 */

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');
const authScreen = read('AuthScreen.tsx');
const host = read('onboarding/OnboardingHost.tsx');

describe('trial_granted survives the hop from the finalize response into the onboarding marker', () => {
    it('reads trial_granted off the /auth/finalize response', () => {
        const at = authScreen.indexOf('axios.post(`${API_BASE}/auth/finalize`');
        expect(at, 'finalize call site missing — did the endpoint move?').toBeGreaterThan(-1);
        const nearby = authScreen.slice(at, at + 1500);
        expect(nearby, 'must destructure trial_granted from finRes.data').toContain('trial_granted');
    });

    it('stores it as a real boolean or undefined — never a truthy string or a guessed false', () => {
        // An older API build (no field) must degrade to "say nothing", not to
        // "withheld" — so only a literal boolean is carried.
        expect(authScreen).toMatch(/trialGranted: typeof trial_granted === 'boolean' \? trial_granted : undefined/);
        const at = authScreen.indexOf('startOnboarding(user_id, {');
        expect(at, 'startOnboarding call missing').toBeGreaterThan(-1);
    });

    it('the marker keeps an explicit false and drops anything that is not a boolean', () => {
        const base = { v: 1, step: 'storage', startedAt: 1 };
        expect(parseOnboardingMarker(JSON.stringify({ ...base, trialGranted: false }))?.trialGranted).toBe(false);
        expect(parseOnboardingMarker(JSON.stringify({ ...base, trialGranted: true }))?.trialGranted).toBe(true);
        expect(parseOnboardingMarker(JSON.stringify({ ...base, trialGranted: 'false' }))?.trialGranted).toBeUndefined();
        expect(parseOnboardingMarker(JSON.stringify(base))?.trialGranted).toBeUndefined();
    });

    it('OnboardingHost hands the marker value to the steps as deps.trialGranted', () => {
        expect(host).toMatch(/trialGranted: p\.marker\?\.trialGranted/);
    });
});
