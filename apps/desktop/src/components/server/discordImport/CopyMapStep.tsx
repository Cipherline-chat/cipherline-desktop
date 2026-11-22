import React from 'react';
import { AlertTriangle, ArrowRight, Hash, Info } from 'lucide-react';
import { ClCheckbox, ClSelect } from '../../cl';
import { DialogNote } from '../../dialog/DialogExtras';
import { HISTORY_WINDOW_SUMMARY } from '../../../utils/discordImport/historyWindow';
import { copyable, type CopyRow, type CopyTargetChannel } from '../../../utils/discordImport/copyMapping';
import type { ImportChannelMap } from '../../../utils/discordImport/history/host';

/**
 * "Copy messages from Discord" into an existing server: the mapping step. One row per Discord message
 * channel: tick it, pick the existing channel it fills (auto-matched by the previous import, then by
 * name), and see why a channel cannot be copied (already copied / holds imported messages of unknown
 * origin). The rule itself lives in utils/discordImport/copyMapping.ts.
 */
export interface CopyMapStepProps {
    guildName: string;
    serverName: string;
    rows: CopyRow[];
    targets: CopyTargetChannel[];
    picked: ReadonlySet<number>;
    onPick: (num: number, on: boolean) => void;
    onPickAll: (on: boolean) => void;
    onRetarget: (num: number, target: string | null) => void;
    map: ImportChannelMap | null;
    /** Existing channels picked twice (two Discord channels into one). */
    clash: string[];
    /** "End it now": this account's own interrupted session here (keeps what it copied). */
    onEndActive?: () => void;
    endingActive?: boolean;
}

const NONE = '__none__';

function statusLine(r: CopyRow, map: ImportChannelMap | null): { text: string; tone: 'muted' | 'warn' | 'faint' } {
    switch (r.status.kind) {
        case 'copied': return { text: `Already copied (${r.status.rows.toLocaleString()} message${r.status.rows === 1 ? '' : 's'} in this server): skipped so nothing is copied twice.`, tone: 'faint' };
        case 'unknown': return { text: `That channel already has ${r.status.rows.toLocaleString()} imported message${r.status.rows === 1 ? '' : 's'} from an earlier import: skipped so nothing is copied twice.`, tone: 'faint' };
        case 'no-target': return { text: 'No matching channel here. Pick one, or leave it out.', tone: 'warn' };
        case 'ready': {
            const has = map?.channels.find(c => c.channel_id === r.target)?.imported_rows ?? 0;
            const how = r.matchedBy === 'previous' ? 'Matched by your earlier import' : r.matchedBy === 'name' ? 'Matched by name' : 'Your choice';
            return { text: has > 0 ? `${how}. Has ${has.toLocaleString()} messages from another Discord channel; these are added after them.` : `${how}. No imported messages there yet.`, tone: 'muted' };
        }
    }
}

export const CopyMapStep: React.FC<CopyMapStepProps> = ({ guildName, serverName, rows, targets, picked, onPick, onPickAll, onRetarget, map, clash, onEndActive, endingActive }) => {
    const options = [{ value: NONE, label: 'Don’t copy' }, ...targets.map(t => ({ value: t.channel_id, label: `# ${t.name}` }))];
    const pickable = rows.filter(copyable);
    const nPicked = rows.filter(r => picked.has(r.source.num) && copyable(r)).length;
    const left = map ? Math.max(0, map.imports.limit - map.imports.used) : null;
    return (
        <>
            <div className="dlg-help flex flex-wrap gap-x-1 min-w-0" data-testid="copy-intro">
                <span>From Discord server</span>
                <span className="text-cl-muted font-semibold truncate min-w-0">{guildName}</span>
                <span>into</span>
                <span className="text-cl-muted font-semibold truncate min-w-0">{serverName}</span>
            </div>
            <fieldset className="m-0 p-0 border-0 flex flex-col gap-2" data-testid="copy-map">
                <legend className="sr-only">Which Discord channels fill which channels here</legend>
                <div className="flex items-center gap-3 text-[12px] text-cl-faint">
                    <span data-testid="copy-picked">{nPicked} of {pickable.length} channel{pickable.length === 1 ? '' : 's'} to copy</span>
                    <button type="button" className="dlg-linkbtn" onClick={() => onPickAll(true)} disabled={pickable.length === 0}>All</button>
                    <button type="button" className="dlg-linkbtn" onClick={() => onPickAll(false)}>None</button>
                </div>
                <ul className="m-0 p-0 list-none flex flex-col gap-1.5" aria-label="Channels">
                    {rows.map(r => {
                        const st = statusLine(r, map);
                        const can = copyable(r);
                        const clashes = !!r.target && clash.includes(r.target) && picked.has(r.source.num);
                        return (
                            <li key={r.source.num} className="rounded-lg border border-cl-border bg-cl-sink/40 px-2.5 py-2 flex flex-col gap-1 min-w-0" data-testid="copy-row" data-status={r.status.kind}>
                                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                                    <ClCheckbox
                                        checked={can && picked.has(r.source.num)}
                                        disabled={!can}
                                        onChange={v => onPick(r.source.num, v)}
                                        label={<span className="inline-flex items-center gap-1 min-w-0"><Hash size={12} aria-hidden="true" /><span className="truncate max-w-[180px]">{r.source.name}</span></span>}
                                    />
                                    <ArrowRight size={13} className="shrink-0 text-cl-faint" aria-hidden="true" />
                                    <div className="min-w-[160px] flex-1">
                                        <ClSelect<string>
                                            value={r.target ?? NONE}
                                            onChange={v => onRetarget(r.source.num, v === NONE ? null : v)}
                                            options={options}
                                            ariaLabel={`Channel here for #${r.source.name}`}
                                            disabled={r.status.kind === 'copied'}
                                            style={{ width: '100%', minWidth: 0 }}
                                        />
                                    </div>
                                </div>
                                <div className={`text-[11.5px] leading-snug ${st.tone === 'warn' ? 'text-cl-muted' : st.tone === 'faint' ? 'text-cl-faint' : 'text-cl-faint'}`} data-testid="copy-row-status">
                                    {clashes ? 'Two Discord channels go into this channel. Pick a different one for one of them.' : st.text}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            </fieldset>
            <div className="dlg-help" data-testid="copy-window">
                {HISTORY_WINDOW_SUMMARY} They arrive as normal messages under each person’s name and picture, after the messages
                already in the channel, and delete 30 days after the copy (files after 14 days) unless you save them. Pins are saved for you.
            </div>
            {map && (
                <DialogNote tone={left === 0 ? 'warn' : 'info'} icon={left === 0 ? <AlertTriangle size={15} aria-hidden="true" /> : <Info size={15} aria-hidden="true" />} data-testid="copy-quota">
                    {left === 0
                        ? <>This server already used its {map.imports.limit} message imports for the last {map.imports.window_days} days. Try again later.</>
                        : <>This copy counts as one of the server’s {map.imports.limit} message imports per {map.imports.window_days} days ({map.imports.used} used, {left} left).</>}
                </DialogNote>
            )}
            {map?.active && (
                <DialogNote tone="info" icon={<Info size={15} aria-hidden="true" />} data-testid="copy-active">
                    {map.active.supersedable
                        ? 'An earlier import from your account was interrupted. Starting this copy ends it; what it copied stays.'
                        : `An import from your account is still running here (active ${map.active.idle_minutes} minute${map.active.idle_minutes === 1 ? '' : 's'} ago). If it was interrupted, end it now (what it copied stays), or it ends on its own after 15 minutes without activity.`}
                    {!map.active.supersedable && onEndActive && (
                        <div className="mt-2">
                            <button type="button" className="dlg-linkbtn" data-testid="copy-end-active" onClick={onEndActive} disabled={endingActive}>
                                {endingActive ? 'Ending…' : 'End that import now'}
                            </button>
                        </div>
                    )}
                </DialogNote>
            )}
        </>
    );
};

export default CopyMapStep;
