/**
 * dmReactionAlert — the ONE place that decides whether an inbound reaction
 * alerts (unread +1 and an OS toast). Owner decision 2026-11: reactions alert
 * ONLY in one-to-one DMs. The same rule, input for input, is implemented in the
 * native mobile core; keep the two in step.
 *
 * Pure: no DOM, no React, no prefs object. Notification settings (DND, sound,
 * hidden preview, mentions-only) are NOT decided here — a reaction that passes
 * this function is then run through notificationDecision.resolveNotification
 * exactly like a message, so every existing rule keeps applying in one place.
 */

import { toPlainText } from './messagePreviewText';

export type DmReactionConversationKind = 'dm' | 'group' | 'channel' | 'thread';

export interface DmReactionAlertInput {
    /** The reaction's action. Only an ADD can alert. */
    op: 'add' | 'remove';
    /** Only a one-to-one DM alerts (the caller maps its own self-DM to 'group': never alerts). */
    conversationKind: DmReactionConversationKind;
    /** The reactor is this account (this device or another of my devices). */
    reactorIsMe: boolean;
    /** The DM is muted (mode 'none'). */
    muted: boolean;
    /** This DM is the open conversation AND the window is focused (the user can see it land). */
    dmOpenAndFocused: boolean;
    /** The reaction's server time, epoch ms; NaN/undefined when unknown. */
    eventMs: number | undefined;
    /** The conversation's last-read point, epoch ms; undefined = never read / unknown. */
    lastReadMs: number | undefined;
    /** This (reactor, message, emoji) has already alerted, or is already applied. */
    alreadyAlerted: boolean;
}

export interface DmReactionAlertDecision {
    /** The DM becomes unread: +1, exactly as one new message. */
    affectsUnread: boolean;
    /** Raise one notification (still subject to the usual notification rules). */
    notify: boolean;
}

const NONE: DmReactionAlertDecision = { affectsUnread: false, notify: false };

export function decideDmReactionAlert(i: DmReactionAlertInput): DmReactionAlertDecision {
    if (i.op !== 'add') return NONE;
    if (i.conversationKind !== 'dm') return NONE;
    if (i.reactorIsMe) return NONE;
    if (i.alreadyAlerted) return NONE;
    // Live arrivals newer than the last-read point only. An unknown event time
    // fails closed: a replayed/backfilled reaction must never buzz.
    if (typeof i.eventMs !== 'number' || !Number.isFinite(i.eventMs)) return NONE;
    if (i.lastReadMs !== undefined && Number.isFinite(i.lastReadMs) && i.eventMs <= i.lastReadMs) return NONE;
    // The user is looking right at it: no unread either.
    if (i.dmOpenAndFocused) return NONE;
    if (i.muted) return NONE;
    return { affectsUnread: true, notify: true };
}

/** Dedup key for the already-alerted set. Lives in memory only; never logged or sent. */
export function reactionAlertKey(conversationId: string, targetId: string, emoji: string, reactorUserId: string): string {
    return `${conversationId}\u0000${targetId}\u0000${emoji}\u0000${reactorUserId}`;
}

/** Bounded insert: the oldest keys go first once `max` is exceeded. */
export function rememberAlerted(set: Set<string>, key: string, max = 2000): void {
    set.add(key);
    while (set.size > max) {
        const oldest = set.values().next().value;
        if (oldest === undefined) break;
        set.delete(oldest);
    }
}

const TARGET_PREVIEW_MAX = 100;

/**
 * Words for the reacted-to message, matching the message toast's own
 * placeholders. '' when the target is not known on this device.
 */
export function reactionTargetPreview(content: { type?: string; text?: string } | null | undefined): string {
    if (!content?.type) return '';
    let raw: string;
    switch (content.type) {
        case 'text': raw = toPlainText(content.text ?? ''); break;
        case 'attachment': raw = '📎 Attachment'; break;
        case 'klipy_gif': raw = 'GIF'; break;
        case 'safety_number': raw = '🔐 Shared their safety code'; break;
        case 'pro_gift': raw = '🎁 Sent you a gift'; break;
        default: raw = 'message';
    }
    raw = raw.replace(/\s+/g, ' ').trim();
    return raw.length > TARGET_PREVIEW_MAX ? `${raw.slice(0, TARGET_PREVIEW_MAX - 1)}…` : raw;
}

/** Notification body. `hidden` = the user's hidden-preview setting. */
export function reactionToastBody(emoji: string, targetPreview: string, hidden: boolean): string {
    if (hidden) return 'Reacted to a message';
    const shown = toPlainText(emoji) || emoji; // custom emoji token -> :name:
    return targetPreview
        ? `Reacted ${shown} to: “${targetPreview}”`
        : `Reacted ${shown} to a message`;
}
