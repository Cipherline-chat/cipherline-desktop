/* ============================================================
   The pointer-driven 3D reaction of the dot field ("parallax"), as ONE
   definition shared by every onboarding step that wants it.

   Two tweened engine params carry it:
     follow  how far the cloud yaws/pitches toward the pointer (the 3D tilt)
     repel   how strongly the dots part around the pointer
   Both default to 1 in the engine; a step that wants a calmer feel sets them
   on enter. The invite step ("Bring a friend") and the privacy step both use
   POINTER_REACTION, so the two screens feel identical.

   Pure and DOM-free so the contract is unit-testable without WebGL.
   ============================================================ */
import type { DotField } from './engine';

export const POINTER_REACTION = { follow: 0.6, repel: 0.5 } as const;

/**
 * The effective `follow` gain the engine applies to the pointer's yaw/pitch.
 * Reduced motion means NO pointer reaction at all, whatever the step asked for.
 */
export function effectiveFollow(follow: number, reducedMotion: boolean): number {
  return reducedMotion ? 0 : follow;
}

/**
 * Turn the pointer reaction on for the current step. Only sets two params; it
 * never morphs, snaps or kicks a scene, so it is safe to call on enter and
 * has no effect on what the field is currently showing.
 */
export function applyPointerReaction(field: Pick<DotField, 'param'>, ms = 600): void {
  void field.param('follow', POINTER_REACTION.follow, ms);
  void field.param('repel', POINTER_REACTION.repel, ms);
}
