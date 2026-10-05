/**
 * channelServerSaves — the client's view of which channel messages are
 * SERVER-SAVED and which of those are PINNED.
 *
 * Server model (apps/api PinsService): one row per saved message, with
 * `is_pinned` marking the pinned subset. Every pinned message is saved, so
 * `pinned ⊆ saved` always holds. GET /v1/channels/:cid/saves returns every
 * saved row (pinned or not) in one request; GET /pins returns only pinned.
 *
 * Both lists are derived from ONE /saves response so they can never be out
 * of step with each other.
 *
 * Deploy-order fallback: a desktop build can reach an API that predates
 * /saves (a staging build against an older API, or during a rolling deploy).
 * There, saving and pinning were still one action, so every /pins row is
 * both saved and pinned — the old semantics exactly.
 */
import axios from 'axios';

export interface ChannelSaveState {
    /** Every server-saved message id (pinned or not). */
    saved: string[];
    /** The pinned subset. Always contained in `saved`. */
    pinned: string[];
}

interface SaveRow {
    message_id?: unknown;
    is_pinned?: unknown;
}

/**
 * Build the state from a /saves response. A row with no `is_pinned` field is
 * treated as pinned — that is what every row meant before the field existed.
 * Rows without a string message_id are dropped rather than trusted.
 */
export function saveStateFromRows(rows: unknown): ChannelSaveState {
    const saved: string[] = [];
    const pinned: string[] = [];
    if (!Array.isArray(rows)) return { saved, pinned };
    for (const r of rows as SaveRow[]) {
        if (!r || typeof r.message_id !== 'string') continue;
        if (!saved.includes(r.message_id)) saved.push(r.message_id);
        if (r.is_pinned !== false && !pinned.includes(r.message_id)) pinned.push(r.message_id);
    }
    return { saved, pinned };
}

/** Legacy /pins response (an API without /saves): every pin is a save. */
export function saveStateFromLegacyPins(rows: unknown): ChannelSaveState {
    const ids = Array.isArray(rows)
        ? [...new Set((rows as SaveRow[])
            .map(r => r?.message_id)
            .filter((id): id is string => typeof id === 'string'))]
        : [];
    return { saved: ids, pinned: [...ids] };
}

/**
 * GET the saved + pinned state for one channel. Throws on failure (callers
 * already treat that as non-fatal and keep their previous state).
 */
export async function fetchChannelSaveState(
    apiBase: string,
    channelId: string,
    token: string,
): Promise<ChannelSaveState> {
    const headers = { Authorization: `Bearer ${token}` };
    try {
        const res = await axios.get(`${apiBase}/channels/${channelId}/saves`, { headers });
        return saveStateFromRows(res.data);
    } catch (err: unknown) {
        if (asSaveRequestError(err).response?.status !== 404) throw err;
        const res = await axios.get(`${apiBase}/channels/${channelId}/pins`, { headers });
        return saveStateFromLegacyPins(res.data);
    }
}

/** The bits of an axios error the save/pin handlers branch on. */
export interface SaveRequestError {
    response?: { status?: number; data?: { code?: string; limit_bytes?: number; storage_plan?: string } };
}

/** Narrow an unknown thrown value to the fields callers read. */
export const asSaveRequestError = (err: unknown): SaveRequestError =>
    (err && typeof err === 'object' ? err : {}) as SaveRequestError;

/** Optimistic helpers — pure, so Dashboard's handlers stay one-liners. */
export const withId = (list: string[] | undefined, id: string): string[] =>
    (list ?? []).includes(id) ? (list ?? []) : [...(list ?? []), id];

export const withoutId = (list: string[] | undefined, id: string): string[] =>
    (list ?? []).filter(x => x !== id);
