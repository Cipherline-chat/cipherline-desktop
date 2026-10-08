/**
 * GamingVideoGuard — the in-call half of "Prioritize call video while gaming".
 * Mounted once per call inside <LiveKitRoom> (CallPane). Renders nothing
 * except, at most once per call, the freeze offer card (portalled to <body>,
 * because CallPane's own subtree is display:none).
 *
 * It does three things:
 *
 *   1. Tells main a call is running (`call:set-media-active`), so main can
 *      raise process priority while the mode is on (Windows) and restore it
 *      when the call ends — unmount sends false; a renderer reload/crash is
 *      handled in main.
 *   2. While the mode is on, sets the outgoing camera's degradation
 *      preference to 'maintain-framerate' (utils/gamingVideoMode.ts), and puts
 *      it back when the mode goes off or the call ends.
 *   3. While the mode is OFF, an offer is still allowed, and Cipherline is in
 *      the background, samples per-track WebRTC stats once a second and runs
 *      them through utils/videoFreezeDetector.ts. A real freeze queues a
 *      one-time offer (utils/gamingVideoOffer.ts decides when it may show).
 *      In the foreground nothing is sampled at all.
 *
 * Nothing here logs, stores or sends anything about who is in the call: stream
 * keys are track sids used only as in-memory map keys, there are no network
 * calls, and the only persisted state is the offer's snooze/never flags.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, Track, type LocalTrackPublication, type LocalVideoTrack, type Room } from 'livekit-client';
import { Gamepad2, X } from 'lucide-react';
import { ClButton } from '../cl';
import { useToast } from '../../contexts/ToastContext';
import {
    useGamingVideoMode, loadGamingVideoMode, setGamingVideoMode, applyCameraDegradation, getGamingVideoSnapshot,
} from '../../utils/gamingVideoMode';
import { VideoFreezeDetector, SAMPLE_INTERVAL_MS } from '../../utils/videoFreezeDetector';
import { sampleCallVideo } from '../../utils/callVideoSampling';
import {
    canOffer, answerOffer, readOfferState, writeOfferState, offerCopy, type OfferAnswer,
} from '../../utils/gamingVideoOffer';
import {
    acquireCallOfferSlot, releaseCallOfferSlot, CALL_OFFER_ENTER_CLASS,
} from '../../utils/performanceOffer';
import { useCallOfferAnchor } from '../../hooks/useCallOfferAnchor';
import { openFreezeOfferReport } from '../../utils/diagnostics/reportRequest';
import { logCallEvent } from '../../utils/callEventLog';

/** This offer's id on the shared in-call offer slot (utils/performanceOffer.ts):
 *  at most ONE in-call offer card is up at a time, so the freeze offer never
 *  stacks on top of the "PC is struggling" load offer. */
const OFFER_SLOT_ID = 'gaming';

/** "Not looking at Cipherline": blurred, minimised, hidden to tray, or document hidden. */
function useBackgrounded(): boolean {
    const [bg, setBg] = useState(() => {
        try { return document.hidden || !document.hasFocus(); } catch { return false; }
    });
    useEffect(() => {
        const api = window.electronAPI;
        const toBg = () => setBg(true);
        const toFg = () => setBg(false);
        // Same rule as utils/idleMotion.ts: with the bridge, only main's real
        // OS focus push ends a minimise/hide (a hidden window's page can still
        // get DOM focus); without it, DOM focus is all there is.
        const domFocus = api?.onWindowFocus ? () => { /* wait for main */ } : toFg;
        const onVis = () => { if (document.hidden) setBg(true); };
        window.addEventListener('blur', toBg);
        window.addEventListener('focus', domFocus);
        document.addEventListener('visibilitychange', onVis);
        const offs = [api?.onWindowFocus?.(toFg), api?.onWindowMinimize?.(toBg), api?.onWindowHide?.(toBg)];
        return () => {
            window.removeEventListener('blur', toBg);
            window.removeEventListener('focus', domFocus);
            document.removeEventListener('visibilitychange', onVis);
            for (const off of offs) { try { off?.(); } catch { /* already gone */ } }
        };
    }, []);
    return bg;
}

/** Whether the game detector has named a running game (copy only). No scan is started here. */
function useGameKnown(): boolean {
    const [known, setKnown] = useState(false);
    useEffect(() => {
        const api = window.electronAPI;
        const offA = api?.onGameDetected?.(() => setKnown(true));
        const offB = api?.onGameStopped?.(() => setKnown(false));
        return () => { try { offA?.(); offB?.(); } catch { /* gone */ } };
    }, []);
    return known;
}

export const GamingVideoGuard: React.FC = () => {
    const room = useRoomContext();
    const mode = useGamingVideoMode();
    const backgrounded = useBackgrounded();
    const gameKnown = useGameKnown();
    const toast = useToast();
    // Which call (Room) the offer is open for / was shown in. Keyed by Room so
    // a new call starts clean without a reset effect: "once per call".
    const [offerRoom, setOfferRoom] = useState<Room | null>(null);
    const offerOpen = !!room && offerRoom === room;
    const [saving, setSaving] = useState(false);
    const shownForRoomRef = useRef<Room | null>(null);
    const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

    // 1. Call running → main (process priority while the mode is on).
    useEffect(() => {
        if (!isElectron) return;
        void loadGamingVideoMode();
        const api = window.electronAPI;
        api?.setCallMediaActive?.(true)?.catch?.(() => {});
        return () => { api?.setCallMediaActive?.(false)?.catch?.(() => {}); };
    }, [isElectron]);

    // 2. Outgoing camera degradation preference while the mode is on.
    useEffect(() => {
        if (!room || !mode.enabled) return;
        const touched = new Set<LocalVideoTrack>();
        const applyTo = (track: LocalVideoTrack | undefined) => {
            if (!track || track.kind !== Track.Kind.Video) return;
            applyCameraDegradation(track, true);
            touched.add(track);
        };
        applyTo(room.localParticipant.getTrackPublication(Track.Source.Camera)?.track as LocalVideoTrack | undefined);
        // Apply to the PUBLISHED track itself, not getTrackPublication(Camera):
        // the webcam make-before-break republish (cameraPublish.ts — 1:1 single
        // layer, H.265 switch, VP8 fallback) publishes the new camera while the
        // old one is still up for REPUBLISH_HOLD_MS, and getTrackPublication
        // returns the FIRST match — the old one — so the new track would keep
        // the plan's 'balanced' after the old one is unpublished.
        const onPublished = (pub: LocalTrackPublication) => {
            if (pub.source === Track.Source.Camera) applyTo(pub.track as LocalVideoTrack | undefined);
        };
        room.on(RoomEvent.LocalTrackPublished, onPublished);
        return () => {
            room.off(RoomEvent.LocalTrackPublished, onPublished);
            for (const t of touched) applyCameraDegradation(t, false);
        };
    }, [room, mode.enabled]);

    // 3. Freeze sampling — only while it could lead to an offer.
    const decryptErrorRef = useRef(false);
    useEffect(() => {
        if (!room) return;
        const onErr = () => { decryptErrorRef.current = true; };
        room.on(RoomEvent.EncryptionError, onErr);
        return () => { room.off(RoomEvent.EncryptionError, onErr); };
    }, [room]);

    const samplingWanted = isElectron && !!room && mode.available && !mode.enabled && backgrounded && !offerOpen;
    useEffect(() => {
        if (!samplingWanted || !room) return;
        if (shownForRoomRef.current === room) return;
        if (!canOffer({ state: readOfferState(), now: Date.now(), modeOn: false, shownThisCall: false })) return;
        const detector = new VideoFreezeDetector();
        let inFlight = false;
        let stopped = false;
        // A freeze was seen but the offer could not show yet (slot busy).
        let pending = false;
        const tick = async () => {
            if (inFlight || stopped) return;
            inFlight = true;
            try {
                const samples = await sampleCallVideo(room);
                if (stopped) return;
                const decryptError = decryptErrorRef.current;
                decryptErrorRef.current = false;
                // This effect only runs while useBackgrounded() says so (it is
                // torn down — and the detector with it — the moment the window
                // comes back), so every tick it sees is a background tick.
                // Not re-derived from document.hasFocus(): a minimised window's
                // page can keep reporting focus (see utils/idleMotion.ts).
                const events = detector.observe(samples, { at: performance.now(), backgrounded: true, decryptError });
                if (events.length > 0) pending = true;
                if (!pending || shownForRoomRef.current === room) return;
                const snap = getGamingVideoSnapshot();
                if (!canOffer({ state: readOfferState(), now: Date.now(), modeOn: snap.enabled, shownThisCall: false })) return;
                // Another in-call offer (the load offer) is up: keep the freeze
                // pending and try again next tick.
                if (!acquireCallOfferSlot(OFFER_SLOT_ID)) return;
                pending = false;
                shownForRoomRef.current = room;
                setOfferRoom(room);
                logCallEvent('offer_shown', { offer: 'gaming' });
            } catch { /* a failed tick is just a skipped sample */ } finally {
                inFlight = false;
            }
        };
        const iv = setInterval(() => { void tick(); }, SAMPLE_INTERVAL_MS);
        return () => { stopped = true; clearInterval(iv); detector.reset(); };
    }, [samplingWanted, room]);

    // The card is gone (answered, call ended, or the mode came on another
    // way): give the shared offer slot back.
    useEffect(() => {
        if (!offerOpen || mode.enabled) releaseCallOfferSlot(OFFER_SLOT_ID);
    }, [offerOpen, mode.enabled]);
    useEffect(() => () => releaseCallOfferSlot(OFFER_SLOT_ID), []);

    /** "Report this freeze": close the card for this call (no snooze written —
     *  the user didn't decline) and open the issue reporter on Performance. */
    const reportFreeze = useCallback(() => {
        logCallEvent('offer_answer', { offer: 'gaming', answer: 'report' });
        setOfferRoom(null);
        releaseCallOfferSlot(OFFER_SLOT_ID);
        openFreezeOfferReport();
    }, []);

    const answer = useCallback(async (a: OfferAnswer) => {
        writeOfferState(answerOffer(readOfferState(), a, Date.now()));
        logCallEvent('offer_answer', { offer: 'gaming', answer: a });
        if (a !== 'turn-on') { setOfferRoom(null); return; }
        setSaving(true);
        try {
            const snap = await setGamingVideoMode(true);
            setOfferRoom(null);
            toast.push({
                kind: 'success',
                title: 'Prioritize call video while gaming is on',
                message: snap.restartPending
                    ? 'It’s working for this call now. Restart Cipherline after the call for the full effect.'
                    : 'It’s working for this call now.',
                durationMs: 8000,
            });
        } catch {
            toast.push({ kind: 'error', message: 'Couldn’t turn it on. You can find it in Settings → Voice & Video.' });
        } finally {
            setSaving(false);
        }
    }, [toast]);

    const anchor = useCallOfferAnchor(offerOpen);
    if (!offerOpen || mode.enabled || typeof document === 'undefined') return null;
    const copy = offerCopy(gameKnown);
    return ReactDOM.createPortal(
        <div className={anchor.className} style={anchor.style}>
            <div
                role="status"
                aria-live="polite"
                aria-label={copy.title}
                className={`pointer-events-auto relative flex items-start gap-3 pl-4 pr-2 py-3 bg-cl-deep border border-white/[0.08] ring-1 ring-cl-lume/30 rounded-xl shadow-2xl overflow-hidden ${CALL_OFFER_ENTER_CLASS}`}
            >
                <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-cl-lume" aria-hidden="true" />
                <span className="shrink-0 mt-0.5 w-8 h-8 rounded-lg grid place-items-center text-cl-lume bg-cl-lume/10" aria-hidden="true">
                    <Gamepad2 size={17} />
                </span>
                <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-white leading-tight m-0">{copy.title}</p>
                    <p className="text-[12px] text-cl-muted leading-snug m-0 mt-0.5 break-words">{copy.body}</p>
                    <div className="flex items-center gap-2 mt-2.5">
                        <ClButton size="sm" variant="primary" loading={saving} disabled={saving} onClick={() => { void answer('turn-on'); }}>
                            {copy.accept}
                        </ClButton>
                        <ClButton size="sm" variant="ghost" disabled={saving} onClick={() => { void answer('not-now'); }}>
                            {copy.decline}
                        </ClButton>
                    </div>
                    <div className="flex items-center gap-3 mt-2">
                        <button
                            type="button"
                            disabled={saving}
                            onClick={() => { void answer('never'); }}
                            className="p-0 bg-transparent border-0 text-[11px] text-cl-faint hover:text-cl-muted underline-offset-2 hover:underline cursor-pointer"
                        >
                            {copy.never}
                        </button>
                        <button
                            type="button"
                            disabled={saving}
                            onClick={reportFreeze}
                            className="p-0 bg-transparent border-0 text-[11px] text-cl-faint hover:text-cl-muted underline-offset-2 hover:underline cursor-pointer"
                        >
                            Report this freeze
                        </button>
                    </div>
                </div>
                <ClButton icon size="sm" variant="ghost" disabled={saving} onClick={() => { void answer('not-now'); }} tooltip="Dismiss">
                    <X size={14} />
                </ClButton>
            </div>
        </div>,
        document.body,
    );
};

export default GamingVideoGuard;
