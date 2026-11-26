/**
 * The own-device transfer trail for "Report a problem".
 *
 * WHY. The 2026-11-26 report sent right after a failed PC to phone history transfer held nothing about the transfer: the perf log is
 * main's FreezeMonitor ring and nothing near / own-device ever wrote to it, so a failed transfer was undiagnosable. This records, per
 * attempt, a short trail of `near:<step>` events into that same ring (`FreezeMonitor.event`), so it rides in the existing `perf_log`
 * (and, when the app dies, in `previous_session`, which keeps the newest `near:` rows: `previous-session.ts`) with no wire change.
 *
 * WHAT IS RECORDED (counts, booleans and words from closed sets, nothing else):
 *   helper_spawned / helper_ready / helper_exited exit=<n> / helper_unavailable why=...
 *   request                         this device asked another one for its history
 *   offer_sent / answer_sent        the control messages that left this device (type only)
 *   offer_received result=offer|replaced|busy|ignored      answer_received result=routed|ignored
 *   state role=sender|receiver state=<engine state>        (one row per change)
 *   sheet_shown                     the "Send your chat history?" sheet is up (holder)
 *   prompt_shown method=password|totp / prompt_unavailable / password_result result=ok|wrong|locked|other / prompt_closed verdict=... why=...
 *   approve result=approved|cancelled|failed / refuse / cancel
 *   capabilities usable=<0|1> peer_usable=<0|1> plan=... elig= wifi= eth= unk= filt= virt= vpn= unres=
 *   lan same_subnet=<0|1> dials=<n> result=<dial result> fail=<cause>
 *   transfer bytes= bytes_total= recs= recs_total= tries=
 *   outcome role= state= cause= code=
 * NEVER: an IP address, a MAC, an SSID, an adapter or device name, a user id, a token or any message content. Enforced twice: every field
 * has a schema (a key that is not listed, or a value outside its closed set, is DROPPED, not coerced) and the report's scrubber still runs
 * over the rows afterwards. `near-diag.test.ts` and `scrub.test.ts` pin both.
 *
 * No `electron` import: the sink is injected (main wires `freezeMonitor.event`), so this is unit-tested without Electron.
 */

export interface NearTrailSink {
    event(name: string, ms?: number, detail?: string): void;
}

export type HelperLifecycle =
    | { kind: 'spawned' }
    | { kind: 'ready' }
    | { kind: 'exited'; code: number | null; signal: string | null }
    | { kind: 'unavailable'; why: 'no_binary' | 'spawn_failed' | 'not_ready' | 'handshake' };

export interface NearTrail {
    /** One step of the trail. Unknown steps and fields are dropped. Never throws. */
    record(step: string, fields?: Record<string, unknown>): void;
    /** Feed every engine snapshot (the helper's `state` lines); records the changes worth knowing. */
    onState(snapshot: unknown): void;
    onHelper(e: HelperLifecycle): void;
}

const words = (...w: string[]): ReadonlySet<string> => new Set(w);
const STATES = words('idle', 'creating_session', 'awaiting_approval', 'approving', 'approved', 'peer_connected', 'negotiating', 'proving_lan', 'proof_verified', 'transferring', 'transfer_paused', 'done', 'refused', 'expired', 'cancelled', 'failed');
/** Every `NearDiag.cause` the engine can say (`near-engine/src/state.rs`), plus `other` for anything newer. */
export const NEAR_CAUSES = words('ok', 'declined', 'busy', 'cancelled', 'peer_cancelled', 'different_network', 'no_usable_network', 'peer_no_usable_network', 'no_answer', 'not_found', 'denied', 'firewall', 'expired', 'refused', 'failed', 'other');
const LAN_RESULTS = words('ok', 'off_link', 'bad_offer', 'timeout', 'refused', 'blocked', 'auth', 'tls', 'io', 'listen_timeout', 'listen_blocked', 'no_offer', 'other');
const ERROR_CODES = words('peer_cancelled', 'own_no_answer', 'own_no_decision', 'no_proximity', 'denied', 'busy', 'bad_answer', 'keys', 'lan_blocked', 'near_error', 'peer_error', 'helper_exited', 'internal', 'assemble', 'session_expired', 'expired', 'bad_caps', 'other');
const SIGNALS = words('SIGTERM', 'SIGKILL', 'SIGINT', 'SIGSEGV', 'SIGABRT', 'SIGHUP', 'other');

/** key -> allowed values (a closed set), or 'int' (a finite non-negative integer) or 'bool' (rendered 1 / 0). */
const SCHEMA: Record<string, ReadonlySet<string> | 'int' | 'bool'> = {
    role: words('sender', 'receiver', 'none'),
    state: STATES,
    type: words('near_offer', 'near_answer'),
    result: words('offer', 'replaced', 'busy', 'ignored', 'routed', 'approved', 'cancelled', 'failed', 'ok', 'wrong', 'locked', 'other', ...LAN_RESULTS),
    method: words('password', 'totp'),
    verdict: words('approved', 'declined'),
    why: words('submit', 'timeout', 'cancel', 'session_end', 'no_binary', 'spawn_failed', 'not_ready', 'handshake'),
    cause: NEAR_CAUSES,
    fail: NEAR_CAUSES,
    code: ERROR_CODES,
    plan: words('listen', 'dial', 'none'),
    sig: SIGNALS,
    exit: 'int',
    usable: 'bool', peer_usable: 'bool', same_subnet: 'bool',
    elig: 'int', wifi: 'int', eth: 'int', unk: 'int', filt: 'int', virt: 'int', vpn: 'int', unres: 'int',
    dials: 'int', bytes: 'int', bytes_total: 'int', recs: 'int', recs_total: 'int', tries: 'int',
};
/** Detail the freeze monitor accepts (`DETAIL_RE`) is checked again there; this is the budget we stay under. */
const MAX_DETAIL = 200;
const STEPS = new Set([
    'helper_spawned', 'helper_ready', 'helper_exited', 'helper_unavailable', 'request', 'request_failed', 'offer_sent', 'answer_sent', 'offer_received', 'answer_received',
    'state', 'sheet_shown', 'prompt_shown', 'prompt_unavailable', 'password_result', 'prompt_closed', 'approve', 'refuse', 'cancel',
    'capabilities', 'lan', 'transfer', 'outcome',
]);

/** `k=v k=v` for the fields that pass their schema; '' when none. Exported for the tests. */
export function formatTrailDetail(fields: Record<string, unknown> | undefined): string {
    if (!fields) return '';
    const parts: string[] = [];
    for (const [k, raw] of Object.entries(fields)) {
        const rule = Object.prototype.hasOwnProperty.call(SCHEMA, k) ? SCHEMA[k] : undefined;
        if (rule === undefined || raw === undefined || raw === null) continue;
        let v: string | null = null;
        if (rule === 'bool') v = typeof raw === 'boolean' ? (raw ? '1' : '0') : null;
        else if (rule === 'int') v = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1e13 ? String(Math.round(raw)) : null;
        else v = typeof raw === 'string' && rule.has(raw) ? raw : null;
        if (v === null) continue;
        const part = `${k}=${v}`;
        if (parts.join(' ').length + part.length + 1 > MAX_DETAIL) break;
        parts.push(part);
    }
    return parts.join(' ');
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
/** A word from a closed set, else `other` (a newer engine may say something this build does not know: never forwarded raw). */
const closed = (v: unknown, set: ReadonlySet<string>): string | undefined => (typeof v === 'string' && v.length > 0 ? (set.has(v) ? v : 'other') : undefined);

export function createNearTrail(sink: NearTrailSink): NearTrail {
    const record = (step: string, fields?: Record<string, unknown>): void => {
        if (!STEPS.has(step)) return;
        try { sink.event(`near:${step}`, 0, formatTrailDetail(fields) || undefined); } catch { /* diagnostics never break a transfer */ }
    };

    // What this session already said, so a re-sent snapshot is not a new row.
    let lastKey = '';
    let capsSeen = false;
    let lanKey = '';
    let outcomeSeen = false;
    const resetSession = () => { lastKey = ''; capsSeen = false; lanKey = ''; outcomeSeen = false; };

    return {
        record,
        onHelper(e) {
            switch (e.kind) {
                case 'spawned': record('helper_spawned'); break;
                case 'ready': record('helper_ready'); break;
                case 'exited': record('helper_exited', { exit: e.code === null ? undefined : e.code, sig: e.signal === null ? undefined : (SIGNALS.has(e.signal) ? e.signal : 'other') }); break;
                case 'unavailable': record('helper_unavailable', { why: e.why }); break;
            }
        },
        onState(snapshot) {
            if (!isObj(snapshot)) return;
            const state = typeof snapshot.state === 'string' ? snapshot.state : '';
            if (!STATES.has(state)) return;
            const role = snapshot.role === 'own_sender' ? 'sender' : snapshot.role === 'own_receiver' ? 'receiver' : 'none';
            if (state === 'creating_session' || state === 'idle') resetSession();
            const key = `${role}:${state}`;
            if (key !== lastKey) {
                lastKey = key;
                // idle is the engine's own housekeeping between sessions
                if (state !== 'idle') record('state', { role, state });
                if (role === 'sender' && state === 'awaiting_approval') record('sheet_shown', { role });
            }
            const d = isObj(snapshot.diag) ? snapshot.diag : null;
            if (d) {
                const a = isObj(d.adapters) ? d.adapters : null;
                if (a && !capsSeen) {
                    capsSeen = true;
                    record('capabilities', {
                        usable: bool(d.lanUsable), peer_usable: bool(d.peerLan), plan: closed(d.lanPlan, words('listen', 'dial', 'none')),
                        elig: num(a.eligible), wifi: num(a.wifi), eth: num(a.ethernet), unk: num(a.unknown),
                        filt: num(a.filtered), virt: num(a.filteredVirtual), vpn: num(a.filteredVpn), unres: num(a.filteredUnresolved),
                    });
                }
                const lanResult = closed(d.lanResult, LAN_RESULTS);
                if (lanResult) {
                    const fail = closed(d.lanFail, NEAR_CAUSES);
                    const k = `${lanResult}:${fail ?? ''}:${String(d.sameSubnet)}`;
                    if (k !== lanKey) {
                        lanKey = k;
                        record('lan', { same_subnet: bool(d.sameSubnet), dials: num(d.dialAttempts), result: lanResult, fail });
                    }
                }
            }
            const terminal = state === 'done' || state === 'refused' || state === 'expired' || state === 'cancelled' || state === 'failed';
            if (terminal && !outcomeSeen) {
                outcomeSeen = true;
                const t = isObj(snapshot.transfer) ? snapshot.transfer : null;
                if (t) record('transfer', { bytes: num(t.bytesDone), bytes_total: num(t.bytesTotal), recs: num(t.recordsDone), recs_total: num(t.recordsTotal), tries: num(t.attempt) });
                const err = isObj(snapshot.error) ? snapshot.error : null;
                record('outcome', { role, state, cause: closed(d?.cause, NEAR_CAUSES), code: closed(err?.code, ERROR_CODES) });
            }
        },
    };
}
