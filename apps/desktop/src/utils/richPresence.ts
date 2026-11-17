/**
 * Rich Presence detail lines — the client model, wire parsing and formatting.
 *
 * Where it comes from: a game or launcher on THIS computer announces what you
 * are doing over the local Rich Presence endpoint (electron/rpc-ipc-server.ts),
 * validated in main (electron/rpc-activity.ts) and again at the bridge
 * (electron/preload.ts toBridgeGame). Your own detail is shown locally; it is
 * shared with others ONLY while both "Share what you're playing" and "Share
 * game details" are on, over `presence:game_detail` (the API validates and caps
 * it again: apps/api/src/gateway/presence.logic.ts normalizeGameDetail), and
 * reaches exactly the audience that already sees your game name.
 *
 * What is never here: images from the app (asset keys / URLs are data in main
 * and never fetched — the picture is our own game art), buttons, and secrets.
 */

/** Same caps as main and the API. */
export const DETAIL_TEXT_MAX = 128;
export const PARTY_MAX = 1_000_000;
/** Timestamps further than this from now are dropped (API: GAME_DETAIL_MAX_SKEW_MS). */
export const DETAIL_TS_SKEW_MS = 30 * 24 * 60 * 60 * 1000;

export interface GameDetail {
    details: string | null;
    state: string | null;
    partySize: number | null;
    partyMax: number | null;
    /** Epoch ms. */
    start: number | null;
    /** Epoch ms. */
    end: number | null;
}

/** What the preload bridge delivers for `game:detected` / `getCurrentGame()`. */
export interface BridgeGame {
    name: string;
    processName: string;
    source: 'process' | 'rpc';
    detail: GameDetail | null;
}

/** The wire shape (`presence:game_detail` up, `game_detail` down). */
export interface WireGameDetail {
    details?: string | null;
    state?: string | null;
    party_size?: number | null;
    party_max?: number | null;
    start?: number | null;
    end?: number | null;
}

const text = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() && v.trim().length <= DETAIL_TEXT_MAX ? v.trim() : null;
const int = (v: unknown, lo: number, hi: number): number | null =>
    typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null;

function build(details: unknown, state: unknown, size: unknown, max: unknown, start: unknown, end: unknown, now: number): GameDetail | null {
    const partyMax = int(max, 1, PARTY_MAX);
    const partySize = partyMax !== null ? int(size, 0, partyMax) : null;
    const ts = (v: unknown) => {
        const n = int(v, 1, 8.64e15);
        return n !== null && Math.abs(n - now) <= DETAIL_TS_SKEW_MS ? n : null;
    };
    const d: GameDetail = {
        details: text(details),
        state: text(state),
        partySize,
        partyMax: partySize !== null ? partyMax : null,
        start: ts(start),
        end: ts(end),
    };
    return isEmptyDetail(d) ? null : d;
}

export function isEmptyDetail(d: GameDetail | null | undefined): boolean {
    return !d || (!d.details && !d.state && d.partyMax === null && d.start === null && d.end === null);
}

/** A `game_detail` from the server (a friend's). Anything malformed → null. */
export function parseWireGameDetail(v: unknown, now: number = Date.now()): GameDetail | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    return build(o.details, o.state, o.party_size, o.party_max, o.start, o.end, now);
}

/** A bridge detail (own). Same rules; never trusts the shape blindly. */
export function parseBridgeDetail(v: unknown, now: number = Date.now()): GameDetail | null {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    return build(o.details, o.state, o.partySize, o.partyMax, o.start, o.end, now);
}

export function toWireGameDetail(d: GameDetail): WireGameDetail {
    return {
        details: d.details, state: d.state,
        party_size: d.partySize, party_max: d.partyMax,
        start: d.start, end: d.end,
    };
}

export function sameWireDetail(a: WireGameDetail | null | undefined, b: WireGameDetail | null | undefined): boolean {
    if (!a || !b) return !a && !b;
    return (a.details ?? null) === (b.details ?? null) && (a.state ?? null) === (b.state ?? null)
        && (a.party_size ?? null) === (b.party_size ?? null) && (a.party_max ?? null) === (b.party_max ?? null)
        && (a.start ?? null) === (b.start ?? null) && (a.end ?? null) === (b.end ?? null);
}

export function sameDetail(a: GameDetail | null | undefined, b: GameDetail | null | undefined): boolean {
    if (!a || !b) return !a && !b;
    return a.details === b.details && a.state === b.state && a.partySize === b.partySize
        && a.partyMax === b.partyMax && a.start === b.start && a.end === b.end;
}

/** "Party 2 of 5", or null. */
export function partyLine(d: GameDetail | null | undefined): string | null {
    return d && d.partyMax !== null && d.partySize !== null ? `Party ${d.partySize} of ${d.partyMax}` : null;
}

export function clock(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "12:34 elapsed" / "3:05 left", or null. A countdown wins while it is running. */
export function timeLine(d: GameDetail | null | undefined, now: number): string | null {
    if (!d) return null;
    if (d.end !== null && d.end > now) return `${clock(d.end - now)} left`;
    if (d.start !== null && d.start <= now) return `${clock(now - d.start)} elapsed`;
    return null;
}

/** The lines under the game's name, in display order. */
export function detailLines(d: GameDetail | null | undefined, now: number): string[] {
    if (!d) return [];
    return [d.details, d.state, partyLine(d), timeLine(d, now)].filter((x): x is string => !!x);
}

/** One line for a tooltip / compact row: "Ranked • Round 3 · Score 2 – 1". */
export function detailSummary(d: GameDetail | null | undefined): string | null {
    if (!d) return null;
    const parts = [d.details, d.state].filter((x): x is string => !!x);
    return parts.length ? parts.join(' · ') : partyLine(d);
}

/** Does this detail need a once-a-second tick to stay right? */
export const needsTick = (d: GameDetail | null | undefined): boolean => !!d && (d.start !== null || d.end !== null);

/**
 * "What friends see" (Settings > Game Activity): exactly the lines that leave
 * this device right now - nothing (sharing off), the name only (details off),
 * or the name plus these lines. The same values useUserStatus sends: the name
 * over presence:game, the detail over presence:game_detail only while
 * shareGameDetails is on.
 */
export function sharedPreviewLines(game: string | null, detail: GameDetail | null, share: boolean, shareDetails: boolean, now: number): string[] | null {
    if (!game || !share) return null;
    return [`Playing ${game}`, ...(shareDetails ? detailLines(detail, now) : [])];
}
