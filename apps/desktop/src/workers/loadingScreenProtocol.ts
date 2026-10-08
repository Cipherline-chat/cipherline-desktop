/**
 * Messages between AppLoadingScreen (main thread) and its worker
 * (loadingScreen.worker.ts). Types only. The main thread sends sizes and raw
 * input, nothing per frame; the worker sends back only state CHANGES (the
 * first frame landed, a run started or ended, WebGL is unavailable).
 */
import type { GameMode } from '../utils/loadingGame';

export type ToWorker =
    | {
        type: 'init';
        canvas: OffscreenCanvas;
        /** CSS px. */
        w: number;
        h: number;
        dpr: number;
        /** This session's best score so far. */
        best: number;
        /** prefers-reduced-motion: one still frame, no pointer, no game. */
        reduced: boolean;
    }
    | { type: 'resize'; w: number; h: number; dpr: number }
    /** The pointer, -1..1 from the centre (y up), at most once a frame. `on` = inside the window. */
    | { type: 'pointer'; x: number; y: number; on: boolean }
    /** Where the loading bar goes (the DOM slot under the status line): centre x, y in px from the window centre (y up), width. */
    | { type: 'bar'; x: number; y: number; w: number }
    /**
     * What is honestly known about progress. The bar creeps from `floor`
     * toward `ceil` (never reaching it) and never goes backwards; `done`
     * (the app has loaded) is the only thing that takes it to the end.
     */
    | { type: 'progress'; floor: number; ceil: number; done: boolean }
    /** Space: start a run, or one stroke. */
    | { type: 'act' }
    /**
     * Show or hide Keys. The lock screen (components/LockScreenField.tsx) wants
     * the dot field alone, behind its own PIN card; every other screen leaves
     * him on (the default).
     */
    | { type: 'keys'; visible: boolean }
    /** Esc while still loading: leave the game. */
    | { type: 'quit' }
    /** The screen is leaving: play the short exit, then stop drawing. */
    | { type: 'exit' }
    /** Parked for a possible handoff (or a StrictMode re-run): stop drawing. */
    | { type: 'pause' }
    /** Re-attached to the canvas it already owns: carry on. */
    | { type: 'resume' }
    /** Going away for good: release the GL context now. */
    | { type: 'detach' }
    /** Measurement hook: frames drawn and time spent since the last ask. */
    | { type: 'stats' };

export type FromWorker =
    | { type: 'ok' }
    | { type: 'nogl' }
    | { type: 'game'; mode: GameMode; score: number; best: number }
    | { type: 'stats'; frames: number; busyMs: number; wallMs: number };
