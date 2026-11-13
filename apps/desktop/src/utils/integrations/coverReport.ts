/**
 * Reporting a friend's END-TO-END ENCRYPTED Spotify cover.
 *
 * The cover is a sharer-chosen image (any Windows program can claim to be
 * Spotify), so friends can report it through the ordinary in-app report flow
 * ("Moderation without breaking E2EE": the reporter includes content from
 * their own device). The server cannot read the cover, so the evidence is what
 * THIS device decrypted.
 *
 * Today's report contract carries text only (POST /v1/reports:
 * `content_snippet`, <= 4000 chars, stored as given - there is no image
 * evidence field). So the evidence is text that fits beside the reporter's
 * own words:
 *   - what the record said (track / artist / album),
 *   - the SHA-256 of the exact image bytes this device decrypted (lets a
 *     moderator match it to a copy obtained later, e.g. from the reporter),
 *   - a small re-encoded JPEG of it as a data: URI (<= EVIDENCE_IMAGE_CHARS),
 *     shrunk until it fits; left out (hash only) when it cannot.
 * Gap (documented in the report): the admin dashboard shows the snippet as
 * text, so a moderator views the thumbnail by opening the data: URI. A real
 * image-evidence field needs a reports column and admin rendering.
 */
import type { DecryptedCover } from './activityCover';
import { bytesToB64 } from './activityCover';
import { reencodeJpeg } from './coverImage';

/** The API's content_snippet cap (apps/api/src/reports/dto/report.dto.ts). */
export const REPORT_SNIPPET_MAX = 4000;
/** Room kept for the reporter's own words. */
export const EVIDENCE_TEXT_MAX = 3400;
const EVIDENCE_IMAGE_CHARS = 2800;
const THUMB_STEPS: ReadonlyArray<readonly [number, number]> = [[96, 0.7], [80, 0.6], [64, 0.55], [48, 0.5], [32, 0.5]];

export interface ReportEvidence {
    /** Shown above the attachment in the report dialog. */
    label: string;
    /** What is appended to content_snippet (<= EVIDENCE_TEXT_MAX). */
    text: string;
    /** A preview for the reporter (the decrypted cover's blob: URL). */
    imageSrc: string | null;
}

export type Thumbnailer = (image: Blob, maxPx: number, quality: number) => Promise<Uint8Array | null>;

const line = (s: string | null | undefined, max = 120) => (s ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, max);

async function sha256Hex(b: Uint8Array): Promise<string> {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
    return [...d].map(x => x.toString(16).padStart(2, '0')).join('');
}

export async function buildCoverEvidence(a: {
    track: string; artist: string; album: string | null;
    cover: DecryptedCover & { url?: string | null };
    thumbnail?: Thumbnailer;
}): Promise<ReportEvidence> {
    const thumb = a.thumbnail ?? reencodeJpeg;
    const head = [
        "[Reported: this friend's Spotify listening cover. It is end-to-end encrypted; the reporter's device decrypted it and attached it below.]",
        `Track: ${line(a.track)}`,
        `Artist: ${line(a.artist)}`,
        ...(a.album ? [`Album: ${line(a.album)}`] : []),
        `Cover SHA-256 (${a.cover.type}, ${a.cover.bytes.length} bytes): ${await sha256Hex(a.cover.bytes)}`,
    ].join('\n');
    let image = '';
    const src = new Blob([a.cover.bytes as BlobPart], { type: a.cover.type });
    for (const [px, q] of THUMB_STEPS) {
        let jpeg: Uint8Array | null = null;
        try { jpeg = await thumb(src, px, q); } catch { jpeg = null; }
        if (!jpeg) break;
        const uri = `data:image/jpeg;base64,${bytesToB64(jpeg)}`;
        if (uri.length <= EVIDENCE_IMAGE_CHARS) { image = `Cover thumbnail (${px} px JPEG): ${uri}`; break; }
    }
    const text = (image ? `${head}\n${image}` : `${head}\n(No thumbnail fits in a report; the hash above identifies the image.)`).slice(0, EVIDENCE_TEXT_MAX);
    return { label: 'The cover you saw (decrypted on this device)', text, imageSrc: a.cover.url ?? null };
}

/** content_snippet = the reporter's words, then the evidence; always within the API's cap. */
export function snippetWithEvidence(snippet: string, evidence: ReportEvidence | null | undefined): string {
    const own = snippet.trim();
    if (!evidence) return own.slice(0, REPORT_SNIPPET_MAX);
    const room = REPORT_SNIPPET_MAX - evidence.text.length - 2;
    const mine = own.slice(0, Math.max(0, room));
    return (mine ? `${mine}\n\n${evidence.text}` : evidence.text).slice(0, REPORT_SNIPPET_MAX);
}
