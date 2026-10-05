/**
 * Pure drag-id logic for force-move — dragging a member from one server call
 * into another (see ServerContextPanel).
 *
 * The move gesture deliberately shares the pre-existing huddle/category
 * reorder DndContext rather than nesting a second one, so every drag handler
 * has to tell the two apart. That discrimination lives here, kept free of
 * React and network imports so it can be unit-tested on its own:
 *
 *   pt:{callId}:{userId}  draggable — a participant row
 *   call:{callId}         droppable — an existing call
 *   hud:{huddleId}        droppable — a Calls channel with no active call
 *
 * `hd:` / `hcat:` (huddle + category reorder) are the ids these must never
 * claim; treating one as a participant drag would hijack channel reordering.
 */

export const PT_PREFIX = 'pt:';
export const CALL_DROP_PREFIX = 'call:';
export const HUDDLE_DROP_PREFIX = 'hud:';

export interface ParsedParticipantDrag { callId: string; userId: string }

export type MoveDropTarget =
    | { kind: 'call'; callId: string }
    | { kind: 'huddle'; huddleId: string };

/** Parse a `pt:{callId}:{userId}` draggable id, or null for anything else
 *  (including a well-formed reorder id). Both parts must be non-empty — a
 *  half-parsed drag would post a move with an undefined target. */
export function parseParticipantDragId(id: string): ParsedParticipantDrag | null {
    if (!id.startsWith(PT_PREFIX)) return null;
    const rest = id.slice(PT_PREFIX.length);
    const sep = rest.indexOf(':');
    if (sep <= 0 || sep === rest.length - 1) return null;
    return { callId: rest.slice(0, sep), userId: rest.slice(sep + 1) };
}

/** Where a drop landed, or null if it isn't a valid move. Dropping someone
 *  back on the call they're already in is a no-op, not an error — the server
 *  would reject it, so we don't send it. */
export function parseMoveDropTarget(overId: string, sourceCallId: string): MoveDropTarget | null {
    if (overId.startsWith(CALL_DROP_PREFIX)) {
        const callId = overId.slice(CALL_DROP_PREFIX.length);
        return callId && callId !== sourceCallId ? { kind: 'call', callId } : null;
    }
    if (overId.startsWith(HUDDLE_DROP_PREFIX)) {
        const huddleId = overId.slice(HUDDLE_DROP_PREFIX.length);
        return huddleId ? { kind: 'huddle', huddleId } : null;
    }
    return null;
}
