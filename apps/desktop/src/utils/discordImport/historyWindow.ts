/**
 * The history window, in words, for the wizard's preview and report. One
 * place so the copy follows the rule (IMPORT_CAPS, packages/shared): per
 * channel, the LARGER of the last 1,000 messages and everything from the last
 * 30 days, at most 25,000 per channel.
 */
import { IMPORT_CAPS } from '@cipherline/shared';

const n = (x: number) => x.toLocaleString('en-US');

/** Preview: what will be copied, and the ceiling (so the admin sees it before starting). */
export const HISTORY_WINDOW_SUMMARY =
    `From each channel you pick: the last ${n(IMPORT_CAPS.messagesPerChannelWindow)} messages or everything from the last ${IMPORT_CAPS.windowDays} days, ` +
    `whichever is more (at most ${n(IMPORT_CAPS.messagesPerChannelCeiling)} per channel), plus all pins and their reactions.`;

/** Report: why a channel's oldest messages stayed on Discord. */
export function historyTruncatedNote(r: { truncated: boolean; ceilingHit?: boolean }): string {
    if (!r.truncated) return '';
    return r.ceilingHit
        ? ` (the channel had more than ${n(IMPORT_CAPS.messagesPerChannelCeiling)} recent messages; the newest ${n(IMPORT_CAPS.messagesPerChannelCeiling)} came over)`
        : ` (older messages beyond ${IMPORT_CAPS.windowDays} days and the last ${n(IMPORT_CAPS.messagesPerChannelWindow)} were left on Discord)`;
}
