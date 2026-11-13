import { useSyncExternalStore } from 'react';
import secureLocalStore from './secureLocalStore';

/**
 * Settings -> Advanced -> "Hardware screen share (Linux)".
 *
 * Device-local and deliberately NOT in backups (backupRegistry.ts): both values describe THIS machine's GPU/desktop, and the portal
 * restore token is a capture permission grant that must not travel to another device.
 *
 * ON by default (owner, 2026-11-10: "that should be on unless they don't have a GPU"). Only an explicit '0' - the user switching it off
 * here - turns it off; an unset key is on. Being on is only permission to TRY: every share still probes for a working hardware encoder and
 * takes the normal Chromium path when there is none, when it is too slow at the size, or when anything fails (nativeShareSelect.ts,
 * tryStartNativeShare in SidebarConference.tsx). CIPHERLINE_NATIVE_SHARE_ENCODER=1 (window.nativeShare.envFlag) still forces it on for
 * the lab, over a '0' here.
 */
const ENABLED_KEY = 'cipherline_native_share_hw';
const TOKEN_KEY = 'cipherline_native_share_token';

const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
function read(key: string): string | null { try { return secureLocalStore.getItem(key); } catch { return null; } }

export function getNativeShareEnabled(): boolean { return read(ENABLED_KEY) !== '0'; }
export function setNativeShareEnabled(on: boolean): void {
    try { secureLocalStore.setItem(ENABLED_KEY, on ? '1' : '0'); } catch { /* locked store: in-memory only */ }
    if (!on) setNativeShareRestoreToken(null);   // turning it off also forgets the capture grant
    emit();
}
export function useNativeShareEnabled(): boolean { return useSyncExternalStore(subscribe, getNativeShareEnabled, () => true); }

const TOKEN_RE = /^[A-Za-z0-9_\-+=.:/]{1,512}$/;
export function getNativeShareRestoreToken(): string | null {
    const t = read(TOKEN_KEY);
    return t && TOKEN_RE.test(t) ? t : null;
}
export function setNativeShareRestoreToken(token: string | null): void {
    try {
        if (token && TOKEN_RE.test(token)) secureLocalStore.setItem(TOKEN_KEY, token);
        else secureLocalStore.removeItem(TOKEN_KEY);
    } catch { /* locked store */ }
}

/**
 * The portal restore token to offer for a native start: ONLY for the app's own restart of the SAME live share (quality change, keep-alive,
 * re-publish), where asking the person again would be wrong. A new share and a change of source get null, so the chooser always shows
 * (a remembered grant silently re-picked the last screen). The token is still stored for the restart case.
 */
export function nativeRestoreTokenFor(internalRestart: boolean, stored: string | null): string | null {
    return internalRestart ? stored : null;
}
