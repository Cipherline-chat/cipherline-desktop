/**
 * AnnotationRequestsDock - the streamer's Allow / Decline, wherever they are
 * looking.
 *
 * The per-tile menu (AnnotationRequestsMenu) only exists on the owner's OWN
 * focused or fullscreen tile - and a person sharing their screen is usually
 * looking at anything but their own share. So a request also surfaces here:
 * a small dock above the call controls, portaled to <body> so it sits above
 * the fullscreen overlay too, in every layout - strip, grid and fullscreen
 * alike. It renders nothing until someone is asking, and goes away when the
 * last request is answered or lapses (REQUEST_TTL_MS).
 *
 * Being present is not the same as being NOTICED, though, and a presenter is
 * by definition looking at what they are presenting. So arrival also gets a
 * sound (useAnnotationTransport -> playSound('annotation_request')), the dock
 * announces itself to assistive tech, it keeps a slow ring going for as long
 * as anyone is waiting rather than flashing once, and more than one waiting
 * person gets a count above the rows.
 */
import React from 'react';
import ReactDOM from 'react-dom';
import { PenLine, Check, X } from 'lucide-react';
import { useMaybeRoomContext } from '@livekit/components-react';
import { annotationStore, useAnnotationStore, isScreenShareTrack } from '../../utils/annotationStore';
import { ownerOf } from '../../utils/annotationTransport';

export interface AnnotationRequestsDockProps {
    /** The local participant's identity: only requests on OUR tracks show. */
    me: string;
}

export const AnnotationRequestsDock: React.FC<AnnotationRequestsDockProps> = ({ me }) => {
    const requests = useAnnotationStore(s => s.requests);
    const room = useMaybeRoomContext();
    const mine = React.useMemo(
        () => Object.entries(requests)
            .filter(([track, ids]) => me && ownerOf(track) === me && ids.length > 0)
            .flatMap(([track, ids]) => ids.map(id => ({ track, id }))),
        [requests, me],
    );
    if (mine.length === 0 || typeof document === 'undefined') return null;

    const label = (id: string) => room?.getParticipantByIdentity(id)?.name ?? id;
    // Read the SOURCE half of the key, not a substring of the whole thing —
    // `track.includes('screen')` also fired on a display name like "screenie".
    const what = (track: string) => (isScreenShareTrack(track) ? 'your screen' : 'your video');

    return ReactDOM.createPortal(
        <div
            role="region"
            aria-label="Requests to draw on your video"
            // Announced as it arrives: the whole point is that the owner is
            // looking at what they are presenting, not at this dock.
            aria-live="polite"
            // The dock parks just above the call controls. Where those controls
            // ARE depends on the surface: in the docked call they sit at the
            // bottom of the chat pane (96px clears them), but in fullscreen the
            // console floats above a participant strip whose height varies with
            // the roster. FullscreenOverlay publishes that geometry as
            // `--cl-call-dock-bottom` on <html> for the lifetime of the
            // fullscreen session and clears it on exit, so the fallback here is
            // the docked-call number. Deliberately NOT hidden by the overlay's
            // idle-chrome fade: an unanswered request is the one thing that
            // must not quietly disappear while the presenter is presenting.
            className="fixed left-1/2 -translate-x-1/2 z-[100000] flex flex-col items-center gap-1.5 pointer-events-auto"
            style={{ bottom: 'var(--cl-call-dock-bottom, 96px)' }}
        >
            {mine.length > 1 && (
                <div className="rounded-full bg-cl-lume/20 border border-cl-lume/40 px-3 py-1 text-[11.5px] font-semibold text-cl-lume">
                    {mine.length} people want to draw
                </div>
            )}
            {mine.map(({ track, id }) => (
                <div
                    key={`${track}\n${id}`}
                    className="annot-req-row flex items-center gap-3 rounded-xl bg-cl-deep/95 backdrop-blur-md border border-cl-lume/40 px-3.5 py-2.5 text-[13px] text-cl-text"
                >
                    <PenLine size={16} className="text-cl-lume shrink-0" aria-hidden />
                    <span className="max-w-[260px] truncate">
                        <b className="font-semibold">{label(id)}</b> wants to draw on {what(track)}
                    </span>
                    <button
                        type="button"
                        onClick={() => annotationStore.grant(track, id)}
                        className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[12px] font-semibold bg-cl-lume/15 text-cl-lume hover:bg-cl-lume/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-cl-lume/70"
                    >
                        <Check size={13} aria-hidden /> Allow
                    </button>
                    <button
                        type="button"
                        title={`Decline — ${label(id)} cannot ask again for a minute`}
                        aria-label={`Decline ${label(id)}`}
                        onClick={() => annotationStore.denyRequest(track, id)}
                        className="inline-flex items-center justify-center rounded-lg w-7 h-7 text-white/70 hover:text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-cl-lume/70"
                    >
                        <X size={14} aria-hidden />
                    </button>
                </div>
            ))}
        </div>,
        document.body,
    );
};
