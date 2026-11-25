/**
 * The visible link card (the no-image Tile: the host, its letter, the link's
 * path), built from the link alone with no request. It is what a link shows
 * when it has no richer embed, AND what any media embed falls back to when its
 * media fails, is blocked or expired (2026-11-24, embeds-media-everywhere):
 * an embed never collapses to nothing, so a message is never an empty row.
 * `reason` adds one quiet line ("Couldn't load this image").
 */
import React, { useMemo } from 'react';
import type { LinkEmbed } from '@cipherline/shared';
import { useEmbedLayout } from '../../utils/embedPrefs';
import { WebEmbedCard } from './WebEmbedCard';

export const LinkFallbackCard: React.FC<{ url: string; reason?: string; site?: string }> = ({ url, reason, site: siteProp }) => {
    const layout = useEmbedLayout();
    const embed = useMemo<LinkEmbed>(() => {
        let site = siteProp ?? url;
        if (!siteProp) { try { site = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep the url */ } }
        return { url, kind: 'card', site, ...(reason ? { description: reason } : {}) };
    }, [url, reason, siteProp]);
    return (
        <div data-embed-fallback={reason ? 'failed' : 'link'} style={{ display: 'contents' }}>
            <WebEmbedCard embed={embed} layout={layout} />
        </div>
    );
};
