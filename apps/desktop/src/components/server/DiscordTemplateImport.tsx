import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Download, Hash, ImagePlus, Lock, ShieldCheck, Volume2, X } from 'lucide-react';
import { ClButton, ClInput, ClImageCropper } from '../cl';
import { DialogHeader, DialogBody, DialogFooter, DialogError } from '../dialog/DialogFrame';
import { DialogForm, DialogField, DialogStack, DialogNote, DialogSteps } from '../dialog/DialogExtras';
import { BusyLabel } from '../dialog/BusyLabel';
import { IMAGE_ACCEPT_ATTR, validateImageUpload } from '../../utils/imageUploadValidation';
import { ChannelIconRenderer } from './ChannelIconPicker';
import { AVATAR_OUTPUT } from '../../utils/imageCrop';
import {
    buildPreviewTree,
    looksLikeTemplateLink,
    roleColorCss,
    rolesForDisplay,
    sanitizeServerNameInput,
    templateErrorMessage,
    type DiscordTemplateImportRequest,
    type DiscordTemplatePreview,
    type PreviewGroup,
} from '../../utils/discordTemplate';
import '../../styles/dialog-server.css';

export interface DiscordTemplateImportProps {
    /** POST /v1/server-templates/discord/preview (the API fetches from Discord). */
    onPreview: (link: string) => Promise<DiscordTemplatePreview>;
    /** Upload the cropped icon (encrypted, same primitive as Server Settings). */
    onUploadIcon?: (blob: Blob) => Promise<{ attachmentId: string; keyB64: string; nonceB64: string }>;
    /** POST /v1/server-templates/discord/import + the normal post-create path. */
    onImport: (req: DiscordTemplateImportRequest) => Promise<void>;
    /** Back to "start from scratch". */
    onBack: () => void;
    /** Starting link (tests / deep links). */
    initialLink?: string;
}

/**
 * "Import from a Discord template": paste link → preview (editable name,
 * channel tree, roles, what will be skipped and why) → optional icon → create.
 *
 * Renders the CONTENTS of a dlg-card ClModal (header / body / footer per
 * step), so the host card (CreateServerModal) owns the modal and its width.
 * Enter submits the current step only when it is valid; a request in flight
 * ignores a second submit.
 *
 * Privacy: the link goes to OUR API, which fetches the template; this device
 * never contacts discord.com.
 */
export const DiscordTemplateImport: React.FC<DiscordTemplateImportProps> = ({
    onPreview, onUploadIcon, onImport, onBack, initialLink = '',
}) => {
    const [link, setLink] = useState(initialLink);
    const [phase, setPhase] = useState<'link' | 'loading' | 'preview' | 'creating'>('link');
    const [error, setError] = useState<string | null>(null);
    const [preview, setPreview] = useState<DiscordTemplatePreview | null>(null);
    const [name, setName] = useState('');
    const [showSkipped, setShowSkipped] = useState(false);
    const [cropFile, setCropFile] = useState<File | null>(null);
    const [icon, setIcon] = useState<{ blob: Blob; url: string } | null>(null);
    const nameRef = useRef<HTMLInputElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const ids = { link: useId(), name: useId(), skipped: useId(), err: useId() };

    useEffect(() => () => { if (icon) URL.revokeObjectURL(icon.url); }, [icon]);
    useEffect(() => { if (phase === 'preview') nameRef.current?.focus(); }, [phase]);

    const linkOk = looksLikeTemplateLink(link);

    const submitLink = async () => {
        if (phase === 'loading' || !link.trim()) return;
        if (!linkOk) {
            setError('Paste a Discord template link, like discord.new/abc123.');
            return;
        }
        setPhase('loading');
        setError(null);
        try {
            const p = await onPreview(link.trim());
            setPreview(p);
            setName(p.blueprint.server.name.slice(0, 50));
            setPhase('preview');
        } catch (err) {
            setError(templateErrorMessage(err));
            setPhase('link');
        }
    };

    const submitCreate = async () => {
        if (!preview || phase === 'creating') return;
        const trimmed = name.trim();
        if (trimmed.length < 2) { setError('Server name must be at least 2 characters'); return; }
        setPhase('creating');
        setError(null);
        try {
            const req: DiscordTemplateImportRequest = { code: preview.code, name: trimmed };
            if (icon && onUploadIcon) {
                const up = await onUploadIcon(icon.blob);
                req.icon_attachment = up.attachmentId;
                req.icon_key_b64 = up.keyB64;
                req.icon_nonce_b64 = up.nonceB64;
            }
            await onImport(req);
        } catch (err) {
            setError(templateErrorMessage(err));
            setPhase('preview');
        }
    };

    const pickIcon = (e: React.ChangeEvent<HTMLInputElement>) => {
        const result = validateImageUpload(e.target.files?.[0]);
        if (e.target) e.target.value = '';
        if (!result.ok) { setError(result.reason); return; }
        if (result.file) setCropFile(result.file);
    };

    // ── Step 1: the link ─────────────────────────────────────────────────
    if (!preview || phase === 'link' || phase === 'loading') {
        const fetching = phase === 'loading';
        return (
            <>
                <DialogHeader
                    icon={<Download size={18} strokeWidth={2.2} />}
                    title="Import a Discord template"
                    subtitle="Channels, roles and permissions, ready to go"
                />
                <DialogForm onSubmit={() => { void submitLink(); }}>
                    <DialogBody>
                        <DialogStack>
                            <DialogField
                                label="Discord template link"
                                htmlFor={ids.link}
                                error={error}
                                errorId={ids.err}
                            >
                                <ClInput
                                    id={ids.link}
                                    autoFocus
                                    value={link}
                                    onChange={e => { setLink(e.target.value); setError(null); }}
                                    placeholder="https://discord.new/…"
                                    maxLength={200}
                                    spellCheck={false}
                                    autoComplete="off"
                                    aria-invalid={!!error}
                                    aria-describedby={error ? ids.err : undefined}
                                    disabled={fetching}
                                />
                            </DialogField>
                            <DialogNote tone="info" icon={<ShieldCheck size={15} aria-hidden="true" />}>
                                We build the channels, categories, roles and permissions for you. Cipherline fetches the
                                template itself, so your device never connects to Discord. Messages are never part of a template.
                            </DialogNote>
                            {fetching && (
                                <div className="flex flex-col gap-2" aria-hidden="true">
                                    <div className="dlg-skel" style={{ height: 16, width: 192 }} />
                                    <div className="dlg-skel" style={{ height: 12, width: '100%' }} />
                                    <div className="dlg-skel" style={{ height: 12, width: '83%' }} />
                                </div>
                            )}
                        </DialogStack>
                    </DialogBody>
                    <DialogFooter hint={fetching ? 'Fetching the template…' : <DialogSteps index={0} count={2} />}>
                        <ClButton type="button" variant="ghost" size="sm" onClick={onBack} disabled={fetching}>Back</ClButton>
                        <ClButton type="submit" size="sm" disabled={!link.trim()} className={fetching ? 'dlg-busy' : undefined}>
                            <BusyLabel busy={fetching}>Preview template</BusyLabel>
                        </ClButton>
                    </DialogFooter>
                </DialogForm>
            </>
        );
    }

    // ── Step 2: preview + create ─────────────────────────────────────────
    const bp = preview.blueprint;
    const creating = phase === 'creating';
    return (
        <>
            <DialogHeader
                icon={<Download size={18} strokeWidth={2.2} />}
                title="Import a Discord template"
                subtitle="Review it, then create your server"
            />
            <DialogForm onSubmit={() => { void submitCreate(); }}>
                <DialogBody>
                    <DialogStack>
                        <div className="dlg-identity">
                            <div className="relative shrink-0">
                                <button
                                    type="button"
                                    onClick={() => fileRef.current?.click()}
                                    disabled={!onUploadIcon || creating}
                                    className="w-14 h-14 rounded-2xl bg-cl-surface border border-cl-border flex items-center justify-center text-cl-faint hover:text-cl-text hover:border-cl-lume/40 transition-colors overflow-hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-cl-lume"
                                    aria-label={icon ? 'Change server icon' : 'Add a server icon (optional)'}
                                    title={icon ? 'Change icon' : 'Add an icon (optional)'}
                                >
                                    {icon ? <img src={icon.url} alt="" className="w-full h-full object-cover" /> : <ImagePlus size={20} />}
                                </button>
                                {icon && !creating && (
                                    <button
                                        type="button"
                                        onClick={() => setIcon(null)}
                                        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-cl-deep border border-cl-border text-cl-muted hover:text-cl-text flex items-center justify-center"
                                        aria-label="Remove icon"
                                    >
                                        <X size={11} />
                                    </button>
                                )}
                                <input ref={fileRef} type="file" accept={IMAGE_ACCEPT_ATTR} className="hidden" onChange={pickIcon} tabIndex={-1} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <DialogField label="Server name" htmlFor={ids.name} aside={`${name.length}/50`}>
                                    <ClInput
                                        id={ids.name}
                                        ref={nameRef}
                                        autoComplete="off"
                                        value={name}
                                        onChange={e => { setName(sanitizeServerNameInput(e.target.value)); setError(null); }}
                                        maxLength={50}
                                        disabled={creating}
                                    />
                                </DialogField>
                            </div>
                        </div>

                        <div className="dlg-help flex items-baseline gap-1 min-w-0">
                            <span className="shrink-0">From Discord template</span>
                            <span className="truncate text-cl-muted font-semibold min-w-0" title={preview.template.name}>{preview.template.name}</span>
                            <span className="shrink-0">
                                · {bp.channels.length} channel{bp.channels.length === 1 ? '' : 's'}
                                {' · '}{bp.roles.length} role{bp.roles.length === 1 ? '' : 's'}
                            </span>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-[1.4fr_1fr]">
                            <section aria-label="Channels" className="rounded-xl bg-cl-sink/60 border border-cl-border p-3 max-h-[240px] overflow-y-auto">
                                <ChannelTree preview={preview} />
                            </section>
                            <section aria-label="Roles" className="rounded-xl bg-cl-sink/60 border border-cl-border p-3 max-h-[240px] overflow-y-auto">
                                <h3 className="text-[11px] uppercase tracking-wide text-cl-faint font-semibold m-0 mb-2">Roles</h3>
                                <ul className="m-0 p-0 list-none space-y-1.5">
                                    {rolesForDisplay(bp).map(r => (
                                        <li key={r.ref} className="flex items-center gap-2 text-[13px] text-cl-text min-w-0">
                                            <span
                                                className="w-2.5 h-2.5 rounded-full shrink-0 border border-white/10"
                                                style={{ background: roleColorCss(r.color) ?? 'transparent' }}
                                                aria-hidden="true"
                                            />
                                            <span className="truncate" style={{ color: roleColorCss(r.color) ?? undefined }}>{r.name}</span>
                                        </li>
                                    ))}
                                    <li className="flex items-center gap-2 text-[13px] text-cl-muted">
                                        <span className="w-2.5 h-2.5 rounded-full shrink-0 border border-white/10" aria-hidden="true" />
                                        @everyone
                                    </li>
                                </ul>
                                <p className="text-[11px] text-cl-faint mt-2 mb-0 leading-snug">You’re the owner, above every role.</p>
                            </section>
                        </div>

                        {bp.warnings.length > 0 && (
                            <ul className="m-0 p-0 list-none flex flex-col gap-2" aria-label="Before you create">
                                {bp.warnings.map(w => (
                                    <li key={w}>
                                        <DialogNote tone="warn" icon={<AlertTriangle size={15} aria-hidden="true" />}>{w}</DialogNote>
                                    </li>
                                ))}
                            </ul>
                        )}

                        {bp.skipped.length > 0 && (
                            <div>
                                <button
                                    type="button"
                                    onClick={() => setShowSkipped(s => !s)}
                                    aria-expanded={showSkipped}
                                    aria-controls={ids.skipped}
                                    className="dlg-linkbtn"
                                >
                                    {showSkipped ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                    What won’t be imported ({bp.skipped.length})
                                </button>
                                {showSkipped && (
                                    <ul id={ids.skipped} className="m-0 mt-2 p-0 list-none space-y-1.5 max-h-[160px] overflow-y-auto">
                                        {bp.skipped.map((s, i) => (
                                            <li key={`${s.item}-${i}`} className="text-[12px] leading-snug">
                                                <span className="text-cl-text font-semibold">{s.item}</span>
                                                <span className="text-cl-faint"> — {s.reason}</span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        )}
                    </DialogStack>
                </DialogBody>
                {error && <DialogError>{error}</DialogError>}
                <DialogFooter hint={creating ? 'Creating your server…' : <DialogSteps index={1} count={2} />}>
                    <ClButton
                        type="button" variant="ghost" size="sm"
                        onClick={() => { setPreview(null); setPhase('link'); setError(null); }}
                        disabled={creating}
                    >
                        Use a different link
                    </ClButton>
                    <ClButton type="submit" size="sm" disabled={name.trim().length < 2} className={creating ? 'dlg-busy' : undefined}>
                        <BusyLabel busy={creating}>Create server</BusyLabel>
                    </ClButton>
                </DialogFooter>
            </DialogForm>

            <ClImageCropper
                open={!!cropFile}
                file={cropFile}
                outputWidth={AVATAR_OUTPUT.width}
                outputHeight={AVATAR_OUTPUT.height}
                shape="rect"
                title="Position the server icon"
                onCancel={() => setCropFile(null)}
                onConfirm={(blob: Blob) => {
                    setCropFile(null);
                    setIcon({ blob, url: URL.createObjectURL(blob) });
                }}
            />
        </>
    );
};

/** The channel tree, arranged the way the new server will show it. */
const ChannelTree: React.FC<{ preview: DiscordTemplatePreview }> = ({ preview }) => {
    const tree = useMemo(() => buildPreviewTree(preview.blueprint), [preview]);
    const panel = (title: string, groups: PreviewGroup[], kind: 'text' | 'huddle') => groups.length > 0 && (
        <div className="mb-3 last:mb-0">
            <h3 className="text-[11px] uppercase tracking-wide text-cl-faint font-semibold m-0 mb-1.5">{title}</h3>
            {groups.map(g => (
                <div key={g.category?.ref ?? `none-${kind}`} className="mb-2 last:mb-0">
                    {g.category && (
                        <div className="flex items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-cl-muted mb-0.5">
                            <span className="truncate">{g.category.name}</span>
                            {g.category.private && <Lock size={10} aria-label="Private" />}
                        </div>
                    )}
                    <ul className="m-0 p-0 list-none">
                        {g.channels.map(c => (
                            <li key={c.ref} className="flex items-center gap-1.5 text-[13px] text-cl-text py-[1px] pl-1 min-w-0" title={c.topic ?? undefined}>
                                {c.icon_name
                                    ? <ChannelIconRenderer name={c.icon_name} size={13} className="text-cl-faint shrink-0" />
                                    : kind === 'text'
                                        ? <Hash size={13} className="text-cl-faint shrink-0" aria-hidden="true" />
                                        : <Volume2 size={13} className="text-cl-faint shrink-0" aria-hidden="true" />}
                                <span className="truncate">{c.name}</span>
                                {c.private && <Lock size={11} className="text-cl-faint shrink-0" aria-label="Private" />}
                                {preview.blueprint.server.system_channel_ref === c.ref && (
                                    <span className="text-[10px] text-cl-faint shrink-0">· system</span>
                                )}
                            </li>
                        ))}
                        {g.channels.length === 0 && <li className="text-[12px] text-cl-faint pl-1">(empty)</li>}
                    </ul>
                </div>
            ))}
        </div>
    );
    return (
        <>
            {panel('Text channels', tree.text, 'text')}
            {panel('Calls', tree.calls, 'huddle')}
        </>
    );
};

export default DiscordTemplateImport;
