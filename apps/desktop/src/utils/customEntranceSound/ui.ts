/**
 * Small helpers for the Settings UI of custom entrance sounds
 * (components/settings/panes/CustomEntranceSound.tsx): the "your sound on
 * this device" hook and the user-facing formatting.
 */
import { useEffect, useState } from 'react';
import { MAX_INPUT_BYTES, MIN_CLIP_SECONDS } from './constants';
import { ownEntranceSound, type OwnSound } from './ownStore';

/** Your custom sound on this device; re-renders when it changes. */
export function useOwnEntranceSound(): OwnSound | null {
    const [, setTick] = useState(0);
    useEffect(() => ownEntranceSound().subscribe(() => setTick(n => n + 1)), []);
    return ownEntranceSound().current();
}

/** `m:ss.s` */
export const fmtTime = (s: number): string => {
    const safe = Math.max(0, s);
    const m = Math.floor(safe / 60);
    const rest = safe - m * 60;
    return `${m}:${rest.toFixed(1).padStart(4, '0')}`;
};
export const fmtSize = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`);
export const fmtSecs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** User-facing text for an input / processing failure code. */
export function describeSoundError(code: string): string {
    switch (code) {
        case 'type': return 'That file type is not supported. Use MP3, OGG, WAV, M4A or WebM.';
        case 'size': return `That file is over ${Math.round(MAX_INPUT_BYTES / (1024 * 1024))} MB.`;
        case 'empty': return 'That file is empty.';
        case 'too_long': return 'That file is longer than 6 minutes. Pick a shorter one.';
        case 'silent': return 'That part is silent. Pick a part with sound in it.';
        case 'window too short': return `Pick at least ${MIN_CLIP_SECONDS} seconds.`;
        case 'too_large': return 'The sound came out too big. Try a shorter part.';
        case 'encode_failed': return 'This device could not encode the sound. Try again, or try another file.';
        case 'signed_out': return 'You are signed out.';
        default: return 'That audio file could not be read.';
    }
}
