/**
 * Server Settings -> Storage: the storage-grace card above the usage meter.
 *
 * Same status, words and buttons as the server banner (ServerStorageBanner),
 * laid out for the settings page: the countdown is the headline, the usage is
 * shown against the 25 MB the server would be trimmed to, and "Manage storage"
 * is replaced by where space is actually freed (Emojis tab / unsaving messages)
 * since this IS the storage page. Renders nothing when the API says `ok`.
 */
import React, { useMemo, useState } from 'react';
import { HardDrive } from 'lucide-react';
import { formatBytes, formatBillingDate } from '@cipherline/shared';
import { ClButton } from '../ClButton';
import { useSubscription } from '../../contexts/SubscriptionContext';
import { useToast } from '../../contexts/ToastContext';
import { useServerStorageStatus } from '../../hooks/useServerStorageStatus';
import {
    buildStorageBannerModel,
    statusDaysLeft,
    type StorageBannerAction,
    type StorageBannerTone,
} from '../../utils/serverStorageGrace';
import { createStorageActionHandler, STORAGE_ACTION_LABELS, type StorageSettingsTarget } from './storageGraceActions';
import { StorageGraceExplainer } from './StorageGraceExplainer';
import type { ServerStorageStatus } from '@cipherline/shared';

const ACCENT: Record<StorageBannerTone, string> = {
    calm: 'var(--cl-lume)',
    amber: 'var(--cl-glow)',
    red: 'var(--cl-flash)',
    neutral: 'var(--cl-muted)',
    ok: 'var(--cl-ok)',
};

export interface ServerStorageGraceCardProps {
    status: ServerStorageStatus;
    serverName: string;
    onAction: (action: StorageBannerAction | 'manage_emojis') => void;
    nowMs?: number;
}

/** Presentational card (no fetching) — exported for tests. */
export const ServerStorageGraceCard: React.FC<ServerStorageGraceCardProps> = ({ status, serverName, onAction, nowMs }) => {
    // Dismissal is a banner concern; the settings page always shows the current state.
    const model = buildStorageBannerModel(status, serverName, { nowMs });
    if (!model) return null;
    const accent = ACCENT[model.tone];
    const days = status.state === 'grace' ? statusDaysLeft(status, nowMs) : null;
    const deadline = formatBillingDate(status.grace_deadline);
    const target = status.target_bytes;
    const usage = status.usage_bytes;
    const over = usage !== null && usage > target ? usage - target : 0;
    const pct = usage !== null && usage > 0 ? Math.min(100, (target / usage) * 100) : 100;
    const canFreeSpace = status.audience !== 'member' && (status.state === 'grace' || status.state === 'pending');
    const actions = model.actions.filter(a => a !== 'manage_storage');

    return (
        <div
            data-storage-grace-card={status.state}
            data-tone={model.tone}
            className="rounded-[14px] p-4 space-y-3"
            style={{ background: 'var(--cl-surface)', border: `1px solid ${accent}`, borderLeftWidth: 3 }}
        >
            <div className="flex items-start gap-3">
                <HardDrive size={16} className="shrink-0 mt-0.5" style={{ color: accent }} />
                <div className="flex-1 min-w-0">
                    {days !== null && (
                        <p className="m-0 text-[20px] font-semibold leading-tight" style={{ fontFamily: 'var(--cl-font-display)', color: accent }}>
                            {days <= 0 ? 'Trimming soon' : `${days} day${days === 1 ? '' : 's'} left`}
                            {deadline && <span className="text-[12px] font-normal text-cl-muted ml-2" style={{ fontFamily: 'inherit' }}>until {deadline}</span>}
                        </p>
                    )}
                    <p className="m-0 mt-1 text-[13px] leading-relaxed text-cl-muted">
                        {model.lead && days === null && <span className="font-semibold text-cl-text">{model.lead} </span>}
                        {model.text}
                    </p>
                </div>
            </div>

            {usage !== null && over > 0 && (
                <div className="space-y-1">
                    <div className="h-1.5 w-full rounded-full overflow-hidden" style={{ background: 'rgba(255,107,94,0.35)' }} title={`${formatBytes(target)} free limit`}>
                        <div className="h-full" style={{ width: `${pct}%`, background: 'var(--cl-lume)' }} />
                    </div>
                    <p className="m-0 text-[11px] text-cl-faint font-mono tabular-nums">
                        {formatBytes(usage)} used · {formatBytes(target)} free limit · {formatBytes(over)} over
                    </p>
                </div>
            )}

            {(actions.length > 0 || canFreeSpace) && (
                <div className="flex flex-wrap items-center gap-2">
                    {actions.map((a, i) => (a === 'transfer' && model.noProMembers
                        ? <span key={a} data-action="no-pro-members" className="text-[12px] text-cl-muted">No members have Pro yet</span>
                        : (
                            <span key={a} data-action={a} className="contents">
                                <ClButton type="button" size="sm" variant={i === 0 && a !== 'learn_more' ? (model.tone === 'red' ? 'danger' : 'primary') : 'ghost'} onClick={() => onAction(a)}>
                                    {STORAGE_ACTION_LABELS[a]}
                                </ClButton>
                            </span>
                        )))}
                    {canFreeSpace && (
                        <span data-action="manage_emojis" className="contents">
                            <ClButton type="button" size="sm" variant="ghost" onClick={() => onAction('manage_emojis')}>
                                Manage emojis
                            </ClButton>
                        </span>
                    )}
                </div>
            )}
            {canFreeSpace && (
                <p className="m-0 text-[11px] text-cl-faint leading-snug">
                    To free space, remove custom emojis, or unsave messages from their channel (right-click a message).
                    The breakdown below shows where the space goes.
                </p>
            )}
        </div>
    );
};

interface Props {
    serverId: string;
    serverName: string;
    token: string | null;
    userId: string | null;
    /** Switch the settings modal to another tab (members filtered to Pro, or emojis). */
    onNavigate: (target: StorageSettingsTarget | { tab: 'emojis' }) => void;
}

export const ServerStorageGracePanel: React.FC<Props> = ({ serverId, serverName, token, userId, onNavigate }) => {
    const status = useServerStorageStatus(serverId, token, userId);
    const { status: billing, openInAppCheckout, setCancellation } = useSubscription();
    const toast = useToast();
    const [explainerOpen, setExplainerOpen] = useState(false);

    const handle = useMemo(() => createStorageActionHandler({
        subscriptionStatus: billing?.subscription_status,
        openInAppCheckout,
        setCancellation,
        openSettings: onNavigate,
        openExplainer: () => setExplainerOpen(true),
        notify: (kind, message) => toast.push({ kind, message }),
    }), [billing?.subscription_status, openInAppCheckout, setCancellation, onNavigate, toast]);

    if (!status || status.server_id !== serverId) return <StorageGraceExplainer open={explainerOpen} onClose={() => setExplainerOpen(false)} />;
    return (
        <>
            <ServerStorageGraceCard
                status={status}
                serverName={serverName}
                onAction={(a) => (a === 'manage_emojis' ? onNavigate({ tab: 'emojis' }) : handle(a))}
            />
            <StorageGraceExplainer open={explainerOpen} onClose={() => setExplainerOpen(false)} />
        </>
    );
};

export default ServerStorageGracePanel;
