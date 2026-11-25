/**
 * Click a picture in an embed to enlarge it (docs/plans/embeds.md §11, owner
 * 2026-11-24: "if there's an image in the embed if you click the image it
 * enlarges it"): web card pictures, page snapshots, X / Reddit post pictures.
 *
 * It opens the app's own image viewer (ImageLightbox, the one attachments and
 * linked images use: zoom, drag, Copy image, "Open original", Save).
 *
 * The picture is the SENDER's re-encoded copy, already decrypted on this device
 * (useEmbedThumb: a blob: URL for an encrypted attachment, a data: URL for an
 * inline one). The viewer shows exactly those bytes: an inline data: picture is
 * turned into a blob: URL here (decoded locally, no fetch) so Save works for it
 * too, and any other kind of source is refused, so opening the viewer can never
 * make a request to the linked site. "Open original" opens the PAGE (or post)
 * link through the shared external-link helper (utils/openExternalLink).
 */
import React, { useEffect, useMemo } from 'react';
import { ImageLightbox } from '../ImageLightbox';
import { objectUrlForDataImage } from './embedPicture';

export interface EmbedPictureViewerProps {
    /** The decrypted picture (blob: or inline data:). */
    src: string;
    /** The page / post the picture belongs to: "Open original". */
    pageUrl: string;
    filename: string;
    onClose: () => void;
}

export const EmbedPictureViewer: React.FC<EmbedPictureViewerProps> = ({ src, pageUrl, filename, onClose }) => {
    const made = useMemo(() => (src.startsWith('data:') ? objectUrlForDataImage(src) : null), [src]);
    useEffect(() => () => { if (made) URL.revokeObjectURL(made); }, [made]);
    const shown = src.startsWith('blob:') ? src : made;
    if (!shown) return null;
    return <ImageLightbox src={shown} externalUrl={pageUrl} filename={filename} onClose={onClose} />;
};
