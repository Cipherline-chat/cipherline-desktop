/**
 * A message that is ONLY one link drawn as a picture (2026-11-24,
 * embeds-media-everywhere; the owner's "invisible message").
 *
 * Discord-style, such a message shows the picture without repeating its URL
 * as text. Before this, ChatPane removed the text whenever the link LOOKED
 * like an image (by its extension): when the picture then failed (an expired
 * Discord CDN link answers 404, an "image" link that is an HTML page, embeds
 * turned off, a GIF waiting behind a click), the message was a tiny empty row.
 *
 * Now the text is always RENDERED, inside `.cl-bare-media-text`, and CSS
 * (styles/formatting.css) hides it only while the message's embed row holds a
 * picture that actually rendered (`[data-embed-rendered="media"]`, set by the
 * embed itself once real pixels are on screen). A failed, pending or blocked
 * embed leaves the link visible and clickable. Pure.
 */
import { sanitizeLinkEmbeds } from '@cipherline/shared';
import { isImageUrl } from '../imageHosts';
import { embedUrlsOf } from './plainText';
import { clipLinkOf, gifLoopMediaHost } from '../mediaEmbed/mediaLinks';

const BARE_URL_RE = /^https?:\/\/\S+$/;

/** Is this message text just one link whose embed is a picture / GIF? */
export function isBareMediaLinkMessage(text: string, embeds?: unknown): boolean {
    const t = typeof text === 'string' ? text.trim() : '';
    if (!BARE_URL_RE.test(t)) return false;
    if (isImageUrl(t)) return true;
    // A GIF host's link (Tenor / Giphy / Imgur .gifv) is drawn as the GIF.
    if (gifLoopMediaHost(clipLinkOf(t))) return true;
    const urls = embedUrlsOf(t);
    if (urls.length !== 1) return false;
    const e = sanitizeLinkEmbeds(embeds, urls)[0];
    return !!e && (e.kind === 'image' || (e.kind === 'video' && !!e.media?.loop));
}
