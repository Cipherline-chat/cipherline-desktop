import { useClTooltip } from './cl/useClTooltip';

/** The hover/focus hint on every slider that carries a `resetValue`. One string
 *  so the wording is identical everywhere (and the wiring test can find it). */
export const SLIDER_RESET_HINT = 'Double-click to reset';

/**
 * The value a double-click puts the slider back to, or `null` when it should do
 * nothing (no default declared, disabled, or a non-finite default). Clamped to
 * [min, max] so a default outside the range (e.g. a persisted ceiling that was
 * later lowered) can never paint the thumb off the track.
 */
export function resolveSliderReset(
    resetValue: number | undefined,
    min: number,
    max: number,
    disabled?: boolean,
): number | null {
    if (disabled || resetValue === undefined || !Number.isFinite(resetValue)) return null;
    return Math.min(Math.max(resetValue, min), max);
}

/**
 * The "Double-click to reset" hint as a hook, for the sliders that are not a
 * ClSlider (the voice-gate threshold, the EQ bands) so every reset-capable
 * slider hints the same way. Wire it onto the slider root:
 * `ref={node => { myRef.current = node; hint.anchorRef(node); }}`,
 * `{...hint.handlers}`, `aria-describedby={hint.describedBy}`, call
 * `hint.closeHint()` from your own onPointerDown, and render `hint.tip` beside it.
 */
export function useSliderResetHint(enabled: boolean) {
    const { anchorProps, tooltip, describedBy } = useClTooltip(enabled ? SLIDER_RESET_HINT : null);
    const { ref, onPointerDown, ...handlers } = anchorProps;
    return { anchorRef: ref, closeHint: onPointerDown, handlers, tip: tooltip, describedBy };
}
