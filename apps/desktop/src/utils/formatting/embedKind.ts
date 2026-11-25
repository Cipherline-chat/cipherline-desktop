/**
 * Which card a URL in a message gets (ChatPane's embed row). Order matters:
 * a THEME link is decided first, so it can never fall through to the image
 * embed (which downloads the URL) or a YouTube player — a theme link renders
 * from its own fragment on this device and is never fetched by anything.
 * Invite links next (their card asks OUR API about the invite code).
 *
 * Then the in-place media (docs/plans/embeds.md phase 2), all receiver-side
 * and built from the URL alone:
 *   youtube — click-to-play facade;
 *   video   — a direct video file (.mp4/.webm/.mov), plays on click;
 *   clip    — a clip page (Medal, Streamable, Imgur, Tenor, Giphy) whose video
 *             main resolves on click;
 *   image   — a direct image / GIF, loads automatically as before.
 * `video` and `clip` come before `image` because i.imgur.com counts as an
 * extension-less image host, which would otherwise swallow its .mp4/.gifv.
 * Spoilered / code / `<url>` links never reach this (utils/formatting/plainText).
 */
import { isThemeLinkUrl } from '../../theme/themeLink';
import { isImageUrl } from '../imageHosts';
import { extractYouTubeId } from '../youtubeLink';
import { clipLinkOf, isDirectVideoUrl } from '../mediaEmbed/mediaLinks';
import { inviteCodeFromUrl } from './inviteLinks';

export type EmbedKind = 'theme' | 'invite' | 'youtube' | 'video' | 'clip' | 'image' | 'link';

export function embedKindOf(url: string): EmbedKind {
    if (isThemeLinkUrl(url)) return 'theme';
    if (inviteCodeFromUrl(url)) return 'invite';
    if (extractYouTubeId(url)) return 'youtube';
    if (isDirectVideoUrl(url)) return 'video';
    if (clipLinkOf(url)) return 'clip';
    if (isImageUrl(url)) return 'image';
    return 'link';
}
