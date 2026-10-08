/**
 * The contract between the onboarding shell (OnboardingFlow), its steps and
 * whoever hosts it (OnboardingHost inside the Dashboard; dev/OnboardingHarness
 * in development).
 *
 * The onboarding runs AFTER sign-in, over the mounted Dashboard, so every
 * choice is saved through the app's REAL settings code: the very hook
 * instances the Dashboard (and Settings) use are passed in here. Network
 * side effects are functions on `deps` so the dev harness can stub them.
 */
import type { PrivacySettingsHook } from '../../hooks/usePrivacySettings';
import type { ScreenLockHook } from '../../hooks/useScreenLock';
import type { GameSettingsHook } from '../../hooks/useGameSettings';
import type { RetentionHook } from '../../hooks/useRetentionPolicy';
import type { DeviceStorageStatus } from '../../hooks/useDeviceStorageSetup';
import type { DeviceRetentionChoice, SetupHow } from '../../utils/deviceStorageSetup';
import type { MyReferral, ReferrerTag } from '../../utils/signupAttribution';
import type { OfficialServerConfig } from '@cipherline/shared';
import type { ToastInput } from '../../contexts/ToastContext';
import type { DotField } from './dots';

/** The signed-in account's own profile, as /auth/me returns it. */
export interface OnboardingUser {
    user_id: string;
    username: string;
    discriminator: number | null;
    avatar_url: string | null;
    banner_url: string | null;
    bio: string | null;
    /** /auth/me: the account still has its temporary `user_<hex>` name (the
     *  profile step has not saved one). Absent on an API that predates it. */
    username_pending?: boolean;
}

export type FriendRequestResult = 'sent' | 'already' | 'failed';

export interface OnboardingDeps {
    userId: string;
    token: string;
    /** Live own profile (AuthContext.user). Null until /auth/me answers. */
    user: OnboardingUser | null;
    refreshProfile: () => Promise<void>;

    // ── The real settings hooks (same instances Settings uses) ──────────────
    privacy: PrivacySettingsHook;
    screenLock: ScreenLockHook;
    gameSettings: GameSettingsHook;
    retention: RetentionHook;
    /** useDeviceStorageSetup: `complete(choice, 'signup')` = saveDeviceStorageChoice + marker. */
    deviceStorage: { status: DeviceStorageStatus; complete: (choice: DeviceRetentionChoice, how: SetupHow) => void };

    // ── Network side effects (stubbed by the harness) ───────────────────────
    /** PATCH /auth/profile, then refreshProfile(). Resolves to the server's
     *  answer (the updated own profile, including the re-allocated #tag). */
    patchProfile: (body: Record<string, unknown>) => Promise<OnboardingUser>;
    /** Encrypt + upload a cropped avatar (utils/avatarUpload). Returns the attachment id for `avatar_url`. */
    uploadAvatar: (blob: Blob) => Promise<string>;
    /** Encrypt + upload a cropped banner (same path as Settings → Profile). Returns the id for `banner_url`. */
    uploadBanner: (blob: Blob) => Promise<string>;
    /** POST /friends/request by tag. 409 (already friends / already sent) = 'already'. */
    sendFriendRequest: (username: string, discriminator: number) => Promise<FriendRequestResult>;
    /** GET /billing/referral (null when unavailable). */
    fetchMyReferral: () => Promise<MyReferral | null>;
    /** GET /config official_server (falls back to the shared constant, never throws). */
    fetchOfficialServer: () => Promise<OfficialServerConfig>;
    /** POST /invites/:code/accept + reload servers + request channel keys. */
    joinServer: (code: string) => Promise<void>;
    pushToast: (t: ToastInput) => void;
    writeClipboard: (text: string) => Promise<void>;
    /** Subscribe to `referral:redeemed` (utils/referralEvents). Returns unsubscribe. */
    onReferralRedeemed: (fn: (ev: { username: string; discriminator: number | null }) => void) => () => void;

    // ── How this person arrived ─────────────────────────────────────────────
    /** Who referred this account (peekReferrer), when the referral applied. */
    referrer: ReferrerTag | null;
    /** The referral code that applied (the code AuthScreen sent with the
     *  signup), spelled in dots on the referral step. Optional: without it
     *  the step spells the referrer's name. */
    referralCode?: string;
    /** The friend-request offer was answered (clearReferrer) — one-shot. */
    clearReferrer: () => void;
    /** A remembered server invite (getPendingInvite) — the join PROMPT opens after the ending. */
    pendingInviteCode: string | null;

    // ── From /auth/finalize (undefined when resumed without the marker) ─────
    trialGranted?: boolean;
    referralApplied?: boolean;
    bonusDays?: number;
    /** Live subscription, for a resume that lost the finalize facts. */
    subscription: { status: string | null; trialEndsAt: string | null } | null;
}

/** State that crosses steps (lives in the shell). */
export interface OnboardingFlowState {
    /** Local preview URLs of what the profile step picked (blob: URLs, owned by the profile step). */
    avatarPreview: string | null;
    bannerPreview: string | null;
    /** What the profile step SAVED (server truth): name + the #tag the server allocated. */
    username: string | null;
    discriminator: number | null;
    bio: string;
    /** The one-click friend request to the referrer (or to a friend who joined with your link). */
    friendRequestSentTo: string | null;
    /** "Also join the official Cipherline server" (joined when the ending starts). */
    joinOfficial: boolean;
}

export const INITIAL_FLOW_STATE: OnboardingFlowState = {
    avatarPreview: null,
    bannerPreview: null,
    username: null,
    discriminator: null,
    bio: '',
    friendRequestSentTo: null,
    joinOfficial: false,
};

/** Props every step component receives. */
export interface StepProps {
    deps: OnboardingDeps;
    flow: OnboardingFlowState;
    setFlow: (patch: Partial<OnboardingFlowState>) => void;
    reducedMotion: boolean;
    /** The shared full-window WebGL dot field (null when WebGL is unavailable,
     *  or before it is created). Only privacy + invite + the ending use it;
     *  the shell fades the canvas in/out via `showDots`. */
    dots: DotField | null;
    showDots: (on: boolean) => void;
    /** Go to the next step. Call it AFTER this step has committed its choices. */
    onNext: () => void;
    /** Go back (absent on the first step). */
    onBack?: () => void;
    /** 1 when arriving forward, -1 when arriving via Back. */
    direction: 1 | -1;
}

/** Props of the ending (statements → trial → build-out into the real Home). */
export interface EndingProps {
    deps: OnboardingDeps;
    flow: OnboardingFlowState;
    reducedMotion: boolean;
    dots: DotField | null;
    showDots: (on: boolean) => void;
    /** The Home view has been revealed (or skipped to): remove the overlay. */
    onDone: () => void;
}
