import React, { useCallback, useMemo, useState } from 'react';
import axios from 'axios';
import { API_BASE } from '../../constants';
import { useAttachments } from '../../hooks/useAttachments';
import { useAvatarBroadcast } from '../../hooks/useAvatarBroadcast';
import { useSubscription } from '../../contexts/SubscriptionContext';
import { uploadAvatarBlob } from '../../utils/avatarUpload';
import { noteProfileEdited } from '../../utils/profileCache';
import { saveAvatarKey } from '../../utils/avatarKeyStore';
import { referralRedeemedBus } from '../../utils/referralEvents';
import {
    clearReferrer, fetchMyReferral, fetchOfficialServer, getPendingInvite, peekReferrer,
} from '../../utils/signupAttribution';
import type { OnboardingMarker, OnboardingStepId } from '../../utils/onboardingProgress';
import type { ToastInput } from '../../contexts/ToastContext';
import { OnboardingFlow } from './OnboardingFlow';
import type { FriendRequestResult, OnboardingDeps, OnboardingUser } from './types';

export interface OnboardingHostProps {
    userId: string;
    token: string;
    user: OnboardingUser | null;
    refreshProfile: () => Promise<void>;
    privacy: OnboardingDeps['privacy'];
    screenLock: OnboardingDeps['screenLock'];
    gameSettings: OnboardingDeps['gameSettings'];
    retention: OnboardingDeps['retention'];
    deviceStorage: OnboardingDeps['deviceStorage'];
    /** useServers().joinServer */
    joinServerByCode: (code: string) => Promise<{ server_id: string } | null>;
    /** Dashboard's requestMissingChannelKeys, run after a join like the invite prompt does. */
    requestMissingChannelKeys: (serverId: string) => Promise<void> | void;
    pushToast: (t: ToastInput) => void;
    marker: OnboardingMarker | null;
    initialStep: OnboardingStepId;
    onDone: () => void;
}

/**
 * Builds the REAL deps (the Dashboard's own settings-hook instances + the
 * app's real network paths) and renders the setup over the Dashboard.
 */
export const OnboardingHost: React.FC<OnboardingHostProps> = (p) => {
    const { userId, token } = p;
    const { uploadEncryptedFile } = useAttachments(token);
    const { broadcastProfileAvatarKey } = useAvatarBroadcast(token, userId);
    const subscription = useSubscription();

    // Read once per mount: who referred us, and a carried server invite.
    const [referrer] = useState(() => {
        const tag = peekReferrer(userId);
        return tag && tag.discriminator !== null ? tag : null;
    });
    const [pendingInviteCode] = useState(() => getPendingInvite());

    const authHeaders = useMemo(() => ({ headers: { Authorization: `Bearer ${token}` } }), [token]);
    const { refreshProfile, joinServerByCode, requestMissingChannelKeys } = p;

    const patchProfile = useCallback(async (body: Record<string, unknown>): Promise<OnboardingUser> => {
        const res = await axios.patch(`${API_BASE}/auth/profile`, body, authHeaders);
        noteProfileEdited(userId, body as { avatar_url?: string | null; banner_url?: string | null });
        await refreshProfile();
        return res.data as OnboardingUser;
    }, [authHeaders, refreshProfile, userId]);

    const uploadAvatar = useCallback(
        (blob: Blob) => uploadAvatarBlob(blob, { uploadEncryptedFile, broadcastProfileAvatarKey }),
        [uploadEncryptedFile, broadcastProfileAvatarKey],
    );

    // Same path as Settings → Profile (ProfilePane.handleSaveProfile).
    const uploadBanner = useCallback(async (blob: Blob) => {
        const { attachmentId, keyB64, nonceB64 } = await uploadEncryptedFile(blob, 'banner.jpg', 'image/jpeg');
        await saveAvatarKey(attachmentId, keyB64, nonceB64);
        await broadcastProfileAvatarKey(attachmentId, keyB64, nonceB64);
        return attachmentId;
    }, [uploadEncryptedFile, broadcastProfileAvatarKey]);

    const sendFriendRequest = useCallback(async (username: string, discriminator: number): Promise<FriendRequestResult> => {
        try {
            await axios.post(`${API_BASE}/friends/request`, { target_username: username, target_discriminator: discriminator }, authHeaders);
            return 'sent';
        } catch (err) {
            // "Already friends" / "already sent" are fine outcomes; everything
            // else (including the neutral not-found) is just "couldn't".
            return axios.isAxiosError(err) && err.response?.status === 409 ? 'already' : 'failed';
        }
    }, [authHeaders]);

    const joinServer = useCallback(async (code: string) => {
        const res = await joinServerByCode(code);
        const serverId = res?.server_id;
        if (serverId) {
            // Pull channel keys distributed by existing members, and file key
            // requests for anything still missing — same as the invite prompt.
            void requestMissingChannelKeys(serverId);
            window.setTimeout(() => void requestMissingChannelKeys(serverId), 3000);
        }
    }, [joinServerByCode, requestMissingChannelKeys]);

    const writeClipboard = useCallback(async (text: string) => {
        const api = window.electronAPI;
        if (api?.writeClipboard) await api.writeClipboard(text);
        else await navigator.clipboard.writeText(text);
    }, []);

    const deps: OnboardingDeps = useMemo(() => ({
        userId,
        token,
        user: p.user,
        refreshProfile,
        privacy: p.privacy,
        screenLock: p.screenLock,
        gameSettings: p.gameSettings,
        retention: p.retention,
        deviceStorage: p.deviceStorage,
        patchProfile,
        uploadAvatar,
        uploadBanner,
        sendFriendRequest,
        fetchMyReferral: () => fetchMyReferral(token),
        fetchOfficialServer,
        joinServer,
        pushToast: p.pushToast,
        writeClipboard,
        onReferralRedeemed: (fn) => referralRedeemedBus.subscribe(ev => fn({ username: ev.username, discriminator: ev.discriminator })),
        referrer,
        clearReferrer: () => clearReferrer(userId),
        pendingInviteCode,
        trialGranted: p.marker?.trialGranted,
        referralApplied: p.marker?.referralApplied,
        bonusDays: p.marker?.bonusDays,
        referralCode: p.marker?.referralCode,
        subscription: subscription.status
            ? { status: subscription.status.subscription_status ?? null, trialEndsAt: subscription.status.trial_ends_at ?? null }
            : null,
    }), [userId, token, p.user, refreshProfile, p.privacy, p.screenLock, p.gameSettings, p.retention, p.deviceStorage,
        patchProfile, uploadAvatar, uploadBanner, sendFriendRequest, joinServer, p.pushToast, writeClipboard,
        referrer, pendingInviteCode, p.marker, subscription.status]);

    return <OnboardingFlow deps={deps} initialStep={p.initialStep} onDone={p.onDone} />;
};
