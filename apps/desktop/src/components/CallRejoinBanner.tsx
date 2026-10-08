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
import { PhoneCall, X } from 'lucide-react';
import { ClButton } from './ClButton';
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
        <div className="w-full shrink-0 py-2" role="region" aria-label="Rejoin call">
            <div
                role="status"
                className="w-full px-4 py-2 rounded-xl flex items-center gap-2.5 text-[13px] animate-in fade-in slide-in-from-top-2 duration-200"
                // Same green wash as the in-chat "Active Call" card, so the two read as one family.
                style={{ background: 'linear-gradient(135deg, rgba(74,222,128,0.10), rgba(74,222,128,0.04))', border: '1px solid rgba(74,222,128,0.22)', color: 'var(--cl-text)' }}
            >
                <PhoneCall size={15} className="shrink-0" style={{ color: 'var(--cl-ok)' }} />
                <div className="flex-1 min-w-0 truncate">
                    <span className="font-semibold">Cipherline restarted while you were in {describeRejoinTarget(offer)}.</span>{' '}
                    <span className="opacity-80">It&apos;s still going — rejoin?</span>
                </div>
                <ClButton type="button" variant="ok" size="sm" loading={busy} onClick={onRejoin}>
                    Rejoin
                </ClButton>
                <ClButton type="button" icon variant="ghost" size="sm" tooltip="Dismiss" disabled={busy} onClick={onDismiss}>
                    <X size={13} />
                </ClButton>
            </div>
        </div>
    );
};

export default CallRejoinBanner;
