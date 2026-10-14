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
 *
 * It can also be answered from the keyboard, without focusing Cipherline
 * (utils/annotationRequestKeybind). The rows here and the keybind's target come
 * from the SAME selector (visibleAnnotationRequests), oldest first, and the
 * first row carries the key hint - so the row the hint is on is exactly the
 * one the key will answer, and the key can never answer anything that is not
 * on screen here. This component also publishes the context that selector
 * needs (who we are, who is in the room) for as long as it is mounted.
 */
import React from 'react';
import ReactDOM from 'react-dom';
import { PenLine, Check, X } from 'lucide-react';
import { useMaybeRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import { useAnnotationStore, isScreenShareTrack, clock } from '../../utils/annotationStore';
import {
    visibleAnnotationRequests, setAnnotationKeybindContext, notifyAnnotationKeybindContextChanged,
    allowAnnotationRequest, declineAnnotationRequest, useAnnotationKeyHints,
    type AnnotationKeybindContext,
} from '../../utils/annotationRequestKeybind';

export interface AnnotationRequestsDockProps {
    /** The local participant's identity: only requests on OUR tracks show. */
    me: string;
}

export const AnnotationRequestsDock: React.FC<AnnotationRequestsDockProps> = ({ me }) => {
    const requests = useAnnotationStore(s => s.requests);
    const requestedAt = useAnnotationStore(s => s.requestedAt);
    const room = useMaybeRoomContext();
    const hints = useAnnotationKeyHints();

    // Who is in the call. Not reactive on its own (the Room is mutable), so
    // roster changes bump `rosterTick` to re-render, and tell the keybind's
    // arming gate to re-evaluate too.
    const [rosterTick, bumpRoster] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
        if (!room) return;
        const onRoster = () => { bumpRoster(); notifyAnnotationKeybindContextChanged(); };
        room.on(RoomEvent.ParticipantConnected, onRoster);
        room.on(RoomEvent.ParticipantDisconnected, onRoster);
        room.on(RoomEvent.Reconnected, onRoster);
        return () => {
            room.off(RoomEvent.ParticipantConnected, onRoster);
            room.off(RoomEvent.ParticipantDisconnected, onRoster);
            room.off(RoomEvent.Reconnected, onRoster);
        };
    }, [room]);

    const ctx = React.useMemo<AnnotationKeybindContext>(() => ({
        me,
        // A REMOTE participant only: our own identity is never a requester.
        isPresent: (id: string) => !!room && id !== room.localParticipant.identity && !!room.remoteParticipants.get(id),
    }), [me, room]);
    React.useEffect(() => setAnnotationKeybindContext(ctx), [ctx]);

    const mine = React.useMemo(
        () => visibleAnnotationRequests({ requests, requestedAt }, ctx, clock.now()),
        // rosterTick: re-filter when someone joins or leaves.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [requests, requestedAt, ctx, rosterTick],
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
            {mine.map(({ track, id }, i) => (
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
                        onClick={() => allowAnnotationRequest(track, id)}
                        // The key answers the OLDEST request, which is this
                        // first row - so only this row carries the hint.
                        className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[12px] font-semibold bg-cl-lume/15 text-cl-lume hover:bg-cl-lume/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-cl-lume/70"
                    >
                        <Check size={13} aria-hidden /> Allow
                        {i === 0 && hints.approve && (
                            <span className="ml-0.5 font-normal text-cl-lume/70">({hints.approve})</span>
                        )}
                    </button>
                    <button
                        type="button"
                        title={`Decline — ${label(id)} cannot ask again for a minute${i === 0 && hints.decline ? ` (${hints.decline})` : ''}`}
                        aria-label={`Decline ${label(id)}`}
                        onClick={() => declineAnnotationRequest(track, id)}
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
