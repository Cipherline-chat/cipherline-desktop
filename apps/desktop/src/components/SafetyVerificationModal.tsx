import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import axios from 'axios';
import { Copy, Check, AlertTriangle, ChevronDown, X, Send, Info } from 'lucide-react';
import { API_BASE } from '../constants';
import { ClButton } from './ClButton';
import { ClModal, ClInput } from './cl';
import { TrustBadge } from './TrustBadge';
import { writeToClipboard } from '../utils/clipboard';
import { computeSafetyNumber, formatSafetyNumber, SAFETY_NUMBER_VERSION, SAFETY_NUMBER_GROUPS } from '../utils/safetyNumber';
import { computeContactCode, formatCode, checkCode, CODE_LENGTH } from '../utils/verificationCode';
import { deriveContactTrust, pinsToTrustDevices, trustExplanation } from '../utils/contactTrust';
import { isLegacyVerified } from '../utils/verificationStrength';
import {
    observeOwnDevices,
    loadOwnLedger,
    assessOwnDeviceSet,
    codeMayBeShown,
    confirmOwnDevice,
    rejectOwnDevice,
    type ListedDevice,
    type OwnSetVerdict,
    type CoveredDevice,
} from '../utils/ownDeviceLedger';
import type { SenderVerdict } from '../utils/senderTrust';
import {
    getDeviceVerification,
    markVerified,
    acknowledgeKeyChange,
    getKnownDevices,
} from '../utils/keyVerification';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    myUserId: string;
    /**
     * This install's device id. Needed for the ghost-device check on "your
     * code" (docs/ghost-device.md): the code is withheld unless this device's
     * own key is in the listing it commits to, under this id. Absent means the
     * check cannot run, and the code is withheld (fail closed).
     */
    myDeviceId?: string | null;
    remoteUserId: string;
    remoteUsername: string;
    token: string | null;
    /** C2: called when the user resolves a key change (verify or acknowledge),
     *  so the caller can clear any "safety number changed" warning state. */
    onResolved?: () => void;
    /**
     * Send the user's own verification code into the conversation as a
     * `safety_number` embed. Absent (undefined) outside a 1:1 DM, which is the
     * only place a single-account fingerprint has one obvious counterparty —
     * the Send control hides itself rather than sending somewhere ambiguous.
     */
    onSendCode?: (code: string, deviceCount: number) => Promise<void>;
    /**
     * The unresolved warning currently raised for this contact, if any.
     *
     * Its only job is to decide whether the explicit "Dismiss this warning"
     * action is offered — and that action exists because the warning now
     * SURVIVES A RESTART. Before it persisted, a warning the user could not
     * clear was a nuisance that a relaunch fixed. Now it would be permanent,
     * and there is a real state where none of the other resolutions are
     * reachable: this modal's whole device list comes from a live
     * `GET /keys/identity_keys`, so offline — or for a contact the server
     * serves no keys for, which is exactly the `unattributed` case — it
     * renders the error branch with nothing to verify and nothing to
     * acknowledge. Dismiss is therefore rendered OUTSIDE the loading/error
     * conditional, so it is available in every state.
     */
    activeWarning?: SenderVerdict | null;
}

interface DeviceEntry {
    device_id: string;
    pub: string;
    safetyNumber: string | null;
    state: 'unverified' | 'verified' | 'key_changed';
    /**
     * `state === 'verified'`, but the vouch predates safety-number v2 and may
     * rest on the collision-weak v1 digits (see `verificationStrength.ts`).
     * Still a trust anchor, but not green until re-checked.
     */
    legacy: boolean;
}

/**
 * This device's v2 safety number with one contact device. `null` when either
 * key is unusable (for example, not 32 bytes). That device's grid then renders
 * empty instead of the whole modal failing over one bad directory row.
 */
async function pairNumber(
    myUserId: string, localPub: string, remoteUserId: string, remotePub: string,
): Promise<string | null> {
    try {
        return await computeSafetyNumber(
            { userId: myUserId, pubB64: localPub },
            { userId: remoteUserId, pubB64: remotePub },
        );
    } catch {
        return null;
    }
}

/**
 * ── The multi-device rework ─────────────────────────────────────────────────
 *
 * A contact can have any number of devices, each with its own identity key by
 * design. The previous layout rendered, per remote device, a 4x3 digit grid
 * PLUS a `<details>` listing one more full safety number for every one of the
 * user's OWN other devices — an N x M explosion. At the measured 5 remote
 * devices that modal was already 1008px tall with every detail collapsed, and
 * the pair-wise numbers inside were rendered as raw wrapped monospace strings
 * rather than the grid used one element above them. That is the "totally
 * broken" view: not a bug in one rule, an information architecture that does
 * not survive its own real case.
 *
 * What changed:
 *
 *  1. **One code verifies the whole contact.** The primary flow compares a
 *     single code committing to ALL of the contact's device keys at once
 *     (`utils/verificationCode.ts`). The N-device case stops being N chores.
 *  2. **The N x M section is gone from the cards.** "What your other devices
 *     see" is a property of the user's own account, not of each remote device,
 *     so it is one footnote at the bottom instead of a nested block per card.
 *  3. **Cards collapse.** Per-device digits are still there for anyone who
 *     wants to read them aloud, but folded away by default, so height grows by
 *     a row per device instead of by a grid per device.
 */
function shortDeviceLabel(deviceId: string): string {
    return `Device •••${deviceId.replace(/-/g, '').slice(-4)}`;
}

/** How long the per-device "seal" sequence (sweep, ring, checkmark draw,
 *  confirmation strip) stays mounted before its class is dropped — sized to
 *  the CSS keyframes in cl-kit-ext.css (longest one ends at .9s + .3s delay). */
const SEAL_ANIM_MS = 1200;

/** How long the all-clear's staged arrival stays mounted before its transient
 *  class is dropped — sized to the CSS keyframes in cl-kit-ext.css, where the
 *  longest strand is the outer halo ring (.34s delay + 1s). Dropping the class
 *  is what stops the flourish replaying on every re-render, exactly as
 *  `cl-verify-seal` does above. */
const ALLCLEAR_ANIM_MS = 1400;

/** Hand-drawn checkmark that draws itself in via stroke-dashoffset — only
 *  animates while its ancestor carries `cl-verify-seal` (see CSS); sits
 *  statically fully-drawn otherwise, so it doesn't replay on every re-render. */
const VerifyCheck: React.FC = () => (
    <svg width="12" height="12" viewBox="0 0 13 13" className="cl-verify-check" aria-hidden="true">
        <path d="M2.3 6.8 L5.2 9.6 L10.7 3.4" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

type CodeOutcome = null | { kind: 'match' } | { kind: 'mismatch' } | { kind: 'malformed'; reason: string };

/** Name and platform for one of the user's own devices, from `GET /v1/devices`.
 *  Server-supplied and display-only: the check never depends on a name. */
interface OwnDeviceName { device_name?: string; platform?: string; created_at?: string }

function ownDeviceLabel(d: CoveredDevice, names: Record<string, OwnDeviceName>): string {
    if (d.isSelf) return 'This device';
    const n = names[d.device_id];
    if (n?.device_name) return n.platform ? `${n.device_name} (${n.platform})` : n.device_name;
    return shortDeviceLabel(d.device_id);
}

/**
 * The covered-device list under "your code", and the reason when the code is
 * withheld. See docs/ghost-device.md §2.2-2.3.
 */
const OwnCoverage: React.FC<{
    verdict: OwnSetVerdict;
    names: Record<string, OwnDeviceName>;
    onConfirm: (d: CoveredDevice) => void;
    onReject: (d: CoveredDevice) => void;
}> = ({ verdict, names, onConfirm, onReject }) => {
    const n = verdict.covered.length;
    const needsAnswer = verdict.kind === 'unconfirmed'
        ? verdict.unconfirmed
        : verdict.kind === 'own_key_changed' ? verdict.changed : [];
    const answerIds = new Set(needsAnswer.map(d => d.device_id));
    const danger = { background: 'var(--cl-flash-tint)', border: '1px solid var(--cl-flash)', color: 'var(--cl-flash)' };

    return (
        <div className="flex flex-col gap-1.5" data-testid="own-coverage" data-verdict={verdict.kind}>
            <span className="text-[11px] leading-snug text-cl-faint [overflow-wrap:anywhere]" data-testid="my-code-count">
                Your code covers {n} device{n === 1 ? '' : 's'}:{' '}
                {verdict.covered.filter(d => !answerIds.has(d.device_id)).map(d => ownDeviceLabel(d, names)).join(', ') || 'none'}
                {needsAnswer.length > 0 && <>, plus {needsAnswer.length} you have not confirmed</>}.
                {' '}If that is not every device you use, or one isn't yours, don't share your code.
            </span>

            {verdict.kind === 'self_key_mismatch' && (
                <div className="rounded-lg px-3 py-2 text-xs leading-snug" style={danger} role="alert">
                    <strong>Your code is withheld.</strong> The server is publishing a key for this device that this
                    device does not hold. Anyone comparing codes with you would be checking the wrong key. Don't share
                    your code, and don't send anything sensitive until this is resolved.
                </div>
            )}
            {verdict.kind === 'self_missing' && (
                <span className="text-xs text-cl-faint" role="status">
                    This device's key isn't published yet, so your code would not include it. Try again in a moment.
                </span>
            )}
            {(verdict.kind === 'unconfirmed' || verdict.kind === 'own_key_changed') && (
                <div className="flex flex-col gap-2 rounded-lg px-3 py-2" style={danger} role="alert">
                    <span className="text-xs leading-snug">
                        <strong>Your code is withheld</strong> until you confirm{' '}
                        {needsAnswer.length === 1 ? 'this device' : `these ${needsAnswer.length} devices`}.{' '}
                        {verdict.kind === 'own_key_changed'
                            ? 'A device on your account is now presenting a different key.'
                            : 'A device you have not confirmed is on your account, and it receives your messages.'}
                        {' '}If it isn't yours, someone may be reading your messages.
                    </span>
                    {needsAnswer.map(d => (
                        <div key={d.device_id} className="flex items-center justify-between gap-2" data-testid="own-unconfirmed-row">
                            {/* `min-w-0` is what lets `truncate` work inside a flex
                                row (its min-width is otherwise `auto` = the full
                                text width, which widens the modal instead). The
                                full name stays reachable in the tooltip. */}
                            <span
                                className="min-w-0 text-xs font-semibold truncate"
                                title={ownDeviceLabel(d, names)}
                            >
                                {ownDeviceLabel(d, names)}
                                {d.status === 'rejected' && ' (you said this is not yours)'}
                                {verdict.kind === 'own_key_changed' && ' (new key)'}
                            </span>
                            <span className="flex gap-1.5 shrink-0">
                                <ClButton size="sm" variant="ghost" onClick={() => onReject(d)}>Not mine</ClButton>
                                <ClButton size="sm" onClick={() => onConfirm(d)}>This is mine</ClButton>
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export const SafetyVerificationModal: React.FC<Props> = ({
    isOpen, onClose, myUserId, myDeviceId = null, remoteUserId, remoteUsername, token, onResolved, onSendCode, activeWarning = null,
}) => {
    const [devices, setDevices] = useState<DeviceEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError]     = useState<string | null>(null);

    /** Code committing to the contact's whole device set — what we compare against. */
    const [theirCode, setTheirCode] = useState<string | null>(null);
    /** Code committing to the user's OWN device set — what they read out to the contact. */
    const [myCode, setMyCode]       = useState<string | null>(null);
    const [typed, setTyped]         = useState('');
    const [outcome, setOutcome]     = useState<CodeOutcome>(null);
    /** Tri-state, NOT a boolean. The old boolean could only say "I asked the
     *  clipboard to take this", which is not the same claim as "it took it" —
     *  see `handleCopy`. A failure has to be able to say so. */
    const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle');

    /** How many devices `myCode` commits to — travels with the embed as a
     *  display hint ("across 3 devices"), never as anything load-bearing. */
    const [myDeviceCount, setMyDeviceCount] = useState(0);
    const [sendState, setSendState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

    const [expanded, setExpanded]   = useState<Record<string, boolean>>({});
    const [manualOpen, setManualOpen] = useState(false);
    /** How many of the user's OWN devices are not this one. Only the count is
     *  displayed (in the footnote), so no numbers are derived for them. */
    const [myOtherDeviceCount, setMyOtherDeviceCount] = useState(0);

    /**
     * Ghost-device interlock (docs/ghost-device.md §2.2). `ownRows` is the
     * EXACT listing `myCode` was computed from, and `ownVerdict` is the
     * ledger's judgement of that same array. "Your code" is rendered only when
     * the verdict allows it. `ownSelfPub` is this device's key from the local
     * keystore, never from the listing.
     */
    const [ownRows, setOwnRows] = useState<ListedDevice[] | null>(null);
    const [ownVerdict, setOwnVerdict] = useState<OwnSetVerdict | null>(null);
    const [ownSelfPub, setOwnSelfPub] = useState<string | null>(null);
    /** The ledger could not be read yet (the account store is still warming up). */
    const [ownNotReady, setOwnNotReady] = useState(false);
    const [ownNames, setOwnNames] = useState<Record<string, OwnDeviceName>>({});

    /**
     * True when the device list came from the PIN STORE rather than a live
     * `GET /keys/identity_keys` — i.e. the directory could not be reached and
     * the user's own durable records were used instead. Only ever set for a
     * contact those records say is fully verified (see the fetch effect), and
     * surfaced in the all-clear so the claim is not overstated: local records
     * cannot know about a device added since.
     */
    const [fromPins, setFromPins] = useState(false);
    /** The user asked to run the live comparison again from the all-clear. */
    const [infoOpen, setInfoOpen] = useState(false);
    const [recheckOpen, setRecheckOpen] = useState(false);
    /** Transient — drives the all-clear's staged arrival, see ALLCLEAR_ANIM_MS. */
    const [allClearAnim, setAllClearAnim] = useState(false);
    /**
     * One celebration per open. Without this the arrival would replay whenever
     * the panel's visibility toggled — and, worse, would fire a second time
     * right after a Quick-verify match, which already has its own seal.
     */
    const celebratedRef = useRef(false);

    const [sealingId, setSealingId] = useState<string | null>(null);
    /** Whole-contact version of `sealingId`: a code match verifies EVERY device
     *  at once, so the seal belongs to the Quick verify card and the header
     *  shield rather than to any one device row. */
    const [codeSealing, setCodeSealing] = useState(false);
    const sealTimer     = useRef<ReturnType<typeof setTimeout> | null>(null);
    const copyTimer     = useRef<ReturnType<typeof setTimeout> | null>(null);
    const codeSealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const allClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => () => {
        if (sealTimer.current) clearTimeout(sealTimer.current);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        if (codeSealTimer.current) clearTimeout(codeSealTimer.current);
        if (allClearTimer.current) clearTimeout(allClearTimer.current);
    }, []);

    useEffect(() => {
        if (!isOpen || !token || !myUserId) return;

        /**
         * The offline path, and ONLY for the already-verified case.
         *
         * This modal's device list is a live `GET /keys/identity_keys`, so
         * without the network the old code fell straight into the error branch
         * — telling a user who HAS verified this contact, whose own device
         * holds durable proof of it, that we could not compute a fingerprint.
         * That reads as "something is wrong with your verification", which is
         * both false and the opposite of reassuring.
         *
         * The pin store is the same source the chat-header shield reads (via
         * `getKnownDevices` → `deriveContactTrust`), so falling back to it is
         * what makes the modal AGREE with the shield offline rather than
         * contradict it. It is also entirely local, user-authored data: no
         * server input reaches this decision.
         *
         * Deliberately narrow. If the pins do not say `verified` we return
         * false and the caller keeps the existing error exactly as it was —
         * partial verification, an unvouched device and a key change are all
         * situations where "we could not look" is the honest report, and
         * dressing them up from a cache would be inventing reassurance. The
         * all-clear says which records it is reading, because local records
         * cannot know about a device added since.
         */
        const showPinnedVerifiedInstead = async (localPub: string | null): Promise<boolean> => {
            try {
                const known = getKnownDevices(myUserId, remoteUserId);
                const pinned = Object.entries(known)
                    .map(([deviceId, rec]) => ({
                        deviceId, pub: rec.pub, verified: rec.verified, legacy: isLegacyVerified(rec),
                    }));
                const pinTrust = deriveContactTrust({ devices: pinsToTrustDevices(known) });
                // A legacy-verified contact is still a fully VOUCHED one, so it
                // keeps the offline view. What it renders there is the refresh
                // prompt, not the all-clear (see `allClear` below).
                if (pinTrust.level !== 'verified' && pinTrust.level !== 'verified_legacy') return false;

                const entries: DeviceEntry[] = await Promise.all(pinned.map(async p => ({
                    device_id: p.deviceId,
                    pub: p.pub,
                    // Null when the LOCAL keystore is what failed rather
                    // than the directory; the by-eye grid then renders
                    // empty, which is honest, and the all-clear (which
                    // does not use it) is unaffected.
                    safetyNumber: localPub ? await pairNumber(myUserId, localPub, remoteUserId, p.pub) : null,
                    state: 'verified' as const,
                    legacy: p.legacy,
                })));
                setDevices(entries);
                // Pure, no round trip — so the re-check affordance still works
                // offline, against the key set the user actually vouched for.
                setTheirCode(await computeContactCode(remoteUserId, pinned.map(p => p.pub)));
                setFromPins(true);
                return true;
            } catch {
                return false;
            }
        };

        const compute = async () => {
            setLoading(true);
            setError(null);
            setDevices([]);
            setTheirCode(null);
            setMyCode(null);
            setMyDeviceCount(0);
            setMyOtherDeviceCount(0);
            setOwnRows(null);
            setOwnVerdict(null);
            setOwnSelfPub(null);
            setOwnNotReady(false);
            setOwnNames({});
            setSendState('idle');
            setTyped('');
            setOutcome(null);
            setFromPins(false);
            setRecheckOpen(false);
            celebratedRef.current = false;

            // Hoisted out of the try so the offline fallback below can still
            // compute per-device safety numbers when it was the DIRECTORY that
            // failed rather than the local keystore.
            let localPub: string | null = null;
            try {
                localPub = window.electronAPI
                    ? await window.electronAPI.getLocalIdentity()
                    : null;
                if (!localPub) throw new Error('Local identity key not found');

                // identity_keys, NOT prekey_bundle: the bundle endpoint claims
                // one one-time prekey per device per call — session material,
                // not display material. This modal used to burn the contact's
                // OTPs on every open.
                const res = await axios.get(
                    `${API_BASE}/keys/identity_keys?user_id=${remoteUserId}`,
                    { headers: { Authorization: `Bearer ${token}` } },
                );
                const bundles: { device_id: string; identity_key_pub_b64: string }[] = res.data ?? [];
                if (!bundles.length) throw new Error('Contact has no encryption keys on record');

                const entries: DeviceEntry[] = [];
                const ownPub = localPub;
                // Derived concurrently: each is a native PBKDF2 call, and this
                // device's own half is memoised in safetyNumber.ts.
                const numbers = await Promise.all(
                    bundles.map(b => pairNumber(myUserId, ownPub, remoteUserId, b.identity_key_pub_b64)),
                );
                for (const [i, b] of bundles.entries()) {
                    // Deliberately does NOT pin these rows, and the comment that
                    // used to sit here claiming the pin was needed for
                    // per-device key-change detection (RC-7) was wrong.
                    //
                    // These rows come straight from the server's directory and
                    // carry no signature from anyone. Pinning them would let a
                    // malicious server seed the TRUST ANCHOR for a device the
                    // user has never heard from — and a later real envelope
                    // from that device id would then read `ok` against a
                    // server-chosen key. Merely opening this modal would
                    // establish trust the user never granted.
                    //
                    // Nothing is lost. getVerificationState returns
                    // 'unverified' for a device with no record, which is the
                    // honest answer for one you have never received a message
                    // from; key-change detection still fires for genuinely
                    // known devices, because their record was written by a real
                    // envelope; and markVerified writes the record itself, so
                    // verifying still works and the anchor is created by an
                    // explicit user act rather than by a server response.
                    const { state, legacy } =
                        getDeviceVerification(myUserId, remoteUserId, b.identity_key_pub_b64, b.device_id);
                    entries.push({
                        device_id: b.device_id, pub: b.identity_key_pub_b64, safetyNumber: numbers[i], state, legacy,
                    });
                }
                setDevices(entries);
                setTheirCode(await computeContactCode(remoteUserId, bundles.map(b => b.identity_key_pub_b64)));

                // The user's OWN devices: needed for two separate things — the
                // code THEY will compare against (over all of this account's
                // keys), and the footnote explaining why the digits differ on
                // the user's laptop. Best-effort: on failure the code section
                // degrades to "unavailable" rather than blocking verification
                // of the contact, which is the direction that matters here.
                try {
                    const mine = await axios.get(
                        `${API_BASE}/keys/identity_keys?user_id=${myUserId}`,
                        { headers: { Authorization: `Bearer ${token}` } },
                    );
                    const myBundles: { device_id: string; identity_key_pub_b64: string }[] = mine.data ?? [];
                    // The ghost-device check runs on THIS array, the same one
                    // hashed into myCode below, so what was checked is exactly
                    // what the code commits to.
                    const rows: ListedDevice[] = myBundles.map(b => ({
                        device_id: b.device_id, pub: b.identity_key_pub_b64,
                    }));
                    const self = { deviceId: myDeviceId ?? '', pub: localPub };
                    observeOwnDevices(myUserId, self, rows, true);
                    const ledger = loadOwnLedger(myUserId);
                    setOwnRows(rows);
                    setOwnSelfPub(localPub);
                    if (ledger === undefined) setOwnNotReady(true);
                    else setOwnVerdict(assessOwnDeviceSet(ledger, rows, self));
                    if (myBundles.length) {
                        setMyCode(await computeContactCode(myUserId, myBundles.map(b => b.identity_key_pub_b64)));
                        setMyDeviceCount(myBundles.length);
                    }
                    setMyOtherDeviceCount(myBundles.filter(d => d.identity_key_pub_b64 !== localPub).length);
                } catch { /* display-only extra — degrade to none */ }

                // Names for the covered-device list. Own account only, and
                // display-only: nothing above depends on it.
                try {
                    const named = await axios.get(`${API_BASE}/devices`, {
                        headers: { Authorization: `Bearer ${token}` },
                    });
                    const byId: Record<string, OwnDeviceName> = {};
                    for (const d of (Array.isArray(named.data) ? named.data : []) as (OwnDeviceName & { device_id?: string })[]) {
                        if (d?.device_id) byId[d.device_id] = { device_name: d.device_name, platform: d.platform, created_at: d.created_at };
                    }
                    setOwnNames(byId);
                } catch { /* names are cosmetic */ }
            } catch (err: unknown) {
                if (!(await showPinnedVerifiedInstead(localPub))) {
                    setError(
                        (err instanceof Error && err.message) || 'Failed to compute safety number',
                    );
                }
            } finally {
                setLoading(false);
            }
        };

        compute();
    }, [isOpen, token, myUserId, myDeviceId, remoteUserId]);

    /** Re-judge the SAME listing after the user answers for one of its devices. */
    const reassessOwn = useCallback(() => {
        if (!ownRows || !ownSelfPub) return;
        const ledger = loadOwnLedger(myUserId);
        if (ledger === undefined) return;
        setOwnVerdict(assessOwnDeviceSet(ledger, ownRows, { deviceId: myDeviceId ?? '', pub: ownSelfPub }));
    }, [ownRows, ownSelfPub, myUserId, myDeviceId]);

    const handleConfirmOwn = useCallback((d: CoveredDevice) => {
        confirmOwnDevice(myUserId, d.device_id, d.pub);
        reassessOwn();
    }, [myUserId, reassessOwn]);

    /**
     * "Not mine": remembered locally as rejected, so it stays an alarm for as
     * long as it is listed, and a best-effort revoke. Against a malicious
     * server the revoke means nothing, which is why the local record is what
     * matters; against a stolen password it removes the device.
     */
    const handleRejectOwn = useCallback(async (d: CoveredDevice) => {
        rejectOwnDevice(myUserId, d.device_id, d.pub);
        reassessOwn();
        try {
            await axios.post(`${API_BASE}/devices/${encodeURIComponent(d.device_id)}/revoke`, {}, {
                headers: { Authorization: `Bearer ${token}`, ...(myDeviceId ? { 'x-device-id': myDeviceId } : {}) },
            });
        } catch { /* the local record already withholds the code */ }
    }, [myUserId, myDeviceId, token, reassessOwn]);

    /** "Your code" may be shown: a code exists AND the ledger accepts every device it covers. */
    const myCodeAllowed = !!myCode && !!ownVerdict && codeMayBeShown(ownVerdict);

    const trust = useMemo(() => deriveContactTrust({
        // A device whose pinned key no longer matches what the directory serves
        // is the `key_changed` verdict by another name, and the badge has to say
        // so. Without this the header renders a mild amber "Not verified" over a
        // modal whose own title says "Security Alert" — the two halves of the
        // same screen disagreeing about how bad the situation is.
        verdict: devices.some(d => d.state === 'key_changed') ? 'key_changed' : null,
        devices: devices.map(d => ({ deviceId: d.device_id, verified: d.state === 'verified', legacy: d.legacy })),
    }), [devices]);

    /**
     * ── The all-clear ───────────────────────────────────────────────────────
     *
     * Asked for as: "if you've already verified all the keys I don't think we
     * should have it show the 'quick verify' thing — just have it show a nice
     * animation indicating that everything is verified and secure."
     *
     * The condition is `trust.level === 'verified'` and nothing else — the
     * SAME `trust` object the header `TrustBadge` two lines below is rendering,
     * so the shield and the panel are not two opinions that could drift apart;
     * they are one value read twice. `deriveContactTrust` is where the
     * per-device reality collapses into a displayable claim, and re-deciding
     * "is this person verified?" here is exactly the second notion of verified
     * that `contactTrust.ts` exists to prevent. Everything that makes green
     * narrow therefore comes for free and is not re-litigated here:
     *
     *   • one unvouched sibling device → 'partially_verified', not 'verified';
     *   • a device the pin store has never seen → `getVerificationState`
     *     returns 'unverified' for it, so the same branch catches it. That is
     *     the event safety numbers exist to surface and it must never read as
     *     "you're done here";
     *   • every device vouched for, but at least one vouch predates
     *     safety-number v2 → 'verified_legacy'. The quick-verify card stays
     *     up, with a calm "refresh" line, because green would be claiming a
     *     comparison the user never made (G1);
     *   • a changed key or any warnable verdict → 'compromised';
     *   • no keys at all → 'unverifiable'.
     *
     * Each of those keeps the existing flow, untouched. Green is the narrow
     * case.
     */
    const allClear = !loading && !error && trust.level === 'verified';
    /**
     * `codeSealing` is the one thing that defers the panel: a Quick-verify
     * match flips every device to verified WHILE its own seal is mid-flight,
     * and swapping the card out from under that animation would cut off the
     * confirmation the user just earned. Once `recheckOpen` is set the panel is
     * already on screen, so there is nothing to defer and it simply stays put
     * rather than unmounting and re-entering.
     */
    const showAllClear = allClear && (recheckOpen || !codeSealing);
    /** The quick-verify card: the default, and on request when already clear. */
    const showQuickVerify = !allClear || recheckOpen || codeSealing;

    useEffect(() => {
        if (!showAllClear || celebratedRef.current) return;
        celebratedRef.current = true;
        setAllClearAnim(true);
        if (allClearTimer.current) clearTimeout(allClearTimer.current);
        allClearTimer.current = setTimeout(() => setAllClearAnim(false), ALLCLEAR_ANIM_MS);
    }, [showAllClear]);

    const markOne = useCallback((device_id: string, pub: string) => {
        markVerified(myUserId, remoteUserId, pub, device_id);
        setDevices(prev => prev.map(d => (d.device_id === device_id ? { ...d, state: 'verified', legacy: false } : d)));
        onResolved?.();
        // If this click is the one that completes the set, the per-device seal
        // below IS the celebration for it. Spending the budget here keeps the
        // all-clear from arriving with a second flourish a beat later.
        celebratedRef.current = true;
        setSealingId(device_id);
        if (sealTimer.current) clearTimeout(sealTimer.current);
        sealTimer.current = setTimeout(() => setSealingId(null), SEAL_ANIM_MS);
    }, [myUserId, remoteUserId, onResolved]);

    /**
     * The one-click path. A matching code means the key set this client holds
     * for the contact is the key set the contact themselves is looking at — so
     * EVERY device in it is vouched for, which is exactly the multi-device
     * problem the per-device flow could not solve without N separate chores.
     *
     * A mismatch deliberately marks NOTHING. It is also not treated as a
     * transcription error: `checkCode` has already separated "you pasted it
     * wrong" (malformed) from "these are different keys" (mismatch), and
     * softening the latter into "try again" is how a real interception gets
     * clicked past.
     */
    const handleVerifyCode = useCallback(() => {
        if (!theirCode) return;
        const check = checkCode(theirCode, typed);
        if (check.result === 'malformed') {
            setOutcome({ kind: 'malformed', reason: check.reason });
            return;
        }
        if (check.result === 'mismatch') {
            setOutcome({ kind: 'mismatch' });
            return;
        }
        setOutcome({ kind: 'match' });
        for (const d of devices) {
            // A legacy vouch is re-marked too: this match IS the
            // current-strength check that refreshes it.
            if (d.state !== 'verified' || d.legacy) markVerified(myUserId, remoteUserId, d.pub, d.device_id);
        }
        setDevices(prev => prev.map(d => ({ ...d, state: 'verified', legacy: false })));
        onResolved?.();

        // The confirmation flourish. Reuses the existing `cl-verify-seal`
        // sequence (light sweep across the card, badge spring + ring, the
        // checkmark drawing itself in, the strip sliding up) plus the
        // `cl-verify-allclear` shield pop that cl-kit-ext.css already defines
        // for precisely this moment — "ALL of a contact's devices become
        // verified" — but which nothing had ever applied. Both are scoped
        // under a transient class so they play once, on the click, and never
        // on an ordinary re-render; both are already disabled wholesale by the
        // `prefers-reduced-motion` block at the end of that CSS section, which
        // is why there is no JS motion check here.
        //
        // Same budget note as `markOne`: this sequence is the celebration for
        // the match, so the all-clear that follows it arrives quietly.
        celebratedRef.current = true;
        setCodeSealing(true);
        if (codeSealTimer.current) clearTimeout(codeSealTimer.current);
        codeSealTimer.current = setTimeout(() => setCodeSealing(false), SEAL_ANIM_MS);
    }, [theirCode, typed, devices, myUserId, remoteUserId, onResolved]);

    const handleAcknowledgeChange = (device_id: string, pub: string) => {
        acknowledgeKeyChange(myUserId, remoteUserId, pub, device_id);
        setDevices(prev => prev.map(d => (d.device_id === device_id ? { ...d, state: 'unverified', legacy: false } : d)));
        onResolved?.();
    };

    /**
     * ── Why the copy button did nothing, and why it LOOKED like it worked ────
     *
     * This used to call `navigator.clipboard.writeText(...)` directly. In the
     * packaged renderer that call never reaches the clipboard:
     * `writeText` makes Chromium request the `clipboard-sanitized-write`
     * permission, and `electron/main.ts`'s `setPermissionRequestHandler` ends
     * in a catch-all `callback(false)` that denies every permission except
     * `media` and `speaker-selection`. So the promise rejects with
     * `NotAllowedError` — every time, on every platform, not intermittently.
     *
     * Two separate mistakes then hid that from the user:
     *   1. `.catch(() => {})` swallowed the rejection whole — no throw, no log,
     *      nothing in the console to find.
     *   2. `setCopied(true)` ran on the SYNCHRONOUS path, before the promise
     *      settled, so the button flipped to a green check regardless. The UI
     *      asserted "Copied" while the clipboard still held whatever it had.
     *      That is worse than a dead button: the user pastes stale content into
     *      the out-of-band channel and compares the wrong code.
     *
     * The repo already had the right answer and this call site simply wasn't
     * using it: `utils/clipboard.ts`'s `writeToClipboard` tries the Electron
     * IPC bridge FIRST (`clipboard:write` → the main-process `clipboard`
     * module, which is not subject to any renderer permission gate), then the
     * web API, then a `document.execCommand('copy')` fallback, and throws if
     * all three fail. Awaiting it and keying the icon off the RESULT is what
     * makes the failure path visible instead of silent.
     */
    const handleCopy = useCallback(async () => {
        if (!myCode || !myCodeAllowed) return;
        if (copyTimer.current) clearTimeout(copyTimer.current);
        try {
            await writeToClipboard(formatCode(myCode));
            setCopyState('ok');
        } catch {
            setCopyState('fail');
        }
        copyTimer.current = setTimeout(() => setCopyState('idle'), 2400);
    }, [myCode, myCodeAllowed]);

    /**
     * Put the user's own code into the conversation as a `safety_number`
     * embed, so the other side compares with a click instead of transcribing
     * forty characters.
     *
     * Note what this does NOT replace: Copy is still here, and is still the
     * only path that can actually establish trust. A code that travels over
     * Cipherline proves nothing on its own — the recipient's embed says so and
     * makes them attest to an out-of-band comparison before anything is marked
     * verified — so Copy (into a call, a text, a different app) remains the
     * channel that carries the real evidence. Send is the convenience; Copy is
     * the ceremony. Dropping Copy would have made the weaker path one click
     * and the stronger path manual.
     */
    const handleSend = useCallback(async () => {
        if (!myCode || !myCodeAllowed || !onSendCode) return;
        setSendState('sending');
        try {
            await onSendCode(myCode, myDeviceCount);
            setSendState('sent');
        } catch {
            setSendState('error');
        }
    }, [myCode, myCodeAllowed, myDeviceCount, onSendCode]);

    const anyKeyChanged = devices.some(d => d.state === 'key_changed');

    return (
        <ClModal
            open={isOpen}
            onClose={onClose}
            width={400}
            label={anyKeyChanged ? 'Security Alert' : 'Verify Identity'}
            // Height still scales with the contact's device count, just far more
            // slowly now that each device is a collapsed row rather than a digit
            // grid plus a nested per-device block. The cap and scroll stay: past
            // the viewport `.mod`'s centred flex puts the top of the list
            // permanently out of reach (scrollTop clamps at 0). Nothing here
            // escapes the card — no ClSelect, no popover — so the overflow is safe.
            cardClassName="flex flex-col items-stretch gap-3 mcard--scroll"
            cardStyle={{ padding: 20 }}
        >
            {/* Header.

                When everything checks out the shield becomes the hero: it
                grows, and the crest wrapper gives its halo rings a containing
                block (same reason `cl-verify-allclear` sets `position:relative`
                — TrustBadge's own `inline-flex` span establishes none, so an
                absolutely-positioned ring would escape to whatever ancestor
                happens to be positioned). Still the SAME `TrustBadge` fed the
                SAME `trust`, so the celebration cannot say anything the badge
                is not already saying. */}
            <div className="shrink-0 flex flex-col items-center gap-1 text-center">
                <div className={allClear ? `cl-allclear-crest ${allClearAnim ? 'cl-allclear--seal' : ''}` : ''}>
                    <TrustBadge
                        trust={trust}
                        displayName={remoteUsername}
                        size={allClear ? 36 : 26}
                        className={codeSealing ? 'cl-verify-allclear' : ''}
                    />
                </div>
                <div className="flex items-center justify-center gap-1.5">
                    <h2 className="m-0 text-cl-text text-base font-semibold">
                        {anyKeyChanged ? 'Security Alert' : allClear ? 'Identity verified' : 'Verify Identity'}
                    </h2>
                    {/* The plain-English "what is this?" lives behind this icon so
                        the screen itself can stay short. */}
                    <button
                        type="button"
                        onClick={() => setInfoOpen(v => !v)}
                        aria-expanded={infoOpen}
                        aria-label="What is this?"
                        title="What is this?"
                        className="inline-flex items-center justify-center rounded-full text-cl-faint hover:text-cl-lume transition-colors"
                        style={{ background: 'none', border: 0, padding: 2, cursor: 'pointer', color: infoOpen ? 'var(--cl-lume)' : undefined }}
                    >
                        <Info size={15} />
                    </button>
                </div>
                {/* The instruction is suppressed once it has been carried out —
                    asking someone to "confirm the keys really are theirs" over a
                    contact they have already confirmed is the whole complaint. */}
                {!allClear && (
                    <p className="text-cl-faint text-[13px] leading-snug m-0">
                        Make sure it's really <strong className="text-cl-muted">{remoteUsername}</strong> on the other end
                        {devices.length > 1 && <> (all {devices.length} of their devices)</>}.
                    </p>
                )}
            </div>

            {/* ── Scrolling body ───────────────────────────────────────────
                Reported: "if they have a lot of devices it kinda breaks the UI
                and I cannot check their code again because the button is cut
                off." That is the flexbox overflow trap, and `mcard--scroll`
                alone cannot prevent it. The card is a `flex-col` with a
                max-height, so once the by-eye list outgrows the viewport its
                children do not overflow — they SHRINK, and any child with
                `overflow: hidden` (the all-clear card, the quick-verify card,
                every device row) has an automatic min-height of 0, so it
                shrinks without limit and clips its own content: the all-clear
                card collapsed to a 34px sliver with "Check their code again"
                cut in half and unclickable.

                So the height cap lives on a body that is told to scroll
                (`min-h-0 flex-1 overflow-y-auto`), between a header and a
                footer that are `shrink-0` and therefore always on screen. The
                children sit in a SECOND, height:auto column inside it, so they
                are laid out at their natural height and the scroll container
                (not the flex algorithm) absorbs the excess. `-mx-5 px-5` puts
                the scrollbar on the card's edge instead of 20px inside it.
                `tabIndex=0` makes the region scrollable from the keyboard even
                when focus is up in the header. */}
            <div
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain -mx-5 px-5"
                data-testid="verify-scroll-body"
                role="region"
                aria-label="Verification details"
                tabIndex={0}
            >
            <div className="flex flex-col items-stretch gap-3">
            {infoOpen && (
                <div
                    className="w-full rounded-xl px-3.5 py-3 text-[12.5px] leading-relaxed text-cl-muted flex flex-col gap-1.5"
                    style={{ background: 'var(--cl-lume-tint)', border: '1px solid rgba(37,224,200,0.22)' }}
                    data-testid="verify-info"
                >
                    <strong className="text-cl-text text-[13px]">What's a verification code?</strong>
                    <span>
                        Everything you and <strong className="text-cl-text">{remoteUsername}</strong> send is locked with
                        keys that belong only to the two of you. A verification code is a short fingerprint of those keys.
                    </span>
                    <span>
                        If the code you have for {remoteUsername} matches the one they see for themselves, nobody is
                        secretly sitting in the middle. Compare it in person or on a call, not by a message sent through
                        Cipherline. A code that arrives through the app could have been written by an attacker, so it
                        can't prove anything.
                    </span>
                    <span>
                        It's a one-time check, and you'll be warned if their keys ever change.
                    </span>
                </div>
            )}

            {loading ? (
                <div className="w-full rounded-xl border border-white/[0.06] bg-black/30 p-5">
                    <p className="text-center text-cl-muted text-sm m-0">Computing fingerprint…</p>
                </div>
            ) : error ? (
                <div className="w-full rounded-xl border border-white/[0.06] bg-black/30 p-5">
                    <p className="text-center text-cl-danger text-sm m-0">{error}</p>
                </div>
            ) : (
                <>
                    {/* ── Everything checks out ────────────────────────────────
                        The narrow, fully-verified case. It REPLACES the
                        quick-verify card rather than sitting above it: leaving
                        both up would still be asking for the work, which is the
                        thing being fixed.

                        What it does NOT do is take the re-check away. The
                        safety-code embed set that precedent — when verified its
                        button demotes to "Check this code again" — and the
                        reason is real: remembering that someone verified must
                        not cost them a live comparison, which is exactly what a
                        person does when something feels off. So there are still
                        two routes out of here, one quiet and one quieter: the
                        ghost button below, and the by-eye disclosure underneath
                        the card, which is never hidden. */}
                    {showAllClear && (
                        <div className={`cl-allclear ${allClearAnim ? 'cl-allclear--seal' : ''}`} role="status">
                            <span className="cl-allclear-head">
                                <VerifyCheck />
                                {devices.length === 1
                                    ? 'Their device is verified'
                                    : `All ${devices.length} of their devices are verified`}
                            </span>
                            {/* `contactTrust`'s own wording, not a second copy
                                of it — the same sentence the header shield's
                                tooltip carries, promoted to something you can
                                read without hovering. */}
                            <p className="cl-allclear-body">{trustExplanation(trust, remoteUsername)}</p>
                            {fromPins && (
                                <p className="cl-allclear-body" style={{ color: 'var(--cl-faint)' }}>
                                    Offline, so this is from the records on this device. If {remoteUsername}{' '}
                                    has added a device since, it won't show up here until you reconnect.
                                </p>
                            )}
                            {!recheckOpen && (
                                <div className="cl-allclear-foot">
                                    <ClButton size="sm" variant="ghost" fullWidth onClick={() => setRecheckOpen(true)}>
                                        Check their code again
                                    </ClButton>
                                </div>
                            )}
                        </div>
                    )}

                    {/* ── Quick verify ─────────────────────────────────────────
                        The honest one-click flow: the machine does the
                        comparison, the human still has to have obtained the
                        code somewhere this app cannot reach. The caveat below
                        is load-bearing, not boilerplate — pasting a code that
                        arrived over Cipherline proves nothing, and a user who
                        does that and gets a green shield has been lied to. */}
                    {showQuickVerify && (
                    <div
                        className={`relative overflow-hidden w-full rounded-xl border border-white/[0.06] bg-black/30 p-3.5 flex flex-col gap-2.5 ${
                            codeSealing ? 'cl-verify-seal' : ''
                        }`}
                    >
                        <div className="flex items-baseline justify-between gap-2">
                            <span className="text-sm font-semibold text-cl-text">Quick verify</span>
                            <span className="text-[11px] text-cl-faint">{CODE_LENGTH} characters</span>
                        </div>

                        {/* The legacy-verification path. Every key is still
                            vouched for, so this is worded as a refresh, not a
                            problem: it is the one place that says WHY the
                            shield is not green, next to the one action that
                            makes it green. */}
                        {trust.level === 'verified_legacy' && (
                            <p className="text-[11px] leading-snug m-0" style={{ color: 'var(--cl-lume)' }} role="status">
                                You verified {remoteUsername} before safety numbers were strengthened. Nothing is
                                wrong. Compare codes once more to refresh it.
                            </p>
                        )}

                        <div className="flex items-start gap-1.5" style={{ color: 'var(--cl-glow)' }}>
                            <AlertTriangle size={13} className="shrink-0 mt-px" />
                            <span className="text-[11.5px] leading-snug">
                                Get their code <strong>outside Cipherline</strong>: in person, or on a call. A code sent
                                through the app proves nothing.
                            </span>
                        </div>

                        <div className="flex flex-col gap-2">
                            <label className="text-xs text-cl-muted" htmlFor="cl-verify-code-input">
                                Paste {remoteUsername}'s code
                            </label>
                            {/* The count is the human half of the ghost-device
                                check: a matching code implies matching counts,
                                but only a person knows how many devices they
                                really have. */}
                            <span className="text-[11px] leading-snug text-cl-faint" data-testid="their-code-count">
                                Their code covers {devices.length} device{devices.length === 1 ? '' : 's'}. Check that
                                matches how many they use.
                            </span>
                            {/* `items-center` is load-bearing, and its absence is
                                what made this button "look bad". With the default
                                `align-items: stretch`, the `.clb` wrapper (which has
                                no height of its own) was stretched to the ClInput's
                                full height while the `.cap` surface inside kept its
                                own smaller natural height and sat top-aligned — so
                                the kit's two depth sheets (`.l.l2`/`.l.l1`, sized to
                                the stretched wrapper) hung out below the cap as a
                                detached darker slab. Exactly the bug already
                                diagnosed and fixed on the invite row in
                                ServerSettingsModal.tsx; the fix is the same.

                                `size="sm"` is the second half: the default `.cap` is
                                15px/800-weight type with 13px/25px padding (~46px
                                tall, 14px radius) against a 14px `.inp` with 11px/15px
                                padding (~40px tall, 13px radius). `clb--sm` brings it
                                to 13.5px type / 9px-18px padding / 11px radius, which
                                is the scale the rest of this compact card already
                                uses — and the convention for a button in an input row
                                across the app (112 other `size="sm"` call sites). */}
                            <div className="flex items-center gap-2">
                                <ClInput
                                    id="cl-verify-code-input"
                                    value={typed}
                                    spellCheck={false}
                                    autoComplete="off"
                                    placeholder="XXXX XXXX XXXX XXXX …"
                                    className="flex-1 font-mono"
                                    onChange={e => { setTyped(e.target.value); setOutcome(null); }}
                                    onKeyDown={e => { if (e.key === 'Enter') handleVerifyCode(); }}
                                />
                                <ClButton size="sm" onClick={handleVerifyCode} disabled={!typed.trim()}>Check</ClButton>
                            </div>
                        </div>

                        {outcome?.kind === 'match' && (
                            <div className="cl-verify-confirm" role="status">
                                <VerifyCheck />
                                <span>
                                    Match — all {devices.length} device{devices.length === 1 ? '' : 's'} verified.
                                </span>
                            </div>
                        )}
                        {outcome?.kind === 'mismatch' && (
                            <div
                                className="flex items-start gap-2 rounded-lg px-3 py-2"
                                style={{ background: 'var(--cl-flash-tint)', border: '1px solid var(--cl-flash)' }}
                                role="alert"
                            >
                                <AlertTriangle size={14} className="shrink-0 mt-0.5" style={{ color: 'var(--cl-flash)' }} />
                                <span className="text-xs leading-snug" style={{ color: 'var(--cl-flash)' }}>
                                    <strong>These do not match.</strong> The keys this app was given for {remoteUsername}
                                    {' '}are not the keys they are looking at. Nothing has been marked verified. Check you
                                    copied the whole code — and if it still fails, do not send anything sensitive and
                                    reach them another way.
                                </span>
                            </div>
                        )}
                        {outcome?.kind === 'malformed' && (
                            <p className="text-xs text-cl-muted m-0">{outcome.reason}</p>
                        )}

                        {/* Their turn: verification is directional, and a user
                            who only pastes has verified the contact without the
                            contact having verified them. */}
                        <div className="flex flex-col gap-1.5 pt-1 border-t border-white/[0.06]">
                            <span className="text-xs text-cl-muted">
                                Your code, so {remoteUsername} can check you too
                            </span>
                            {ownVerdict && (
                                <OwnCoverage
                                    verdict={ownVerdict}
                                    names={ownNames}
                                    onConfirm={handleConfirmOwn}
                                    onReject={d => { void handleRejectOwn(d); }}
                                />
                            )}
                            {myCodeAllowed ? (
                                <div className="flex items-center gap-2" data-testid="my-code">
                                    {/* `break-words`, never `break-all`: the code is read
                                        aloud in four-character groups, and break-all splits
                                        mid-group ("… WV / 64"), which is exactly the kind of
                                        transcription ambiguity the grouping exists to avoid.
                                        Wrapping at the spaces keeps every group intact. */}
                                    <code className="flex-1 font-mono text-[12px] leading-snug text-cl-text break-words">
                                        {formatCode(myCode)}
                                    </code>
                                    <ClButton
                                        icon
                                        size="sm"
                                        variant="ghost"
                                        onClick={handleCopy}
                                        tooltip={
                                            copyState === 'ok'   ? 'Copied'
                                            : copyState === 'fail' ? 'Copy failed'
                                            : 'Copy your code'
                                        }
                                    >
                                        {copyState === 'ok'   ? <Check size={16} className="text-cl-ok" />
                                         : copyState === 'fail' ? <X size={16} style={{ color: 'var(--cl-flash)' }} />
                                         : <Copy size={16} />}
                                    </ClButton>
                                </div>
                            ) : ownNotReady ? (
                                <span className="text-xs text-cl-faint">Checking your devices. Close and reopen this in a moment.</span>
                            ) : ownVerdict && myCode ? (
                                /* Withheld: OwnCoverage above says why and offers the fix. */
                                null
                            ) : (
                                <span className="text-xs text-cl-faint">Unavailable — could not read your own device keys.</span>
                            )}
                            {/* A tooltip is hover-only, so it cannot be the whole
                                failure report — a user who clicked and saw nothing
                                happen is precisely the one not hovering. This line
                                states the failure in the flow, and names the manual
                                recovery (the code above is selectable text). */}
                            {copyState === 'fail' && (
                                <span className="text-[11px] leading-snug" style={{ color: 'var(--cl-flash)' }} role="alert">
                                    Could not write to the clipboard. Select the code above and copy it manually.
                                </span>
                            )}

                            {/* Send — the convenience path. Deliberately worded
                                as "so they can check it", not "verify me":
                                sending a code through Cipherline cannot verify
                                anything by itself, and the recipient's embed
                                says so too. Hidden entirely outside a 1:1 DM
                                (`onSendCode` undefined). */}
                            {myCodeAllowed && onSendCode && (
                                <>
                                    <ClButton
                                        size="sm"
                                        fullWidth
                                        pressAnim="send"
                                        loading={sendState === 'sending'}
                                        disabled={sendState === 'sent'}
                                        onClick={handleSend}
                                    >
                                        {sendState === 'sent'
                                            ? <><Check size={14} className="ico" /> Sent to {remoteUsername}</>
                                            : <><Send size={14} className="ico" /> Send my code to {remoteUsername}</>}
                                    </ClButton>
                                    {sendState === 'error' && (
                                        <span className="text-[11px] leading-snug" style={{ color: 'var(--cl-flash)' }} role="alert">
                                            Could not send. Check your connection and try again.
                                        </span>
                                    )}
                                    <span className="text-[11px] leading-snug text-cl-faint">
                                        Safe to send, but it can't replace comparing outside Cipherline.
                                    </span>
                                </>
                            )}
                        </div>
                    </div>
                    )}

                    {/* ── Manual comparison ────────────────────────────────────
                        Never hidden by the all-clear. A user who wants to read
                        the digits aloud again is precisely the user who has
                        stopped trusting the remembered verdict, and that is the
                        moment to make the check easy rather than to fold it
                        away behind a celebration. */}
                    <button
                        type="button"
                        onClick={() => setManualOpen(v => !v)}
                        aria-expanded={manualOpen}
                        className="flex items-center gap-1.5 text-xs text-cl-muted"
                        style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }}
                    >
                        <ChevronDown
                            size={14}
                            style={{ transform: manualOpen ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .15s' }}
                        />
                        Compare numbers by eye instead ({devices.length} device{devices.length === 1 ? '' : 's'})
                    </button>

                    {manualOpen && (
                        <div className="w-full flex flex-col gap-2">
                            {/* Versioned on screen, because the number changed
                                shape: v1 was 6 groups, v2 is 12. Without this, a
                                contact still on an older app reads a shorter
                                number that can never match, and the only
                                conclusion available to either of them is
                                "intercepted". The contact code above did NOT
                                change, so it is the cross-version route. */}
                            <p className="text-[11px] text-cl-faint leading-snug m-0 px-1" data-testid="sn-version-note">
                                Safety number v{SAFETY_NUMBER_VERSION} · {SAFETY_NUMBER_GROUPS} groups of five.
                                If {remoteUsername}'s app shows only 6 groups, it is out of date and the numbers
                                can't match. Use the Quick verify code instead.
                            </p>
                            {devices.map(d => {
                                const grid = d.safetyNumber ? formatSafetyNumber(d.safetyNumber) : [];
                                const sealing = sealingId === d.device_id;
                                const open = !!expanded[d.device_id];
                                return (
                                    <div
                                        key={d.device_id}
                                        className={`relative overflow-hidden w-full rounded-xl border p-3 ${
                                            sealing ? 'cl-verify-seal' : ''
                                        } ${
                                            d.state === 'key_changed'
                                                ? 'bg-cl-danger/10 border-cl-danger/50'
                                                : d.state === 'verified' && !d.legacy
                                                ? 'bg-cl-ok/10 border-cl-ok/30'
                                                : 'bg-black/30 border-white/[0.06]'
                                        }`}
                                    >
                                        <button
                                            type="button"
                                            onClick={() => setExpanded(p => ({ ...p, [d.device_id]: !open }))}
                                            aria-expanded={open}
                                            className="w-full flex items-center justify-between gap-2"
                                            style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }}
                                        >
                                            <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-cl-muted" title={d.device_id}>
                                                <ChevronDown
                                                    size={13}
                                                    style={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .15s' }}
                                                />
                                                {shortDeviceLabel(d.device_id)}
                                            </span>
                                            {d.state === 'verified' && !d.legacy && (
                                                <span className="cl-verify-badge text-xs text-cl-ok"><VerifyCheck />Verified</span>
                                            )}
                                            {d.state === 'verified' && d.legacy && (
                                                <span className="text-xs" style={{ color: 'var(--cl-lume)' }}>Verified (older check)</span>
                                            )}
                                            {d.state === 'key_changed' && <span className="text-xs text-cl-danger">Key changed</span>}
                                            {d.state === 'unverified' && <span className="text-xs text-cl-muted">Not verified</span>}
                                        </button>

                                        {open && (
                                            <div className="mt-3">
                                                {d.state === 'key_changed' && (
                                                    <p className="text-cl-danger text-xs leading-relaxed mb-3">
                                                        This device's identity key changed since you last verified it. This could mean
                                                        {' '}{remoteUsername} reinstalled Cipherline on this device, or someone is
                                                        intercepting your messages. Compare the new number out of band before continuing.
                                                    </p>
                                                )}
                                                <div className="flex flex-col items-center gap-2 mb-3">
                                                    {grid.map((row, ri) => (
                                                        <div key={ri} className="flex gap-2">
                                                            {row.map((g, gi) => (
                                                                <span
                                                                    key={gi}
                                                                    className={`font-mono text-sm px-1.5 py-0.5 rounded transition-colors duration-700 ${
                                                                        d.state === 'key_changed'
                                                                            ? 'text-cl-danger bg-cl-danger/10'
                                                                            : d.state === 'verified' && !d.legacy
                                                                            ? 'text-cl-ok bg-cl-ok/5'
                                                                            : 'text-cl-text'
                                                                    }`}
                                                                >
                                                                    {g}
                                                                </span>
                                                            ))}
                                                        </div>
                                                    ))}
                                                </div>
                                                {d.state === 'key_changed' && (
                                                    <ClButton variant="danger" fullWidth onClick={() => handleAcknowledgeChange(d.device_id, d.pub)}>
                                                        Acknowledge Change
                                                    </ClButton>
                                                )}
                                                {d.state === 'unverified' && (
                                                    <ClButton fullWidth onClick={() => markOne(d.device_id, d.pub)}>
                                                        Mark this device verified
                                                    </ClButton>
                                                )}
                                                {d.state === 'verified' && d.legacy && (
                                                    <ClButton fullWidth onClick={() => markOne(d.device_id, d.pub)}>
                                                        These numbers match — refresh verification
                                                    </ClButton>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}

                            {/* One footnote for the whole account, rather than a
                                nested copy inside every remote device's card —
                                this is a fact about the user's own devices and
                                does not vary per contact device. */}
                            {myOtherDeviceCount > 0 && (
                                <p className="text-[11px] text-cl-faint leading-snug m-0 px-1">
                                    These are for <strong className="text-cl-muted">this</strong> device of yours. Your{' '}
                                    {myOtherDeviceCount} other device{myOtherDeviceCount === 1 ? '' : 's'} show
                                    {myOtherDeviceCount === 1 ? 's' : ''} different numbers. The Quick verify code covers all of them.
                                </p>
                            )}
                        </div>
                    )}
                </>
            )}

            </div>
            </div>

            {/* Footer — `shrink-0`, so Close (and the dismiss escape hatch) are on
                screen at any device count; only the body above scrolls. */}
            <div className="shrink-0 flex flex-col items-stretch gap-3" data-testid="verify-footer">
            {/* The escape hatch. Rendered outside the loading/error branch on
                purpose — see `activeWarning` in Props for the offline /
                no-keys-published state where it is the ONLY resolution left,
                and why a persistent warning must always have one.

                Worded as an acknowledgement rather than a close: "Dismiss"
                alone reads like hiding a notification, and this genuinely
                retires the alarm. Ghost + small so it stays visibly weaker
                than verifying, which is what we actually want the user to do. */}
            {activeWarning && (
                <div className="flex flex-col gap-1.5">
                    <ClButton
                        fullWidth
                        variant="ghost"
                        size="sm"
                        onClick={() => { onResolved?.(); onClose(); }}
                    >
                        Dismiss this warning
                    </ClButton>
                    <p className="text-[11px] text-cl-faint leading-snug m-0 text-center">
                        Clears the alert without verifying {remoteUsername}. It returns if something changes.
                    </p>
                </div>
            )}

            <ClButton fullWidth variant="ghost" size="sm" onClick={onClose}>Close</ClButton>
            </div>
        </ClModal>
    );
};
