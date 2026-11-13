import { useEffect, useRef, useSyncExternalStore } from 'react';
import secureLocalStore from './secureLocalStore';

/**
 * "Screen sharing on Linux is new" — a one-time card shown the first time this device shares its screen on Linux
 * (components/diagnostics/LinuxShareIntroCard.tsx).
 *
 * Owner, 2026-11-10: be honest that AMD and Intel are less tested than NVIDIA, ask for test data, and show (a short
 * video) how to send a quality report. Every Linux device sees it ONCE, whatever its GPU — an NVIDIA share is new too.
 *
 * Flow: SidebarConference calls useLinuxShareIntroTrigger(sharing, encoder) -> the first time `sharing` turns true on
 * Linux the card becomes PENDING -> the card shows when the window is next visible and focused (never over a game the
 * user is sharing, never delaying the share: nothing here is awaited by the share path) -> only at that moment is the
 * device flag written. A card that never got on screen (app quit while unfocused) is offered again on the next share.
 *
 * The flag is device-global (no user id in the key — any account on this computer has now been told) and is NOT in
 * backups (backupRegistry.ts): it is about THIS machine's first share, a new machine should say it again.
 */
export const LINUX_SHARE_INTRO_KEY = 'cipherline_linux_share_intro_seen';

/** Which share path actually engaged: the native helper's NVENC / VA-API encoder, or the normal (Chromium) share. */
export type ShareBackendKind = 'nvenc' | 'vaapi' | 'normal';

export interface LinuxShareIntroState {
    backend: ShareBackendKind;
    /** On screen now (the flag is written at the moment this turns true). */
    shown: boolean;
}

/** The native pipeline's encoder name ('nvenc' / 'vaapi', native/share-encoder ClEncoderOps.name) -> backend. */
export function backendFromEncoder(encoder: string | null | undefined): ShareBackendKind {
    return encoder === 'nvenc' ? 'nvenc' : encoder === 'vaapi' ? 'vaapi' : 'normal';
}

/** Pure decision: offer the card for a share that just started? */
export function shouldOfferLinuxShareIntro(platform: string | undefined, seen: boolean, alreadyOffered: boolean): boolean {
    return platform === 'linux' && !seen && !alreadyOffered;
}

export function hasSeenLinuxShareIntro(): boolean {
    try { return secureLocalStore.getItem(LINUX_SHARE_INTRO_KEY) === '1'; } catch { return false; }
}

let state: LinuxShareIntroState | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of [...listeners]) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => state;

/** The card's state now (null = nothing to show). */
export function getLinuxShareIntroState(): LinuxShareIntroState | null { return state; }

/** A share just went live. Makes the card pending when this is Linux and the device has never shown it. */
export function noteScreenShareStarted(backend: ShareBackendKind, platform: string | undefined = window.electronAPI?.platform): void {
    if (!shouldOfferLinuxShareIntro(platform, hasSeenLinuxShareIntro(), state !== null)) return;
    state = { backend, shown: false };
    emit();
}

/** The card is on screen: latch it and write the device flag (once). */
export function revealLinuxShareIntro(): void {
    if (!state || state.shown) return;
    state = { ...state, shown: true };
    try { secureLocalStore.setItem(LINUX_SHARE_INTRO_KEY, '1'); } catch { /* locked store: in-memory only, it may say it again next launch */ }
    emit();
}

export function dismissLinuxShareIntro(): void {
    if (!state) return;
    state = null;
    emit();
}

export function useLinuxShareIntro(): LinuxShareIntroState | null {
    return useSyncExternalStore(subscribe, snapshot, () => null);
}

/**
 * The one line in SidebarConference: `sharing` = our own screen share is published; `encoder` reads the native pipeline's
 * encoder name at that moment (null/undefined = the normal share). Re-fires per share; noteScreenShareStarted keeps it once.
 */
export function useLinuxShareIntroTrigger(sharing: boolean, encoder: () => string | null | undefined): void {
    const encoderRef = useRef(encoder);
    useEffect(() => { encoderRef.current = encoder; });
    useEffect(() => {
        if (!sharing) return;
        let backend: ShareBackendKind = 'normal';
        try { backend = backendFromEncoder(encoderRef.current()); } catch { /* the copy falls back to the general line */ }
        noteScreenShareStarted(backend);
    }, [sharing]);
}

export function __resetLinuxShareIntroForTests(): void {
    state = null;
    emit();
}
