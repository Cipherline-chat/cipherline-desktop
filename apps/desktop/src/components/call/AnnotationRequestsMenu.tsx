/**
 * AnnotationRequestsMenu - the streamer's side of Phase 3, in the top-right
 * cluster of their OWN focused / fullscreen tile: who is asking to draw, who
 * may already, and the switches to change that. Every grant is per person -
 * there is no "let everyone draw" here, by decision.
 *
 * Renders nothing until there is something to show (a pending request or an
 * existing grant), so the cluster stays as small as the toolbar alone the
 * rest of the time. A pending request also pulses the trigger so it is
 * noticed without a toast stealing the frame.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Users, Check, X, UserMinus } from 'lucide-react';
import { useMaybeRoomContext } from '@livekit/components-react';
import { annotationStore, useAnnotationStore, selectTrackGrants, selectTrackRequests } from '../../utils/annotationStore';
import { useEscape } from '../../hooks/useEscape';

export interface AnnotationRequestsMenuProps {
    trackKey: string;
    /** Display-name overrides by identity. Without one, the LiveKit
     *  participant's name is used, then the raw identity. */
    names?: Record<string, string>;
}

const rowBtn = 'inline-flex items-center justify-center rounded-md w-6 h-6 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cl-lume/70';

export const AnnotationRequestsMenu: React.FC<AnnotationRequestsMenuProps> = ({ trackKey, names }) => {
    const requests = useAnnotationStore(selectTrackRequests(trackKey));
    const grants = useAnnotationStore(selectTrackGrants(trackKey));
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    // Provider-safe: undefined outside <LiveKitRoom>, in which case we fall
    // back to identities rather than throwing.
    const room = useMaybeRoomContext();

    // Close on outside click / Escape (Escape via the shared stack).
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
        document.addEventListener('mousedown', onDown);
        return () => { document.removeEventListener('mousedown', onDown); };
    }, [open]);
    useEscape(() => setOpen(false), open);

    if (requests.length === 0 && grants.length === 0) return null;
    const label = (id: string) => names?.[id] ?? room?.getParticipantByIdentity(id)?.name ?? id;
    const stop = (e: React.SyntheticEvent) => e.stopPropagation();

    return (
        <div ref={rootRef} className="relative pointer-events-auto" onClick={stop} onDoubleClick={stop} onPointerDown={stop}>
            <button
                type="button"
                title={requests.length ? `${requests.length} asking to draw` : `${grants.length} can draw`}
                aria-label={requests.length ? `${requests.length} people asking to draw` : `${grants.length} people can draw`}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(o => !o)}
                className={`relative inline-flex items-center gap-1 rounded-lg px-2 py-1 bg-black/35 backdrop-blur-sm text-[11px] font-medium text-white/85 hover:text-white hover:bg-black/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-cl-lume/70 ${requests.length ? 'ss-start-flash' : ''}`}
            >
                <Users size={12} />
                <span>{requests.length ? requests.length : grants.length}</span>
                {requests.length > 0 && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-cl-lume" aria-hidden="true" />}
            </button>
            {open && (
                <div
                    role="menu"
                    aria-label="Annotation access"
                    className="absolute right-0 mt-1 min-w-[220px] rounded-xl bg-cl-deep/95 backdrop-blur-md border border-white/10 shadow-2xl p-1.5 text-[12px] text-cl-text z-30"
                >
                    {requests.length > 0 && (
                        <div className="px-2 pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-cl-faint">Asking to draw</div>
                    )}
                    {requests.map(id => (
                        <div key={`r-${id}`} role="menuitem" className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-white/5">
                            <span className="flex-1 truncate">{label(id)}</span>
                            <button type="button" title="Allow" aria-label={`Allow ${label(id)} to draw`} onClick={() => annotationStore.grant(trackKey, id)} className={`${rowBtn} text-cl-lume hover:bg-cl-lume/15`}><Check size={14} /></button>
                            <button type="button" title="Decline — they cannot ask again for a minute" aria-label={`Decline ${label(id)}`} onClick={() => annotationStore.denyRequest(trackKey, id)} className={`${rowBtn} text-white/70 hover:bg-white/10`}><X size={14} /></button>
                        </div>
                    ))}
                    {grants.length > 0 && (
                        <div className="px-2 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-cl-faint">Can draw</div>
                    )}
                    {grants.map(id => (
                        <div key={`g-${id}`} role="menuitem" className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-white/5">
                            <span className="flex-1 truncate">{label(id)}</span>
                            <button type="button" title="Revoke" aria-label={`Stop ${label(id)} drawing`} onClick={() => annotationStore.revoke(trackKey, id)} className={`${rowBtn} text-cl-flash hover:bg-cl-flash/15`}><UserMinus size={14} /></button>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};
