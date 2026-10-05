/**
 * Pure decision logic for the render-process-gone crash-loop guard (main.ts).
 * Kept as a separate, isolated function so a crash-recovery bug is easy to
 * spot on review even though electron/ has no automated test harness in
 * this repo (main.ts is compiled locally via tsc, not covered by
 * `npx vitest run`).
 *
 * Mutates `timestamps` in place: prunes entries older than `windowMs`, then
 * appends `now`. Returns true once more than `threshold` crashes have
 * landed inside the trailing `windowMs` window — i.e. give up on
 * auto-reload and fall back to the manual-restart dialog instead of
 * potentially reload-looping forever on a crash-on-load bug.
 */
export function shouldGiveUpOnCrashLoop(
  timestamps: number[],
  now: number,
  windowMs: number,
  threshold: number,
): boolean {
  while (timestamps.length > 0 && now - timestamps[0] > windowMs) {
    timestamps.shift();
  }
  timestamps.push(now);
  return timestamps.length > threshold;
}
