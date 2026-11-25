import React, { useEffect } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Check, PauseCircle } from 'lucide-react';
import { ClBanner } from '../ClBanner';
import { NearProgress } from './NearParts';
import { nt } from '../../utils/nearStrings';
import type { TransferBannerView } from '../../utils/nearTransferView';

export interface TransferBannerProps {
    view: TransferBannerView;
    direction: 'send' | 'receive';
    onPause?: () => void;
    onResume?: () => void;
    onDetails?: () => void;
    onCancel?: () => void;
    onDismiss?: () => void;
}

/**
 * `TransferBanner` (spec component 3): `ClBanner` with a progress bar and Pause/Resume, Details, Cancel. The same
 * component on the sender and the receiver. Banner priority: below security alerts, above everything else (the
 * stack orders by tone priority; `info` sits there).
 */
export const TransferBanner: React.FC<TransferBannerProps> = ({ view, direction, onPause, onResume, onDetails, onCancel, onDismiss }) => {
    useEffect(() => {
        if (view.autoHideMs == null || !onDismiss) return;
        const id = setTimeout(onDismiss, view.autoHideMs);
        return () => clearTimeout(id);
    }, [view.kind, view.autoHideMs, onDismiss]);

    const actions = view.actions.map((a, i) => ({
        key: a,
        label: a === 'pause' ? nt('e.pause') : a === 'resume' ? nt('e.resume') : a === 'details' ? nt('e.details') : a === 'discard' ? nt('e.stop.discard') : nt('e.cancel'),
        onClick: a === 'pause' ? onPause : a === 'resume' ? onResume : a === 'details' ? onDetails : a === 'discard' ? onDismiss : onCancel,
        variant: (i === 0 && (a === 'pause' || a === 'resume') ? 'primary' : 'ghost') as 'primary' | 'ghost',
    }));
    const icon = view.kind === 'done' ? <Check size={16} /> : view.kind === 'paused' ? <PauseCircle size={16} /> : direction === 'send' ? <ArrowUpFromLine size={16} /> : <ArrowDownToLine size={16} />;
    return (
        <ClBanner
            id="near-transfer"
            tone={view.tone}
            title={view.title}
            description={view.description || undefined}
            icon={icon}
            actions={actions}
            onDismiss={view.dismissible ? onDismiss : undefined}
            dismissLabel={nt('common.dismiss.a11y')}
            live="polite"
            testId="transfer-banner"
            data={{ kind: view.kind, direction }}
        >
            {view.progress && (
                <div className="nr-xfer">
                    <NearProgress pct={view.progress.pct} state={view.progress.state} label={nt('e.a11y.progress', { pct: view.progress.pct })} />
                </div>
            )}
        </ClBanner>
    );
};
