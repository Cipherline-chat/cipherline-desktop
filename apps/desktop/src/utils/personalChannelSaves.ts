/**
 * personalChannelSaves — desktop's channel "Save — keep forever" and mobile's
 * channel "Save for me" become one synced thing.
 *
 * Desktop's save on a channel message has always been a RETENTION save
 * (`useRetentionPolicy`: saved-message / saved-attachment id lists, local to
 * this device). Mobile's is a private bookmark keyed by message id. To make the
 * one gesture mean the same thing everywhere, the channel ChatPane gets a
 * retention object wrapped by `withPersonalChannelSaves`:
 *
 *   • saving/unsaving still does exactly what it did (the retention save), AND
 *     records a personal channel save for the message, which the
 *     `personal_saves` slot carries to the account's other devices;
 *   • a message saved on ANOTHER device (present in `localChannelPins`) reads
 *     as saved here — indicator, keep-forever expiry and all — without being
 *     copied into the retention lists, so the two stores never fight.
 *
 * The retention sweep already unions `localChannelPins` into its exemptions,
 * so a synced save is kept forever on this device too.
 *
 * Pure — no React, no storage — so it is unit-testable.
 */

import type { RetentionHook } from '../hooks/useRetentionPolicy';

export interface PersonalChannelSavesInput {
    /** Personally saved message ids in THIS channel. */
    savedMessageIds: readonly string[];
    /** Message id for an attachment id, for this channel's loaded messages. */
    messageIdForAttachment: (attachmentId: string) => string | undefined;
    /** Attachment ids of the personally saved messages that carry one. */
    savedAttachmentIds: readonly string[];
    /** Record a personal save change (applies locally + marks the slot dirty). */
    onToggle: (messageId: string, action: 'add' | 'remove') => void;
}

export function withPersonalChannelSaves(retention: RetentionHook, input: PersonalChannelSavesInput): RetentionHook {
    const toggleForAttachment = (attId: string, action: 'add' | 'remove') => {
        const m = input.messageIdForAttachment(attId);
        if (m) input.onToggle(m, action);
    };
    // Every save/unsave does what it always did, then fans out as a personal save.
    const writes = {
        saveMessage: (id: string) => { retention.saveMessage(id); input.onToggle(id, 'add'); },
        unsaveMessage: (id: string) => { retention.unsaveMessage(id); input.onToggle(id, 'remove'); },
        saveAttachment: (attId: string) => { retention.saveAttachment(attId); toggleForAttachment(attId, 'add'); },
        unsaveAttachment: (attId: string) => { retention.unsaveAttachment(attId); toggleForAttachment(attId, 'remove'); },
    };

    const savedMsgs = new Set(input.savedMessageIds);
    const savedAtts = new Set(input.savedAttachmentIds);
    if (savedMsgs.size === 0 && savedAtts.size === 0) return { ...retention, ...writes };

    // Saves made on another device read as saved here, without being copied
    // into this device's retention lists.
    const p = retention.policy;
    const policy = {
        ...p,
        savedMessageIds: [...p.savedMessageIds, ...[...savedMsgs].filter(id => !p.savedMessageIds.includes(id))],
        unsavedMessageIds: p.unsavedMessageIds.filter(id => !savedMsgs.has(id)),
        savedAttachmentIds: [...p.savedAttachmentIds, ...[...savedAtts].filter(id => !p.savedAttachmentIds.includes(id))],
        unsavedAttachmentIds: p.unsavedAttachmentIds.filter(id => !savedAtts.has(id)),
    };

    return {
        ...retention,
        ...writes,
        policy,
        isMessageSaved: (id: string) => savedMsgs.has(id) || retention.isMessageSaved(id),
        isAttachmentSaved: (attId: string) => savedAtts.has(attId) || retention.isAttachmentSaved(attId),
        getMessageExpiryAt: (id: string, sentAtMs: number) =>
            savedMsgs.has(id) ? null : retention.getMessageExpiryAt(id, sentAtMs),
        getAttachmentExpiryAt: (attId: string, sentAtMs: number) =>
            savedAtts.has(attId) ? null : retention.getAttachmentExpiryAt(attId, sentAtMs),
    };
}

/** The attachment ids of the saved messages among `messages`. */
export function attachmentIdsOf(messages: readonly { id?: string; content?: { type?: string; attachment_id?: string } }[], saved: readonly string[]): string[] {
    const want = new Set(saved);
    const out: string[] = [];
    for (const m of messages) {
        if (m?.id && want.has(m.id) && m.content?.type === 'attachment' && m.content.attachment_id) {
            out.push(m.content.attachment_id);
        }
    }
    return out;
}
