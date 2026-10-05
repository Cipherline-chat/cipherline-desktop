import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';

/**
 * Continuity — `GET /v1/devices/presence`: live state of the CALLER'S OWN
 * devices (see apps/api/src/devices/devices.controller.ts's
 * getOwnDevicePresence for the full server-side doc comment). Unconditional
 * — it exposes nothing about anyone but the caller, over their own
 * authenticated session.
 *
 * `connected` and `attentive` are deliberately separate and must stay that
 * way in this client too: a connected laptop with the lid shut is not a
 * present user. Never collapse them into one boolean.
 */
export interface OwnDevicePresenceEntry {
    device_id: string;
    device_name: string;
    platform: string;
    connected: boolean;
    attentive: boolean;
    last_active_at: number | null;
    last_seen_at: string;
}

/**
 * Seeded at boot and on every WS reconnect — NEVER polled. The endpoint's
 * own throttle bucket (devicePresence, 10/10s) exists for exactly this
 * pattern and would be trivially exceeded by a timer; a reconnect is the
 * only moment this state can have gone stale (the WS is what would
 * otherwise carry a live update, and there is no per-device presence WS
 * event to react to instead).
 *
 * "On reconnect" is read off the SAME global signal useRealtime.ts's own
 * 'cipherline:ws-connected' CustomEvent already provides (confirmed-alive,
 * not just handshake-complete — see that file's doc comment) rather than
 * threading wsConnectCount as a prop through Settings → DevicesPane, which
 * would mean widening that component's prop surface for a value it doesn't
 * otherwise need.
 */
export function useOwnDevicePresence(token: string | null) {
    const [devices, setDevices] = useState<OwnDevicePresenceEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const refresh = useCallback(async () => {
        if (!token) return;
        setLoading(true);
        setError('');
        try {
            const res = await axios.get<{ devices: OwnDevicePresenceEntry[] }>(
                `${API_BASE}/devices/presence`,
                { headers: { Authorization: `Bearer ${token}` } },
            );
            setDevices(res.data?.devices ?? []);
        } catch {
            setError('Failed to load device presence.');
        } finally {
            setLoading(false);
        }
    }, [token]);

    useEffect(() => { refresh(); }, [refresh]);

    useEffect(() => {
        const onReconnect = () => { refresh(); };
        window.addEventListener('cipherline:ws-connected', onReconnect);
        return () => window.removeEventListener('cipherline:ws-connected', onReconnect);
    }, [refresh]);

    return { devices, loading, error, refresh };
}

export type OwnDevicePresenceHook = ReturnType<typeof useOwnDevicePresence>;
