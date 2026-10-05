import { useSyncExternalStore } from 'react';
import secureLocalStore from './secureLocalStore';
import type { ScreenShareCodecPref } from './screenShare';

/**
 * Settings → Advanced → "Screen share & stream diagnostics".
 *
 * Two device-local preferences, both deliberately NOT in backups
 * (backupRegistry.ts): the stats overlay is a testing aid, and the codec
 * choice is a statement about THIS machine's GPU, which a restore onto a
 * different machine must not inherit.
 *
 * A tiny external store rather than component state: the toggle lives in the
 * settings page while every video tile reads it, and flipping it has to show
 * or hide the overlay on tiles that are already on screen.
 */

const HUD_KEY = 'cipherline_stream_stats_hud';
const CODEC_KEY = 'cipherline_screenshare_codec';

const CODEC_PREFS: readonly ScreenShareCodecPref[] = ['auto', 'h264', 'vp9', 'vp8'];

export function parseCodecPref(raw: string | null | undefined): ScreenShareCodecPref {
    return (CODEC_PREFS as readonly string[]).includes(raw ?? '') ? raw as ScreenShareCodecPref : 'auto';
}

const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

function read(key: string): string | null {
    try { return secureLocalStore.getItem(key); } catch { return null; }
}

export function getStreamStatsHudEnabled(): boolean {
    return read(HUD_KEY) === '1';
}

export function setStreamStatsHudEnabled(on: boolean): void {
    try { secureLocalStore.setItem(HUD_KEY, on ? '1' : '0'); } catch { /* locked store: in-memory only */ }
    emit();
}

export function getScreenShareCodecPref(): ScreenShareCodecPref {
    return parseCodecPref(read(CODEC_KEY));
}

export function setScreenShareCodecPref(pref: ScreenShareCodecPref): void {
    try { secureLocalStore.setItem(CODEC_KEY, parseCodecPref(pref)); } catch { /* locked store */ }
    emit();
}

export function useStreamStatsHudEnabled(): boolean {
    return useSyncExternalStore(subscribe, getStreamStatsHudEnabled, () => false);
}

export function useScreenShareCodecPref(): ScreenShareCodecPref {
    return useSyncExternalStore(subscribe, getScreenShareCodecPref, () => 'auto' as const);
}
