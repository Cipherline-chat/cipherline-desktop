/**
 * Stale-device policy — client half (owner decision 2026-10-19: prompt after
 * 30 days unseen, prompt again after 180, the server removes it after 365).
 *
 * The server owns every decision: `GET /v1/devices` says, per device, which
 * tier it is in (`stale_tier`) and whether the owner still has to answer the
 * prompt for that tier (`stale_prompt_due`). The "Keep it" answer is stored
 * server-side (`POST /v1/devices/stale-dismiss`) so it holds on every one of
 * the user's devices and the prompt is shown once per tier, not per launch.
 * Removal reuses the existing `POST /v1/devices/:id/revoke`.
 *
 * Older servers send none of the stale_* fields; every helper here treats a
 * missing field as "not stale", so the prompt simply never appears.
 */
import axios from 'axios';
import { API_BASE } from '../constants';
import { apiUrl } from './apiPath';

export type StaleTier = 'none' | '30d' | '180d';

/** One row of `GET /v1/devices` (only the fields this feature reads). */
export interface OwnDevice {
    device_id: string;
    device_name: string;
    platform: string;
    created_at?: string;
    last_seen_at?: string | null;
    /** YYYY-MM-DD (UTC) — the server only ever hands out day precision. */
    last_active_on?: string;
    stale_tier?: StaleTier;
    stale_prompt_due?: boolean;
    /** Present only while the server's automatic removal is switched on. */
    auto_remove_on?: string | null;
}

export function staleTierOf(d: Pick<OwnDevice, 'stale_tier'>): StaleTier {
    return d.stale_tier === '30d' || d.stale_tier === '180d' ? d.stale_tier : 'none';
}

/**
 * Devices to put in front of the owner right now: due on the server, and
 * never the device doing the asking (it is obviously in use). Oldest tier
 * first, then name, so the list is stable between renders.
 */
export function dueStaleDevices(devices: OwnDevice[], myDeviceId: string | null | undefined): OwnDevice[] {
    return devices
        .filter(d => d.device_id !== myDeviceId && d.stale_prompt_due === true && staleTierOf(d) !== 'none')
        .sort((a, b) => (staleTierOf(b) === '180d' ? 1 : 0) - (staleTierOf(a) === '180d' ? 1 : 0)
            || (a.last_active_on ?? '').localeCompare(b.last_active_on ?? '')
            || a.device_name.localeCompare(b.device_name));
}

/** Badge copy for Settings → Devices and the prompt. */
export function staleBadgeLabel(tier: StaleTier): string | null {
    if (tier === '180d') return 'Not used in 6+ months';
    if (tier === '30d') return 'Not used in 30+ days';
    return null;
}

/** "Aug 3, 2026" from the server's YYYY-MM-DD, read as a calendar day (no TZ shift). */
export function formatLastActive(day: string | null | undefined): string | null {
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const [y, m, d] = day.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
    });
}

/** Copy for the dialog header/footer — pure so it is testable. */
export function staleDialogCopy(devices: OwnDevice[]): { title: string; subtitle: string; hint: string; autoRemove: string | null } {
    const one = devices.length === 1;
    const anyOld = devices.some(d => staleTierOf(d) === '180d');
    const removeOn = devices
        .map(d => d.auto_remove_on)
        .filter((x): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x))
        .sort()[0] ?? null;
    return {
        title: one ? 'Still using this device?' : 'Still using these devices?',
        subtitle: anyOld
            ? `${one ? 'It hasn’t' : 'Some haven’t'} been used in over 6 months.`
            : `${one ? 'It hasn’t' : 'They haven’t'} been used in over a month.`,
        hint: one ? 'If you keep it, it stays signed in.' : 'Devices you keep stay signed in.',
        autoRemove: removeOn
            ? `Devices that stay unused for a year are removed automatically${one ? ` (this one on ${formatLastActive(removeOn)})` : ''}.`
            : null,
    };
}

export async function fetchOwnDevices(token: string): Promise<OwnDevice[]> {
    const res = await axios.get<OwnDevice[]>(`${API_BASE}/devices`, { headers: { Authorization: `Bearer ${token}` } });
    return Array.isArray(res.data) ? res.data : [];
}

/** "Keep it" for each listed device at the tier it is in now. */
export async function keepStaleDevices(
    token: string,
    myDeviceId: string,
    devices: Array<Pick<OwnDevice, 'device_id' | 'stale_tier'>>,
): Promise<void> {
    const dismissals = devices
        .map(d => ({ device_id: d.device_id, tier: staleTierOf(d) }))
        .filter((d): d is { device_id: string; tier: '30d' | '180d' } => d.tier !== 'none');
    if (dismissals.length === 0) return;
    await axios.post(`${API_BASE}/devices/stale-dismiss`, { dismissals }, {
        headers: { Authorization: `Bearer ${token}`, 'x-device-id': myDeviceId },
    });
}

/** The same revoke the Devices pane uses. */
export async function removeOwnDevice(token: string, myDeviceId: string, targetId: string): Promise<void> {
    await axios.post(apiUrl`/devices/${targetId}/revoke`, {}, {
        headers: { Authorization: `Bearer ${token}`, 'x-device-id': myDeviceId },
    });
}
