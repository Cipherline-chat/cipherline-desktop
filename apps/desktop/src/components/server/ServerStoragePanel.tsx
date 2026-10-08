/**
 * ServerStoragePanel — replaces the old `StorageMeter`.
 *
 * Shows:
 *  1. Overall quota bar (used / limit, tier label, warning at ≥90 %).
 *  2. Per-channel breakdown of server saves: channel name, save count,
 *     total bytes, message vs. attachment split.
 *     Each channel row is expandable (future: list individual saves and
 *     allow bulk-unsave directly from settings).
 *
 * Refreshes whenever `refreshKey` is bumped from the parent (happens
 * after every server-save / unsave).
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import axios from 'axios';
import { Archive, Hash, ChevronDown, ChevronRight, AlertTriangle, Check, Info } from 'lucide-react';
import { formatBytes, STORAGE_TIERS } from '@cipherline/shared';
import { API_BASE } from '../../constants';
import { ClButton } from '../cl';
import { isFlatStoragePlan, nearLimitMessage } from '../../utils/serverStorageCopy';

interface Props {
    serverId: string;
    token: string | null;
    /** Refresh trigger — bump when a server-save / unsave lands. */
    refreshKey?: number;
    /** Whether the current user can manage messages (unsave from settings). */
    canManage?: boolean;
}

interface QuotaInfo {
    used_bytes: number;
    limit_bytes: number;
    member_count: number;
    tier_label: string;
    /** 'flat25' = the server owner is on the Free plan (flat 25 MB);
     *  'ladder' = owner has Pro/trial (grows with members). Absent on an older
     *  API, which reads as the ladder. */
    storage_plan?: 'flat25' | 'ladder';
    /** The split of used_bytes (absent on an API older than 2026-10-05):
     *  server saves vs custom emojis, which share the one quota. */
    saves_bytes?: number;
    emoji_bytes?: number;
    emoji_count?: number;
}

interface ChannelStorageRow {
    channel_id: string;
    channel_name: string;
    kind: string;
    save_count: number;
    total_bytes: number;
    attachment_bytes: number;
    attachment_count: number;
}

export const ServerStoragePanel: React.FC<Props> = ({
    serverId,
    token,
    refreshKey = 0,
    canManage = false,
}) => {
    const [quota, setQuota] = useState<QuotaInfo | null>(null);
    const [channels, setChannels] = useState<ChannelStorageRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expandedChannels, setExpandedChannels] = useState<Set<string>>(new Set());
    const [showTierPopover, setShowTierPopover] = useState(false);
    const tierBtnRef = useRef<HTMLSpanElement>(null);
    const tierPopoverRef = useRef<HTMLDivElement>(null);

    // Dismiss tier popover on outside click
    useEffect(() => {
        if (!showTierPopover) return;
        const handler = (e: MouseEvent) => {
            if (
                tierBtnRef.current && !tierBtnRef.current.contains(e.target as Node) &&
                tierPopoverRef.current && !tierPopoverRef.current.contains(e.target as Node)
            ) {
                setShowTierPopover(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [showTierPopover]);

    const load = useCallback(async () => {
        if (!token || !serverId) return;
        setLoading(true);
        setError(null);
        try {
            const [quotaRes, channelsRes] = await Promise.all([
                axios.get(`${API_BASE}/servers/${serverId}/storage`, {
                    headers: { Authorization: `Bearer ${token}` },
                }),
                axios.get(`${API_BASE}/servers/${serverId}/storage/channels`, {
                    headers: { Authorization: `Bearer ${token}` },
                }),
            ]);
            setQuota(quotaRes.data);
            setChannels(channelsRes.data?.channels ?? []);
        } catch (e: any) {
            setError(e?.response?.data?.message ?? 'Failed to load storage');
        } finally {
            setLoading(false);
        }
    }, [serverId, token]);

    useEffect(() => { load(); }, [load, refreshKey]);

    const toggleChannel = (id: string) => {
        setExpandedChannels(prev => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    };

    if (loading && !quota) {
        return (
            <div className="space-y-3">
                <div className="h-3 w-40 bg-white/[0.06] rounded-full animate-pulse" />
                <div className="h-1.5 w-full bg-white/[0.06] rounded-full animate-pulse" />
            </div>
        );
    }

    if (error || !quota) {
        return <div className="text-[11px] text-red-400/70">{error ?? 'Storage unavailable'}</div>;
    }

    const pct = quota.limit_bytes > 0
        ? Math.min(100, (quota.used_bytes / quota.limit_bytes) * 100)
        : 0;
    const isFlat = isFlatStoragePlan(quota.storage_plan);
    const isNearLimit = pct >= 90;
    const isOverHalf  = pct >= 50;

    const fillColor = isNearLimit
        ? 'bg-red-500'
        : isOverHalf
            ? 'bg-amber-400'
            : 'bg-cl-lume';

    return (
        <div className="space-y-4">
            {/* ── Overall quota bar ────────────────────────────────────────── */}
            <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                        <Archive size={11} className="text-amber-400/70" />
                        <span className="text-[10px] font-mono font-semibold uppercase tracking-widest text-cl-faint">
                            Server Storage
                        </span>
                    </div>
                    <span className="text-[11px] text-cl-muted font-mono tabular-nums">
                        {formatBytes(quota.used_bytes)} / {formatBytes(quota.limit_bytes)}
                    </span>
                </div>

                {/* Bar */}
                <div className="h-1.5 w-full bg-white/[0.06] rounded-full overflow-hidden">
                    <div
                        className={`h-full ${fillColor} transition-all duration-500`}
                        style={{ width: `${pct}%` }}
                    />
                </div>

                <div className="flex items-center justify-between text-[10px] text-cl-faint">
                    {/* Tier label — click to see the full tier ladder */}
                    <span className="relative">
                        <span ref={tierBtnRef}>
                        <ClButton
                            variant="ghost"
                            size="sm"
                            onClick={() => setShowTierPopover(p => !p)}
                            tooltip="Click to view all tiers"
                        >
                            Tier:{' '}
                            <span className={`${showTierPopover ? 'text-cl-lume' : 'text-cl-muted'} transition-colors`}>
                                {quota.tier_label}
                            </span>
                            <Info size={10} className={`${showTierPopover ? 'text-cl-lume' : 'text-cl-faint'} transition-colors`} />
                        </ClButton>
                        </span>

                        {/* Tier ladder popover */}
                        {showTierPopover && (
                            <div
                                ref={tierPopoverRef}
                                className="absolute bottom-full left-0 mb-2 z-50 w-72 rounded-xl bg-cl-deep border border-cl-border/50 shadow-2xl overflow-hidden"
                            >
                                {/* Header */}
                                <div className="px-4 pt-3 pb-2 border-b border-cl-border/30">
                                    <p className="text-[11px] font-semibold text-cl-muted">Storage Tiers</p>
                                    <p className="text-[10px] text-cl-faint mt-0.5">
                                        {isFlat
                                            ? "The server owner is on the Free plan, so this server has a flat 25 MB of saved storage. With Cipherline Pro the owner's limit grows as the server gains members:"
                                            : 'Quota grows automatically as your server gains members.'}
                                    </p>
                                </div>

                                {/* Tier rows */}
                                <div className="py-1">
                                    {STORAGE_TIERS.map((tier, i) => {
                                        // On the flat free quota no ladder tier applies.
                                        const isCurrent = !isFlat &&
                                            quota.member_count >= tier.minMembers &&
                                            quota.member_count <= tier.maxMembers;
                                        const isUnlocked = !isFlat && quota.member_count >= tier.minMembers;

                                        return (
                                            <div
                                                key={i}
                                                className={`flex items-center gap-3 px-4 py-2 ${
                                                    isCurrent
                                                        ? 'bg-cl-lume/10'
                                                        : ''
                                                }`}
                                            >
                                                {/* Check / dot */}
                                                <div className="w-4 shrink-0 flex justify-center">
                                                    {isCurrent ? (
                                                        <Check size={12} className="text-cl-lume" />
                                                    ) : (
                                                        <span className={`w-1.5 h-1.5 rounded-full ${isUnlocked ? 'bg-white/30' : 'bg-white/10'}`} />
                                                    )}
                                                </div>

                                                {/* Member range */}
                                                <span className={`flex-1 text-[11px] ${
                                                    isCurrent
                                                        ? 'text-white/80 font-medium'
                                                        : isUnlocked
                                                            ? 'text-cl-faint'
                                                            : 'text-cl-faint'
                                                }`}>
                                                    {tier.label}
                                                </span>

                                                {/* Quota */}
                                                <span className={`text-[11px] font-mono tabular-nums ${
                                                    isCurrent
                                                        ? 'text-cl-lume font-semibold'
                                                        : isUnlocked
                                                            ? 'text-cl-faint'
                                                            : 'text-cl-faint'
                                                }`}>
                                                    {formatBytes(tier.bytes)}
                                                </span>
                                            </div>
                                        );
                                    })}
                                </div>

                                {/* Footer: current member count */}
                                <div className="px-4 py-2.5 border-t border-cl-border/30 bg-white/[0.02]">
                                    <p className="text-[10px] text-cl-faint">
                                        Your server has{' '}
                                        <span className="text-cl-muted font-semibold">
                                            {quota.member_count.toLocaleString()}
                                        </span>{' '}
                                        member{quota.member_count !== 1 ? 's' : ''}.
                                    </p>
                                </div>
                            </div>
                        )}
                    </span>
                    <span>{Math.round(pct)}% used</span>
                </div>

                {typeof quota.emoji_bytes === 'number' && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-cl-faint">
                        <span>
                            Saved messages{' '}
                            <span className="text-cl-muted font-mono tabular-nums">
                                {formatBytes(quota.saves_bytes ?? Math.max(0, quota.used_bytes - quota.emoji_bytes))}
                            </span>
                        </span>
                        <span>
                            Custom emojis{' '}
                            <span className="text-cl-muted font-mono tabular-nums">{formatBytes(quota.emoji_bytes)}</span>
                            {typeof quota.emoji_count === 'number' && <> ({quota.emoji_count})</>}
                        </span>
                    </div>
                )}

                {isNearLimit && (
                    <div className="flex items-start gap-1.5 text-[11px] text-amber-400/80 leading-snug">
                        <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                        <span>{nearLimitMessage(quota.storage_plan)}</span>
                    </div>
                )}
            </div>

            {/* ── Per-channel breakdown ─────────────────────────────────────── */}
            {channels.length > 0 && (
                <div className="space-y-1">
                    <p className="text-[10px] font-mono font-semibold uppercase tracking-widest text-cl-faint pb-1">
                        By Channel
                    </p>

                    {channels.map(ch => {
                        const expanded  = expandedChannels.has(ch.channel_id);
                        const chPct     = quota.limit_bytes > 0
                            ? Math.min(100, (ch.total_bytes / quota.limit_bytes) * 100)
                            : 0;
                        const msgBytes  = ch.total_bytes - ch.attachment_bytes;

                        return (
                            <div
                                key={ch.channel_id}
                                className="rounded-lg bg-white/[0.03] border border-cl-border/30 overflow-hidden"
                            >
                                {/* Row header */}
                                <ClButton
                                    variant="ghost"
                                    fullWidth
                                    onClick={() => toggleChannel(ch.channel_id)}
                                >
                                    {/* Channel icon */}
                                    <Hash size={13} className="text-cl-faint shrink-0" />

                                    {/* Name */}
                                    <span className="flex-1 text-[13px] text-white/80 font-medium truncate min-w-0 text-left">
                                        {ch.channel_name}
                                    </span>

                                    {/* Save count badge */}
                                    <span className="text-[10px] text-cl-faint tabular-nums shrink-0">
                                        {ch.save_count} {ch.save_count === 1 ? 'save' : 'saves'}
                                    </span>

                                    {/* Byte total */}
                                    <span className="text-[11px] text-cl-muted font-mono tabular-nums shrink-0 w-16 text-right">
                                        {formatBytes(ch.total_bytes)}
                                    </span>

                                    {/* Expand chevron */}
                                    {expanded
                                        ? <ChevronDown size={13} className="text-cl-faint shrink-0" />
                                        : <ChevronRight size={13} className="text-cl-faint shrink-0" />
                                    }
                                </ClButton>

                                {/* Expanded detail */}
                                {expanded && (
                                    <div className="px-3 pb-3 pt-0 space-y-2 border-t border-cl-border/30">
                                        {/* Mini bar showing this channel's share of total quota */}
                                        <div className="h-1 w-full bg-white/[0.06] rounded-full overflow-hidden mt-2">
                                            <div
                                                className="h-full bg-amber-400/60 transition-all duration-300"
                                                style={{ width: `${chPct}%` }}
                                            />
                                        </div>

                                        {/* Message vs. attachment split */}
                                        <div className="grid grid-cols-2 gap-2">
                                            <div className="rounded-md bg-white/[0.03] px-2.5 py-2">
                                                <p className="text-[10px] text-cl-faint uppercase tracking-widest font-semibold">
                                                    Messages
                                                </p>
                                                <p className="text-[13px] text-cl-muted font-mono tabular-nums mt-0.5">
                                                    {formatBytes(msgBytes)}
                                                </p>
                                                <p className="text-[10px] text-cl-faint mt-0.5">
                                                    {ch.save_count - ch.attachment_count} text saves
                                                </p>
                                            </div>
                                            <div className="rounded-md bg-white/[0.03] px-2.5 py-2">
                                                <p className="text-[10px] text-cl-faint uppercase tracking-widest font-semibold">
                                                    Attachments
                                                </p>
                                                <p className="text-[13px] text-cl-muted font-mono tabular-nums mt-0.5">
                                                    {formatBytes(ch.attachment_bytes)}
                                                </p>
                                                <p className="text-[10px] text-cl-faint mt-0.5">
                                                    {ch.attachment_count} file{ch.attachment_count !== 1 ? 's' : ''}
                                                </p>
                                            </div>
                                        </div>

                                        {canManage && (
                                            <p className="text-[10px] text-cl-faint leading-snug">
                                                To free space, open the channel and right-click messages
                                                to remove server saves individually.
                                            </p>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {channels.length === 0 && quota.used_bytes === 0 && (
                <div className="text-center py-4 text-[12px] text-cl-faint">
                    No server saves yet. Right-click a channel message and choose
                    "Server Save" to keep it permanently.
                </div>
            )}
        </div>
    );
};
