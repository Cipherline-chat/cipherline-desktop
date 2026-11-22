import { reducedMotionNow } from './a11y/motionPrefs';

/** Effective reduced motion right now (in-app setting, else the OS). */
export const prefersReducedMotion = (): boolean => reducedMotionNow();
