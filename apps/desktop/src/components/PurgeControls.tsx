import React, { useState, useRef } from 'react';
import { ChevronDown, Trash2, AlertTriangle } from 'lucide-react';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';
import { useEscape } from '../hooks/useEscape';
import { ClButton, ClModal } from './cl';

export const PURGE_OPTIONS: { ms: number; label: string }[] = [
    { ms: 365 * 24 * 3600 * 1000, label: '1 year' },
    { ms: 182 * 24 * 3600 * 1000, label: '6 months' },
    { ms: 30  * 24 * 3600 * 1000, label: '1 month' },
    { ms: 7   * 24 * 3600 * 1000, label: '1 week' },
    { ms: 0,                      label: 'Everything' },
];

/**
 * Count how many messages in the array WOULD be deleted by a purge with this
 * threshold. Mirrors the filter logic in Dashboard's handlePurgeConversation so
 * the count shown in the confirm modal matches what actually gets deleted.
 * Pending (unsent) messages are never purged.
 */
export function countMessagesToPurge(messages: any[] | undefined, olderThanMs: number): number {
    if (!Array.isArray(messages)) return 0;
    if (olderThanMs === 0) {
        return messages.filter((m: any) => !m?._pending).length;
    }
    const now = Date.now();
    return messages.filter((m: any) => {
        if (m?._pending) return false;
        const t = m?.timestamp ?? m?.sent_at ?? m?.created_at ?? m?.received_at ?? null;
        let ts = typeof t === 'number' ? t : (t ? Date.parse(t) : Date.now());
        if (!Number.isFinite(ts)) ts = Date.now();
        return (now - ts) >= olderThanMs;
    }).length;
}

interface PurgeDropdownProps {
    onSelect: (olderThanMs: number, label: string) => void;
    size?: 'sm' | 'md';
    disabled?: boolean;
}

/**
 * One-shot dropdown to pick a purge window. Not a persistent-value selector,
 * so ClSelect doesn't fit — keeps its own open/close state.
 */
export const PurgeDropdown: React.FC<PurgeDropdownProps> = ({ onSelect, size = 'sm', disabled }) => {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useDismissOnOutsideClick(ref, open, () => setOpen(false));
    useEscape(() => setOpen(false), open);

    return (
        <div ref={ref} className="relative flex-1 min-w-0">
            <ClButton
                type="button"
                variant="ghost"
                size={size === 'sm' ? 'sm' : undefined}
                disabled={disabled}
                fullWidth
                onClick={() => setOpen(v => !v)}
                style={{ justifyContent: 'space-between' }}
            >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Purge older than…</span>
                <ChevronDown size={14} style={{ color: 'var(--cl-faint)', flexShrink: 0, transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }} />
            </ClButton>
            {open && (
                <div
                    role="listbox"
                    style={{
                        position: 'absolute',
                        zIndex: 30,
                        left: 0, right: 0,
                        marginTop: 4,
                        background: 'var(--cl-deep)',
                        border: '1px solid var(--cl-border)',
                        borderRadius: 12,
                        boxShadow: '0 12px 32px rgba(0,0,0,.6)',
                        overflow: 'hidden',
                    }}
                >
                    {PURGE_OPTIONS.map(o => (
                        <ClButton
                            key={o.ms}
                            type="button"
                            variant={o.ms === 0 ? 'danger' : 'ghost'}
                            size="sm"
                            fullWidth
                            onClick={() => { onSelect(o.ms, o.label); setOpen(false); }}
                            style={{
                                justifyContent: 'flex-start',
                                borderRadius: 0,
                                borderTop: o.ms === 0 ? '1px solid var(--cl-border)' : undefined,
                            }}
                        >
                            {o.label}
                        </ClButton>
                    ))}
                </div>
            )}
        </div>
    );
};

interface PurgeConfirmModalProps {
    count: number;
    /** Human-readable threshold ("1 month", "Everything"). Drives copy. */
    label: string;
    /** Optional chat title to mention in the copy ("…from Alice"). */
    convTitle?: string;
    onConfirm: () => void;
    onCancel: () => void;
}

/**
 * Confirmation dialog for message purges. Shows the exact count of messages
 * that will be deleted so the user knows the scope before committing.
 */
export const PurgeConfirmModal: React.FC<PurgeConfirmModalProps> = ({ count, label, convTitle, onConfirm, onCancel }) => {
    const isEverything = label === 'Everything';
    const msgNoun = count === 1 ? 'message' : 'messages';

    return (
        <ClModal open onClose={onCancel} width={440}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(239,68,68,.15)', border: '1px solid rgba(239,68,68,.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <Trash2 size={20} style={{ color: 'var(--cl-flash)' }} />
                </div>
                <h4 style={{ margin: 0 }}>Purge Messages</h4>
            </div>

            {count === 0 ? (
                <p style={{ fontSize: 14, color: 'var(--cl-muted)', lineHeight: 1.6, marginBottom: 20 }}>
                    No messages match <strong style={{ color: 'var(--cl-text)' }}>{label}</strong>
                    {convTitle ? <> in <strong style={{ color: 'var(--cl-text)' }}>{convTitle}</strong></> : null}. Nothing to delete.
                </p>
            ) : (
                <>
                    <p style={{ fontSize: 14, color: 'var(--cl-muted)', lineHeight: 1.6, marginBottom: 12 }}>
                        {isEverything ? (
                            <>This will permanently delete <strong style={{ color: 'var(--cl-flash)' }}>{count.toLocaleString()}</strong> {msgNoun}
                            {convTitle ? <> from <strong style={{ color: 'var(--cl-text)' }}>{convTitle}</strong></> : null} on this device.</>
                        ) : (
                            <>This will permanently delete <strong style={{ color: 'var(--cl-flash)' }}>{count.toLocaleString()}</strong> {msgNoun} older than <strong style={{ color: 'var(--cl-text)' }}>{label}</strong>
                            {convTitle ? <> from <strong style={{ color: 'var(--cl-text)' }}>{convTitle}</strong></> : null} on this device.</>
                        )}
                    </p>
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', borderRadius: 10, background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.25)', fontSize: 11, color: 'var(--cl-glow)', marginBottom: 20 }}>
                        <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                        <span>This cannot be undone. Other devices and recipients keep their copies.</span>
                    </div>
                </>
            )}

            <div className="mrow">
                <ClButton variant="ghost" size="sm" onClick={onCancel}>{count === 0 ? 'Close' : 'Cancel'}</ClButton>
                {count > 0 && (
                    <ClButton variant="danger" size="sm" autoFocus onClick={onConfirm}>
                        Delete {count.toLocaleString()}
                    </ClButton>
                )}
            </div>
        </ClModal>
    );
};
