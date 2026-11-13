import React, { useId, useState } from 'react';
import { ChevronRight, Download, Server } from 'lucide-react';
import { ClModal, ClButton, ClInput } from '../cl';
import { useModalExit } from '../../hooks/useModalExit';
import { useAttachments } from '../../hooks/useAttachments';
import { DiscordTemplateImport } from './DiscordTemplateImport';
import { DialogHeader, DialogBody, DialogFooter, DialogError } from '../dialog/DialogFrame';
import { DialogForm, DialogField, DialogStack } from '../dialog/DialogExtras';
import { BusyLabel } from '../dialog/BusyLabel';
import type { DiscordTemplateImportRequest, DiscordTemplatePreview } from '../../utils/discordTemplate';
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
    /** Auth token — enables the optional icon upload in the import flow. */
    token?: string | null;
    /** Open straight into the import flow (tests / deep links). */
    initialMode?: 'scratch' | 'discord';
}

export const CreateServerModal: React.FC<Props> = ({
    onClose, onCreateServer, onPreviewTemplate, onImportTemplate, onUploadIcon, token = null, initialMode = 'scratch',
}) => {
    const { uploadEncryptedFile } = useAttachments(token);
    // Encrypted upload — the same primitive and file name Server Settings uses
    // for a server icon; the import request then carries the key/nonce exactly
    // like PATCH /servers/:id does.
    const uploadIcon = onUploadIcon ?? (token ? (blob: Blob) => uploadEncryptedFile(blob, 'server-icon.jpg', 'image/jpeg') : undefined);
    const { closing, handleClose } = useModalExit(onClose, 260);
    const nameId = useId();
    const [name, setName] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const canImport = !!onPreviewTemplate && !!onImportTemplate;
    const [mode, setMode] = useState<'scratch' | 'discord'>(canImport ? initialMode : 'scratch');

    const handleSubmit = async () => {
        if (loading || !name.trim()) return;
        const trimmed = name.trim();
        if (trimmed.length < 2) { setError('Server name must be at least 2 characters'); return; }
        if (trimmed.length > 50) { setError('Server name must be 50 characters or less'); return; }
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

    return (
        <ClModal
            open={!closing}
            onClose={handleClose}
            width={importing ? 600 : 440}
            label={importing ? 'Import a Discord template' : 'Create a Server'}
            cardClassName="dlg-card dlg-card--srv"
        >
            {importing ? (
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
                                <DialogField label="Server name" htmlFor={nameId} aside={`${name.length}/50`} help="Letters, numbers, spaces and . - _ '">
                                    <ClInput
                                        id={nameId}
                                        autoFocus
                                        autoComplete="off"
                                        value={name}
                                        onChange={e => setName(e.target.value.replace(/[^a-zA-Z0-9 '\-_.]/g, ''))}
                                        placeholder="My Awesome Server"
                                        maxLength={50}
                                        aria-invalid={error ? true : undefined}
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
