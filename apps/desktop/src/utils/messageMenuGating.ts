/**
 * messageMenuGating — pure permission/gating rules shared by the message
 * hover action bar and the right-click context menu (both in ChatPane.tsx).
 *
 * Pulled out of the component so each rule is testable without mounting the
 * ~7k-line ChatPane, and — the concrete motivation — so the hover bar and the
 * context menu can never silently disagree about who is allowed to do what.
 * `canPinMessage` in particular is the single source of truth for Pin/Unpin:
 * a second, independently-maintained copy of "!activeChannel || canManageMessages"
 * is exactly how the two menus would drift the next time either one is edited
 * (e.g. a future permission-model change that only touches one call site).
 *
 * Each function mirrors a boolean expression that used to be duplicated
 * inline in ChatPane's render — see the call sites for the pre-refactor shape.
 */

export interface MessageMenuContext {
    /** True for a server channel message; false for a DM/group message. */
    isChannelMessage: boolean;
    /** MANAGE_MESSAGES on the current channel. Meaningless (ignored) for DMs/groups. */
    canManageMessages: boolean;
    /** Whether the viewer sent this message. */
    isOwnMessage: boolean;
    /** `message.content.type === 'text'`. */
    isTextMessage: boolean;
    /**
     * Whether this chat currently allows composing (send/reply/react/edit) —
     * false e.g. in a DM after removing the other person as a friend, where
     * history remains visible but the conversation is otherwise frozen.
     */
    canCompose: boolean;
    /** ADD_REACTIONS on the channel, or friendship/group-membership in a DM. */
    canReact: boolean;
}

/**
 * Pin / Unpin — THE single source of truth for both the hover bar and the
 * context menu (and any future entry point). DM/group: a local bookmark,
 * always allowed — there is no shared-pin concept for an E2EE DM. Channel:
 * shared + server-stored, so it requires MANAGE_MESSAGES, same as the API.
 */
export function canPinMessage(
    ctx: Pick<MessageMenuContext, 'isChannelMessage' | 'canManageMessages'>,
): boolean {
    return !ctx.isChannelMessage || ctx.canManageMessages;
}

/**
 * What the "Save to server" entry should offer for one message — THE single
 * source of truth for the hover bar and the context menu, same reasoning as
 * `canPinMessage`.
 *
 * Server save is a channel-only concept (a DM has no server to save to) and
 * needs SAVE_MESSAGES, which the API enforces independently. Every pinned
 * message is saved and the API refuses to unsave one (409 MESSAGE_PINNED),
 * so a pinned message offers a disabled "Saved (pinned)" row that tells the
 * user to unpin first, rather than a Remove that would always fail.
 *
 *   'hidden'  — not shown at all (DM/group, or no SAVE_MESSAGES)
 *   'save'    — "Save to server"
 *   'unsave'  — "Remove from server"
 *   'pinned'  — disabled "Saved (pinned)", tooltip "Unpin first"
 */
export type ServerSaveAction = 'hidden' | 'save' | 'unsave' | 'pinned';

/** Whether the "Save to server" entry exists at all for this chat: channel
 *  messages only, and only with SAVE_MESSAGES. */
export function canServerSaveMessage(
    ctx: { isChannelMessage: boolean; canSaveMessages: boolean },
): boolean {
    return ctx.isChannelMessage && ctx.canSaveMessages;
}

export function serverSaveAction(ctx: {
    isChannelMessage: boolean;
    /** SAVE_MESSAGES on the current channel. Meaningless (ignored) for DMs/groups. */
    canSaveMessages: boolean;
    /** The message is server-saved (pinned or not). */
    isServerSaved: boolean;
    /** The message is pinned in this channel (and therefore saved). */
    isPinned: boolean;
}): ServerSaveAction {
    if (!canServerSaveMessage(ctx)) return 'hidden';
    // Pinned wins even if the saved list lags the pinned list for a moment
    // (both come from one GET, but optimistic updates touch them separately):
    // a pinned message IS saved, whatever the local saved list says.
    if (ctx.isPinned) return 'pinned';
    return ctx.isServerSaved ? 'unsave' : 'save';
}

/** Reply — available whenever this chat can be composed in at all. */
export function canReplyToMessage(ctx: Pick<MessageMenuContext, 'canCompose'>): boolean {
    return ctx.canCompose;
}

/** Add/quick-react — needs both a composable chat AND the reaction permission. */
export function canReactToMessage(
    ctx: Pick<MessageMenuContext, 'canCompose' | 'canReact'>,
): boolean {
    return ctx.canCompose && ctx.canReact;
}

/** Edit — own plain-text messages only, and only while this chat is composable. */
export function canEditMessage(
    ctx: Pick<MessageMenuContext, 'canCompose' | 'isOwnMessage' | 'isTextMessage'>,
): boolean {
    return ctx.canCompose && ctx.isOwnMessage && ctx.isTextMessage;
}

/**
 * Delete — your own message, or any message if you can moderate this channel
 * (DMs/groups have no moderator concept, so `canManageMessages` is always
 * false there and only the own-message branch applies). Gated on `canCompose`
 * to match the hover bar's existing behaviour: the whole action bar — Delete
 * included — is hidden once a DM is no longer composable (e.g. after
 * unfriending), and this preserves that rather than quietly expanding it.
 */
export function canDeleteMessage(
    ctx: Pick<MessageMenuContext, 'canCompose' | 'isOwnMessage' | 'canManageMessages'>,
): boolean {
    return ctx.canCompose && (ctx.isOwnMessage || ctx.canManageMessages);
}

/**
 * Content-kind classification shared by save/pin/expiry logic: text,
 * server_invite and klipy_gif messages are treated identically for pin / save /
 * report / retention. (A KLIPY GIF is a link, so it has no "Copy Text" — the
 * menu special-cases it.)
 */
export function isTextLikeMessageType(contentType: string | null | undefined): boolean {
    return contentType === 'text' || contentType === 'server_invite' || contentType === 'klipy_gif';
}
