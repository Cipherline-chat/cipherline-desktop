/**
 * Wiring checks for the profile-media speed work — the parts that live in
 * files too large (Dashboard) or too app-shaped to render in a unit test.
 * Each one is a call that, if dropped, leaves every module's own tests green
 * while the feature silently stops working (the wiring-class failure mode).
 * `profileOpenLatency.test.ts` covers the card itself end to end.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');
const dashboard = read('Dashboard.tsx');
const warming = read('../hooks/useAvatarWarming.ts');
const profilePane = read('settings/panes/ProfilePane.tsx');
const onboardingHost = read('onboarding/OnboardingHost.tsx');

describe('profile media wiring', () => {
    it('Dashboard feeds friends\' avatar + banner ids to the identity cache', () => {
        const block = dashboard.slice(dashboard.indexOf('for (const f of globalFriends?.accepted ?? [])'));
        const body = block.slice(0, block.indexOf('}, [globalFriends]);'));
        expect(body).toContain('rememberUserBannerId(f.user_id, f.banner_url ?? null)');
        expect(body).toContain('rememberUserAvatarId(f.user_id, f.avatar_url ?? null)');
    });

    it('Dashboard hands the DM panel\'s profile response to the profile cache', () => {
        const block = dashboard.slice(dashboard.indexOf('// Fetch DM partner public profile'));
        expect(block.slice(0, block.indexOf('setDmPartnerProfile({'))).toContain('primeProfile(res.data)');
    });

    it('the warmer scopes the profile cache to the account and warms friends\' banners', () => {
        expect(warming).toContain('bindProfileCacheViewer(warmUserId)');
        expect(warming).toContain("preloadAvatarsBackground(banners, token, { kind: 'banner' })");
    });

    it('editing your own profile tells the cache (Settings and onboarding)', () => {
        expect(profilePane).toContain('noteProfileEdited(user?.user_id, patchBody');
        expect(onboardingHost).toContain('noteProfileEdited(userId, body');
    });
});
