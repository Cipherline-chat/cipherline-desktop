import { describe, it, expect } from 'vitest';
import { parseParticipantDragId, parseMoveDropTarget } from './moveDrag';

/**
 * Pure drag-id logic for force-move (drag a member from one call to another).
 *
 * These two helpers are the whole reason the feature can share one DndContext
 * with the pre-existing huddle/category reorder instead of nesting a second
 * one: every drag handler branches on whether parseParticipantDragId returns
 * null. If that discrimination breaks, a participant drag would fall through
 * into the reorder path (or vice versa) and silently reorder channels.
 */

const CALL_A = '3f1b2c4d-0000-4000-8000-000000000001';
const CALL_B = '3f1b2c4d-0000-4000-8000-000000000002';
const USER   = '9a8b7c6d-0000-4000-8000-0000000000ff';
const HUDDLE = '11112222-0000-4000-8000-000000000abc';

describe('parseParticipantDragId', () => {
    it('splits a participant drag id into its call and user', () => {
        expect(parseParticipantDragId(`pt:${CALL_A}:${USER}`))
            .toEqual({ callId: CALL_A, userId: USER });
    });

    it('returns null for the reorder ids that share the same DndContext', () => {
        // These are the ids the huddle/category sortables use. Treating any of
        // them as a participant drag would hijack channel reordering.
        expect(parseParticipantDragId(`hd:${HUDDLE}`)).toBeNull();
        expect(parseParticipantDragId('hcat:general')).toBeNull();
        expect(parseParticipantDragId(`call:${CALL_A}`)).toBeNull();
        expect(parseParticipantDragId(`hud:${HUDDLE}`)).toBeNull();
    });

    it('rejects malformed ids rather than producing a half-parsed drag', () => {
        expect(parseParticipantDragId('pt:')).toBeNull();              // nothing at all
        expect(parseParticipantDragId(`pt:${CALL_A}`)).toBeNull();     // no separator → no user
        expect(parseParticipantDragId(`pt::${USER}`)).toBeNull();      // empty call id
        expect(parseParticipantDragId(`pt:${CALL_A}:`)).toBeNull();    // empty user id
    });

    it('splits on the FIRST separator so the user id survives intact', () => {
        // Both ids are UUIDs (no colons), but splitting from the wrong end
        // would corrupt them if that ever changed.
        const parsed = parseParticipantDragId(`pt:${CALL_A}:${USER}`);
        expect(parsed?.userId).toBe(USER);
        expect(parsed?.callId).not.toContain(':');
    });
});

describe('parseMoveDropTarget', () => {
    it('resolves a drop on another call', () => {
        expect(parseMoveDropTarget(`call:${CALL_B}`, CALL_A))
            .toEqual({ kind: 'call', callId: CALL_B });
    });

    it('resolves a drop on an empty Calls channel (spawn-then-move)', () => {
        expect(parseMoveDropTarget(`hud:${HUDDLE}`, CALL_A))
            .toEqual({ kind: 'huddle', huddleId: HUDDLE });
    });

    it('refuses a drop back on the call they are already in', () => {
        // Not an error, just a no-op — the server would reject it as
        // "already in that call", so the client shouldn't send it.
        expect(parseMoveDropTarget(`call:${CALL_A}`, CALL_A)).toBeNull();
    });

    it('ignores reorder drop targets', () => {
        expect(parseMoveDropTarget(`hd:${HUDDLE}`, CALL_A)).toBeNull();
        expect(parseMoveDropTarget('hcat:voice', CALL_A)).toBeNull();
    });

    it('rejects empty ids', () => {
        expect(parseMoveDropTarget('call:', CALL_A)).toBeNull();
        expect(parseMoveDropTarget('hud:', CALL_A)).toBeNull();
    });
});
