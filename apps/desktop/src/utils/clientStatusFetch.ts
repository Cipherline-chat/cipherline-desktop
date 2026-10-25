import axios from 'axios';
import { API_BASE } from '../constants';
import { parseClientStatus, type ClientStatus } from './clientControl';

/**
 * GET /v1/client-status — public, unauthenticated, exempt from the shutdown
 * and from the version floor, so it answers for a logged-out client, for one
 * below the floor and during a shutdown alike. No token is sent: the endpoint
 * carries nothing about the caller and does not need to know who asks.
 *
 * Resolves null on any failure (offline, a proxy error, an older API without
 * the route — a 404 there): the caller treats "unknown" as "keep whatever
 * state you are in", never as "shut down".
 */
export async function fetchClientStatus(timeoutMs = 10_000): Promise<ClientStatus | null> {
    try {
        // The server answers `Cache-Control: no-store`, so a "shut down" can
        // never be served from cache after the switch lifts.
        const res = await axios.get(`${API_BASE}/client-status`, { timeout: timeoutMs });
        return parseClientStatus(res.data);
    } catch {
        return null;
    }
}
