/* eslint-disable -- visual harness, not shipped */
// In-memory stand-in for hooks/useEncryptedAvatar in the animated-art harness: an attachment id
// resolves to the blob URL registered in window.__art (the page fetches real animated files and
// registers them), with the file's MIME - exactly what the real hook hands ServerIcon after decrypt.
declare global { interface Window { __art?: Record<string, { url: string; mime: string }> } }
const mimeByUrl = new Map<string, string>();
export function useEncryptedAvatar(attachmentId: string | null | undefined): string | null {
    const art = attachmentId ? window.__art?.[attachmentId] : undefined;
    if (!art) return null;
    mimeByUrl.set(art.url, art.mime);
    return art.url;
}
export const avatarUrlMime = (url: string | null | undefined): string | null => (url ? mimeByUrl.get(url) ?? null : null);
export function evictAvatar(): void {}
export function peekAvatarUrl(): string | null { return null; }
export async function preloadAvatar(): Promise<void> {}
export async function preloadAvatars(): Promise<void> {}
export async function loadAvatarToCache(): Promise<null> { return null; }
export function avatarCacheStats() { return { entries: 0, bytes: 0 }; }
export function __resetAvatarCaches(): void {}
export function warmAvatarsFromDiskCache(): void {}
export function preloadAvatarsBackground(): void {}
