import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { ClButton, ClModal } from '../../cl';
import { useModalExit } from '../../../hooks/useModalExit';
import { DialogHeader, DialogBody, DialogFooter } from '../../dialog/DialogFrame';
import { DialogNote } from '../../dialog/DialogExtras';
import { DiscordGuildImport, type DiscordGuildImportHost } from '../DiscordGuildImport';
import { createDiscordHistoryHost } from '../../../utils/discordImport/history/host';
import { getDiscordImportApi } from '../../../utils/discordImport/types';
import type { CopyTargetChannel } from '../../../utils/discordImport/copyMapping';
import '../../../styles/dialog-server.css';

/**
 * "Copy messages from Discord" on an EXISTING server (server menu; owner or IMPORT_HISTORY). The same
 * wizard as "Import from Discord" (token, add the bot, pick the server), then a mapping step instead of
 * "new server" options, then the app-level job (utils/discordImport/backgroundImport.ts startCopyJob).
 */
export interface CopyFromDiscordModalProps {
    serverId: string;
    serverName: string;
    token: string | null;
    historyDeps?: {
        userId: string; deviceId: string; maxFileBytes: number;
        prepareChannelKeys(serverId: string, channelIds: string[]): Promise<void>;
        existingChannelKeys?(serverId: string, channelIds: string[]): Promise<string[]>;
    };
    /** The server's text channels (the copy targets), fresh. */
    loadTextChannels(serverId: string): Promise<CopyTargetChannel[]>;
    onClose: () => void;
    onOpenServer: (serverId: string, serverName: string) => void | Promise<void>;
}

/** A copy never creates a server: the structure half of the wizard's host is never called. */
const notUsed = async (): Promise<never> => { throw new Error('Not used when copying into an existing server'); };
const NO_STRUCTURE: DiscordGuildImportHost = {
    preview: notUsed, importGuild: notUsed, listEmojiNames: async () => [], createEmoji: notUsed, upload: notUsed,
};

export const CopyFromDiscordModal: React.FC<CopyFromDiscordModalProps> = ({ serverId, serverName, token, historyDeps, loadTextChannels, onClose, onOpenServer }) => {
    const { closing, handleClose } = useModalExit(onClose, 260);
    const api = getDiscordImportApi();
    const history = useMemo(() => (token && historyDeps && api?.history ? createDiscordHistoryHost({ token, ...historyDeps }) : undefined), [token, historyDeps, api]);
    const [channels, setChannels] = useState<CopyTargetChannel[] | null>(null);
    const [loadErr, setLoadErr] = useState(false);
    // Loaded once per server (the host passes a fresh function every render).
    const loadRef = useRef(loadTextChannels);
    useEffect(() => {
        let live = true;
        loadRef.current(serverId).then(c => { if (live) setChannels(c); }, () => { if (live) setLoadErr(true); });
        return () => { live = false; };
    }, [serverId]);

    const unavailable = !api || !history;
    return (
        <ClModal open={!closing} onClose={handleClose} width={600} label="Copy messages from Discord" cardClassName="dlg-card dlg-card--srv">
            {unavailable || loadErr || channels === null ? (
                <>
                    <DialogHeader icon={<Download size={18} strokeWidth={2.2} />} title="Copy messages from Discord" subtitle={serverName} />
                    <DialogBody>
                        <DialogNote tone={unavailable || loadErr ? 'warn' : 'info'} role="status">
                            {unavailable ? 'Copying from Discord needs the Cipherline desktop app.'
                                : loadErr ? 'Couldn’t load this server’s channels. Close this and try again.'
                                    : 'Loading the server’s channels…'}
                        </DialogNote>
                    </DialogBody>
                    <DialogFooter><ClButton type="button" size="sm" onClick={handleClose}>Close</ClButton></DialogFooter>
                </>
            ) : (
                <DiscordGuildImport
                    api={api!}
                    host={NO_STRUCTURE}
                    history={history}
                    copyInto={{ serverId, serverName, channels }}
                    onBack={handleClose}
                    onClose={handleClose}
                    onOpenServer={async (id, n) => { await onOpenServer(id, n); handleClose(); }}
                    onOpenExternal={(url) => { void window.electronAPI?.openExternal(url); }}
                />
            )}
        </ClModal>
    );
};

export default CopyFromDiscordModal;
