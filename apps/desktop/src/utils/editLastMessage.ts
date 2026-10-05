/**
 * editLastMessage — "press Up to edit your last message" decision logic.
 *
 * Pure, so the interesting half of the feature is testable without a renderer.
 * Two questions are answered here and nowhere else:
 *
 *   1. Which message would Up target? (`findLastEditableOwnMessage`)
 *   2. Should Up open the editor at all, or move the caret? (`shouldOpenEditorOnArrowUp`)
 *
 * (2) is the part that decides whether the composer feels broken. Up inside a
 * real draft must move the caret — it is a textarea, and a multi-line draft is
 * the common case, not the edge case. So the predicate is deliberately narrow:
 * it fires only when there is nothing in the composer for Up to navigate.
 */

export interface EditableMessageLike {
    id?: string | null;
    content?: { type?: string | null; text?: string | null } | null;
    sender_user_id?: string | null;
    sender_device_id?: string | null;
}

export interface OwnershipContext {
    myUserId?: string | null;
    /** This account's device ids — the fallback when an envelope carries no user id. */
    myDeviceIds: ReadonlySet<string>;
}

/** Same ownership rule ChatPane renders `isMe` with: user id if present, else device id. */
export function isOwnMessage(msg: EditableMessageLike, ctx: OwnershipContext): boolean {
    if (msg.sender_user_id) {
        return !!ctx.myUserId && msg.sender_user_id === ctx.myUserId;
    }
    return !!msg.sender_device_id && ctx.myDeviceIds.has(msg.sender_device_id);
}

/**
 * Exactly the condition the message action bar uses to show its Edit button:
 * your own message, and a plain `text` ClientContent.
 *
 * That single rule is what excludes everything the edit path refuses —
 * attachments, invites, safety-number embeds, call events and system rows all
 * carry a different `content.type`, and a deleted message is not in the list at
 * all (clients fold a `delete` by splicing the row out, they do not tombstone
 * it). Keeping this as one mirror of the button's condition, rather than a
 * second hand-maintained blocklist, is what stops Up and the button from
 * drifting apart.
 */
export function isEditableOwnMessage(msg: EditableMessageLike | null | undefined, ctx: OwnershipContext): boolean {
    if (!msg || !msg.id) return false;
    if (msg.content?.type !== 'text') return false;
    return isOwnMessage(msg, ctx);
}

/** The newest editable message this account sent, or null. Scans from the end. */
export function findLastEditableOwnMessage<T extends EditableMessageLike>(
    messages: readonly T[] | null | undefined,
    ctx: OwnershipContext,
): T | null {
    if (!messages) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (isEditableOwnMessage(m, ctx)) return m;
    }
    return null;
}

export interface ArrowUpContext {
    /** Current composer value. */
    composerText: string;
    /** Caret/selection in the composer textarea. */
    selectionStart: number;
    selectionEnd: number;
    /** An edit is already open — Up must not restart it. */
    isEditing: boolean;
    /** A reply is being composed — Up must not hijack it. */
    isReplying: boolean;
    /** The @mention or :emoji suggestion menu owns Up while it is open. */
    hasOpenSuggestions: boolean;
    /** Files staged for upload — the composer is a caption field, leave it alone. */
    stagedFileCount: number;
    modifiers: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean };
    /** Whether findLastEditableOwnMessage found anything. */
    hasEditableCandidate: boolean;
}

/**
 * Should ArrowUp in the composer open the editor for the last own message?
 *
 * False means "do nothing" — the caller does not preventDefault, so the
 * textarea gets its normal caret movement. When there is simply no editable
 * message the answer is also false: nothing happens, quietly, rather than an
 * empty editor opening.
 */
export function shouldOpenEditorOnArrowUp(ctx: ArrowUpContext): boolean {
    const { shiftKey, ctrlKey, altKey, metaKey } = ctx.modifiers;
    // Shift+Up selects, Ctrl/Alt/Cmd+Up are word/document/OS navigation.
    if (shiftKey || ctrlKey || altKey || metaKey) return false;

    if (ctx.hasOpenSuggestions) return false;
    if (ctx.isEditing) return false;
    if (ctx.isReplying) return false;
    if (ctx.stagedFileCount > 0) return false;

    // The load-bearing condition. A draft with any real content keeps Up as a
    // caret key, whether it is one line or twenty; whitespace-only counts as
    // empty but still has to have the caret parked at the very start, so Up
    // can never yank the caret out of somewhere the user put it.
    if (ctx.composerText.trim() !== '') return false;
    if (ctx.selectionStart !== 0 || ctx.selectionEnd !== 0) return false;

    return ctx.hasEditableCandidate;
}
