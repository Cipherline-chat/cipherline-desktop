/** Pure helpers for RoleIconPicker (kept out of the component so tests need
 *  no axios / DOM). */
export const ROLE_ICON_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const ROLE_ICON_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/** A readable reason for a failed icon request. Exported for tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / Error); fields are read defensively
export function roleIconErrorMessage(e: any): string {
    const status = e?.response?.status;
    const data = e?.response?.data;
    const code = data?.code ?? data?.message?.code;
    if (code === 'EMOJI_INVALID_IMAGE') return "That file isn't an image we can use. Try a PNG, JPEG, WebP or GIF.";
    if (code === 'EMOJI_TOO_LARGE') return 'That image is too large, even after resizing. Try a smaller or shorter one.';
    if (status === 429) return 'Too many changes at once. Wait a few seconds and try again.';
    if (status === 403) return "You can't edit this role. It must be below your highest role.";
    const msg = typeof data?.message === 'string' ? data.message : null;
    return msg ?? 'Could not update the role icon. Check your connection and try again.';
}

/** Client-side pre-check (the server re-checks both). Exported for tests. */
export function roleIconFileError(file: { type: string; size: number }): string | null {
    if (!(ROLE_ICON_MIMES as readonly string[]).includes(file.type)) return 'Pick a PNG, JPEG, WebP or GIF image.';
    if (file.size > ROLE_ICON_MAX_UPLOAD_BYTES) return 'That image is over 5 MB. Pick a smaller one.';
    if (file.size === 0) return 'That file is empty.';
    return null;
}
