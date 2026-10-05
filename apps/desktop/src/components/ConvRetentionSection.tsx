/**
 * ConvRetentionSection — per-conversation local storage stats + retention controls.
 *
 * Replaces the old "Local Storage" section (with PurgeDropdown controls) in the
 * right-panel info area for DMs and group chats.  Keeps the same card layout but
 * swaps the one-shot "Purge older than…" drop-down for a persistent retention
 * select that drives automatic sweeping.
 *
 * Storage key: `cipherline_conv_retention_${userId}_${convId}`
 * No entry / null value = no override — falls back to global policy.
 */

import secureLocalStore from '../utils/secureLocalStore';
import React, { useState, useEffect, useMemo } from 'react';
import { MessageSquare, FolderOpen, Clock, RotateCcw, X } from 'lucide-react';
import type { MessageRetention, AttachmentRetention } from '../hooks/useRetentionPolicy';
import { MESSAGE_RETENTION_LABELS, ATTACHMENT_RETENTION_LABELS } from '../hooks/useRetentionPolicy';
import { calcConversationStorage } from '../utils/storageCalc';
import { formatBytes } from './StorageSettings';
import { ClButton, ClSelect } from './cl';
import type { ClSelectOption } from './cl';

// Ordered least → most restrictive (index 0 = keep forever).
const MSG_ORDER: MessageRetention[]    = ['never', '1y', '6mo', '3mo', '1mo', '1wk'];
const ATT_ORDER: AttachmentRetention[] = ['never', '1y', '6mo', '3mo', '1mo', '1wk', '24h'];

const MSG_OPTIONS: ClSelectOption<MessageRetention>[] = MSG_ORDER.map(v => ({ value: v, label: MESSAGE_RETENTION_LABELS[v] }));
const ATT_OPTIONS: ClSelectOption<AttachmentRetention>[] = ATT_ORDER.map(v => ({ value: v, label: ATTACHMENT_RETENTION_LABELS[v] }));

export function convRetentionKey(userId: string, convId: string) {
    return `cipherline_conv_retention_${userId}_${convId}`;
}

export interface ConvRetentionOverride {
    messageRetention: MessageRetention;
    attachmentRetention: AttachmentRetention;
}

function loadOverride(userId: string, convId: string): ConvRetentionOverride | null {
    try {
        const raw = secureLocalStore.getItem(convRetentionKey(userId, convId));
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

interface Props {
    convId: string;
    userId: string;
    msgs: any[];
    globalMsgRetention: MessageRetention;
    globalAttRetention: AttachmentRetention;
    onChanged: () => void;
    onPurgeNow: (
        convId: string,
        msgRet: MessageRetention,
        attRet: AttachmentRetention,
    ) => void;
}

export const ConvRetentionSection: React.FC<Props> = ({
    convId,
    userId,
    msgs,
    globalMsgRetention,
    globalAttRetention,
    onChanged,
    onPurgeNow,
}) => {
    const [override, setOverride] = useState<ConvRetentionOverride | null>(() =>
        loadOverride(userId, convId),
    );

    const [purgeConfirm, setPurgeConfirm] = useState<{
        proposed: ConvRetentionOverride;
        label: string;
    } | null>(null);

    useEffect(() => {
        setPurgeConfirm(null);
        setOverride(loadOverride(userId, convId));
    }, [convId, userId]);

    useEffect(() => {
        const key = convRetentionKey(userId, convId);
        try {
            if (override === null) {
                secureLocalStore.removeItem(key);
            } else {
                secureLocalStore.setItem(key, JSON.stringify(override));
            }
            onChanged();
        } catch { /* non-fatal */ }
    }, [override, convId, userId]); // eslint-disable-line react-hooks/exhaustive-deps

    const effectiveMsg: MessageRetention    = override?.messageRetention    ?? globalMsgRetention;
    const effectiveAtt: AttachmentRetention = override?.attachmentRetention ?? globalAttRetention;
    const hasOverride = override !== null;

    // PERF: JSON-sizes every message in the conversation. This panel re-renders
    // with Dashboard (presence, typing, unread events), so for a long DM that
    // was a full JSON.stringify of ~1,500 messages per event. Only recompute
    // when the messages themselves change.
    const stats = useMemo(() => calcConversationStorage(convId, msgs), [convId, msgs]);
    const textMsgCount = stats.messageCount - stats.attachmentCount;

    const handleMsgChange = (newVal: MessageRetention) => {
        const oldIdx = MSG_ORDER.indexOf(effectiveMsg);
        const newIdx = MSG_ORDER.indexOf(newVal);
        const proposed: ConvRetentionOverride = {
            messageRetention:    newVal,
            attachmentRetention: effectiveAtt,
        };
        if (newIdx > oldIdx) {
            setPurgeConfirm({ proposed, label: MESSAGE_RETENTION_LABELS[newVal] });
        } else {
            setOverride(proposed);
        }
    };

    const handleAttChange = (newVal: AttachmentRetention) => {
        const oldIdx = ATT_ORDER.indexOf(effectiveAtt);
        const newIdx = ATT_ORDER.indexOf(newVal);
        const proposed: ConvRetentionOverride = {
            messageRetention:    effectiveMsg,
            attachmentRetention: newVal,
        };
        if (newIdx > oldIdx) {
            setPurgeConfirm({ proposed, label: ATTACHMENT_RETENTION_LABELS[newVal] });
        } else {
            setOverride(proposed);
        }
    };

    const applyPurge = () => {
        if (!purgeConfirm) return;
        setOverride(purgeConfirm.proposed);
        onPurgeNow(
            convId,
            purgeConfirm.proposed.messageRetention,
            purgeConfirm.proposed.attachmentRetention,
        );
        setPurgeConfirm(null);
    };

    return (
        <div className="shrink-0 px-2 pt-3">
            {/* ── Section header — DS StorageCard ────────────────────────── */}
            <div className="flex items-baseline justify-between" style={{ padding: '0 2px 8px' }}>
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--cl-faint)' }}>
                    Local storage
                </span>
                <div className="flex items-center gap-2">
                    {hasOverride && (
                        <ClButton
                            size="sm"
                            variant="ghost"
                            onClick={() => { setPurgeConfirm(null); setOverride(null); }}
                            tooltip="Remove overrides — revert to global retention settings"
                        >
                            <RotateCcw size={10} />Reset
                        </ClButton>
                    )}
                    <span style={{ fontFamily: 'var(--cl-font-mono)', fontSize: 11.5, color: 'var(--cl-muted)' }}>
                        {formatBytes(stats.totalBytes)} used
                    </span>
                </div>
            </div>

            {/* ── One card · Messages + Attachments. The retention select sits on
                its own line so the panel's narrow width never clips the labels. ── */}
            <div style={{ background: 'var(--cl-surface)', border: '1px solid var(--cl-border)', borderRadius: 14, padding: '14px 15px' }}>
                {/* Messages entry */}
                <div>
                    <div className="flex items-center" style={{ gap: 11 }}>
                        <span className="shrink-0 flex items-center justify-center" style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--cl-lume-tint)', color: 'var(--cl-lume)' }}>
                            <MessageSquare size={15} />
                        </span>
                        <span className="min-w-0" style={{ lineHeight: 1.2 }}>
                            <span className="block truncate" style={{ fontSize: 13, fontWeight: 800, color: 'var(--cl-text)' }}>Messages</span>
                            <span className="block whitespace-nowrap" style={{ fontSize: 11, fontWeight: 600, color: 'var(--cl-faint)', fontFamily: 'var(--cl-font-mono)' }}>
                                {textMsgCount.toLocaleString()} · {formatBytes(stats.textBytes)}
                            </span>
                        </span>
                    </div>
                    <div className="flex items-center" style={{ gap: 8, marginTop: 10 }}>
                        <span className="shrink-0" style={{ fontSize: 11, color: 'var(--cl-faint)' }}>Keep for</span>
                        <ClSelect<MessageRetention>
                            value={effectiveMsg}
                            onChange={handleMsgChange}
                            options={MSG_OPTIONS}
                            style={{ flex: 1 }}
                        />
                    </div>
                </div>
                {/* Attachments entry */}
                <div style={{ paddingTop: 12, marginTop: 12, borderTop: '1px solid var(--cl-border)' }}>
                    <div className="flex items-center" style={{ gap: 11 }}>
                        <span className="shrink-0 flex items-center justify-center" style={{ width: 30, height: 30, borderRadius: 9, background: 'var(--cl-lume-tint)', color: 'var(--cl-lume)' }}>
                            <FolderOpen size={15} />
                        </span>
                        <span className="min-w-0" style={{ lineHeight: 1.2 }}>
                            <span className="block truncate" style={{ fontSize: 13, fontWeight: 800, color: 'var(--cl-text)' }}>Attachments</span>
                            <span className="block whitespace-nowrap" style={{ fontSize: 11, fontWeight: 600, color: 'var(--cl-faint)', fontFamily: 'var(--cl-font-mono)' }}>
                                {stats.attachmentCount.toLocaleString()} · {formatBytes(stats.attachmentBytes)}
                            </span>
                        </span>
                    </div>
                    <div className="flex items-center" style={{ gap: 8, marginTop: 10 }}>
                        <span className="shrink-0" style={{ fontSize: 11, color: 'var(--cl-faint)' }}>Keep for</span>
                        <ClSelect<AttachmentRetention>
                            value={effectiveAtt}
                            onChange={handleAttChange}
                            options={ATT_OPTIONS}
                            style={{ flex: 1 }}
                        />
                    </div>
                </div>
            </div>
            <p style={{ margin: '7px 2px 0', fontSize: 11, lineHeight: 1.45, color: 'var(--cl-faint)' }}>
                Applies to this device only — doesn’t sync to your other devices.
            </p>

            {/* ── Retention change confirmation ─────────────────────────── */}
            {purgeConfirm && (
                <div className="mt-2.5 rounded-xl border p-3" style={{ background: 'var(--cl-surface)', borderColor: 'var(--cl-border)' }}>
                    <div className="flex items-start gap-2.5 mb-3">
                        <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-0.5" style={{ background: 'rgba(37,224,200,.1)', border: '1px solid rgba(37,224,200,.2)' }}>
                            <Clock size={11} style={{ color: 'var(--cl-lume)' }} />
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-[12px] font-semibold leading-snug" style={{ color: 'var(--cl-text)' }}>
                                Shortening to {purgeConfirm.label}
                            </p>
                            <p className="text-[11px] mt-0.5" style={{ color: 'var(--cl-faint)' }}>
                                Existing messages outside this window will be removed on the next sweep, or now.
                            </p>
                        </div>
                        <ClButton
                            icon
                            variant="ghost"
                            size="sm"
                            onClick={() => setPurgeConfirm(null)}
                            tooltip="Dismiss"
                            style={{ flexShrink: 0 }}
                        >
                            <X size={11} />
                        </ClButton>
                    </div>
                    <div className="flex gap-1.5">
                        <ClButton
                            variant="ghost"
                            size="sm"
                            fullWidth
                            onClick={() => { setOverride(purgeConfirm.proposed); setPurgeConfirm(null); }}
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
        </div>
    );
};
