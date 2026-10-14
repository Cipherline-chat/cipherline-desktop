/**
 * Device approval — wire shapes, event parsers, queue reducers and the live
 * event bus. Pure (no axios, no DOM): `useRealtime` imports this, and its test
 * must be able to load it. The requests live in `./deviceApproval`.
 */

// ── wire shapes ─────────────────────────────────────────────────────────────

/** A pending request as an approver sees it (`GET /v1/devices/pending`, the
 *  `device:approval_pending` event). */
export interface PendingDeviceRequest {
    device_id: string;
    device_name: string;
    platform: string;
    /** The pending device's identity key — input to the code AND what the
     *  approver's signature commits to. */
    identity_key_pub_b64: string;
    nonce_b64: string;
    requested_at: string;
    expires_at: string;
    reset_due_at: string | null;
    /** Coarse network of the registering address (/16), event only. */
    ip_hint?: string | null;
}

export type ApprovalOutcome = 'approved' | 'denied' | 'expired';

export interface ApprovalResolved {
    device_id: string;
    status: ApprovalOutcome;
    by_device_id: string | null;
}

export type ApprovalStatus = 'pending' | 'approved' | 'expired' | 'revoked' | 'denied';

export interface ApprovalStatusResponse {
    status: ApprovalStatus;
    nonce_b64?: string | null;
    expires_at?: string | null;
    reset_due_at?: string | null;
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Parse `device:approval_pending`. Null for anything malformed — a malformed
 *  prompt must never render (it could not be verified). */
export function parseApprovalPendingEvent(data: unknown): PendingDeviceRequest | null {
    if (!data || typeof data !== 'object') return null;
    const d = data as Record<string, unknown>;
    if (!str(d.device_id) || !str(d.device_name) || !str(d.platform)
        || !str(d.identity_key_pub_b64) || !str(d.nonce_b64)
        || !str(d.requested_at) || !str(d.expires_at)) return null;
    return {
        device_id: d.device_id,
        device_name: d.device_name,
        platform: d.platform,
        identity_key_pub_b64: d.identity_key_pub_b64,
        nonce_b64: d.nonce_b64,
        requested_at: d.requested_at,
        expires_at: d.expires_at,
        reset_due_at: str(d.reset_due_at) ? d.reset_due_at : null,
        ip_hint: str(d.ip_hint) ? d.ip_hint : null,
    };
}

/** Parse `device:approval_resolved`. */
export function parseApprovalResolvedEvent(data: unknown): ApprovalResolved | null {
    if (!data || typeof data !== 'object') return null;
    const d = data as Record<string, unknown>;
    if (!str(d.device_id)) return null;
    if (d.status !== 'approved' && d.status !== 'denied' && d.status !== 'expired') return null;
    return { device_id: d.device_id, status: d.status, by_device_id: str(d.by_device_id) ? d.by_device_id : null };
}

// ── list reducers (the approver's queue) ────────────────────────────────────

/** Add or replace a request (a re-registration of the same device, or a
 *  reset request, re-sends the event with fresh fields). Oldest first. */
export function upsertPending(list: PendingDeviceRequest[], req: PendingDeviceRequest): PendingDeviceRequest[] {
    const rest = list.filter(r => r.device_id !== req.device_id);
    return [...rest, req].sort((a, b) => Date.parse(a.requested_at) - Date.parse(b.requested_at));
}

export function removePending(list: PendingDeviceRequest[], deviceId: string): PendingDeviceRequest[] {
    return list.some(r => r.device_id === deviceId) ? list.filter(r => r.device_id !== deviceId) : list;
}

/** Drop lapsed requests; returns the SAME array when nothing changed so a
 *  state setter does not re-render. */
export function pruneExpired(list: PendingDeviceRequest[], nowMs: number): PendingDeviceRequest[] {
    const live = list.filter(r => !Number.isFinite(Date.parse(r.expires_at)) || Date.parse(r.expires_at) > nowMs);
    return live.length === list.length ? list : live;
}

/** Requests with a cooling-off reset still ahead of them. A reset whose time
 *  has passed is the server's to execute or cancel on its next poll, so it
 *  is no longer something the user can usefully "cancel" from a banner. */
export function activeResetRequests(list: PendingDeviceRequest[], nowMs: number): PendingDeviceRequest[] {
    return list.filter(r => {
        const due = r.reset_due_at ? Date.parse(r.reset_due_at) : NaN;
        return Number.isFinite(due) && due > nowMs;
    });
}

/** Whole seconds until `iso`, floored at 0; null when unparseable. */
export function secondsUntil(iso: string | null | undefined, nowMs: number): number | null {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? Math.max(0, Math.floor((t - nowMs) / 1000)) : null;
}

/** 874 -> "14:34". */
export function formatCountdown(totalSeconds: number): string {
    const s = Math.max(0, Math.floor(totalSeconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function platformLabel(platform: string): string {
    const p = (platform || '').toLowerCase();
    if (p === 'ios') return 'iPhone / iPad';
    if (p === 'android') return 'Android';
    if (p === 'mac' || p === 'darwin' || p === 'macos') return 'Mac';
    if (p === 'linux') return 'Linux';
    if (p === 'windows' || p === 'win32') return 'Windows';
    return platform || 'Unknown platform';
}

/** "203.0.0.0" (the server's /16 hint) -> "203.0.x.x". */
export function networkHint(ip: string | null | undefined): string | null {
    if (!ip) return null;
    const m = /^(\d{1,3})\.(\d{1,3})\./.exec(ip);
    if (m) return `${m[1]}.${m[2]}.x.x`;
    return ip.length <= 24 ? ip : null;
}

// ── live events ─────────────────────────────────────────────────────────────

export type DeviceApprovalEvent =
    | { kind: 'pending'; request: PendingDeviceRequest }
    | { kind: 'resolved'; resolved: ApprovalResolved };

type BusListener = (ev: DeviceApprovalEvent) => void;
const busListeners = new Set<BusListener>();

/**
 * `device:approval_pending` / `device:reset_requested` / `device:approval_resolved` fan-out. `useRealtime`
 * validates the frame and emits here; the approver host and Settings →
 * Devices subscribe. A bus rather than hook state because two requests (or a
 * request and its resolution) can arrive back to back, and state would keep
 * only the last. Same shape as `referralRedeemedBus`.
 */
export const deviceApprovalBus = {
    emit(ev: DeviceApprovalEvent): void {
        for (const l of Array.from(busListeners)) {
            try { l(ev); } catch (e) { console.error('[deviceApprovalBus] listener failed:', e); }
        }
    },
    subscribe(l: BusListener): () => void {
        busListeners.add(l);
        return () => { busListeners.delete(l); };
    },
};

/** Route a raw WS frame onto the bus. Returns true when it was one of ours. */
export function dispatchDeviceApprovalFrame(event: string, data: unknown): boolean {
    if (event === 'device:approval_pending') {
        const request = parseApprovalPendingEvent(data);
        if (request) deviceApprovalBus.emit({ kind: 'pending', request });
        return true;
    }
    if (event === 'device:reset_requested') {
        // Same shape as `device:approval_pending`, with `reset_due_at` set.
        // Anything without a reset date is not a reset notice: dropped, never
        // upgraded into a prompt.
        const request = parseApprovalPendingEvent(data);
        if (request && request.reset_due_at) deviceApprovalBus.emit({ kind: 'pending', request });
        return true;
    }
    if (event === 'device:approval_resolved') {
        const resolved = parseApprovalResolvedEvent(data);
        if (resolved) deviceApprovalBus.emit({ kind: 'resolved', resolved });
        return true;
    }
    return false;
}

