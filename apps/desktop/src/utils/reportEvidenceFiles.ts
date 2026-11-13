/**
 * Images a reporter attaches to an abuse report (screenshots, or the decrypted
 * file of a message that was reported with its franking proof).
 *
 * The limits mirror the API (apps/api/src/reports/report-evidence.*): PNG, JPEG
 * or WebP, at most 4 per report, each up to 8 MiB. They are checked here only
 * to save an upload that would be refused; the server decides, by magic bytes,
 * and re-encodes every image with its metadata removed.
 */
import axios from 'axios';
import { apiUrl } from './apiPath';

export const REPORT_IMAGE_MAX_COUNT = 4;
export const REPORT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const REPORT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ReportImageType = (typeof REPORT_IMAGE_TYPES)[number];

/** The image type from the file's first bytes, or null. The declared type is never trusted. */
export function sniffReportImageType(head: Uint8Array): ReportImageType | null {
    if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
        && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) return 'image/png';
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
    if (head.length >= 12 && String.fromCharCode(head[0], head[1], head[2], head[3]) === 'RIFF'
        && String.fromCharCode(head[8], head[9], head[10], head[11]) === 'WEBP') return 'image/webp';
    return null;
}

export interface PickedImage {
    file: File;
    type: ReportImageType;
}

export interface PickResult {
    accepted: PickedImage[];
    /** One short, user-facing line per refused file. */
    problems: string[];
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

/** Filter what the user picked down to what can be uploaded, saying why for the rest. */
export async function pickReportImages(existing: number, picked: File[]): Promise<PickResult> {
    const accepted: PickedImage[] = [];
    const problems: string[] = [];
    for (const file of picked) {
        const name = file.name || 'That file';
        if (existing + accepted.length >= REPORT_IMAGE_MAX_COUNT) {
            problems.push(`You can attach up to ${REPORT_IMAGE_MAX_COUNT} images; ${name} was not added.`);
            continue;
        }
        if (file.size > REPORT_IMAGE_MAX_BYTES) {
            problems.push(`${name} is larger than ${mb(REPORT_IMAGE_MAX_BYTES)}.`);
            continue;
        }
        let type: ReportImageType | null = null;
        try {
            type = sniffReportImageType(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
        } catch { /* unreadable: refused below */ }
        if (!type) {
            problems.push(`${name} is not a PNG, JPEG or WebP image.`);
            continue;
        }
        accepted.push({ file, type });
    }
    return { accepted, problems };
}

/**
 * Why the file of a reported message cannot be sent with the report, or null
 * when it can. Decided from the details the sender committed to, so the dialog
 * can say so up front instead of failing after submit. Videos and other files
 * reach moderators as their name, type and size only.
 */
export function reportedFileProblem(file: { mime?: string; byte_size?: number } | undefined): 'type' | 'size' | null {
    const mime = (file?.mime ?? '').split(';')[0].trim().toLowerCase();
    if (!(REPORT_IMAGE_TYPES as readonly string[]).includes(mime)) return 'type';
    if (typeof file?.byte_size === 'number' && file.byte_size > REPORT_IMAGE_MAX_BYTES) return 'size';
    return null;
}

export type EvidenceKind = 'screenshot' | 'attachment';

/** Upload one image to a report the caller just filed. Resolves true on success, never throws. */
export async function uploadReportEvidence(args: {
    reportId: string;
    kind: EvidenceKind;
    blob: Blob;
    type: ReportImageType;
    token: string;
}): Promise<boolean> {
    try {
        await axios.post(
            apiUrl`/reports/${args.reportId}/evidence?kind=${args.kind}`,
            args.blob,
            { headers: { Authorization: `Bearer ${args.token}`, 'Content-Type': args.type } },
        );
        return true;
    } catch {
        return false;
    }
}
