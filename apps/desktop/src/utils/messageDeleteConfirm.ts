/**
 * messageDeleteConfirm — the confirmation policy for deleting a chat message.
 *
 * Pure decision logic, deliberately kept out of ChatPane so it can be tested
 * without a renderer. Two things live here:
 *
 *   1. The ENTRY-POINT TABLE. A confirmation that guards some delete buttons
 *      and not others is worse than no confirmation at all — the user stops
 *      expecting the dialog and then loses a message on the path that skipped
 *      it. So every affordance that can delete a message is listed explicitly
 *      with its own `requiresConfirmation` flag, and `shouldConfirmMessageDelete`
 *      refuses to guess: an entry point that is not in the table confirms.
 *
 *   2. The DIALOG COPY — a title and a Delete label. See buildDeleteConfirmCopy.
 */

/** Every affordance in the app that can issue a `delete` ClientContent. */
export type MessageDeleteEntryPoint =
    /** Hover the message row, click the trash icon in the floating action bar. */
    | 'msgbar-mouse'
    /** Same button, activated from the keyboard (Enter/Space on the focused button). */
    | 'msgbar-keyboard'
    /**
     * Right-click the message, pick Delete from the context menu. The menu's
     * `onSelect` carries no MouseEvent, so there is no Shift state to read
     * here — this path always confirms, which `requiresConfirmation: true`
     * plus a hard-coded `shiftKey: false` at the call site both express.
     */
    | 'contextmenu';

export interface MessageDeleteEntryPointSpec {
    id: MessageDeleteEntryPoint;
    /** What the user physically does to reach this. */
    description: string;
    /**
     * Whether this path shows the confirmation dialog. Spelled out per entry
     * point rather than assumed, so a future path that opts out shows up as a
     * visible `false` in this table instead of as a silent omission.
     */
    requiresConfirmation: boolean;
}

export const MESSAGE_DELETE_ENTRY_POINTS: readonly MessageDeleteEntryPointSpec[] = [
    {
        id: 'msgbar-mouse',
        description: 'Message hover action bar — trash button, clicked with the mouse',
        requiresConfirmation: true,
    },
    {
        id: 'msgbar-keyboard',
        description: 'Message hover action bar — trash button, activated with Enter/Space',
        requiresConfirmation: true,
    },
    {
        id: 'contextmenu',
        description: 'Right-click message context menu — Delete item',
        requiresConfirmation: true,
    },
];

export interface DeleteActivation {
    entryPoint: MessageDeleteEntryPoint;
    /**
     * Whether Shift was held at the moment of activation.
     *
     * This is read off the click event, NOT off a mousedown, so the bypass is
     * input-agnostic: the browser stamps the current modifier state onto the
     * click it synthesises when a focused <button> is activated with Enter or
     * Space, so Shift+Enter on the focused trash button bypasses exactly the
     * way a shift-click does. Keyboard users are not locked out of the bypass.
     */
    shiftKey: boolean;
}

/**
 * Should this delete activation raise the confirmation dialog?
 *
 * `table` is injectable purely so the unit tests can positive-control the
 * `requiresConfirmation` flag — production always uses the module table.
 */
export function shouldConfirmMessageDelete(
    activation: DeleteActivation,
    table: readonly MessageDeleteEntryPointSpec[] = MESSAGE_DELETE_ENTRY_POINTS,
): boolean {
    const spec = table.find(s => s.id === activation.entryPoint);
    // Unknown entry point — a path that was added without being registered
    // here. Fail toward the dialog; losing a message is the worse outcome.
    if (!spec) return true;
    if (!spec.requiresConfirmation) return false;
    return !activation.shiftKey;
}

export interface DeleteConfirmCopy {
    title: string;
    confirmLabel: string;
}

export interface DeleteCopyContext {
    /** False when a moderator is deleting somebody else's message. */
    isOwnMessage: boolean;
}

/**
 * The dialog is a bare yes/no: a title and two buttons, nothing else.
 *
 * It used to carry a paragraph on sync semantics and relay retention plus a
 * "Hold Shift to skip" hint. The owner asked for all of that to go (2026-09-16)
 * — a confirmation exists to catch a misclick, and a paragraph in front of the
 * buttons slows down the common case to explain an edge case. The Shift bypass
 * itself still works; it is simply no longer advertised here.
 */
export function buildDeleteConfirmCopy(ctx: DeleteCopyContext): DeleteConfirmCopy {
    return {
        title: ctx.isOwnMessage ? 'Delete this message?' : 'Delete this message as a moderator?',
        confirmLabel: 'Delete',
    };
}
