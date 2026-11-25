import React, { useId, useMemo, useState } from 'react';
import { createServerStickerFromBytes } from '../../utils/stickers/createServerSticker';
import axios from 'axios';
import { SERVER_NAME_MAX_GRAPHEMES } from '@cipherline/shared';
import { nameCounter, serverNameDraftError, SERVER_NAME_INPUT_MAX_UNITS } from '../../utils/serverRoleNames';
import { ChevronRight, Download, Server, Bot } from 'lucide-react';
import { ClModal, ClButton, ClInput } from '../cl';
import { useModalExit } from '../../hooks/useModalExit';
import { useAttachments } from '../../hooks/useAttachments';
import { DiscordTemplateImport } from './DiscordTemplateImport';
import { DiscordGuildImport, type DiscordGuildImportHost } from './DiscordGuildImport';
import { createDiscordHistoryHost } from '../../utils/discordImport/history/host';
import { isRunningPhase, useImportJob } from '../../utils/discordImport/backgroundImport';
import { getDiscordImportApi, type GuildImportRequest, type GuildImportResponse, type GuildPreview } from '../../utils/discordImport/types';
import { apiUrl } from '../../utils/apiPath';
import { DialogHeader, DialogBody, DialogFooter, DialogError } from '../dialog/DialogFrame';
import { DialogForm, DialogField, DialogStack } from '../dialog/DialogExtras';
import { BusyLabel } from '../dialog/BusyLabel';
import type { DiscordTemplateImportRequest, DiscordTemplatePreview } from '../../utils/discordTemplate';
import { imageUploadType, imageUploadExt } from '../../utils/imageCrop';
import { openExternalLink } from '../../utils/openExternalLink';
import '../../styles/dialog-server.css';

/**
 * "Create a Server", in the house dialog pattern (components/dialog/DialogFrame).
 * Two views share the card: the name form, and (when the caller can preview and
 * import templates) the "Import from a Discord template" flow, whose steps
 * render their own header / body / footer (DiscordTemplateImport).
 *
 * Enter submits only a non-blank name; a one-character name is refused with
 * the length message; a request in flight ignores a second submit.
 */

interface Props {
    onClose: () => void;
    onCreateServer: (name: string) => Promise<void>;
    /** "Import from a Discord template" — shown only when both are provided. */
    onPreviewTemplate?: (link: string) => Promise<DiscordTemplatePreview>;
    onImportTemplate?: (req: DiscordTemplateImportRequest) => Promise<void>;
    onUploadIcon?: (blob: Blob) => Promise<{ attachmentId: string; keyB64: string; nonceB64: string }>;
    /** "Import from Discord" (live server, via the user's own bot). Shown only in the desktop app and only
     *  when both are provided. */
    onPreviewGuild?: (guild: Record<string, unknown>) => Promise<GuildPreview>;
    /** The WHOLE import-guild answer (Dashboard: utils/discordImport/importGuildHandler). */
    onImportGuild?: (req: GuildImportRequest) => Promise<GuildImportResponse>;
    /** Messages + pins (Discord import phase 2): who is importing, and how to mint the new server's channel keys. */
    historyDeps?: { userId: string; deviceId: string; maxFileBytes: number; prepareChannelKeys(serverId: string, channelIds: string[]): Promise<void> };
    /** The wizard's last step: open the new server (the host navigates). */
    onOpenImportedServer?: (serverId: string, serverName: string) => void | Promise<void>;
    /** Auth token — enables the optional icon upload in the import flow. */
    token?: string | null;
    /** Open straight into the import flow (tests / deep links). */
    initialMode?: 'scratch' | 'discord' | 'discord-guild';
}

export const CreateServerModal: React.FC<Props> = ({
    onClose, onCreateServer, onPreviewTemplate, onImportTemplate, onUploadIcon, onPreviewGuild, onImportGuild, onOpenImportedServer, historyDeps, token = null, initialMode = 'scratch',
}) => {
    const { uploadEncryptedFile } = useAttachments(token);
    // Encrypted upload — the same primitive and file name Server Settings uses
    // for a server icon; the import request then carries the key/nonce exactly
    // like PATCH /servers/:id does.
    const uploadIcon = onUploadIcon ?? (token ? (blob: Blob) => uploadEncryptedFile(blob, `server-icon.${imageUploadExt(imageUploadType(blob))}`, imageUploadType(blob)) : undefined);
    const { closing, handleClose } = useModalExit(onClose, 260);
    const nameId = useId();
    const [name, setName] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const canImport = !!onPreviewTemplate && !!onImportTemplate;
    const discordApi = getDiscordImportApi();
    const guildHost = useMemo<DiscordGuildImportHost | null>(() => {
        if (!token || !onPreviewGuild || !onImportGuild) return null;
        const auth = { headers: { Authorization: `Bearer ${token}` } };
        return {
            preview: onPreviewGuild,
            importGuild: onImportGuild,
            listEmojiNames: async (sid) => {
                const res = await axios.get<Array<{ name: string }>>(apiUrl`/servers/${sid}/emojis`, auth);
                return (res.data ?? []).map(e => e.name);
            },
            // The import's own emoji path (owner of a just-imported server, faster
            // bucket, one coalesced event); an older API (404) or a refusal (403)
            // falls back to the normal create, which the runner's 429 handling paces.
            createEmoji: async (sid, body) => {
                try { await axios.post(apiUrl`/servers/${sid}/emojis/import`, body, auth); }
                catch (e) {
                    const st = (e as { response?: { status?: number } } | null)?.response?.status;
                    if (st !== 404 && st !== 403) throw e;
                    await axios.post(apiUrl`/servers/${sid}/emojis`, body, auth);
                }
            },
            upload: (blob, mime, o) => uploadEncryptedFile(blob, 'discord-import', mime, undefined, o?.signal, o?.serverId),
            // A role's icon picture (Discord role icon): the same two calls as
            // Server Settings > Roles > Role Icon (RoleIconPicker): an encrypted
            // 'role_icon' upload, then PUT .../icon, which the API resizes and
            // re-keys. The runner paces these under the roleIcon bucket.
            // A Discord guild sticker -> a server sticker, through the stickers branch's
            // importer entry point (encrypt, upload, POST .../stickers/import: importSticker 10/10 s).
            createSticker: async (sid, s) => {
                const made = await createServerStickerFromBytes({ serverId: sid, bytes: s.bytes, name: s.name, description: s.description, tags: s.tags, token, via: 'import', signal: s.signal });
                return { sticker_id: made.sticker_id, name: made.name };
            },
            setRoleIcon: async (sid, roleId, blob, mime, signal) => {
                const up = await uploadEncryptedFile(blob, '', mime, undefined, signal, sid, 'role_icon');
                await axios.put(apiUrl`/servers/${sid}/roles/${roleId}/icon`,
                    { attachment_id: up.attachmentId, key_b64: up.keyB64, nonce_b64: up.nonceB64 }, { ...auth, signal });
            },
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- uploadEncryptedFile is recreated each render but only closes over `token`
    }, [token, onPreviewGuild, onImportGuild]);
    const canImportGuild = !!discordApi && !!guildHost;
    /** One import at a time: while one runs, this choice opens its progress instead of a new wizard. */
    const importJob = useImportJob();
    const importRunning = isRunningPhase(importJob?.phase);
    const historyHost = useMemo(() => (token && historyDeps && discordApi?.history
        ? createDiscordHistoryHost({ token, userId: historyDeps.userId, deviceId: historyDeps.deviceId, maxFileBytes: historyDeps.maxFileBytes, prepareChannelKeys: historyDeps.prepareChannelKeys })
        : undefined), [token, historyDeps, discordApi]);
    const [mode, setMode] = useState<'scratch' | 'discord' | 'discord-guild'>(
        initialMode === 'discord-guild' ? (canImportGuild ? 'discord-guild' : 'scratch') : canImport ? initialMode : 'scratch',
    );

    const handleSubmit = async () => {
        if (loading || !name.trim()) return;
        const trimmed = name.trim();
        const nameProblem = serverNameDraftError(trimmed);
        if (nameProblem) { setError(nameProblem); return; }
        setLoading(true);
        setError(null);
        try {
            await onCreateServer(trimmed);
            handleClose();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- caught value is dynamic (axios / DOMException / Error); fields are read defensively
        } catch (err: any) {
            setError(err?.response?.data?.message ?? 'Failed to create server');
        } finally {
            setLoading(false);
        }
    };

    const importing = mode === 'discord' && canImport;
    const importingGuild = mode === 'discord-guild' && canImportGuild;

    return (
        <ClModal
            open={!closing}
            onClose={handleClose}
            width={importing || importingGuild ? 600 : 440}
            label={importingGuild ? 'Import from Discord' : importing ? 'Import a Discord template' : 'Create a Server'}
            cardClassName="dlg-card dlg-card--srv"
        >
            {importingGuild ? (
                <DiscordGuildImport
                    api={discordApi!}
                    host={guildHost!}
                    history={historyHost}
                    onBack={() => setMode('scratch')}
                    onClose={handleClose}
                    onOpenServer={async (id, n) => { await onOpenImportedServer?.(id, n); handleClose(); }}
                    onOpenExternal={(url) => { openExternalLink(url, { source: 'app' }); }}
                />
            ) : importing ? (
                <DiscordTemplateImport
                    onPreview={onPreviewTemplate!}
                    onUploadIcon={uploadIcon}
                    onImport={async (req) => { await onImportTemplate!(req); handleClose(); }}
                    onBack={() => setMode('scratch')}
                />
            ) : (
                <>
                    <DialogHeader
                        icon={<Server size={18} strokeWidth={2.2} />}
                        title="Create a Server"
                        subtitle="Invite-only. Share an invite link after you create it."
                    />
                    <DialogForm onSubmit={handleSubmit}>
                        <DialogBody>
                            <DialogStack>
                                <DialogField label="Server name" htmlFor={nameId} aside={nameCounter(name, SERVER_NAME_MAX_GRAPHEMES)} help={serverNameDraftError(name) ?? 'Emoji, symbols and any letters work - paste what you like'}>
                                    <ClInput
                                        id={nameId}
                                        autoFocus
                                        autoComplete="off"
                                        value={name}
                                        onChange={e => { setName(e.target.value); setError(null); }}
                                        placeholder="My Awesome Server"
                                        maxLength={SERVER_NAME_INPUT_MAX_UNITS}
                                        aria-invalid={error || serverNameDraftError(name) ? true : undefined}
                                    />
                                </DialogField>
                                {canImport && (
                                    <button
                                        type="button"
                                        className="dlg-choice"
                                        onClick={() => { setMode('discord'); setError(null); }}
                                    >
                                        <span className="dlg-choice-ico" aria-hidden="true"><Download size={16} /></span>
                                        <span className="dlg-choice-text">
                                            <span className="dlg-choice-title">Import from a Discord template</span>
                                            <span className="dlg-choice-sub">Paste a discord.new link to copy its channels, roles and permissions</span>
                                        </span>
                                        <ChevronRight size={16} className="dlg-choice-chev" aria-hidden="true" />
                                    </button>
                                )}
                                {canImportGuild && (
                                    <button
                                        type="button"
                                        className="dlg-choice"
                                        data-testid="import-discord-server"
                                        onClick={() => { setMode('discord-guild'); setError(null); }}
                                    >
                                        <span className="dlg-choice-ico" aria-hidden="true"><Bot size={16} /></span>
                                        <span className="dlg-choice-text">
                                            <span className="dlg-choice-title">Import from a Discord server</span>
                                            <span className="dlg-choice-sub">
                                                {importRunning && importJob
                                                    ? `Importing ${importJob.serverName} now (${importJob.percent}%): open to see its progress`
                                                    : 'Use a read-only bot you create to copy a server you run: roles, channels, permissions, icon and emojis'}
                                            </span>
                                        </span>
                                        <ChevronRight size={16} className="dlg-choice-chev" aria-hidden="true" />
                                    </button>
                                )}
                            </DialogStack>
                        </DialogBody>
                        {error && <DialogError>{error}</DialogError>}
                        <DialogFooter hint={loading ? 'Creating your server…' : undefined}>
                            <ClButton type="button" variant="ghost" size="sm" onClick={handleClose}>Cancel</ClButton>
                            <ClButton type="submit" size="sm" disabled={!name.trim()} className={loading ? 'dlg-busy' : undefined}>
                                <BusyLabel busy={loading}>Create server</BusyLabel>
                            </ClButton>
                        </DialogFooter>
                    </DialogForm>
                </>
            )}
        </ClModal>
    );
};

export default CreateServerModal;
