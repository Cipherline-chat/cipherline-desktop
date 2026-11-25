/**
 * YouTube's public oEmbed endpoint (no API key): the title and channel shown
 * on the YouTube facade (src/components/embeds/YouTubeEmbed.tsx).
 *
 * The renderer sends only a video id; the URL is built HERE from that id, so
 * the renderer cannot point this fetch anywhere else. Pure: the fetch itself
 * is pinned-fetch.ts, wired in ipc.ts.
 */

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MAX_FIELD = 200;

export function isYouTubeId(id: unknown): id is string {
    return typeof id === 'string' && YT_ID_RE.test(id);
}

export function youTubeOEmbedUrl(id: string): string {
    if (!isYouTubeId(id)) throw new Error('Invalid YouTube id');
    const watch = `https://www.youtube.com/watch?v=${id}`;
    return `https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`;
}

/** Plain display text: no control or bidi-override characters, bounded. */
export function cleanText(v: unknown, max = MAX_FIELD): string {
    if (typeof v !== 'string') return '';
    let out = '';
    for (const ch of v) {
        const c = ch.codePointAt(0)!;
        if (c < 0x20 || c === 0x7f || (c >= 0x80 && c < 0xa0)) { out += ' '; continue; }
        if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0x200e || c === 0x200f) continue;
        out += ch;
    }
    out = out.replace(/\s+/g, ' ').trim();
    return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

export interface YouTubeMeta { title: string; author: string }

/** The oEmbed JSON → title/channel, or null when it carries no usable title. */
export function parseYouTubeOEmbed(body: string): YouTubeMeta | null {
    let j: unknown;
    try { j = JSON.parse(body); } catch { return null; }
    if (!j || typeof j !== 'object') return null;
    const o = j as Record<string, unknown>;
    const title = cleanText(o.title);
    if (!title) return null;
    return { title, author: cleanText(o.author_name) };
}
