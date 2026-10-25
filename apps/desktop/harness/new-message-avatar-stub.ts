/* eslint-disable -- visual harness, not shipped */
// In-memory stand-in for hooks/useEncryptedAvatar (new-message harness only): attachment ids
// that start with "img-" resolve instantly to an inline SVG portrait; everything else resolves
// to null, so the component draws its own silhouette fallback — exactly what a friend with no
// photo looks like in the app. No network, no decrypt.
const PALETTE: Record<string, [string, string, string]> = {
    'img-me':    ['#b388ff', '#ff6b9d', '#3a1d52'],
    'img-mira':  ['#ff8a5c', '#ffd166', '#5a2a12'],
    'img-jun':   ['#3a7bd5', '#00d2ff', '#0b2540'],
    'img-sana':  ['#f857a6', '#ff5858', '#4a0f24'],
    'img-okoye': ['#11998e', '#38ef7d', '#0b3326'],
    'img-elena': ['#c471f5', '#fa71cd', '#3b1550'],
    'img-kenji': ['#f7971e', '#ffd200', '#4a2c05'],
    'img-zara':  ['#43cea2', '#185a9d', '#0e2a3a'],
    'img-marco': ['#ee0979', '#ff6a00', '#4a0a1c'],
};
export function useEncryptedAvatar(attachmentId: string | null | undefined): string | null {
    if (!attachmentId || !attachmentId.startsWith('img-')) return null;
    const [a, b, ink] = PALETTE[attachmentId] ?? ['#888', '#ccc', '#222'];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><circle cx="32" cy="27" r="12" fill="${ink}" opacity=".78"/><path d="M8 64c3-15 13-22 24-22s21 7 24 22z" fill="${ink}" opacity=".78"/><circle cx="18" cy="12" r="18" fill="#fff" opacity=".12"/></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
export function evictAvatar(): void {}
export function peekAvatarUrl(): string | null { return null; }
export async function preloadAvatar(): Promise<void> {}
export async function preloadAvatars(): Promise<void> {}
export async function loadAvatarToCache(): Promise<null> { return null; }
export function avatarCacheStats() { return { entries: 0, bytes: 0 }; }
export function __resetAvatarCaches(): void {}
export async function warmAvatarsFromDiskCache(): Promise<number> { return 0; }
export async function preloadAvatarsBackground(): Promise<void> {}
export const __preloadTuning = {};
export function __preloadInFlightCount(): number { return 0; }
export function __warmNetworkClaims(): number { return 0; }
