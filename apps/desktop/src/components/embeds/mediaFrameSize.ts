/**
 * Whole seconds → `m:ss` or `h:mm:ss` (duration badge, "Starts at").
 * (The embed box sizes moved to mediaSize.ts: size follows the media, §11.)
 */
export function formatClock(totalSeconds: number): string {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
