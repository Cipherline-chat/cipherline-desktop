/**
 * The link previews being built for the message in the composer
 * (hooks/useComposerEmbeds.ts), shown just above it: a small thumbnail, the
 * title and site, and an × to drop that preview from this message. A preview
 * still building shows a spinner, and so does one whose better picture (a
 * frame of its video, a page snapshot) is being made while it only has the
 * designed one (useComposerEmbeds); one that found nothing shows nothing.
 */
import React from 'react';
import { X, Link as LinkIcon } from 'lucide-react';
import type { ComposerEmbeds } from '../../hooks/useComposerEmbeds';
import '../../styles/sender-embeds.css';

const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

export const ComposerEmbedPreviews: React.FC<{ embeds: ComposerEmbeds }> = ({ embeds }) => {
    if (embeds.items.length === 0) return null;
    return (
        <div className="cl-cep" role="list" aria-label="Link previews for this message">
            {embeds.items.map((it) => {
                const e = it.prepared?.embed;
                // A tweet has no title: its author and words stand in.
                const title = e?.title || (e?.author ? (e.description ? `${e.author}: ${e.description}` : e.author) : hostOf(it.url));
                const site = e?.site || hostOf(it.url);
                // A card whose only picture is its site's icon (a favicon): shown whole, not cropped.
                const p = it.prepared;
                const iconOnly = !!p?.icon && !p.thumb && !p.images?.length && e?.kind === 'card';
                // No picture of its own (none, or only the designed one) while a frame / snapshot is being made: the picture is coming.
                const snapping = !!it.snapshotting && (!p?.thumb || !!p.thumb.designed);
                return (
                    <div key={it.url} className="cl-cep-item" role="listitem" data-status={it.status} data-snapshot={snapping ? 'taking' : p?.snapshotResult} title={it.url}>
                        <span className={`cl-cep-pic${iconOnly && !snapping ? ' cl-cep-pic--icon' : ''}`} aria-hidden="true">
                            {it.status === 'loading' || snapping ? <span className="cl-cep-spin" />
                                : it.previewUrl ? <img src={it.previewUrl} alt="" draggable={false} />
                                : <LinkIcon size={14} style={{ color: 'var(--cl-faint)' }} />}
                        </span>
                        <span className="cl-cep-text">
                            <span className="cl-cep-title">{it.status === 'loading' ? 'Building preview…' : title}</span>
                            <span className="cl-cep-site">{site}</span>
                        </span>
                        <button type="button" className="cl-cep-x" aria-label={`Don't include a preview of ${hostOf(it.url)}`}
                            title="Remove preview" onClick={() => embeds.dismiss(it.url)}>
                            <X />
                        </button>
                    </div>
                );
            })}
        </div>
    );
};
