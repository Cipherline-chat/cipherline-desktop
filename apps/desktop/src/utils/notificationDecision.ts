/**
 * notificationDecision — the ONE place that decides what an incoming message
 * does to the UI: does it count as a mention, does it bump the unread badge,
 * does it make a sound, does it raise an OS toast.
 *
 * Why this exists: those four answers used to be computed in three separate
 * places that disagreed with each other.
 *
 *   • Dashboard's DM path (pullMessages) decided "unread" from
 *     `!document.hasFocus() || activeChat.id !== convId` and decided "mention"
 *     from messageTextMentionsUser() alone.
 *   • Dashboard's channel path (handleChannelMessage) decided "mention" from
 *     messageTextMentionsUser + mentions_everyone + role pings.
 *   • useNotificationDispatch decided "sound/toast" from its own suppression
 *     rule AND counted a user-configured KEYWORD hit as a mention.
 *
 * The keyword rule existing on only one side is a confirmed way to get the
 * exact symptom "I hear the notification sound but nothing on screen changes":
 * in a conversation set to @mentions-only or muted, a message containing a
 * configured keyword passes notify()'s mention test (sound + toast fire) but
 * fails Dashboard's, so neither the unread counter nor the mention counter is
 * ever incremented. Same divergence, opposite direction, whenever the two
 * focus/active-conversation expressions drift apart.
 *
 * Pure functions over plain data — no DOM, no React, no prefs object — so the
 * rules are testable under vitest's node environment (see
 * notificationDecision.test.ts), the same approach used for utils/unreadBadges.ts
 * and utils/inviteLimits.ts.
 */

import { matchesKeyword } from './mentionKeywords';

export type NotifMode = 'all' | 'mentions' | 'none';

export interface NotifDecisionInput {
    /** Decrypted message body. Empty string for non-text content. */
    text: string;
    /**
     * A direct ping detected by the caller: @user for DMs; @user, @everyone or
     * an @role the user holds for server channels. Keyword matching is NOT the
     * caller's job — it happens here so every surface applies it identically.
     */
    directMention: boolean;
    /** The user's configured trigger keywords (NotificationPrefs.keywords). */
    keywords: string[];
    /** Effective per-conversation / per-channel notification mode. */
    mode: NotifMode;
    /** document.hasFocus() — read ONCE per batch by the caller, not per message. */
    windowFocused: boolean;
    /** True when this conversation/channel is the one currently on screen. */
    isActiveConversation: boolean;
    /** NotificationPrefs.suppress_when_active_conv. */
    suppressWhenActiveConv: boolean;
    /** Result of computeDnd(...).active. Pass false where DND doesn't apply. */
    dndActive: boolean;
    /** NotificationPrefs.dnd_let_mentions_through. */
    dndLetMentionsThrough: boolean;
}

export interface NotifDecision {
    /** Direct ping OR keyword hit. This is the value every surface must use. */
    isMention: boolean;
    /** Increment the per-conversation mention counter. */
    countsMention: boolean;
    /** Increment the per-conversation unread counter. */
    countsUnread: boolean;
    /** Play the notification sound. */
    playsSound: boolean;
    /**
     * Raise an OS toast. Identical to playsSound here — the caller still applies
     * `suppress_when_window_focused` on top, which is a toast-only preference.
     */
    showsToast: boolean;
}

/**
 * Resolve everything an incoming message should do, in one pass.
 *
 * The rules, stated once:
 *
 *   seen        = the user is demonstrably looking at this conversation right
 *                 now (window focused AND it's the open one). A blurred window
 *                 means they're elsewhere even if the conversation is "open".
 *   isMention   = direct ping OR keyword hit.
 *   countsMention  = !seen && isMention. Mentions count even in a muted
 *                    conversation — that's the whole point of muting to
 *                    "@mentions only" vs. going silent.
 *   countsUnread   = !seen && mode !== 'none'. An @mentions-only conversation
 *                    still accumulates unread — it is shown quietly rather
 *                    than not at all. Only Muted suppresses the count itself.
 *   playsSound     = the mode allows it, DND isn't swallowing it, and the user
 *                    hasn't asked for silence on the conversation they're
 *                    actively reading.
 *
 * Note the one intentional asymmetry: DND suppresses sound and toast but never
 * the badge. "Do not disturb" means don't interrupt me, not don't tell me it
 * happened — the count is still there when the user looks.
 */
export function resolveNotification(input: NotifDecisionInput): NotifDecision {
    const {
        text, directMention, keywords, mode,
        windowFocused, isActiveConversation, suppressWhenActiveConv,
        dndActive, dndLetMentionsThrough,
    } = input;

    const isMention = directMention || matchesKeyword(text ?? '', keywords ?? []) !== null;

    // "The user can already see this land." Computed once, shared by the badge
    // rules and the alert rules so they can never drift apart again.
    const seen = windowFocused && isActiveConversation;

    const modeAllows = mode === 'all' || isMention;

    const countsMention = !seen && isMention;
    // Tracked for every mode except a full mute. This used to be
    // `!seen && modeAllows && mode !== 'none'`, i.e. an @mentions-only
    // conversation counted NOTHING for an ordinary message — so a server you
    // had turned pings off for looked identical to one with nothing new in
    // it. "Don't ping me" and "don't tell me" are different requests; only
    // Muted asks for the second. What the badge then LOOKS like (a quiet grey
    // count rather than the alert red one) is a rendering decision, made in
    // unreadBadges.resolveBadge from this same mode.
    const countsUnread = !seen && mode !== 'none';

    const dndSwallows = dndActive && !(isMention && dndLetMentionsThrough);
    const alerts = modeAllows && !dndSwallows && !(suppressWhenActiveConv && seen);

    return {
        isMention,
        countsMention,
        countsUnread,
        playsSound: alerts,
        showsToast: alerts,
    };
}
