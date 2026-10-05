/**
 * Rich embed for a received `safety_number` message.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 *
 * The ergonomic complaint behind the whole verification-code feature is that
 * comparing a forty-character fingerprint by hand is slow and people skip it.
 * This embed removes the TRANSCRIPTION from that chore — one click compares
 * the code the contact sent against the keys this client independently holds
 * for them — while deliberately leaving the TRUST step where it belongs.
 *
 * ── The line this component does not cross ──────────────────────────────────
 *
 * A match here does NOT mark anything verified on its own, and that is not an
 * oversight to be tidied up later. The code arrives over the same channel a
 * safety number exists to police: an attacker who has substituted the keys
 * controls both the directory this client reads and the message body, so a
 * matching code costs them nothing to produce. Auto-verifying on an in-band
 * match would hand exactly that attacker a one-click green shield — strictly
 * worse than having no feature, because users would stop doing the real
 * check. `utils/verificationCode.ts` documents the circularity at length.
 *
 * So the verdicts are asymmetric, because the evidence is:
 *
 *   • mismatch → a real, actionable alarm, obtained for free.
 *   • match    → agreement, and an invitation to complete the one step that
 *                cannot be automated: confirming the code came from somewhere
 *                an attacker would have to break separately.
 *
 * `markVerified` is reached only through that explicit attestation button, and
 * it goes through `keyVerification` — the same pin store the modal and
 * `TrustBadge` already read — so there is no second notion of "verified" here.
 *
 * ── What persists, and what does not ────────────────────────────────────────
 *
 * Everything above describes ONE session's comparison. What the embed shows on
 * a FRESH mount is a separate question, and it used to be answered wrongly: the
 * component kept `attested` in `useState`, `ChatPane` remounts on every chat
 * switch, and so leaving the conversation and coming back re-asked for a
 * verification the user had already done and which the pin store had durably
 * recorded. Local state still drives the in-session transitions — checking,
 * matched, the seal flourish — but what you SEE at rest is derived from
 * persisted state, via `deriveEmbedRestingState`. Its header carries the rule
 * for each of the three multi-device cases and why a new unverified device
 * must never read as green; this file only renders the answer.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { ShieldCheck, ShieldAlert, ShieldQuestion, Fingerprint } from 'lucide-react';
import { API_BASE } from '../constants';
import { ClButton } from './ClButton';
import { TrustBadge } from './TrustBadge';
import { formatCode } from '../utils/verificationCode';
import {
    evaluateSafetyNumberEmbed,
    deriveEmbedRestingState,
    liveMatchCaution,
    type SafetyEmbedVerdict,
    type EmbedRestingState,
} from '../utils/safetyNumberEmbed';
import { trustExplanation } from '../utils/contactTrust';
import { verdictMessage, type SenderVerdict } from '../utils/senderTrust';
import { markVerified, getKnownDevices } from '../utils/keyVerification';
import { isLegacyVerified } from '../utils/verificationStrength';

interface Props {
    /** `content.code` exactly as it arrived. */
    code: string;
    /** `content.user_id` exactly as it arrived — consistency-checked, not trusted. */
    claimedUserId: string;
    /** Device count from the payload. Display only. */
    deviceCount?: number;
    /** Envelope sender — the identity every verdict is bound to. */
    senderUserId: string | null;
    /** Viewer's own account id. */
    myUserId: string;
    /** Display name for the sender. */
    senderName: string;
    token: string | null;
    /** Lets the chat clear any "safety number changed" banner for this contact. */
    onVerified?: (userId: string) => void;
    /**
     * The contact's current warnable verdict, if the conversation has one —
     * the SAME value the chat header feeds `TrustBadge`. Threaded through so
     * the embed's resting claim cannot contradict the shield six inches above
     * it; `deriveEmbedRestingState` lets it outrank anything the pin store
     * would otherwise have said.
     */
    contactVerdict?: SenderVerdict | null;
}

/** How long the match flourish stays mounted — matches the CSS sequence. */
const SEAL_MS = 1500;

type Phase =
    | { s: 'idle' }
    | { s: 'checking' }
    | { s: 'done'; verdict: SafetyEmbedVerdict };

/** Read the pin store without letting an unreadable one take the embed down.
 *  A locked or corrupt store reads as "nothing pinned", which renders the
 *  pre-existing plain "Check this code" affordance — never a false green. */
function readPinnedDevices(myUserId: string, theirUserId: string) {
    try {
        return Object.entries(getKnownDevices(myUserId, theirUserId))
            .map(([deviceId, rec]) => ({
                deviceId, pub: rec.pub, verified: rec.verified, legacy: isLegacyVerified(rec),
            }));
    } catch {
        return [];
    }
}

/**
 * True iff EVERY pub this client just compared is already pinned VERIFIED.
 *
 * This is what stops a re-check from re-asking for an attestation the user has
 * already made: the attestation prompt is a question about the pubs in front of
 * you, and if all of them are already vouched for there is nothing left to ask.
 * Reads the pin store and nothing else — it cannot be asserted by the sender,
 * and it creates no new way to BECOME verified, since `markVerified` is still
 * the only writer.
 *
 * A LEGACY vouch (made before safety-number v2) does not count as answered.
 * This code comparison is a current-strength check, and confirming it is
 * exactly how a legacy verification gets refreshed. Skipping the prompt would
 * leave the user no way to do that from the embed.
 */
function allComparedPubsVerified(myUserId: string, theirUserId: string, pubs: string[]): boolean {
    if (!pubs.length) return false;
    const pinned = readPinnedDevices(myUserId, theirUserId);
    return pubs.every(p => pinned.some(d => d.verified && !d.legacy && d.pub === p));
}

export const SafetyNumberEmbed: React.FC<Props> = ({
    code: rawCode, claimedUserId, deviceCount, senderUserId, myUserId, senderName, token, onVerified,
    contactVerdict = null,
}) => {
    // Defensive even though ChatPane re-validates the row: the payload is
    // sender-controlled, and a non-string code used to throw in the useMemo
    // below and take the WHOLE app to the root error screen. An unusable code
    // renders a "couldn't be shown" card (after the hooks, which must run).
    const code = typeof rawCode === 'string' ? rawCode : '';
    const [phase, setPhase]   = useState<Phase>({ s: 'idle' });
    const [sealing, setSealing] = useState(false);
    const [attested, setAttested] = useState(false);
    /** True when the pubs compared this session were ALREADY vouched for before
     *  the user clicked anything — i.e. this is a re-check, not a first pass. */
    const [preVerified, setPreVerified] = useState(false);
    /** The sender's pubs as this client fetched them — kept so the attestation
     *  step pins exactly what was compared, never what the message claimed. */
    const [localPubs, setLocalPubs] = useState<{ device_id: string; pub: string }[]>([]);
    /** What persisted state says this embed should show on a fresh mount.
     *  `null` only for the first frame, before the derivation settles. */
    const [resting, setResting] = useState<EmbedRestingState | null>(null);
    /** Bumped after a write to the pin store so `resting` is re-derived from
     *  the store rather than from the local `attested` flag. */
    const [storeEpoch, setStoreEpoch] = useState(0);

    const isMine = !!senderUserId && senderUserId === myUserId;
    const groups = useMemo(() => formatCode(code.toUpperCase()).split(' '), [code]);

    /**
     * The fix for the reported bug: what a fresh mount shows comes from the pin
     * store, not from `attested`. Deliberately store-only — no directory fetch
     * on mount, because the pin store already answers "what has this user
     * vouched for" and a badge is not worth a round trip.
     */
    useEffect(() => {
        // Nothing to derive, and deliberately no `setResting` here: a
        // synchronous setState in an effect body is a cascading render, and it
        // is unnecessary anyway — `restingTrust` below re-checks both
        // conditions, so a stale value from a previous sender can never be
        // rendered.
        if (isMine || !senderUserId) return;
        let cancelled = false;
        deriveEmbedRestingState({
            senderUserId,
            claimedUserId,
            claimedCode: code,
            pinned: readPinnedDevices(myUserId, senderUserId),
            verdict: contactVerdict,
        })
            .then(r => { if (!cancelled) setResting(r); })
            .catch(() => { if (!cancelled) setResting({ kind: 'silent' }); });
        return () => { cancelled = true; };
    }, [isMine, senderUserId, claimedUserId, code, myUserId, contactVerdict, storeEpoch]);

    const handleCheck = useCallback(async () => {
        if (!senderUserId || !code) return;
        setPhase({ s: 'checking' });
        let pubs: { device_id: string; pub: string }[] = [];
        try {
            const res = await axios.get(
                `${API_BASE}/keys/identity_keys?user_id=${senderUserId}`,
                { headers: { Authorization: `Bearer ${token}` } },
            );
            const bundles: { device_id: string; identity_key_pub_b64: string }[] = res.data ?? [];
            pubs = bundles.map(b => ({ device_id: b.device_id, pub: b.identity_key_pub_b64 }));
            setLocalPubs(pubs);
            // Answered against the pubs actually fetched, so a re-check of a
            // contact verified in an earlier session does not re-ask for the
            // out-of-band attestation. Scoped to THESE pubs rather than to the
            // contact: if the directory now serves a device the user never
            // vouched for, this is false and the prompt correctly returns.
            setPreVerified(allComparedPubsVerified(myUserId, senderUserId, pubs.map(p => p.pub)));
        } catch {
            setPhase({ s: 'done', verdict: { kind: 'unavailable', reason: "Could not reach the key directory. Try again." } });
            return;
        }

        const verdict = await evaluateSafetyNumberEmbed({
            senderUserId,
            claimedUserId,
            claimedCode: code,
            localDevicePubsB64: pubs.map(p => p.pub),
        });
        setPhase({ s: 'done', verdict });

        if (verdict.kind === 'match') {
            setSealing(true);
            setTimeout(() => setSealing(false), SEAL_MS);
        }
    }, [senderUserId, claimedUserId, code, token, myUserId]);

    /**
     * The only path to `markVerified` in this component, and it is gated on a
     * human statement the app cannot make for them: that the code was obtained
     * somewhere other than Cipherline. Pins the pubs THIS CLIENT fetched and
     * compared — never anything out of the message.
     */
    const handleAttest = useCallback(() => {
        if (!senderUserId) return;
        for (const { device_id, pub } of localPubs) {
            // `recordFirstSeen` used to run here first. It was removed as
            // provably redundant, not as a shortcut: `markVerified` already
            // calls `adopt(...)` for the same (deviceId, pub), and already
            // writes `{ pub, verified: true, first_seen: existing ?? now,
            // last_seen: now }` — byte-for-byte the record `recordFirstSeen`
            // would have produced, then immediately overwritten. The only
            // effect of keeping it was a second encrypted read-modify-write of
            // the pin store per device, and a second apparent writer sitting
            // next to a security-critical one.
            markVerified(myUserId, senderUserId, pub, device_id);
        }
        setAttested(true);
        // Re-derive the resting claim from what was just written, so the
        // persisted store — never the local flag — is what the next render and
        // every future mount agree on.
        setStoreEpoch(e => e + 1);
        onVerified?.(senderUserId);
    }, [senderUserId, myUserId, localPubs, onVerified]);

    const verdict = phase.s === 'done' ? phase.verdict : null;

    /**
     * A match compared the keys the directory served JUST NOW, not the keys
     * this device pinned. With an unresolved key change (or a served key that
     * contradicts a pin) that is the interception case itself, so the match is
     * amber and the warning stays until the user attests — see
     * `liveMatchCaution`. An attestation this session is what resolves it.
     */
    const caution = verdict?.kind === 'match' && !attested && senderUserId
        ? liveMatchCaution({
            pinned: readPinnedDevices(myUserId, senderUserId),
            compared: localPubs.map(p => ({ deviceId: p.device_id, pub: p.pub })),
            verdict: contactVerdict,
        })
        : null;

    /** The user has already vouched for these keys out of band — this session
     *  or a previous one. Either way the attestation prompt is answered —
     *  except under a caution, which only an explicit attestation clears. */
    const vouchedFor = attested || (preVerified && !caution);

    /**
     * The resting claim, and the one case that earns a green card: the contact
     * is fully verified AND this code commits to exactly the set of devices
     * this client has pinned. Anything less — a sibling device unverified, or a
     * code committing to a device set we have not pinned — is amber by
     * construction, because a green shield is a claim about ALL of it.
     */
    const restingTrust =
        (!isMine && senderUserId && resting?.kind === 'trust') ? resting : null;
    const restingClear = !!restingTrust
        && restingTrust.trust.level === 'verified'
        && restingTrust.commitsToPinnedSet;

    const restTone =
        restingClear ? 'ok'
        : restingTrust?.trust.level === 'compromised' ? 'bad'
        : 'neutral';

    const tone =
        verdict?.kind === 'match' ? (caution ? 'neutral' : 'ok')
        : verdict?.kind === 'mismatch' || verdict?.kind === 'sender_mismatch' ? 'bad'
        : verdict ? 'neutral'
        : restTone;

    if (!code) {
        // Unusable payload (see the `code` normalisation at the top). Rendered
        // as a quiet card rather than thrown on — a thrown render here is an
        // app-wide crash any contact can trigger.
        return (
            <div className="cl-sn-card cl-sn-card--neutral">
                <div className="cl-sn-eyebrow">
                    <Fingerprint size={12} aria-hidden="true" />
                    Safety code
                </div>
                <p className="cl-sn-sub">This safety code couldn’t be shown.</p>
            </div>
        );
    }

    return (
        <div
            className={[
                'cl-sn-card',
                `cl-sn-card--${tone}`,
                sealing ? 'cl-sn-seal' : '',
            ].filter(Boolean).join(' ')}
        >
            <div className="cl-sn-eyebrow">
                <Fingerprint size={12} aria-hidden="true" />
                {isMine ? 'You shared your safety code' : 'Safety code'}
            </div>

            <div className="cl-sn-body">
                {/* The code itself. Rendered as per-group spans rather than one
                    string so the match flourish can settle them left-to-right —
                    and so a group never wraps mid-token, which is the
                    transcription ambiguity the grouping exists to prevent. */}
                <div className="cl-sn-code" aria-label={`Safety code: ${groups.join(' ')}`}>
                    {groups.map((g, i) => (
                        <span key={i} className="cl-sn-grp">{g}</span>
                    ))}
                </div>

                <p className="cl-sn-sub">
                    {isMine ? (
                        <>Your identity fingerprint{typeof deviceCount === 'number' && deviceCount > 0
                            ? <> across {deviceCount} device{deviceCount === 1 ? '' : 's'}</> : null}.
                            {' '}They can check it against what their app shows for you.</>
                    ) : (
                        <><strong className="text-cl-muted">{senderName}</strong>'s identity fingerprint. Check it
                            against the keys this device holds for them.</>
                    )}
                </p>
            </div>

            {!isMine && (
                <div className="cl-sn-foot">
                    {phase.s === 'idle' && (
                        <>
                            {/* ── The resting claim ───────────────────────────
                                Rendered from the pin store, so a verification
                                the user already did survives leaving the chat.
                                The tone is the WEAKER of the two facts it
                                carries (see `deriveEmbedRestingState`), which is
                                why a "verified" contact whose code commits to a
                                different device set gets the amber row and not a
                                green tick beside a caution. */}
                            {restingTrust && (
                                <div
                                    className={`cl-sn-result cl-sn-result--${
                                        restingClear ? 'ok'
                                        : restingTrust.trust.level === 'compromised' ? 'bad'
                                        : 'warn'}`}
                                    role={restingTrust.trust.level === 'compromised' ? 'alert' : 'status'}
                                >
                                    {/* The badge is withheld in exactly one
                                        case: a contact whose every pinned
                                        device IS verified, reading an embed
                                        whose code commits to some other device
                                        set. `TrustBadge` would correctly render
                                        a green "Verified" there — it is a claim
                                        about the contact and it is true — but
                                        a green tick sitting beside "check this
                                        before relying on it" is the mixed
                                        signal this codebase keeps warning
                                        about, so the row carries the caution
                                        alone and the contact-level claim stays
                                        in words.

                                        Everywhere else `showLabel` is on
                                        purpose: this row is the only place the
                                        level is stated, and "Partly verified
                                        (1/2)" is the precise bit — an icon
                                        cannot carry the fraction, and colour is
                                        never the only channel here either. */}
                                    {restingClear || restingTrust.trust.level !== 'verified' ? (
                                        <TrustBadge
                                            trust={restingTrust.trust}
                                            displayName={senderName}
                                            size={16}
                                            showLabel
                                            className="shrink-0"
                                        />
                                    ) : (
                                        <ShieldQuestion size={16} className="shrink-0" aria-hidden="true" />
                                    )}
                                    <span>
                                        {restingClear ? (
                                            <>
                                                <strong>You already verified {senderName}.</strong> This code is the
                                                one this device has pinned for{' '}
                                                {restingTrust.trust.deviceCount === 1
                                                    ? 'their device'
                                                    : `all ${restingTrust.trust.deviceCount} of their devices`}
                                                {' '}— nothing to do here.
                                            </>
                                        ) : restingTrust.trust.level === 'compromised' ? (
                                            verdictMessage(restingTrust.trust.verdict!, senderName)
                                                || trustExplanation(restingTrust.trust, senderName)
                                        ) : (
                                            <>
                                                {trustExplanation(restingTrust.trust, senderName)}
                                                {!restingTrust.commitsToPinnedSet && (
                                                    <>
                                                        {' '}
                                                        <strong>
                                                            This code also commits to a different set of devices than
                                                            this one has pinned for them
                                                        </strong>
                                                        , so check it before relying on it.
                                                    </>
                                                )}
                                            </>
                                        )}
                                    </span>
                                </div>
                            )}

                            {senderUserId ? (
                                <ClButton
                                    size="sm"
                                    fullWidth
                                    variant={restingClear ? 'ghost' : undefined}
                                    onClick={handleCheck}
                                >
                                    <ShieldQuestion size={14} /> Check this code{restingClear ? ' again' : ''}
                                </ClButton>
                            ) : (
                                // The button used to render here and silently do
                                // nothing: every verdict is bound to the envelope
                                // sender, and without one there is nobody to
                                // compare the code against.
                                <div className="cl-sn-result cl-sn-result--neutral" role="status">
                                    <ShieldQuestion size={14} className="shrink-0" aria-hidden="true" />
                                    <span>
                                        This device couldn’t confirm who sent this code, so there is nothing to check it
                                        against. Ask them to send it again, or compare codes in Safety verification.
                                    </span>
                                </div>
                            )}
                        </>
                    )}

                    {phase.s === 'checking' && (
                        <ClButton size="sm" fullWidth loading disabled>Checking</ClButton>
                    )}

                    {verdict?.kind === 'match' && (
                        <>
                            {caution ? (
                                <div className="cl-sn-result cl-sn-result--warn" role="alert">
                                    <ShieldQuestion size={16} className="shrink-0" aria-hidden="true" />
                                    <span>
                                        <strong>This code matches the keys the server gave this device for {senderName} just
                                        now</strong>
                                        {caution.reason === 'pins_differ'
                                            ? <> — not the keys this device had pinned for them. </>
                                            : <>. </>}
                                        {(contactVerdict && verdictMessage(contactVerdict, senderName))
                                            || 'Someone who can intercept your messages could send a matching code for their own keys.'}
                                        {' '}It is not verified until you confirm it somewhere else.
                                    </span>
                                </div>
                            ) : (
                                <div className="cl-sn-result cl-sn-result--ok" role="status">
                                    <span className="cl-sn-shield"><ShieldCheck size={16} aria-hidden="true" /></span>
                                    <span>
                                        <strong>This code matches.</strong> The keys this device holds for {senderName} are
                                        the keys they say are theirs.
                                    </span>
                                </div>
                            )}

                            {/* The honest caveat, and the reason a match is not
                                itself a verification. Not boilerplate: without
                                it this embed awards a shield on the say-so of
                                whoever controls the channel. */}
                            {vouchedFor ? (
                                <div className="cl-sn-result cl-sn-result--ok" role="status">
                                    <ShieldCheck size={14} aria-hidden="true" />
                                    <span>
                                        {attested
                                            ? <>Marked verified. {senderName}'s devices are now pinned.</>
                                            // Reached when every pub just compared was ALREADY
                                            // vouched for — a re-check of work done earlier.
                                            // Re-showing the attestation prompt here is the
                                            // reported bug in its second form.
                                            : <>Already verified. You confirmed these keys with {senderName} out
                                                of band, and they have not changed since.</>}
                                    </span>
                                </div>
                            ) : (
                                <>
                                    <p className="cl-sn-caveat">
                                        A matching code proves these two views agree — it cannot prove the code
                                        reached you untampered, because it travelled over Cipherline. Only confirm
                                        below if you also have it from {senderName} <strong>somewhere else</strong>:
                                        in person, or a call you recognise their voice on.
                                    </p>
                                    {/* No name in this label, and a smaller cap than
                                        the kit's `sm` default. `.cap` is white-space:nowrap,
                                        so interpolating a username here truncated the
                                        sentence to an ellipsis for anyone with a long one —
                                        and the one word that carried the whole meaning
                                        ("elsewhere") was the first to go. The caveat
                                        paragraph directly above already names who and what
                                        "this" is, so the button does not need to repeat it. */}
                                    <ClButton
                                        size="sm"
                                        variant="ghost"
                                        fullWidth
                                        className="cl-sn-attest"
                                        onClick={handleAttest}
                                    >
                                        I compared this elsewhere
                                    </ClButton>
                                </>
                            )}
                        </>
                    )}

                    {verdict?.kind === 'mismatch' && (
                        <div className="cl-sn-result cl-sn-result--bad" role="alert">
                            <ShieldAlert size={16} className="shrink-0" aria-hidden="true" />
                            <span>
                                <strong>This code does not match.</strong> The keys this device holds for {senderName}
                                {' '}are not the keys this message commits to. That can mean they added or removed a
                                device since sending — or that someone is intercepting your messages. Nothing has been
                                marked verified. Reach them another way before sending anything sensitive.
                            </span>
                        </div>
                    )}

                    {verdict?.kind === 'sender_mismatch' && (
                        <div className="cl-sn-result cl-sn-result--bad" role="alert">
                            <ShieldAlert size={16} className="shrink-0" aria-hidden="true" />
                            <span>
                                <strong>This code names a different account than the one that sent it.</strong>{' '}
                                Nothing was compared. A genuine client never does this.
                            </span>
                        </div>
                    )}

                    {verdict?.kind === 'malformed' && (
                        <div className="cl-sn-result cl-sn-result--neutral" role="status">
                            <ShieldQuestion size={14} className="shrink-0" aria-hidden="true" />
                            <span>{verdict.reason}</span>
                        </div>
                    )}

                    {verdict?.kind === 'unavailable' && (
                        <div className="cl-sn-result cl-sn-result--neutral" role="status">
                            <ShieldQuestion size={14} className="shrink-0" aria-hidden="true" />
                            <span>{verdict.reason}</span>
                            <button type="button" className="cl-sn-retry" onClick={handleCheck}>Retry</button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default SafetyNumberEmbed;
