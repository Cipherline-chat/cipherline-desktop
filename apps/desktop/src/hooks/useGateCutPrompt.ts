/**
 * "Your voice gate may be cutting you off" in a live call: listens to the gate worklet's once-a-second voice-vs-gate
 * counts (utils/gateCut.ts, published by the voice processor), decides over a window of real talking, and shows the
 * prompt once at most (rules: utils/gateCutPrompt.ts). Detection only: the threshold changes only when the user clicks
 * "Lower to ... dB", through the same setter as the Settings slider. Nothing is uploaded: at most a memory-only
 * `gate_cut` call event (shares and levels, never audio) and `gate_cut_prompt` answers.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Room } from 'livekit-client';
import { logCallEvent } from '../utils/callEventLog';
import { GateCutWatcher, subscribeGateCutSeconds, type GateCutDetection } from '../utils/gateCut';
import {
    afterDismiss, afterNever, loadGateCutPromptStore, mayPromptForGateCut, offerDontAskAgain, saveGateCutPromptStore,
    type GateCutPromptStore,
} from '../utils/gateCutPrompt';

/** Calls in which the prompt was shown or dismissed (survives this component remounting mid-call). */
const shownRooms = new WeakSet<object>();
/** When each call was first seen (the "first seconds of a call" rule). */
const callStart = new WeakMap<object, number>();

const r1 = (v: number) => Math.round(v * 10) / 10;

export interface UseGateCutPromptArgs {
    room: Room | null | undefined;
    gateOn: boolean;
    thresholdDb: number;
    /** Mic open: not muted, and in push-to-talk the key is held. */
    micOpen: boolean;
    deafened: boolean;
    /** The Settings slider's setter (voice.setVoiceGateThreshold). */
    setThreshold: (db: number) => void;
    /** voice.setVoiceGate. */
    setGate: (on: boolean) => void;
    /** For tests: the clock. */
    now?: () => number;
}

export interface GateCutPrompt { detection: GateCutDetection; offerNever: boolean }

export function useGateCutPrompt({ room, gateOn, thresholdDb, micOpen, deafened, setThreshold, setGate, now = Date.now }: UseGateCutPromptArgs) {
    const [prompt, setPrompt] = useState<GateCutPrompt | null>(null);
    const storeRef = useRef<GateCutPromptStore>(loadGateCutPromptStore());
    const watcher = useRef(new GateCutWatcher());
    const live = useRef({ gateOn, thresholdDb, micOpen, deafened });
    useEffect(() => { live.current = { gateOn, thresholdDb, micOpen, deafened }; }, [gateOn, thresholdDb, micOpen, deafened]);
    const setters = useRef({ setThreshold, setGate });
    useEffect(() => { setters.current = { setThreshold, setGate }; }, [setThreshold, setGate]);
    const nowRef = useRef(now);
    nowRef.current = now;

    // New evidence is needed whenever the gate itself changes.
    useEffect(() => { watcher.current.reset(); }, [gateOn, thresholdDb]);

    useEffect(() => {
        if (!room) return;
        if (!callStart.has(room)) callStart.set(room, nowRef.current());
        return subscribeGateCutSeconds((sec) => {
            const l = live.current;
            // Only seconds in which the user could be heard count as evidence.
            if (!l.gateOn || !l.micOpen || l.deafened) return;
            watcher.current.push(sec);
            const ctx = {
                gateOn: l.gateOn, micOpen: l.micOpen, deafened: l.deafened,
                callSec: (nowRef.current() - (callStart.get(room) ?? nowRef.current())) / 1000,
                shownThisCall: shownRooms.has(room), store: storeRef.current,
            };
            if (!mayPromptForGateCut(ctx)) return;
            const d = watcher.current.decide(l.thresholdDb);
            if (!d) return;
            shownRooms.add(room);
            // -1 stands for "unknown" (no floor reading) / "none" (no lower threshold to offer).
            logCallEvent('gate_cut', {
                voiced_s: Math.round(d.voicedSec), gated_pct: Math.round(100 * d.gatedShare),
                starts: d.starts, starts_clipped: d.clipped, cuts_per_min: Math.round(d.closesPerMin),
                speech_db: r1(d.speechDb), thr_db: d.thresholdDb,
                floor_db: d.floorDb !== null ? r1(d.floorDb) : -1, suggest_db: d.suggestDb ?? -1,
            });
            logCallEvent('gate_cut_prompt', { action: 'shown' });
            setPrompt({ detection: d, offerNever: offerDontAskAgain(storeRef.current) });
        });
    }, [room]);

    const lower = useCallback(() => {
        const s = prompt?.detection.suggestDb;
        if (s == null) return;
        logCallEvent('gate_cut_prompt', { action: 'lower', to_db: s });
        setters.current.setThreshold(s);
        setPrompt(null);
    }, [prompt]);

    const turnOff = useCallback(() => {
        logCallEvent('gate_cut_prompt', { action: 'gate_off' });
        setters.current.setGate(false);
        setPrompt(null);
    }, []);

    const dismiss = useCallback(() => {
        logCallEvent('gate_cut_prompt', { action: 'dismiss' });
        const next = afterDismiss(storeRef.current);
        storeRef.current = next;
        saveGateCutPromptStore(next);
        setPrompt(null);
    }, []);

    const neverAskAgain = useCallback(() => {
        logCallEvent('gate_cut_prompt', { action: 'never' });
        const next = afterNever(afterDismiss(storeRef.current));
        storeRef.current = next;
        saveGateCutPromptStore(next);
        setPrompt(null);
    }, []);

    // The gate went off, or the user muted / deafened: nothing to say right now.
    const visible = prompt && gateOn && micOpen && !deafened ? prompt : null;
    return { prompt: visible, lower, turnOff, dismiss, neverAskAgain };
}
