/* eslint-disable -- visual harness, not shipped */
// In-memory stand-in for hooks/useEncryptedAvatar: attachment ids that start with "img-"
// resolve instantly to an inline SVG picture; everything else resolves to null (the
// component's own silhouette / group fallback). No network, no decrypt.
const COLOURS: Record<string, [string, string]> = {
    'img-mira': ['#ff8a5c', '#ffd166'],
    'img-crew': ['#6c8cff', '#25e0c8'],
    'img-me': ['#b388ff', '#ff6b9d'],
};
export function useEncryptedAvatar(attachmentId: string | null | undefined): string | null {
    if (!attachmentId || !attachmentId.startsWith('img-')) return null;
    const [a, b] = COLOURS[attachmentId] ?? ['#888', '#ccc'];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><circle cx="32" cy="26" r="11" fill="rgba(255,255,255,.85)"/><path d="M10 64c2-14 12-20 22-20s20 6 22 20z" fill="rgba(255,255,255,.85)"/></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
export function evictAvatar(): void {}
export function peekAvatarUrl(): string | null { return null; }
export async function preloadAvatar(): Promise<void> {}
export async function preloadAvatars(): Promise<void> {}
export async function loadAvatarToCache(): Promise<null> { return null; }
export function avatarCacheStats() { return { entries: 0, bytes: 0 }; }
export function __resetAvatarCaches(): void {}
export function warmAvatarsFromDiskCache(): void {}
export function preloadAvatarsBackground(): void {}
