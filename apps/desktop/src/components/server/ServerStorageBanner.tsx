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
import { AlertTriangle, CheckCircle2, Clock, HardDrive, Info } from 'lucide-react';
import { ClBanner } from '../ClBanner';
import type { ClBannerTone } from '../bannerStack';
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

/** The storage model's five tones onto the shared banner tones. */
const BANNER_TONE: Record<StorageBannerTone, ClBannerTone> = {
    calm: 'info',
    amber: 'warning',
    red: 'danger',
    neutral: 'neutral',
    ok: 'success',
};
/** Red outranks everything routine; a calm countdown yields to anything else. */
const BANNER_PRIORITY: Record<StorageBannerTone, number> = {
    red: 82, amber: 66, ok: 36, calm: 34, neutral: 25,
};

function toneIcon(tone: StorageBannerTone): React.ReactNode {
    const p = { size: 15 } as const;
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
export const ServerStorageBannerView: React.FC<ServerStorageBannerViewProps> = ({ model, onAction, onDismiss }) => (
    <ClBanner
        id="server-storage"
        tone={BANNER_TONE[model.tone]}
        priority={BANNER_PRIORITY[model.tone]}
        ariaLabel="Server storage"
        icon={toneIcon(model.tone)}
        data={{ 'storage-banner': model.noticeId, tone: model.tone }}
        title={model.lead || undefined}
        description={model.text}
        actions={model.actions.map((a, i) => (
            a === 'transfer' && model.noProMembers
                ? {
                    key: 'no-pro-members',
                    node: (
                        <span className="inline-flex items-center gap-1 text-[12px] text-cl-muted px-2">
                            <Info size={12} className="shrink-0" />
                            No members have Pro yet
                        </span>
                    ),
                }
                : {
                    key: a,
                    label: STORAGE_ACTION_LABELS[a],
                    variant: actionVariant(model, a, i),
                    onClick: () => onAction(a),
                }
        ))}
        onDismiss={model.dismissible ? onDismiss : undefined}
    />
);

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
