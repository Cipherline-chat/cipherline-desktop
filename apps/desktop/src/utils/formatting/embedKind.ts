/**
 * Which card a URL in a message gets (ChatPane's embed row). Order matters:
 * a THEME link is decided first, so it can never fall through to the image
 * embed (which downloads the URL) or a YouTube player — a theme link renders
 * from its own fragment on this device and is never fetched by anything.
 * Invite links next (their card asks OUR API about the invite code).
 */
import { isThemeLinkUrl } from '../../theme/themeLink';
import { isImageUrl } from '../imageHosts';
import { extractYouTubeId } from '../youtubeLink';
import { inviteCodeFromUrl } from './inviteLinks';

export type EmbedKind = 'theme' | 'invite' | 'youtube' | 'image' | 'link';

export function embedKindOf(url: string): EmbedKind {
    if (isThemeLinkUrl(url)) return 'theme';
    if (inviteCodeFromUrl(url)) return 'invite';
    if (extractYouTubeId(url)) return 'youtube';
    if (isImageUrl(url)) return 'image';
    return 'link';
}
