/**
 * The YouTube video a message link points at, or null.
 *
 * A link only produces an inline player when it is really a YouTube link: the
 * host must be one of YouTube's own (youtube.com, www.youtube.com,
 * m.youtube.com, youtu.be) over http(s). The patterns this replaced matched
 * anywhere in the URL, so a link to any site carrying `?v=<11 chars>` (or a
 * `/embed/…` path) rendered as a YouTube embed, presenting another site's
 * link as a YouTube video.
 *
 * Shared by the chat (ChatPane MessageEmbed) and the pinned-messages panel.
 */

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function extractYouTubeId(raw: string): string | null {
    if (typeof raw !== 'string' || raw.length > 2048) return null;
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    const segs = u.pathname.split('/').filter(Boolean);
    let id: string | null = null;
    if (host === 'youtu.be') {
        id = segs[0] ?? null;
    } else if (YT_HOSTS.has(host)) {
        if (segs[0] === 'watch') id = u.searchParams.get('v');
        else if ((segs[0] === 'embed' || segs[0] === 'shorts' || segs[0] === 'live') && segs[1]) id = segs[1];
    }
    return id && ID_RE.test(id) ? id : null;
}
