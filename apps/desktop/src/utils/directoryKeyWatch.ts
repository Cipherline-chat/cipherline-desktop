/**
 * Key-change detection at DIRECTORY-FETCH time (the second producer of
 * `senderWarnings`).
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * `Dashboard.pinAndDetect` was the only producer of `senderWarnings`, and all
 * four of its call sites are message-RECEIVE paths. `deviceDirectory`'s
 * interceptor already sees every `/conversations/:id/devices`,
 * `/recipient-devices` and `/keys/identity_keys` response — the fetches the
 * client makes on chat open, on every send, and when the verification modal
 * opens — but it only warmed the attribution cache. It never compared what the
 * server just served against what the user has PINNED.
 *
 * So a contact whose pinned device now presents a different identity key stayed
 * unmarked until they happened to send something. The evidence was already on
 * the wire and being thrown away. This module reads it.
 *
 * ── Why ONLY `key_changed` ──────────────────────────────────────────────────
 *
 * `evaluateSender` is deliberately NOT used here, and that is the single most
 * important thing about this file.
 *
 *   • `unattributed` means "the server's directory does not publish this key".
 *     Deriving it FROM that same directory is circular — the key came out of
 *     the directory, so it always attributes. It can only ever be sourced from
 *     an envelope, which is the one input the server does not author.
 *
 *   • `unrecognized_verified` means "this key matches none of the contact's
 *     Safety-Number-verified devices". Every directory response for a verified
 *     contact who has ever added a second, unverified device satisfies that —
 *     it would fire on the completely normal case and train the warning away.
 *     It, too, is a statement about a key that ARRIVED, not one that was
 *     merely published.
 *
 * `key_changed` is the only verdict whose evidence survives the source change:
 * it compares a device id the user has ALREADY pinned against the pub now
 * published for that same device id. Both halves are local except the new pub.
 * A reinstall mints a NEW device id, so it is false by construction there; what
 * is left is an in-place re-key or a lying server. High signal, low volume.
 *
 * ── What this module must never do: pin ─────────────────────────────────────
 *
 * `pinAndDetect` calls `recordFirstSeen` on a benign verdict — TOFU. Doing
 * that here would let the server SEED the pin store for devices the user has
 * never received anything from, by serving a directory row. The next genuine
 * envelope from that contact would then read `ok` against a server-chosen pin.
 * That is strictly worse than the gap being closed, so nothing here writes to
 * `keyVerification.ts`. This module is read-only against the pin store.
 *
 * (`SafetyVerificationModal` does call `recordFirstSeen` on directory rows.
 * That is pre-existing and at least gated behind an explicit user act; it is
 * out of scope here, but it is why this file states the rule so loudly.)
 *
 * ── Why these warnings are SESSION-SCOPED and never persisted ───────────────
 *
 * `senderWarningStore` is durable and its cap REFUSES new entries rather than
 * evicting, so that a flood cannot push a real targeted warning out of the
 * table. That design holds because, until now, every producer required a
 * VALID, SELF-SIGNED ENVELOPE — evidence the server cannot manufacture without
 * actually mounting the attack.
 *
 * A directory response is the opposite: server-authored, unsigned, and free to
 * produce. If these warnings were durable, a hostile server could, at zero
 * cost and with no key material:
 *
 *   1. turn every pinned contact red at once (alarm fatigue — the user mass
 *      dismisses, and a real substitution hides in the noise);
 *   2. fill all `MAX_WARNINGS` durable slots, after which a genuine
 *      envelope-sourced warning cannot be stored AT ALL, because the cap
 *      refuses rather than evicts; and
 *   3. get that junk written into the user's encrypted backup
 *      (`backupRegistry` classifies `kv_warn_v1_*` as `include`) and re-merged
 *      on every restore forever, because `mergeWarnings` is a deliberately
 *      non-losing union.
 *
 * The argument FOR durability does not transfer either. Persistence exists
 * because an envelope-sourced warning is NOT RE-DERIVABLE: the offending key
 * is never written to the pin store, so once the app forgets it, nothing on
 * disk records that it ever arrived. A directory contradiction is the exact
 * opposite — it is standing server state, re-derived automatically and for
 * free on the very next chat open. "It evaporates on restart" is only a defect
 * for evidence that was expensive to obtain. This evidence is not.
 *
 * So the two tiers are structural, not a flag: envelope-sourced warnings go
 * through `raiseWarning` and persist; directory-sourced warnings exist only in
 * `Dashboard.senderWarnings` for the session. Note `onWarn` below deliberately
 * does NOT hand the caller the offending pub, which is the argument
 * `raiseWarning` needs — the omission is the guard.
 *
 * The promotion path needs no marker: if the contradiction is ever corroborated
 * by a real envelope, `pinAndDetect` raises it durably on its own.
 *
 * ── What still bounds a hostile server ──────────────────────────────────────
 *
 *   • It can only contradict a device the user has ALREADY pinned. Inventing
 *     device ids produces nothing (`isKeyChanged` returns false for an unseen
 *     device), so the ceiling is the user's real contact set — never more.
 *   • Nothing it mints consumes durable cap headroom, so a genuine
 *     envelope-sourced warning is always storable.
 *   • Nothing it mints survives a restart or reaches a backup.
 *   • `MAX_RAISES_PER_RESPONSE` bounds the synchronous work one pathological
 *     response can cause inside an axios interceptor. That is a work bound, not
 *     a security control — a server can simply send more responses — and it is
 *     described as such rather than oversold.
 */

import { isKeyChanged } from './keyVerification';
import type { DirectoryEntry } from './deviceDirectory';
import type { SenderVerdict } from './senderTrust';

/**
 * Cap on warnings raised from ONE directory response. A group roster fetch
 * returns every participant's devices, so one response can in principle
 * contradict many pins at once. See the note above: this bounds interceptor
 * work, it does not bound the attacker.
 */
export const MAX_RAISES_PER_RESPONSE = 32;

/** Per-contact bound on the session dismissal ledger. */
const MAX_ACK_PUBS_PER_USER = 8;
/** Bound on how many contacts the ledger tracks. */
const MAX_ACK_USERS = 512;

/**
 * The pub each contact's live directory-sourced warning was raised on.
 * Needed by `noteResolved`, which is told only the user id.
 */
const lastRaisedPub = new Map<string, string>();

/**
 * Contradictions the user has already answered THIS SESSION, keyed by contact
 * and by the offending pub.
 *
 * ── Why this, and not "suppress while the verification modal is open" ───────
 *
 * The obvious loop is: a durable warning is showing, the user opens
 * `SafetyVerificationModal` to RESOLVE it, the modal's own
 * `GET /keys/identity_keys` comes back through the interceptor, and the
 * contradiction is re-raised on top of the resolution.
 *
 * A "the modal triggered this fetch" flag is the wrong instrument. It has to
 * infer provenance from timing, so it wrongly suppresses an unrelated
 * concurrent fetch that lands in the same window, and it misses the modal's
 * fetch whenever the response arrives outside it. It also does not fix the
 * loop at all for the DISMISS resolution, which is the one that matters:
 * verify (`markVerified`) and acknowledge (`acknowledgeKeyChange`) both RE-PIN
 * the new key, so `isKeyChanged` is false afterwards and no flag was ever
 * needed; dismiss deliberately does not re-pin, so the contradiction is still
 * standing and EVERY later directory fetch — chat open, next send, re-opening
 * the modal — would raise it again. The user could never clear it.
 *
 * So the question to ask is not "who made this request" (unanswerable, and the
 * wrong axis) but "has the user already answered THIS contradiction" — which
 * is local state, exact, and scoped to the (contact, key) pair rather than to a
 * user or a global flag. A concurrent fetch for a different contact is
 * untouched. A modal fetch that lands late is still suppressed. And a
 * DIFFERENT key later appearing for the same contact is a new fact and raises
 * again, which is the property a timing flag cannot express at all.
 *
 * Session-scoped, matching the warnings it governs: a dismissal that outlived
 * the warning would be a durable silencer sourced from the same unsigned data,
 * which is the thing this whole file is avoiding.
 */
const acknowledgedPubs = new Map<string, Set<string>>();

export interface DirectoryWarning {
    /** Contact whose pinned device was contradicted. */
    userId: string;
    /** Always `'key_changed'` — see the module note. */
    verdict: SenderVerdict;
}

export interface ObserveOptions {
    /** The signed-in account. Rows for this user are skipped. */
    myUserId: string;
    /** Rows from `GET /keys/identity_keys?user_id=` carry no `user_id` of their
     *  own — it is in the query string. `deviceDirectory` extracts it. */
    fullUserId?: string | null;
    /**
     * Called once per contradicted contact, at most once per contact per
     * response. Deliberately NOT given the offending pub or device id: those
     * are the arguments `senderWarningStore.raiseWarning` needs, and this
     * producer must not reach it.
     */
    onWarn: (warning: DirectoryWarning) => void;
}

/**
 * Compare one directory response against the pin store and report every
 * contact whose already-pinned device is now presenting a different key.
 *
 * Read-only against `keyVerification` — see the module note on why this must
 * never pin. Never throws: it runs inside an axios response interceptor, where
 * a throw would break an unrelated request.
 */
export function observeDirectory(
    entries: DirectoryEntry[] | undefined | null,
    opts: ObserveOptions,
): void {
    const { myUserId, fullUserId, onWarn } = opts;
    if (!myUserId || !Array.isArray(entries)) return;

    const seen = new Set<string>();
    let raised = 0;

    for (const e of entries) {
        if (raised >= MAX_RAISES_PER_RESPONSE) break;
        const uid = e?.user_id ?? fullUserId ?? null;
        const deviceId = e?.device_id;
        const pub = e?.identity_pub_b64 ?? e?.identity_key_pub_b64;
        // A row with no device id cannot be compared: `isKeyChanged` is
        // device-scoped by design (RC-7), and a user-scoped comparison would
        // flag a contact's legitimate second device.
        if (!uid || !deviceId || !pub) continue;
        // Own devices are not a contact relationship and have no pin store.
        // They are judged by `ownDeviceLedger` instead (the ghost-device
        // alarm), fed from the same interceptor.
        if (uid === myUserId) continue;
        // One warning per contact per response: `senderWarnings` is keyed by
        // user id, so a second row for the same contact cannot say anything new.
        if (seen.has(uid)) continue;

        let changed = false;
        try {
            changed = isKeyChanged(myUserId, uid, pub, deviceId);
        } catch {
            // Pin store unreadable. Stay silent rather than warn on a local
            // fault: this producer's evidence is server-authored, so the
            // fail-toward-warning rule that governs the envelope path would
            // here mean "let a storage glitch raise an alarm the server can
            // then flood". The envelope path still covers the real case.
            continue;
        }
        if (!changed) continue;

        if (acknowledgedPubs.get(uid)?.has(pub)) continue;

        seen.add(uid);
        raised += 1;
        lastRaisedPub.set(uid, pub);
        onWarn({ userId: uid, verdict: 'key_changed' });
    }
}

/**
 * Record that the user has answered the live warning for `theirUserId`, so the
 * standing contradiction behind it stops re-raising.
 *
 * Called from `Dashboard.clearSenderWarning`, i.e. on all three explicit
 * resolutions (verify / acknowledge / dismiss). `alsoSuppress` carries the pub
 * from the DURABLE record when there is one, because an envelope-sourced
 * warning and a directory-sourced one for the same contact can name different
 * keys and resolving the banner must answer both.
 */
export function noteResolved(theirUserId: string, alsoSuppress?: string | null): void {
    if (!theirUserId) return;
    const pubs = [lastRaisedPub.get(theirUserId), alsoSuppress].filter(
        (p): p is string => !!p,
    );
    lastRaisedPub.delete(theirUserId);
    if (!pubs.length) return;

    let set = acknowledgedPubs.get(theirUserId);
    if (!set) {
        if (acknowledgedPubs.size >= MAX_ACK_USERS) return;
        set = new Set<string>();
        acknowledgedPubs.set(theirUserId, set);
    }
    for (const pub of pubs) {
        // Evict-oldest, unlike the durable store's refuse-new cap, and for the
        // opposite reason: overflowing here fails toward RE-SHOWING a warning,
        // which is the safe direction, and this is session UX state rather
        // than security state.
        if (set.size >= MAX_ACK_PUBS_PER_USER && !set.has(pub)) {
            const oldest = set.values().next().value;
            if (oldest !== undefined) set.delete(oldest);
        }
        set.add(pub);
    }
}

/** Test seam / account-switch + sign-out hygiene. Session state only. */
export function _reset(): void {
    lastRaisedPub.clear();
    acknowledgedPubs.clear();
}
