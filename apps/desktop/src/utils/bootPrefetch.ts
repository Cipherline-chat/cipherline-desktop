import { whenIdle } from './idleTasks';
import { prefetchEmojiPicker } from '../components/emojiSearch';
import { prefetchRnnoiseSources } from './rnnoiseSources';

/**
 * Warm the code that was split out of the startup bundle, AFTER the app is up.
 *
 * The emoji picker / emoji dataset and the RNNoise worklet sources no longer
 * load before first paint (see emojiSearch.ts / emojiPickerLazy.tsx,
 * rnnoiseSources.ts). So
 * that splitting them out never costs the user anything — no blank picker on
 * first open, no extra delay when joining the first call — each one is loaded
 * here in its own idle slot once startup has settled: one at a time, never
 * competing with the first data loads or the user's first clicks.
 */
const START_DELAY_MS = 4000;
const GAP_MS = 1500;

let scheduled = false;

export function scheduleBootPrefetch(): void {
    if (scheduled) return;
    scheduled = true;
    const steps: Array<() => void> = [prefetchEmojiPicker, prefetchRnnoiseSources];
    const next = (i: number) => {
        if (i >= steps.length) return;
        whenIdle(() => {
            try { steps[i](); } catch { /* prefetch is best-effort */ }
            setTimeout(() => next(i + 1), GAP_MS);
        }, 10_000);
    };
    setTimeout(() => next(0), START_DELAY_MS);
}
