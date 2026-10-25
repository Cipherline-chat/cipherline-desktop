import React, { useId, useState } from 'react';
import { ChevronDown, ExternalLink, ListMusic } from 'lucide-react';
import { ProfileLinkIcon } from '../ProfileLinkIcon';
import { IntegrationArt } from './IntegrationArt';
import { openExternalLink } from '../../utils/openExternalLink';
import { spotifyItemUrl, type SpotifyItem } from '../../utils/integrations/api';

/**
 * The Spotify showcase: up to three public playlists / albums the owner picked.
 * Each is a row (cover, title, kind); pressing one opens a little window under
 * it - the cover large with the record sliding out of its sleeve, and "Open in
 * Spotify". One open at a time. Title and cover come from Spotify's public
 * oEmbed via our API; the cover through our art proxy; the link is built from
 * the validated id and opened through the safe external-link path.
 */
export const SpotifyShowcase: React.FC<{
    items: readonly SpotifyItem[];
    token: string | null;
    className?: string;
    /** Start with this item open (the Settings preview, screenshots). */
    defaultOpenId?: string | null;
}> = ({ items, token, className, defaultOpenId = null }) => {
    const [open, setOpen] = useState<string | null>(defaultOpenId);
    const base = useId();
    if (items.length === 0) return null;
    return (
        <ul className={['ig-sp', className ?? ''].filter(Boolean).join(' ')} aria-label="Spotify playlists" data-testid="spotify-showcase">
            {items.map((it) => {
                const isOpen = open === it.id;
                const panelId = `${base}-${it.id}`;
                const kind = it.kind === 'album' ? 'Album' : 'Playlist';
                return (
                    <li key={`${it.kind}:${it.id}`} className="ig-sp-item" data-open={isOpen ? 'true' : undefined}>
                        <button
                            type="button" className="ig-sp-row" aria-expanded={isOpen} aria-controls={panelId}
                            onClick={(e) => { e.stopPropagation(); setOpen(isOpen ? null : it.id); }}
                        >
                            <IntegrationArt refs={it.cover} token={token} className="ig-sp-cover" fallback={<ListMusic size={18} aria-hidden="true" />} />
                            <span className="ig-sp-txt">
                                <b>{it.title}</b>
                                <span>{kind} on Spotify</span>
                            </span>
                            <ChevronDown size={16} className="ig-sp-chev" aria-hidden="true" />
                        </button>
                        {isOpen && (
                            <div className="ig-sp-window" id={panelId} role="region" aria-label={`${it.title}, ${kind.toLowerCase()}`}>
                                <span className="ig-sp-sleeve">
                                    <span className="ig-sp-disc" aria-hidden="true" />
                                    <IntegrationArt refs={it.cover} token={token} className="ig-sp-big" fallback={<ListMusic size={28} aria-hidden="true" />} />
                                </span>
                                <span className="ig-sp-info">
                                    <span className="ig-sp-kind"><ProfileLinkIcon platform="spotify" size={13} />{kind}</span>
                                    <b className="ig-sp-title">{it.title}</b>
                                    <button type="button" className="ig-sp-open"
                                        onClick={(e) => { e.stopPropagation(); openExternalLink(spotifyItemUrl(it)); }}>
                                        Open in Spotify <ExternalLink size={13} aria-hidden="true" />
                                    </button>
                                </span>
                            </div>
                        )}
                    </li>
                );
            })}
        </ul>
    );
};

export default SpotifyShowcase;
