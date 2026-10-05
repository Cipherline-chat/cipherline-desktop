/**
 * ServerSettingsModal — 7-tab modal for managing a server's settings.
 *
 * Tabs:
 *   1. Overview   — name editing (MANAGE_SERVER)
 *   2. Roles      — list/create/edit/delete (MANAGE_ROLES)
 *   3. Members    — search/kick/ban/mute/nickname (KICK/BAN/MUTE/MANAGE_NICKNAMES)
 *   4. Invites    — full invite history (active + expired), revoke (MANAGE_SERVER).
 *                  The quick-share modal only ever creates and copies; this
 *                  is where invites are audited.
 *   5. Emojis     — upload/rename/delete this server's custom emojis
 *                  (MANAGE_EMOJIS). See docs/custom-emoji-design.md. The
 *                  picker/message-renderer consumers of the emoji list are a
 *                  separate phase — this tab only manages the set.
 *   6. Bans       — list banned users, unban (BAN_MEMBERS)
 *   7. Audit Log  — paginated action history (VIEW_AUDIT_LOG)
 *
 * Channel/category creation, editing, and permission overrides live in the
 * right-click context menus of the channel sidebar itself (ChannelSettingsDialog
 * / CategoryFormDialog) — there is no Channels tab here anymore; it duplicated
 * that UI with no capability of its own.
 *
 * The server enforces all permission checks; the UI makes the calls and
 * surfaces errors returned by the API.
 */
import React, { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import axios from 'axios';
import { ClButton } from '../ClButton';
import { ClModal, ClSelect, ClInput, ClTextarea, ClImageCropper } from '../cl';
import { motion, AnimatePresence } from 'framer-motion';
import '../../styles/server-dock.css';
import {
    X, Server, Shield, Users, Link, Ban, ClipboardList,
    Trash2, Check, AlertCircle, Copy,
    Camera, Image as ImageIcon, Crown,
    ChevronDown, ChevronUp, Clock,
    Smile, Upload, Pencil,
} from 'lucide-react';
import type { ServerInfo } from '../../hooks/useServers';
import { useAttachments } from '../../hooks/useAttachments';
import { IMAGE_ACCEPT_ATTR, validateImageUpload, validateEmojiUpload } from '../../utils/imageUploadValidation';
import { AVATAR_OUTPUT, BANNER_OUTPUT } from '../../utils/imageCrop';
import { serverSettingsTabVisibility, type ServerSettingsTab } from '../../utils/serverSettingsAccess';
import { Permissions, hasPermission } from '@cipherline/shared';
import { ServerIcon } from './ServerIcon';
import { EmojiImage } from './EmojiImage';
import { useServerEmojis, type ServerEmoji } from '../../hooks/useServerEmojis';
import { DockBackdrop } from './DockBackdrop';
import { ServerStoragePanel } from './ServerStoragePanel';
import { API_BASE } from '../../constants';
import { RolesTabContainer } from './roles/RolesTabContainer';
import { EncryptedAvatar } from '../EncryptedAvatar';
import { useToast } from '../../contexts/ToastContext';
import { useUnsavedChangesGuard, useReportDirty } from '../../hooks/useUnsavedChangesGuard';
import { useEscape } from '../../hooks/useEscape';
import { writeToClipboard } from '../../utils/clipboard';

// ── Helper Types ─────────────────────────────────────────────────────────────

interface Member {
    user_id: string;
    nickname: string | null;
    joined_at: string;
    muted_until: string | null;
    banned: boolean;
    username?: string;
    avatar_url?: string | null;
}

interface Invite {
    code: string;
    inviter_user_id: string;
    /** Username of the member who created this invite (from User join). */
    inviter_username: string | null;
    inviter_discriminator: number | null;
    created_at: string;
    expires_at: string | null;
    max_uses: number | null;
    uses: number;
}

interface InviteUseEntry {
    user_id: string;
    username: string | null;
    discriminator: number | null;
    joined_at: string;
}

interface BanEntry {
    user_id: string;
    username: string | null;
    discriminator: number | null;
    ban_reason: string | null;
    banned_at: string;
}

interface AuditEntry {
    id: string;
    action: string;
    actor_user_id: string;
    actor_username: string | null;
    target_user_id: string | null;
    target_username: string | null;
    target_role_id: string | null;
    target_channel_id: string | null;
    data_jsonb: any;
    created_at: string;
}

// ── Props ────────────────────────────────────────────────────────────────────

interface Props {
    server: ServerInfo;
    token: string | null;
    userId: string | null;
    /** Caller's resolved server-level permission bitfield. Drives canManage flags. */
    myPermissions?: bigint;
    onClose: () => void;
    onServerUpdated: (updated: Partial<ServerInfo>) => void;
    /** Bumps when a server-save / unsave lands so ServerStoragePanel refetches. */
    storageRefreshKey?: number;
    /**
     * Deep link into one tab instead of the caller's usual landing tab.
     *
     * Used by callers that mean "take me to Members" (where the transfer UI
     * lives) rather than the owner's usual first tab, Overview.
     *
     * `nonce`, not the tab id, is what re-targets an ALREADY-OPEN modal. A bare
     * tab id would be a no-op prop on a second click at the same destination,
     * and would also yank the user back off any tab they picked by hand on the
     * next unrelated re-render.
     *
     * A request for a tab this user can't see is ignored, not honoured — see
     * `activeTab` below, which clamps to `tabVisibility` either way.
     */
    tabRequest?: { tab: ServerSettingsTab; nonce: number };
}

// ── Shared UI primitives ─────────────────────────────────────────────────────

const sectionLabel = 'text-[11px] font-mono font-semibold uppercase tracking-widest text-cl-faint mb-2';

// ── Tab definitions ──────────────────────────────────────────────────────────

type Tab = ServerSettingsTab;

/** "Dry Dock" station groups — the sidebar clusters tabs by the kind of work
 *  they do on the vessel: steering it, managing who crews it, and the ship's
 *  papers. Grouping only; tab ids/labels/permission gating are unchanged. */
const TAB_SECTIONS: { name: string; ids: Tab[] }[] = [
    { name: 'Command', ids: ['overview'] },
    { name: 'Crew',    ids: ['roles', 'members', 'invites', 'emojis'] },
    { name: 'Records', ids: ['bans', 'audit'] },
];

const TABS: { id: Tab; label: string; icon: React.ReactNode; description?: string }[] = [
    { id: 'overview',  label: 'Overview',   icon: <Server size={18} />,        description: 'Server identity, icon & banner' },
    { id: 'roles',     label: 'Roles',      icon: <Shield size={18} />,        description: 'Hierarchy, permissions & members' },
    { id: 'members',   label: 'Members',    icon: <Users size={18} />,         description: 'Browse, kick, ban, assign roles' },
    { id: 'invites',   label: 'Invites',    icon: <Link size={18} />,          description: 'Every invite, active and past' },
    { id: 'emojis',    label: 'Emojis',     icon: <Smile size={18} />,         description: 'Custom emojis for this server' },
    { id: 'bans',      label: 'Bans',       icon: <Ban size={18} />,           description: 'Banned users' },
    { id: 'audit',     label: 'Audit Log',  icon: <ClipboardList size={18} />, description: 'Moderation history' },
];

// ── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab({ server, token, onServerUpdated, storageRefreshKey, canManageServer, isOwner, onDeleted, onDirtyChange }: {
    server: ServerInfo;
    token: string | null;
    onServerUpdated: (u: Partial<ServerInfo>) => void;
    storageRefreshKey?: number;
    canManageServer?: boolean;
    /** True only for the server owner — shows the Danger Zone. */
    isOwner?: boolean;
    /** Called after a successful server deletion so the parent can close. */
    onDeleted?: () => void;
    /** Lets the shell guard close / tab-switch while the form has unsaved edits. */
    onDirtyChange?: (dirty: boolean) => void;
}) {
    const [name, setName] = useState(server.name);
    const [description, setDescription] = useState(server.description ?? '');
    const [defaultNotifLevel, setDefaultNotifLevel] = useState<'all' | 'mentions'>(
        server.default_notification_level ?? 'all'
    );
    const [systemChannelId, setSystemChannelId] = useState<string | null>(
        server.system_channel_id ?? null
    );
    /** Text channels available for system message routing. Fetched on mount. */
    const [textChannels, setTextChannels] = useState<Array<{ channel_id: string; name: string }>>([]);
    const [iconAttachment, setIconAttachment] = useState(server.icon_attachment);
    const [iconKeyB64, setIconKeyB64] = useState(server.icon_key_b64);
    const [iconNonceB64, setIconNonceB64] = useState(server.icon_nonce_b64);
    const [bannerAttachment, setBannerAttachment] = useState(server.banner_attachment);
    const [bannerKeyB64, setBannerKeyB64] = useState(server.banner_key_b64);
    const [bannerNonceB64, setBannerNonceB64] = useState(server.banner_nonce_b64);
    const [iconPreview, setIconPreview] = useState<string | null>(null);   // local blob URL while uploading
    const [bannerPreview, setBannerPreview] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [uploading, setUploading] = useState<'icon' | 'banner' | null>(null);
    const [saved, setSaved] = useState(false);
    /** The picked image awaiting crop, and which surface it was picked for. */
    const [cropTarget, setCropTarget] = useState<{ kind: 'icon' | 'banner'; file: File } | null>(null);
    const iconInputRef = useRef<HTMLInputElement>(null);
    const bannerInputRef = useRef<HTMLInputElement>(null);
    const toast = useToast();

    // ── Delete server dialog state ────────────────────────────────────────
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const [deletePassword, setDeletePassword] = useState('');
    const [deleting, setDeleting]   = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    const openDeleteDialog  = () => { setDeletePassword(''); setDeleteError(null); setShowDeleteDialog(true); };
    const closeDeleteDialog = () => { setShowDeleteDialog(false); setDeletePassword(''); setDeleteError(null); };

    const handleDeleteServer = async () => {
        if (!token || !deletePassword.trim() || deleting) return;
        setDeleting(true);
        setDeleteError(null);
        try {
            await axios.delete(`${API_BASE}/servers/${server.server_id}`, {
                data: { password: deletePassword },
                headers: { Authorization: `Bearer ${token}` },
            });
            onDeleted?.();
        } catch (e: any) {
            setDeleteError(e?.response?.data?.message ?? 'Failed to delete server');
        } finally {
            setDeleting(false);
        }
    };

    const { uploadEncryptedFile } = useAttachments(token);

    // Load the server's text channels so the system-channel picker is populated.
    useEffect(() => {
        if (!token) return;
        axios.get(`${API_BASE}/servers/${server.server_id}/channels`, {
            headers: { Authorization: `Bearer ${token}` },
        }).then(res => {
            const channels: Array<{ channel_id: string; name: string; kind: string }> = res.data ?? [];
            setTextChannels(channels.filter(c => c.kind === 'text').map(c => ({ channel_id: c.channel_id, name: c.name })));
        }).catch(() => { /* non-fatal — picker just won't be populated */ });
    }, [token, server.server_id]);

    const dirty =
        name.trim() !== server.name ||
        (description.trim() || null) !== (server.description ?? null) ||
        iconAttachment !== server.icon_attachment ||
        bannerAttachment !== server.banner_attachment ||
        defaultNotifLevel !== (server.default_notification_level ?? 'all') ||
        systemChannelId !== (server.system_channel_id ?? null);
    useReportDirty(dirty, onDirtyChange);

    /** Hand a picked file to the cropper; the cropped blob comes back via onConfirm. */
    const pickForCrop = (kind: 'icon' | 'banner', e: React.ChangeEvent<HTMLInputElement>) => {
        const result = validateImageUpload(e.target.files?.[0]);
        // Always clear the input: without this, cancelling the cropper and
        // re-picking the same file fires no change event.
        if (e.target) e.target.value = '';
        if (!result.ok) { toast.push({ kind: 'error', message: result.reason }); return; }
        if (result.file) setCropTarget({ kind, file: result.file });
    };

    /** Upload the cropped blob straight away — this surface commits the image on
     *  pick and keeps the keys in state for the later PATCH. */
    const handleCropped = async (blob: Blob) => {
        const kind = cropTarget?.kind;
        setCropTarget(null);
        if (!kind) return;
        try {
            setUploading(kind);
            // Local preview while we wait for the round-trip
            const preview = URL.createObjectURL(blob);
            if (kind === 'icon')   setIconPreview(preview);   else setBannerPreview(preview);

            // Encrypted upload — same primitive as user avatars/banners
            const { attachmentId, keyB64, nonceB64 } = await uploadEncryptedFile(
                blob,
                kind === 'icon' ? 'server-icon.jpg' : 'server-banner.jpg',
                'image/jpeg',
            );
            if (kind === 'icon')   { setIconAttachment(attachmentId);   setIconKeyB64(keyB64);   setIconNonceB64(nonceB64); }
            else                   { setBannerAttachment(attachmentId); setBannerKeyB64(keyB64); setBannerNonceB64(nonceB64); }
        } catch (e: any) {
            toast.push({ kind: 'error', message: e?.message ?? 'Upload failed' });
        } finally {
            setUploading(null);
        }
    };

    const handleClearImage = (kind: 'icon' | 'banner') => {
        if (kind === 'icon') {
            setIconAttachment(null); setIconKeyB64(null); setIconNonceB64(null);
            if (iconPreview) URL.revokeObjectURL(iconPreview);
            setIconPreview(null);
        } else {
            setBannerAttachment(null); setBannerKeyB64(null); setBannerNonceB64(null);
            if (bannerPreview) URL.revokeObjectURL(bannerPreview);
            setBannerPreview(null);
        }
    };

    const handleSave = async () => {
        if (!token || !name.trim() || name.trim().length < 2) return;
        setSaving(true);
        try {
            // Build the patch body — only send fields the user actually changed.
            const patch: Record<string, unknown> = {};
            if (name.trim() !== server.name) patch.name = name.trim();
            if ((description.trim() || null) !== (server.description ?? null)) {
                patch.description = description.trim();
            }
            if (iconAttachment !== server.icon_attachment) {
                patch.icon_attachment = iconAttachment ?? '';
                if (iconAttachment && iconKeyB64 && iconNonceB64) {
                    patch.icon_key_b64   = iconKeyB64;
                    patch.icon_nonce_b64 = iconNonceB64;
                }
            }
            if (bannerAttachment !== server.banner_attachment) {
                patch.banner_attachment = bannerAttachment ?? '';
                if (bannerAttachment && bannerKeyB64 && bannerNonceB64) {
                    patch.banner_key_b64   = bannerKeyB64;
                    patch.banner_nonce_b64 = bannerNonceB64;
                }
            }
            if (defaultNotifLevel !== (server.default_notification_level ?? 'all')) {
                patch.default_notification_level = defaultNotifLevel;
            }
            if (systemChannelId !== (server.system_channel_id ?? null)) {
                patch.system_channel_id = systemChannelId ?? '';
            }
            await axios.patch(
                `${API_BASE}/servers/${server.server_id}`,
                patch,
                { headers: { Authorization: `Bearer ${token}` } },
            );
            onServerUpdated({
                name: name.trim(),
                description: description.trim() || null,
                icon_attachment: iconAttachment,
                icon_key_b64: iconKeyB64,
                icon_nonce_b64: iconNonceB64,
                banner_attachment: bannerAttachment,
                banner_key_b64: bannerKeyB64,
                banner_nonce_b64: bannerNonceB64,
                default_notification_level: defaultNotifLevel,
                system_channel_id: systemChannelId,
            });
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } catch (e: any) {
            toast.push({ kind: 'error', message: e?.response?.data?.message ?? 'Failed to save' });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-6">
            {/* Identity card — banner is the wide image strip, the icon overlays
                it at the bottom-left (like Discord), name sits alongside. One
                card: these three read as a single "who this server is" group,
                not three independent sections. */}
            <div className="dock-card rounded-[14px] border border-cl-border/40 bg-cl-surface/40 p-5 space-y-5">
                <div>
                    <p className={sectionLabel}>Banner</p>
                    <div className="relative">
                        <div
                            className="w-full h-32 rounded-xl bg-cl-surface overflow-hidden border border-cl-border cursor-pointer group relative"
                            onClick={() => bannerInputRef.current?.click()}
                        >
                            {bannerPreview ? (
                                <img src={bannerPreview} alt="Banner preview" className="w-full h-full object-cover" />
                            ) : bannerAttachment && bannerKeyB64 && bannerNonceB64 ? (
                                <ServerIcon
                                    serverId={server.server_id}
                                    name={server.name}
                                    attachmentId={bannerAttachment}
                                    keyB64={bannerKeyB64}
                                    nonceB64={bannerNonceB64}
                                    token={token}
                                    className="w-full h-full"
                                />
                            ) : (
                                <div className="w-full h-full flex items-center justify-center text-cl-faint group-hover:text-cl-muted transition-colors">
                                    <ImageIcon size={28} />
                                    <span className="ml-2 text-xs">Upload banner (1500×600)</span>
                                </div>
                            )}
                            <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-colors">
                                <Camera size={20} className="opacity-0 group-hover:opacity-100 text-cl-text transition-opacity" />
                            </div>
                        </div>
                        {(bannerAttachment || bannerPreview) && (
                            <ClButton
                                icon
                                size="sm"
                                variant="ghost"
                                onClick={() => handleClearImage('banner')}
                                tooltip="Remove banner"
                                style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.6)' }}
                            >
                                <X size={14} />
                            </ClButton>
                        )}
                    </div>
                    <input
                        ref={bannerInputRef}
                        type="file"
                        accept={IMAGE_ACCEPT_ATTR}
                        className="hidden"
                        onChange={e => pickForCrop('banner', e)}
                    />
                </div>

                {/* Icon (square 512x512) + name on one row */}
                <div className="flex items-start gap-4">
                    <div className="shrink-0">
                        <p className={sectionLabel}>Icon</p>
                        <div
                            className="w-20 h-20 rounded-2xl overflow-hidden border border-cl-border cursor-pointer relative group bg-cl-surface"
                            onClick={() => iconInputRef.current?.click()}
                        >
                            {iconPreview ? (
                                <img src={iconPreview} alt="Icon preview" className="w-full h-full object-cover" />
                            ) : (
                                <ServerIcon
                                    serverId={server.server_id}
                                    name={name || server.name}
                                    attachmentId={iconAttachment}
                                    keyB64={iconKeyB64}
                                    nonceB64={iconNonceB64}
                                    token={token}
                                    className="w-full h-full text-2xl"
                                />
                            )}
                            <div className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-colors">
                                <Camera size={18} className="opacity-0 group-hover:opacity-100 text-cl-text transition-opacity" />
                            </div>
                        </div>
                        {iconAttachment && (
                            <ClButton
                                size="sm"
                                variant="ghost"
                                onClick={() => handleClearImage('icon')}
                                style={{ marginTop: 4, fontSize: 10 }}
                            >
                                Remove
                            </ClButton>
                        )}
                        <input
                            ref={iconInputRef}
                            type="file"
                            accept={IMAGE_ACCEPT_ATTR}
                            className="hidden"
                            onChange={e => pickForCrop('icon', e)}
                        />
                    </div>

                    <div className="flex-1">
                        <p className={sectionLabel}>Server Name</p>
                        <ClInput
                            type="text"
                            value={name}
                            onChange={e => setName(e.target.value.replace(/[^a-zA-Z0-9 '\-_.]/g, ''))}
                            maxLength={50}
                            placeholder="Server name…"
                            // Belt-and-braces: this whole tab is hidden without
                            // MANAGE_SERVER, but the field itself should never be
                            // typeable by someone who can't save it. Ungated, it
                            // was the thing plain members ended up staring at.
                            disabled={!canManageServer}
                        />
                    </div>
                </div>
            </div>

            {/* Description card */}
            <div className="dock-card rounded-[14px] border border-cl-border/40 bg-cl-surface/40 p-5">
                <div className="flex items-center justify-between mb-2">
                    <p className={sectionLabel + ' mb-0'}>Description</p>
                    <span className="text-[10px] text-cl-faint">{description.length}/1000</span>
                </div>
                <ClTextarea
                    value={description}
                    onChange={e => setDescription(e.target.value.slice(0, 1000))}
                    rows={4}
                    className="resize-none font-sans"
                    placeholder="Tell people what this server is about. Shown in the invite preview and server panel."
                    disabled={!canManageServer}
                />
            </div>

            {/* Messaging card — default notification level + system channel,
                admin only. Both gated on the same permission, so the card
                either renders whole or not at all. */}
            {canManageServer && (
                <div className="dock-card rounded-[14px] border border-cl-border/40 bg-cl-surface/40 divide-y divide-white/[0.05]">
                    <div className="p-5">
                        <p className={sectionLabel}>Default Notifications</p>
                        <p className="text-[11px] text-cl-faint mb-3">
                            This sets the default notification level for all members when they join the server.
                            Individual members can always override this for themselves.
                        </p>
                        <div className="flex gap-2">
                            {(['all', 'mentions'] as const).map(lvl => (
                                <ClButton
                                    key={lvl}
                                    onClick={() => setDefaultNotifLevel(lvl)}
                                    active={defaultNotifLevel === lvl}
                                    variant="ghost"
                                    className="clb--chip"
                                >
                                    {lvl === 'all' ? 'All Messages' : '@Mentions Only'}
                                </ClButton>
                            ))}
                        </div>
                    </div>

                    <div className="p-5">
                        <p className={sectionLabel}>System Messages Channel</p>
                        <p className="text-[11px] text-cl-faint mb-3">
                            Server events like member joins, leaves, kicks, and bans are posted here as system messages.
                            Set to "None" to disable system messages.
                        </p>
                        <ClSelect
                            options={[
                                { value: '', label: 'None — system messages disabled' },
                                ...textChannels.map(ch => ({ value: ch.channel_id, label: `#${ch.name}` })),
                            ]}
                            value={systemChannelId ?? ''}
                            onChange={(v) => setSystemChannelId(v || null)}
                            style={{ width: '100%' }}
                        />
                    </div>
                </div>
            )}

            {/* Save bar */}
            <div className="flex items-center justify-end gap-3">
                {uploading && (
                    <span className="text-xs text-cl-faint">Uploading {uploading}…</span>
                )}
                <ClButton
                    size="sm"
                    disabled={saving || !!uploading || !name.trim() || !dirty}
                    loading={saving}
                    onClick={handleSave}
                >
                    {saving ? 'Saving…' : saved ? 'Saved!' : 'Save Changes'}
                </ClButton>
            </div>

            {/* Server info card — storage quota + IDs */}
            <div className="dock-card rounded-[14px] border border-cl-border/40 bg-cl-surface/40 p-5 space-y-4">
                {/* Server Save storage — quota bar + per-channel breakdown.
                    Refreshes after every server-save/unsave via storageRefreshKey. */}
                <ServerStoragePanel
                    serverId={server.server_id}
                    token={token}
                    refreshKey={storageRefreshKey}
                    canManage={canManageServer}
                />

                <div className="pt-3 space-y-3 border-t border-cl-border/30">
                    <div>
                        <p className={sectionLabel}>Server ID</p>
                        <p className="text-xs text-cl-faint font-mono">{server.server_id}</p>
                    </div>
                    <div>
                        <p className={sectionLabel}>Owner</p>
                        <p className="text-xs text-cl-faint font-mono">{server.owner_user_id}</p>
                    </div>
                </div>
            </div>

            {/* ── Danger Zone — owner only ─────────────────────────────── */}
            {isOwner && (
                <div className="mt-8 rounded-xl border border-cl-flash/25 bg-cl-flash/[0.04]">
                    <div className="px-5 py-4 border-b border-cl-flash/15">
                        <p className="text-[11px] font-mono font-semibold uppercase tracking-widest text-cl-flash/70">Danger Zone</p>
                    </div>
                    <div className="px-5 py-4 flex items-center justify-between gap-6">
                        <div className="min-w-0">
                            <p className="text-[14px] font-semibold text-cl-text">Delete this server</p>
                            <p className="text-[12px] text-cl-faint mt-0.5">
                                Permanently removes all channels, messages, roles, and members. This cannot be undone.
                            </p>
                        </div>
                        <ClButton variant="danger" onClick={openDeleteDialog}>
                            Delete Server
                        </ClButton>
                    </div>
                </div>
            )}

            {/* ── Delete confirmation dialog ───────────────────────────── */}
            <ClModal open={showDeleteDialog} onClose={closeDeleteDialog} width={448} overlayStyle={{ zIndex: 1100 }} cardStyle={{ padding: 0, overflow: 'hidden' }}>
                <div className="px-6 pt-6 pb-4 border-b border-cl-border/40">
                    <p className="text-[18px] font-bold text-cl-text mt-0 mb-0">Delete <span className="text-cl-flash">{server.name}</span>?</p>
                    <p className="text-[13px] text-cl-faint mt-1.5 leading-relaxed">
                        This will permanently delete all channels, messages, roles, and members.
                        This action <span className="font-semibold text-cl-muted">cannot be undone</span>.
                    </p>
                </div>
                <div className="px-6 py-5 space-y-4">
                    <div>
                        <label className="block text-[12px] font-semibold text-cl-faint uppercase tracking-wider mb-2">
                            Enter your password to confirm
                        </label>
                        <ClInput
                            type="password"
                            value={deletePassword}
                            onChange={e => { setDeletePassword(e.target.value); setDeleteError(null); }}
                            onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter' && deletePassword.trim()) handleDeleteServer(); }}
                            placeholder="Your account password"
                            autoFocus
                        />
                    </div>
                    {deleteError && (
                        <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-cl-flash/10 border border-cl-flash/25">
                            <AlertCircle size={14} className="text-cl-flash shrink-0" />
                            <p className="text-[13px] text-cl-flash">{deleteError}</p>
                        </div>
                    )}
                </div>
                <div className="px-6 pb-6 flex gap-3 justify-end">
                    <ClButton variant="ghost" onClick={closeDeleteDialog} disabled={deleting}>Cancel</ClButton>
                    <ClButton variant="danger" onClick={handleDeleteServer} disabled={!deletePassword.trim() || deleting} loading={deleting}>
                        {deleting ? 'Deleting…' : 'Delete Server'}
                    </ClButton>
                </div>
            </ClModal>

            {/* Crop step — one mount, dimensions/shape switch on the picked target.
                ClModal's overlay sits at z-index 1000 (cl-kit-ext.css) while this
                settings shell is z-index 50, so the cropper stacks above without
                an overlayStyle override; the shell's Escape handler bails while
                any `.cl-kit .mod` is mounted, so Escape closes only the cropper.

                Both kinds mask as rect: unlike user/group avatars, server icons
                render as rounded SQUARES (rounded-2xl here, rounded-xl in the
                masthead), so a circular mask would preview a tighter crop than
                the user actually gets. */}
            <ClImageCropper
                open={!!cropTarget}
                file={cropTarget?.file ?? null}
                outputWidth={cropTarget?.kind === 'banner' ? BANNER_OUTPUT.width : AVATAR_OUTPUT.width}
                outputHeight={cropTarget?.kind === 'banner' ? BANNER_OUTPUT.height : AVATAR_OUTPUT.height}
                shape="rect"
                title={cropTarget?.kind === 'banner' ? 'Position the server banner' : 'Position the server icon'}
                onCancel={() => setCropTarget(null)}
                onConfirm={handleCropped}
            />
        </div>
    );
}

// ── Members Tab ──────────────────────────────────────────────────────────────

function MembersTab({ server, token, userId, onServerUpdated }: {
    server: ServerInfo;
    token: string | null;
    userId: string | null;
    onServerUpdated: (u: Partial<ServerInfo>) => void;
}) {
    const [members, setMembers] = useState<Member[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const toast = useToast();
    const [muteTarget, setMuteTarget] = useState<string | null>(null);
    const [muteMins, setMuteMins] = useState('10');
    /** Member targeted for ownership transfer — opens the confirmation dialog. */
    const [transferDialog, setTransferDialog] = useState<Member | null>(null);
    const [transferring, setTransferring] = useState(false);
    const [transferPassword, setTransferPassword] = useState('');
    const [transferError, setTransferError] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!token) return;
        try {
            const res = await axios.get(`${API_BASE}/servers/${server.server_id}/members`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            setMembers(res.data ?? []);
        } catch { }
        finally { setLoading(false); }
    }, [server.server_id, token]);

    useEffect(() => { load(); }, [load]);

    const kick = async (targetUserId: string) => {
        if (!token) return;
        try {
            await axios.post(
                `${API_BASE}/servers/${server.server_id}/members/${targetUserId}/kick`,
                {},
                { headers: { Authorization: `Bearer ${token}` } },
            );
            setMembers(m => m.filter(x => x.user_id !== targetUserId));
        } catch (e: any) { toast.push({ kind: 'error', message: e?.response?.data?.message ?? 'Failed to kick' }); }
    };

    const ban = async (targetUserId: string) => {
        if (!token) return;
        try {
            await axios.post(
                `${API_BASE}/servers/${server.server_id}/members/${targetUserId}/ban`,
                {},
                { headers: { Authorization: `Bearer ${token}` } },
            );
            setMembers(m => m.filter(x => x.user_id !== targetUserId));
        } catch (e: any) { toast.push({ kind: 'error', message: e?.response?.data?.message ?? 'Failed to ban' }); }
    };

    const mute = async (targetUserId: string) => {
        if (!token) return;
        const mins = parseInt(muteMins, 10);
        if (!mins || mins <= 0) return;
        try {
            await axios.post(
                `${API_BASE}/servers/${server.server_id}/members/${targetUserId}/mute`,
                { duration_seconds: mins * 60 },
                { headers: { Authorization: `Bearer ${token}` } },
            );
            setMuteTarget(null);
            await load();
        } catch (e: any) { toast.push({ kind: 'error', message: e?.response?.data?.message ?? 'Failed to mute' }); }
    };

    const closeTransferDialog = () => { setTransferDialog(null); setTransferPassword(''); setTransferError(null); };

    const doTransfer = async (targetUserId: string) => {
        if (!token || !transferPassword.trim()) return;
        setTransferring(true);
        setTransferError(null);
        try {
            // The API requires the owner's password as a step-up confirmation
            // (same gate as delete). Sending it was missing before, so transfer
            // always 403'd.
            await axios.post(
                `${API_BASE}/servers/${server.server_id}/transfer`,
                { new_owner_user_id: targetUserId, password: transferPassword },
                { headers: { Authorization: `Bearer ${token}` } },
            );
            // Notify parent so the server object updates everywhere (rail, header, etc.)
            onServerUpdated({ owner_user_id: targetUserId });
            closeTransferDialog();
        } catch (e: any) {
            setTransferError(e?.response?.data?.message ?? 'Failed to transfer ownership');
        } finally {
            setTransferring(false);
        }
    };

    const filtered = members.filter(m =>
        !search || (m.username ?? m.user_id).toLowerCase().includes(search.toLowerCase())
    );

    if (loading) return <div className="flex justify-center py-8"><div className="w-5 h-5 border-2 border-cl-border border-t-cl-lume rounded-full animate-spin" /></div>;

    return (
        <div className="space-y-4">
            <ClInput
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search members…"
            />
            <div className="dock-card rounded-[14px] border border-cl-border/40 bg-cl-surface/40 p-2">
            <div className="space-y-1 max-h-[420px] overflow-y-auto custom-scrollbar pr-1">
                {filtered.map(m => (
                    <div key={m.user_id} className="flex items-center gap-3 px-3 py-2 bg-cl-raise/20 border border-cl-border rounded-xl">
                        <EncryptedAvatar
                            attachmentId={m.avatar_url}
                            token={token}
                            userId={m.user_id}
                            bypassFriendGate
                            disableClickProfile
                            fallbackSize={16}
                            className="w-8 h-8 shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                            <p className="text-sm text-cl-text truncate">{m.username ?? 'Unknown User'}</p>
                            {m.nickname && <p className="text-xs text-cl-faint truncate">aka {m.nickname}</p>}
                            {m.muted_until && new Date(m.muted_until) > new Date() && (
                                <p className="text-xs text-cl-glow/70">Muted until {new Date(m.muted_until).toLocaleTimeString()}</p>
                            )}
                        </div>
                        {m.user_id === server.owner_user_id && (
                            <span className="flex items-center gap-1 text-[10px] text-amber-400/80 bg-amber-400/10 px-2 py-0.5 rounded-full shrink-0">
                                <Crown size={9} />Owner
                            </span>
                        )}
                        {m.user_id !== userId && m.user_id !== server.owner_user_id && (
                            <div className="flex items-center gap-1.5 shrink-0">
                                {muteTarget === m.user_id ? (
                                    <>
                                        <ClInput
                                            type="number"
                                            value={muteMins}
                                            onChange={e => setMuteMins(e.target.value)}
                                            // width forced inline, not via w-16 — see ChannelSettingsDialog's
                                            // LimitSlider comment: .inp's width:100% silently wins the
                                            // specificity tie against Tailwind width utilities here.
                                            style={{ width: 64, flexShrink: 0 }}
                                            min={1}
                                            max={10080}
                                            placeholder="min"
                                        />
                                        <ClButton size="sm" onClick={() => mute(m.user_id)}>Mute</ClButton>
                                        <ClButton icon size="sm" variant="ghost" onClick={() => setMuteTarget(null)}>
                                            <X size={12} />
                                        </ClButton>
                                    </>
                                ) : (
                                    <>
                                        {userId === server.owner_user_id && (
                                            <ClButton
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => setTransferDialog(m)}
                                                tooltip="Transfer server ownership to this member"
                                                style={{ color: 'rgb(251 191 36 / 0.7)' }}
                                            >
                                                <Crown size={11} />
                                                Transfer
                                            </ClButton>
                                        )}
                                        <ClButton size="sm" variant="ghost" onClick={() => setMuteTarget(m.user_id)} style={{ color: 'var(--cl-glow, #a78bfa)' }}>Mute</ClButton>
                                        <ClButton size="sm" variant="danger" onClick={() => kick(m.user_id)}>Kick</ClButton>
                                        <ClButton size="sm" variant="danger" onClick={() => ban(m.user_id)}>Ban</ClButton>
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                ))}
                {filtered.length === 0 && <p className="text-sm text-cl-faint text-center py-6">No members found.</p>}
            </div>
            </div>

            {/* ── Transfer Ownership dialog ─────────────────────────────── */}
            <ClModal open={!!transferDialog} onClose={closeTransferDialog} width={448} overlayStyle={{ zIndex: 1100 }} cardStyle={{ padding: 0, overflow: 'hidden' }}>
                {transferDialog && (
                    <>
                        <div className="px-6 pt-6 pb-4 border-b border-cl-border/40">
                            <div className="flex items-center gap-2.5 mb-3">
                                <div className="w-8 h-8 rounded-full bg-amber-400/15 flex items-center justify-center">
                                    <Crown size={16} className="text-amber-400" />
                                </div>
                                <p className="text-[18px] font-bold text-cl-text mt-0 mb-0">Transfer Ownership</p>
                            </div>
                            <p className="text-[13px] text-cl-faint leading-relaxed">
                                You are about to transfer ownership of <span className="text-cl-muted font-medium">{server.name}</span> to{' '}
                                <span className="text-amber-400 font-semibold">{transferDialog.username ?? 'this member'}</span>.
                            </p>
                            <p className="text-[13px] text-cl-faint leading-relaxed mt-2">
                                You will become a regular member. Only {transferDialog.username ?? 'they'} can transfer it back. From then on their plan decides this server's saved-storage limit (anything already saved is kept).
                            </p>
                        </div>
                        <div className="px-6 py-5 space-y-4">
                            <div>
                                <label className="block text-[12px] font-semibold text-cl-faint uppercase tracking-wider mb-2">
                                    Enter your password to confirm
                                </label>
                                <ClInput
                                    type="password"
                                    value={transferPassword}
                                    onChange={e => { setTransferPassword(e.target.value); setTransferError(null); }}
                                    onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter' && transferPassword.trim() && !transferring) doTransfer(transferDialog.user_id); }}
                                    placeholder="Your account password"
                                    autoFocus
                                />
                            </div>
                            {transferError && (
                                <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-cl-flash/10 border border-cl-flash/25">
                                    <AlertCircle size={14} className="text-cl-flash shrink-0" />
                                    <p className="text-[13px] text-cl-flash">{transferError}</p>
                                </div>
                            )}
                        </div>
                        <div className="px-6 pb-6 flex gap-3 justify-end">
                            <ClButton variant="ghost" onClick={closeTransferDialog} disabled={transferring}>Cancel</ClButton>
                            <ClButton
                                onClick={() => doTransfer(transferDialog.user_id)}
                                disabled={transferring || !transferPassword.trim()}
                                loading={transferring}
                                style={{ background: transferring ? undefined : 'rgb(217 119 6)', color: '#fff' }}
                            >
                                {transferring ? 'Transferring…' : 'Transfer Ownership'}
                            </ClButton>
                        </div>
                    </>
                )}
            </ClModal>
        </div>
    );
}

// ── Invites Tab ──────────────────────────────────────────────────────────────

/** Format a relative time string for joined_at / created_at dates. */
function relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins  = Math.floor(diff / 60_000);
    const hours = Math.floor(diff / 3_600_000);
    const days  = Math.floor(diff / 86_400_000);
    if (mins  <  1) return 'just now';
    if (mins  < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
}

/** Render a username#discriminator tag, or just the username if no disc. */
function displayName(username: string | null, discriminator: number | null): string {
    if (!username) return 'Unknown';
    return discriminator ? `${username}#${String(discriminator).padStart(4, '0')}` : username;
}

/** One collapsible invite row. */
function InviteRow({
    inv, token, serverId, onRevoke, canRevoke,
}: {
    inv: Invite;
    token: string | null;
    serverId: string;
    onRevoke: (code: string) => void;
    canRevoke: boolean;
}) {
    const [copied,       setCopied]       = useState(false);
    const [expanded,     setExpanded]     = useState(false);
    const [uses,         setUses]         = useState<InviteUseEntry[] | null>(null);
    const [usesLoading,  setUsesLoading]  = useState(false);
    const [revoking,     setRevoking]     = useState(false);
    const toast = useToast();

    const link = `https://cipherline.chat/invite/${inv.code}`;
    const isExpired = inv.expires_at ? new Date(inv.expires_at) < new Date() : false;
    const isExhausted = inv.max_uses !== null && inv.uses >= inv.max_uses;

    const copy = () => {
        writeToClipboard(link).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
        }).catch(() => {
            toast.push({ kind: 'error', message: 'Could not copy — try selecting and copying manually.' });
        });
    };

    const toggleExpand = async () => {
        if (!expanded && uses === null) {
            setUsesLoading(true);
            try {
                const res = await axios.get(
                    `${API_BASE}/servers/${serverId}/invites/${inv.code}/uses`,
                    { headers: { Authorization: `Bearer ${token}` } },
                );
                setUses(res.data ?? []);
            } catch { setUses([]); }
            finally { setUsesLoading(false); }
        }
        setExpanded(v => !v);
    };

    const revoke = async () => {
        if (!canRevoke) return;
        setRevoking(true);
        try {
            await axios.delete(
                `${API_BASE}/servers/${serverId}/invites/${inv.code}`,
                { headers: { Authorization: `Bearer ${token}` } },
            );
            onRevoke(inv.code);
        } catch { setRevoking(false); }
    };

    return (
        <div className={`border rounded-xl overflow-hidden transition-colors ${
            isExpired || isExhausted
                ? 'border-cl-border/40 bg-cl-raise/5'
                : 'border-cl-border bg-cl-raise/20'
        }`}>
            {/* Main row */}
            <div className="flex items-center gap-2 px-3 py-2.5">
                {/* Link preview */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                        <Link size={11} className="shrink-0 text-cl-lume/60" />
                        <code className={`text-[12px] font-mono truncate ${isExpired || isExhausted ? 'text-cl-faint line-through' : 'text-cl-lume'}`}>
                            cipherline.chat/invite/{inv.code}
                        </code>
                        {(isExpired || isExhausted) && (
                            <span className="text-[10px] text-cl-flash/70 font-medium shrink-0">
                                {isExpired ? 'Expired' : 'Exhausted'}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[11px] text-cl-faint">
                            Created by{' '}
                            <span className="text-cl-muted font-medium">
                                {displayName(inv.inviter_username, inv.inviter_discriminator)}
                            </span>
                        </span>
                        <span className="text-cl-border">·</span>
                        <span className="text-[11px] text-cl-faint">
                            <span className={inv.uses > 0 ? 'text-cl-muted font-medium' : ''}>
                                {inv.uses}
                            </span>
                            {inv.max_uses ? `/${inv.max_uses}` : ''} uses
                        </span>
                        {inv.expires_at && (
                            <>
                                <span className="text-cl-border">·</span>
                                <span className={`flex items-center gap-0.5 text-[11px] ${isExpired ? 'text-cl-flash/60' : 'text-cl-faint'}`}>
                                    <Clock size={10} />
                                    {isExpired
                                        ? 'Expired'
                                        : `Expires ${new Date(inv.expires_at).toLocaleDateString()}`}
                                </span>
                            </>
                        )}
                        <span className="text-cl-border">·</span>
                        <span className="text-[11px] text-cl-faint">{relativeTime(inv.created_at)}</span>
                    </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                    {/* Expand joiners */}
                    <ClButton
                        size="sm"
                        variant="ghost"
                        onClick={toggleExpand}
                        tooltip={expanded ? 'Hide joiners' : 'Show who joined'}
                    >
                        <Users size={12} />
                        {usesLoading ? (
                            <div className="w-2.5 h-2.5 border border-cl-border border-t-cl-lume rounded-full animate-spin" />
                        ) : (
                            expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />
                        )}
                    </ClButton>

                    {/* Copy link */}
                    <ClButton
                        icon
                        size="sm"
                        variant="ghost"
                        onClick={copy}
                        tooltip="Copy invite link"
                    >
                        {copied ? <Check size={13} className="text-cl-ok" /> : <Copy size={13} />}
                    </ClButton>

                    {/* Revoke */}
                    {canRevoke && (
                        <ClButton
                            icon
                            size="sm"
                            variant="danger"
                            onClick={revoke}
                            disabled={revoking}
                            loading={revoking}
                            tooltip="Revoke invite"
                        >
                            <Trash2 size={13} />
                        </ClButton>
                    )}
                </div>
            </div>

            {/* Joiners panel */}
            {expanded && (
                <div className="border-t border-cl-border/40 bg-cl-sink">
                    {uses === null || usesLoading ? (
                        <div className="flex justify-center py-3">
                            <div className="w-4 h-4 border border-cl-border border-t-cl-lume rounded-full animate-spin" />
                        </div>
                    ) : uses.length === 0 ? (
                        <p className="text-xs text-cl-faint text-center py-3">No one has joined via this invite yet.</p>
                    ) : (
                        <div className="px-3 py-2 space-y-0.5">
                            {uses.map((u, i) => (
                                <div key={u.user_id + i} className="flex items-center gap-2 py-1">
                                    <div className="w-5 h-5 rounded-full bg-cl-raise flex items-center justify-center shrink-0">
                                        <span className="text-[9px] text-cl-muted font-bold">
                                            {(u.username?.[0] ?? '?').toUpperCase()}
                                        </span>
                                    </div>
                                    <span className="text-[12px] text-cl-muted font-medium">
                                        {displayName(u.username, u.discriminator)}
                                    </span>
                                    <span className="text-[11px] text-cl-faint ml-auto">{relativeTime(u.joined_at)}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function InvitesTab({
    server,
    token,
    canManageServer = false,
}: {
    server: ServerInfo;
    token: string | null;
    canManageServer?: boolean;
}) {
    const [invites, setInvites] = useState<Invite[]>([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [maxUses, setMaxUses] = useState('');
    const [expiresHours, setExpiresHours] = useState('');
    const toast = useToast();

    const load = useCallback(async () => {
        if (!token) return;
        try {
            const res = await axios.get(`${API_BASE}/servers/${server.server_id}/invites`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            setInvites(res.data ?? []);
        } catch { }
        finally { setLoading(false); }
    }, [server.server_id, token]);

    useEffect(() => { load(); }, [load]);

    const create = async () => {
        if (!token) return;
        setCreating(true);
        try {
            const body: any = {};
            if (maxUses) body.max_uses = parseInt(maxUses, 10);
            if (expiresHours) body.expires_in_seconds = parseInt(expiresHours, 10) * 3600;
            await axios.post(
                `${API_BASE}/servers/${server.server_id}/invites`,
                body,
                { headers: { Authorization: `Bearer ${token}` } },
            );
            setMaxUses('');
            setExpiresHours('');
            await load();
        } catch (e: any) {
            toast.push({ kind: 'error', message: e?.response?.data?.message ?? 'Failed to create invite' });
        } finally { setCreating(false); }
    };

    if (loading) return (
        <div className="flex justify-center py-8">
            <div className="w-5 h-5 border-2 border-cl-border border-t-cl-lume rounded-full animate-spin" />
        </div>
    );

    return (
        <div className="space-y-5">
            {/* ── Create invite ── */}
            <div className="dock-card rounded-[14px] border border-cl-border/40 bg-cl-surface/40 p-5 space-y-3">
                <p className="text-xs text-cl-faint font-mono font-semibold uppercase tracking-wider">Create Invite</p>
                <div className="flex gap-3 flex-wrap items-center">
                    <ClInput
                        type="number"
                        value={maxUses}
                        onChange={e => setMaxUses(e.target.value)}
                        placeholder="Max uses (optional)"
                        min={1}
                        className="flex-1 min-w-[120px]"
                    />
                    <ClInput
                        type="number"
                        value={expiresHours}
                        onChange={e => setExpiresHours(e.target.value)}
                        placeholder="Expires in hours (optional)"
                        min={1}
                        className="flex-1 min-w-[120px]"
                    />
                    {/* This row previously had NO align-items, so the default
                        `stretch` pulled `.clb` (no explicit height) up to the
                        full-height ClInputs' height while its `.cap` kept its
                        own smaller natural height, top-aligned inside — the
                        kit's depth sheets (sized to the taller, stretched .clb)
                        then hung out below the cap as a detached darker slab.
                        `items-center` here lets the button keep its natural
                        size (and its full depth-sheet treatment, matching the
                        rest of the design system — see e.g. RoleListPane's
                        "Add" button) instead of suppressing the sheets. */}
                    <ClButton size="sm" disabled={creating} loading={creating} onClick={create}>Generate</ClButton>
                </div>
            </div>

            {/* ── Active invite list ── */}
            <div>
                <div className="flex items-center justify-between mb-2">
                    <p className="text-xs text-cl-faint font-mono font-semibold uppercase tracking-wider">
                        All Invites
                        {invites.length > 0 && (
                            <span className="ml-1.5 text-cl-faint/50">({invites.length})</span>
                        )}
                    </p>
                </div>
                <div className="dock-card rounded-[14px] border border-cl-border/40 bg-cl-surface/40 p-2 space-y-1.5">
                    {invites.map(inv => (
                        <InviteRow
                            key={inv.code}
                            inv={inv}
                            token={token}
                            serverId={server.server_id}
                            onRevoke={(code) => setInvites(i => i.filter(x => x.code !== code))}
                            canRevoke={canManageServer || true /* creator can always revoke own */}
                        />
                    ))}
                    {invites.length === 0 && (
                        <p className="text-sm text-cl-faint text-center py-8">No active invites.</p>
                    )}
                </div>
            </div>
        </div>
    );
}

// ── Emojis Tab ───────────────────────────────────────────────────────────────

/** `[a-z0-9_]`, 2-32 chars — mirrors CreateEmojiDto's server-side regex. */
const EMOJI_NAME_RE = /^[a-z0-9_]{2,32}$/;

/** Best-effort default name from a picked file — strips the extension,
 *  lowercases, and replaces anything outside [a-z0-9_] with '_'. The user
 *  can always edit it before confirming; this just saves typing for the
 *  common case of a file already named sensibly. */
function nameFromFile(file: File): string {
    const base = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
    return base.slice(0, 32) || 'emoji';
}

function EmojisTab({ server, token, canManageEmojis }: {
    server: ServerInfo; token: string | null; canManageEmojis: boolean;
}) {
    const { emojis, loading, create, rename, remove } = useServerEmojis(server.server_id, token);
    const { uploadEncryptedFile } = useAttachments(token);
    const toast = useToast();
    const fileInputRef = useRef<HTMLInputElement>(null);

    const [pending, setPending] = useState<{ file: File; name: string; previewUrl: string } | null>(null);
    const [uploading, setUploading] = useState(false);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [deletingId, setDeletingId] = useState<string | null>(null);

    // The preview object URL is owned by `pending` for its whole lifetime —
    // revoke exactly once, on whichever path clears it (confirm, cancel, or
    // picking a new file over an existing pending one), and on unmount.
    useEffect(() => () => { if (pending) URL.revokeObjectURL(pending.previewUrl); }, [pending]);

    const MAX_EMOJIS = 50;
    const atCap = emojis.length >= MAX_EMOJIS;

    const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (e.target) e.target.value = ''; // allow re-picking the same file
        const result = validateEmojiUpload(file);
        if (!result.ok) { toast.push({ kind: 'error', message: result.reason }); return; }
        setPending({ file: result.file, name: nameFromFile(result.file), previewUrl: URL.createObjectURL(result.file) });
    };

    const confirmAdd = async () => {
        if (!pending) return;
        const name = pending.name.trim().toLowerCase();
        if (!EMOJI_NAME_RE.test(name)) {
            toast.push({ kind: 'error', message: 'Names may only use lowercase letters, numbers, and underscores (2-32 characters).' });
            return;
        }
        if (emojis.some(e => e.name === name)) {
            toast.push({ kind: 'error', message: `An emoji named "${name}" already exists on this server.` });
            return;
        }
        setUploading(true);
        try {
            const { attachmentId, keyB64, nonceB64 } = await uploadEncryptedFile(
                pending.file, pending.file.name, pending.file.type,
                undefined, undefined, server.server_id,
            );
            // No `animated` field — the server derives it from the decoded
            // image itself while center-cropping it to a square, see
            // useServerEmojis.create's own comment.
            await create({ name, attachment_id: attachmentId, key_b64: keyB64, nonce_b64: nonceB64 });
            setPending(null);
        } catch (e: any) {
            toast.push({ kind: 'error', message: e?.response?.data?.message ?? e?.message ?? 'Upload failed' });
        } finally {
            setUploading(false);
        }
    };

    const startRename = (e: ServerEmoji) => { setRenamingId(e.emoji_id); setRenameValue(e.name); };
    // TASK 2: this inline rename editor had no Escape-to-cancel before — a
    // layer of its own so it backs out without closing Settings underneath.
    useEscape(() => setRenamingId(null), !!renamingId);

    const confirmRename = async (emojiId: string) => {
        const name = renameValue.trim().toLowerCase();
        if (!EMOJI_NAME_RE.test(name)) {
            toast.push({ kind: 'error', message: 'Names may only use lowercase letters, numbers, and underscores (2-32 characters).' });
            return;
        }
        try {
            await rename(emojiId, name);
            setRenamingId(null);
        } catch (e: any) {
            toast.push({ kind: 'error', message: e?.response?.data?.message ?? 'Rename failed' });
        }
    };

    const doDelete = async (emojiId: string) => {
        setDeletingId(emojiId);
        try {
            await remove(emojiId);
        } catch (e: any) {
            toast.push({ kind: 'error', message: e?.response?.data?.message ?? 'Delete failed' });
        } finally {
            setDeletingId(null);
        }
    };

    if (loading) return <div className="flex justify-center py-8"><div className="w-5 h-5 border-2 border-cl-border border-t-cl-lume rounded-full animate-spin" /></div>;

    return (
        <div className="space-y-4">
            {canManageEmojis && (
                <div className="dock-card rounded-[14px] border border-cl-border/40 bg-cl-surface/40 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm font-medium text-cl-text">Add an emoji</p>
                            <p className="text-xs text-cl-faint">JPG, PNG, WEBP, or GIF — up to 5 MB. Automatically cropped to a square. {emojis.length}/{MAX_EMOJIS} used.</p>
                        </div>
                        <ClButton
                            size="sm"
                            variant="ghost"
                            disabled={atCap || uploading}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            <Upload size={14} className="mr-1.5" /> Upload
                        </ClButton>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept={IMAGE_ACCEPT_ATTR}
                            className="hidden"
                            onChange={pickFile}
                        />
                    </div>
                    {atCap && (
                        <p className="text-xs text-cl-flash">This server already has the maximum of {MAX_EMOJIS} custom emojis.</p>
                    )}
                    {pending && (
                        <div className="flex items-center gap-3 px-3 py-2.5 bg-cl-raise/20 border border-cl-border rounded-xl">
                            {/* Local object-URL preview — the attachment doesn't exist
                                server-side until confirmAdd runs, so this can't go through
                                EmojiImage/useEncryptedAvatar yet. object-cover (not
                                object-contain) to match what the server will actually
                                store: EmojiImageProcessorService center-crops every upload
                                to FILL a 128×128 square (fit: 'cover'), never letterboxing
                                it — the preview should show the same fill, not a hint of
                                bars this pick will never actually have. */}
                            <img
                                src={pending.previewUrl}
                                alt=""
                                className="w-8 h-8 shrink-0 object-cover rounded bg-cl-raise/40"
                            />
                            <div className="flex-1 min-w-0">
                                <ClInput
                                    value={pending.name}
                                    onChange={e => setPending(p => p && { ...p, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })}
                                    placeholder="emoji_name"
                                    maxLength={32}
                                />
                            </div>
                            <ClButton size="sm" onClick={confirmAdd} disabled={uploading}>
                                {uploading ? 'Uploading…' : 'Add'}
                            </ClButton>
                            <ClButton size="sm" variant="ghost" onClick={() => setPending(null)} disabled={uploading}>
                                Cancel
                            </ClButton>
                        </div>
                    )}
                </div>
            )}

            {emojis.length === 0 ? (
                <p className="text-sm text-cl-faint text-center py-8">No custom emojis yet.</p>
            ) : (
                <div className="dock-card rounded-[14px] border border-cl-border/40 bg-cl-surface/40 p-2 grid grid-cols-1 sm:grid-cols-2 gap-1">
                    {emojis.map(e => (
                        <div key={e.emoji_id} className="flex items-center gap-3 px-3 py-2 bg-cl-raise/20 border border-cl-border rounded-xl">
                            <EmojiImage
                                name={e.name}
                                attachmentId={e.attachment_id}
                                keyB64={e.key_b64}
                                nonceB64={e.nonce_b64}
                                token={token}
                                className="w-8 h-8 shrink-0"
                            />
                            {renamingId === e.emoji_id ? (
                                <div className="flex-1 min-w-0 flex items-center gap-1.5">
                                    <ClInput
                                        value={renameValue}
                                        onChange={e => setRenameValue(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                                        maxLength={32}
                                        autoFocus
                                    />
                                    <ClButton size="sm" onClick={() => confirmRename(e.emoji_id)}><Check size={14} /></ClButton>
                                    <ClButton size="sm" variant="ghost" onClick={() => setRenamingId(null)}><X size={14} /></ClButton>
                                </div>
                            ) : (
                                <>
                                    <p className="flex-1 min-w-0 text-sm text-cl-text truncate font-mono">:{e.name}:</p>
                                    {canManageEmojis && (
                                        <div className="flex items-center gap-1 shrink-0">
                                            <ClButton size="sm" variant="ghost" onClick={() => startRename(e)}>
                                                <Pencil size={14} />
                                            </ClButton>
                                            <ClButton
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => doDelete(e.emoji_id)}
                                                disabled={deletingId === e.emoji_id}
                                            >
                                                <Trash2 size={14} className="text-cl-flash" />
                                            </ClButton>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Bans Tab ─────────────────────────────────────────────────────────────────

function BansTab({ server, token }: { server: ServerInfo; token: string | null }) {
    const [bans, setBans] = useState<BanEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const toast = useToast();

    const load = useCallback(async () => {
        if (!token) return;
        try {
            const res = await axios.get(`${API_BASE}/servers/${server.server_id}/bans`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            setBans(res.data ?? []);
        } catch { }
        finally { setLoading(false); }
    }, [server.server_id, token]);

    useEffect(() => { load(); }, [load]);

    const unban = async (targetUserId: string) => {
        if (!token) return;
        try {
            await axios.post(
                `${API_BASE}/servers/${server.server_id}/members/${targetUserId}/unban`,
                {},
                { headers: { Authorization: `Bearer ${token}` } },
            );
            setBans(b => b.filter(x => x.user_id !== targetUserId));
        } catch (e: any) { toast.push({ kind: 'error', message: e?.response?.data?.message ?? 'Failed to unban' }); }
    };

    if (loading) return <div className="flex justify-center py-8"><div className="w-5 h-5 border-2 border-cl-border border-t-cl-lume rounded-full animate-spin" /></div>;

    return (
        <div className="space-y-3">
            {bans.length === 0 ? (
                <p className="text-sm text-cl-faint text-center py-8">No banned members.</p>
            ) : (
                <div className="dock-card rounded-[14px] border border-cl-border/40 bg-cl-surface/40 p-2 space-y-1">
                    {bans.map(b => (
                        <div key={b.user_id} className="flex items-center gap-3 px-3 py-2.5 bg-cl-raise/20 border border-cl-border rounded-xl">
                            <div className="flex-1 min-w-0">
                                <p className="text-sm text-cl-text truncate font-medium">
                                    {b.username
                                        ? displayName(b.username, b.discriminator)
                                        : <span className="text-cl-faint">Unknown User</span>
                                    }
                                </p>
                                {b.ban_reason && <p className="text-xs text-cl-faint truncate">Reason: {b.ban_reason}</p>}
                                <p className="text-xs text-cl-faint/60">{new Date(b.banned_at).toLocaleDateString()}</p>
                            </div>
                            <ClButton size="sm" variant="ghost" onClick={() => unban(b.user_id)}>Unban</ClButton>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ── Audit Log Tab ─────────────────────────────────────────────────────────────

function AuditTab({ server, token }: { server: ServerInfo; token: string | null }) {
    const [entries, setEntries] = useState<AuditEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [hasMore, setHasMore] = useState(false);
    const toast = useToast();

    const load = useCallback(async (before?: string) => {
        if (!token) return;
        setLoading(true);
        try {
            const params: any = { limit: 50 };
            if (before) params.before = before;
            const res = await axios.get(`${API_BASE}/servers/${server.server_id}/audit_log`, {
                headers: { Authorization: `Bearer ${token}` },
                params,
            });
            const data: AuditEntry[] = res.data ?? [];
            setEntries(prev => before ? [...prev, ...data] : data);
            setHasMore(data.length === 50);
        } catch (e: any) { toast.push({ kind: 'error', message: e?.response?.data?.message ?? 'Failed to load audit log' }); }
        finally { setLoading(false); }
    }, [server.server_id, token]);

    useEffect(() => { load(); }, [load]);

    const loadMore = () => {
        const last = entries[entries.length - 1];
        if (last) load(last.id);
    };

    const actionColor: Record<string, string> = {
        'member.kick': 'text-cl-flash',
        'member.ban': 'text-cl-flash',
        'member.unban': 'text-cl-ok',
        'member.mute': 'text-cl-glow',
        'channel.create': 'text-cl-lume',
        'channel.delete': 'text-cl-flash',
        'role.create': 'text-cl-lume',
        'role.delete': 'text-cl-flash',
        'server.update': 'text-cl-lume',
    };

    if (loading && entries.length === 0) return <div className="flex justify-center py-8"><div className="w-5 h-5 border-2 border-cl-border border-t-cl-lume rounded-full animate-spin" /></div>;

    return (
        <div className="space-y-2">
            <div className="dock-card rounded-[14px] border border-cl-border/40 bg-cl-surface/40 p-2 space-y-1 max-h-[420px] overflow-y-auto custom-scrollbar">
                {entries.map(e => (
                    <div key={e.id} className="flex items-start gap-3 px-3 py-2 bg-cl-raise/15 border border-cl-border rounded-xl">
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                                <span className={`text-xs font-semibold ${actionColor[e.action] ?? 'text-cl-muted'}`}>{e.action}</span>
                                <span className="text-[10px] text-cl-faint/60">{new Date(e.created_at).toLocaleString()}</span>
                            </div>
                            <p className="text-xs text-cl-faint truncate mt-0.5">
                                actor: <span className="text-cl-muted font-medium">
                                    {e.actor_username ?? 'Unknown User'}
                                </span>
                                {e.target_user_id && <>
                                    {' · '}target: <span className="text-cl-muted font-medium">
                                        {e.target_username ?? 'Unknown User'}
                                    </span>
                                </>}
                            </p>
                        </div>
                    </div>
                ))}
                {entries.length === 0 && !loading && (
                    <p className="text-sm text-cl-faint text-center py-8">No audit log entries yet.</p>
                )}
            </div>
            {hasMore && (
                <ClButton variant="ghost" fullWidth disabled={loading} loading={loading} onClick={loadMore}>Load more</ClButton>
            )}
        </div>
    );
}

// ── Main Modal ───────────────────────────────────────────────────────────────

export const ServerSettingsModal: React.FC<Props> = ({
    server,
    token,
    userId,
    myPermissions = 0n,
    onClose,
    onServerUpdated,
    storageRefreshKey,
    tabRequest,
}) => {
    // Owner short-circuits MANAGE_ROLES; otherwise check the bit (1 << 2).
    // Server still re-validates on every PATCH/POST, so this is purely UX-gating.
    // Per-tab gating now lives in serverSettingsAccess (shared with Dashboard's
    // entry-point check). Only the two flags that drive controls INSIDE a tab
    // are still needed here; the rest of the hand-rolled bit tests were folded
    // into the helper. Note these used raw `1n << n` literals rather than the
    // Permissions constants, which is how the "(1 << 2) // MANAGE_SERVER"
    // mislabelling that predates this got in.
    const isOwner         = server.owner_user_id === userId;
    const hasAdmin        = hasPermission(myPermissions, Permissions.ADMINISTRATOR);
    const canManageRoles  = isOwner || hasAdmin || hasPermission(myPermissions, Permissions.MANAGE_ROLES);
    const canManageServer = isOwner || hasAdmin || hasPermission(myPermissions, Permissions.MANAGE_SERVER);
    const canManageEmojis = isOwner || hasAdmin || hasPermission(myPermissions, Permissions.MANAGE_EMOJIS);

    /** Per-tab visibility. Shared with Dashboard's gear-icon gate via
     *  serverSettingsAccess so the entry point and the contents can never
     *  disagree — they used to, and the mismatch is what let ordinary members
     *  reach the Overview form. Server-side enforces every individual write, so
     *  this is purely UX. */
    const tabVisibility = serverSettingsTabVisibility(myPermissions, isOwner);
    const visibleTabs = TABS.filter(t => tabVisibility[t.id]);

    // The user's *requested* tab — what they clicked. If that tab becomes
    // hidden (e.g. their permissions were revoked mid-session), the *effective*
    // activeTab below falls back to the first visible tab — no useEffect /
    // cascading-render dance needed.
    // A deep link (`tabRequest`) is seeded here rather than applied in an effect
    // so the requested tab is what gets painted first — an effect would show a
    // frame of Overview and then jump.
    const [requestedTab, setRequestedTab] = useState<Tab>(
        () => tabRequest?.tab ?? visibleTabs[0]?.id ?? 'overview',
    );
    // `?? requestedTab` on an EMPTY visibleTabs used to resolve to 'overview'
    // and render the server name/description form to someone with no
    // permissions at all. Nothing visible now means nothing rendered — see the
    // guard below, which returns before this is ever used.
    const activeTab: Tab = tabVisibility[requestedTab] ? requestedTab : (visibleTabs[0]?.id ?? requestedTab);
    const setActiveTab = setRequestedTab;

    const activeMeta = TABS.find(t => t.id === activeTab);

    // ── Windowed ↔ full-screen, live on resize ──────────────────────────────
    const dockWindowed = useCallback(
        () => window.innerWidth >= 1080 && window.innerHeight >= 780,
        [],
    );
    const [windowed, setWindowed] = useState(dockWindowed);
    useEffect(() => {
        const onResize = () => setWindowed(dockWindowed());
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [dockWindowed]);

    // ── Unsaved edits (overview form, role permissions, channel overrides)
    //    gate every exit and tab switch behind a confirm ──
    const unsaved = useUnsavedChangesGuard('Your server changes');
    const requestClose = useCallback(() => unsaved.guard(onClose), [unsaved.guard, onClose]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Escape closes the shell through the shared stack (guarded) — a kit
    //    modal or the unsaved-changes prompt opened on top pushes its own
    //    layer and is reached first, so no manual "is one open" check needed ──
    useEscape(requestClose);

    // ── Directional pane motion ──
    const flatTabOrder = TAB_SECTIONS.flatMap(s => s.ids);
    const [tabDir, setTabDir] = useState<1 | -1>(1);
    const selectTab = (id: Tab) => {
        if (id === activeTab) return;
        unsaved.guard(() => selectTabNow(id));
    };
    const selectTabNow = (id: Tab) => {
        const fromIdx = flatTabOrder.indexOf(activeTab);
        const toIdx = flatTabOrder.indexOf(id);
        setTabDir(toIdx >= fromIdx ? 1 : -1);
        setActiveTab(id);
    };

    /**
     * Re-target a modal that is ALREADY open (the mount case is handled by the
     * `requestedTab` seed above). Routed through `selectTab`, not
     * `setRequestedTab`, so an unsaved Overview edit still gets its confirm
     * prompt instead of being silently thrown away by the navigation.
     *
     * Keyed on the nonce alone: on mount this fires once with the nonce already
     * applied by the seed, and `selectTab` no-ops on a same-tab request anyway.
     */
    const appliedTabNonce = useRef(tabRequest?.nonce);
    useEffect(() => {
        if (!tabRequest || appliedTabNonce.current === tabRequest.nonce) return;
        appliedTabNonce.current = tabRequest.nonce;
        selectTab(tabRequest.tab);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tabRequest?.nonce, tabRequest?.tab]);

    // ── The sliding berth bead ──
    const railScrollRef = useRef<HTMLDivElement>(null);
    const railBtnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    const [beadBox, setBeadBox] = useState<{ top: number; height: number } | null>(null);
    const measureBead = useCallback(() => {
        const btn = railBtnRefs.current[activeTab];
        const scroller = railScrollRef.current;
        if (!btn || !scroller) return;
        setBeadBox({ top: btn.offsetTop, height: btn.offsetHeight });
    }, [activeTab]);
    useLayoutEffect(measureBead, [measureBead, visibleTabs.length]);
    useEffect(() => {
        const onResize = () => measureBead();
        window.addEventListener('resize', onResize);
        const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts;
        if (fonts?.ready) fonts.ready.then(measureBead);
        const t = setTimeout(measureBead, 300);
        return () => { window.removeEventListener('resize', onResize); clearTimeout(t); };
    }, [measureBead]);

    // Nothing this user can act on — render nothing at all rather than falling
    // through to the first tab. Reaching here means the caller offered an entry
    // point it shouldn't have (Dashboard now gates on the same
    // canOpenServerSettings helper, so this is a backstop, not the normal path);
    // previously that fall-through handed a plain member the editable server
    // name and description. Placed after every hook so hook order is stable.
    if (visibleTabs.length === 0) return null;

    return (
        <div
            className={windowed ? 'dock-veil' : 'fixed inset-0 z-50'}
            onClick={windowed ? (e) => { if (e.target === e.currentTarget) requestClose(); } : undefined}
        >
            <motion.div
                initial={windowed ? { opacity: 0, y: 38 } : { opacity: 0 }}
                animate={{ opacity: 1, y: 0 }}
                exit={windowed
                    ? { opacity: 0, y: 28, transition: { duration: 0.26, ease: [0.4, 0, 0.7, 1] } }
                    : { opacity: 0, transition: { duration: 0.2 } }}
                transition={windowed
                    ? { type: 'spring', stiffness: 300, damping: 26, mass: 0.9 }
                    : { duration: 0.28 }}
                className={`dock-root ${windowed ? 'dock-root--win' : 'dock-root--full'}`}
            >
                {/* Fullscreen only — see the CSS comment on .dock-topbar. */}
                {!windowed && <div className="dock-topbar drag-region" />}

                {/* ── Masthead — the settings sheet flies the server's flag.
                       Banner servers get their photo fading into the deck; the
                       rest get the lume-glow identity strip. ── */}
                <div className="dock-masthead">
                    {server.banner_attachment && server.banner_key_b64 && server.banner_nonce_b64 ? (
                        <>
                            <ServerIcon
                                serverId={server.server_id}
                                name={server.name}
                                attachmentId={server.banner_attachment}
                                keyB64={server.banner_key_b64}
                                nonceB64={server.banner_nonce_b64}
                                token={token}
                                className="absolute inset-0 w-full h-full object-cover"
                            />
                            <div className="absolute inset-0 bg-gradient-to-r from-cl-deep via-cl-deep/85 to-cl-deep/40 pointer-events-none" />
                            <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-cl-deep to-transparent pointer-events-none" />
                        </>
                    ) : (
                        <div
                            className="absolute inset-0"
                            style={{ background: 'radial-gradient(420px 160px at 18% 130%, var(--cl-lume-tint), transparent 70%), var(--cl-deep)' }}
                        />
                    )}
                    <div className="relative h-full px-6 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3.5 min-w-0">
                            <ServerIcon
                                serverId={server.server_id}
                                name={server.name}
                                attachmentId={server.icon_attachment ?? null}
                                keyB64={server.icon_key_b64 ?? null}
                                nonceB64={server.icon_nonce_b64 ?? null}
                                token={token}
                                className="w-11 h-11 rounded-xl text-sm shrink-0"
                            />
                            <div className="min-w-0">
                                <p
                                    className="text-[10px] font-mono font-semibold uppercase text-cl-faint m-0 mb-0.5"
                                    style={{ letterSpacing: '1.4px' }}
                                >
                                    Server Settings
                                </p>
                                <p className="text-[20px] font-display font-semibold text-cl-text truncate leading-tight m-0" style={{ textShadow: '0 1px 8px rgba(0,0,0,.5)' }}>
                                    {server.name}
                                </p>
                            </div>
                        </div>
                        <div className="flex flex-col items-center gap-1 shrink-0">
                            <ClButton icon size="sm" variant="ghost" onClick={requestClose} tooltip="Back to deck">
                                <X size={15} />
                            </ClButton>
                            <span className="text-[9px] font-mono text-cl-faint select-none" style={{ letterSpacing: '1px' }}>ESC</span>
                        </div>
                    </div>
                </div>

                <div className="flex-1 flex min-h-0 border-t border-cl-border/30 dock-workspace">
                    <DockBackdrop />

                    {/* Left rail — stations, grouped by the work they do. */}
                    <div className="dock-rail">
                        <div ref={railScrollRef} className="dock-rail-scroll custom-scrollbar">
                            {beadBox && (
                                <span
                                    className="dock-bead"
                                    style={{ top: beadBox.top, height: beadBox.height }}
                                    aria-hidden="true"
                                />
                            )}
                            {TAB_SECTIONS.map(section => {
                                const items = visibleTabs.filter(t => section.ids.includes(t.id));
                                if (!items.length) return null;
                                return (
                                    <div key={section.name} className="mb-4">
                                        <p
                                            className="text-[9.5px] font-mono font-semibold uppercase text-cl-faint px-3 pb-1.5 m-0"
                                            style={{ letterSpacing: '1.3px' }}
                                        >
                                            {section.name}
                                        </p>
                                        <div className="flex flex-col gap-0.5">
                                            {items.map(t => {
                                                const isActive = activeTab === t.id;
                                                return (
                                                    <button
                                                        key={t.id}
                                                        type="button"
                                                        ref={el => { railBtnRefs.current[t.id] = el; }}
                                                        onClick={() => selectTab(t.id)}
                                                        className={`relative flex items-center gap-2.5 w-full px-3 py-2 rounded-[10px] text-left text-[13.5px] font-semibold transition-all cursor-pointer border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cl-lume/50 ${
                                                            isActive
                                                                ? 'bg-cl-lume/[0.08] border-cl-lume/25 text-cl-lume shadow-[0_0_16px_rgba(37,224,200,.12)]'
                                                                : 'bg-transparent border-transparent text-cl-muted hover:text-cl-text hover:bg-white/[0.05]'
                                                        }`}
                                                    >
                                                        {/* Active station gets an icon "chip" — a small anchor point,
                                                            same idea as LimitField's icon chips (ChannelSettingsDialog.tsx).
                                                            Inactive rows stay plain so the chip reads as presence, not noise. */}
                                                        {isActive ? (
                                                            <span className="w-[22px] h-[22px] rounded-md bg-cl-lume/15 text-cl-lume flex items-center justify-center shrink-0">
                                                                {t.icon}
                                                            </span>
                                                        ) : (
                                                            <span className="text-cl-faint shrink-0">{t.icon}</span>
                                                        )}
                                                        <span className="truncate">{t.label}</span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                );
                            })}
                            <span style={{ marginTop: 'auto' }} />
                            {/* Registry plate — short server id (handy for support) + the promise. */}
                            <p className="text-[9px] font-mono text-cl-faint px-3 pt-3 m-0 select-none" style={{ letterSpacing: '0.8px' }}>
                                ID {server.server_id.slice(0, 8).toUpperCase()}
                                <br />End-to-end encrypted
                            </p>
                        </div>
                    </div>

                    {/* Right content — the drafting table, lit by the same caustics
                        as the rail (a bigger, fainter, slower bleed of the same
                        light) instead of a separate blueprint-grid treatment. */}
                    <div className="dock-content" style={{ background: 'var(--cl-deep)' }}>

                        {/* Header — station name + description. The icon chip mirrors
                            the rail's active-row treatment (same bg-cl-lume/15 +
                            text-cl-lume recipe) so the header reads as a
                            continuation of the rail's language, not a separate
                            plain title bar. dock-header-glow replaces a flat
                            border-b with a lume hairline, matching the rail's
                            own seam treatment. */}
                        <div className="dock-header h-20 flex items-center gap-3.5 px-10 shrink-0" style={{ position: 'relative', zIndex: 1 }}>
                            {activeMeta?.icon && (
                                <div className="w-10 h-10 rounded-xl bg-cl-lume/15 text-cl-lume flex items-center justify-center shrink-0">
                                    {activeMeta.icon}
                                </div>
                            )}
                            <div className="min-w-0">
                                <h2 className="text-2xl font-display font-semibold text-cl-text leading-tight tracking-tight truncate">
                                    {activeMeta?.label}
                                </h2>
                                {activeMeta?.description && (
                                    <p className="text-[12px] text-cl-faint mt-0.5 truncate">{activeMeta.description}</p>
                                )}
                            </div>
                        </div>

                        {/* Tab content — Roles gets its own bounded, unpadded flex
                            slot (it manages its own internal scroll and needs a
                            real height to lay out against); every other tab keeps
                            the shared padded/scrolling wrapper below. */}
                        <div className="flex-1 min-h-0 flex flex-col" style={{ position: 'relative', zIndex: 1 }}>
                            <AnimatePresence mode="wait">
                                {activeTab === 'roles' ? (
                                    <motion.div
                                        key="roles"
                                        initial={{ opacity: 0, y: tabDir * 18 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, transition: { duration: 0.09 } }}
                                        transition={{ type: 'spring', stiffness: 340, damping: 30, mass: 0.8 }}
                                        className="flex-1 min-h-0 flex flex-col"
                                    >
                                        <RolesTabContainer server={server} token={token} canManage={canManageRoles} onDirtyChange={unsaved.setDirty} />
                                    </motion.div>
                                ) : (
                                    <motion.div
                                        key={activeTab}
                                        initial={{ opacity: 0, y: tabDir * 18 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, transition: { duration: 0.09 } }}
                                        transition={{ type: 'spring', stiffness: 340, damping: 30, mass: 0.8 }}
                                        className="flex-1 min-h-0 overflow-y-auto custom-scrollbar"
                                    >
                                        <div className="px-10 py-8 max-w-5xl mx-auto">
                                            {activeTab === 'overview'  && <OverviewTab  server={server} token={token} onServerUpdated={onServerUpdated} storageRefreshKey={storageRefreshKey} canManageServer={canManageServer} isOwner={server.owner_user_id === userId} onDeleted={onClose} onDirtyChange={unsaved.setDirty} />}
                                            {activeTab === 'members'   && <MembersTab   server={server} token={token} userId={userId} onServerUpdated={onServerUpdated} />}
                                            {activeTab === 'invites'   && <InvitesTab   server={server} token={token} canManageServer={canManageServer} />}
                                            {activeTab === 'emojis'    && <EmojisTab    server={server} token={token} canManageEmojis={canManageEmojis} />}
                                            {activeTab === 'bans'      && <BansTab      server={server} token={token} />}
                                            {activeTab === 'audit'     && <AuditTab     server={server} token={token} />}
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    </div>
                </div>
            </motion.div>
            {unsaved.dialog}
        </div>
    );
};

export default ServerSettingsModal;
