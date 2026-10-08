/**
 * useNotificationDispatch — the single entry point for FIRING notifications
 * (sound + OS toast). What a message *means* — mention or not, unread or not,
 * alert or not — is decided by utils/notificationDecision.ts, which Dashboard's
 * badge counters use as well. Splitting "decide" from "do" is deliberate: the
 * two used to be decided separately here and in Dashboard with subtly different
 * rules, which is how you end up hearing a ding with nothing on screen to show
 * for it. See notificationDecision.ts for the full history.
 *
 * This hook still owns:
 *   1. The master switch (both sound and toast off → nothing to do).
 *   2. Playing the sound, when the decision says to.
 *   3. Raising the OS toast, when the decision says to AND
 *      `suppress_when_window_focused` doesn't veto it (a toast-only preference,
 *      so it lives here rather than in the shared decision).
 *
 * Callers that also maintain badge counts MUST pass the same `decision` object
 * they counted from; callers that don't (the incoming-call path) can omit it
 * and let this hook derive one with the identical function.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNotificationPrefs } from '../contexts/NotificationContext';
import { computeDnd } from './useDndState';
import { playSound } from '../utils/notificationSounds';
import { resolveNotification, type NotifDecision } from '../utils/notificationDecision';
import { mentionsToDisplayText } from '../utils/mentionTokens';
import {
    selectNotificationAvatarId, getNotificationIconDataUrl, createToastSequencer,
    rasterizeCircleIcon, type NotifIconDeps,
} from '../utils/notificationAvatar';
import { lookupUserAvatarId } from '../utils/peerIdentityCache';
import { peekAvatarUrl, warmAvatarsFromDiskCache } from './useEncryptedAvatar';
import type { FriendshipCheckFn } from '../contexts/FriendshipContext';

/** Cache-only avatar sources for toast icons — never the network. */
const NOTIF_ICON_DEPS: NotifIconDeps = {
    peek: peekAvatarUrl,
    warmFromDisk: (id) => warmAvatarsFromDiskCache([id]),
    rasterize: rasterizeCircleIcon,
};

export type NotifCategory = 'message' | 'mention' | 'call' | 'join' | 'leave';
export type { NotifDecision };
export type NotifMode = 'all' | 'mentions' | 'none';

export interface NotifyPayload {
    /** 'message' for normal messages, 'mention' for @mention, 'call' for incoming call. */
    category: NotifCategory;
    /** Conversation or channel ID (used for click-to-focus and suppression check). */
    conv_id: string;
    /** Sender display name. */
    sender_name: string;
    /**
     * The user who sent the message / placed the call. Used ONLY to pick the
     * toast's avatar icon (utils/notificationAvatar.ts) — subject to the
     * preview setting, `show_sender_avatar` and the friend-or-self gate.
     */
    sender_user_id?: string | null;
    /** Avatar attachment id the caller already holds; else looked up from peerIdentityCache. */
    sender_avatar_id?: string | null;
    /** Decrypted message text (may be empty for non-text messages). */
    text?: string;
    /** Whether this message already contains a direct @mention of the user. */
    is_mention?: boolean;
    /** Per-conversation / per-channel NotifMode. Defaults to 'all'. */
    mode?: NotifMode;
    /** ID of the active conversation the user is currently viewing. */
    active_conv_id?: string | null;
    /** State flags for DND auto-triggers. */
    ctx?: {
        userStatus: string;
        activeCall: boolean;
        screensharing: boolean;
        gameActive: boolean;
    };
    /**
     * The decision this notification was already counted against, from
     * resolveNotification(). Pass it whenever the caller also bumped unread /
     * mention counters — that's what makes "made a noise" and "showed a badge"
     * structurally inseparable. Omit it and an equivalent one is derived here
     * from the same function (used by the incoming-call path, which has no
     * badge of its own).
     */
    decision?: NotifDecision;
}

export interface NotificationDispatchOptions {
    /**
     * Returns the CURRENT friend-or-self gate (the one EncryptedAvatar uses).
     * A getter, because Dashboard defines its gate after calling this hook.
     * Absent or returning null → toasts never carry an avatar (fail closed).
     */
    getAvatarGate?: () => FriendshipCheckFn | null | undefined;
}

export function useNotificationDispatch(options?: NotificationDispatchOptions) {
    const { prefs } = useNotificationPrefs();
    const optionsRef = useRef(options);
    useEffect(() => { optionsRef.current = options; });
    // One sequencer per dispatcher: an avatar toast that resolves late must not
    // replace a newer toast for the same conversation.
    const [takeToastTicket] = useState(createToastSequencer);
    // Keep ref so the callback doesn't need prefs in its dep array (avoids
    // re-creating on every prefs change, which would make Dashboard sad).
    const prefsRef = useRef(prefs);
    prefsRef.current = prefs;

    const notify = useCallback((payload: NotifyPayload) => {
        const p = prefsRef.current;

        // 1. Master switch — bail only if BOTH sound and toast are off.
        if (!p.desktop_notifications_enabled && !p.sounds_enabled) return;

        const text = payload.text ?? '';
        // What the toast SHOWS. `text` stays raw below because
        // resolveNotification's keyword matching runs against the message as
        // sent; only the human-readable body is de-tokenised. Without this the
        // OS toast printed the wire token verbatim —
        // "<@u:d43f9e1a-...:Shinobi> test" — for every message containing a
        // mention of any kind (user, role, @everyone, custom emoji).
        const displayText = mentionsToDisplayText(text);
        const windowFocused = typeof document !== 'undefined' && document.hasFocus();

        // 2. What does this message mean? Either the caller already resolved it
        //    (and counted its badges from the same object), or we resolve an
        //    equivalent one here. Same function either way — that identity is
        //    the fix, not an optimisation.
        const decision = payload.decision ?? resolveNotification({
            text,
            // A call is always mention-level: it must pierce muted conversations
            // and DND the same way an @ping does.
            directMention: !!payload.is_mention || payload.category === 'call',
            keywords: p.keywords,
            mode: payload.mode ?? 'all',
            windowFocused,
            isActiveConversation: payload.active_conv_id === payload.conv_id,
            suppressWhenActiveConv: p.suppress_when_active_conv,
            dndActive: computeDnd(p, payload.ctx ?? {
                userStatus: 'online', activeCall: false, screensharing: false, gameActive: false,
            }).active,
            dndLetMentionsThrough: p.dnd_let_mentions_through,
        });

        // 3. Sound — plays even when the window is focused, as long as it isn't
        //    the conversation you're actively viewing (folded into the decision).
        //    Calls are skipped here: the incoming-call UI plays its own looping
        //    ringtone, so a one-shot here would double up.
        if (decision.playsSound && p.sounds_enabled && payload.category !== 'call') {
            const soundCat = decision.isMention ? 'mention' : payload.category;
            // `p` is the whole NotificationPrefs, which is a superset of
            // SoundsPrefs — pass it straight through rather than picking
            // fields, so a prefs field playSound learns to read later (as it
            // did with `sound_groups`) can't be silently dropped here.
            playSound(soundCat, p);
        }

        // 4. OS toast — additionally suppressed when the window is focused
        //    (you're already in the app, an OS toast would be noise).
        const toastSuppressedByFocus = p.suppress_when_window_focused && windowFocused;
        if (decision.showsToast && p.desktop_notifications_enabled && !toastSuppressedByFocus) {
            let title: string;
            let body: string;
            switch (p.show_preview) {
                case 'full':
                    title = payload.sender_name;
                    body  = displayText.slice(0, 200) || (payload.category === 'call' ? 'Incoming call' : 'New message');
                    break;
                case 'sender_only':
                    title = 'Cipherline';
                    body  = payload.sender_name;
                    break;
                default: // 'hidden'
                    title = 'Cipherline';
                    body  = 'New message';
                    break;
            }
            const id = `notif_${payload.conv_id}`;  // stable per-conv → replaces previous toast
            const isCurrent = takeToastTicket(id);
            const show = (iconDataUrl: string | null) => {
                if (!isCurrent()) return;  // a newer toast for this conversation already went out
                window.electronAPI?.notifShow?.({
                    id,
                    title,
                    body,
                    conv_id: payload.conv_id,
                    hasReply: p.quick_reply_enabled && p.show_preview !== 'hidden' && payload.category !== 'call',
                    replyPlaceholder: 'Reply…',
                    ...(iconDataUrl ? { iconDataUrl } : {}),
                });
            };
            // Sender avatar: follows the same preview setting as the sender's
            // name, the user's own toggle, and the on-screen friend gate. From
            // caches only, with a short bounded wait — never a request.
            const avatarId = selectNotificationAvatarId({
                showPreview: p.show_preview,
                showSenderAvatar: p.show_sender_avatar,
                senderUserId: payload.sender_user_id,
                avatarIdHint: payload.sender_avatar_id,
                lookupAvatarId: lookupUserAvatarId,
                isFriendOrSelf: optionsRef.current?.getAvatarGate?.(),
            });
            if (avatarId) {
                void getNotificationIconDataUrl(avatarId, NOTIF_ICON_DEPS)
                    .catch(() => null)
                    .then(show);
            } else {
                show(null);
            }
            if (p.flash_taskbar) window.electronAPI?.notifFlashTaskbar?.();
        }
    }, [takeToastTicket]); // stable — reads live prefs/options via refs

    return notify;
}
