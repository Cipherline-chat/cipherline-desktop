/**
 * Server settings → Roles → role editor: the role's ICON (Discord parity).
 *
 *   Upload image  → encrypted upload (purpose 'role_icon', MANAGE_ROLES) then
 *                   PUT /servers/:sid/roles/:rid/icon; the API resizes it to a
 *                   128px square and re-encrypts it (same as custom emojis).
 *   Choose emoji  → PATCH roles/:rid { icon_emoji } (unicode only).
 *   Remove        → DELETE roles/:rid/icon.
 *
 * Free on every server (Discord gates role icons behind boosts; we do not).
 * The server enforces MANAGE_ROLES + the role hierarchy on every route; this
 * component only mirrors it with `readOnly`.
 */
import React, { useRef, useState } from 'react';
import axios from 'axios';
import { ImagePlus, Smile, X } from 'lucide-react';
import { apiUrl } from '../../../utils/apiPath';
import { useAttachments } from '../../../hooks/useAttachments';
import { roleIconOf } from '../../../utils/roleStyle';
import { ClButton } from '../../cl';
import EmojiPickerPopover from '../../emojiPickerLazy';
import { RoleIconBadge } from './RoleIconBadge';
import type { Role } from './types';
import { ROLE_ICON_MIMES, roleIconErrorMessage, roleIconFileError } from './roleIconPickerModel';

type Busy = 'upload' | 'emoji' | 'remove' | null;

const ICON_FIELDS_CLEARED = { icon_emoji: null, icon_attachment_id: null, icon_key_b64: null, icon_nonce_b64: null } as const;

export const RoleIconPicker: React.FC<{
    role: Role;
    serverId: string;
    token: string | null;
    readOnly?: boolean;
    onSaved: (next: Role) => void;
}> = ({ role, serverId, token, readOnly, onSaved }) => {
    const [busy, setBusy] = useState<Busy>(null);
    const [error, setError] = useState<string | null>(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    // The emoji button's wrapper, kept in state (the picker positions off it during render).
    const [emojiWrap, setEmojiWrap] = useState<HTMLSpanElement | null>(null);
    const { uploadEncryptedFile } = useAttachments(token);
    const icon = roleIconOf(role, serverId);
    const headers = { Authorization: `Bearer ${token}` };
    const disabled = readOnly || !token || busy !== null;

    const onFile = async (file: File | undefined) => {
        if (fileRef.current) fileRef.current.value = '';
        if (!file || !token) return;
        const pre = roleIconFileError(file);
        if (pre) { setError(pre); return; }
        setError(null);
        setBusy('upload');
        try {
            const up = await uploadEncryptedFile(file, '', file.type, undefined, undefined, serverId, 'role_icon');
            const res = await axios.put(
                apiUrl`/servers/${serverId}/roles/${role.role_id}/icon`,
                { attachment_id: up.attachmentId, key_b64: up.keyB64, nonce_b64: up.nonceB64 },
                { headers },
            );
            const d = res.data ?? {};
            onSaved({
                ...role,
                icon_emoji: null,
                icon_attachment_id: d.icon_attachment_id ?? up.attachmentId,
                icon_key_b64: d.icon_key_b64 ?? null,
                icon_nonce_b64: d.icon_nonce_b64 ?? null,
            });
        } catch (e) {
            setError(roleIconErrorMessage(e));
        } finally {
            setBusy(null);
        }
    };

    const onEmoji = async (emoji: string) => {
        if (!token) return;
        setError(null);
        setBusy('emoji');
        const prev = role;
        onSaved({ ...role, ...ICON_FIELDS_CLEARED, icon_emoji: emoji }); // optimistic
        try {
            await axios.patch(apiUrl`/servers/${serverId}/roles/${role.role_id}`, { icon_emoji: emoji }, { headers });
        } catch (e) {
            onSaved(prev);
            setError(roleIconErrorMessage(e));
        } finally {
            setBusy(null);
        }
    };

    const onRemove = async () => {
        if (!token) return;
        setError(null);
        setBusy('remove');
        const prev = role;
        onSaved({ ...role, ...ICON_FIELDS_CLEARED }); // optimistic
        try {
            await axios.delete(apiUrl`/servers/${serverId}/roles/${role.role_id}/icon`, { headers });
        } catch (e) {
            onSaved(prev);
            setError(roleIconErrorMessage(e));
        } finally {
            setBusy(null);
        }
    };

    return (
        <section data-testid="role-icon-picker">
            <label className="block text-[11px] font-mono font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--cl-faint)' }}>
                Role Icon
            </label>
            <p className="text-[12px] text-cl-faint mb-3">
                Shown next to member names in the member list and on profiles. Members show the icon of their highest role that has one.
            </p>
            <div className="flex items-center gap-4 flex-wrap">
                <div
                    className="w-14 h-14 rounded-2xl shrink-0 flex items-center justify-center border border-dashed border-cl-border/70"
                    style={{ background: 'var(--cl-sink)' }}
                    aria-live="polite"
                    data-testid="role-icon-preview"
                >
                    {busy === 'upload' ? (
                        <span className="text-[11px] text-cl-faint" role="status">Uploading…</span>
                    ) : icon ? (
                        <RoleIconBadge icon={icon} token={token} size={32} />
                    ) : (
                        <span className="text-[11px] text-cl-faint">None</span>
                    )}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                    <input
                        ref={fileRef}
                        type="file"
                        accept={ROLE_ICON_MIMES.join(',')}
                        className="hidden"
                        tabIndex={-1}
                        aria-hidden="true"
                        onChange={e => { void onFile(e.target.files?.[0]); }}
                        data-testid="role-icon-file"
                    />
                    <ClButton size="sm" variant="ghost" onClick={() => fileRef.current?.click()} disabled={disabled} loading={busy === 'upload'}>
                        <ImagePlus size={13} aria-hidden="true" /> Upload image
                    </ClButton>
                    <span ref={setEmojiWrap} className="inline-flex">
                        <ClButton
                            size="sm"
                            variant="ghost"
                            onClick={() => setPickerOpen(o => !o)}
                            disabled={disabled}
                            loading={busy === 'emoji'}
                            ariaPressed={pickerOpen}
                        >
                            <Smile size={13} aria-hidden="true" /> Choose emoji
                        </ClButton>
                    </span>
                    {icon && (
                        <ClButton size="sm" variant="ghost" onClick={() => void onRemove()} disabled={disabled} loading={busy === 'remove'}>
                            <X size={13} aria-hidden="true" /> Remove
                        </ClButton>
                    )}
                </div>
            </div>
            <p className="mt-2 text-[12px] text-cl-faint">PNG, JPEG, WebP or GIF up to 5 MB, cropped to a square. Free on every server.</p>
            {error && <p role="alert" className="mt-2 text-[12px] cl-fmsg" data-testid="role-icon-error">{error}</p>}
            {pickerOpen && (
                <EmojiPickerPopover
                    anchorEl={emojiWrap}
                    onClose={() => setPickerOpen(false)}
                    onEmojiSelect={sel => {
                        setPickerOpen(false);
                        // Unicode only: a custom/personal emoji is not a role icon
                        // (upload the image instead).
                        if (sel.native) void onEmoji(sel.native);
                        else setError('Pick a standard emoji, or upload an image for a custom icon.');
                        emojiWrap?.querySelector('button')?.focus();
                    }}
                />
            )}
        </section>
    );
};
