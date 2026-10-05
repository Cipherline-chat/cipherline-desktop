import React, { useMemo, useState } from 'react';
import {
    Clock,
    Trash2, ChevronDown, ChevronRight,
    BarChart2, Archive, X,
} from 'lucide-react';
import {
    type AttachmentRetention,
    type MessageRetention,
    type RetentionHook,
    type ConvType,
    ATTACHMENT_RETENTION_LABELS,
    MESSAGE_RETENTION_LABELS,
    attachmentRetentionMs,
    messageRetentionMs,
    getEffectiveMessageRetention,
    getEffectiveAttachmentRetention,
} from '../hooks/useRetentionPolicy';
import { rankByStorage, findOrphanedConversations } from '../utils/storageCalc';
import { PurgeDropdown, PurgeConfirmModal, countMessagesToPurge } from './PurgeControls';
import { ClButton, ClSelect } from './cl';
import type { ClSelectOption } from './cl';

const ATTACHMENT_OPTIONS: AttachmentRetention[] = ['never', '1y', '6mo', '3mo', '1mo', '1wk', '24h'];
const MESSAGE_OPTIONS: MessageRetention[]       = ['never', '1y', '6mo', '3mo', '1mo', '1wk'];

const MSG_SELECT_OPTIONS: ClSelectOption<MessageRetention>[] = MESSAGE_OPTIONS.map(v => ({
    value: v, label: MESSAGE_RETENTION_LABELS[v],
}));
const ATT_SELECT_OPTIONS: ClSelectOption<AttachmentRetention>[] = ATTACHMENT_OPTIONS.map(v => ({
    value: v, label: ATTACHMENT_RETENTION_LABELS[v],
}));

interface StorageSettingsProps {
    retention: RetentionHook;
    messagesState: Record<string, any[]>;
    conversations: any[];
    onClearAllMessages: () => void;
    onPurgeConversation: (convId: string, olderThanMs: number) => void;
    onPurgeTypeNow: (type: ConvType) => void;
    /**
     * Dry-run: how many messages / files the cleanup would remove if `type`'s
     * default became `newVal`. Supplied by Dashboard, which owns BOTH message
     * stores and the pin / server-save sets; without it the (DM-store-only)
     * local estimate below is used, which cannot see server channels.
     */
    countExpiringForType?: (type: ConvType, kind: 'msg' | 'att', newVal: MessageRetention | AttachmentRetention) => number;
}

export function formatBytes(n: number): string {
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const StorageSettings: React.FC<StorageSettingsProps> = ({
    retention,
    messagesState,
    conversations,
    onClearAllMessages,
    onPurgeConversation,
    onPurgeTypeNow,
    countExpiringForType,
}) => {
    const [orphanOpen, setOrphanOpen] = useState(false);

    const countMsgsForType = (type: ConvType, windowMs: number): number => {
        if (type === 'server') {
            const convIdSet = new Set(conversations.map((c: any) => c.conversation_id as string));
            return Object.entries(messagesState).reduce((acc, [id, msgs]) => {
                if (convIdSet.has(id) || !Array.isArray(msgs)) return acc;
                return acc + countMessagesToPurge(msgs, windowMs);
            }, 0);
        }
        return conversations
            .filter((c: any) => c.type === type)
            .reduce((acc: number, c: any) => {
                return acc + countMessagesToPurge(messagesState[c.conversation_id], windowMs);
            }, 0);
    };

    const countAttsForType = (type: ConvType, windowMs: number): number => {
        const now = Date.now();
        const matchKeys = (id: string): boolean => {
            if (type === 'server') {
                const convIdSet = new Set(conversations.map((c: any) => c.conversation_id as string));
                return !convIdSet.has(id);
            }
            return conversations.some((c: any) => c.type === type && c.conversation_id === id);
        };
        return Object.entries(messagesState).reduce((acc, [id, msgs]) => {
            if (!matchKeys(id) || !Array.isArray(msgs)) return acc;
            return acc + msgs.filter((m: any) => {
                if (m?._pending || m?.content?.type !== 'attachment') return false;
                const t = m?.timestamp ?? m?.sent_at ?? m?.created_at ?? m?.received_at ?? null;
                let ts = typeof t === 'number' ? t : (t ? Date.parse(t) : now);
                if (!Number.isFinite(ts)) ts = now;
                return (now - ts) >= windowMs;
            }).length;
        }, 0);
    };

    const TYPE_LABELS: Record<ConvType, string> = {
        dm:     'Direct Messages',
        group:  'Group Chats',
        server: 'Server Channels',
    };

    const [pendingChange, setPendingChange] = useState<{
        type: ConvType;
        kind: 'msg' | 'att';
        label: string;
        count: number;
        noun: string;
        apply: () => void;
    } | null>(null);

    const handleTypeMsgChange = (type: ConvType, newVal: MessageRetention) => {
        const oldVal = getEffectiveMessageRetention(retention.policy, type);
        const oldIdx = MESSAGE_OPTIONS.indexOf(oldVal);
        const newIdx = MESSAGE_OPTIONS.indexOf(newVal);
        const setter =
            type === 'dm'     ? retention.setDmMessageRetention :
            type === 'group'  ? retention.setGroupMessageRetention :
                                retention.setServerMessageRetention;
        if (newIdx > oldIdx) {
            const windowMs = messageRetentionMs(newVal);
            setPendingChange({
                type, kind: 'msg',
                label: MESSAGE_RETENTION_LABELS[newVal],
                count: countExpiringForType ? countExpiringForType(type, 'msg', newVal) : countMsgsForType(type, windowMs),
                noun: 'messages',
                apply: () => setter(newVal),
            });
        } else {
            setter(newVal);
        }
    };

    const handleTypeAttChange = (type: ConvType, newVal: AttachmentRetention) => {
        const oldVal = getEffectiveAttachmentRetention(retention.policy, type);
        const oldIdx = ATTACHMENT_OPTIONS.indexOf(oldVal);
        const newIdx = ATTACHMENT_OPTIONS.indexOf(newVal);
        const setter =
            type === 'dm'     ? retention.setDmAttachmentRetention :
            type === 'group'  ? retention.setGroupAttachmentRetention :
                                retention.setServerAttachmentRetention;
        if (newIdx > oldIdx) {
            const windowMs = attachmentRetentionMs(newVal);
            setPendingChange({
                type, kind: 'att',
                label: ATTACHMENT_RETENTION_LABELS[newVal],
                count: countExpiringForType ? countExpiringForType(type, 'att', newVal) : countAttsForType(type, windowMs),
                noun: 'files',
                apply: () => setter(newVal),
            });
        } else {
            setter(newVal);
        }
    };

    const [pendingPurge, setPendingPurge] = useState<{
        count: number;
        label: string;
        convTitle?: string;
        commit: () => void;
    } | null>(null);

    const convTitleMap = useMemo(() => {
        const m: Record<string, string> = {};
        for (const c of conversations) {
            m[c.conversation_id] = c.title || c.other_user_id || 'Unknown Chat';
        }
        return m;
    }, [conversations]);

    const knownIds = useMemo(() => new Set(conversations.map((c: any) => c.conversation_id as string)), [conversations]);

    const top10 = useMemo(() => rankByStorage(messagesState, 10), [messagesState]);
    const maxBytes = top10[0]?.totalBytes || 1;

    const totalStats = useMemo(() => {
        let totalBytes = 0;
        let messageCount = 0;
        for (const msgs of Object.values(messagesState)) {
            if (!Array.isArray(msgs)) continue;
            messageCount += msgs.length;
            for (const m of msgs) {
                if (m?.content?.type === 'attachment') totalBytes += m.content.byte_size || 0;
            }
        }
        try { totalBytes = Math.max(totalBytes, JSON.stringify(messagesState).length); } catch {}
        return { totalBytes, messageCount };
    }, [messagesState]);

    const orphaned = useMemo(() => findOrphanedConversations(messagesState, knownIds), [messagesState, knownIds]);

    // Descent sd-card shell (settings-descent.css) — matches every other pane.
    const sectionStyle = {};
    const sectionCls = 'sd-card';

    return (
        <div className="flex flex-col gap-5">
            {/* Section A — Default Retention */}
            <div className={sectionCls} style={sectionStyle}>
                <div className="flex items-center gap-3 mb-2">
                    <Clock className="w-5 h-5" style={{ color: 'var(--cl-lume)' }} />
                    <h3 className="text-base" style={{ color: 'var(--cl-text)', fontFamily: 'var(--cl-font-display)', fontWeight: 500, margin: 0 }}>Default retention</h3>
                </div>
                <p className="text-xs mb-5" style={{ color: 'var(--cl-faint)' }}>
                    How long messages and attachments are kept on this device, by chat type.
                    Individual conversations can override these from their info panel.
                    These settings apply to this device only — they don’t sync to your other
                    devices and aren’t included in backups.
                </p>

                {(() => {
                    const rows: { type: ConvType; label: string }[] = [
                        { type: 'dm',     label: 'Direct Messages' },
                        { type: 'group',  label: 'Group Chats'     },
                        { type: 'server', label: 'Server Channels' },
                    ];

                    return (
                        <div className="flex flex-col gap-2">
                            <div className="grid grid-cols-[1fr_140px_140px] gap-3 items-center px-1 mb-0.5">
                                <span />
                                <span className="text-[10px] font-bold uppercase tracking-widest text-center" style={{ color: 'var(--cl-faint)' }}>Messages</span>
                                <span className="text-[10px] font-bold uppercase tracking-widest text-center" style={{ color: 'var(--cl-faint)' }}>Attachments</span>
                            </div>

                            {rows.map(({ type, label }) => {
                                const effMsg = getEffectiveMessageRetention(retention.policy, type);
                                const effAtt = getEffectiveAttachmentRetention(retention.policy, type);
                                const isPending = pendingChange?.type === type;
                                return (
                                    <div key={type} className={`grid grid-cols-[1fr_140px_140px] gap-3 items-center px-1 py-2 rounded-xl transition-colors ${isPending ? 'bg-[rgba(37,224,200,0.04)]' : 'hover:bg-white/[0.02]'}`}>
                                        <span className="text-sm font-medium" style={{ color: 'var(--cl-muted)' }}>{label}</span>
                                        <ClSelect<MessageRetention>
                                            value={effMsg}
                                            onChange={v => handleTypeMsgChange(type, v)}
                                            options={MSG_SELECT_OPTIONS}
                                            style={{ width: 140 }}
                                        />
                                        <ClSelect<AttachmentRetention>
                                            value={effAtt}
                                            onChange={v => handleTypeAttChange(type, v)}
                                            options={ATT_SELECT_OPTIONS}
                                            style={{ width: 140 }}
                                        />
                                    </div>
                                );
                            })}

                            {pendingChange && (
                                <div className="mt-1 rounded-xl p-4" style={{ border: '1px solid var(--cl-border)', background: 'var(--cl-surface)' }}>
                                    <div className="flex items-start gap-3 mb-3.5">
                                        <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5" style={{ background: 'rgba(37,224,200,.1)', border: '1px solid rgba(37,224,200,.2)' }}>
                                            <Clock className="w-3.5 h-3.5" style={{ color: 'var(--cl-lume)' }} />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-[13px] font-semibold leading-snug" style={{ color: 'var(--cl-text)' }}>
                                                Shortening {TYPE_LABELS[pendingChange.type]} to {pendingChange.label}
                                            </p>
                                            <p className="text-[12px] mt-0.5 leading-snug" style={{ color: 'var(--cl-muted)' }}>
                                                {pendingChange.count > 0
                                                    ? `${pendingChange.count.toLocaleString()} ${pendingChange.noun} are outside this window right now. The automatic cleanup will remove them within a few minutes; or remove them immediately.`
                                                    : `No existing ${pendingChange.noun} fall outside this window yet.`
                                                }
                                            </p>
                                        </div>
                                        <ClButton
                                            icon
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => setPendingChange(null)}
                                            tooltip="Dismiss"
                                        >
                                            <X size={13} />
                                        </ClButton>
                                    </div>
                                    <div className="flex gap-2">
                                        <ClButton
                                            size="sm"
                                            variant="ghost"
                                            fullWidth
                                            onClick={() => { pendingChange.apply(); setPendingChange(null); }}
                                        >
                                            {pendingChange.count > 0 ? 'Let Cleanup Handle It' : 'Apply'}
                                        </ClButton>
                                        {pendingChange.count > 0 && (
                                            <ClButton
                                                size="sm"
                                                variant="danger"
                                                fullWidth
                                                onClick={() => { pendingChange.apply(); onPurgeTypeNow(pendingChange.type); setPendingChange(null); }}
                                            >
                                                Remove {pendingChange.count.toLocaleString()} Now
                                            </ClButton>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })()}
            </div>

            {/* Section D — Conversation Storage Breakdown */}
            <div className={sectionCls} style={sectionStyle}>
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <BarChart2 className="w-5 h-5" style={{ color: 'var(--cl-lume)' }} />
                        <h3 className="text-base" style={{ color: 'var(--cl-text)', fontFamily: 'var(--cl-font-display)', fontWeight: 500, margin: 0 }}>Conversation storage</h3>
                    </div>
                    <span className="text-[11px]" style={{ color: 'var(--cl-faint)' }}>
                        {formatBytes(totalStats.totalBytes)} · {totalStats.messageCount.toLocaleString()} msgs
                    </span>
                </div>

                {top10.length === 0 ? (
                    <div className="text-xs italic py-4 text-center rounded-lg" style={{ color: 'var(--cl-faint)', background: 'rgba(0,0,0,.2)', border: '1px solid var(--cl-border)' }}>
                        No messages stored locally yet.
                    </div>
                ) : (
                    <div className="flex flex-col gap-3">
                        {top10.map(stats => {
                            const title = convTitleMap[stats.conversationId] || 'Unknown Chat';
                            const isOrphaned = !knownIds.has(stats.conversationId);
                            const barPct = maxBytes > 0 ? Math.round((stats.totalBytes / maxBytes) * 100) : 0;
                            return (
                                <div key={stats.conversationId} className="p-3 rounded-xl space-y-2" style={{ background: 'rgba(0,0,0,.2)', border: '1px solid var(--cl-border)' }}>
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <span className="text-sm font-medium truncate" style={{ color: 'var(--cl-text)' }}>{title}</span>
                                            {isOrphaned && (
                                                <span className="text-[10px] font-bold rounded-full px-1.5 py-0.5 shrink-0" style={{ color: 'var(--cl-glow)', background: 'rgba(245,158,11,.1)', border: '1px solid rgba(245,158,11,.3)' }}>deleted</span>
                                            )}
                                        </div>
                                        <span className="text-xs shrink-0" style={{ color: 'var(--cl-muted)' }}>{formatBytes(stats.totalBytes)}</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,.06)' }}>
                                            <div className="h-full rounded-full" style={{ width: `${barPct}%`, background: 'rgba(37,224,200,.6)' }} />
                                        </div>
                                        <span className="text-[11px] shrink-0" style={{ color: 'var(--cl-faint)' }}>{stats.messageCount.toLocaleString()} msgs</span>
                                    </div>
                                    <div className="flex items-center gap-2 pt-0.5">
                                        <PurgeDropdown
                                            onSelect={(ms, label) => {
                                                const count = countMessagesToPurge(messagesState[stats.conversationId], ms);
                                                setPendingPurge({
                                                    count, label,
                                                    convTitle: title,
                                                    commit: () => onPurgeConversation(stats.conversationId, ms),
                                                });
                                            }}
                                        />
                                        {stats.attachmentCount > 0 && (
                                            <span className="text-[11px] shrink-0" style={{ color: 'var(--cl-faint)' }}>{stats.attachmentCount} attachments</span>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                <div className="mt-4">
                    <ClButton
                        variant="danger"
                        fullWidth
                        onClick={() => {
                            setPendingPurge({
                                count: totalStats.messageCount,
                                label: 'Everything',
                                commit: onClearAllMessages,
                            });
                        }}
                    >
                        <Trash2 className="w-4 h-4" />
                        Clear All Local Messages
                    </ClButton>
                </div>
            </div>

            {/* Section E — Orphaned Chats */}
            {orphaned.length > 0 && (
                <div className={sectionCls} style={sectionStyle}>
                    <ClButton
                        variant="ghost"
                        fullWidth
                        onClick={() => setOrphanOpen(v => !v)}
                    >
                        <div className="flex items-center gap-3">
                            <Archive className="w-5 h-5" style={{ color: 'var(--cl-glow)' }} />
                            <h3 className="text-base" style={{ color: 'var(--cl-text)', fontFamily: 'var(--cl-font-display)', fontWeight: 500, margin: 0 }}>Orphaned chats</h3>
                            <span className="text-[11px] font-bold rounded-full px-2 py-0.5" style={{ color: 'var(--cl-glow)', background: 'rgba(245,158,11,.1)', border: '1px solid rgba(245,158,11,.3)' }}>{orphaned.length}</span>
                        </div>
                        {orphanOpen
                            ? <ChevronDown className="w-4 h-4" style={{ color: 'var(--cl-faint)' }} />
                            : <ChevronRight className="w-4 h-4" style={{ color: 'var(--cl-faint)' }} />
                        }
                    </ClButton>

                    {orphanOpen && (
                        <div className="mt-4">
                            <p className="text-xs mb-3" style={{ color: 'var(--cl-faint)' }}>
                                These are conversations from unfriended contacts or deleted DMs
                                that still have local message history stored on your device.
                            </p>
                            <div className="flex flex-col gap-2">
                                {orphaned.map(stats => (
                                    <div key={stats.conversationId} className="flex items-center gap-3 px-3 py-2.5 rounded-xl" style={{ background: 'rgba(0,0,0,.2)', border: '1px solid var(--cl-border)' }}>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-medium truncate" style={{ color: 'var(--cl-muted)' }}>Unknown Chat</div>
                                            <div className="text-[11px]" style={{ color: 'var(--cl-faint)' }}>{formatBytes(stats.totalBytes)} · {stats.messageCount} messages</div>
                                        </div>
                                        <ClButton
                                            size="sm"
                                            variant="danger"
                                            onClick={() => {
                                                setPendingPurge({
                                                    count: stats.messageCount,
                                                    label: 'Everything',
                                                    convTitle: 'this orphaned chat',
                                                    commit: () => onPurgeConversation(stats.conversationId, 0),
                                                });
                                            }}
                                        >
                                            Delete History
                                        </ClButton>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {pendingPurge && (
                <PurgeConfirmModal
                    count={pendingPurge.count}
                    label={pendingPurge.label}
                    convTitle={pendingPurge.convTitle}
                    onCancel={() => setPendingPurge(null)}
                    onConfirm={() => {
                        pendingPurge.commit();
                        setPendingPurge(null);
                    }}
                />
            )}
        </div>
    );
};
