/**
 * The designed card picture on the RECEIVER (2026-11-24, embeds-always-thumb):
 * for a preview with no picture (a message from before "always a thumbnail",
 * or from an older app), or one whose picture turned out to be one flat colour
 * (Medal's black first frame), draw the same designed picture the sender's app
 * would have (utils/linkEmbeds/designedThumb.ts). Local only: drawn from the
 * embed's own text and, on a card, the site icon already decrypted from the
 * message. No request of any kind.
 */
import { useEffect, useMemo, useState } from 'react';
import { designedPictureUrl } from '../../utils/linkEmbeds/designedThumb';
import { isFlatPicture, statsOf } from '../../utils/linkEmbeds/thumb';

export interface DesignedSpecInput {
    label: string;
    color?: string;
    play?: boolean;
    /** The site's icon (a data: / blob: URL from the message), drawn on the tile once decoded. */
    iconUrl?: string | null;
}

/** The designed picture's data: URL for `spec` (null = none wanted, or no canvas here). */
export function useDesignedPicture(spec: DesignedSpecInput | null): string | null {
    const label = spec?.label ?? '';
    const color = spec?.color;
    const play = !!spec?.play;
    const iconUrl = spec?.iconUrl ?? null;
    const wanted = !!spec;
    const [icon, setIcon] = useState<{ url: string; img: HTMLImageElement } | null>(null);
    useEffect(() => {
        if (!wanted || !iconUrl || typeof Image === 'undefined') return;
        let cancelled = false;
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => { if (!cancelled) setIcon({ url: iconUrl, img }); };
        img.src = iconUrl;
        return () => { cancelled = true; };
    }, [wanted, iconUrl]);
    const loadedIcon = icon && icon.url === iconUrl ? icon.img : null;
    return useMemo(
        () => (wanted ? designedPictureUrl({ label, color, play, icon: loadedIcon }, loadedIcon ? iconUrl ?? '' : '') : null),
        [wanted, label, color, play, loadedIcon, iconUrl],
    );
}

/** Is a decoded <img> one flat colour / near-black (a black first frame)? False when it cannot be read. */
export function imageLooksFlat(img: HTMLImageElement): boolean {
    const s = statsOf(img);
    return !!s && isFlatPicture(s);
}
