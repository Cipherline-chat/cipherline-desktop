/**
 * User-facing copy for the per-tier upload cap. Derived from the constants so
 * the copy cannot drift from the limit it describes (it used to be hard-coded
 * "25 MB" strings in three components while the constant said 25 MiB).
 *
 * The limits themselves are mirrors for UX only — the API enforces them in
 * AttachmentsService.initiateUpload (free 100 MB, paid/trial 2 GB).
 */
import { FREE_TIER_MAX_UPLOAD_BYTES, MAX_ATTACHMENT_BYTES } from '../constants';

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** "100 MB" / "2 GB" — whole units, binary like the limits themselves. */
export function formatUploadLimit(bytes: number): string {
    return bytes >= GB ? `${Math.round(bytes / GB)} GB` : `${Math.round(bytes / MB)} MB`;
}

export const FREE_UPLOAD_LIMIT_LABEL = formatUploadLimit(FREE_TIER_MAX_UPLOAD_BYTES);
export const PRO_UPLOAD_LIMIT_LABEL = formatUploadLimit(MAX_ATTACHMENT_BYTES);

/** Detail line for the "file too large for the free plan" prompt. */
export function freeTierTooLargeDetail(tooBigNames: string[]): string {
    return tooBigNames.length === 1
        ? `"${tooBigNames[0]}" exceeds the ${FREE_UPLOAD_LIMIT_LABEL} free-tier upload limit.`
        : `${tooBigNames.length} files exceed the ${FREE_UPLOAD_LIMIT_LABEL} free-tier upload limit.`;
}
