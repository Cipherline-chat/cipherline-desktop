/**
 * Motion for the rail folder popover — one place to tweak the feel.
 *
 * Open: the popover grows out of the folder tile (transform-origin is the
 * tile's centre) from FOLDER_FROM_SCALE with a fade and a slight overshoot,
 * and the server icons stagger in. Close: the reverse, quicker, no overshoot.
 * Reduced motion: opacity only — no scale, no stagger.
 */
type Bezier = [number, number, number, number];

export const FOLDER_FROM_SCALE = 0.85;
/** ~200 ms with a gentle overshoot ("slight spring") — a bezier rather than a
 *  real spring so the settle time is fixed and short. */
export const FOLDER_OPEN = { duration: 0.2, ease: [0.22, 1.22, 0.36, 1] as Bezier };
export const FOLDER_CLOSE = { duration: 0.14, ease: [0.4, 0, 0.9, 0.6] as Bezier };
export const FOLDER_FADE = { duration: 0.12 };
/** Icons inside: the first after ICON_DELAY, then one every ICON_STAGGER. */
export const ICON_DELAY = 0.04;
export const ICON_STAGGER = 0.02;
export const ICON_FROM_SCALE = 0.72;
export const ICON_IN = { duration: 0.18, ease: [0.22, 1.3, 0.36, 1] as Bezier };

export function popoverMotion(reduced: boolean) {
    if (reduced) {
        return {
            initial: { opacity: 0 },
            animate: { opacity: 1, transition: FOLDER_FADE },
            exit: { opacity: 0, transition: FOLDER_FADE },
        };
    }
    return {
        initial: { opacity: 0, scale: FOLDER_FROM_SCALE },
        animate: { opacity: 1, scale: 1, transition: { ...FOLDER_OPEN, opacity: { duration: 0.12 } } },
        exit: { opacity: 0, scale: FOLDER_FROM_SCALE, transition: FOLDER_CLOSE },
    };
}

export function iconMotion(reduced: boolean, index: number) {
    if (reduced) return { initial: false as const, animate: { opacity: 1, scale: 1 } };
    return {
        initial: { opacity: 0, scale: ICON_FROM_SCALE },
        animate: { opacity: 1, scale: 1, transition: { ...ICON_IN, delay: ICON_DELAY + index * ICON_STAGGER } },
    };
}
