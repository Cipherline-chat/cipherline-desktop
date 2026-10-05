/**
 * Durable storage for UNRESOLVED sender-identity warnings.
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 *
 * The pin store (`keyVerification.ts`) persists. The *verdict* did not.
 * `Dashboard.tsx` held `senderWarnings` in `useState({})`, populated only when
 * a message arrived and dropped on unmount. So:
 *
 *   contact's key changes -> banner + picker marker appear -> app restarts ->
 *   both are gone, and the contact renders as completely normal while the
 *   changed key is still the one in use.
 *
 * The alarm turned itself off. That is strictly worse than never having shown
 * one, because the user saw a warning, did nothing about it, and the app then
 * told them — by silence — that the situation had resolved itself.
 *
 * ── Why this cannot be re-derived from the pin store ────────────────────────
 *
 * It is tempting to treat this file as a cache and rebuild it at boot from
 * `kv_verify_v2_*`. That is not possible, and the reason is worth stating
 * because it also decides the backup question below.
 *
 * The pin store records what was ACCEPTED: one pub per known device. A warning
 * is evidence about what was REJECTED — a key that differed from the pin, or
 * that the directory would not attribute. That key is deliberately never
 * written into the pin store (that is the whole point of not auto-adopting it),
 * so after the fact there is nothing in the pins that says it ever arrived.
 * Pins and warnings are two different facts about one relationship and neither
 * implies the other. This record is therefore primary state, not a cache — and
 * primary state that is lost on restore is a security regression delivered by
 * the recovery path, which is why `backupRegistry.ts` classifies it `include`.
 *
 * ── What resolves a warning ─────────────────────────────────────────────────
 *
 * Only an explicit user act, of which there are exactly three, all routed
 * through `Dashboard.clearSenderWarning` -> `resolveWarning` here:
 *
 *   1. Verifying the contact's safety number out of band (`markVerified`).
 *   2. Acknowledging the change (`acknowledgeKeyChange`) — "yes, that was me
 *      reinstalling", which re-pins the new key as the trusted one.
 *   3. Dismissing the warning from the verification modal. This exists so the
 *      user can never be stranded with an alarm they have no way to clear —
 *      see `SafetyVerificationModal`, where it is available even in the
 *      offline/error state that renders no devices to verify.
 *
 * Plus one non-interactive condition, in `loadWarnings`, which is still an
 * explicit user act just recorded elsewhere: the offending key itself is now
 * pinned AND marked verified for this contact. That can only happen because
 * the user compared a safety number out of band and it matched — the strongest
 * resolution available, and the only evidence strong enough to retire a
 * warning without the user touching the banner. It matters because it is what
 * makes a warning restored from a backup consistent with pins restored from
 * the same backup (see `mergeWarnings`).
 *
 * Deliberately NOT resolution:
 *   • the app restarting (that is the bug);
 *   • a later message from the contact that matches the NEW pin — that is the
 *     attacker's own key being used consistently, and consistency is not
 *     safety. `pinAndDetect` overwrites an entry with a fresher warnable
 *     verdict but never deletes one on a benign verdict;
 *   • opening, reading or scrolling the conversation.
 *
 * ── Failure directions ──────────────────────────────────────────────────────
 *
 * Every path here is written to fail toward SHOWING the warning:
 *   • unreadable/absent record          -> no warnings restored, but the pin
 *                                          store is untouched, so the next
 *                                          message from that contact re-derives
 *                                          and re-raises the verdict.
 *   • entry with an unrecognised verdict -> kept, coerced to `unattributed`
 *                                          (the most conservative wording), not
 *                                          dropped.
 *   • entry with a known BENIGN verdict  -> dropped. `ok`/`first_contact` are
 *                                          not alarms and never get written
 *                                          here; inventing one would be the
 *                                          opposite error.
 *   • write fails (quota, locked store)  -> the in-memory warning still shows
 *                                          for this session; only its survival
 *                                          across restart is lost.
 *   • resolve fails to persist           -> the warning comes back next launch.
 *                                          Annoying, and the safe direction.
 *   • keystore LOCKED                    -> `secureLocalStore` performs zero
 *                                          reads and zero writes by design and
 *                                          boot shows `StorageLockedScreen`;
 *                                          nothing here throws, it simply reads
 *                                          empty and writes nothing, leaving the
 *                                          existing ciphertext intact.
 *
 * ── What bounds the storage ─────────────────────────────────────────────────
 *
 * One record per account, holding a map keyed by contact user id, capped at
 * `MAX_WARNINGS` entries. Each entry is ~150 bytes, so the record is bounded at
 * roughly 40 KB regardless of how many contacts the user accumulates over
 * years — and in normal use it is EMPTY, because an entry is only ever created
 * by a warnable verdict.
 *
 * At the cap, new entries are REFUSED and existing ones are kept (an existing
 * contact's entry can still be updated in place). Evicting the oldest would be
 * the conventional choice and is wrong here: LRU eviction would hand anyone who
 * can mint entries a way to push a real, targeted warning out of the table by
 * flooding. Refusing new entries at the cap means an alarm already raised can
 * never be silenced by volume; the cost is that the 257th distinct warning does
 * not survive a restart, and it is still shown for the session it was raised in.
 *
 * The cap is belt-and-braces, though, not the primary bound. The primary bound
 * is that all three warnable verdicts require PRE-EXISTING LOCAL STATE for the
 * claimed sender before they can fire at all: `key_changed` needs a pinned
 * device for them, `unrecognized_verified` needs a Safety-Number-verified
 * device for them, and `unattributed` needs a directory snapshot for them
 * (see `evaluateSender`). A server inventing `su` values it has never
 * published devices for produces `first_contact`, which is not warnable and is
 * never written here. So the table is bounded by the user's real contact set,
 * and the flood it could otherwise suffer is not reachable.
 *
 * Field sizes are capped separately (`MAX_FIELD`) because `pub` comes straight
 * off the wire and is the one value here that nothing upstream length-checks.
 */

import { secureLocalStore } from './secureLocalStore';
import { getKnownDevices } from './keyVerification';
import { isWarnable, type SenderVerdict } from './senderTrust';

/** Key prefix. `_{uid}` suffix puts it in `secureLocalStore`'s per-account
 *  tier — encrypted under HKDF(master, userId), so account A cannot read
 *  account B's warnings even on the same machine — and makes the account-switch
 *  teardown drop it with the rest of the account's records. Classified in
 *  `backupRegistry.ts` as `kv_warn_v1_{uid}`. */
const WARN_PREFIX = 'kv_warn_v1_';

export function warnKey(myUserId: string): string {
    return `${WARN_PREFIX}${myUserId}`;
}

/** See the storage-bound note above for why this is a refuse-new cap rather
 *  than an LRU. */
export const MAX_WARNINGS = 256;

/**
 * Per-field length cap. A base64 Ed25519 key is 44 characters and a UUID is 36;
 * 512 is generous for both. It exists because `pub` is `sp` off the envelope —
 * attacker-chosen, and nothing upstream of here length-checks it — so without
 * this one oversized envelope could turn a ~40 KB bounded record into an
 * arbitrarily large one. Over-long values are TRUNCATED rather than dropped:
 * the warning itself still stands, and a truncated `pub` only costs the
 * automatic "the user later verified this exact key" resolution in
 * `loadWarnings`, which fails toward keeping the warning.
 */
const MAX_FIELD = 512;

const clip = (s: string): string => (s.length > MAX_FIELD ? s.slice(0, MAX_FIELD) : s);

export interface WarningRecord {
    /** Always a warnable verdict — `isWarnable(verdict)` holds for anything
     *  this module returns. */
    verdict: SenderVerdict;
    /**
     * The identity pub that CAUSED the warning (`sp` off the offending
     * envelope). Not in the pin store by construction, which is what makes
     * this record irreplaceable — and what lets `loadWarnings` recognise the
     * one non-interactive resolution: the user later verified this exact key.
     * May be empty if a caller had none.
     */
    pub: string;
    /** Claimed sender device id (`sd`), when the envelope carried one. Kept
     *  for diagnostics; deliberately not part of any decision, since an
     *  attacker chooses it freely. */
    deviceId?: string;
    /** When it was first raised (ms). Display/diagnostics only — nothing
     *  expires, because an unresolved identity warning does not become less
     *  true with age. */
    at: number;
}

interface WarnStore {
    v: 1;
    warnings: Record<string, WarningRecord>;
}

const BENIGN: ReadonlySet<string> = new Set(['ok', 'first_contact']);

/** Fallback for an entry we know was flagged but whose verdict string this
 *  build does not recognise (a downgrade from a future version). `unattributed`
 *  is chosen because it produces the strongest UI treatment and makes the
 *  least specific claim about the contact's own behaviour — "treat it as
 *  unverified" rather than asserting which way it went wrong. It is also
 *  self-correcting: the next message from that contact overwrites it with a
 *  freshly derived verdict. */
const UNKNOWN_VERDICT_FALLBACK: SenderVerdict = 'unattributed';

function emptyStore(): WarnStore {
    return { v: 1, warnings: {} };
}

/**
 * Read + validate the record. Never throws; a store that cannot be read or
 * parsed reads as empty and is LEFT ON DISK rather than cleared, so a later
 * build (or a support path) can still recover it.
 */
function readStore(myUserId: string): WarnStore {
    if (!myUserId) return emptyStore();
    let raw: string | null = null;
    try {
        raw = secureLocalStore.getItem(warnKey(myUserId));
    } catch {
        return emptyStore();
    }
    if (!raw) return emptyStore();

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        console.warn('[senderWarningStore] unreadable warning record — left in place, reading as empty');
        return emptyStore();
    }

    const store = emptyStore();
    const bag = (parsed as { warnings?: unknown })?.warnings;
    if (!bag || typeof bag !== 'object') return store;

    for (const [uid, value] of Object.entries(bag as Record<string, unknown>)) {
        if (!uid || uid.length > MAX_FIELD) continue;
        // The cap is enforced on READ as well as on write. `applyIncludedKv`
        // writes a restored record verbatim, so a vault carrying an oversized
        // table would otherwise bypass the write-side cap entirely.
        if (Object.keys(store.warnings).length >= MAX_WARNINGS) break;
        const rec = value as Partial<WarningRecord> | null;
        if (!rec || typeof rec !== 'object') continue;
        const verdict = typeof rec.verdict === 'string' ? rec.verdict : '';
        // A benign verdict is not an alarm and must never have been written
        // here; drop it rather than render a banner with no message. Anything
        // else unrecognised is kept — see UNKNOWN_VERDICT_FALLBACK.
        if (BENIGN.has(verdict)) continue;
        store.warnings[uid] = {
            verdict: isWarnable(verdict as SenderVerdict) ? (verdict as SenderVerdict) : UNKNOWN_VERDICT_FALLBACK,
            pub: typeof rec.pub === 'string' ? clip(rec.pub) : '',
            ...(typeof rec.deviceId === 'string' ? { deviceId: clip(rec.deviceId) } : {}),
            at: typeof rec.at === 'number' && Number.isFinite(rec.at) ? rec.at : 0,
        };
    }
    return store;
}

/** Write. Swallows failure: a warning that cannot be persisted is still shown
 *  for this session, and losing the write is never worse than not warning. */
function writeStore(myUserId: string, store: WarnStore): void {
    if (!myUserId) return;
    try {
        secureLocalStore.setItem(warnKey(myUserId), JSON.stringify(store));
    } catch (e) {
        console.warn('[senderWarningStore] failed to persist warnings', e);
    }
}

/**
 * True iff the user has out-of-band VERIFIED the exact key that caused the
 * warning. This is the only evidence strong enough to retire a warning without
 * the user touching the banner, and it cannot be produced by anything an
 * attacker controls — `verified` is only ever set by `markVerified`, which is
 * only ever reached through the safety-number comparison the user performs
 * themselves.
 *
 * Deliberately NOT satisfied by the key merely being pinned: `recordFirstSeen`
 * pins on TOFU, so "pinned" would mean an attacker's key resolves its own
 * warning simply by being used a second time.
 */
function vouchedFor(myUserId: string, theirUserId: string, pub: string): boolean {
    if (!pub) return false;
    try {
        const devices = getKnownDevices(myUserId, theirUserId);
        return Object.values(devices).some(d => d.verified && d.pub === pub);
    } catch {
        // Pin store unreadable — keep the warning. Fail toward warning.
        return false;
    }
}

/**
 * Restore the unresolved warnings for an account, in the shape
 * `Dashboard.senderWarnings` consumes.
 *
 * MUST be called only after `secureLocalStore.whenAccountReady()` resolves:
 * per-account records are cold immediately after an explicit sign-in, and
 * reading early returns empty — which here means "no warnings", i.e. exactly
 * the silence this whole module exists to prevent.
 *
 * Compacts the record as a side effect when an entry has been resolved by
 * out-of-band verification since it was written.
 */
export function loadWarnings(myUserId: string): Record<string, SenderVerdict> {
    const store = readStore(myUserId);
    const out: Record<string, SenderVerdict> = {};
    let resolved = false;

    for (const [uid, rec] of Object.entries(store.warnings)) {
        if (vouchedFor(myUserId, uid, rec.pub)) {
            delete store.warnings[uid];
            resolved = true;
            continue;
        }
        out[uid] = rec.verdict;
    }
    if (resolved) writeStore(myUserId, store);
    return out;
}

/**
 * Persist one unresolved warning. Write-through from `pinAndDetect` rather
 * than an effect that mirrors React state — an effect of that shape is exactly
 * what wiped pins and ignored-games before, because it fires once on mount
 * with the still-empty initial value and writes it over the stored data.
 * There is no such window here: nothing ever writes the whole map from state.
 *
 * Overwrites an existing entry for the same contact (a fresher verdict is
 * better evidence) but never resets `at`, so the age of the original alarm
 * survives.
 */
export function raiseWarning(
    myUserId: string,
    theirUserId: string,
    verdict: SenderVerdict,
    pub: string,
    deviceId?: string,
): void {
    if (!myUserId || !theirUserId || theirUserId.length > MAX_FIELD || !isWarnable(verdict)) return;
    const store = readStore(myUserId);
    const existing = store.warnings[theirUserId];
    if (!existing && Object.keys(store.warnings).length >= MAX_WARNINGS) {
        // Refuse rather than evict — see the storage-bound note at the top.
        console.warn('[senderWarningStore] warning table full; not persisting a new entry');
        return;
    }
    if (existing && existing.verdict === verdict && existing.pub === pub) return;
    store.warnings[theirUserId] = {
        verdict,
        pub: pub ? clip(pub) : '',
        ...(deviceId ? { deviceId: clip(deviceId) } : {}),
        at: existing?.at ?? Date.now(),
    };
    writeStore(myUserId, store);
}

/** Retire a warning. The ONLY caller is `Dashboard.clearSenderWarning`, which
 *  is only reached from an explicit user act (verify / acknowledge / dismiss). */
export function resolveWarning(myUserId: string, theirUserId: string): void {
    if (!myUserId || !theirUserId) return;
    const store = readStore(myUserId);
    if (!(theirUserId in store.warnings)) return;
    delete store.warnings[theirUserId];
    writeStore(myUserId, store);
}

/** Raw records for an account. Used by the backup/restore union below; the UI
 *  path wants `loadWarnings`. */
export function snapshotWarnings(myUserId: string): Record<string, WarningRecord> {
    return readStore(myUserId).warnings;
}

/**
 * Union `incoming` into the account's current record. An entry already present
 * wins; a conflict means both sides hold an unresolved alarm for the same
 * contact, so either verdict is a true statement and neither side loses one.
 *
 * `importLocalHistory` calls this with the LOCAL record snapshotted BEFORE
 * `applyIncludedKv` overwrote it with the backup's, which is why restore ends
 * up a union for this one key rather than the wholesale overwrite every other
 * backed-up key gets. A backup is a snapshot of some earlier moment. Letting
 * it replace this record would silently drop any alarm raised on this device
 * SINCE that moment — reintroducing the exact "the alarm turns itself off"
 * defect, via the recovery path, at the same time as the reassuring half (the
 * pins, which carry `verified`) is restored in full. The union direction is the
 * one that cannot lose an unresolved alarm.
 *
 * The converse — an entry the user resolved locally after the backup was
 * taken comes back — is accepted deliberately. It is the fail-toward-warning
 * direction, it is one click to dismiss, and `loadWarnings` retires it
 * automatically anyway if the resolution was an out-of-band verification (the
 * restored pins carry that `verified` flag with them).
 */
export function mergeWarnings(myUserId: string, incoming: Record<string, WarningRecord>): void {
    if (!myUserId || !incoming || !Object.keys(incoming).length) return;
    const store = readStore(myUserId);
    let changed = false;
    for (const [uid, rec] of Object.entries(incoming)) {
        if (!uid || !rec || store.warnings[uid]) continue;
        if (BENIGN.has(rec.verdict) || !isWarnable(rec.verdict)) continue;
        if (Object.keys(store.warnings).length >= MAX_WARNINGS) break;
        store.warnings[uid] = rec;
        changed = true;
    }
    if (changed) writeStore(myUserId, store);
}
