/**
 * What the Create Channel dialog does about NAVIGATION once the server has
 * answered a create. Pure, so the decision is testable without the dialog.
 *
 *  - "Create another" checked  -> stay in the dialog, go nowhere.
 *  - the server refused        -> go nowhere (the error toast / inline error stays).
 *  - success, text channel     -> open it, exactly as a sidebar click would.
 *  - success, Calls channel    -> only select/reveal its row; joining a call is a
 *                                 separate, deliberate action and never happens here.
 *
 * The target is always the REAL channel the server returned. A `pending:` id is
 * the optimistic placeholder (never a channel the rest of the app can open), so
 * it is refused outright rather than trusted to be replaced in time.
 */
export const PENDING_CHANNEL_PREFIX = 'pending:';

export type CreateNavigation =
    | { action: 'none' }
    | { action: 'open'; channelId: string }
    | { action: 'reveal'; channelId: string };

export interface CreateOutcome {
    /** The server created the channel. */
    ok: boolean;
    /** The channel the SERVER returned (undefined on failure). */
    channel?: { channel_id: string; kind: string } | null;
    /** The "Create another" box, already ANDed with the toggle being offered. */
    keepOpen: boolean;
}

export function decideCreateNavigation(o: CreateOutcome): CreateNavigation {
    if (!o.ok || o.keepOpen || !o.channel) return { action: 'none' };
    const channelId = o.channel.channel_id;
    if (!channelId || channelId.startsWith(PENDING_CHANNEL_PREFIX)) return { action: 'none' };
    return o.channel.kind === 'text'
        ? { action: 'open', channelId }
        : { action: 'reveal', channelId };
}
