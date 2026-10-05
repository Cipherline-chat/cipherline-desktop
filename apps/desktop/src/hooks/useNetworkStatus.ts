/**
 * useNetworkStatus — tracks whether the device actually has working internet.
 *
 * Two signals are combined:
 *
 *   1. navigator.onLine — fast OS-level interface state. Flips immediately
 *      when Wi-Fi is turned off, an ethernet cable is unplugged, etc. The
 *      'online'/'offline' window events deliver these transitions.
 *
 *   2. WebSocket reachability — the renderer dispatches custom events from
 *      useRealtime:
 *        • 'cipherline:ws-connected'    on every successful ws.onopen
 *        • 'cipherline:ws-disconnected' on every ws.onclose (excluding the
 *          forced-upgrade close and the unmount close)
 *      This is the ground truth for "can we actually reach the API". It
 *      catches the cases navigator.onLine misses entirely: Wi-Fi is up but
 *      the router is dead, DNS is broken, the laptop is on a captive-portal
 *      page that hasn't been signed into, the corporate VPN dropped, etc.
 *      In all these scenarios navigator.onLine reports `true` and the user
 *      would otherwise sit with a stale UI thinking everything's fine.
 *
 * Combined rule:
 *   - If navigator.onLine = false → offline immediately (clear OS signal).
 *   - Else if WS has reported a confirmed disconnect and no subsequent
 *     reconnect → offline.
 *   - Else → online. The initial 'unknown' WS state defers to navigator.onLine,
 *     so we don't flash an offline screen before the WS has had a chance to try.
 */
import { useState, useEffect } from 'react';

type WsState = 'unknown' | 'connected' | 'disconnected';

export function useNetworkStatus(): boolean {
    const [navOnline, setNavOnline] = useState<boolean>(() => navigator.onLine);
    const [wsState, setWsState] = useState<WsState>('unknown');

    useEffect(() => {
        const onNavOnline  = () => setNavOnline(true);
        const onNavOffline = () => setNavOnline(false);
        const onWsUp       = () => setWsState('connected');
        const onWsDown     = () => setWsState('disconnected');

        window.addEventListener('online',  onNavOnline);
        window.addEventListener('offline', onNavOffline);
        window.addEventListener('cipherline:ws-connected',    onWsUp);
        window.addEventListener('cipherline:ws-disconnected', onWsDown);

        // Sync once on mount in case the state changed between SSR hydration
        // and this effect (edge case in hot-reload dev only).
        setNavOnline(navigator.onLine);

        return () => {
            window.removeEventListener('online',  onNavOnline);
            window.removeEventListener('offline', onNavOffline);
            window.removeEventListener('cipherline:ws-connected',    onWsUp);
            window.removeEventListener('cipherline:ws-disconnected', onWsDown);
        };
    }, []);

    if (!navOnline) return false;
    if (wsState === 'disconnected') return false;
    return true;
}
