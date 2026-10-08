/**
 * saveCoachMark — the one-time "you can save a message" moment.
 *
 * Owner (2026-10-04): "I think we demonstrate the saving-a-message part when
 * they get their first DM." So onboarding does NOT explain it; the first time
 * a message actually arrives from someone else, in a DM whose messages
 * auto-delete, a small coach mark appears next to THAT message, says when
 * messages in this chat go away, and offers to save this one.
 *
 * Pure rules only (what qualifies, what to point at, the words). The component
 * is components/SaveCoachMark.tsx; the "already taught" flag lives in the
 * per-account nudge state (`coachSaveDone`) so it is one time per account and
 * can be switched off with the rest of the tips.
 */
import { DAY_MS, parseCreatedAt } from './firstWeekNudges';
import { MESSAGE_RETENTION_LABELS, type MessageRetention } from '../hooks/useRetentionPolicy';
import { isTextLikeMessageType } from './messageMenuGating';

/**
 * How long after account creation the coach mark may still appear. Longer than
 * the nudge week on purpose: a new account whose first DM arrives on day 9 has
 * still never been shown how saving works. An old account that merely updates
 * the app is long past this and is never interrupted. An unknown creation time
 * shows nothing.
 */
export const COACH_WINDOW_DAYS = 30;

export function isWithinCoachWindow(createdAt: string | number | null | undefined, now: number): boolean {
    const ms = parseCreatedAt(createdAt);
    if (ms == null) return false;
    const age = now - ms;
    return age >= -5 * 60_000 && age < COACH_WINDOW_DAYS * DAY_MS;
}

export interface CoachMessage {
    id?: string | null;
    sender_user_id?: string | null;
    content?: { type?: string | null } | null;
}

export interface CoachChatInput {
    /** Direct message with one other person (not a group, channel, or yourself). */
    isOneToOneDm: boolean;
    /** The retention that actually applies to this chat. 'never' = keep forever. */
    retention: MessageRetention;
    messages: readonly CoachMessage[];
    myUserId: string | null | undefined;
    /** Already saved (or already kept by policy) — nothing to teach. */
    isSaved: (messageId: string) => boolean;
}

/**
 * The message to point at: the NEWEST message from the other person that is
 * text-like (text / invite / GIF — the kinds the Save button applies to) and
 * not already saved, in a chat whose messages auto-delete. null when none
 * qualifies — including every chat set to keep forever, where there is nothing
 * to explain.
 */
export function pickSaveCoachTarget(i: CoachChatInput): string | null {
    if (!i.isOneToOneDm) return null;
    if (i.retention === 'never') return null;
    if (!i.myUserId) return null;
    for (let k = i.messages.length - 1; k >= 0; k--) {
        const m = i.messages[k];
        if (!m?.id) continue;
        if (!m.sender_user_id || m.sender_user_id === i.myUserId) continue; // mine, or unknown sender
        if (!isTextLikeMessageType(m.content?.type)) continue;
        if (i.isSaved(m.id)) continue;
        return m.id;
    }
    return null;
}

export interface CoachGateInput {
    /** NudgeState.coachSaveDone. */
    done: boolean;
    /** NudgeState.off — "Don't show these" covers tips too. */
    off: boolean;
    createdAt: string | number | null | undefined;
    now: number;
    /** The window is focused and visible: a mark shown to nobody is a mark wasted. */
    windowActive: boolean;
}

export function coachMayShow(g: CoachGateInput): boolean {
    return !g.done && !g.off && g.windowActive && isWithinCoachWindow(g.createdAt, g.now);
}

export interface CoachCopy {
    title: string;
    body: string;
    hint: string;
    save: string;
    dismiss: string;
}

/** "Messages here delete themselves after 1 week." — the label comes from the
 *  same table the Storage settings use, so the two can never disagree. */
export function saveCoachCopy(retention: MessageRetention): CoachCopy {
    const after = (MESSAGE_RETENTION_LABELS[retention] ?? '').toLowerCase();
    return {
        title: 'Keep what matters',
        body: after
            ? `Messages in this chat delete themselves after ${after}. Save the ones you want to keep and they stay.`
            : 'Messages in this chat delete themselves after a while. Save the ones you want to keep and they stay.',
        hint: 'Hover a message to see when it expires, tap the message to save it.',
        save: 'Save this message',
        dismiss: 'Got it',
    };
}
