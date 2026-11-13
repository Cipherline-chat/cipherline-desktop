import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { VoiceModerationEntry } from '@cipherline/shared';
import { onServerModerationPresenceChange } from './callMediaPresence';
import { apiPath } from './apiPath';

/**
 * A moderator's view of the server's active VOICE MODERATION: who is server
 * muted / server deafened and for how much longer.
 *
 * The restriction itself lives on the server (per server + user, 24 h, removed
 * only by a moderator or by lapsing - it survives the person leaving voice,
 * switching channels, reconnecting and restarting). Everyone in a call learns
 * the two bits through ordinary call presence (utils/callMediaPresence); the
 * EXPIRY is moderator-only information, fetched from
 * `GET /v1/servers/:id/voice-moderation` (MODERATE_CALL_MEDIA), which is what
 * this store holds. It powers:
 *   - the "Server muted · 23 h left" tooltip on a participant's badge, and
 *   - removing a mute / deafen from a member who is NOT in voice (member menu).
 *
 * UX only: the server re-checks the permission on every request, and a client
 * that never loads this still sees the correct badges (presence) - it just
 * cannot show a countdown.
 *
 * Module-level external store (same pattern as callMediaPresence): rows
 * subscribe to one server's list and re-render only when it changes.
 */

export interface VoiceModerationTimes {
    /** Epoch ms the server mute lapses, 0 = not muted. */
    mutedUntil: number;
    /** Epoch ms the server deafen lapses, 0 = not deafened. */
    deafenedUntil: number;
}

const NONE: Readonly<VoiceModerationTimes> = Object.freeze({ mutedUntil: 0, deafenedUntil: 0 });

const byServer = new Map<string, Map<string, VoiceModerationTimes>>();
const listeners = new Map<string, Set<() => void>>();
const versions = new Map<string, number>();

function notify(serverId: string): void {
    versions.set(serverId, (versions.get(serverId) ?? 0) + 1);
    listeners.get(serverId)?.forEach(l => l());
}

function parseUntil(v: unknown): number {
    if (typeof v !== 'string') return 0;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
}

/** Replace a server's list with a fresh `GET .../voice-moderation` body.
 *  Malformed entries are dropped; anything that is not an array reads as empty. */
export function setServerVoiceModeration(serverId: string, raw: unknown): void {
    const next = new Map<string, VoiceModerationTimes>();
    if (Array.isArray(raw)) {
        for (const e of raw as Partial<VoiceModerationEntry>[]) {
            if (!e || typeof e.user_id !== 'string' || !e.user_id) continue;
            const mutedUntil = parseUntil(e.muted_until);
            const deafenedUntil = parseUntil(e.deafened_until);
            if (mutedUntil > 0 || deafenedUntil > 0) next.set(e.user_id, { mutedUntil, deafenedUntil });
        }
    }
    byServer.set(serverId, next);
    notify(serverId);
}

/** Drop one restriction locally right after a successful removal, so the menu
 *  and tooltip update before the next refetch. */
export function clearServerVoiceModerationBit(serverId: string, userId: string, bit: 'muted' | 'deafened'): void {
    const m = byServer.get(serverId);
    const cur = m?.get(userId);
    if (!m || !cur) return;
    const next = { ...cur, ...(bit === 'muted' ? { mutedUntil: 0 } : { deafenedUntil: 0 }) };
    if (next.mutedUntil === 0 && next.deafenedUntil === 0) m.delete(userId); else m.set(userId, next);
    notify(serverId);
}

/** What the moderator list currently says about one member (live bits only). */
export function getServerVoiceModeration(
    serverId: string | null | undefined,
    userId: string,
    now: number = Date.now(),
): VoiceModerationTimes {
    const t = serverId ? byServer.get(serverId)?.get(userId) : undefined;
    if (!t) return NONE;
    return { mutedUntil: t.mutedUntil > now ? t.mutedUntil : 0, deafenedUntil: t.deafenedUntil > now ? t.deafenedUntil : 0 };
}

/** Every member with a live restriction on this server. */
export function listServerVoiceModeration(
    serverId: string | null | undefined,
    now: number = Date.now(),
): Array<{ userId: string } & VoiceModerationTimes> {
    const m = serverId ? byServer.get(serverId) : undefined;
    if (!m) return [];
    const out: Array<{ userId: string } & VoiceModerationTimes> = [];
    for (const [userId, t] of m) {
        const live = { mutedUntil: t.mutedUntil > now ? t.mutedUntil : 0, deafenedUntil: t.deafenedUntil > now ? t.deafenedUntil : 0 };
        if (live.mutedUntil > 0 || live.deafenedUntil > 0) out.push({ userId, ...live });
    }
    return out;
}

function subscribe(serverId: string, l: () => void): () => void {
    let set = listeners.get(serverId);
    if (!set) { set = new Set(); listeners.set(serverId, set); }
    set.add(l);
    return () => {
        const s = listeners.get(serverId);
        if (!s) return;
        s.delete(l);
        if (s.size === 0) listeners.delete(serverId);
    };
}

/** Re-render when this server's moderator list changes. Returns a version
 *  number to key memos on. `serverId` null subscribes to nothing. */
export function useServerVoiceModerationVersion(serverId: string | null | undefined): number {
    const sub = useCallback((l: () => void) => (serverId ? subscribe(serverId, l) : () => {}), [serverId]);
    return useSyncExternalStore(sub, () => (serverId ? versions.get(serverId) ?? 0 : 0), () => 0);
}

/**
 * "23 h left" / "45 min left" / "under a minute left". Rounds UP so a
 * restriction never reads as already over while it still applies; a lapsed or
 * unknown time returns ''.
 */
export function formatTimeLeft(until: number, now: number = Date.now()): string {
    const ms = until - now;
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const min = Math.ceil(ms / 60_000);
    if (min <= 1) return 'under a minute left';
    if (min < 60) return `${min} min left`;
    const h = Math.ceil(min / 60);
    return `${h} h left`;
}

export type VoiceModerationBit = 'muted' | 'deafened';

/** "Server muted · 23 h left" - the tooltip on a badge. The countdown part is
 *  omitted when the viewer is not a moderator / has no expiry on hand. */
export function describeVoiceModeration(bit: VoiceModerationBit, until: number | null | undefined, now: number = Date.now()): string {
    const label = bit === 'muted' ? 'Server muted' : 'Server deafened';
    const left = until ? formatTimeLeft(until, now) : '';
    return left ? `${label} · ${left}` : label;
}

/** Context-menu label for removing one: "Remove server mute · 23 h left". */
export function removeVoiceModerationLabel(bit: VoiceModerationBit, until: number | null | undefined, now: number = Date.now()): string {
    const base = bit === 'muted' ? 'Remove Server Mute' : 'Remove Server Deafen';
    const left = until ? formatTimeLeft(until, now) : '';
    return left ? `${base} · ${left}` : base;
}

/** Minimal HTTP surface so the fetch/remove helpers are testable without axios. */
export interface VoiceModerationHttp {
    get(url: string, config: { headers: Record<string, string> }): Promise<{ data: unknown }>;
    patch(url: string, body: unknown, config: { headers: Record<string, string> }): Promise<{ data: unknown }>;
}

export async function fetchServerVoiceModeration(
    http: VoiceModerationHttp,
    apiBase: string,
    token: string,
    serverId: string,
): Promise<void> {
    const res = await http.get(apiBase + apiPath`/servers/${serverId}/voice-moderation`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    setServerVoiceModeration(serverId, res.data);
}

/**
 * Remove a server mute / deafen from a member WITHOUT naming a call - works
 * while they are not in voice at all (and, if they are in one, the server
 * restores their live grants). Updates the local list on success.
 */
export async function removeServerVoiceModeration(
    http: VoiceModerationHttp,
    apiBase: string,
    token: string,
    serverId: string,
    userId: string,
    bit: VoiceModerationBit,
): Promise<void> {
    await http.patch(
        apiBase + apiPath`/servers/${serverId}/members/${userId}/call-mute`,
        { track_type: bit === 'muted' ? 'audio' : 'deafen', muted: false },
        { headers: { Authorization: `Bearer ${token}` } },
    );
    clearServerVoiceModerationBit(serverId, userId, bit);
}

/** Refresh interval while a moderator has the server open: the countdown is
 *  computed locally, this only picks up other moderators' changes and expiries. */
export const VOICE_MODERATION_REFRESH_MS = 5 * 60_000;
const REFETCH_DEBOUNCE_MS = 800;

/**
 * Keep a server's moderator list loaded while `enabled` (the viewer holds
 * MODERATE_CALL_MEDIA): fetch on open, refetch when presence reports that
 * someone's server mute / deafen changed (another moderator acted, or a
 * restriction was applied / removed), and on a slow timer. Errors are silent -
 * the list is a convenience layer over the badges.
 */
export function useServerVoiceModerationFeed(opts: {
    serverId: string | null | undefined;
    enabled: boolean;
    load: () => Promise<void>;
}): void {
    const { serverId, enabled, load } = opts;
    const loadRef = useRef(load);
    loadRef.current = load;
    useEffect(() => {
        if (!enabled || !serverId) return;
        let cancelled = false;
        let debounce: ReturnType<typeof setTimeout> | null = null;
        const run = () => { if (!cancelled) loadRef.current().catch(() => { /* convenience layer */ }); };
        run();
        const timer = setInterval(run, VOICE_MODERATION_REFRESH_MS);
        const off = onServerModerationPresenceChange(() => {
            if (debounce) clearTimeout(debounce);
            debounce = setTimeout(run, REFETCH_DEBOUNCE_MS);
        });
        return () => {
            cancelled = true;
            clearInterval(timer);
            if (debounce) clearTimeout(debounce);
            off();
        };
    }, [serverId, enabled]);
}

/** Tests only. */
export function __resetServerVoiceModeration(): void {
    const ids = [...byServer.keys()];
    byServer.clear();
    ids.forEach(notify);
}

/**
 * Tooltips for a participant's server mute / deafen badges: "Server muted ·
 * 23 h left" for a moderator (who has the expiry), plain "Server muted" for
 * everyone else. Re-renders when the moderator list changes.
 */
export function useVoiceModerationTitles(
    serverId: string | null | undefined,
    userId: string,
): { muted: string; deafened: string } {
    useServerVoiceModerationVersion(serverId);
    const t = getServerVoiceModeration(serverId, userId);
    return {
        muted: describeVoiceModeration('muted', t.mutedUntil),
        deafened: describeVoiceModeration('deafened', t.deafenedUntil),
    };
}
