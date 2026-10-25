import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { apiUrl } from '../utils/apiPath';
import { encryptAndAddress } from '../utils/encryptAndAddress';
import { generateCallKey } from '../utils/crypto';
import { CALL_KEY_ROTATION_MS, type CallKeyDecision, type CallKeyStore } from '../utils/callKeyStore';
import {
    CALL_KEY_DECRYPT_REQUEST_MIN_GAP_MS,
    CALL_KEY_ID_MINT,
    CALL_KEY_SOLO_MINT_AFTER_MS,
    KeyResponseLimiter,
    MinGapGate,
    buildKeyRequest,
    buildShareContent,
    chooseRotator,
    decideKeyRequestResponse,
    devicesOfUser,
    devicesOfUsers,
    keyRequestRecipientUserIds,
    isRotationDue,
    mintEpoch,
    nextRequestDelayMs,
    responseJitterMs,
    shouldMintSoloKey,
} from '../utils/callKeyShare';

/**
 * Call-key sharing for DM / group calls (see utils/callKeyShare.ts for the
 * protocol). This hook is the I/O half: timers and requests around the pure
 * decisions.
 *
 *  - REQUEST: while the active DM/group call has no accepted key, send
 *    `call_key_request` (first after a short grace, then every 4 s, 5 in all).
 *  - RESPOND: `handleKeyRequest`, called by the DM pull loop after the
 *    sender-trust gate, answers with the held key — only while connected to
 *    that call and only to the requester's own devices.
 *  - ROTATE: the initiator (else the connected participant with the lowest user
 *    id) replaces the key when its epoch is due. This replaced ChatPane's
 *    initiator-only timer, which stopped when the initiator left.
 *  - MINT: a joiner still keyless after the retries, alone in the call (the
 *    server's call status says the room is empty), mints a fresh key.
 *
 * Never logs user ids, device ids or who asked whom: counts and reasons only.
 * Never builds a room: the keyless gate (utils/callKeyGate.ts) is untouched.
 */

export interface SharingCall {
    id: string;
    conversation_id?: string;
    isInitiator?: boolean;
    isVoiceChannel?: boolean;
    callsChannelId?: string;
}

export interface CallKeySharingArgs {
    token: string | null | undefined;
    deviceId: string | null | undefined;
    userId: string | null | undefined;
    bundleReady: boolean;
    activeCall: SharingCall | null;
    /** The call whose LiveKit room is connected (Dashboard's roomConnectedCallId). */
    roomConnectedCallId: string | null;
    storeRef: MutableRefObject<CallKeyStore>;
    /** Bumped on every store write (Dashboard's callKeyEpoch): re-run the effects below. */
    keyEpoch: number;
    /**
     * What the store holds for a call right now: an ACCEPTED key (epoch >= 1),
     * and any key at all (an unconfirmed epoch-0 adoption counts). A function
     * rather than the ref so this hook never touches a ref during render.
     */
    readKeyState: (conversationId: string, callId: string) => { accepted: boolean; any: boolean };
    /** Record a key this device generated, at an explicit epoch. */
    recordGeneratedKey: (conversationId: string, callId: string, keyB64: string, epoch: number) => CallKeyDecision;
    /** false = the user is known NOT to be in the conversation; undefined = unknown. */
    isConversationMember: (conversationId: string, userId: string) => boolean | undefined;
}

interface ControlDevice { device_id: string; spk_pub_b64: string; user_id?: string }

export interface KeyRequestInput {
    conversationId: string;
    callId: string;
    /** The requester's user and device, from the decrypted envelope. */
    senderUserId: string;
    senderDeviceId: string | null | undefined;
    /** `actionFor(verdict, 'key_material') === 'accept'` for this envelope. */
    senderTrusted: boolean;
}

const MINT_RECHECK_MS = 10_000;
const ROTATION_TICK_MS = 5_000;
const ROTATION_RETRY_BACKOFF_MS = 30_000;

const newId = () => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `ck-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * Encrypt `content` for the conversation's devices — all of them, or only one
 * user's — and post it. Same fetch / `encryptAndAddress` / send pattern as the
 * `call_key` broadcasts. Returns how many devices it was addressed to.
 */
async function sendControlMessage(
    auth: { token: string; deviceId: string; userId: string },
    conversationId: string,
    content: object,
    onlyUserId?: string | readonly string[],
    claimOtp = true,
): Promise<number> {
    const headers = { Authorization: `Bearer ${auth.token}`, 'x-device-id': auth.deviceId };
    // claim_otp=1: consume a one-time prekey per recipient device (per-message
    // forward secrecy). Key material only — a request carries no secret, so it
    // doesn't burn the recipients' one-time prekeys.
    const devicesRes = claimOtp
        ? await axios.get(apiUrl`/conversations/${conversationId}/devices?claim_otp=1`, { headers })
        : await axios.get(apiUrl`/conversations/${conversationId}/devices`, { headers });
    if (!Array.isArray(devicesRes.data)) return 0;
    let devices = devicesRes.data as ControlDevice[];
    if (typeof onlyUserId === 'string') devices = devicesOfUser(devices, onlyUserId);
    else if (onlyUserId) devices = devicesOfUsers(devices, onlyUserId);
    if (devices.length === 0) return 0;
    // RC-2: address exactly the devices that got wrapped.
    const { ciphertext_b64, recipient_device_ids } = await encryptAndAddress(JSON.stringify(content), auth.userId, devices, auth.deviceId);
    if (recipient_device_ids.length === 0) return 0;
    await axios.post(`${API_BASE}/messages/send`, {
        conversation_id: conversationId,
        recipient_device_ids,
        envelope_type: 'signal_chat',
        ciphertext_b64,
        sent_at_client: new Date().toISOString(),
    }, { headers });
    return recipient_device_ids.length;
}

/** Ask only the users connected to the call for its key (see keyRequestRecipientUserIds). */
async function sendKeyRequest(
    auth: { token: string; deviceId: string; userId: string },
    conversationId: string,
    callId: string,
): Promise<number> {
    const status = await axios.get(apiUrl`/calls/${callId}/status`, { headers: { Authorization: `Bearer ${auth.token}` } });
    const recipients = keyRequestRecipientUserIds(status.data);
    if (recipients.length === 0) return 0;
    return sendControlMessage(auth, conversationId, buildKeyRequest(callId, newId()), recipients, false);
}

export function useCallKeySharing(args: CallKeySharingArgs) {
    const { token, deviceId, userId, bundleReady, activeCall, roomConnectedCallId, storeRef, keyEpoch } = args;

    // Latest values for the callbacks the pull loop holds on to.
    const latest = useRef(args);
    useEffect(() => { latest.current = args; });

    const limiterRef = useRef(new KeyResponseLimiter());
    const decryptGateRef = useRef(new MinGapGate(CALL_KEY_DECRYPT_REQUEST_MIN_GAP_MS));
    const participantIdsRef = useRef<string[]>([]);
    const rotatingRef = useRef(false);
    const rotateBackoffUntilRef = useRef(0);

    const callId = activeCall?.id ?? null;
    const convId = activeCall?.conversation_id ?? null;
    // DM / group calls only: a Calls channel derives its key, a voice channel
    // uses the channel Sender Key.
    const isConvCall = !!activeCall && !!convId && !activeCall.callsChannelId && !activeCall.isVoiceChannel;
    // Read through `keyEpoch` so a store write re-runs the effects below.
    void keyEpoch;
    const keyState = isConvCall && convId && callId ? args.readKeyState(convId, callId) : { accepted: false, any: false };
    const hasAcceptedKey = keyState.accepted;
    const hasAnyKey = keyState.any;
    const connected = isConvCall && roomConnectedCallId === callId;
    const selfIsInitiatorFlag = activeCall?.isInitiator === true;

    // A different call starts with fresh participant knowledge and gates.
    useEffect(() => {
        participantIdsRef.current = [];
        decryptGateRef.current.reset();
        rotateBackoffUntilRef.current = 0;
    }, [callId]);

    // ── REQUEST ─────────────────────────────────────────────────────────────
    const canSend = !!token && !!deviceId && !!userId && bundleReady;
    useEffect(() => {
        if (!isConvCall || hasAcceptedKey || !canSend || !callId || !convId) return;
        const auth = { token: token!, deviceId: deviceId!, userId: userId! };
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let sent = 0;
        const step = async () => {
            if (cancelled || storeRef.current.accepted(convId, callId)) return;
            try {
                await sendKeyRequest(auth, convId, callId);
            } catch {
                // Best-effort: the next retry (or a holder's own broadcast) covers it.
            }
            sent += 1;
            if (!cancelled) schedule();
        };
        const schedule = () => {
            const delay = nextRequestDelayMs(sent);
            if (delay === null) return;
            timer = setTimeout(() => { void step(); }, delay);
        };
        schedule();
        return () => { cancelled = true; if (timer) clearTimeout(timer); };
    }, [isConvCall, hasAcceptedKey, canSend, callId, convId, token, deviceId, userId, storeRef]);

    // ── MINT (nobody can answer) ────────────────────────────────────────────
    useEffect(() => {
        if (!isConvCall || hasAnyKey || !canSend || !callId || !convId) return;
        const auth = { token: token!, deviceId: deviceId!, userId: userId! };
        const headers = { Authorization: `Bearer ${auth.token}` };
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const startedAt = Date.now();
        const keyless = () => !storeRef.current.get(convId, callId);

        const attempt = async () => {
            if (cancelled || !keyless()) return;
            try {
                const res = await axios.get(apiUrl`/calls/${callId}/status`, { headers });
                if (cancelled || !shouldMintSoloKey({ stillKeyless: keyless(), keylessForMs: Date.now() - startedAt, status: res.data })) {
                    if (!cancelled) timer = setTimeout(() => { void attempt(); }, MINT_RECHECK_MS);
                    return;
                }
                // Two lone joiners racing each other must not both mint in the
                // same instant: jitter, then look again.
                await new Promise<void>(r => { timer = setTimeout(r, responseJitterMs()); });
                if (cancelled || !keyless()) return;
                const again = await axios.get(apiUrl`/calls/${callId}/status`, { headers });
                if (cancelled || !shouldMintSoloKey({ stillKeyless: keyless(), keylessForMs: Date.now() - startedAt, status: again.data })) {
                    if (!cancelled) timer = setTimeout(() => { void attempt(); }, MINT_RECHECK_MS);
                    return;
                }
                const epoch = mintEpoch(storeRef.current.highestEpoch(convId, callId));
                const key = await generateCallKey();
                if (cancelled || !keyless()) return;
                if (latest.current.recordGeneratedKey(convId, callId, key, epoch) !== 'stored') return;
                console.log('[CallKeyShare] alone in the call with no key — minted a fresh one');
                try {
                    const n = await sendControlMessage(auth, convId, {
                        client_msg_id: newId(),
                        type: 'call_key',
                        call_id: callId,
                        epoch,
                        e2ee_key_b64: key,
                        key_id: CALL_KEY_ID_MINT,
                        rotates_at: new Date(Date.now() + CALL_KEY_ROTATION_MS).toISOString(),
                    });
                    console.log(`[CallKeyShare] minted key sent to ${n} device(s)`);
                } catch {
                    console.warn('[CallKeyShare] minted key broadcast failed; holders will still be asked for it on request');
                }
            } catch {
                // Status unknown (network, 429): never mint on an unknown, try again.
                if (!cancelled) timer = setTimeout(() => { void attempt(); }, MINT_RECHECK_MS);
            }
        };
        // A timer can fire a hair early; the margin keeps the elapsed-time check honest.
        timer = setTimeout(() => { void attempt(); }, CALL_KEY_SOLO_MINT_AFTER_MS + 250);
        return () => { cancelled = true; if (timer) clearTimeout(timer); };
    }, [isConvCall, hasAnyKey, canSend, callId, convId, token, deviceId, userId, storeRef]);

    // ── ROTATE ──────────────────────────────────────────────────────────────
    useEffect(() => {
        if (!isConvCall || !connected || !hasAcceptedKey || !canSend || !callId || !convId) return;
        const auth = { token: token!, deviceId: deviceId!, userId: userId! };
        const tick = async () => {
            if (rotatingRef.current || Date.now() < rotateBackoffUntilRef.current) return;
            const store = storeRef.current;
            const held = store.accepted(convId, callId);
            if (!held) return;
            const initiator = store.initiatorOf(convId, callId);
            const choice = chooseRotator({
                selfUserId: auth.userId,
                selfIsInitiator: selfIsInitiatorFlag || initiator === auth.userId,
                knownInitiatorUserId: initiator,
                connectedUserIds: participantIdsRef.current,
            });
            if (!isRotationDue({ selfUserId: auth.userId, choice, rotatesAtMs: held.rotatesAtMs, nowMs: Date.now() })) return;
            rotatingRef.current = true;
            try {
                const nextEpoch = held.epoch + 1;
                const newKey = await generateCallKey();
                // Someone else rotated while the key was being made: stand down.
                if (store.accepted(convId, callId)?.epoch !== held.epoch) return;
                await sendControlMessage(auth, convId, {
                    client_msg_id: newId(),
                    type: 'call_key',
                    call_id: callId,
                    epoch: nextEpoch,
                    e2ee_key_b64: newKey,
                    key_id: `rotate-${nextEpoch}`,
                    rotates_at: new Date(Date.now() + CALL_KEY_ROTATION_MS).toISOString(),
                });
                latest.current.recordGeneratedKey(convId, callId, newKey, nextEpoch);
            } catch {
                rotateBackoffUntilRef.current = Date.now() + ROTATION_RETRY_BACKOFF_MS;
                console.warn('[CallKeyShare] key rotation failed; will retry');
            } finally {
                rotatingRef.current = false;
            }
        };
        const id = setInterval(() => { void tick(); }, ROTATION_TICK_MS);
        return () => clearInterval(id);
    }, [isConvCall, connected, hasAcceptedKey, canSend, callId, convId, token, deviceId, userId, selfIsInitiatorFlag, storeRef]);

    // ── RESPOND ─────────────────────────────────────────────────────────────
    /**
     * A `call_key_request` that already passed the content boundary and the
     * sender-trust gate. Returns the reason it was ignored, or 'scheduled'.
     */
    const handleKeyRequest = useCallback((req: KeyRequestInput): string => {
        const a = latest.current;
        const call = a.activeCall;
        const myUserId = a.userId;
        if (!myUserId || !a.token || !a.deviceId) return 'not_ready';
        const connectedHere = !!call && call.conversation_id === req.conversationId && a.roomConnectedCallId === call.id;
        const decision = decideKeyRequestResponse({
            connectedCallId: connectedHere && call ? call.id : null,
            requestedCallId: req.callId,
            holdsAcceptedKey: !!a.storeRef.current.accepted(req.conversationId, req.callId),
            senderTrusted: req.senderTrusted,
            requesterIsMember: a.isConversationMember(req.conversationId, req.senderUserId),
            requesterDeviceId: req.senderDeviceId,
            myDeviceId: a.deviceId,
            nowMs: Date.now(),
            limiter: limiterRef.current,
        });
        if (!decision.respond) return decision.reason;
        setTimeout(() => {
            const b = latest.current;
            // Re-check at fire time: the jitter is long enough to leave the call.
            const stillHere = !!b.activeCall && b.activeCall.id === req.callId
                && b.activeCall.conversation_id === req.conversationId && b.roomConnectedCallId === req.callId;
            const held = b.storeRef.current.accepted(req.conversationId, req.callId);
            if (!stillHere || !held || !b.token || !b.deviceId || !b.userId) return;
            const content = buildShareContent({
                callId: req.callId,
                keyB64: held.keyB64,
                epoch: held.epoch,
                rotatesAtMs: held.rotatesAtMs,
                nowMs: Date.now(),
                clientMsgId: newId(),
                rotationMs: CALL_KEY_ROTATION_MS,
            });
            sendControlMessage({ token: b.token, deviceId: b.deviceId, userId: b.userId }, req.conversationId, content, req.senderUserId)
                .then(n => console.log(`[CallKeyShare] answered a key request (${n} device(s))`))
                .catch(() => console.warn('[CallKeyShare] could not answer a key request'));
        }, responseJitterMs());
        return 'scheduled';
    }, []);

    // ── Signals from the call ───────────────────────────────────────────────
    /** CallPane's LiveKit roster (participant identities = user ids). */
    const reportParticipants = useCallback((ids: string[]) => { participantIdsRef.current = ids; }, []);

    /** The room cannot decrypt a remote participant's media: ask again, at most every 10 s. */
    const requestKeyAfterDecryptFailure = useCallback(() => {
        const a = latest.current;
        const call = a.activeCall;
        if (!call || !call.conversation_id || call.callsChannelId || call.isVoiceChannel) return;
        if (a.roomConnectedCallId !== call.id || !a.token || !a.deviceId || !a.userId) return;
        if (!decryptGateRef.current.tryPass(Date.now())) return;
        sendKeyRequest({ token: a.token, deviceId: a.deviceId, userId: a.userId }, call.conversation_id, call.id)
            .catch(() => { /* best-effort */ });
    }, []);

    return { handleKeyRequest, reportParticipants, requestKeyAfterDecryptFailure };
}
