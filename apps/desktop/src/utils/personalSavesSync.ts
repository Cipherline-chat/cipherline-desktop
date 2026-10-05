/**
 * personalSavesSync — the private saves that follow you between your devices.
 *
 * Two kinds of private bookmark, one snapshot:
 *
 *   conversation   DM/group personal pins (`cipherline_pinned_{uid}` + its
 *                  ledger `cipherline_pin_ledger_{uid}`)
 *   channel        channel "Save for me" (`cipherline_local_channel_pins_{uid}`
 *                  + `cipherline_local_channel_pin_ledger_{uid}`)
 *
 * Live DM pin ops still travel as `pin` envelopes to your online devices
 * (pinSync.ts); this snapshot is what a brand-new device, or one offline past
 * the 30-day envelope sweep, catches up from, and it is the ONLY path a
 * channel save has — a channel belongs to no conversation, so a `pin`
 * envelope cannot carry it (and must not: old clients would misfile it).
 *
 * It travels as an own-device slot (`personal_saves`, magic "CLSAV1"; see
 * ownSlotSync.ts). This module is the pure part: the payload shape, its
 * validation, and a commutative last-write-wins merge over the exact
 * `PinMap`/`PinLedger` shapes pinSync.ts already uses, so the renderer, the
 * backup vault and sweepRetention keep reading what they read today.
 *
 *   msg in pins[c]              → saved,   at ledger[c][msg] (0 if none)
 *   msg in ledger[c], not pins  → TOMBSTONE, removed at ledger[c][msg]
 *
 * Newer timestamp wins; an exact tie keeps the save (the data-preserving side
 * of a coin flip); a side that never heard of an id cannot outvote one that
 * has. A pin with no ledger entry (pinned before the ledger existed) counts as
 * time 0: it loses only to a genuine remote unpin of that same message, which
 * is the right answer.
 *
 * Mobile's port (cipherline-mobile src/features/own-sync/personalSaves.ts) is
 * checked against this file by scripts/interop/own-slot-protocol.mjs.
 */

import type { PinLedger, PinMap } from './pinSync';
import { isSafeSyncId } from './ownSlotSync';

export const PERSONAL_SAVES_SLOT = 'personal_saves';
export const SAVES_SNAPSHOT_MAGIC = 'CLSAV1';
export const SAVES_PAYLOAD_VERSION = 1;

/** Upper bound on saved ids per scope in one snapshot. Far beyond any real
 *  use; exists so a hostile or corrupt payload cannot balloon memory. */
export const MAX_SAVES_PER_SCOPE = 20_000;

export interface PinScopeState {
    pins: PinMap;
    ledger: PinLedger;
}

export interface SavesState {
    conversation: PinScopeState;
    channel: PinScopeState;
}

export interface SavesPayload extends SavesState {
    v: number;
    /** Wall clock of the writer. Diagnostics only — merge uses the ledgers. */
    writtenAt: number;
}

export const emptyScope = (): PinScopeState => ({ pins: {}, ledger: {} });
export const emptySaves = (): SavesState => ({ conversation: emptyScope(), channel: emptyScope() });

// ── merge ───────────────────────────────────────────────────────────────────

function containersOf(s: PinScopeState): Set<string> {
    return new Set([...Object.keys(s.pins), ...Object.keys(s.ledger)]);
}

const finiteOr = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : Number.NEGATIVE_INFINITY;

/** Effective (present, at) for one message on one side, or null if unheard of. */
function sideOf(s: PinScopeState, c: string, m: string): { present: boolean; at: number } | null {
    const present = (s.pins[c] ?? []).includes(m);
    const led = s.ledger[c]?.[m];
    const at = typeof led === 'number' && Number.isFinite(led) ? led : undefined;
    if (!present && at === undefined) return null;
    return { present, at: at ?? 0 };
}

/**
 * Merge two scopes. Commutative and idempotent as SETS (see sameScope): which
 * messages are saved and at what time never depends on argument order. List
 * ORDER follows `a` first, so merging a remote snapshot into local state keeps
 * the local pin order the UI shows and appends what is new.
 */
export function mergeScope(a: PinScopeState, b: PinScopeState): PinScopeState {
    const pins: PinMap = {};
    const ledger: PinLedger = {};
    const containers = new Set([...containersOf(a), ...containersOf(b)]);

    for (const c of containers) {
        const ids = new Set<string>([
            ...(a.pins[c] ?? []), ...Object.keys(a.ledger[c] ?? {}),
            ...(b.pins[c] ?? []), ...Object.keys(b.ledger[c] ?? {}),
        ]);
        const live: string[] = [];
        const led: Record<string, number> = {};
        for (const m of ids) {
            const x = sideOf(a, c, m);
            const y = sideOf(b, c, m);
            if (!x && !y) continue;
            let win: { present: boolean; at: number };
            if (!x) win = y!;
            else if (!y) win = x;
            else if (x.at !== y.at) win = x.at > y.at ? x : y;
            else win = { present: x.present || y.present, at: x.at };

            if (win.present) live.push(m);
            // Keep a timestamp for tombstones always, and for saves whenever one
            // exists. A 0 is "no ledger entry" — writing it would invent one.
            const ts = Math.max(finiteOr(a.ledger[c]?.[m]), finiteOr(b.ledger[c]?.[m]));
            if (Number.isFinite(ts)) led[m] = ts;
        }
        if (live.length > 0) pins[c] = live;
        if (Object.keys(led).length > 0) ledger[c] = led;
    }
    return { pins, ledger };
}

export function mergeSaves(a: SavesState, b: SavesState): SavesState {
    return {
        conversation: mergeScope(a.conversation, b.conversation),
        channel: mergeScope(a.channel, b.channel),
    };
}

/** Order-insensitive equality: same saved set, same timestamps. */
export function sameScope(a: PinScopeState, b: PinScopeState): boolean {
    const norm = (s: PinScopeState) => {
        const live: string[] = [];
        for (const [c, ids] of Object.entries(s.pins)) for (const m of ids) live.push(`${c}\u0000${m}`);
        const led: string[] = [];
        for (const [c, row] of Object.entries(s.ledger)) for (const [m, at] of Object.entries(row)) led.push(`${c}\u0000${m}\u0000${at}`);
        return `${live.sort().join('\u0001')}\u0002${led.sort().join('\u0001')}`;
    };
    return norm(a) === norm(b);
}

export function sameSaves(a: SavesState, b: SavesState): boolean {
    return sameScope(a.conversation, b.conversation) && sameScope(a.channel, b.channel);
}

export function isEmptySaves(s: SavesState): boolean {
    return Object.keys(s.conversation.pins).length === 0 && Object.keys(s.conversation.ledger).length === 0
        && Object.keys(s.channel.pins).length === 0 && Object.keys(s.channel.ledger).length === 0;
}

/** Saves present in `after` but not `before`, per scope — what a caller must
 *  act on locally (desktop marks a newly-pinned DM message save-forever). */
export function addedSaves(before: PinScopeState, after: PinScopeState): { container_id: string; message_id: string }[] {
    const out: { container_id: string; message_id: string }[] = [];
    for (const [c, ids] of Object.entries(after.pins)) {
        const had = new Set(before.pins[c] ?? []);
        for (const m of ids) if (!had.has(m)) out.push({ container_id: c, message_id: m });
    }
    return out;
}

// ── payload ─────────────────────────────────────────────────────────────────

/**
 * Coerce an untrusted scope into a well-formed one. Unknown shapes are dropped,
 * never repaired; ids must be safe (they end up as map keys and, on mobile,
 * as database keys); timestamps must be finite; the scope is capped.
 */
export function sanitizeScope(raw: unknown): PinScopeState {
    const out = emptyScope();
    if (!raw || typeof raw !== 'object') return out;
    const r = raw as { pins?: unknown; ledger?: unknown };
    let budget = MAX_SAVES_PER_SCOPE;

    if (r.pins && typeof r.pins === 'object' && !Array.isArray(r.pins)) {
        for (const [c, ids] of Object.entries(r.pins as Record<string, unknown>)) {
            if (!isSafeSyncId(c) || !Array.isArray(ids)) continue;
            const clean = [...new Set(ids.filter(isSafeSyncId))].slice(0, Math.max(0, budget));
            budget -= clean.length;
            if (clean.length > 0) out.pins[c] = clean.sort();
        }
    }
    budget = MAX_SAVES_PER_SCOPE;
    if (r.ledger && typeof r.ledger === 'object' && !Array.isArray(r.ledger)) {
        for (const [c, row] of Object.entries(r.ledger as Record<string, unknown>)) {
            if (!isSafeSyncId(c) || !row || typeof row !== 'object' || Array.isArray(row)) continue;
            const clean: Record<string, number> = {};
            for (const [m, at] of Object.entries(row as Record<string, unknown>)) {
                if (budget <= 0) break;
                if (!isSafeSyncId(m) || typeof at !== 'number' || !Number.isFinite(at) || at < 0) continue;
                clean[m] = at;
                budget--;
            }
            if (Object.keys(clean).length > 0) out.ledger[c] = clean;
        }
    }
    return out;
}

export function parseSavesPayload(json: string): SavesPayload {
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { throw new Error('Saves snapshot payload is not valid JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Saves snapshot payload is not an object');
    const raw = parsed as Record<string, unknown>;
    if (raw.v !== SAVES_PAYLOAD_VERSION) throw new Error(`Unsupported saves payload version ${String(raw.v)}`);
    return {
        v: SAVES_PAYLOAD_VERSION,
        writtenAt: typeof raw.writtenAt === 'number' && Number.isFinite(raw.writtenAt) ? raw.writtenAt : 0,
        conversation: sanitizeScope(raw.conversation),
        channel: sanitizeScope(raw.channel),
    };
}

export function buildSavesPayload(state: SavesState, now: number): SavesPayload {
    return {
        v: SAVES_PAYLOAD_VERSION,
        writtenAt: now,
        conversation: sanitizeScope(state.conversation),
        channel: sanitizeScope(state.channel),
    };
}
