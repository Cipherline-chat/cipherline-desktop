import React from 'react';
import { useArt } from '../../hooks/useIntegrations';
import { safeImageSrc } from '../../utils/safeMediaUrl';

/**
 * A third-party image (game capsule, cover) by art REF, loaded through our API
 * (hooks/useIntegrations.ts) - never from the third party's CDN. Shows a quiet
 * placeholder while loading and `fallback` when there is no image.
 */
export const IntegrationArt: React.FC<{
    refs: ReadonlyArray<string | null | undefined> | string | null | undefined;
    token: string | null;
    className?: string;
    fallback?: React.ReactNode;
    /** A local data: URI to use instead (your own cover, read on this device). */
    src?: string | null;
}> = ({ refs, token, className, fallback = null, src }) => {
    const fetched = useArt(src ? null : refs, token);
    const url = safeImageSrc(src ?? fetched ?? null);
    return (
        <span className={['ig-art', className ?? ''].filter(Boolean).join(' ')} data-state={url ? 'ready' : fetched === undefined && !src ? 'loading' : 'empty'}>
            {url ? <img src={url} alt="" draggable={false} /> : fallback}
        </span>
    );
};

export default IntegrationArt;
