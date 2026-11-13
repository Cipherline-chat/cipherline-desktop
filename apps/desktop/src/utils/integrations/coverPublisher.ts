/**
 * The sharer's side of friends' END-TO-END ENCRYPTED Spotify covers.
 *
 * Called by the listening publisher (hooks/useListeningShare.ts) right before
 * each PUT /v1/me/listening. For the Spotify desktop app only (`source ===
 * 'spotify'`: the browser cannot be told apart, and the owner accepted that
 * another Windows program could claim to be Spotify - the cover is then a
 * sharer-chosen image, seen only by friends, end to end encrypted, and
 * reportable), it:
 *
 *   1. re-encodes the cover the OS media session gave this device as a
 *      <= 160 px JPEG (coverImage.ts - strips all metadata),
 *   2. encrypts it under this device's activity key (activityKeys.ts) with a
 *      fresh random cover id bound into the AAD (activityCover.ts),
 *   3. uploads the ciphertext (PUT /v1/me/listening/cover), and returns the id
 *      for the record's `cover_id`.
 *
 * Only when the picture changes: the same source image under the same key is
 * not re-uploaded while the server still holds it (a successful publish that
 * names the id keeps it alive; COVER_REUSE_MS stays inside the API's 150 s
 * record TTL). A new album, a key rotation, or a lapse uploads again.
 *
 * Nothing is uploaded while the audience (accepted friends) is unknown or
 * empty, or once the API has answered 404 (it predates covers): from then on
 * this session publishes exactly what it did before. Nothing here is logged.
 */
import { API_BASE } from '../../constants';
import { bytesToB64, encryptCover, newCoverId } from './activityCover';
import { activityAudience, currentActivityKey, keyStoreReady } from './activityKeys';
import { downscaleCover } from './coverImage';
import type { NowPlaying } from './nowPlaying';

/** Re-use an uploaded cover only this long after the server last confirmed it (< the API's 150 s TTL). */
export const COVER_REUSE_MS = 120_000;

export type UploadResult = 'ok' | 'gone' | 'failed';

export interface CoverPublisherDeps {
    upload(coverId: string, blobB64: string): Promise<UploadResult>;
    downscale(dataUri: string): Promise<Uint8Array | null>;
    audience(): readonly string[] | null;
    now(): number;
}

interface Last { srcHash: string; kid: string; coverId: string; confirmedAt: number }
let last: Last | null = null;
let unsupported = false;

/** Whether this player's cover may be shared with friends end to end encrypted. */
export const coverShareable = (p: Pick<NowPlaying, 'kind' | 'source' | 'art'> | null | undefined): boolean =>
    !!p && p.kind === 'listening' && p.source === 'spotify' && typeof p.art === 'string' && p.art.startsWith('data:image/');

async function sha256Hex(s: string): Promise<string> {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
    return [...d].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** The cover id to publish with this track, or null (no cover / not Spotify / nobody to show it to / API too old). Never throws. */
export async function prepareCover(p: NowPlaying, userId: string, deps: CoverPublisherDeps): Promise<string | null> {
    try {
        if (unsupported || !coverShareable(p)) return null;
        const aud = deps.audience();
        if (!aud || aud.length === 0 || !keyStoreReady(userId)) return null;
        const now = deps.now();
        // Rotates first when a holder of the key is no longer a friend.
        const key = currentActivityKey(userId, aud, now);
        const srcHash = await sha256Hex(p.art!);
        if (last && last.srcHash === srcHash && last.kid === key.kid && now - last.confirmedAt < COVER_REUSE_MS) return last.coverId;
        const jpeg = await deps.downscale(p.art!);
        if (!jpeg) return null;
        const coverId = newCoverId();
        const blob = await encryptCover({ sharerUserId: userId, coverId, kid: key.kid, keyB64: key.keyB64, image: jpeg });
        if (!blob) return null;
        const r = await deps.upload(coverId, bytesToB64(blob));
        if (r === 'gone') { unsupported = true; last = null; return null; }
        if (r !== 'ok') return null;
        last = { srcHash, kid: key.kid, coverId, confirmedAt: now };
        return coverId;
    } catch { return null; }
}

/**
 * After a publish: `sent` is the cover id the body carried (null = none),
 * `stored` the record the API answered with. Confirmed -> the cover may be
 * reused for another COVER_REUSE_MS; dropped (the blob expired) -> the next
 * publish uploads again.
 */
export function confirmCover(sent: string | null, stored: unknown, now: number): void {
    if (!sent || !last || last.coverId !== sent) return;
    const rec = stored && typeof stored === 'object' ? (stored as { listening?: { cover_id?: unknown } | null }).listening : undefined;
    if (rec && rec.cover_id === sent) last = { ...last, confirmedAt: now };
    else last = null;
}

/** Sign-out / account switch / sharing switched off. */
export function resetCoverPublisher(): void { last = null; unsupported = false; }

/** The real dependencies, for the publisher hook. */
export function coverPublisherDeps(token: string): CoverPublisherDeps {
    return {
        async upload(coverId, blobB64) {
            try {
                // axios is loaded on first use (this module is imported by tests that have no browser globals).
                const { default: axios } = await import('axios');
                await axios.put(`${API_BASE}/me/listening/cover`, { cover_id: coverId, blob_b64: blobB64 }, {
                    headers: { Authorization: `Bearer ${token}` }, timeout: 15_000,
                });
                return 'ok';
            } catch (e) {
                // 404: an API from before covers. 400 can only be a bug here; treat it the same (stop for this session).
                const s = (e as { response?: { status?: number } })?.response?.status;
                return s === 404 || s === 400 ? 'gone' : 'failed';
            }
        },
        downscale: downscaleCover,
        audience: activityAudience,
        now: () => Date.now(),
    };
}
