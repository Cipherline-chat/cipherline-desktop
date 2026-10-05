/**
 * ServerInviteEmbed — rich card rendered inline in chat when a message
 * contains `{ type: 'server_invite', code }`.
 *
 * States:
 *   loading      — spinner while fetching preview
 *   valid        — server card with icon, name, description, member count, Join button
 *   joined       — already a member → "✓ Already joined" badge + Go to Server button
 *   invalid      — expired / not found → greyed-out "Invite expired" card
 *   error        — unexpected API failure (auto-retried by useInvitePreview
 *                  before it ever gets here — see that hook)
 */

import React, { useState } from 'react';
import axios from 'axios';
import { Users, ServerCrash, CheckCircle2, Clock, Ticket, RotateCw } from 'lucide-react';
import { API_BASE } from '../../constants';
import { ServerIcon } from './ServerIcon';
import { useContextMenu } from '../../hooks/useContextMenu';
import { useInvitePreview } from '../../hooks/useInvitePreview';
import type { ServerInfo } from '../../hooks/useServers';
import { ClButton } from '../cl';

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
    const { preview, state, reload } = useInvitePreview(code, token, servers);
    const [joining, setJoining]   = useState(false);
    const [joinError, setJoinError] = useState<string | null>(null);
    const ctx = useContextMenu();

    const inviteUrl = `https://cipherline.chat/invite/${code}`;
    const handleContextMenu = (e: React.MouseEvent) => {
        ctx.open(e, [
            {
                label: 'Copy Invite Link',
                onSelect: () => {
                    navigator.clipboard.writeText(inviteUrl).catch(() => {
                        (window as any).electronAPI?.writeClipboard?.(inviteUrl);
                    });
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
                `${API_BASE}/invites/${code}/accept`,
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
                <div className="cl-invite-card cl-invite-card--flat">
                    <div className="w-10 h-10 rounded-xl bg-white/[0.06] animate-pulse shrink-0" />
                    <div className="flex-1 space-y-1.5">
                        <div className="h-3 w-32 bg-white/[0.06] rounded animate-pulse" />
                        <div className="h-2.5 w-20 bg-white/[0.04] rounded animate-pulse" />
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
                    <div>
                        <p className="text-[13px] font-semibold text-cl-muted leading-tight">Invite expired</p>
                        <p className="text-[11px] text-cl-faint mt-0.5">This invite link is no longer valid.</p>
                    </div>
                </div>
            );
        }

        if (state === 'error' || !preview) {
            // useInvitePreview already retried a few times with backoff
            // before landing here — this is only reached after those are
            // exhausted, so a manual retry (rather than a dead end) is
            // worth offering: it's very likely still a transient blip
            // (throttle, a flaky connection), not a genuinely gone invite.
            return (
                <div className="cl-invite-card cl-invite-card--flat cl-invite-card--dead">
                    <span className="w-10 h-10 rounded-xl bg-white/[0.05] flex items-center justify-center shrink-0">
                        <ServerCrash size={18} className="text-cl-faint" />
                    </span>
                    <div className="flex-1 flex items-center justify-between gap-2 min-w-0">
                        <p className="text-[13px] font-semibold text-cl-faint leading-tight">Invite unavailable</p>
                        <button
                            type="button"
                            onClick={reload}
                            className="flex items-center gap-1 text-[11px] text-cl-faint hover:text-cl-text shrink-0"
                        >
                            <RotateCw size={11} /> Retry
                        </button>
                    </div>
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
            <div className="mt-1 select-none" onContextMenu={handleContextMenu}>
                {cardContent}
            </div>
            {ctx.menu}
        </>
    );
};
