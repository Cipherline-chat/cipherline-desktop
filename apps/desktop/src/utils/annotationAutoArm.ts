/**
 * annotationAutoArm - "they said yes, so start drawing".
 *
 * After a streamer approves OUR request to draw on their share, the viewer
 * used to have to find the pencil and then, separately, pick a colour. When
 * the share is on a surface where the tool exists (the focused stage or any
 * fullscreen view) that is just friction: we asked, we were let in, we want to
 * draw. So the approval arms the tool.
 *
 * The decision is deliberately small and lives here, away from React, so the
 * state transitions are testable in plain vitest:
 *
 *   approval marker (store, one-shot, set only by a LIVE grant.grant naming
 *   us while our request was pending)
 *     + this tile is a drawing surface (focused / fullscreen)
 *     + we are actually on the track's grant list
 *     => annotationStore.setEnabled(true)
 *
 * `setEnabled(true)` IS what the pencil button does (AnnotationToolbar's
 * onClick), so this is the same code path and the same state - and the
 * toolbar's colour picker is shown whenever `enabled` is on, so "armed" and
 * "picker expanded" are one fact, not two to keep in step.
 *
 * It never moves keyboard focus (so it cannot pull focus out of a text input
 * the user is typing in) and never touches the sharer side: the marker is only
 * ever set on the viewer, for a request the viewer made.
 */
import { annotationStore, AUTO_ARM_WINDOW_MS } from './annotationStore';

export interface AutoArmContext {
    /** This tile is a place drawing exists: focused stage or a fullscreen view,
     *  NOT the right-hand sidebar column / grid thumbnails. */
    surfaceActive: boolean;
    /** The owner's grant list names us for this track (the list message
     *  follows the grant message, so this can lag it by a beat). */
    granted: boolean;
}

/**
 * Try to arm drawing for `trackKey`. Returns true when it did.
 *
 * The marker is spent only when every condition holds, so an approval that
 * lands while the share is in the sidebar column stays claimable for
 * AUTO_ARM_WINDOW_MS: focus it inside the window and it arms then; let the
 * window lapse and it simply expires, leaving today's behaviour (the pencil
 * is available, nothing is armed).
 */
export function tryAutoArm(trackKey: string, ctx: AutoArmContext): boolean {
    if (!ctx.surfaceActive || !ctx.granted) return false;
    if (!annotationStore.consumeApproval(trackKey, AUTO_ARM_WINDOW_MS)) return false;
    annotationStore.setEnabled(true);
    return true;
}

/** What assistive tech (and the toast) is told when drawing starts by itself. */
export const autoArmAnnouncement = (ownerName: string, isScreenShare: boolean): string =>
    `Drawing on ${ownerName}'s ${isScreenShare ? 'screen' : 'video'} — Esc to stop`;
