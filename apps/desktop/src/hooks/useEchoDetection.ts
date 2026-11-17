/**
 * Mid-call echo detection, wired into a live call (see utils/echoDetector.ts for
 * the method, utils/echoTap.ts for the audio taps, utils/echoPrompt.ts for when
 * a prompt may show).
 *
 * Runs only while echo cancellation is OFF (nothing to detect otherwise) and
 * only until the user is asked once per call; while it runs it costs one tiny
 * worklet and a 2-second correlation (see echoDetector.ts). Nothing is
 * uploaded: the result is at most one memory-only `echo_detected` call event
 * (correlation, delay, speech seconds; no audio, no names).
 *
 * When echo cancellation is ON this instead logs, every 30 s, Chromium's own
 * echo return loss figures from the mic's media-source stats (`aec_stats`), which
 * is what makes AEC tuning from a bug report possible.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Track, type Room } from 'livekit-client';
import { EchoDetector, type EchoDetection } from '../utils/echoDetector';
import { EchoTap } from '../utils/echoTap';
import { getAudibleFarEndTracks } from './useParticipantAudio';
import { logCallEvent } from '../utils/callEventLog';
import {
    afterDismiss, afterNever, loadEchoPromptStore, mayPromptForEcho, offerDontAskAgain, saveEchoPromptStore,
    type EchoPromptStore,
} from '../utils/echoPrompt';

/** Rooms where the user already dismissed the prompt: survives this component remounting mid-call. */
const dismissedRooms = new WeakSet<object>();

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

interface LocalMicLike {
    _mediaStreamTrack?: MediaStreamTrack;
    mediaStreamTrack?: MediaStreamTrack;
    sender?: RTCRtpSender;
}

function localMic(room: Room): LocalMicLike | null {
    const t = room.localParticipant?.getTrackPublication(Track.Source.Microphone)?.track;
    return (t as unknown as LocalMicLike | undefined) ?? null;
}

export interface UseEchoDetectionArgs {
    room: Room | null | undefined;
    /** Effective echo cancellation (voice.settings.echoCancellation). */
    aecOn: boolean;
    /** Mic open: not muted, and in push-to-talk the key is held. */
    micOpen: boolean;
    deafened: boolean;
    /** Switch echo cancellation on, as a user choice. */
    turnOnEchoCancellation: () => void;
}

export function useEchoDetection({ room, aecOn, micOpen, deafened, turnOnEchoCancellation }: UseEchoDetectionArgs) {
    const [prompt, setPrompt] = useState<{ offerNever: boolean } | null>(null);
    const [store, setStore] = useState<EchoPromptStore>(loadEchoPromptStore);
    const storeRef = useRef(store);
    useEffect(() => { storeRef.current = store; }, [store]);
    // Latest values for the frame callback / timers, which outlive any one render.
    const live = useRef({ aecOn, micOpen, deafened });
    useEffect(() => { live.current = { aecOn, micOpen, deafened }; }, [aecOn, micOpen, deafened]);
    const turnOnRef = useRef(turnOnEchoCancellation);
    useEffect(() => { turnOnRef.current = turnOnEchoCancellation; }, [turnOnEchoCancellation]);
    const [dismissTick, setDismissTick] = useState(0); // re-evaluate `allowed` after a dismissal
    void dismissTick;

    // Whether the tap should exist at all. The mic / deafen state is NOT part of this: it gates the
    // FRAMES (below), so muting for a moment does not tear the detector down and forget its evidence.
    const allowed = !!room && mayPromptForEcho({
        aecOn, micOpen: true, deafened: false,
        dismissedThisCall: dismissedRooms.has(room), store,
    });

    useEffect(() => {
        if (!room || !allowed) return;
        const detector = new EchoDetector();
        const tap = new EchoTap((far, near) => {
            const l = live.current;
            const valid = !l.aecOn && l.micOpen && !l.deafened;
            const found: EchoDetection | null = detector.push(far, near, valid);
            if (!found) return;
            // Re-check at the moment of showing: the user may have muted or turned it on meanwhile.
            const l2 = live.current;
            if (!mayPromptForEcho({ aecOn: l2.aecOn, micOpen: l2.micOpen, deafened: l2.deafened, dismissedThisCall: dismissedRooms.has(room), store: storeRef.current })) {
                detector.reset();
                return;
            }
            logCallEvent('echo_detected', {
                corr: round(found.corr, 2), delay_ms: found.delayMs, aec_on: false,
                speech_s: Math.round(found.speechSec), windows: found.windows,
            });
            logCallEvent('echo_prompt', { action: 'shown' });
            setPrompt({ offerNever: offerDontAskAgain(storeRef.current) });
        });
        let stopped = false;
        void tap.start();
        // Far tracks come and go as people join, leave, mute; the near track is replaced on every mic restart.
        const reconcile = () => {
            if (stopped) return;
            tap.setFarTracks(getAudibleFarEndTracks());
            const mic = localMic(room);
            tap.setNearTrack(mic?._mediaStreamTrack ?? null);
        };
        const timer = setInterval(reconcile, 1000);
        reconcile();
        return () => {
            stopped = true;
            clearInterval(timer);
            tap.dispose();
            setPrompt(null);
        };
    }, [room, allowed]);

    // Chromium's own echo figures while AEC runs (cheap: one getStats on the mic sender every 30 s).
    useEffect(() => {
        if (!room || !aecOn) return;
        let last = '';
        const poll = async () => {
            try {
                const sender = localMic(room)?.sender;
                if (!sender) return;
                const report = await sender.getStats();
                report.forEach((s: Record<string, unknown>) => {
                    if (s.type !== 'media-source' || s.kind !== 'audio') return;
                    const erl = s.echoReturnLoss, erle = s.echoReturnLossEnhancement;
                    if (typeof erl !== 'number' && typeof erle !== 'number') return;
                    const d: Record<string, number> = {};
                    if (typeof erl === 'number' && Number.isFinite(erl)) d.erl_db = round(erl, 1);
                    if (typeof erle === 'number' && Number.isFinite(erle)) d.erle_db = round(erle, 1);
                    const key = JSON.stringify(d);
                    if (key === last || !Object.keys(d).length) return;
                    last = key;
                    logCallEvent('aec_stats', d);
                });
            } catch { /* stats are best-effort */ }
        };
        const t = setInterval(() => { void poll(); }, 30_000);
        const first = setTimeout(() => { void poll(); }, 8_000);
        return () => { clearInterval(t); clearTimeout(first); };
    }, [room, aecOn]);

    const accept = useCallback(() => {
        logCallEvent('echo_prompt', { action: 'turn_on' });
        setPrompt(null);
        turnOnRef.current();
    }, []);

    const dismiss = useCallback(() => {
        logCallEvent('echo_prompt', { action: 'dismiss' });
        if (room) dismissedRooms.add(room);
        const next = afterDismiss(storeRef.current);
        saveEchoPromptStore(next);
        setStore(next);
        setPrompt(null);
        setDismissTick(n => n + 1);
    }, [room]);

    const neverAskAgain = useCallback(() => {
        logCallEvent('echo_prompt', { action: 'never' });
        if (room) dismissedRooms.add(room);
        const next = afterNever(afterDismiss(storeRef.current));
        saveEchoPromptStore(next);
        setStore(next);
        setPrompt(null);
        setDismissTick(n => n + 1);
    }, [room]);

    // Echo cancellation came on by any route: the prompt has nothing left to say.
    return { prompt: aecOn ? null : prompt, accept, dismiss, neverAskAgain };
}
