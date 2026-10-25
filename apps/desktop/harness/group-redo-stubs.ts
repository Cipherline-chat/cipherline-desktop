/* eslint-disable -- harness stubs, not shipped */
// Stand-ins used ONLY by the group-redo harness (see group-redo.vite.config.ts).
const q = new URLSearchParams(location.search);

// ── contexts/AuthContext ──
export const useAuth = () => ({
    token: 'harness-token', userId: 'me', deviceId: 'dev-1',
    user: { user_id: 'me', username: 'Dawson', avatar_url: null },
});
export const AuthProvider = ({ children }: { children: unknown }) => children as any;

// ── contexts/ToastContext ──
export const useToast = () => ({ push: (t: unknown) => { ((window as any).__toasts ||= []).push(t); } });

// ── hooks/useAttachments, hooks/useAvatarBroadcast, utils/avatarKeyStore ──
export const useAttachments = () => ({
    uploadEncryptedFile: async () => ({ attachmentId: 'img-new', keyB64: 'a', nonceB64: 'b' }),
});
export const useAvatarBroadcast = () => ({ broadcastGroupAvatarKey: async () => {} });
export const saveAvatarKey = async () => {};

// ── hooks/useEncryptedAvatar: ids start "img-"; colourful / bright pictures as inline SVG ──
const svgUrl = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
const PICS: Record<string, string> = {
    // saturated, busy, mid-bright
    'img-colorful': svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff5fa2"/><stop offset=".5" stop-color="#ffb347"/><stop offset="1" stop-color="#2dd4bf"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/><circle cx="110" cy="120" r="90" fill="#7c3aed" opacity=".85"/><circle cx="300" cy="90" r="60" fill="#fde047"/><circle cx="270" cy="300" r="110" fill="#38bdf8" opacity=".9"/><rect x="40" y="280" width="140" height="90" rx="20" fill="#f43f5e"/></svg>`),
    // worst case: essentially pure white with faint tints
    'img-bright': svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#ffffff"/><circle cx="120" cy="140" r="130" fill="#fffbe6"/><circle cx="290" cy="270" r="120" fill="#f0fdff"/></svg>`),
};
export function useEncryptedAvatar(attachmentId: string | null | undefined): string | null {
    if (!attachmentId) return null;
    if (attachmentId.startsWith('blob:') || attachmentId.startsWith('data:')) return attachmentId;
    if (q.get('stall') === '1') return null; // never resolves: the "still loading" look
    return PICS[attachmentId] ?? null;
}
export function evictAvatar(): void {}
export function peekAvatarUrl(): string | null { return null; }
export async function preloadAvatar(): Promise<void> {}
export async function preloadAvatars(): Promise<void> {}
export async function loadAvatarToCache(): Promise<null> { return null; }
export function avatarCacheStats() { return { entries: 0, bytes: 0 }; }
export function __resetAvatarCaches(): void {}
export async function warmAvatarsFromDiskCache(): Promise<number> { return 0; }
