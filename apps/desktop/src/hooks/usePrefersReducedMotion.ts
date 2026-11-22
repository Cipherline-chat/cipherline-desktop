import { useReducedMotionSetting } from '../utils/a11y/motionPrefs';

/**
 * Effective reduced motion: Settings → Accessibility → Reduce motion
 * (System follows the OS `prefers-reduced-motion`; On / Off override it).
 * See utils/a11y/motionPrefs.ts.
 */
export function usePrefersReducedMotion(): boolean {
    return useReducedMotionSetting();
}
