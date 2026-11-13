/* eslint-disable -- harness stub, not shipped */
// Stand-in for utils/integrations/listeningArt in the friends-activity harness: a made-up album
// cover for one ref, no network.
const svg = (s: string) => `data:image/svg+xml;utf8,${encodeURIComponent(s)}`;
const COVER = svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b0f2e"/><stop offset="1" stop-color="#4b1d3f"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><circle cx="32" cy="30" r="15" fill="none" stroke="#ff9f6b" stroke-width="2.5"/><circle cx="32" cy="30" r="6" fill="#ffd27a"/><path d="M0 52 Q16 44 32 52 T64 50 V64 H0Z" fill="#0d0718"/></svg>`);
export const HARNESS_COVER_REF = 'spotify:i:ab67616d0000b273aaaaaaaaaaaaaaaaaaaaaaaa';
export function useListeningArt(userId: string | null | undefined, ref: string | null | undefined): string | null {
    return userId && ref === HARNESS_COVER_REF ? COVER : null;
}
export function setListeningArtToken(): void {}
export async function fetchListeningArt(): Promise<null> { return null; }
export function sniffCover(): null { return null; }
export function __resetListeningArt(): void {}
