/**
 * Helpers for enlarging an embed's picture (EmbedPictureViewer.tsx, §11).
 *
 * Only pictures already on this device may be shown: the sender's re-encoded
 * copy, decrypted here (a blob: URL), or inline in the message (a data: URL).
 * An inline one is turned into a blob: URL by decoding it locally (no fetch),
 * so the viewer's Save works for it too.
 */
import type React from 'react';
import { base64ToBytes } from '../../utils/linkEmbeds/thumb';

const DATA_IMAGE = /^data:(image\/(?:webp|jpeg|png|gif));base64,([A-Za-z0-9+/=]+)$/;

/** A local object URL for an inline `data:image/...;base64,` picture (no fetch), else null. */
export function objectUrlForDataImage(src: string): string | null {
    const m = DATA_IMAGE.exec(src);
    if (!m) return null;
    try {
        const bytes = base64ToBytes(m[2]);
        return URL.createObjectURL(new Blob([bytes as BlobPart], { type: m[1] }));
    } catch {
        return null;
    }
}

/** A blob: URL, or an inline data: image: nothing that could make a request. */
export function isLocalPicture(src: string | null | undefined): src is string {
    return typeof src === 'string' && (src.startsWith('blob:') || DATA_IMAGE.test(src));
}

/** Props that make a picture element open the viewer by click, Enter or Space. */
export function pictureOpenProps(label: string, open: () => void) {
    return {
        role: 'button' as const,
        tabIndex: 0,
        'aria-label': label,
        'data-picture-open': 'true',
        onClick: (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); open(); },
        onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); open(); }
        },
    };
}

/** "<host>-picture.webp" for Save. */
export function pictureFilename(url: string, mime: string | undefined, what = 'picture'): string {
    let host = 'link';
    try { host = new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '') || 'link'; } catch { /* keep */ }
    const ext = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : mime === 'image/gif' ? 'gif' : 'webp';
    return `${host}-${what}.${ext}`;
}
