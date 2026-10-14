/**
 * ServerStorageBanner — the storage-grace notice at the top of a server's view.
 *
 * Mounted once in Dashboard's banner stack, fed the server being shown. The
 * API decides what this viewer may see (owner / manager / member, and members
 * only near the deadline or just after a trim); this renders what it returns —
 * see utils/serverStorageGrace.ts for the words and buttons per state x
 * audience x urgency, and components/server/storageGraceActions.ts for what
 * each button does.
 *
 * Dismissal is client-side, per account, keyed by the API's `notice_id`, and
 * only for notices the API marks `dismissible` (pruned / resolved). A running
 * countdown cannot be dismissed. Persisted in secureLocalStore (never raw
 * localStorage) via utils/storageNoticeDismissals.ts; classified in
 * services/backupRegistry.ts.
 */
import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, HardDrive, Info, X } from 'lucide-react';
import { ClButton } from '../ClButton';
import { useAuth } from '../../contexts/AuthContext';
import { useSubscription } from '../../contexts/SubscriptionContext';
import { useToast } from '../../contexts/ToastContext';
import { useServerStorageStatus } from '../../hooks/useServerStorageStatus';
import { persistStorageNoticeDismissal, readDismissedStorageNotices } from '../../utils/storageNoticeDismissals';
import {
    buildStorageBannerModel,
    type StorageBannerAction,
    type StorageBannerModel,
    type StorageBannerTone,
} from '../../utils/serverStorageGrace';
import { createStorageActionHandler, STORAGE_ACTION_LABELS, type StorageSettingsTarget } from './storageGraceActions';
import { StorageGraceExplainer } from './StorageGraceExplainer';

const TONE_STYLE: Record<StorageBannerTone, { bg: string; border: string; icon: string }> = {
    calm:    { bg: 'rgba(37,224,200,0.07)',  border: 'rgba(37,224,200,0.24)',  icon: 'var(--cl-lume)' },
    amber:   { bg: 'rgba(255,201,77,0.10)',  border: 'rgba(255,201,77,0.34)',  icon: 'var(--cl-glow)' },
    red:     { bg: 'rgba(255,107,94,0.13)',  border: 'rgba(255,107,94,0.42)',  icon: 'var(--cl-flash)' },
    neutral: { bg: 'var(--cl-deep)',         border: 'var(--cl-border)',       icon: 'var(--cl-muted)' },
    ok:      { bg: 'rgba(74,222,128,0.08)',  border: 'rgba(74,222,128,0.26)',  icon: 'var(--cl-ok)' },
};

function ToneIcon({ tone }: { tone: StorageBannerTone }) {
    const color = TONE_STYLE[tone].icon;
    const p = { size: 15, className: 'shrink-0', style: { color } } as const;
    if (tone === 'red' || tone === 'amber') return <AlertTriangle {...p} />;
    if (tone === 'calm') return <Clock {...p} />;
    if (tone === 'ok') return <CheckCircle2 {...p} />;
    return <HardDrive {...p} />;
}

/** Primary button per tone: the first action is the one that matters most. */
function actionVariant(model: StorageBannerModel, action: StorageBannerAction, index: number): 'primary' | 'ghost' | 'danger' {
    if (action === 'learn_more') return 'ghost';
    if (index !== 0) return 'ghost';
    return model.tone === 'red' ? 'danger' : 'primary';
}

export interface ServerStorageBannerViewProps {
    model: StorageBannerModel;
    onAction: (action: StorageBannerAction) => void;
    onDismiss: () => void;
}

/** Presentational — no data fetching, so it renders in tests and the screenshot harness. */
export const ServerStorageBannerView: React.FC<ServerStorageBannerViewProps> = ({ model, onAction, onDismiss }) => {
    const tone = TONE_STYLE[model.tone];
    return (
        <div className="w-full shrink-0 py-2" role="region" aria-label="Server storage">
            <div
                role="status"
                data-storage-banner={model.noticeId}
                data-tone={model.tone}
                className="w-full px-4 py-2.5 rounded-xl flex items-center gap-2.5 text-[13px] animate-in fade-in slide-in-from-top-2 duration-200"
                style={{ background: tone.bg, border: `1px solid ${tone.border}`, color: 'var(--cl-text)' }}
            >
                <ToneIcon tone={model.tone} />
                <div className="flex-1 min-w-0 leading-snug">
                    {model.lead && <span className="font-semibold">{model.lead}</span>}
                    {model.lead && ' '}
                    <span className="opacity-90">{model.text}</span>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1.5 shrink-0">
                    {model.actions.map((a, i) => {
                        if (a === 'transfer' && model.noProMembers) {
                            return (
                                <span
                                    key={a}
                                    data-action="no-pro-members"
                                    className="inline-flex items-center gap-1 text-[12px] text-cl-muted px-2"
                                >
                                    <Info size={12} className="shrink-0" />
                                    No members have Pro yet
                                </span>
                            );
                        }
                        return (
                            <span key={a} data-action={a} className="contents">
                                <ClButton
                                    type="button"
                                    size="sm"
                                    variant={actionVariant(model, a, i)}
                                    onClick={() => onAction(a)}
                                >
                                    {STORAGE_ACTION_LABELS[a]}
                                </ClButton>
                            </span>
                        );
                    })}
                    {model.dismissible && (
                        <span data-action="dismiss" className="contents">
                            <ClButton type="button" icon variant="ghost" size="sm" tooltip="Dismiss" onClick={onDismiss}>
                                <X size={13} />
                            </ClButton>
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
};

interface Props {
    serverId: string | null;
    serverName: string;
    wsConnectCount: number;
    /** Open Server Settings for THIS server at the given tab. */
    onOpenSettings: (target: StorageSettingsTarget) => void;
}

export const ServerStorageBanner: React.FC<Props> = ({ serverId, serverName, wsConnectCount, onOpenSettings }) => {
    const { token, userId } = useAuth();
    const { status: billing, openInAppCheckout, setCancellation } = useSubscription();
    const toast = useToast();
    const status = useServerStorageStatus(serverId, token, userId, wsConnectCount);
    const [explainerOpen, setExplainerOpen] = useState(false);
    const [dismissTick, setDismissTick] = useState(0);

    const dismissedIds = useMemo(
        () => (userId ? readDismissedStorageNotices(userId) : []),
        // dismissTick is a deliberate re-read trigger.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [userId, dismissTick],
    );
    const model = useMemo(
        () => (status && status.server_id === serverId ? buildStorageBannerModel(status, serverName, { dismissedIds }) : null),
        [status, serverId, serverName, dismissedIds],
    );

    const onAction = useMemo(() => createStorageActionHandler({
        subscriptionStatus: billing?.subscription_status,
        openInAppCheckout,
        setCancellation,
        openSettings: onOpenSettings,
        openExplainer: () => setExplainerOpen(true),
        notify: (kind, message) => toast.push({ kind, message }),
    }), [billing?.subscription_status, openInAppCheckout, setCancellation, onOpenSettings, toast]);

    return (
        <>
            {model && userId && (
                <ServerStorageBannerView
                    model={model}
                    onAction={onAction}
                    onDismiss={() => {
                        persistStorageNoticeDismissal(userId, model.noticeId);
                        setDismissTick(t => t + 1);
                    }}
                />
            )}
            <StorageGraceExplainer open={explainerOpen} onClose={() => setExplainerOpen(false)} />
        </>
    );
};

export default ServerStorageBanner;
