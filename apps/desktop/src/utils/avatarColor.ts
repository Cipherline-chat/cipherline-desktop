/**
 * Deterministic default-avatar colors.
 *
 * Every user without a profile picture gets one of these colors, chosen
 * deterministically from their user_id via a fast string hash. Same user →
 * same color, on every device, forever. This mirrors the Discord / Slack
 * approach and lets people visually identify avatar-less friends at a glance.
 */

/**
 * 10 tasteful, visually distinct colors. Ordered so adjacent palette entries
 * differ enough in hue that hash collisions on similar user_ids still land on
 * perceptibly different colors.
 */
export const AVATAR_PALETTE: readonly string[] = [
    '#5865F2', // indigo
    '#EB459E', // pink
    '#ED4245', // red
    '#F0B232', // amber
    '#57F287', // green
    '#5CDBF0', // cyan
    '#9B84EC', // lavender
    '#FF8C42', // orange
    '#3BA55D', // emerald
    '#E91E63', // rose
] as const;

/**
 * Deterministic index 0..N-1 from any string. Pure function, no randomness.
 * Uses the classic `h * 31 + char` string hash with Math.imul for consistent
 * 32-bit multiplication across JS engines. 10 buckets is plenty — we don't
 * need cryptographic hash quality here.
 */
export function userColorIndex(id: string): number {
    let h = 0;
    for (let i = 0; i < id.length; i++) {
        h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
    }
    return Math.abs(h) % AVATAR_PALETTE.length;
}

/** The user's deterministic avatar color (hex string). */
export function userColor(id: string): string {
    return AVATAR_PALETTE[userColorIndex(id)];
}

/**
 * Readable icon color (`'#000'` or `'#fff'`) for a given background hex.
 * Uses the classic YIQ perceived-brightness formula; threshold 160/255 gives:
 *   indigo, pink, red, lavender, emerald, rose → white icon
 *   amber, green, cyan, orange                 → black icon
 * which matches how those colors actually read on screen.
 */
export function iconColorForBackground(hex: string): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 160 ? '#000000' : '#ffffff';
}

/** Readable icon color for the user's own avatar color. */
export function userIconColor(id: string): string {
    return iconColorForBackground(userColor(id));
}
