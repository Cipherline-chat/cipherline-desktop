/**
 * What a SENDER-built embed (packages/shared link-embeds.ts, phase 3) hands
 * the in-place video players (YouTubeEmbed, VideoLinkEmbed): the real title,
 * channel / author, game tag and duration, the thumbnail already decrypted
 * from the message, and for a clip page the video file the sender found.
 * With it a player's card needs no request of its own before play.
 */
export interface SenderVideoMeta {
    title?: string;
    author?: string;
    tag?: string;
    /** Decrypted thumbnail object URL (useEmbedThumb), or null while it loads. */
    thumbUrl?: string | null;
    /** The message has a thumbnail still being decrypted (no designed picture meanwhile). */
    thumbLoading?: boolean;
    /** The page's colour, for the designed picture when there is no thumbnail. */
    color?: string;
    durationS?: number;
    /** A clip page's video file as the sender resolved it (https; checked again in main). */
    mediaUrl?: string;
    /** The video's own size (LinkEmbed.media), the first choice for the box's shape. */
    width?: number;
    height?: number;
    /** The sender's thumbnail size (EmbedImage): the shape when the media size is unknown. A designed picture gives none. */
    thumbWidth?: number;
    thumbHeight?: number;
    /**
     * The sender's COPY of the video (media.file, an expiring link; 2026-11-24):
     * play decrypts it (`request`) and plays the blob:; the link's host is never
     * contacted.
     */
    copy?: { url: string | null; failed: boolean; loading: boolean; request: () => void };
    /**
     * A video file on the link's OWN site the sender found by its bytes (an
     * extensionless link, a page's og:video; 2026-11-24): played as a direct
     * media link (main serves only a real video/* answer).
     */
    directMedia?: string;
}
