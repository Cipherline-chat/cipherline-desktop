import React, { useEffect, useId, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download, KeyRound } from 'lucide-react';
import { ClButton, ClProgress } from '../../cl';
import { DialogHeader, DialogBody, DialogFooter, DialogError } from '../../dialog/DialogFrame';
import { DialogStack, DialogNote } from '../../dialog/DialogExtras';
import { historyTruncatedNote } from '../../../utils/discordImport/historyWindow';
import {
    attachImportJobViewer, cancelImportJob, dismissImportJob, importJobDeps, importJobIssues, retryFailedImportChannels, retryImportJob,
    stopImportJobHistory, useImportJob,
} from '../../../utils/discordImport/backgroundImport';
import { filesSkippedSummary } from '../../../utils/discordImport/importIssuesText';
import { ImportKeepStep } from './ImportKeepStep';

/**
 * The running import's progress, then its report, then the "Server save
 * messages you don't want deleted" popup: everything after "Import server".
 *
 * Bound to the app-level job (utils/discordImport/backgroundImport.ts), not to
 * whoever mounts it: the wizard shows it right after the consent step, and the
 * floating progress pill / "Import finished" toast mount it again in their
 * own modal (DiscordImportHost). Unmounting it never touches the job.
 */
export interface DiscordImportProgressViewProps {
    /** Hide the view; the import keeps going (the pill takes over). */
    onClose: () => void;
    /** "Open server" / "Open the server anyway": the host navigates and closes its modal. */
    onOpenServer: (serverId: string, serverName: string) => void | Promise<void>;
    /** The wizard's way back to its consent step (Cancel before the server existed). Absent: Close. */
    onBackToSetup?: (message: string | null) => void;
}

const SUBTITLE = { run: 'Building your server', done: 'All set', issues: 'Issues found', keep: 'Imported messages are normal messages' } as const;

export const DiscordImportProgressView: React.FC<DiscordImportProgressViewProps> = ({ onClose, onOpenServer, onBackToSetup }) => {
    const job = useImportJob();
    const [stopAskRaw, setStopAsk] = useState(false);
    const [showReport, setShowReport] = useState(false);
    const [keep, setKeep] = useState(false);
    const [forgotten, setForgotten] = useState(false);
    const [showSkippedEmoji, setShowSkippedEmoji] = useState(false);
    const [dismissAsk, setDismissAsk] = useState(false);
    const skippedId = useId();

    // On screen: the pill hides, and a result that finishes now (or already did) counts as seen.
    useEffect(() => attachImportJobViewer(), []);

    // Cancelled before the server existed: the wizard goes back to its consent step.
    const cancelled = job?.phase === 'cancelled';
    useEffect(() => {
        if (cancelled && onBackToSetup) { const msg = job?.error ?? null; dismissImportJob(); onBackToSetup(msg); }
    }, [cancelled, onBackToSetup, job?.error]);

    // The stop question belongs to the message copy: gone once it is not running.
    const stopAsk = stopAskRaw && job?.phase === 'history';
    const copy = job?.kind === 'copy';
    const header = (sub: string) => <DialogHeader icon={<Download size={18} strokeWidth={2.2} />} title={copy ? 'Copy messages from Discord' : 'Import from Discord'} subtitle={copy && sub === SUBTITLE.run ? 'Copying messages' : sub} />;

    if (!job) {
        return (
            <>
                {header(SUBTITLE.done)}
                <DialogBody><DialogNote tone="info">No import is running.</DialogNote></DialogBody>
                <DialogFooter><ClButton type="button" size="sm" onClick={onClose}>Close</ClButton></DialogFooter>
            </>
        );
    }

    // With a channel still waiting for Retry, opening the server keeps the job (and its pill: "1 channel
    // failed · Retry"), so the person can come back to it; only an explicit Dismiss lets it go.
    const openServer = (id: string, name: string) => {
        if (importJobIssues(job).retryable.length === 0) dismissImportJob();
        void onOpenServer(id, name);
    };
    const deps = importJobDeps();
    const history = deps?.history;
    const report = job.report;

    // ── After the report: "Server save messages you don't want deleted" ──
    if (keep && report && history && job.hReports) {
        const sid = report.serverId;
        const iid = job.importId;
        return (
            <ImportKeepStep
                channels={job.hReports.map(r => ({ channelId: r.channelId, name: r.name, rows: r.savable }))}
                loadStorage={() => history.storage(sid)}
                saveAll={async (channelId, rows) => {
                    if (!iid) return { saved: 0, noRoom: rows.length };
                    let saved = 0; let noRoom = 0;
                    const apiFor = history.api(sid);
                    for (let i = 0; i < rows.length; i += 500) {
                        const r = await apiFor.save(iid, { channel_id: channelId, pin: false, items: rows.slice(i, i + 500).map(x => ({ message_id: x.message_id, attachment_ids: x.attachment_ids })) });
                        for (const x of r.results) { if (x.status === 'saved' || x.status === 'already' || x.status === 'pinned') saved++; else if (x.status === 'no_room') noRoom++; }
                    }
                    return { saved, noRoom };
                }}
                onDone={() => openServer(report.serverId, report.serverName)}
            />
        );
    }

    // ── Done (or messages stopped by an error, once "See the report" is pressed) ──
    if (report && (job.phase === 'done' || (job.phase === 'history-failed' && showReport))) {
        const hReports = job.hReports;
        const issues = importJobIssues(job);
        const failedChannels = issues.failed;
        const retryChannels = issues.retryable;
        const retryIds = new Set(retryChannels.map(r => r.channelId));
        const copied = (hReports ?? []).reduce((t, r) => t + r.messages, 0);
        const allSkips = (hReports ?? []).flatMap(r => r.filesSkipped);
        return (
            <>
                {header(issues.any ? SUBTITLE.issues : SUBTITLE.done)}
                <DialogBody className="dlg-body--scroll">
                    <DialogStack>
                        {issues.any && (
                            // Owner 2026-11-22: "if there are issues like this, I'd like the pop up to say issues found
                            // in red or something so they don't just dismiss it and then never get the chance to retry".
                            <DialogNote tone="danger" icon={<AlertTriangle size={15} aria-hidden="true" />} role="alert" data-testid="import-issues">
                                <div className="text-[13.5px] font-bold text-cl-danger-text" data-testid="import-issues-title">
                                    {copy ? 'Copy finished — issues found' : 'Import finished — issues found'}
                                </div>
                                {failedChannels.length > 0 && (
                                    <ul className="m-0 mt-1.5 p-0 list-none flex flex-col gap-1.5" data-testid="history-failed">
                                        {failedChannels.map(r => (
                                            <li key={r.channelId} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                                <span className="min-w-0 flex-1 basis-[240px]">
                                                    <b>#{r.name}</b>{' '}
                                                    {r.rows === 0 ? 'didn’t come over: ' : `stopped after ${r.messages.toLocaleString()} message${r.messages === 1 ? '' : 's'}: `}
                                                    {r.error}
                                                </span>
                                                {retryIds.has(r.channelId) && (
                                                    <span data-testid="history-retry-one">
                                                        <ClButton type="button" size="sm" variant="ghost" onClick={() => retryFailedImportChannels([r.channelId])}>
                                                            Retry #{r.name}
                                                        </ClButton>
                                                    </span>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                {issues.partial.length > 0 && (
                                    <div className="mt-1.5" data-testid="import-issues-partial">
                                        {issues.partial.map(r => `#${r.name}`).join(', ')}: Discord stopped answering partway, so only the newest messages came over.
                                    </div>
                                )}
                                {allSkips.length > 0 && (
                                    <div className="mt-1.5" data-testid="import-issues-files">
                                        {filesSkippedSummary(allSkips)}. Each of those messages came over with a line saying which file is missing.
                                    </div>
                                )}
                                {issues.messagesSkipped > 0 && (
                                    <div className="mt-1.5">
                                        {issues.messagesSkipped.toLocaleString()} message{issues.messagesSkipped === 1 ? '' : 's'} couldn’t be copied (details below).
                                    </div>
                                )}
                                {failedChannels.length > 0 && (
                                    <div className="mt-1.5 text-[12.5px]">
                                        {retryChannels.length > 0
                                            ? `Nothing from ${retryChannels.length === 1 ? 'that channel' : 'those channels'} was copied, so retrying is safe. You can also do it later: the server’s menu → Copy messages from Discord.`
                                            : failedChannels.every(r => r.rows === 0)
                                                ? 'Nothing from them was copied. Use “Copy messages from Discord” in the server’s menu to try again.'
                                                : 'What was copied before it stopped is kept.'}
                                    </div>
                                )}
                                {retryChannels.length > 1 && (
                                    <div className="mt-2" data-testid="history-retry">
                                        <ClButton type="button" size="sm" onClick={() => retryFailedImportChannels()}>Retry all ({retryChannels.length})</ClButton>
                                    </div>
                                )}
                            </DialogNote>
                        )}
                        {copy ? (
                            <DialogNote tone={failedChannels.length > 0 && copied === 0 ? 'warn' : 'ok'} icon={<CheckCircle2 size={15} aria-hidden="true" />} role="status" data-testid="copy-done">
                                {copied.toLocaleString()} message{copied === 1 ? '' : 's'} copied into <b>{report.serverName}</b>.
                            </DialogNote>
                        ) : (
                            <DialogNote tone="ok" icon={<CheckCircle2 size={15} aria-hidden="true" />} role="status">
                                {report.cancelled ? <>Stopped early. <b>{report.serverName}</b> was created; some emojis may be missing.</>
                                    : <><b>{report.serverName}</b> is ready.</>}
                            </DialogNote>
                        )}
                        {!copy && (
                        <ul className="m-0 pl-4 text-[13px] leading-[1.55] text-cl-muted space-y-0.5" data-testid="done-summary">
                            <li>{job.counts.roles} roles, {job.counts.categories} categories and {job.counts.channels} channels created</li>
                            {(report.iconDone || report.bannerDone) && <li>Server {report.iconDone && report.bannerDone ? 'icon and banner' : report.iconDone ? 'icon' : 'banner'} copied</li>}
                            {job.emojiTotal > 0 && job.includeEmojis && <li>{report.emojisAdded} of {job.emojiTotal} emojis added</li>}
                            {!!report.roleIconsAdded && <li>{report.roleIconsAdded} role icon{report.roleIconsAdded === 1 ? '' : 's'} copied</li>}
                            {job.stickerTotal > 0 && job.includeStickers && <li data-testid="done-stickers">{report.stickersAdded ?? 0} of {job.stickerTotal} stickers added</li>}
                        </ul>
                        )}
                        {report.notes.length > 0 && (
                            <ul className="m-0 pl-4 text-[12px] leading-snug text-cl-faint space-y-0.5">
                                {report.notes.map((n, i) => <li key={i}>{n}</li>)}
                            </ul>
                        )}
                        {hReports && (
                            <section aria-label="Messages" data-testid="history-report" className="flex flex-col gap-1.5">
                                {job.stopped && (
                                    <DialogNote tone="warn" icon={<AlertTriangle size={15} aria-hidden="true" />} role="status">
                                        {job.stopped.deleted > 0 ? `Stopped. ${job.stopped.deleted.toLocaleString()} copied messages were deleted.` : 'Stopped. What was copied so far is kept.'}
                                    </DialogNote>
                                )}
                                <ul className="m-0 p-0 list-none flex flex-col gap-1">
                                    {hReports.map(r => (
                                        <li key={r.channelId} className="text-[12.5px] leading-snug" data-testid={r.error ? 'history-line-failed' : 'history-line'}>
                                            <span className="text-cl-text font-semibold">#{r.name}</span>
                                            {r.error ? (
                                                <span className="text-cl-danger-text">
                                                    {r.rows === 0 ? ' — not copied: ' : ` — stopped after ${r.messages.toLocaleString()} message${r.messages === 1 ? '' : 's'}: `}{r.error}
                                                </span>
                                            ) : (
                                                <span className="text-cl-muted">{` — ${r.messages.toLocaleString()} message${r.messages === 1 ? '' : 's'}`}</span>
                                            )}
                                            <span className="text-cl-muted">
                                                {r.pinsSaved > 0 && `, ${r.pinsSaved} pin${r.pinsSaved === 1 ? '' : 's'} saved and pinned`}
                                                {r.pinsNoRoom > 0 && `, ${r.pinsNoRoom} pin${r.pinsNoRoom === 1 ? '' : 's'} not saved (storage full)`}
                                                {r.filesSkipped.length > 0 && `, ${r.filesSkipped.length} file${r.filesSkipped.length === 1 ? '' : 's'} not copied`}
                                                {!!r.messagesSkipped && `, ${r.messagesSkipped.toLocaleString()} message${r.messagesSkipped === 1 ? '' : 's'} could not be copied (${r.skipReason ?? 'unknown reason'})`}
                                                {!r.error && historyTruncatedNote(r)}
                                            </span>
                                            {r.notes?.map((n, i) => <div key={i} className="text-[12px] text-cl-faint">{n}</div>)}
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        )}
                        {report.emojisSkipped.length > 0 && (
                            <div>
                                <button type="button" className="dlg-linkbtn" onClick={() => setShowSkippedEmoji(s => !s)} aria-expanded={showSkippedEmoji} aria-controls={skippedId}>
                                    {showSkippedEmoji ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                    {report.emojisSkipped.length} emoji{report.emojisSkipped.length === 1 ? '' : 's'} skipped
                                </button>
                                {showSkippedEmoji && (
                                    <ul id={skippedId} className="m-0 mt-2 p-0 list-none space-y-1 max-h-[140px] overflow-y-auto">
                                        {report.emojisSkipped.map((s, i) => (
                                            <li key={i} className="text-[12px]"><span className="text-cl-text font-semibold">:{s.name}:</span><span className="text-cl-faint"> — {s.reason}</span></li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        )}
                        <DialogNote tone="info" icon={<KeyRound size={15} aria-hidden="true" />}>
                            You’re done with the bot. In the Developer Portal you can reset its token or delete the application, and you can remove
                            the bot from your Discord server. <button type="button" className="dlg-linkbtn" onClick={() => { void deps?.api.forget().then(() => setForgotten(true)); }} disabled={forgotten || !deps}>
                                {forgotten ? 'Token forgotten' : 'Forget the saved token now'}
                            </button>
                        </DialogNote>
                    </DialogStack>
                </DialogBody>
                {dismissAsk && retryChannels.length > 0 && (
                    <div className="px-5 pb-1">
                        <DialogNote tone="warn" icon={<AlertTriangle size={15} aria-hidden="true" />} role="alert" data-testid="dismiss-ask">
                            Dismiss without retrying? The Retry button goes away, but you can still copy {retryChannels.length === 1 ? `#${retryChannels[0].name}` : 'those channels'} later: the server’s menu → Copy messages from Discord.
                            <div className="flex flex-wrap gap-2 mt-2">
                                <ClButton type="button" size="sm" variant="ghost" onClick={() => setDismissAsk(false)} autoFocus>Keep it</ClButton>
                                <span data-testid="dismiss-confirm">
                                    <ClButton type="button" size="sm" variant="ghost" onClick={() => { setDismissAsk(false); dismissImportJob(); onClose(); }}>Dismiss</ClButton>
                                </span>
                            </div>
                        </DialogNote>
                    </div>
                )}
                <DialogFooter hint={copy ? undefined : retryChannels.length > 0 ? undefined : 'Invite people from the new server’s menu'}>
                    {retryChannels.length > 0 && (
                        <span data-testid="import-dismiss" className="contents">
                            <ClButton type="button" variant="ghost" size="sm" onClick={() => setDismissAsk(true)} disabled={dismissAsk}>Dismiss</ClButton>
                        </span>
                    )}
                    <ClButton type="button" variant="ghost" size="sm" onClick={onClose}>Close</ClButton>
                    <ClButton type="button" size="sm" onClick={() => {
                        // Imported messages: the "server save" popup comes first, once (owner decision 3).
                        if (hReports && hReports.some(r => r.savable.length > 0) && history) { setKeep(true); return; }
                        openServer(report.serverId, report.serverName);
                    }}>Open server</ClButton>
                </DialogFooter>
            </>
        );
    }

    // ── Messages being copied (or stopped by an error) ──
    const hp = job.hProgress;
    if (report && hp && (job.phase === 'history' || job.phase === 'history-failed')) {
        const hFailed = job.phase === 'history-failed';
        const pct = Math.round(((hp.channelIndex + (hp.total > 0 ? Math.min(1, hp.done / hp.total) : 0)) / Math.max(1, hp.channels)) * 100);
        const phaseLabel = ({
            reading: `Reading #${hp.channelName} from Discord`,
            files: `Copying files in #${hp.channelName}`,
            posting: `Copying messages in #${hp.channelName}${hp.total ? ` (${Math.min(hp.done, hp.total).toLocaleString()} of ${hp.total.toLocaleString()})` : ''}`,
            pins: `Saving and pinning the pins of #${hp.channelName}`,
            done: `#${hp.channelName} done`,
        } as const)[hp.phase];
        return (
            <>
                {header(SUBTITLE.run)}
                <DialogBody>
                    <DialogStack>
                        <div role="status" aria-live="polite" className="text-[13.5px] text-cl-text font-semibold" data-testid="run-label">
                            {hFailed ? 'Copying messages stopped' : job.stopping ? 'Stopping…' : phaseLabel}
                        </div>
                        <div role="progressbar" aria-label="Message copy progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={hFailed ? undefined : pct}>
                            <ClProgress value={hFailed ? 0 : pct} style={{ width: '100%' }} />
                        </div>
                        <div className="dlg-help">
                            {hFailed ? 'The server and everything copied so far are kept.'
                                : `Channel ${hp.channelIndex + 1} of ${hp.channels}. Messages are encrypted on this computer before they are sent; nobody is notified.`}
                        </div>
                        {!hFailed && (
                            <DialogNote tone="info" data-testid="background-note">
                                <b>{report.serverName}</b> is already open for use. You can close this window and keep chatting: the import
                                keeps going, and its progress stays at the top of the window.
                            </DialogNote>
                        )}
                        {stopAsk && (
                            <DialogNote tone="warn" icon={<AlertTriangle size={15} aria-hidden="true" />} role="alert">
                                Stop copying messages? You can keep what was copied so far, or delete all of it.
                                <div className="flex flex-wrap gap-2 mt-2">
                                    <ClButton type="button" size="sm" variant="ghost" onClick={() => setStopAsk(false)} autoFocus>Keep going</ClButton>
                                    <ClButton type="button" size="sm" variant="ghost" onClick={() => { setStopAsk(false); void stopImportJobHistory(false); }}>Stop and keep</ClButton>
                                    <ClButton type="button" size="sm" variant="danger" onClick={() => { setStopAsk(false); void stopImportJobHistory(true); }}>Stop and delete what was copied</ClButton>
                                </div>
                            </DialogNote>
                        )}
                    </DialogStack>
                </DialogBody>
                {job.hError && <DialogError>{job.hError}</DialogError>}
                <DialogFooter hint={hFailed ? undefined : 'Closing this window doesn’t stop the import'}>
                    {hFailed ? (
                        <ClButton type="button" size="sm" onClick={() => setShowReport(true)}>See the report</ClButton>
                    ) : (
                        <>
                            <ClButton type="button" variant="ghost" size="sm" onClick={() => setStopAsk(true)} disabled={stopAsk || job.stopping}>Stop</ClButton>
                            <ClButton type="button" size="sm" onClick={onClose} data-testid="import-hide">Keep using Cipherline</ClButton>
                        </>
                    )}
                </DialogFooter>
            </>
        );
    }

    // ── Building the server (or that failed / was cancelled) ──
    const failed = job.phase === 'structure-failed' || job.phase === 'cancelled';
    const progress = job.progress;
    const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
    return (
        <>
            {header(SUBTITLE.run)}
            <DialogBody>
                <DialogStack>
                    <div role="status" aria-live="polite" className="text-[13.5px] text-cl-text font-semibold" data-testid="run-label">
                        {job.phase === 'cancelled' ? 'Cancelled' : failed ? 'Something went wrong' : (progress?.label ?? 'Starting…')}
                    </div>
                    <div role="progressbar" aria-label="Import progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={failed ? undefined : pct}>
                        <ClProgress value={failed ? 0 : pct} style={{ width: '100%' }} />
                    </div>
                    <div className="dlg-help">
                        {job.phase === 'cancelled' ? 'Nothing was created.'
                            : failed ? 'Nothing is lost: trying again continues where it stopped and never makes a second server.'
                                : 'This takes a moment. Emojis are added a few at a time so Cipherline’s limits are respected. You can close this window: the import keeps going.'}
                    </div>
                </DialogStack>
            </DialogBody>
            {job.phase === 'structure-failed' && job.error && <DialogError>{job.error}</DialogError>}
            <DialogFooter hint={failed ? 'Your Discord server is only read, never changed' : 'Closing this window doesn’t stop the import'}>
                {job.phase === 'cancelled' ? (
                    <ClButton type="button" size="sm" onClick={() => { dismissImportJob(); onClose(); }}>Close</ClButton>
                ) : failed ? (
                    <>
                        {job.created ? (
                            <ClButton type="button" variant="ghost" size="sm" onClick={() => openServer(job.created!.id, job.created!.name)}>
                                Open the server anyway
                            </ClButton>
                        ) : onBackToSetup ? (
                            <ClButton type="button" variant="ghost" size="sm" onClick={() => { dismissImportJob(); onBackToSetup(null); }}>Back</ClButton>
                        ) : (
                            <ClButton type="button" variant="ghost" size="sm" onClick={() => { dismissImportJob(); onClose(); }}>Close</ClButton>
                        )}
                        <ClButton type="button" size="sm" onClick={retryImportJob}>Try again</ClButton>
                    </>
                ) : (
                    <>
                        <ClButton type="button" variant="ghost" size="sm" onClick={cancelImportJob}>Cancel</ClButton>
                        <ClButton type="button" size="sm" onClick={onClose} data-testid="import-hide">Keep using Cipherline</ClButton>
                    </>
                )}
            </DialogFooter>
        </>
    );
};

export default DiscordImportProgressView;
