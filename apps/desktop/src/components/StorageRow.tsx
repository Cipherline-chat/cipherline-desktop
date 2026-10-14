import React from 'react';

export interface StorageRowProps {
    title: string;
    /** Optional leading visual (a server icon). */
    lead?: React.ReactNode;
    /** Small amber pill after the title ("deleted", "Left"). */
    badge?: string;
    /** One quiet line under the title. */
    subtitle?: string;
    /** Right-aligned size, already formatted. */
    sizeLabel: string;
    /** 0-100 width of the usage bar. */
    barPct: number;
    /** Text beside the bar ("1,204 msgs"). */
    countLabel: string;
    /** The purge control (a PurgeDropdown). */
    purge: React.ReactNode;
    attachmentCount?: number;
    /** Result of the last purge on this row. */
    status?: { tone: 'ok' | 'warn'; text: string } | null;
}

/**
 * One row of Settings -> Storage -> "Conversation storage" / "Server storage".
 * Extracted from StorageSettings so a DM, a group chat and a server are the same
 * markup, not three copies that drift: title + size, usage bar + message count,
 * then the "Purge older than..." menu.
 */
export const StorageRow: React.FC<StorageRowProps> = ({
    title, lead, badge, subtitle, sizeLabel, barPct, countLabel, purge, attachmentCount = 0, status,
}) => (
    <div className="p-3 rounded-xl space-y-2" style={{ background: 'rgba(0,0,0,.2)', border: '1px solid var(--cl-border)' }}>
        <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
                {lead}
                <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-medium truncate" style={{ color: 'var(--cl-text)' }}>{title}</span>
                        {badge && (
                            <span className="text-[10px] font-bold rounded-full px-1.5 py-0.5 shrink-0" style={{ color: 'var(--cl-glow)', background: 'rgba(245,158,11,.1)', border: '1px solid rgba(245,158,11,.3)' }}>{badge}</span>
                        )}
                    </div>
                    {subtitle && (
                        <div className="text-[11px] truncate" style={{ color: 'var(--cl-faint)' }}>{subtitle}</div>
                    )}
                </div>
            </div>
            <span className="text-xs shrink-0" style={{ color: 'var(--cl-muted)' }}>{sizeLabel}</span>
        </div>
        <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,.06)' }}>
                <div className="h-full rounded-full" style={{ width: `${barPct}%`, background: 'rgba(37,224,200,.6)' }} />
            </div>
            <span className="text-[11px] shrink-0" style={{ color: 'var(--cl-faint)' }}>{countLabel}</span>
        </div>
        <div className="flex items-center gap-2 pt-0.5">
            {purge}
            {attachmentCount > 0 && (
                <span className="text-[11px] shrink-0" style={{ color: 'var(--cl-faint)' }}>{attachmentCount} attachments</span>
            )}
        </div>
        {status && (
            <div role="status" className="text-[11px] leading-snug" style={{ color: status.tone === 'warn' ? 'var(--cl-glow)' : 'var(--cl-muted)' }}>
                {status.text}
            </div>
        )}
    </div>
);
