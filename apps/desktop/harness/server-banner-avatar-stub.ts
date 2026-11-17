/* eslint-disable -- visual harness, not shipped */
// useEncryptedAvatar stand-in for the server-banner-preview harness: ids starting "banner-" resolve to a
// 1200x480 (2.5:1, = BANNER_OUTPUT) test card whose four edges are labelled, so any re-crop of the preview
// shows up as a missing edge label. Everything else defers to the shared portrait stub.
export * from './new-message-avatar-stub';
import { useEncryptedAvatar as portrait } from './new-message-avatar-stub';
const BANNER = (() => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="480" viewBox="0 0 1200 480">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b5876"/><stop offset=".55" stop-color="#4e4376"/><stop offset="1" stop-color="#d76d77"/></linearGradient></defs>
<rect width="1200" height="480" fill="url(#g)"/>
<path d="M0 360 L180 250 L330 330 L520 180 L700 320 L880 220 L1040 300 L1200 230 L1200 480 L0 480 Z" fill="#0b0f1e" opacity=".55"/>
<circle cx="940" cy="130" r="58" fill="#ffd166" opacity=".9"/>
<rect x="6" y="6" width="1188" height="468" fill="none" stroke="#25E0C8" stroke-width="12"/>
<g font-family="sans-serif" font-weight="700" font-size="34" fill="#fff">
<text x="600" y="58" text-anchor="middle">TOP EDGE</text><text x="600" y="452" text-anchor="middle">BOTTOM EDGE</text>
<text x="34" y="252">LEFT</text><text x="1166" y="252" text-anchor="end">RIGHT</text></g></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
})();
export function useEncryptedAvatar(attachmentId: string | null | undefined, ...rest: any[]): string | null {
    if (attachmentId && attachmentId.startsWith('banner-')) return BANNER;
    return (portrait as any)(attachmentId, ...rest);
}
export const avatarUrlMime = (url: string | null | undefined): string | null => {
    const m = url ? /^data:([^;,]+)/i.exec(url) : null;
    return m ? m[1].toLowerCase() : null;
};
