/**
 * A received (or sent) `klipy_gif` message.
 *
 * The payload is a REFERENCE to a KLIPY rendition; the media is loaded
 * straight from KLIPY's CDN by this client. Two rules make that safe:
 *
 *   1. The payload is re-validated here (`parseKlipyGifRef`) — the sender is
 *      untrusted and chose the URL. Anything not on the exact KLIPY media-host
 *      allowlist renders as "couldn't be shown" and loads NOTHING, so a GIF
 *      message can never be used as a tracking pixel.
 *   2. Nothing loads for someone who has not opted in to KLIPY. They get a
 *      "GIF from KLIPY — tap to load" card; a tap loads this one GIF once, and
 *      "Always load KLIPY GIFs" turns the setting on.
 *
 * Playback goes through GifPlayer: it respects the "autoplay GIFs" setting
 * and the OS reduced-motion preference (frozen until hovered).
 */

import React, { useCallback, useState, useSyncExternalStore } from 'react';
import { Bookmark, ImageIcon, RotateCw } from 'lucide-react';
import { parseKlipyGifRef, isKlipyMediaUrl } from '@cipherline/shared';
import { GifPlayer } from './GifPlayer';
import { ImageLightbox } from './ImageLightbox';
import { useGifSettings, updateGifSettings } from '../hooks/useGifSettings';
import {
    addKlipyFavorite,
    findKlipyFavorite,
    loadFavorites,
    removeFavorite,
    GIF_LIBRARY_CHANGED,
} from '../utils/gifStorage';
import {
    klipyDisplaySize,
    klipyEmbedMode,
    KLIPY_ALWAYS_LOAD_TEXT,
    KLIPY_TAP_TO_LOAD_TEXT,
} from '../utils/klipy';

function subscribeLibrary(onChange: () => void): () => void {
    window.addEventListener(GIF_LIBRARY_CHANGED, onChange);
    return () => window.removeEventListener(GIF_LIBRARY_CHANGED, onChange);
}

/** Is this slug in the saved library? Live across saves from anywhere. */
function useSavedKlipy(slug: string | undefined): boolean {
    const read = useCallback(() => (slug ? !!findKlipyFavorite(loadFavorites(), slug) : false), [slug]);
    return useSyncExternalStore(subscribeLibrary, read, () => false);
}

interface Props {
    /** The stored message content — validated here, not trusted. */
    content: unknown;
}

export const KlipyGifEmbed: React.FC<Props> = ({ content }) => {
    const ref = parseKlipyGifRef(content);
    const { settings: { klipyEnabled } } = useGifSettings();
    const [tapped, setTapped] = useState(false);
    const [failed, setFailed] = useState(false);
    const [lightboxOpen, setLightboxOpen] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const saved = useSavedKlipy(ref?.slug);
    const mode = klipyEmbedMode(ref, klipyEnabled, tapped);

    if (mode === 'invalid' || !ref) {
        return (
            <span className="inline-flex items-center gap-1.5 text-[12px] text-cl-faint italic" role="note">
                <ImageIcon className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
                This GIF couldn’t be shown.
            </span>
        );
    }

    const box = klipyDisplaySize(ref.media.width, ref.media.height);
    const alt = ref.title ? `${ref.title} (GIF from KLIPY)` : 'GIF from KLIPY';

    const toggleSave = (e: React.MouseEvent) => {
        e.stopPropagation();
        try {
            if (saved) {
                const fav = findKlipyFavorite(loadFavorites(), ref.slug);
                if (fav) void removeFavorite(fav.id);
            } else {
                // A reference only — no bytes are fetched or stored.
                addKlipyFavorite(ref);
            }
        } catch (err) {
            console.warn('[KlipyGifEmbed] save failed', (err as Error)?.message);
        }
    };

    if (mode === 'placeholder') {
        return (
            <div className="mt-1 klipy-embed" style={{ width: Math.max(box.width, 200), maxWidth: '100%' }}>
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setTapped(true); }}
                    aria-label={`${KLIPY_TAP_TO_LOAD_TEXT}${ref.title ? `: ${ref.title}` : ''}`}
                    title="Loads this GIF from KLIPY's servers. KLIPY will see your IP address."
                    style={{
                        width: '100%', height: Math.max(Math.min(box.height, 160), 96), borderRadius: 10,
                        background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)',
                        display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', justifyContent: 'center',
                        cursor: 'pointer', color: 'rgba(255,255,255,0.65)',
                    }}
                >
                    <ImageIcon className="w-5 h-5 text-white/40" aria-hidden="true" />
                    <span style={{ fontSize: 12.5 }}>{KLIPY_TAP_TO_LOAD_TEXT}</span>
                    {ref.title && (
                        <span style={{ fontSize: 10.5, opacity: 0.55, maxWidth: '90%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {ref.title}
                        </span>
                    )}
                </button>
                <button
                    type="button"
                    className="klipy-always-btn"
                    onClick={(e) => { e.stopPropagation(); updateGifSettings({ klipyEnabled: true }); }}
                    title="Turns on KLIPY for GIFs in chat and GIF search. Change it any time in Settings → Privacy & Safety."
                    style={{
                        all: 'unset', cursor: 'pointer', marginTop: 4, fontSize: 11,
                        color: 'rgba(37,224,200,0.85)', textDecoration: 'underline',
                    }}
                >
                    {KLIPY_ALWAYS_LOAD_TEXT}
                </button>
            </div>
        );
    }

    if (failed) {
        return (
            <div className="mt-1" style={{
                width: box.width, maxWidth: '100%', height: Math.min(box.height, 140), minHeight: 80, borderRadius: 10,
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)',
                display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', justifyContent: 'center',
                color: 'rgba(255,255,255,0.5)', fontSize: 12,
            }}>
                <span>Couldn’t load this GIF from KLIPY.</span>
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setFailed(false); setAttempt(a => a + 1); }}
                    style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, color: 'rgba(37,224,200,0.85)', fontSize: 11.5 }}
                >
                    <RotateCw style={{ width: 11, height: 11 }} aria-hidden="true" /> Retry
                </button>
            </div>
        );
    }

    return (
        <div className="mt-1 klipy-embed img-link-wrap" style={{ position: 'relative', display: 'inline-block', width: 'fit-content', alignSelf: 'flex-start', maxWidth: '100%' }}>
            <GifPlayer
                key={attempt}
                src={ref.media.url}
                alt={alt}
                referrerPolicy="no-referrer"
                onError={() => setFailed(true)}
                imgStyle={{ width: box.width, height: box.height, maxWidth: '100%', objectFit: 'contain', borderRadius: 10, display: 'block', cursor: 'zoom-in' }}
                onClick={(e) => { e.stopPropagation(); setLightboxOpen(true); }}
            />
            {lightboxOpen && (
                <ImageLightbox
                    src={ref.media.url}
                    alt={alt}
                    filename={ref.title || 'KLIPY GIF'}
                    referrerPolicy="no-referrer"
                    onClose={() => setLightboxOpen(false)}
                />
            )}
            <button
                type="button"
                onClick={toggleSave}
                title={saved ? 'Remove from favorites' : 'Favorite GIF'}
                aria-label={saved ? 'Remove from favorites' : 'Favorite GIF'}
                aria-pressed={saved}
                className={`img-gif-save-btn${saved ? ' saved' : ''}`}
            >
                <Bookmark style={{ width: 13, height: 13, fill: saved ? 'currentColor' : 'none' }} />
            </button>
        </div>
    );
};

/**
 * A pasted KLIPY media link (an https link to one of KLIPY's media hosts, ending .gif or .webp) in a text
 * message. It is NOT routed through the generic image-link path: that fetches
 * the bytes via the main process and offers to store them in the GIF library,
 * which KLIPY's terms don't allow, and it treated KLIPY like an unknown host
 * (click-to-load every time). This one follows the same rules as a sent
 * `klipy_gif`: nothing loads until the viewer has opted in to KLIPY (or taps
 * this one GIF), it loads straight from KLIPY with no referrer, and there is no
 * save button — a bare link has no KLIPY id to keep as a reference.
 */
export const KlipyLinkEmbed: React.FC<{ url: string }> = ({ url }) => {
    const { settings: { klipyEnabled } } = useGifSettings();
    const [tapped, setTapped] = useState(false);
    const [failed, setFailed] = useState(false);
    const [lightboxOpen, setLightboxOpen] = useState(false);
    const [attempt, setAttempt] = useState(0);

    if (!isKlipyMediaUrl(url)) return null;

    if (!klipyEnabled && !tapped) {
        return (
            <div className="mt-1 klipy-embed" style={{ width: 240, maxWidth: '100%' }}>
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setTapped(true); }}
                    aria-label={KLIPY_TAP_TO_LOAD_TEXT}
                    title="Loads this GIF from KLIPY's servers. KLIPY will see your IP address."
                    style={{
                        width: '100%', height: 110, borderRadius: 10,
                        background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)',
                        display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', justifyContent: 'center',
                        cursor: 'pointer', color: 'rgba(255,255,255,0.65)',
                    }}
                >
                    <ImageIcon className="w-5 h-5 text-white/40" aria-hidden="true" />
                    <span style={{ fontSize: 12.5 }}>{KLIPY_TAP_TO_LOAD_TEXT}</span>
                </button>
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); updateGifSettings({ klipyEnabled: true }); }}
                    title="Turns on KLIPY for GIFs in chat and GIF search. Change it any time in Settings → Privacy & Safety."
                    style={{ all: 'unset', cursor: 'pointer', marginTop: 4, fontSize: 11, color: 'rgba(37,224,200,0.85)', textDecoration: 'underline' }}
                >
                    {KLIPY_ALWAYS_LOAD_TEXT}
                </button>
            </div>
        );
    }

    if (failed) {
        return (
            <div className="mt-1" style={{
                width: 240, maxWidth: '100%', height: 90, borderRadius: 10,
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)',
                display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', justifyContent: 'center',
                color: 'rgba(255,255,255,0.5)', fontSize: 12,
            }}>
                <span>Couldn’t load this GIF from KLIPY.</span>
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setFailed(false); setAttempt(a => a + 1); }}
                    style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, color: 'rgba(37,224,200,0.85)', fontSize: 11.5 }}
                >
                    <RotateCw style={{ width: 11, height: 11 }} aria-hidden="true" /> Retry
                </button>
            </div>
        );
    }

    return (
        <div className="mt-1 klipy-embed" style={{ position: 'relative', display: 'inline-block', width: 'fit-content', alignSelf: 'flex-start', maxWidth: '100%' }}>
            <GifPlayer
                key={attempt}
                src={url}
                alt="GIF from KLIPY"
                referrerPolicy="no-referrer"
                onError={() => setFailed(true)}
                imgStyle={{ maxWidth: 'min(300px, 100%)', maxHeight: 300, width: 'auto', height: 'auto', objectFit: 'contain', borderRadius: 10, display: 'block', cursor: 'zoom-in' }}
                onClick={(e) => { e.stopPropagation(); setLightboxOpen(true); }}
            />
            {lightboxOpen && (
                <ImageLightbox
                    src={url}
                    alt="GIF from KLIPY"
                    filename="KLIPY GIF"
                    referrerPolicy="no-referrer"
                    onClose={() => setLightboxOpen(false)}
                />
            )}
        </div>
    );
};

export default KlipyGifEmbed;
