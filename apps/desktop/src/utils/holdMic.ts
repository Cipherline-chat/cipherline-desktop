import { getPttUiState, setPttUiState } from './pushToTalk';

/** What the controller needs from the call: the mic, and whether it may be (re)opened. */
export interface MicPort {
    /** The mic track is publishing right now. */
    isEnabled(): boolean;
    set(on: boolean): Promise<unknown> | void;
    /** May a hold key OPEN the mic (permission to speak / publish). */
    canOpen(): boolean;
    /** May push-to-mute give the mic BACK on release (can open, and the user is not deafened). */
    canRestore(): boolean;
    /** Audible feedback for push-to-mute (the same mute/unmute sounds the Mute button plays). PTT is silent. */
    cue?(kind: 'mute' | 'unmute'): void;
}

/**
 * Push-to-talk and push-to-mute, as one small state machine so they cannot disagree about the mic.
 *
 *  - Push-to-talk (PTT mode on): the mic is closed unless the key is held. A deliberate Mute
 *    (`manualMuted`, in the UI store) makes the key do nothing until the user unmutes.
 *  - Push-to-mute (PTT mode OFF, normal voice-activity mode): while held, the mic is muted; on release it
 *    returns to what it was. It never opens a mic that was closed when it was pressed, so someone who had
 *    already muted themselves stays muted. If the user toggles Mute during the hold they have taken over and
 *    release does not touch it. It is INERT while PTT mode is on (the mic is already closed by default and
 *    the PTT key alone decides when it opens).
 *
 * Every method is idempotent (key-down repeats, or the same key seen by two delivery paths, are harmless).
 */
export class HoldMicController {
    private pttDown = false;
    private muteHeld = false;
    private pushMuted = false;

    private readonly mic: MicPort;

    constructor(mic: MicPort) { this.mic = mic; }

    pttPress(): void {
        const ui = getPttUiState();
        if (!ui.active || ui.recording || ui.manualMuted || this.pttDown) return;
        this.pttDown = true;
        setPttUiState({ keyDown: true });
        if (!this.mic.isEnabled() && this.mic.canOpen()) {
            // A quick tap can release before the mic finishes opening: close it again then, or it stays hot.
            Promise.resolve(this.mic.set(true)).then(() => {
                if (!this.pttDown && this.mic.isEnabled()) void this.mic.set(false);
            }).catch(() => undefined);
        }
    }

    pttRelease(): void {
        if (!this.pttDown) return;
        this.pttDown = false;
        setPttUiState({ keyDown: false });
        if (this.mic.isEnabled()) void this.mic.set(false);
    }

    mutePress(): void {
        const ui = getPttUiState();
        if (ui.active || ui.recording || this.muteHeld) return;
        this.muteHeld = true;
        if (this.mic.isEnabled()) {
            this.pushMuted = true;
            void this.mic.set(false);
            this.mic.cue?.('mute');
        }
    }

    muteRelease(): void {
        if (!this.muteHeld) return;
        this.muteHeld = false;
        if (!this.pushMuted) return;          // it was already muted when pressed: leave it muted
        this.pushMuted = false;
        if (!this.mic.isEnabled() && this.mic.canRestore()) {
            void this.mic.set(true);
            this.mic.cue?.('unmute');
        }
    }

    /** The user pressed Mute / Unmute themselves (button or key): from here the mic is theirs, release restores nothing. */
    userToggled(): void { this.pushMuted = false; }

    /** Push-to-talk mode turned on: a push-to-mute that was mid-hold is dropped (the mic is closed anyway). */
    enteredPttMode(): void { this.pushMuted = false; this.muteHeld = false; }

    /** Window lost focus with no system-wide watcher: a key-up elsewhere would never arrive. */
    releaseAll(): void { this.pttRelease(); this.muteRelease(); }

    /** Call end / unmount. */
    reset(): void { this.pttDown = false; this.muteHeld = false; this.pushMuted = false; }
}
