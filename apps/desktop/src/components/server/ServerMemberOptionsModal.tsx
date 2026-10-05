/**
 * ServerMemberOptionsModal — per-member server preferences.
 *
 * Available to every member (no special permissions required):
 *   • Notifications  — All / Mentions Only / Off for this server
 *   • My Nickname    — set or clear a server-scoped display name
 *   • Retention      — how long channel messages / attachments stay on this device
 *   • Local Storage  — read-only view of how much local space this server uses
 *
 * Server managers see the same modal; a separate "Manage Server" button
 * (handled by the parent) opens the full admin settings.
 */

import secureLocalStore from '../../utils/secureLocalStore';
import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { X, Bell, BellOff, BellDot, HardDrive, Clock, Check, Database } from 'lucide-react';
import { formatBytes } from '@cipherline/shared';
import { API_BASE } from '../../constants';
import type { ServerInfo } from '../../hooks/useServers';
import type { AttachmentRetention, MessageRetention } from '../../hooks/useRetentionPolicy';
import { ATTACHMENT_RETENTION_LABELS, MESSAGE_RETENTION_LABELS } from '../../hooks/useRetentionPolicy';
import { ClModal, ClButton, ClInput, ClSelect, ClSegment } from '../cl';
import { ServerIcon } from './ServerIcon';
import { EncryptedAvatar } from '../EncryptedAvatar';
import { useAuth } from '../../contexts/AuthContext';
import { useModalExit } from '../../hooks/useModalExit';

// ── Types ─────────────────────────────────────────────────────────────────────

type NotifMode = 'all' | 'mentions' | 'none';

const MSG_ORDER: MessageRetention[]    = ['never', '1y', '6mo', '3mo', '1mo', '1wk'];
const ATT_ORDER: AttachmentRetention[] = ['never', '1y', '6mo', '3mo', '1mo', '1wk', '24h'];

export interface ServerLocalStats {
    totalBytes: number;
    messageCount: number;
    attachmentCount: number;
    attachmentBytes: number;
}

interface PerServerRetention {
    messageRetention: MessageRetention;
    attachmentRetention: AttachmentRetention;
}

function retentionStorageKey(userId: string, serverId: string) {
    return `cipherline_server_retention_${userId}_${serverId}`;
}

function loadRetention(userId: string, serverId: string, fallback: PerServerRetention): PerServerRetention {
    try {
        const raw = secureLocalStore.getItem(retentionStorageKey(userId, serverId));
        if (!raw) return fallback;
        return { ...fallback, ...JSON.parse(raw) };
    } catch {
        return fallback;
    }
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
    server: ServerInfo;
    userId: string;
    token: string | null;
    notifMode: NotifMode;
    onSetNotif: (mode: NotifMode) => void;
    localStats: ServerLocalStats;
    defaultMessageRetention: MessageRetention;
    defaultAttachmentRetention: AttachmentRetention;
    onNicknameSaved?: () => void;
    onRetentionChanged?: () => void;
    onPurgeRequest?: (
        serverId: string,
        newMessageRetention: MessageRetention,
        newAttachmentRetention: AttachmentRetention,
    ) => void;
    onClose: () => void;
}

const NOTIF_OPTIONS: { mode: NotifMode; icon: React.ReactNode; label: string; sub: string }[] = [
    {
        mode: 'all',
        icon: <Bell size={14} />,
        label: 'All Notifications',
        sub: 'Every message in this server pings you',
    },
    {
        mode: 'mentions',
        icon: <BellDot size={14} />,
        label: 'Mentions Only',
        sub: '@mentions and direct replies still come through',
    },
    {
        mode: 'none',
        icon: <BellOff size={14} />,
        label: 'Muted',
        sub: 'No pings — @mention badges still show',
    },
];

/**
 * NOTE: use <div>, never <p>, for text inside this modal. The kit styles
 * `.mcard p { font-size:14px; margin:0 0 22px }` at specificity (0,1,1), which
 * outranks every Tailwind utility (0,1,0) — so a <p> silently renders at 14px
 * with a 22px bottom margin no matter what classes it carries.
 */
const sectionLabel = 'text-[10px] font-mono font-semibold uppercase tracking-widest text-cl-faint mb-2';

type TabKey = 'notifications' | 'identity' | 'storage';

const TAB_OPTIONS: { value: TabKey; label: string }[] = [
    { value: 'notifications', label: 'Notifications' },
    { value: 'identity', label: 'Identity' },
    { value: 'storage', label: 'Storage' },
];

/** Shared card chrome for the retention / usage rows. */
const cardCls = 'rounded-xl bg-white/[0.03] border border-cl-border/30';

export const ServerMemberOptionsModal: React.FC<Props> = ({
    server,
    userId,
    token,
    notifMode,
    onSetNotif,
    localStats,
    defaultMessageRetention,
    defaultAttachmentRetention,
    onNicknameSaved,
    onRetentionChanged,
    onPurgeRequest,
    onClose,
}) => {
    const { closing, handleClose } = useModalExit(onClose, 260);
    const { user } = useAuth();

    // Notifications first — it's the reason people open this panel most often.
    const [tab, setTab] = useState<TabKey>('notifications');

    // ── Nickname ──────────────────────────────────────────────────────────────
    const [nickname, setNickname] = useState('');
    const [nicknameLoading, setNicknameLoading] = useState(true);
    const [nicknameSaving, setNicknameSaving] = useState(false);
    const [nicknameError, setNicknameError] = useState<string | null>(null);
    const [nicknameSaved, setNicknameSaved] = useState(false);
    const nickSavedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // ── Retention ─────────────────────────────────────────────────────────────
    const [retention, setRetention] = useState<PerServerRetention>(() =>
        loadRetention(userId, server.server_id, {
            messageRetention: defaultMessageRetention,
            attachmentRetention: defaultAttachmentRetention,
        }),
    );

    // A per-server override must exist only because THIS USER chose one. The
    // persist effect below used to write `retention` on mount - and `retention`
    // starts as the Server Channels type default - so merely opening this panel
    // (most people open it for notifications) froze the then-current default
    // into a per-server override, after which changing the default in Settings
    // -> Storage silently stopped applying to that server.
    const retentionDirtyRef = useRef(false);
    const commitRetention = (next: PerServerRetention) => {
        retentionDirtyRef.current = true;
        setRetention(next);
    };

    const [purgeConfirm, setPurgeConfirm] = useState<{
        proposed: PerServerRetention;
        label: string;
    } | null>(null);

    useEffect(() => {
        if (!token) { setNicknameLoading(false); return; }
        setNicknameLoading(true);
        axios.get(`${API_BASE}/servers/${server.server_id}/me`, {
            headers: { Authorization: `Bearer ${token}` },
        }).then(res => {
            setNickname(res.data?.nickname ?? '');
        }).catch(() => {
            // non-fatal
        }).finally(() => {
            setNicknameLoading(false);
        });
    }, [server.server_id, userId, token]);

    useEffect(() => {
        if (!retentionDirtyRef.current) return;   // only a user's choice becomes an override
        try {
            secureLocalStore.setItem(
                retentionStorageKey(userId, server.server_id),
                JSON.stringify(retention),
            );
            onRetentionChanged?.();
        } catch { /* non-fatal */ }
    }, [retention, userId, server.server_id]); // eslint-disable-line react-hooks/exhaustive-deps

    // ── Retention change handlers ─────────────────────────────────────────────

    const handleMsgRetentionChange = (newVal: MessageRetention) => {
        const oldIdx = MSG_ORDER.indexOf(retention.messageRetention);
        const newIdx = MSG_ORDER.indexOf(newVal);
        const proposed: PerServerRetention = { ...retention, messageRetention: newVal };
        if (newIdx > oldIdx) {
            setPurgeConfirm({ proposed, label: MESSAGE_RETENTION_LABELS[newVal] });
        } else {
            commitRetention(proposed);
        }
    };

    const handleAttRetentionChange = (newVal: AttachmentRetention) => {
        const oldIdx = ATT_ORDER.indexOf(retention.attachmentRetention);
        const newIdx = ATT_ORDER.indexOf(newVal);
        const proposed: PerServerRetention = { ...retention, attachmentRetention: newVal };
        if (newIdx > oldIdx) {
            setPurgeConfirm({ proposed, label: ATTACHMENT_RETENTION_LABELS[newVal] });
        } else {
            commitRetention(proposed);
        }
    };

    const applyPurge = () => {
        if (!purgeConfirm) return;
        commitRetention(purgeConfirm.proposed);
        onPurgeRequest?.(
            server.server_id,
            purgeConfirm.proposed.messageRetention,
            purgeConfirm.proposed.attachmentRetention,
        );
        setPurgeConfirm(null);
    };

    const saveNickname = async () => {
        if (!token) return;
        setNicknameSaving(true);
        setNicknameError(null);
        try {
            await axios.patch(
                `${API_BASE}/servers/${server.server_id}/members/${userId}/nickname`,
                { nickname: nickname.trim() || null },
                { headers: { Authorization: `Bearer ${token}` } },
            );
            setNicknameSaved(true);
            if (nickSavedTimer.current) clearTimeout(nickSavedTimer.current);
            nickSavedTimer.current = setTimeout(() => setNicknameSaved(false), 2000);
            onNicknameSaved?.();
        } catch (e: any) {
            setNicknameError(e?.response?.data?.message ?? 'Failed to save nickname');
        } finally {
            setNicknameSaving(false);
        }
    };

    // totalBytes is cached message JSON; attachmentBytes is the size of the
    // attachment files themselves. They're separate quantities — attachments
    // are NOT a subset of totalBytes — so the footprint is their sum, and the
    // bar shows how that sum splits rather than progress toward a cap (a cap
    // bar sat permanently empty, since message JSON is kilobytes).
    const combinedBytes = localStats.totalBytes + localStats.attachmentBytes;
    const msgSharePct = combinedBytes > 0 ? (localStats.totalBytes / combinedBytes) * 100 : 0;

    // Preview identity — mirrors ChatPane's own resolution order for your
    // messages: server nickname if set, else your account username.
    const previewName = nickname.trim() || user?.username || 'You';
    // ChatPane's smartTimestamp for a message sent just now.
    const previewTimestamp = `Today at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

    const msgRetentionOptions = (Object.entries(MESSAGE_RETENTION_LABELS) as [MessageRetention, string][]).map(
        ([val, label]) => ({ value: val, label }),
    );
    const attRetentionOptions = (Object.entries(ATTACHMENT_RETENTION_LABELS) as [AttachmentRetention, string][]).map(
        ([val, label]) => ({ value: val, label }),
    );

    return (
        <ClModal
            open={!closing}
            onClose={handleClose}
            width={448}
            cardStyle={{ padding: 0, maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        >
            {/* ── Header — the server's own identity, not a generic glyph ────── */}
            <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-4 shrink-0">
                <div className="flex items-center gap-3 min-w-0">
                    <ServerIcon
                        serverId={server.server_id}
                        name={server.name}
                        attachmentId={server.icon_attachment}
                        keyB64={server.icon_key_b64}
                        nonceB64={server.icon_nonce_b64}
                        token={token}
                        className="w-10 h-10 rounded-xl text-[14px] shrink-0"
                    />
                    <div className="min-w-0">
                        <h2 className="font-display font-semibold text-[16px] text-cl-text leading-tight mt-0 mb-0 truncate">
                            {server.name}
                        </h2>
                        <div className="text-[11px] text-cl-faint leading-tight mt-0.5">
                            Your settings — only you see these
                        </div>
                    </div>
                </div>
                <ClButton icon onClick={handleClose} variant="ghost" size="sm" tooltip="Close">
                    <X size={15} />
                </ClButton>
            </div>

            {/* Tabs — the old single-scroll stack made this panel taller than the
                viewport; splitting it means no section needs scrolling. */}
            <div className="px-5 shrink-0">
                <ClSegment options={TAB_OPTIONS} value={tab} onChange={setTab} className="seg--fill" />
            </div>

            {/* Body sizes to its tab — a shared minHeight left a block of dead
                space under the shortest tab, which is worse than the card
                resizing on a tab switch. */}
            <div className="px-5 pt-4 pb-5 overflow-y-auto custom-scrollbar min-h-0">

                {/* ── Notifications ──────────────────────────────────────────── */}
                {tab === 'notifications' && (
                    <div className="space-y-2 fade-enter">
                        {NOTIF_OPTIONS.map(opt => {
                            const active = notifMode === opt.mode;
                            return (
                                <button
                                    key={opt.mode}
                                    type="button"
                                    onClick={() => onSetNotif(opt.mode)}
                                    aria-pressed={active}
                                    className={`w-full text-left flex items-center gap-3 pl-3 pr-3 py-2.5 rounded-xl border transition-all duration-200 ${
                                        active
                                            ? 'bg-cl-lume/[0.09] border-cl-lume/35'
                                            : 'bg-white/[0.02] border-cl-border/30 hover:bg-white/[0.05] hover:border-cl-border/60'
                                    }`}
                                >
                                    <span
                                        className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors duration-200 ${
                                            active
                                                ? 'bg-cl-lume/20 text-cl-lume'
                                                : 'bg-white/[0.04] text-cl-faint'
                                        }`}
                                    >
                                        {opt.icon}
                                    </span>
                                    <span className="flex-1 min-w-0">
                                        <span className={`block text-[13px] font-semibold leading-tight ${active ? 'text-cl-text' : 'text-cl-muted'}`}>
                                            {opt.label}
                                        </span>
                                        <span className="block text-[11px] text-cl-faint leading-snug mt-0.5">
                                            {opt.sub}
                                        </span>
                                    </span>
                                    <span
                                        className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 transition-all duration-200 ${
                                            active
                                                ? 'bg-cl-lume text-cl-deep scale-100'
                                                : 'bg-transparent border border-cl-border/60 scale-90'
                                        }`}
                                    >
                                        {active && <Check size={12} strokeWidth={3} />}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}

                {/* ── Identity ───────────────────────────────────────────────── */}
                {tab === 'identity' && (
                    <div className="fade-enter">
                        {/* Live preview — a real message row, not an approximation of
                            one. Avatar / name / timestamp / body markup are copied
                            verbatim from ChatPane's renderer (same classes, same
                            15px body, same "Today at HH:MM" format) so what you see
                            here is what the channel actually renders. */}
                        <div className={`${cardCls} py-2.5 mb-3 overflow-hidden`}>
                            {/* Row keeps ChatPane's own pl-3/pr-2 insets so the
                                avatar-to-text rhythm matches the channel exactly. */}
                            <div className="flex gap-3 py-0.5 pr-2 pl-3">
                                <EncryptedAvatar
                                    attachmentId={user?.avatar_url || undefined}
                                    userId={userId}
                                    token={token}
                                    className="w-10 h-10 shrink-0 mt-0.5 ring-1 ring-white/5 shadow-sm"
                                    fallbackSize={24}
                                    disableClickProfile
                                />
                                <div className="relative flex flex-col min-w-0 flex-1">
                                    <div className="flex items-baseline gap-2 mb-0.5">
                                        <span
                                            className="text-[14px] font-semibold leading-tight truncate"
                                            style={{ color: 'white' }}
                                        >
                                            {previewName}
                                        </span>
                                        <span className="text-[11px] text-cl-faint leading-tight shrink-0">
                                            {previewTimestamp}
                                        </span>
                                    </div>
                                    <div
                                        className="text-white/90 break-words whitespace-pre-wrap overflow-hidden"
                                        style={{ fontSize: '15px', lineHeight: 'normal', wordBreak: 'break-word' }}
                                    >
                                        Hey everyone 👋
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="flex items-center justify-between mb-1.5">
                            <div className={`${sectionLabel} mb-0`}>Nickname</div>
                            <span className="text-[10px] font-mono text-cl-faint tabular-nums">
                                {nickname.length}/32
                            </span>
                        </div>
                        <ClInput
                            value={nickname}
                            onChange={e => {
                                setNickname(e.target.value.slice(0, 32));
                                setNicknameError(null);
                                setNicknameSaved(false);
                            }}
                            placeholder={nicknameLoading ? 'Loading…' : (user?.username || 'Your username')}
                            disabled={nicknameLoading}
                            maxLength={32}
                            onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter') saveNickname(); }}
                        />
                        <div className="text-[11px] text-cl-faint mt-1.5 leading-snug">
                            Leave empty to go back to your username. Only applies to this server.
                        </div>

                        <div className="flex items-center gap-2 mt-3">
                            <ClButton
                                variant={nicknameSaved ? 'ok' : 'primary'}
                                size="sm"
                                onClick={saveNickname}
                                disabled={nicknameSaving || nicknameLoading}
                                loading={nicknameSaving}
                            >
                                {nicknameSaved ? <><Check size={12} /> Saved</> : 'Save'}
                            </ClButton>
                            {nickname.length > 0 && (
                                <ClButton
                                    variant="ghost"
                                    size="sm"
                                    disabled={nicknameSaving || nicknameLoading}
                                    onClick={() => { setNickname(''); saveNickname(); }}
                                >
                                    Reset
                                </ClButton>
                            )}
                        </div>

                        {nicknameError && (
                            <div className="text-[11px] text-cl-flash mt-2">{nicknameError}</div>
                        )}
                    </div>
                )}

                {/* ── Storage — retention and usage are one concern, not two ──── */}
                {tab === 'storage' && (
                    <div className="fade-enter">
                        <div className={sectionLabel}>Retention</div>
                        <div className="text-[11px] text-cl-faint mb-2.5 leading-relaxed">
                            How long this server's messages and attachments stay cached on
                            this device. Server-saved messages are unaffected. This setting
                            applies to this device only and doesn’t sync.
                        </div>

                        {/* Same card shape as the Notifications options — icon
                            chip, label, trailing control — so the tabs read as
                            one panel rather than three unrelated screens. */}
                        <div className="space-y-2">
                            <div className={`flex items-center gap-3 pl-3 pr-2.5 py-2.5 ${cardCls}`}>
                                <span className="w-8 h-8 rounded-lg bg-white/[0.04] text-cl-faint flex items-center justify-center shrink-0">
                                    <Clock size={15} />
                                </span>
                                <div className="text-[13px] font-semibold text-cl-muted flex-1 min-w-0">Messages</div>
                                <ClSelect
                                    options={msgRetentionOptions}
                                    value={retention.messageRetention}
                                    onChange={(v) => handleMsgRetentionChange(v as MessageRetention)}
                                    style={{ width: 132 }}
                                />
                            </div>

                            <div className={`flex items-center gap-3 pl-3 pr-2.5 py-2.5 ${cardCls}`}>
                                <span className="w-8 h-8 rounded-lg bg-white/[0.04] text-cl-faint flex items-center justify-center shrink-0">
                                    <HardDrive size={15} />
                                </span>
                                <div className="text-[13px] font-semibold text-cl-muted flex-1 min-w-0">Attachments</div>
                                <ClSelect
                                    options={attRetentionOptions}
                                    value={retention.attachmentRetention}
                                    onChange={(v) => handleAttRetentionChange(v as AttachmentRetention)}
                                    style={{ width: 132 }}
                                />
                            </div>
                        </div>

                        {/* ── Retention change confirmation ─────────────────── */}
                        {purgeConfirm && (
                            <div className="mt-3 rounded-xl border border-cl-lume/25 bg-cl-lume/[0.05] p-3 fade-drop-enter">
                                <div className="flex items-start gap-2.5 mb-3">
                                    <div className="w-6 h-6 rounded-md bg-cl-lume/15 border border-cl-lume/25 flex items-center justify-center shrink-0 mt-0.5">
                                        <Clock size={11} className="text-cl-lume" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[12px] text-cl-text font-semibold leading-snug">
                                            Shortening to {purgeConfirm.label}
                                        </div>
                                        <div className="text-[11px] text-cl-faint mt-0.5">
                                            Older messages will be removed from this server's local cache.
                                        </div>
                                    </div>
                                    <ClButton icon onClick={() => setPurgeConfirm(null)} variant="ghost" size="sm" tooltip="Dismiss">
                                        <X size={11} />
                                    </ClButton>
                                </div>
                                <div className="flex gap-1.5">
                                    <ClButton
                                        variant="ghost"
                                        size="sm"
                                        fullWidth
                                        onClick={() => { commitRetention(purgeConfirm.proposed); setPurgeConfirm(null); }}
                                    >
                                        Going Forward
                                    </ClButton>
                                    <ClButton
                                        variant="danger"
                                        size="sm"
                                        fullWidth
                                        onClick={applyPurge}
                                    >
                                        Purge Now
                                    </ClButton>
                                </div>
                            </div>
                        )}

                        {/* ── Usage ─────────────────────────────────────────── */}
                        <div className={`${sectionLabel} mt-5`}>Usage</div>

                        {combinedBytes === 0 ? (
                            <div className={`${cardCls} px-3 py-4 flex items-center gap-2.5`}>
                                <Database size={14} className="text-cl-faint shrink-0" />
                                <div className="text-[13px] text-cl-faint">Nothing cached from this server yet.</div>
                            </div>
                        ) : (
                            <div className={`${cardCls} px-3 py-3`}>
                                <div className="flex items-baseline justify-between mb-2.5">
                                    <span className="font-mono tabular-nums text-[18px] text-cl-text font-semibold leading-none">
                                        {formatBytes(combinedBytes)}
                                    </span>
                                    <span className="text-[11px] text-cl-faint">on this device</span>
                                </div>

                                {/* Split bar — the two segments are the two rows below. */}
                                <div className="h-1.5 w-full bg-white/[0.06] rounded-full overflow-hidden flex">
                                    <div
                                        className="h-full bg-cl-lume/70 transition-all duration-300"
                                        style={{ width: `${msgSharePct}%` }}
                                    />
                                    <div
                                        className="h-full bg-white/25 transition-all duration-300"
                                        style={{ width: `${100 - msgSharePct}%` }}
                                    />
                                </div>

                                <div className="mt-3 space-y-2">
                                    <div className="flex items-center gap-2 text-[13px]">
                                        <i className="w-2 h-2 rounded-sm bg-cl-lume/70 shrink-0" />
                                        <span className="text-cl-muted flex-1 min-w-0">Messages</span>
                                        <span className="text-[11px] text-cl-faint tabular-nums">
                                            {localStats.messageCount} cached
                                        </span>
                                        <span className="font-mono tabular-nums text-cl-muted w-16 text-right">
                                            {formatBytes(localStats.totalBytes)}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2 text-[13px]">
                                        <i className="w-2 h-2 rounded-sm bg-white/25 shrink-0" />
                                        <span className="text-cl-muted flex-1 min-w-0">Attachments</span>
                                        <span className="text-[11px] text-cl-faint tabular-nums">
                                            {localStats.attachmentCount} file{localStats.attachmentCount !== 1 ? 's' : ''}
                                        </span>
                                        <span className="font-mono tabular-nums text-cl-muted w-16 text-right">
                                            {formatBytes(localStats.attachmentBytes)}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </ClModal>
    );
};

// ── Utility: compute per-server local stats ────────────────────────────────────

/**
 * Aggregate local cache stats across all channels of a server.
 * Pass `channelMessages` from Dashboard and the list of channel IDs for the server.
 */
export function computeServerLocalStats(
    channelMessages: Record<string, any[]>,
    channelIds: string[],
): ServerLocalStats {
    let totalBytes = 0;
    let messageCount = 0;
    let attachmentCount = 0;
    let attachmentBytes = 0;

    for (const cid of channelIds) {
        const msgs = channelMessages[cid];
        if (!Array.isArray(msgs)) continue;
        for (const m of msgs) {
            messageCount++;
            try {
                const sz = JSON.stringify(m).length;
                totalBytes += sz;
                if (m?.content?.type === 'attachment') {
                    attachmentCount++;
                    attachmentBytes += (m.content.byte_size as number) || 0;
                }
            } catch { /* ignore */ }
        }
    }

    return { totalBytes, messageCount, attachmentCount, attachmentBytes };
}
