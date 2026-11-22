/**
 * ServerInviteEmbed — rich card rendered inline in chat when a message
 * contains `{ type: 'server_invite', code }`.
 *
 * States:
 *   loading      — "Loading invite…" while fetching preview
 *   valid        — server card with icon, name, description, member count, Join button
 *   joined       — already a member → "✓ Already joined" badge + Go to Server button
 *   invalid      — the server said not found / expired / used up → greyed-out
 *                  "Invite expired" card. The ONLY state that says expired.
 *   error        — couldn't load (rate limited, offline, 5xx — auto-retried by
 *                  useInvitePreview before it gets here) → "Couldn't load" + Retry
 *
 * Every state that is not a server card shows the invite link itself. A bare
 * invite link is hidden from the message text when the card renders
 * (utils/formatting/inviteLinks.ts), and a `server_invite` message has no text
 * at all, so for a message that is ONLY an invite the card is the whole
 * message: a skeleton or a status line without the link left the sender
 * looking at a row with nothing of what he sent in it, and he sent it again.
 *
 * The preview is not asked for until the card is near the viewport
 * (useNearViewport), and every card shares one cached, rate-aware lookup
 * (utils/invitePreviewCache.ts).
 */

import React, { useRef, useState } from 'react';
import axios from 'axios';
import { Users, ServerCrash, CheckCircle2, Clock, Ticket, RotateCw } from 'lucide-react';
import { apiUrl } from '../../utils/apiPath';
import { ServerIcon } from './ServerIcon';
import { useContextMenu } from '../../hooks/useContextMenu';
import { useInvitePreview } from '../../hooks/useInvitePreview';
import { useNearViewport } from '../../hooks/useNearViewport';
import type { ServerInfo } from '../../hooks/useServers';
import { ClButton } from '../cl';
import { copyText } from '../../utils/clipboard';
import { useToast } from '../../contexts/ToastContext';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
    code: string;
    token: string | null;
    /** Current user's server list — used to detect "already a member". */
    servers: ServerInfo[];
    onJoin: (serverId: string, serverName: string) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export const ServerInviteEmbed: React.FC<Props> = ({ code, token, servers, onJoin }) => {
    const boxRef = useRef<HTMLDivElement>(null);
    const near = useNearViewport(boxRef);
    const { preview, state, reload } = useInvitePreview(code, token, servers, { enabled: near });
    const [joining, setJoining]   = useState(false);
    const [joinError, setJoinError] = useState<string | null>(null);
    const ctx = useContextMenu();
    const toast = useToast();

    const inviteUrl = `https://cipherline.chat/invite/${code}`;
    // The link as the sender wrote it (minus the scheme): shown in every state
    // that is not a server card, so the message is never an empty box.
    const linkLine = (
        <p className="text-[11px] text-cl-faint mt-0.5 select-text truncate" title={inviteUrl} data-invite-link>
            {inviteUrl.replace(/^https:\/\//, '')}
        </p>
    );
    const handleContextMenu = (e: React.MouseEvent) => {
        ctx.open(e, [
            {
                label: 'Copy Invite Link',
                onSelect: () => {
                    // The link is printed on the card (linkLine), so a failed copy is still recoverable.
                    void copyText(inviteUrl).then(ok => toast.push(ok
                        ? { kind: 'success', message: 'Invite link copied.' }
                        : { kind: 'error', message: 'Could not copy. Select the link on the card and copy it yourself.' }));
                },
            },
        ]);
    };

    // ── Join ──────────────────────────────────────────────────────────────────

    const handleJoin = async () => {
        if (!token || !preview || joining) return;
        setJoining(true);
        setJoinError(null);
        try {
            await axios.post(
                apiUrl`/invites/${code}/accept`,
                {},
                { headers: { Authorization: `Bearer ${token}` } },
            );
            // See the identical fix in JoinServerModal: `state` belongs to
            // useInvitePreview and has no setter, so this referenced an
            // undeclared name and threw right after a SUCCESSFUL join —
            // surfacing "Failed to join" and skipping onJoin(), which is what
            // made the joined server only appear after a restart. The hook
            // reconciles to 'joined' on its own once `servers` includes it.
            onJoin(preview.server_id, preview.server_name);
        } catch (e: unknown) {
            const msg = axios.isAxiosError(e) ? e.response?.data?.message : undefined;
            if (!axios.isAxiosError(e)) console.error('[ServerInviteEmbed] join threw:', e);
            setJoinError(msg ?? 'Failed to join');
        } finally {
            setJoining(false);
        }
    };

    // ── Derived invite metadata ───────────────────────────────────────────────
    // Both round DOWN and stop at "soon"/"expired" rather than counting
    // seconds — a live-ticking countdown in a chat transcript would be noise,
    // and the card doesn't re-render on a timer anyway.
    const expiryLabel = (() => {
        if (!preview?.expires_at) return null;
        const ms = Date.parse(preview.expires_at) - Date.now();
        if (!Number.isFinite(ms)) return null;
        if (ms <= 0) return 'Expired';
        const days = Math.floor(ms / 86_400_000);
        if (days >= 1) return `${days}d left`;
        const hours = Math.floor(ms / 3_600_000);
        if (hours >= 1) return `${hours}h left`;
        return 'Expires soon';
    })();

    const usesLabel = (() => {
        if (!preview?.max_uses) return null;      // null/0 = unlimited, nothing to say
        const left = Math.max(0, preview.max_uses - (preview.uses ?? 0));
        return `${left} use${left === 1 ? '' : 's'} left`;
    })();

    // ── Render ────────────────────────────────────────────────────────────────

    const cardContent = (() => {
        if (state === 'loading') {
            return (
                <div className="cl-invite-card cl-invite-card--flat" aria-busy="true">
                    <div className="w-10 h-10 rounded-xl bg-white/[0.06] animate-pulse shrink-0" />
                    <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold text-cl-muted leading-tight">Loading invite…</p>
                        {linkLine}
                    </div>
                </div>
            );
        }

        if (state === 'invalid') {
            return (
                <div className="cl-invite-card cl-invite-card--flat cl-invite-card--dead">
                    <span className="w-10 h-10 rounded-xl bg-white/[0.05] flex items-center justify-center shrink-0">
                        <ServerCrash size={18} className="text-cl-faint" />
                    </span>
                    <div className="min-w-0">
                        <p className="text-[13px] font-semibold text-cl-muted leading-tight">Invite expired</p>
                        <p className="text-[11px] text-cl-faint mt-0.5">This invite link is no longer valid.</p>
                        {linkLine}
                    </div>
                </div>
            );
        }

        if (state === 'error' || !preview) {
            // Not a dead invite: we could not find out (rate limited, offline,
            // a server error), and useInvitePreview already retried quietly.
            // So it looks like a card that is still there, with a Retry.
            return (
                <div className="cl-invite-card cl-invite-card--flat">
                    <span className="w-10 h-10 rounded-xl bg-white/[0.05] flex items-center justify-center shrink-0">
                        <Ticket size={18} className="text-cl-muted" />
                    </span>
                    <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold text-cl-muted leading-tight">Couldn’t load this invite</p>
                        {linkLine}
                    </div>
                    <button
                        type="button"
                        onClick={reload}
                        className="flex items-center gap-1 text-[12px] font-semibold text-cl-muted hover:text-cl-text shrink-0 px-2 py-1 rounded-md hover:bg-white/[0.05]"
                    >
                        <RotateCw size={12} /> Retry
                    </button>
                </div>
            );
        }

        const joined = state === 'joined';
        return (
            <div className="cl-invite-card">
                {/* Eyebrow — names the thing before the card's content does, so
                    an invite is identifiable at a glance in a busy channel
                    rather than reading as just another server-shaped box. */}
                <div className="cl-invite-eyebrow">
                    {joined ? 'You’re already in this server' : 'You’ve been invited to join'}
                </div>

                <div className="cl-invite-body">
                    <ServerIcon
                        serverId={preview.server_id}
                        name={preview.server_name}
                        attachmentId={preview.server_icon}
                        keyB64={preview.server_icon_key_b64}
                        nonceB64={preview.server_icon_nonce_b64}
                        token={token}
                        className="cl-invite-icon"
                    />

                    <div className="flex-1 min-w-0">
                        <p className="cl-invite-name">{preview.server_name}</p>
                        {preview.server_description && (
                            <p className="cl-invite-desc">{preview.server_description}</p>
                        )}
                        <div className="cl-invite-meta">
                            <span className="cl-invite-metaitem">
                                <Users size={11} className="shrink-0" />
                                {preview.member_count.toLocaleString()} member{preview.member_count !== 1 ? 's' : ''}
                            </span>
                            {/* expires_at / uses / max_uses were fetched and then
                                thrown away — surfacing them is the difference
                                between "a link" and knowing whether it's about
                                to stop working. */}
                            {expiryLabel && (
                                <span className="cl-invite-metaitem">
                                    <Clock size={11} className="shrink-0" />
                                    {expiryLabel}
                                </span>
                            )}
                            {usesLabel && (
                                <span className="cl-invite-metaitem">
                                    <Ticket size={11} className="shrink-0" />
                                    {usesLabel}
                                </span>
                            )}
                        </div>
                    </div>
                </div>

                <div className="cl-invite-foot">
                    {joinError && <p className="cl-invite-err">{joinError}</p>}
                    {joined ? (
                        <ClButton
                            variant="ghost"
                            fullWidth
                            onClick={() => onJoin(preview.server_id, preview.server_name)}
                        >
                            <CheckCircle2 size={14} />
                            Go to Server
                        </ClButton>
                    ) : (
                        <ClButton
                            fullWidth
                            onClick={handleJoin}
                            disabled={joining || !token}
                            loading={joining}
                        >
                            Join Server
                        </ClButton>
                    )}
                </div>
            </div>
        );
    })();

    return (
        <>
            {/* Wrap in a div so onContextMenu fires wherever the user right-clicks
                the card — even over its border/padding area. */}
            <div ref={boxRef} className="mt-1 select-none" onContextMenu={handleContextMenu} data-invite-state={state}>
                {cardContent}
            </div>
            {ctx.menu}
        </>
    );
};
