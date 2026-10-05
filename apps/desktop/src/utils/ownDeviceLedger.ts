/**
 * Own-device ledger: this install's local memory of which devices belong to
 * the signed-in account. The fix for the "ghost device" gap.
 * The full argument is in docs/ghost-device.md.
 *
 * ── The gap ─────────────────────────────────────────────────────────────────
 *
 * The contact code (`verificationCode.ts`) commits to a device SET, and both
 * sides of the comparison read that set from the key directory. "Your code"
 * came from `GET /keys/identity_keys?user_id=<me>`, and nothing checked that
 * listing against anything local. A server (or anyone holding the password)
 * that adds a device to Bob's account and lists it in BOTH views makes Bob's
 * code and Alice's code for Bob commit to the same wrong set. They match, and
 * no computation is needed. The ghost then receives every DM in both
 * directions, every `call_key`, and every channel key Bob's devices are served.
 *
 * ── Why this closes it ──────────────────────────────────────────────────────
 *
 * To pass the code comparison the ghost must be in Bob's OWN listing too. A
 * split view (hidden from Bob, shown to Alice) makes the two codes differ.
 * Bob's own client is therefore always shown the ghost, and this ledger is
 * what lets it notice:
 *
 *   • every own device id is remembered with its identity key;
 *   • an id never seen before is `pending` and raises an alarm;
 *   • "your code" is WITHHELD while any device it would cover is not
 *     confirmed (`assessOwnDeviceSet`), and that check runs on the SAME array
 *     the code is computed from, so there is no gap between them;
 *   • this device's own key must appear in the listing under this device's
 *     id. Before this, a server could substitute THIS device's key in both
 *     views and the codes still matched.
 *
 * ── What the server can still do ────────────────────────────────────────────
 *
 * The first COMPLETE listing seen by an install with no ledger becomes the
 * baseline (trust on first use). A ghost that is already present at that
 * moment is accepted. The one-time baseline review (`reviewed: false`) is the
 * human check for exactly that moment. See docs/ghost-device.md §5.
 *
 * ── Rules this module keeps ─────────────────────────────────────────────────
 *
 *   • A listing never changes a pinned pub. A different pub for a known id is
 *     REPORTED (`own_key_changed`), never adopted. Only an explicit user
 *     confirmation re-pins.
 *   • A PARTIAL listing (own rows inside `/conversations/:id/devices`) can add
 *     `pending` records but can never CREATE the ledger. Baselining from a
 *     partial view would accept whatever subset the server chose to show.
 *   • Nothing is read or written before `secureLocalStore.isAccountReady`.
 *     A cold per-account read returns empty. Treating that as "no ledger yet"
 *     would re-baseline over real state, silently accepting whatever is
 *     listed at that instant.
 *   • This device's record always carries the LOCAL key, never a listed one.
 */

import { secureLocalStore } from './secureLocalStore';
import type { DirectoryEntry } from './deviceDirectory';

export const OWN_LEDGER_PREFIX = 'kv_own_devices_v1_';

/** Hard cap on stored records. A server that invents thousands of device ids
 *  must not be able to grow encrypted storage (and backups) without bound.
 *  An id beyond the cap is not stored, but the assessment still reports it,
 *  because an unrecorded device counts as unconfirmed. */
export const MAX_OWN_DEVICES = 64;

export type OwnDeviceStatus =
    /** Present in the first complete listing this install saw. Accepted by TOFU. */
    | 'baseline'
    /** The user said "this is mine", or it is this device. */
    | 'confirmed'
    /** Appeared after the baseline. Nobody has vouched for it. The alarm. */
    | 'pending'
    /** The user said "not mine". Stays an alarm while it is still listed. */
    | 'rejected';

export interface OwnDeviceRecord {
    pub: string;
    status: OwnDeviceStatus;
    first_seen: number;
    /** `baseline` only: the one-time "these are your devices" review was answered. */
    reviewed?: boolean;
    /** Last time a complete listing did NOT include this device. Cleared when it reappears. */
    gone_at?: number;
}

export interface OwnLedger {
    v: 1;
    created_at: number;
    devices: Record<string, OwnDeviceRecord>;
}

export interface ListedDevice {
    device_id: string;
    pub: string;
}

export interface SelfIdentity {
    deviceId: string;
    pub: string;
}

export interface CoveredDevice extends ListedDevice {
    isSelf: boolean;
    /** Ledger status, or 'unknown' when the ledger has no record for it. */
    status: OwnDeviceStatus | 'unknown';
}

export type OwnSetVerdict =
    /** Everything listed is this device, confirmed, or baseline. The code may be shown. */
    | { kind: 'ok'; covered: CoveredDevice[] }
    /** At least one listed device has not been vouched for. */
    | { kind: 'unconfirmed'; covered: CoveredDevice[]; unconfirmed: CoveredDevice[] }
    /** A remembered own device now presents a different identity key. */
    | { kind: 'own_key_changed'; covered: CoveredDevice[]; changed: CoveredDevice[] }
    /** This device is not in the listing (not published yet, or revoked). */
    | { kind: 'self_missing'; covered: CoveredDevice[] }
    /** This device's id is listed with a key this device does not hold. */
    | { kind: 'self_key_mismatch'; covered: CoveredDevice[] };

/** True only for the verdict under which "your code" may be displayed. */
export function codeMayBeShown(v: OwnSetVerdict): boolean {
    return v.kind === 'ok';
}

// ── Pure core ────────────────────────────────────────────────────────────────

function cleanRows(rows: readonly ListedDevice[] | null | undefined): ListedDevice[] {
    if (!Array.isArray(rows)) return [];
    const seen = new Set<string>();
    const out: ListedDevice[] = [];
    for (const r of rows) {
        if (!r || typeof r.device_id !== 'string' || typeof r.pub !== 'string') continue;
        if (!r.device_id || !r.pub || seen.has(r.device_id)) continue;
        seen.add(r.device_id);
        out.push({ device_id: r.device_id, pub: r.pub });
    }
    return out;
}

function cloneLedger(l: OwnLedger): OwnLedger {
    const devices: Record<string, OwnDeviceRecord> = {};
    for (const [id, rec] of Object.entries(l.devices)) devices[id] = { ...rec };
    return { ...l, devices };
}

/**
 * Fold one listing into the ledger. Pure: returns a new ledger, or `null` when
 * there is none and this listing is not allowed to create one.
 */
export function applyObservation(
    ledger: OwnLedger | null,
    self: SelfIdentity,
    rowsIn: readonly ListedDevice[] | null | undefined,
    complete: boolean,
    now: number,
): OwnLedger | null {
    const rows = cleanRows(rowsIn);
    if (!self?.deviceId || !self?.pub) return ledger ? cloneLedger(ledger) : null;

    let next: OwnLedger;
    if (!ledger) {
        if (!complete) return null;
        next = { v: 1, created_at: now, devices: {} };
        for (const r of rows) {
            if (r.device_id === self.deviceId) continue;
            if (Object.keys(next.devices).length >= MAX_OWN_DEVICES) break;
            next.devices[r.device_id] = { pub: r.pub, status: 'baseline', first_seen: now, reviewed: false };
        }
    } else {
        next = cloneLedger(ledger);
        for (const r of rows) {
            if (r.device_id === self.deviceId) continue;
            const rec = next.devices[r.device_id];
            if (rec) {
                // Reappeared: clear the gone mark. The pub is NEVER updated here;
                // a different pub is reported by `assessOwnDeviceSet`.
                if (rec.gone_at !== undefined) delete rec.gone_at;
                continue;
            }
            if (Object.keys(next.devices).length >= MAX_OWN_DEVICES) continue;
            next.devices[r.device_id] = { pub: r.pub, status: 'pending', first_seen: now };
        }
    }

    // This device: always confirmed, always the LOCAL key. The local keystore
    // is authoritative for this one record, so it is corrected, not reported.
    const selfRec = next.devices[self.deviceId];
    if (!selfRec) {
        next.devices[self.deviceId] = { pub: self.pub, status: 'confirmed', first_seen: now };
    } else {
        selfRec.pub = self.pub;
        selfRec.status = 'confirmed';
        delete selfRec.gone_at;
        delete selfRec.reviewed;
    }

    if (complete) {
        const listed = new Set(rows.map(r => r.device_id));
        for (const [id, rec] of Object.entries(next.devices)) {
            if (id === self.deviceId || listed.has(id)) continue;
            if (rec.gone_at === undefined) rec.gone_at = now;
        }
    }
    return next;
}

/**
 * Decide whether a listing of the user's own devices is safe to commit to in
 * "your code". Run it on EXACTLY the array that is hashed. Pure.
 */
export function assessOwnDeviceSet(
    ledger: OwnLedger | null,
    rowsIn: readonly ListedDevice[] | null | undefined,
    self: SelfIdentity,
): OwnSetVerdict {
    const rows = cleanRows(rowsIn);
    const covered: CoveredDevice[] = rows.map(r => {
        const isSelf = r.device_id === self.deviceId;
        const rec = ledger?.devices[r.device_id];
        return {
            ...r,
            isSelf,
            status: isSelf ? 'confirmed' : (rec?.status ?? 'unknown'),
        };
    });

    const selfRow = covered.find(c => c.isSelf);
    if (selfRow && selfRow.pub !== self.pub) return { kind: 'self_key_mismatch', covered };

    const changed = covered.filter(c => {
        if (c.isSelf) return false;
        const rec = ledger?.devices[c.device_id];
        return !!rec && rec.pub !== c.pub;
    });
    if (changed.length) return { kind: 'own_key_changed', covered, changed };

    if (!selfRow) return { kind: 'self_missing', covered };

    const unconfirmed = covered.filter(c =>
        !c.isSelf && (c.status === 'unknown' || c.status === 'pending' || c.status === 'rejected'));
    if (unconfirmed.length) return { kind: 'unconfirmed', covered, unconfirmed };

    return { kind: 'ok', covered };
}

/** Pure: the user vouches for `deviceId` with `pub` (re-pins it). */
export function applyConfirm(ledger: OwnLedger, deviceId: string, pub: string, now: number): OwnLedger {
    const next = cloneLedger(ledger);
    const prev = next.devices[deviceId];
    next.devices[deviceId] = { pub, status: 'confirmed', first_seen: prev?.first_seen ?? now };
    return next;
}

/** Pure: the user says `deviceId` is not theirs. Keeps the pinned pub if there was one. */
export function applyReject(ledger: OwnLedger, deviceId: string, pub: string, now: number): OwnLedger {
    const next = cloneLedger(ledger);
    const prev = next.devices[deviceId];
    next.devices[deviceId] = {
        pub: prev?.pub ?? pub,
        status: 'rejected',
        first_seen: prev?.first_seen ?? now,
        ...(prev?.gone_at !== undefined ? { gone_at: prev.gone_at } : {}),
    };
    return next;
}

/** Pure: the one-time baseline review was answered. */
export function applyReviewed(ledger: OwnLedger): OwnLedger {
    const next = cloneLedger(ledger);
    for (const rec of Object.values(next.devices)) {
        if (rec.status === 'baseline') rec.reviewed = true;
    }
    return next;
}

export interface OwnDeviceAlert {
    device_id: string;
    pub: string;
    kind: 'new' | 'rejected_still_listed' | 'key_changed';
    first_seen: number;
    /** True when the last complete listing no longer included it. */
    gone: boolean;
}

/**
 * What the Dashboard banner should say, given the ledger and the most recent
 * listing (complete or partial; the pubs in it drive `key_changed`). Pure.
 */
export function deriveAlerts(
    ledger: OwnLedger | null,
    self: SelfIdentity,
    latestRows: readonly ListedDevice[] | null,
): { alerts: OwnDeviceAlert[]; selfKeyMismatch: boolean; unreviewedBaseline: string[] } {
    if (!ledger) return { alerts: [], selfKeyMismatch: false, unreviewedBaseline: [] };
    const rows = cleanRows(latestRows);
    const listedPub = new Map(rows.map(r => [r.device_id, r.pub]));
    const alerts: OwnDeviceAlert[] = [];
    const unreviewedBaseline: string[] = [];

    for (const [id, rec] of Object.entries(ledger.devices)) {
        if (id === self.deviceId) continue;
        const gone = rec.gone_at !== undefined && !listedPub.has(id);
        const served = listedPub.get(id);
        if (served !== undefined && served !== rec.pub) {
            alerts.push({ device_id: id, pub: served, kind: 'key_changed', first_seen: rec.first_seen, gone: false });
        } else if (rec.status === 'pending') {
            alerts.push({ device_id: id, pub: rec.pub, kind: 'new', first_seen: rec.first_seen, gone });
        } else if (rec.status === 'rejected' && !gone) {
            alerts.push({ device_id: id, pub: rec.pub, kind: 'rejected_still_listed', first_seen: rec.first_seen, gone });
        } else if (rec.status === 'baseline' && !rec.reviewed && !gone) {
            unreviewedBaseline.push(id);
        }
    }
    const selfServed = listedPub.get(self.deviceId);
    alerts.sort((a, b) => a.first_seen - b.first_seen);
    return { alerts, selfKeyMismatch: selfServed !== undefined && selfServed !== self.pub, unreviewedBaseline };
}

/**
 * Extract the user's OWN rows from a directory response the app already made.
 * Pure. Returns null when the response says nothing about own devices.
 *
 *   • `/keys/identity_keys?user_id=<me>` → complete.
 *   • `/conversations/:id/devices` → the caller's other devices (the current
 *     device is excluded server-side) → partial. This is exactly the list
 *     self-fan-out is addressed from, so any own device being SENT to is
 *     observed here.
 */
export function ownRowsFromDirectory(
    entries: readonly DirectoryEntry[] | null | undefined,
    fullUserId: string | null,
    url: string | undefined,
    myUserId: string,
): { rows: ListedDevice[]; complete: boolean } | null {
    if (!Array.isArray(entries) || !url || !myUserId) return null;
    const path = url.split('?')[0];
    const pubOf = (e: DirectoryEntry) => e?.identity_pub_b64 ?? e?.identity_key_pub_b64 ?? '';

    if (path.endsWith('/identity_keys')) {
        if (fullUserId !== myUserId) return null;
        return {
            rows: entries.map(e => ({ device_id: e?.device_id ?? '', pub: pubOf(e) })),
            complete: true,
        };
    }
    if (/\/conversations\/[^/]+\/devices$/.test(path)) {
        const rows = entries
            .filter(e => e?.user_id === myUserId)
            .map(e => ({ device_id: e?.device_id ?? '', pub: pubOf(e) }));
        return rows.length ? { rows, complete: false } : null;
    }
    return null;
}

// ── Storage ──────────────────────────────────────────────────────────────────

export function ledgerKey(myUserId: string): string {
    return `${OWN_LEDGER_PREFIX}${myUserId}`;
}

function isValidLedger(x: unknown): x is OwnLedger {
    if (!x || typeof x !== 'object') return false;
    const l = x as OwnLedger;
    return l.v === 1 && !!l.devices && typeof l.devices === 'object';
}

/**
 * Read the ledger. Returns `undefined` (NOT null) when the account's store is
 * not ready, so a caller cannot confuse "cold" with "no ledger yet".
 */
export function loadOwnLedger(myUserId: string): OwnLedger | null | undefined {
    if (!myUserId || !secureLocalStore.isAccountReady(myUserId)) return undefined;
    const raw = secureLocalStore.getItem(ledgerKey(myUserId));
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        // A corrupt record is treated as ABSENT only for reading. It is never
        // silently replaced by a fresh baseline: see `observeOwnDevices`.
        return isValidLedger(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function hasStoredRecord(myUserId: string): boolean {
    return !!secureLocalStore.getItem(ledgerKey(myUserId));
}

function saveOwnLedger(myUserId: string, ledger: OwnLedger): void {
    // Literal key head on purpose: backupRegistry.test.ts scans for it, so the
    // backup classification of this record cannot silently go missing.
    secureLocalStore.setItem(`kv_own_devices_v1_${myUserId}`, JSON.stringify(ledger));
    notify(myUserId);
}

/** Most recent listing per account, for `deriveAlerts`. Session memory only. */
const latestRowsByUser = new Map<string, ListedDevice[]>();

/**
 * Fold a listing of the user's own devices into the stored ledger.
 * No-op (returns false) while the account store is not ready.
 */
export function observeOwnDevices(
    myUserId: string,
    self: SelfIdentity,
    rows: readonly ListedDevice[] | null | undefined,
    complete: boolean,
    now: number = Date.now(),
): boolean {
    const current = loadOwnLedger(myUserId);
    if (current === undefined) return false;
    // Unparseable bytes on disk: do not re-baseline over them. That would turn
    // a storage fault into silent acceptance of whatever is listed right now.
    if (current === null && hasStoredRecord(myUserId)) return false;

    const cleaned = cleanRows(rows);
    const prevLatest = latestRowsByUser.get(myUserId);
    if (complete) {
        latestRowsByUser.set(myUserId, cleaned);
    } else {
        // Merge a partial listing into the remembered view so a key change seen
        // in a conversation listing is still reported.
        const merged = new Map((prevLatest ?? []).map(r => [r.device_id, r.pub]));
        for (const r of cleaned) merged.set(r.device_id, r.pub);
        latestRowsByUser.set(myUserId, [...merged].map(([device_id, pub]) => ({ device_id, pub })));
    }

    const next = applyObservation(current, self, cleaned, complete, now);
    if (!next) return false;
    if (current && JSON.stringify(current) === JSON.stringify(next)) {
        notify(myUserId);
        return true;
    }
    saveOwnLedger(myUserId, next);
    return true;
}

export function confirmOwnDevice(myUserId: string, deviceId: string, pub: string): boolean {
    const current = loadOwnLedger(myUserId);
    if (!current) return false;
    saveOwnLedger(myUserId, applyConfirm(current, deviceId, pub, Date.now()));
    return true;
}

export function rejectOwnDevice(myUserId: string, deviceId: string, pub: string): boolean {
    const current = loadOwnLedger(myUserId);
    if (!current) return false;
    saveOwnLedger(myUserId, applyReject(current, deviceId, pub, Date.now()));
    return true;
}

export function markOwnDevicesReviewed(myUserId: string): boolean {
    const current = loadOwnLedger(myUserId);
    if (!current) return false;
    saveOwnLedger(myUserId, applyReviewed(current));
    return true;
}

export function currentOwnAlerts(myUserId: string, self: SelfIdentity): ReturnType<typeof deriveAlerts> {
    const ledger = loadOwnLedger(myUserId);
    return deriveAlerts(ledger ?? null, self, latestRowsByUser.get(myUserId) ?? null);
}

// ── Change notification (for the Dashboard banner) ───────────────────────────

type Listener = (myUserId: string) => void;
const listeners = new Set<Listener>();

export function subscribeOwnLedger(fn: Listener): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

function notify(myUserId: string): void {
    for (const fn of listeners) {
        try { fn(myUserId); } catch { /* a listener fault is never a ledger fault */ }
    }
}

/** Test seam / account-switch hygiene. Session state only; the store is untouched. */
export function _resetSession(): void {
    latestRowsByUser.clear();
}
