/**
 * CallRejoinBanner — the "Rejoin call?" prompt shown after the renderer
 * restarted while the user was in a call (crash recovery, forced reload, or a
 * quick quit-and-relaunch). See callRejoinPolicy.ts for when it appears.
 *
 * Deliberately a prompt, not an auto-rejoin: the user may have crashed
 * precisely because something was wrong, may have wanted out of the call, and
 * a silent re-entry would open the mic in a room they believed they had left.
 * Mounted in Dashboard's app shell next to the other banners so it is visible
 * on every tab without covering the call/chat panes.
 */
import React from 'react';
import { PhoneCall } from 'lucide-react';
import { ClBanner } from './ClBanner';
import { describeRejoinTarget, type CallRejoinDescriptor } from '../utils/callRejoinPolicy';

interface Props {
    offer: CallRejoinDescriptor | null;
    busy: boolean;
    onRejoin: () => void;
    onDismiss: () => void;
}

export const CallRejoinBanner: React.FC<Props> = ({ offer, busy, onRejoin, onDismiss }) => {
    if (!offer) return null;
    return (
        <ClBanner
            id="call-rejoin"
            tone="success"
            priority={88}
            ariaLabel="Rejoin call"
            icon={<PhoneCall size={15} />}
            title={`Cipherline restarted while you were in ${describeRejoinTarget(offer)}.`}
            description="It's still going — rejoin?"
            actions={[{ key: 'rejoin', label: 'Rejoin', variant: 'ok', loading: busy, onClick: onRejoin }]}
            dismissDisabled={busy}
            onDismiss={onDismiss}
        />
    );
};

export default CallRejoinBanner;
