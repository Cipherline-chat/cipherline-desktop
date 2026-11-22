/**
 * Words for the Discord import's "issues found" state (owner 2026-11-22): the report's file summary.
 * The title-bar pill's words are components/server/discordImport/importPillModel.ts. Pure, unit-tested.
 */
import type { FileSkipCode } from './history/runner';

const FILE_REASON_WORDS: Record<FileSkipCode, string> = {
    too_large: 'too large to copy', expired: 'gone from Discord', download_failed: 'download failed', unsupported: 'address not supported',
    refused: 'upload refused', upload_failed: 'upload failed', other: 'other problems',
};

/** "12 files couldn’t be copied (8 too large to copy, 4 download failed)". */
export function filesSkippedSummary(skips: Array<{ code?: FileSkipCode }>): string {
    const by = new Map<FileSkipCode, number>();
    for (const f of skips) by.set(f.code ?? 'other', (by.get(f.code ?? 'other') ?? 0) + 1);
    const parts = [...by].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${n.toLocaleString()} ${FILE_REASON_WORDS[c]}`);
    return `${skips.length.toLocaleString()} file${skips.length === 1 ? '' : 's'} couldn’t be copied (${parts.join(', ')})`;
}
