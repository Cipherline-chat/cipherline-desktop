import React, { useMemo, useState } from 'react';
import { usePrivacySettings } from '../../../hooks/usePrivacySettings';
import { useScreenLock } from '../../../hooks/useScreenLock';
import { useGameSettings } from '../../../hooks/useGameSettings';
import { useRetentionPolicy } from '../../../hooks/useRetentionPolicy';
import { useToast } from '../../../contexts/ToastContext';
import { officialServerDefault } from '../../../utils/signupAttribution';
import type { DeviceRetentionChoice } from '../../../utils/deviceStorageSetup';
import type { OnboardingStepId } from '../../../utils/onboardingProgress';
import { OnboardingFlow } from '../OnboardingFlow';
import type { FriendRequestResult, OnboardingDeps, OnboardingUser } from '../types';

/**
 * DEV ONLY — mounted by App.tsx when `import.meta.env.DEV` and the URL has
 * `?ob-harness=<step>` (dead-code-eliminated from production builds, like the
 * cl-kit gallery). Renders the real OnboardingFlow with the REAL settings
 * hooks (privacy, screen lock, games, retention) but stubbed network calls,
 * so each step can be built and screenshotted without an account or the dev
 * stack. Run the renderer with VITE_API_HOST pointing somewhere unreachable.
 *
 *   ?ob-harness=storage|privacy|profile|invite|ending
 *   &ref=1      arrived with a referral (referrer sam#1042, +7 days)
 *   &invite=1   a server invite is carried (code "night-owls")
 *   &trial=0    the server withheld the trial
 *   &rm=1       reduced motion
 *   &name=x     pretend the profile step already saved the name `x`
 *   (profile step) typing the name `popular` gets the API's 409, `offline` a network error
 *   &bonus=0    (with &ref=1) the referral applied but gave no bonus days
 *   &fr=fail|already  what the stubbed POST /friends/request answers
 *   &sent=x     pretend a friend request was already sent to tag `x` (the ending's toast)
 *   &official=1 pretend "also join the official server" was switched on
 *
 * Simulate "a friend signed up with your link" from devtools / Playwright:
 *   window.dispatchEvent(new CustomEvent('ob-harness:friend', { detail: { username: 'kit', discriminator: 5512 } }))
 * Every stubbed call is logged to the console as `[ob-harness] …`.
 */
const HARNESS_USER_ID = 'ob-harness-user';
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const log = (...a: unknown[]) => console.info('[ob-harness]', ...a);

export const OnboardingHarness: React.FC = () => {
    const q = useMemo(() => new URLSearchParams(window.location.search), []);
    const step = (q.get('ob-harness') || 'storage') as OnboardingStepId;
    const withRef = q.get('ref') === '1';
    const withInvite = q.get('invite') === '1';
    const trialGranted = q.get('trial') !== '0';
    const presetName = q.get('name');
    const bonusDays = q.get('bonus') === '0' ? 0 : 7;
    const friendResult: FriendRequestResult = q.get('fr') === 'fail' ? 'failed' : q.get('fr') === 'already' ? 'already' : 'sent';

    const privacy = usePrivacySettings();
    const screenLock = useScreenLock();
    const gameSettings = useGameSettings(HARNESS_USER_ID);
    const retention = useRetentionPolicy(HARNESS_USER_ID);
    const toast = useToast();
    const [storageStatus, setStorageStatus] = useState<'prompt' | 'done'>('prompt');
    const [user, setUser] = useState<OnboardingUser>({
        user_id: HARNESS_USER_ID,
        username: presetName || 'user_3f9a0c1b2e',
        discriminator: presetName ? 4821 : 1337,
        avatar_url: null,
        banner_url: null,
        bio: null,
        username_pending: !presetName,
    });
    const [done, setDone] = useState(false);

    const deps: OnboardingDeps = {
        userId: HARNESS_USER_ID,
        token: 'harness-token',
        user,
        refreshProfile: async () => { log('refreshProfile'); },
        privacy,
        screenLock,
        gameSettings,
        retention,
        deviceStorage: {
            status: storageStatus,
            complete: (choice: DeviceRetentionChoice, how) => { log('deviceStorage.complete', how, choice); setStorageStatus('done'); },
        },
        patchProfile: async (body) => {
            log('PATCH /auth/profile', body);
            await sleep(400);
            // The profile step's error paths: the name "popular" gets the API's
            // 409 (the #tag space for that name is full), "offline" a network error.
            if (body.username === 'popular') {
                throw Object.assign(new Error('409'), { response: { status: 409, data: { message: 'This username is very popular — pick another.' } } });
            }
            if (body.username === 'offline') throw new Error('Network Error');
            const next: OnboardingUser = {
                ...user,
                ...(typeof body.username === 'string' ? { username: body.username, discriminator: 4821, username_pending: false } : {}),
                ...(typeof body.bio === 'string' ? { bio: body.bio } : {}),
                ...(typeof body.avatar_url === 'string' || body.avatar_url === null ? { avatar_url: body.avatar_url as string | null } : {}),
                ...(typeof body.banner_url === 'string' || body.banner_url === null ? { banner_url: body.banner_url as string | null } : {}),
            };
            setUser(next);
            return next;
        },
        uploadAvatar: async (blob) => { log('uploadAvatar', blob.size); await sleep(300); return 'harness-avatar'; },
        uploadBanner: async (blob) => { log('uploadBanner', blob.size); await sleep(300); return 'harness-banner'; },
        sendFriendRequest: async (u, d) => { log('POST /friends/request', u, d); await sleep(600); return friendResult; },
        fetchMyReferral: async () => ({ code: '7C41E9A2', url: 'https://cipherline.chat/ref/7C41E9A2', count: 0, recent: [] }),
        fetchOfficialServer: async () => officialServerDefault(),
        joinServer: async (code) => { log('POST /invites/accept', code); await sleep(300); },
        pushToast: toast.push,
        writeClipboard: async (text) => { log('clipboard', text); try { await navigator.clipboard.writeText(text); } catch { /* headless */ } },
        onReferralRedeemed: (fn) => {
            const h = (e: Event) => fn((e as CustomEvent<{ username: string; discriminator: number | null }>).detail);
            window.addEventListener('ob-harness:friend', h);
            return () => window.removeEventListener('ob-harness:friend', h);
        },
        referrer: withRef ? { username: 'sam', discriminator: 1042 } : null,
        referralCode: withRef ? '3F8A21C7' : undefined,
        clearReferrer: () => log('clearReferrer'),
        pendingInviteCode: withInvite ? 'night-owls' : null,
        trialGranted,
        referralApplied: withRef,
        bonusDays: withRef ? bonusDays : 0,
        subscription: { status: trialGranted || withRef ? 'trial' : 'expired', trialEndsAt: null },
    };

    if (done) {
        return (
            <div style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: 'var(--cl-abyss)', color: 'var(--cl-muted)' }} data-ob-harness-done>
                Onboarding finished (harness). Reload to run it again.
            </div>
        );
    }
    return (
        <OnboardingFlow
            deps={deps}
            initialStep={step}
            onDone={() => { log('onDone'); setDone(true); }}
            forceReducedMotion={q.get('rm') === '1'}
            persist={false}
            initialFlow={{
                ...(q.get('sent') ? { friendRequestSentTo: q.get('sent') } : {}),
                ...(q.get('official') === '1' ? { joinOfficial: true } : {}),
            }}
        />
    );
};

export default OnboardingHarness;
