import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ClModal } from '../../cl';
import { useModalExit } from '../../../hooks/useModalExit';
import { useToast } from '../../../contexts/ToastContext';
import {
    abortImportJob, endInterruptedImportSession, importJobIssues, onImportJobFinished, useImportJob,
} from '../../../utils/discordImport/backgroundImport';
import { DiscordImportProgressView } from './DiscordImportProgressView';
import { ImportPill } from './ImportPill';
import { importPillModel } from './importPillModel';
import '../../../styles/dialog-server.css';

/**
 * The Discord import while the wizard is closed (owner 2026-11-22: "do other
 * stuff while servers are importing"). Mounted once, in the Dashboard title
 * bar:
 *   - the PILL (ImportPill), centred in the title bar (visible in every view,
 *     covers no content): "Importing <server> 42%", then "<server> imported ·
 *     See report"; clicking it opens the progress / report view;
 *   - the MODAL that view lives in (the same view the wizard shows);
 *   - the "Import finished" TOAST when it finishes with no view open, whose
 *     button opens the report (and from there the "server save" popup);
 *   - signing out (this unmounting with the Dashboard) aborts the job.
 */
export interface DiscordImportHostProps {
    onOpenServer: (serverId: string, serverName: string) => void | Promise<void>;
    /** End this account's open import session in a server, keeping what it copied (POST .../imports/active/end). */
    endInterruptedSession?: (serverId: string) => Promise<unknown>;
}

const ImportJobModal: React.FC<{ onClose: () => void; onOpenServer: DiscordImportHostProps['onOpenServer'] }> = ({ onClose, onOpenServer }) => {
    const { closing, handleClose } = useModalExit(onClose, 260);
    return (
        <ClModal open={!closing} onClose={handleClose} width={600} label="Import from Discord" cardClassName="dlg-card dlg-card--srv">
            <DiscordImportProgressView
                onClose={handleClose}
                onOpenServer={async (id, name) => { await onOpenServer(id, name); handleClose(); }}
            />
        </ClModal>
    );
};

export const DiscordImportHost: React.FC<DiscordImportHostProps> = ({ onOpenServer, endInterruptedSession }) => {
    const job = useImportJob();
    const toast = useToast();
    const [open, setOpen] = useState(false);
    const openRef = useRef(open);
    useEffect(() => { openRef.current = open; }, [open]);

    // Finished while nothing showed it: say so, with a way to the report.
    useEffect(() => onImportJobFinished((j) => {
        if (j.seen || openRef.current) return;
        const ok = j.phase === 'done';
        const issues = importJobIssues(j);
        if (ok && issues.any) {
            // Issues: a red toast that stays until dismissed (the pill keeps the warning after that).
            const failedNames = issues.failed.map(r => `#${r.name}`);
            const parts = [
                failedNames.length ? `${failedNames.slice(0, 3).join(', ')}${failedNames.length > 3 ? ` and ${failedNames.length - 3} more` : ''} didn’t come over.` : '',
                issues.filesSkipped ? `${issues.filesSkipped.toLocaleString()} file${issues.filesSkipped === 1 ? '' : 's'} couldn’t be copied.` : '',
                issues.partial.length ? `${issues.partial.length} channel${issues.partial.length === 1 ? '' : 's'} only partly came over.` : '',
            ].filter(Boolean);
            toast.push({
                kind: 'error',
                title: j.kind === 'copy' ? 'Copy finished — issues found' : 'Import finished — issues found',
                message: parts.join(' ') || 'Some messages couldn’t be copied.',
                durationMs: 0,
                action: { label: issues.retryable.length ? 'Review and retry' : 'See the report', onClick: () => setOpen(true) },
            });
            return;
        }
        toast.push({
            kind: ok ? 'success' : 'warning',
            title: ok ? (j.kind === 'copy' ? 'Messages copied' : 'Import finished') : 'Import stopped',
            message: ok ? (j.kind === 'copy' ? `Discord messages are in ${j.serverName}.` : `${j.serverName} is ready.`) : `Copying messages into ${j.serverName} stopped. What was copied is kept.`,
            durationMs: 12_000,
            action: { label: 'See the report', onClick: () => setOpen(true) },
        });
    }), [toast]);

    // Signing out / switching account unmounts the Dashboard: the job holds that account's token and keys.
    useEffect(() => () => abortImportJob(), []);

    // Once per sign-in: a session a crash left open is ended (keeps what was copied).
    const recovered = useRef(false);
    useEffect(() => {
        if (!endInterruptedSession || recovered.current) return;
        recovered.current = true;
        void endInterruptedImportSession(endInterruptedSession).catch(() => undefined);
    }, [endInterruptedSession]);

    const close = useCallback(() => setOpen(false), []);

    // A view is on screen (this modal, or the wizard's): the pill steps aside.
    const showPill = !!job && !open && !job.viewing && job.phase !== 'cancelled';
    return (
        <>
            {showPill && (
                <ImportPill
                    model={importPillModel(job, importJobIssues(job))}
                    onClick={() => setOpen(true)}
                    title={job.guildName ? `From the Discord server ${job.guildName}` : undefined}
                />
            )}
            {open && <ImportJobModal onClose={close} onOpenServer={onOpenServer} />}
        </>
    );
};

export default DiscordImportHost;
