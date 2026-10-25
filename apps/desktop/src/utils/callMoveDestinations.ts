/**
 * Where a moderator (MANAGE_CALL_MEMBERS) may move a call participant — the
 * "Move to ▸" submenu and the drag-and-drop targets list the same set.
 *
 * The rule (owner, 2026-10-24): "I should be able to move someone to a private
 * channel if I want to, as long as I myself can join that channel." So every
 * destination is filtered by the VIEWER's own access only:
 *
 *   • any other live call whose Calls channel the viewer can CONNECT to;
 *   • any Calls channel with no call running where the viewer can CONNECT AND
 *     START_CALLS (moving someone there starts a call, with the viewer as its
 *     starter).
 *
 * The TARGET's permissions are deliberately not consulted: the server admits a
 * member without access as a guest of that one call (HuddlesService "Moved-in
 * guests"). A channel that not everyone can see is marked `restricted`, so the
 * menu can say "(private)" — the moderator should know they are putting someone
 * somewhere that person could not go alone.
 *
 * UX only: the server re-checks all of it.
 */

export interface MoveDestCall {
    call_id: string;
    huddle_id: string;
    name: string;
    participants: string[];
}

export interface MoveDestChannel {
    channel_id: string;
    name: string;
    kind: string;
    /** From the channel list: 'restricted' = some members cannot see it. */
    view_scope?: 'all' | 'restricted';
}

export type MoveDestination =
    | { kind: 'call'; callId: string; huddleId: string; label: string; restricted: boolean }
    | { kind: 'huddle'; huddleId: string; label: string; restricted: boolean };

export const PRIVATE_HINT = '(private)';

export interface MoveDestinationInput {
    /** The member being moved. */
    targetUserId: string;
    /** Every live call the viewer knows about, grouped or not. */
    calls: MoveDestCall[];
    /** The server's channels (only `kind: 'huddle'` ones are considered). */
    channels: MoveDestChannel[];
    /** Calls per Calls channel, to know which channels have none running. */
    callsByChannel: Record<string, unknown[] | undefined>;
    /** The VIEWER's own CONNECT on a channel. */
    canConnect(channelId: string): boolean;
    /** The VIEWER's own START_CALLS on a channel. */
    canStartCalls(channelId: string): boolean;
}

function withHint(label: string, restricted: boolean): string {
    return restricted ? `${label} ${PRIVATE_HINT}` : label;
}

/** Destinations for moving `targetUserId`, or [] when they are in no call. */
export function listMoveDestinations(input: MoveDestinationInput): MoveDestination[] {
    const source = input.calls.find(c => c.participants.includes(input.targetUserId));
    if (!source) return [];

    const huddles = input.channels.filter(c => c.kind === 'huddle');
    const byId = new Map(huddles.map(h => [h.channel_id, h] as const));
    const out: MoveDestination[] = [];

    for (const c of input.calls) {
        if (c.call_id === source.call_id) continue;
        if (!input.canConnect(c.huddle_id)) continue;
        const ch = byId.get(c.huddle_id);
        const restricted = ch?.view_scope === 'restricted';
        out.push({
            kind: 'call',
            callId: c.call_id,
            huddleId: c.huddle_id,
            label: withHint(`${c.name} · ${ch?.name ?? 'Calls'}`, restricted),
            restricted,
        });
    }
    for (const h of huddles) {
        if ((input.callsByChannel[h.channel_id] ?? []).length > 0) continue;
        if (!input.canConnect(h.channel_id) || !input.canStartCalls(h.channel_id)) continue;
        const restricted = h.view_scope === 'restricted';
        out.push({
            kind: 'huddle',
            huddleId: h.channel_id,
            label: withHint(`New call in ${h.name}`, restricted),
            restricted,
        });
    }
    return out;
}
