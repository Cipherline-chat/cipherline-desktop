import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { presenceBus, type WirePresence } from '../utils/presenceState';
import { parseReferralRedeemed, referralRedeemedBus } from '../utils/referralEvents';
import { selfPresenceBus } from '../utils/ownStatusSync';
import { beginActivity } from '../utils/freezeLog';
import { WS_BASE, APP_VERSION } from '../constants';
import {
    TYPING_EXPIRY_MS,
    recordTypingStart,
    typingSendDecision,
    TYPING_REFRESH_MIN_MS,
    recordTypingStop,
    clearTypingForUser,
    pruneExpiredTyping,
    toTypingUsersView,
    type TypingTimestamps,
} from '../utils/typingStore';
import { computeIsAttentive, heartbeatPayload, isWindowAttendable, IDLE_THRESHOLD_SECONDS, IDLE_POLL_INTERVAL_MS } from '../utils/attentionState';
import { parseChannelReadEvent, type ChannelReadEvent } from '../utils/channelReadSync';

/** Matches the application-defined close code in the gateway. */
const WS_CLOSE_UPGRADE_REQUIRED = 4426;
const WS_CLOSE_ATTESTATION_REQUIRED = 4401;
/** Session revoked server-side (password change / account disable). Stop reconnecting. */
const WS_CLOSE_SESSION_REVOKED = 4403;

/** How often we send `presence:heartbeat` while the socket believes it's OPEN. */
const HEARTBEAT_INTERVAL_MS = 15_000;
/** A socket reporting OPEN with no inbound traffic (including the server's own
 *  presence:ack replies to our heartbeat) for this long is presumed dead. Sleep
 *  is the case this exists for: the OS drops the TCP connection silently, but
 *  WebSocket.readyState has no way to learn that — send() on a half-open
 *  socket doesn't throw, it just queues bytes into a dead buffer forever, so
 *  onclose never fires and the normal reconnect path never runs. Threshold is
 *  ~2.5x the heartbeat interval so one dropped ack (real packet loss, not a
 *  dead link) doesn't false-positive. */
const LIVENESS_TIMEOUT_MS = 40_000;

/** Pure decision so the sleep-detection logic is unit-testable without a real
 *  socket: has too long passed since we last heard ANYTHING from the server? */
export function isSocketStale(lastInboundAt: number, now: number, thresholdMs: number = LIVENESS_TIMEOUT_MS): boolean {
    return now - lastInboundAt > thresholdMs;
}

export interface ChannelMessageEvent {
    channel_id: string;
    server_id: string;
    message_id: string;
    sender_device_id: string;
    sender_user_id: string;
    sender_identity_pub_b64: string;
    epoch: number;
    nonce_b64: string;
    ciphertext_b64: string;
    signature_b64: string;
    reply_to_id: string | null;
    mentions_everyone: boolean;
    created_at: string;
}

/**
 * Device-scoped WS event filtering — extracted as pure, independently
 * testable predicates (device-sync audit hardening follow-up). Server-side
 * broadcasts every device:* event to ALL of the user's connected sockets
 * (by design — see gateway.gateway.ts's notifyDeviceApproved/
 * notifyHistoryRequest), so filtering by device_id here is the ONLY thing
 * standing between "this event is for me" and "this event is for some
 * other device of mine that happens to also be online right now." Getting
 * this wrong for device:approved is exactly what caused a CONFIRMED,
 * critical bug: an unrelated, already-populated device silently received
 * and applied another device's history transfer, overwriting its own local
 * message history with zero UI shown. See the call site below.
 */

/** True iff a `device:history_request` event should be surfaced to THIS
 *  device as something it can answer. Unscoped requests (no
 *  target_device_id) are meant for every approved device to see; a scoped
 *  request only reaches its intended target. */
export function shouldHandleHistoryRequest(
    targetDeviceId: string | null | undefined,
    myDeviceId: string | null | undefined,
): boolean {
    return !targetDeviceId || !myDeviceId || targetDeviceId === myDeviceId;
}

/**
 * Read the optional `display_name` off a live call-presence event
 * (`channel:voice_state` / `huddle:participant`).
 *
 * The desktop app and the API roll separately, so a client on a new build can
 * talk to an API that predates the field — that must degrade to the old
 * seed-only behaviour, never render `undefined` or a coerced non-string. Only
 * a non-empty string counts; anything else yields `undefined`, which the name
 * map treats as "learned nothing".
 */
export function readDisplayName(value: unknown): string | undefined {
    return readPresenceString(value);
}

/**
 * The same guard for the other optional string a presence JOIN event may
 * carry: `avatar_url`, the attachment id of the joiner's profile picture.
 *
 * It exists for the same reason and under the same rule as the display name —
 * an API that predates the field must degrade to "learned nothing", never to a
 * coerced non-string that would be handed to `useEncryptedAvatar` as an
 * attachment id and turned into a 404 plus two wasted requests. Named
 * separately from readDisplayName so a future change to one field's parsing
 * cannot silently change the other's.
 */
export function readPresenceString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** True iff a `device:approved` event's history-transfer payload belongs to
 *  THIS device. Unlike shouldHandleHistoryRequest, this must NEVER be
 *  permissive on a missing id — a transfer key is sensitive,
 *  single-recipient data, not a broadcast-to-whoever's-listening request.
 *
 *  C-2 status: this is no longer the ONLY thing separating devices.
 *  `wrapped_transfer_key_b64` is an ECIES envelope wrapped to a single
 *  device_id, so a sibling device that got past this filter still could not
 *  decrypt it — the separation is now structural, and this check is defence in
 *  depth.
 *
 *  C-2b: the legacy plaintext `transfer_key_b64` still arrives on this event
 *  when the APPROVER is running a pre-2026-08-30 client, and this filter is
 *  still the only thing keeping a sibling device from seeing it here — the
 *  wrap cannot help with a field that was never wrapped. `HistorySyncBanner`
 *  now refuses to IMPORT that form, but the refusal happens downstream of this
 *  point, so do not remove this check until the field is gone from the wire. */
/** True iff a `call:answered_elsewhere` event is this device's own echo of the
 *  join it just won, and must therefore be ignored.
 *
 *  Deliberately PERMISSIVE on a missing id, the opposite of
 *  isMyHistoryDelivery: the server stamps the winning `device_id` and also
 *  skips the winner's sockets, but an older server sends no id at all. Treating
 *  "no id" as "mine" there would swallow the event for the genuine losing
 *  sibling — which is the whole point of the event — so an unstamped event is
 *  still handled, exactly as before. Only a positive match is suppressed. */
export function isOwnAnswerEcho(
    eventDeviceId: string | null | undefined,
    myDeviceId: string | null | undefined,
): boolean {
    return !!eventDeviceId && !!myDeviceId && eventDeviceId === myDeviceId;
}

export function isMyHistoryDelivery(
    eventDeviceId: string | null | undefined,
    myDeviceId: string | null | undefined,
): boolean {
    return !!eventDeviceId && !!myDeviceId && eventDeviceId === myDeviceId;
}

/**
 * Continuity — cross-device read sync. `message:read` now reaches the
 * READER's own other devices too (see gateway.gateway.ts's onMessageRead:
 * `broadcastToUsers([...notifyIds, client.userId], ...)`), not just the
 * other side of the conversation, specifically so a message read on one
 * device clears its unread badge on every other device of the same account.
 * `reader_user_id` is whatever the server stamped from the SENDING socket's
 * verified identity — comparing it to our own id is the only thing that
 * tells "someone else read this" apart from "I read this, elsewhere".
 *
 * Fails closed like isMyHistoryDelivery: a missing id on either side must
 * never be treated as a match — this drives clearing an unread badge, and a
 * false positive there would hide a genuinely unread message.
 */
export function isSelfReadEvent(
    readerUserId: string | null | undefined,
    myUserId: string | null | undefined,
): boolean {
    return !!readerUserId && !!myUserId && readerUserId === myUserId;
}

/**
 * QR-2 (adversarial review) — `device:linked` (`gateway.gateway.ts`'s
 * `notifyDeviceLinked`) had ZERO listeners anywhere in the client before
 * this. The design leans on it twice as the "you would notice" mitigation
 * for two residual risks it explicitly declines to solve cryptographically
 * (docs/QR-LINKING.md §2.9.1 scan-phishing, §2.9.5 a compromised device
 * linking another) — with nothing subscribed, the server was emitting into
 * the void and neither mitigation existed in practice. This is the same
 * failure class CLAUDE.md already documents twice (device:approval_request/
 * device:pairing_request, and the voice-E2EE rotation signal): a server
 * event shipped alongside a client change that landed in a different file
 * than the one that dispatches events.
 *
 * Parses `msg.data` into the shape Dashboard's toast is built from. Pure and
 * exported (rather than inlined in the `onmessage` branch below) for the
 * same testability reason as the other predicates in this file —
 * apps/desktop's vitest has no DOM/@testing-library, so this function IS the
 * assertion that the event reaches user-visible state; `useRealtime.test.ts`
 * exercises it directly, plus a source-scan confirming the dispatch switch
 * actually calls it.
 */
export function parseDeviceLinkedEvent(data: unknown): {
    approved_by_device_id: string;
    approved_by_device_name: string;
    device_label: string;
    linked_at: string;
} | null {
    if (!data || typeof data !== 'object') return null;
    const d = data as Record<string, unknown>;
    if (typeof d.approved_by_device_id !== 'string') return null;
    if (typeof d.approved_by_device_name !== 'string') return null;
    if (typeof d.device_label !== 'string') return null;
    if (typeof d.linked_at !== 'string') return null;
    return {
        approved_by_device_id: d.approved_by_device_id,
        approved_by_device_name: d.approved_by_device_name,
        device_label: d.device_label,
        linked_at: d.linked_at,
    };
}

/**
 * Builds the toast Dashboard shows for a `device:linked` event — a one-line
 * `toast.push({ kind: 'warning', ...formatDeviceLinkedToast(evt) })` at the
 * call site. `device_label` is prefixed "reported as" because it is
 * self-asserted by the newly-linked device, not verified — the same caveat
 * this app already applies everywhere else that field is shown (see
 * HistoryRequestModal / device_label handling elsewhere in this codebase).
 */
export function formatDeviceLinkedToast(evt: {
    approved_by_device_name: string;
    device_label: string;
}): { title: string; message: string } {
    return {
        title: 'New device linked',
        message: `Approved by ${evt.approved_by_device_name} — reported as "${evt.device_label}"`,
    };
}

export const useRealtime = (token: string | null, onNewMessage?: () => void, onChannelMessage?: (evt: ChannelMessageEvent) => void, deviceId?: string | null, myUserId?: string | null) => {
    const wsRef = useRef<WebSocket | null>(null);
    // ── Continuity — the desktop attention state machine ────────────────────
    // See utils/attentionState.ts's module doc for the full rationale. These
    // refs (not state — nothing here should ever trigger a re-render; they
    // exist purely to be read at the moment a heartbeat is about to be sent)
    // track the inputs; the decision itself is `currentAttention()`, computed
    // at send time from them AND the live window (document focus, visibility):
    //   focusedRef      — the focus/blur/minimise/hide/lock event stream's view.
    //   idleSecondsRef  — last polled electronAPI.getSystemIdleTime() reading.
    //                     Starts at +Infinity (unknown) so the FIRST heartbeat
    //                     this session sends — before any poll has completed —
    //                     reports not-attentive rather than guessing true. See
    //                     the module doc: the conservative direction is safe,
    //                     the permissive direction silences a phone that
    //                     shouldn't be silenced.
    const focusedRef = useRef<boolean>(typeof document !== 'undefined' ? document.hasFocus() : true);
    const idleSecondsRef = useRef<number>(Number.POSITIVE_INFINITY);
    /** The attention verdict from the LIVE window, recomputed at send time —
     *  see isWindowAttendable: a missed focus/blur event must never leave a
     *  hidden, minimised or unfocused window reporting `active: true`. */
    const currentAttention = (): boolean => {
        const attendable = typeof document !== 'undefined' && isWindowAttendable({
            focusedByEvent: focusedRef.current,
            documentHasFocus: document.hasFocus(),
            visibilityState: document.visibilityState,
        });
        return computeIsAttentive(attendable, idleSecondsRef.current, IDLE_THRESHOLD_SECONDS);
    };
    /** Send a presence:heartbeat carrying an explicit `active` value RIGHT
     *  NOW, outside the normal 15s cadence — the off-cycle half of the spec
     *  ("send active:false immediately... on blur, minimise, screen lock or
     *  app quit"). A no-op when there's no open socket (nothing to lie to —
     *  the server already treats a dead/absent connection as not attentive). */
    const sendAttentionNow = useCallback((active: boolean) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(heartbeatPayload(active));
        }
    }, []);
    /** `presence:idle` — this connection's user is (not) idle, for a server
     *  that decides auto-away across all of a user's devices. Its own event,
     *  not a heartbeat field, so an older server simply ignores it (a new
     *  heartbeat field would make it reject the heartbeat body — and with it
     *  the attention flag). useUserStatus only calls this once the server has
     *  shown it understands (by sending `presence:snapshot`). */
    const sendPresenceIdle = useCallback((idle: boolean) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ event: 'presence:idle', data: { idle } }));
        }
    }, []);
    /** Continuity — self-read sync (see isSelfReadEvent above). One-shot
     *  event slot, same pattern as every other *Event state in this hook:
     *  Dashboard's consumer clears the conversation's unread/mention badge
     *  and does not need the value to persist past that. */
    const [selfReadEvent, setSelfReadEvent] = useState<{
        conversation_id: string;
        last_read_message_id: string;
        read_at: number;
    } | null>(null);
    // Timestamp-keyed store (typingStore.ts), not the Set-shaped view
    // components consume — see that module's header for why an expiry is
    // needed at all (a missed `typing:stop` otherwise sticks forever) and
    // why it's kept pure/timestamp-driven rather than per-user setTimeouts.
    const [typingTimestamps, setTypingTimestamps] = useState<TypingTimestamps>({});
    const typingUsers = useMemo(() => toTypingUsersView(typingTimestamps), [typingTimestamps]);
    const [readReceipts, setReadReceipts] = useState<Record<string, Record<string, number>>>({});
    // { [conversationId]: { [userId]: read_at_timestamp } }
    const [pairingRequest, setPairingRequest] = useState<{ requesting_device_id: string, device_name: string } | null>(null);
    const [approvalRequest, setApprovalRequest] = useState<{ device_id: string, device_name: string, platform: string, created_at: string } | null>(null);
    // Multi-device selective-history flow — set on the approver side when the
    // new device taps "Sync from existing device". Consumed by Dashboard's
    // HistoryRequestModal. Range/content choice now lives in the approver's UI.
    const [historyRequest, setHistoryRequest] = useState<{
        device_id: string;
        device_name: string;
        platform: string;
        requested_at: string;
        /** C-2 — requester can unwrap an ECIES-wrapped transfer key.
         *  C-2b — advisory only; the approver acts on the signature below. */
        accepts_wrapped_key?: boolean;
        /** C-2b — Ed25519 signature over the canonical advertisement, made
         *  with the requesting device's identity key. Unverified here. */
        capability_sig_b64?: string;
        /** C-2b — unix seconds the advertisement was signed at. */
        capability_ts?: number;
        /** QR transfer authorisation (docs/QR-LINKING.md §3) — additive,
         *  optional fields on the EXISTING `device:history_request` event.
         *  Both absent from a request that arrived the ordinary way (the
         *  in-app "sync from device" flow), so an older/unaware client
         *  behaves exactly as before. Carried through UNVERIFIED, same as
         *  the capability fields above — it is display copy only ("this was
         *  authorised by a physical QR scan"), never a trust decision; the
         *  cryptographic checks below are identical either way. */
        via?: 'qr';
        transfer_id?: string;
    } | null>(null);
    // Set on the requesting (new) side when the approver hits "Decline".
    const [historyDeclined, setHistoryDeclined] = useState<{ device_id: string; reason: string | null } | null>(null);
    /** QR-2 — a device was just linked into this account via a QR scan
     *  (docs/QR-LINKING.md §2). One-shot, like the other WS event slots in
     *  this file; Dashboard's consumer effect turns each new value into a
     *  toast via formatDeviceLinkedToast. */
    const [deviceLinkedEvent, setDeviceLinkedEvent] = useState<{
        approved_by_device_id: string;
        approved_by_device_name: string;
        device_label: string;
        linked_at: string;
    } | null>(null);
    // Set on the requesting (new) side when device:approved arrives with a
    // transfer key — triggers import in HistorySyncBanner.
    const [historyDelivered, setHistoryDelivered] = useState<{
        /** C-2 — ECIES envelope only THIS device can open. Preferred. */
        wrapped_transfer_key_b64?: string;
        /** LEGACY plaintext key; present only from a pre-2026-08-30 approver. */
        transfer_key_b64?: string;
        transfer_meta?: any;
    } | null>(null);
    const [friendRemovedEvent, setFriendRemovedEvent] = useState<{ removed_by: string, other_user_id: string } | null>(null);
    const [friendAcceptedEvent, setFriendAcceptedEvent] = useState<{ requester_id: string, recipient_id: string } | null>(null);
    const [friendRequestEvent, setFriendRequestEvent] = useState<{ recipient_id: string } | null>(null);
    // Kept for Dashboard's DM-header "last seen" consumer, which only needs
    // the latest offline transition of the open DM partner. Presence itself
    // goes through `presenceBus` (utils/presenceState.ts), which delivers
    // EVERY event — this single slot drops all but the last of a burst.
    const [statusChangedEvent, setStatusChangedEvent] = useState<{ user_id: string, status: string, custom_status_text: string | null, custom_status_emoji: string | null, game_name: string | null, last_seen_at: string | null, on_mobile: boolean } | null>(null);
    const [callEndedEvent, setCallEndedEvent] = useState<{ session_id: string } | null>(null);
    const [soloKickEvent, setSoloKickEvent] = useState<{ session_id: string } | null>(null);
    /** Multi-device answer race fix: pushed when a SIBLING device answers a
     *  call this device is still ringing for (see calls.service.ts's Redis
     *  claim in joinCall). Distinct from soloKickEvent — this fires on
     *  devices that never joined at all, so there's no LiveKit disconnect to
     *  handle, just the ringing UI to clear. */
    const [answeredElsewhereEvent, setAnsweredElsewhereEvent] = useState<{ session_id: string } | null>(null);
    const [groupMemberAddedEvent, setGroupMemberAddedEvent] = useState<{ conversation_id: string; system_text?: string } | null>(null);
    const [groupUpdatedEvent, setGroupUpdatedEvent] = useState<{
        conversation_id: string,
        action: string,
        user_id?: string,
        username?: string,
        system_text?: string,
        // Set by the server's metadata_changed broadcast when an admin
        // edits the group's title/icon. Either may be present, neither, or both.
        title?: string,
        avatar_attachment?: string,
    } | null>(null);
    const [avatarUpdatedEvent, setAvatarUpdatedEvent] = useState<{ user_id: string; avatar_url: string } | null>(null);
    /** Someone visible to us renamed themselves. The avatar half of this pair
     *  has always been broadcast; the username half never was, so a rename
     *  stayed stale on DM rows, chat headers and member lists until something
     *  unrelated refetched them. Payload carries the new handle directly —
     *  usernames aren't encrypted and the audience can already read them. */
    const [usernameUpdatedEvent, setUsernameUpdatedEvent] = useState<{ user_id: string; username: string; discriminator: number | null } | null>(null);
    /** `display_name` is optional: the API and the desktop app roll separately,
     *  so an older API sends none and the consumer must degrade to the seeded
     *  name (or the "Someone" fallback), not render `undefined`. */
    const [voiceStateEvent, setVoiceStateEvent] = useState<{ channel_id: string; user_id: string; action: 'join' | 'leave'; display_name?: string; avatar_url?: string } | null>(null);
    /** Phase M — Huddles. Each event surfaces as a one-shot state slot
     *  consumed by Dashboard's useEffects, mirroring the voiceStateEvent
     *  pattern. Setters bump even when the same payload arrives twice (the
     *  consumer effect is idempotent against the underlying state). */
    const [huddleSpawnEvent, setHuddleSpawnEvent] = useState<{ huddle_id: string; call: { call_id: string; name: string; spawner_user_id: string; spawned_at: string } } | null>(null);
    const [huddleDestroyEvent, setHuddleDestroyEvent] = useState<{ huddle_id: string; call_id: string } | null>(null);
    const [huddleRenameEvent, setHuddleRenameEvent] = useState<{ huddle_id: string; call_id: string; name: string } | null>(null);
    const [huddleParticipantEvent, setHuddleParticipantEvent] = useState<{ huddle_id: string; call_id: string; user_id: string; action: 'join' | 'leave'; display_name?: string; avatar_url?: string } | null>(null);
    /** A moderator with MOVE_MEMBERS moved US into another call. Addressed to
     *  this user's devices only and carries a destination-scoped LiveKit
     *  token. The server has already applied the state change and evicted us
     *  from the old room, so the consumer must connect straight through
     *  WITHOUT re-issuing a leave. Nonce forces a re-fire if the same
     *  moderator moves us to the same call twice. */
    const [huddleForceMoveEvent, setHuddleForceMoveEvent] = useState<{
        huddle_id: string; call_id: string; call_name: string;
        livekit_url: string; livekit_token: string; moved_by: string; nonce: number;
    } | null>(null);
    const [serverRemovedEvent, setServerRemovedEvent] = useState<{ server_id: string; reason: 'kick' | 'ban' | 'deleted' } | null>(null);
    const [serverMemberJoinedEvent, setServerMemberJoinedEvent] = useState<{ server_id: string; user_id: string } | null>(null);
    /** Fires when ANY permission-affecting mutation lands on the server
     *  (role create/update/delete, role assign/unassign, channel/category
     *  override changes). Dashboard's consumer refetches myPermissions +
     *  channels for the affected server so the UI gates update live.
     *  Includes a monotonic `ts` so repeated events for the same server
     *  still trigger the consumer's useEffect (React deps comparison). */
    const [permissionsChangedEvent, setPermissionsChangedEvent] = useState<{ server_id: string; ts: number } | null>(null);
    /** Fires on channel create/update/delete (server:channels_changed carries
     *  ONLY server_id — never a channel_id, so a channel that's about to get
     *  a private override doesn't leak its existence pre-fanout). Dashboard's
     *  consumer refetches the channel list AND requests Sender Keys for any
     *  channel this device is now missing, so a channel someone else just
     *  created (and already keyed) becomes usable immediately instead of only
     *  on this device's next connect sweep. */
    const [channelsChangedEvent, setChannelsChangedEvent] = useState<{ server_id: string; ts: number } | null>(null);
    /** Fires on server:members_changed — someone left, was kicked/banned/unbanned,
     *  or had their nickname or mute state edited. Dashboard bumps the roster
     *  refresh key so ServerContextPanel reloads its member list. Kept separate
     *  from server:permissions_changed so a nickname edit doesn't make every
     *  member re-resolve permissions and re-fetch channels. */
    const [serverMembersChangedEvent, setServerMembersChangedEvent] = useState<{ server_id: string; ts: number } | null>(null);
    /** Fires on server:updated — the server's own profile changed (name,
     *  description, icon, banner, default notification level, system channel).
     *  Carries ONLY server_id by design (icon/banner key material stays behind
     *  the REST gate); Dashboard's consumer reloads the servers list. Nothing
     *  used to listen for this because nothing used to SEND it — a rename or a
     *  new icon was invisible to every other member until they restarted. */
    const [serverUpdatedEvent, setServerUpdatedEvent] = useState<{ server_id: string; ts: number } | null>(null);
    /** Fires when someone pins or unpins in a channel. Channel pins are shared
     *  with the whole server, so without this the other members only saw the
     *  change on their next channel entry. Carries channel_id (unlike
     *  channels_changed) because the server already restricts this event's
     *  audience to members with VIEW_CHANNEL — see notifyChannelPinsChanged.
     *  Metadata only: the consumer refetches through the permission-checked
     *  GET /channels/:cid/saves rather than trusting anything in the payload.
     *  Also fired for channel:saves_changed (save/unsave without a pin change). */
    const [channelPinsChangedEvent, setChannelPinsChangedEvent] = useState<{ server_id: string; channel_id: string; ts: number } | null>(null);
    /** Fires on server:emojis_updated — a moderator added, renamed, or
     *  deleted one of this server's custom emojis (docs/custom-emoji-design.md).
     *  Carries ONLY server_id, same rationale as serverUpdatedEvent: the key
     *  material lives behind GET /servers/:id/emojis' own membership gate, so
     *  the WS payload never carries it — the consumer (useServerEmojis, via
     *  ChatPane) refetches through that gate instead of trusting the event. */
    const [emojisChangedEvent, setEmojisChangedEvent] = useState<{ server_id: string; ts: number } | null>(null);
    /** Fires on server:owner_lapsed (owner's entitlement expired — grace period
     *  started/still running) or server:owner_grace_cleared (owner resubscribed,
     *  transferred ownership, or an admin comp/trial grant reactivated them).
     *  Both directions previously had NO client-side listener at all — the
     *  "subscription lapsed" banner only ever updated on whatever schedule
     *  loadServers() happened to run on. Dashboard reacts by reloading the
     *  servers list so owner_lapsed_at reflects the change immediately. */
    const [serverGraceStatusEvent, setServerGraceStatusEvent] = useState<{ server_id: string; ts: number } | null>(null);
    /** Fires when ChannelKeyHandshakesService posts new envelopes for one of
     *  our devices. Dashboard pulls immediately so new joiners stop sitting on
     *  "Couldn't decrypt" placeholders while the distributor finishes its
     *  per-channel POSTs.
     *  Append-only array (capped), NOT a single nullable slot: a distributor
     *  posting envelopes for several channels in quick succession fires this
     *  once per channel, and React can batch multiple state updates into one
     *  render — a single-slot setState only keeps the LAST one, silently
     *  dropping every earlier channel's ready event in the same batch. The
     *  consumer drains the whole array per render instead of reading one value. */
    const [channelKeyEnvelopesReadyEvents, setChannelKeyEnvelopesReadyEvents] =
        useState<{ server_id: string; channel_id: string; epoch: number; ts: number }[]>([]);
    /** `channel:read` — one of MY other devices read a channel (multi-device
     *  audit 2026-10-03; utils/channelReadSync.ts). Append-only queue, drained
     *  by Dashboard, for the same reason as the queue above: reading several
     *  channels in a row on the phone lands several of these, possibly in one
     *  React batch, and a single slot would keep only the last. */
    const [channelReadEvents, setChannelReadEvents] = useState<ChannelReadEvent[]>([]);
    /** Fires when a keyless member device files a channel key request. Every
     *  online key-holder (VIEW-filtered server-side) receives this and, after
     *  a short jitter, re-checks the pending list and serves the keys.
     *  Append-only array (capped) for the same reason as above: a joiner
     *  filing requests for several channels in a loop can land more than one
     *  of these in the same React batch, and a single-slot setState would
     *  cancel the earlier server's pending serve (see Dashboard's consumer). */
    const [keyRequestedEvents, setKeyRequestedEvents] = useState<{
        server_id: string;
        channel_id: string;
        requester_user_id: string;
        requester_device_id: string;
        ts: number;
    }[]>([]);
    /** Fires when a member LOSES access to a Calls channel (kind 'huddle' /
     *  legacy 'voice') — a role edit, a channel/category override, a kick, a
     *  ban or a leave. The audience is the POST-change authorized holder set,
     *  so the demoted member is never told. Remaining holders mint the next
     *  epoch and redistribute it, which is what bounds the room-key material
     *  the demoted member keeps (see Dashboard's rotateCallsChannelKey).
     *
     *  Append-only capped array for the same reason as the two above: an admin
     *  editing several roles in a row lands a burst of these, and a single-slot
     *  setState would keep only the last — dropping every other channel's
     *  rotation. Dashboard coalesces the batch to one rotation per channel. */
    const [channelKeyRotationEvents, setChannelKeyRotationEvents] = useState<{
        server_id: string;
        channel_id: string;
        reason: string;
        ts: number;
    }[]>([]);
    // Cap all three queues so a runaway burst (e.g. a bug elsewhere firing
    // these rapidly) can't grow state unboundedly across a long session.
    const EVENT_QUEUE_CAP = 100;
    /** Ephemeral system channel event — member joined / left / kicked / banned.
     *  Not stored in DB; arrives as a WS push and is injected into channelMessages
     *  by Dashboard. Consumers must treat it as a one-shot trigger (fire-and-forget). */
    const [channelSystemEvent, setChannelSystemEvent] = useState<{
        server_id: string;
        channel_id: string;
        event_type: 'member_join' | 'member_leave' | 'member_kick' | 'member_ban';
        user_id: string;
        username: string;
        actor_id?: string;
        actor_username?: string;
        created_at: string;
    } | null>(null);
    const heartbeatInterval = useRef<ReturnType<typeof setInterval> | null>(null);
    // Increments each time the WS successfully opens (initial connect + every
    // reconnect). Consumers can watch this to re-announce presence.
    const [wsConnectCount, setWsConnectCount] = useState(0);
    // Bridges the connect effect's internal forceReconnect() out to the
    // OS-resume IPC listener effect below, which runs once (mount-only) and
    // therefore can't close over a value that's re-created every time the
    // [token] effect re-runs. Always points at the CURRENT connection
    // attempt's forceReconnect, reassigned every time that effect re-fires.
    const forceReconnectRef = useRef<() => void>(() => {});

    // Keep stable refs so the ws.onmessage closure always uses the latest callbacks
    const onNewMessageRef = useRef(onNewMessage);
    useEffect(() => { onNewMessageRef.current = onNewMessage; }, [onNewMessage]);
    const onChannelMessageRef = useRef(onChannelMessage);
    useEffect(() => { onChannelMessageRef.current = onChannelMessage; }, [onChannelMessage]);
    // Same stale-closure guard as the two above — the main connect effect's
    // deps are [token, deviceId], so its onmessage closure is only rebuilt on
    // a reconnect. myUserId can resolve (or change on an account switch)
    // without a reconnect in between, and a stale null here would silently
    // stop isSelfReadEvent from ever matching.
    const myUserIdRef = useRef(myUserId);
    useEffect(() => { myUserIdRef.current = myUserId; }, [myUserId]);

    useEffect(() => {
        if (!token) return;

        let dead = false;
        let connecting = false;
        let retryDelay = 1_000;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        // Timestamp of the last byte we heard from the server on the CURRENT
        // socket (any message counts, not just presence:ack specifically —
        // see isSocketStale's doc comment). Reset on every onmessage and again
        // in onopen, so a fresh connection isn't judged against a previous
        // connection's silence.
        let lastInboundAt = Date.now();

        const scheduleReconnect = () => {
            retryTimer = setTimeout(connect, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 30_000);
        };

        // Called when we know connectivity is back (network online event or
        // page becoming visible after sleep). Cancels any pending retry timer,
        // resets the backoff, and dials immediately.
        const connectNow = () => {
            if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
            retryDelay = 1_000;
            connect();
        };

        // Unconditionally tears down whatever socket exists — regardless of
        // its reported readyState — and redials immediately. This is the
        // sleep fix: a half-open zombie socket is readyState OPEN, so it can
        // never be caught by "reconnect only if CLOSED" logic. Anything that
        // KNOWS (or strongly suspects) the current connection is stale should
        // call this instead of connectNow, which still trusts readyState.
        const forceReconnect = () => {
            if (dead) return;
            console.log('[WS] force-reconnect — tearing down current socket');
            if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
            retryDelay = 1_000;
            if (wsRef.current) {
                const stale = wsRef.current;
                // Prevent the zombie's belated onclose (if the OS ever does
                // notice) from scheduling a SECOND reconnect on top of the one
                // we're about to start.
                stale.onclose = null;
                try { stale.close(); } catch { /* already dead — fine */ }
                wsRef.current = null;
            }
            connect();
        };
        forceReconnectRef.current = forceReconnect;

        // network 'online' and page-visibility both fire on wake, but neither
        // is authoritative on its own (a laptop can wake with the same Wi-Fi
        // already associated, so 'online' never re-fires; a minimized-but-not-
        // hidden Electron window may never fire visibilitychange either) — so
        // this is a second line of defence behind the liveness watchdog in the
        // heartbeat interval below, not the primary mechanism. Only force a
        // reconnect when the socket both LOOKS open and IS stale by the same
        // measure the watchdog uses; a healthy socket shouldn't be torn down
        // just because the tab regained focus.
        const checkLivenessNow = () => {
            if (dead) return;
            if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
                connectNow();
            } else if (
                wsRef.current.readyState === WebSocket.OPEN &&
                isSocketStale(lastInboundAt, Date.now())
            ) {
                forceReconnect();
            }
            // CONNECTING / CLOSING: already in flight, leave it be.
        };

        const onOnline = () => {
            console.log('[WS] network online — checking connection');
            checkLivenessNow();
        };

        const onVisibilityChange = () => {
            if (!document.hidden) {
                console.log('[WS] page visible — checking connection');
                checkLivenessNow();
            }
        };

        window.addEventListener('online', onOnline);
        document.addEventListener('visibilitychange', onVisibilityChange);

        const connect = async () => {
            if (dead) return;
            // Don't open a second socket if one is already connecting or open.
            if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) return;
            // The attest await below opens a window before wsRef is assigned;
            // without this flag two concurrent callers (reconnect timer + an
            // online/visibility connectNow) could both pass the checks and open
            // duplicate sockets. The flag holds across the await.
            if (connecting) return;
            connecting = true;
            try {
                // Official-build attestation (parity with the REST header). Empty
                // in dev / forks → omitted; the server enforces only when set.
                let attestParam = '';
                try {
                    const at = await window.electronAPI?.attestSign?.();
                    if (at) attestParam = `&attest=${encodeURIComponent(at)}`;
                } catch { /* no signer (web/dev) — connect without it */ }
                // Re-check after the await — state may have changed while signing.
                if (dead) return;
                if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) return;

                // Phase 7 / device sprawl: device_id is additive and optional —
                // an older API build ignores unknown query params entirely, and
                // this connection's authorization still rests solely on `token`.
                // Lets the gateway record a real last_seen_at heartbeat for the
                // SPECIFIC device that's connected, not just "some device of
                // this user is online" (which JWT alone can't distinguish).
                const deviceIdParam = deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : '';
                const ws = new WebSocket(`${WS_BASE}?token=${token}&version=${encodeURIComponent(APP_VERSION)}${attestParam}${deviceIdParam}`);
                wsRef.current = ws;

            // Set once this socket has proven a real round trip (see onmessage
            // below) — guards 'cipherline:ws-connected' so it fires at most
            // once per connection, not on every subsequent message.
            let confirmedConnected = false;

            ws.onopen = () => {
                retryDelay = 1000;
                lastInboundAt = Date.now();
                console.log('[WS] Connected ✓');
                // Continuity: carries the current attention verdict on every
                // heartbeat, including this very first one — idleSecondsRef
                // starts at +Infinity (see its declaration) until the idle
                // poll's first read, so a fresh connect never CLAIMS
                // attention it hasn't verified.
                ws.send(heartbeatPayload(currentAttention()));
                // Signal consumers (useUserStatus) to re-push their status so
                // friends see them as online after a reconnect. Fine to do
                // this on the bare handshake, unlike 'cipherline:ws-connected'
                // below — worst case it's re-sent moments later on the real
                // reconnect if this socket turns out to be a flap.
                setWsConnectCount(n => n + 1);

                heartbeatInterval.current = setInterval(() => {
                    if (ws.readyState !== WebSocket.OPEN) return;
                    // Liveness check rides the same timer as the heartbeat send
                    // rather than a separate interval: if nothing has arrived
                    // (including the server's own presence:ack) since well
                    // before now, sending another heartbeat into what's likely
                    // a dead buffer just delays detection. Force a reconnect
                    // instead of sending.
                    if (isSocketStale(lastInboundAt, Date.now())) {
                        console.warn(`[WS] no inbound traffic for over ${LIVENESS_TIMEOUT_MS / 1000}s on a socket reporting OPEN — presumed dead, forcing reconnect`);
                        forceReconnect();
                        return;
                    }
                    // Continuity: the same verdict the off-cycle sends use —
                    // one state machine, recomputed from the live window at
                    // send time (a hidden window whose timers still run, or
                    // run late, reports false), never a second timer or a
                    // second heartbeat.
                    ws.send(heartbeatPayload(currentAttention()));
                }, HEARTBEAT_INTERVAL_MS);
            };

            ws.onmessage = (event) => {
                // ANY inbound byte proves the socket is genuinely alive, which
                // is exactly what the liveness watchdog above needs — this
                // covers presence:ack as a side effect without having to
                // special-case it, since it's just one more message type.
                lastInboundAt = Date.now();
                // 'cipherline:ws-connected' drives OfflineScreen's reload, so
                // it must mean "the connection actually works", not just "the
                // TCP handshake completed" — those aren't the same thing right
                // after an OS resume/unlock, when Wi-Fi/VPN can still be
                // reassociating: a socket can open, then die again seconds
                // later, before ever completing a round trip. Firing on
                // onopen let that flap trigger OfflineScreen's reload while
                // the network was still bad — a page reload mid-flap racing
                // its own hydration fetches, landing back on a dead socket
                // immediately after. This first inbound message (in practice
                // the presence:ack the heartbeat above just requested) is
                // proof of a real client→server→client round trip, which a
                // bare handshake is not.
                if (!confirmedConnected) {
                    confirmedConnected = true;
                    window.dispatchEvent(new CustomEvent('cipherline:ws-connected'));
                }
                try {
                    const msg = JSON.parse(event.data);

                    // Server rejected a write-like event because the subscription
                    // lapsed (parity with the HTTP 403 subscription_required). Ask
                    // the SubscriptionContext to re-fetch so the read-only UI flips.
                    if (msg.event === 'error' && msg.data?.code === 'subscription_required') {
                        window.dispatchEvent(new CustomEvent('cipherline:subscription-required'));
                        return;
                    }

                    if (msg.event === 'typing:start' || msg.event === 'typing:stop') {
                        const { conversation_id, user_id } = msg.data;
                        if (msg.event === 'typing:start') {
                            const now = Date.now();
                            // Refreshes within TYPING_REFRESH_MIN_MS keep the same state object (no re-render);
                            // older clients still send a start per keystroke.
                            setTypingTimestamps(prev => recordTypingStart(prev, conversation_id, user_id, now, TYPING_REFRESH_MIN_MS));
                        } else {
                            setTypingTimestamps(prev => recordTypingStop(prev, conversation_id, user_id));
                        }
                    }

                    if (msg.event === 'message:read') {
                        const { conversation_id, reader_user_id, last_read_message_id, read_at } = msg.data;
                        if (conversation_id && reader_user_id) {
                            setReadReceipts(prev => ({
                                ...prev,
                                [conversation_id]: {
                                    ...(prev[conversation_id] || {}),
                                    [reader_user_id]: read_at ?? Date.now(),
                                }
                            }));
                            // Continuity — self-read sync: the server now
                            // includes the reader's OWN other devices in this
                            // broadcast (see isSelfReadEvent's doc comment)
                            // specifically so reading on one device clears the
                            // badge everywhere else. Idempotent by design —
                            // this fires even for the reporting device itself
                            // (best-effort server-side exclusion, not
                            // guaranteed), and re-applying "clear this
                            // conversation's badge" a second time is a no-op.
                            if (isSelfReadEvent(reader_user_id, myUserIdRef.current)) {
                                setSelfReadEvent({
                                    conversation_id,
                                    last_read_message_id,
                                    read_at: read_at ?? Date.now(),
                                });
                            }
                        }
                    }

                    if (msg.event === 'message:new') {
                        // Server is telling us there are new messages — pull immediately
                        onNewMessageRef.current?.();
                    }

                    if (msg.event === 'channel:message_new') {
                        // Channel message arrives inline — no need for a follow-up REST pull.
                        // Dashboard decrypts it and appends to channel message state.
                        onChannelMessageRef.current?.(msg.data as ChannelMessageEvent);
                    }

                    if (msg.event === 'device:pairing_request') {
                        setPairingRequest({
                            requesting_device_id: msg.data.requesting_device_id,
                            device_name: msg.data.device_name
                        });
                    }

                    // Approver side: new device requests history sync.
                    // If the request targets a specific device, ignore it unless we are that device.
                    if (msg.event === 'device:history_request') {
                        const tid = msg.data.target_device_id;
                        if (shouldHandleHistoryRequest(tid, deviceId)) {
                            setHistoryRequest({
                                device_id: msg.data.device_id,
                                device_name: msg.data.device_name,
                                platform: msg.data.platform,
                                requested_at: msg.data.requested_at,
                                accepts_wrapped_key: msg.data.accepts_wrapped_key === true,
                                // C-2b — carried through UNVERIFIED. The
                                // approver (HistoryRequestModal) is the only
                                // party that checks them, and it checks them
                                // against an identity key it fetches itself,
                                // not against anything in this event.
                                capability_sig_b64: msg.data.capability_sig_b64 ?? undefined,
                                capability_ts: typeof msg.data.capability_ts === 'number'
                                    ? msg.data.capability_ts
                                    : undefined,
                                // QR transfer authorisation — additive fields,
                                // both optional (docs/QR-LINKING.md §3).
                                via: msg.data.via === 'qr' ? 'qr' : undefined,
                                transfer_id: typeof msg.data.transfer_id === 'string'
                                    ? msg.data.transfer_id
                                    : undefined,
                            });
                        }
                    }

                    // Requester side: approver declined the transfer.
                    if (msg.event === 'device:history_declined') {
                        setHistoryDeclined({
                            device_id: msg.data.device_id,
                            reason: msg.data.reason ?? null,
                        });
                    }

                    // QR-2 — a device was just linked via QR sign-in, fanned
                    // out to the account's OTHER devices. See
                    // parseDeviceLinkedEvent's doc above for why this used to
                    // be a server event with no listener anywhere.
                    if (msg.event === 'device:linked') {
                        const parsed = parseDeviceLinkedEvent(msg.data);
                        if (parsed) setDeviceLinkedEvent(parsed);
                    }

                    // Requester side: approver sent history (device:approved WITH
                    // transfer key). See isMyHistoryDelivery's doc comment above —
                    // this filter used to be MISSING entirely (CRITICAL, confirmed
                    // bug: an unrelated online device could silently receive and
                    // apply another device's history transfer, overwriting its own
                    // local history with zero UI shown).
                    //
                    // C-2 made that targeting STRUCTURAL rather than a client
                    // check: `wrapped_transfer_key_b64` is an ECIES envelope
                    // addressed to one device_id, so another device that
                    // reaches this line cannot decrypt it. The filter stays as
                    // defence in depth — and it is still load-bearing for the
                    // legacy plaintext field below.
                    if (msg.event === 'device:approved'
                        && (msg.data?.wrapped_transfer_key_b64 || msg.data?.transfer_key_b64)
                        && isMyHistoryDelivery(msg.data.device_id, deviceId)) {
                        setHistoryDelivered({
                            wrapped_transfer_key_b64: msg.data.wrapped_transfer_key_b64 ?? undefined,
                            transfer_key_b64: msg.data.transfer_key_b64 ?? undefined,
                            transfer_meta: msg.data.transfer_meta ?? undefined,
                        });
                    }



                    if (msg.event === 'friend:request') {
                        setFriendRequestEvent({ recipient_id: msg.data.recipient_id });
                    }

                    // Someone signed up with MY referral link. Public tag + time only;
                    // consumers subscribe to the bus (utils/referralEvents.ts).
                    if (msg.event === 'referral:redeemed') {
                        const ev = parseReferralRedeemed(msg.data);
                        if (ev) referralRedeemedBus.emit(ev);
                    }

                    if (msg.event === 'user:status_changed') {
                        presenceBus.emit({ kind: 'changed', entry: msg.data as WirePresence });
                        setStatusChangedEvent({
                            user_id: msg.data.user_id,
                            status: msg.data.status,
                            custom_status_text: msg.data.custom_status_text ?? null,
                            custom_status_emoji: msg.data.custom_status_emoji ?? null,
                            game_name: msg.data.game_name ?? null,
                            last_seen_at: msg.data.last_seen_at ?? null,
                            on_mobile: msg.data.on_mobile === true,
                        });
                        // An offline user cannot still be typing — this is the
                        // other half of the stale-"typing…" fix alongside the
                        // expiry in typingStore.ts. Covers the case where the
                        // presence:offline signal (server-side disconnect
                        // detection) beats the 5s expiry, e.g. the app was
                        // force-quit right after a keystroke.
                        if (msg.data.status === 'offline') {
                            setTypingTimestamps(prev => clearTypingForUser(prev, msg.data.user_id));
                        }
                    }

                    if (msg.event === 'user:friends_status_batch') {
                        const batch = (Array.isArray(msg.data) ? msg.data : []) as WirePresence[];
                        presenceBus.emit({ kind: 'friends_batch', entries: batch });
                        const offlineIds = batch.filter(f => f.status === 'offline').map(f => f.user_id);
                        if (offlineIds.length > 0) {
                            setTypingTimestamps(prev => {
                                let next = prev;
                                for (const uid of offlineIds) next = clearTypingForUser(next, uid);
                                return next;
                            });
                        }
                    }

                    // The complete presence picture for our whole audience
                    // (friends, DM/group co-members, server co-members) on
                    // every (re)connect — anyone not listed is offline. What
                    // corrects a non-friend whose change we missed while this
                    // connection was down. Sent only by servers that also do
                    // per-connection auto-away (see useUserStatus).
                    if (msg.event === 'presence:snapshot') {
                        const users = (Array.isArray(msg.data?.users) ? msg.data.users : []) as WirePresence[];
                        presenceBus.emit({ kind: 'snapshot', entries: users, complete: msg.data?.complete === true });
                    }

                    // Our OWN choice changed (status picker on any device,
                    // "show when I'm on mobile") — sent only to our own
                    // sockets. useUserStatus / usePrivacySettings adopt it;
                    // see utils/ownStatusSync.ts.
                    if (msg.event === 'presence:self') {
                        selfPresenceBus.emit(msg.data);
                    }

                    if (msg.event === 'friend:removed') {
                        setFriendRemovedEvent({
                            removed_by: msg.data.removed_by,
                            other_user_id: msg.data.other_user_id
                        });
                    }
                    if (msg.event === 'call:ended') {
                        setCallEndedEvent({ session_id: msg.data.session_id });
                    }
                    if (msg.event === 'call:solo_kick') {
                        setSoloKickEvent({ session_id: msg.data.session_id });
                    }
                    if (msg.event === 'call:answered_elsewhere') {
                        // Ignore our OWN join's echo. The server emits this
                        // push before the join's HTTP response is serialized,
                        // so on the winning device the frame lands while the
                        // accept flow is still awaiting axios and
                        // globalIncomingCall is still set — which is how
                        // answering on the device you are looking at used to
                        // toast "answered on your other device".
                        if (!isOwnAnswerEcho(msg.data?.device_id, deviceId)) {
                            setAnsweredElsewhereEvent({ session_id: msg.data.session_id });
                        }
                    }
                    if (msg.event === 'friend:accepted') {
                        setFriendAcceptedEvent({
                            requester_id: msg.data.requester_id,
                            recipient_id: msg.data.recipient_id
                        });
                    }
                    if (msg.event === 'group:member_added') {
                        setGroupMemberAddedEvent({
                            conversation_id: msg.data.conversation_id,
                            system_text: msg.data.system_text,
                        });
                    }
                    if (msg.event === 'group:updated') {
                        setGroupUpdatedEvent({
                            conversation_id: msg.data.conversation_id,
                            action: msg.data.action,
                            user_id: msg.data.user_id,
                            username: msg.data.username,
                            system_text: msg.data.system_text,
                            title: msg.data.title,
                            avatar_attachment: msg.data.avatar_attachment,
                        });
                    }
                    if (msg.event === 'user:avatar_updated') {
                        setAvatarUpdatedEvent({
                            user_id: msg.data.user_id,
                            avatar_url: msg.data.avatar_url,
                        });
                    }
                    if (msg.event === 'user:username_updated') {
                        setUsernameUpdatedEvent({
                            user_id: msg.data.user_id,
                            username: msg.data.username,
                            discriminator: msg.data.discriminator ?? null,
                        });
                    }
                    if (msg.event === 'channel:voice_state') {
                        setVoiceStateEvent({
                            channel_id: msg.data.channel_id,
                            user_id: msg.data.user_id,
                            action: msg.data.action as 'join' | 'leave',
                            display_name: readDisplayName(msg.data.display_name),
                            avatar_url: readPresenceString(msg.data.avatar_url),
                        });
                    }
                    if (msg.event === 'huddle:call_spawned') {
                        setHuddleSpawnEvent({
                            huddle_id: msg.data.huddle_id,
                            call: msg.data.call,
                        });
                    }
                    if (msg.event === 'huddle:call_destroyed') {
                        setHuddleDestroyEvent({
                            huddle_id: msg.data.huddle_id,
                            call_id: msg.data.call_id,
                        });
                    }
                    if (msg.event === 'huddle:call_renamed') {
                        setHuddleRenameEvent({
                            huddle_id: msg.data.huddle_id,
                            call_id: msg.data.call_id,
                            name: msg.data.name,
                        });
                    }
                    if (msg.event === 'huddle:participant') {
                        setHuddleParticipantEvent({
                            huddle_id: msg.data.huddle_id,
                            call_id: msg.data.call_id,
                            user_id: msg.data.user_id,
                            action: msg.data.action as 'join' | 'leave',
                            display_name: readDisplayName(msg.data.display_name),
                            avatar_url: readPresenceString(msg.data.avatar_url),
                        });
                    }
                    if (msg.event === 'huddle:force_move') {
                        setHuddleForceMoveEvent({
                            huddle_id: msg.data.huddle_id,
                            call_id: msg.data.call_id,
                            call_name: msg.data.call_name,
                            livekit_url: msg.data.livekit_url,
                            livekit_token: msg.data.livekit_token,
                            moved_by: msg.data.moved_by,
                            nonce: Date.now(),
                        });
                    }
                    if (msg.event === 'server:removed') {
                        setServerRemovedEvent({
                            server_id: msg.data.server_id,
                            reason: msg.data.reason as 'kick' | 'ban',
                        });
                    }
                    if (msg.event === 'server:member_joined') {
                        setServerMemberJoinedEvent({
                            server_id: msg.data.server_id,
                            user_id: msg.data.user_id,
                        });
                    }
                    if (msg.event === 'server:permissions_changed') {
                        // Use Date.now() as the timestamp so repeated permission
                        // events for the same server produce distinct objects —
                        // otherwise React's deps comparison wouldn't fire the
                        // consumer's useEffect a second time.
                        setPermissionsChangedEvent({
                            server_id: msg.data.server_id,
                            ts: Date.now(),
                        });
                    }
                    if (msg.event === 'server:channels_changed') {
                        setChannelsChangedEvent({
                            server_id: msg.data.server_id,
                            ts: Date.now(),
                        });
                    }
                    if (msg.event === 'server:members_changed') {
                        setServerMembersChangedEvent({
                            server_id: msg.data.server_id,
                            ts: Date.now(),
                        });
                    }
                    if (msg.event === 'server:updated') {
                        setServerUpdatedEvent({
                            server_id: msg.data.server_id,
                            ts: Date.now(),
                        });
                    }
                    // channel:saves_changed (a message was server-saved or
                    // unsaved without its pin changing) shares this state: the
                    // consumer's only job is "refetch this channel's saved +
                    // pinned lists", which one GET /saves answers for both.
                    if (msg.event === 'channel:pins_changed' || msg.event === 'channel:saves_changed') {
                        setChannelPinsChangedEvent({
                            server_id: msg.data.server_id,
                            channel_id: msg.data.channel_id,
                            ts: Date.now(),
                        });
                    }
                    if (msg.event === 'server:emojis_updated') {
                        setEmojisChangedEvent({
                            server_id: msg.data.server_id,
                            ts: Date.now(),
                        });
                    }
                    if (msg.event === 'server:owner_lapsed' || msg.event === 'server:owner_grace_cleared') {
                        setServerGraceStatusEvent({
                            server_id: msg.data.server_id,
                            ts: Date.now(),
                        });
                    }
                    if (msg.event === 'channel:read') {
                        const ev = parseChannelReadEvent(msg.data);
                        if (ev) setChannelReadEvents(prev => [...prev, ev].slice(-EVENT_QUEUE_CAP));
                    }
                    if (msg.event === 'server:channel_key_envelopes_ready') {
                        setChannelKeyEnvelopesReadyEvents(prev => [...prev, {
                            server_id:  msg.data.server_id,
                            channel_id: msg.data.channel_id,
                            epoch:      msg.data.epoch,
                            ts: Date.now(),
                        }].slice(-EVENT_QUEUE_CAP));
                    }
                    if (msg.event === 'server:key_requested') {
                        setKeyRequestedEvents(prev => [...prev, {
                            server_id:           msg.data.server_id,
                            channel_id:          msg.data.channel_id,
                            requester_user_id:   msg.data.requester_user_id,
                            requester_device_id: msg.data.requester_device_id,
                            ts: Date.now(),
                        }].slice(-EVENT_QUEUE_CAP));
                    }
                    if (msg.event === 'server:channel_key_rotation_needed') {
                        setChannelKeyRotationEvents(prev => [...prev, {
                            server_id:  msg.data.server_id,
                            channel_id: msg.data.channel_id,
                            reason:     msg.data.reason,
                            ts: Date.now(),
                        }].slice(-EVENT_QUEUE_CAP));
                    }
                    if (msg.event === 'channel:system_event') {
                        setChannelSystemEvent({
                            server_id: msg.data.server_id,
                            channel_id: msg.data.channel_id,
                            event_type: msg.data.event_type as 'member_join' | 'member_leave' | 'member_kick' | 'member_ban',
                            user_id: msg.data.user_id,
                            username: msg.data.username,
                            actor_id: msg.data.actor_id,
                            actor_username: msg.data.actor_username,
                            created_at: msg.data.created_at,
                        });
                    }
                    // Content-free by design (no `data` payload) — see
                    // useAnnouncements.ts's docblock for why this re-dispatches
                    // as a window CustomEvent rather than a setXxx state field:
                    // useAnnouncements is mounted separately inside
                    // AnnouncementBanners, not a consumer of this hook's return
                    // value. The event name is inlined (not imported from
                    // useAnnouncements.ts, which is `ANNOUNCEMENTS_CHANGED_EVENT`
                    // there and MUST stay in sync with the string below) because
                    // that module pulls in axios at load time, and axios's
                    // platform-detection code throws under useRealtime.test.ts's
                    // minimal window stub if imported transitively here.
                    if (msg.event === 'announcements:changed') {
                        window.dispatchEvent(new CustomEvent('cipherline:announcements-changed'));
                    }
                } catch (e) {
                    console.error('Failed to parse WS message', e);
                }
            };

            ws.onerror = (err) => console.error('WS Error:', err);

            ws.onclose = (ev) => {
                if (heartbeatInterval.current) clearInterval(heartbeatInterval.current);
                if (wsRef.current === ws) wsRef.current = null;

                // Server rejected us as too old — stop reconnecting and let the
                // global upgrade overlay take over the UI. Reconnecting would
                // just loop against the same 4426.
                if (ev.code === WS_CLOSE_UPGRADE_REQUIRED) {
                    dead = true;
                    window.dispatchEvent(new CustomEvent('cipherline:upgrade-required'));
                    return;
                }

                // Server rejected our client attestation. Reconnecting would
                // loop against the same rejection, so stop and surface the
                // upgrade overlay — the remedy is the same (install/update the
                // official build). Should be unreachable for a current official
                // client; only fires for forks or a rotated-out build secret.
                if (ev.code === WS_CLOSE_ATTESTATION_REQUIRED) {
                    dead = true;
                    window.dispatchEvent(new CustomEvent('cipherline:upgrade-required'));
                    return;
                }

                // Server revoked this session (password change or account disable).
                // Stop reconnecting and let AuthContext clear credentials + show login.
                if (ev.code === WS_CLOSE_SESSION_REVOKED) {
                    dead = true;
                    const message = ev.reason === 'Account disabled'
                        ? 'Your account has been disabled. Please contact support.'
                        : 'Your password was changed on another device. Please sign in again.';
                    window.dispatchEvent(new CustomEvent('cipherline:session-revoked', { detail: { message } }));
                    return;
                }

                if (!dead) {
                    // Notify useNetworkStatus so the OfflineScreen overlay can
                    // appear immediately when connectivity is lost (covers the
                    // case where navigator.onLine still reports true — e.g.
                    // Wi-Fi up but router dead / DNS broken / VPN dropped).
                    window.dispatchEvent(new CustomEvent('cipherline:ws-disconnected'));
                    scheduleReconnect();
                }
            };
            } finally {
                // Socket created + handlers wired (or we bailed) — release the
                // in-flight latch. From here the readyState guard prevents dups.
                connecting = false;
            }
        };

        connect();

        return () => {
            dead = true;
            window.removeEventListener('online', onOnline);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
            if (heartbeatInterval.current) clearInterval(heartbeatInterval.current);
            wsRef.current?.close();
            wsRef.current = null;
        };
    // deviceId is in the deps: a late-arriving deviceId (assigned shortly
    // after boot, once device registration completes) previously never
    // triggered a re-dial, so the gateway couldn't attribute that connection
    // to a specific device until the NEXT natural reconnect. Re-running this
    // effect tears down and reopens the socket, which only happens once in
    // practice — deviceId goes null-or-undefined -> a real id and then stays put.
    }, [token, deviceId]);

    // OS-level wake signal (electron/main.ts powerMonitor 'resume' /
    // 'unlock-screen') — the most reliable trigger there is, so this skips
    // straight to forceReconnect() rather than waiting for the liveness
    // watchdog above to independently notice the same thing up to
    // LIVENESS_TIMEOUT_MS later. Registered once (mount-only, no [token] dep)
    // via forceReconnectRef so it always calls into whichever connect effect
    // is current, even across a token change. No-ops outside Electron.
    useEffect(() => {
        const unsub = window.electronAPI?.onOsResume?.(() => {
            console.log('[WS] OS resume/unlock — forcing reconnect');
            // Freeze log: everything a wake sets off lands in this window.
            setTimeout(beginActivity('resume:wake'), 15_000);
            forceReconnectRef.current();
        });
        return () => unsub?.();
    }, []);

    // Expires stale "typing…" entries even with no further WS traffic for
    // that conversation — the other half of the fix alongside the
    // offline-clear above. `pruneExpiredTyping` is a no-op (returns the same
    // object reference) once nothing is left to expire, so this interval
    // costs a cheap map walk and no re-render the vast majority of the time
    // it fires. A quarter of TYPING_EXPIRY_MS keeps the indicator's worst-case
    // staleness close to the expiry itself rather than to the tick interval.
    // Only while someone IS typing: otherwise this was the app's most frequent
    // idle wakeup (0.8/s, forever) for a map that was empty.
    const anyoneTyping = useMemo(
        () => Object.values(typingTimestamps).some(users => Object.keys(users).length > 0),
        [typingTimestamps],
    );
    useEffect(() => {
        if (!anyoneTyping) return;
        const id = setInterval(() => {
            setTypingTimestamps(prev => pruneExpiredTyping(prev, Date.now()));
        }, TYPING_EXPIRY_MS / 4);
        return () => clearInterval(id);
    }, [anyoneTyping]);

    // ── Continuity — attention wiring ────────────────────────────────────────
    // Mount-once (no [token] dep), same pattern as the OS-resume effect above:
    // this tracks focus/idle regardless of connection state (sendAttentionNow
    // itself no-ops without an open socket, so there's nothing unsafe about
    // running it before login), and re-subscribing on every token change would
    // just mean redundant listener churn on every reconnect for no benefit.
    useEffect(() => {
        const electronAPI = (typeof window !== 'undefined' ? window.electronAPI : undefined);

        // Focus lost → not attentive, reported OFF-CYCLE (immediately, not
        // waiting for the next 15s heartbeat) per the spec: "without it the
        // user waits their full idle threshold plus 90s [server escalation]".
        const onFocusLost = () => {
            focusedRef.current = false;
            sendAttentionNow(false);
        };
        const onFocusGained = () => {
            focusedRef.current = true;
            // No off-cycle send on REGAINING focus — the spec only calls out
            // immediate sends for the four loss triggers. The next scheduled
            // heartbeat (≤15s) or idle poll (≤30s) picks up `true` once idle
            // time actually confirms recent input; reporting attentive here
            // before that would be the permissive direction the module doc
            // warns against (window merely regained focus proves nothing
            // about whether a human is actually at the keyboard yet).
        };

        // DOM-level baseline — works outside Electron too (web/dev), and is
        // the ONLY signal for 'focus'/'blur' in that context.
        window.addEventListener('blur', onFocusLost);
        window.addEventListener('focus', onFocusGained);
        // Hidden (tray, minimise — Chromium reports both as `hidden`): report
        // at once. A window hidden while it was already unfocused fires no
        // blur, so without this the next report waited for the 15 s timer.
        // Becoming visible again reports nothing early, same as regaining
        // focus; the next heartbeat carries the live verdict.
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') onFocusLost();
        };
        document.addEventListener('visibilitychange', onVisibility);

        // Electron main-process pushes — see preload.ts/main.ts. More
        // reliable than the renderer DOM events alone (same reasoning as the
        // existing onWindowFocus comment), and 'minimize'/lock are cases the
        // DOM 'blur' event may not reliably cover on every platform.
        const unsubBlur = electronAPI?.onWindowBlur?.(onFocusLost);
        const unsubMinimize = electronAPI?.onWindowMinimize?.(onFocusLost);
        // Tray hide (close-to-tray, `mainWindow.hide()`): not a blur on every
        // platform, and not a minimise at all.
        const unsubHide = electronAPI?.onWindowHide?.(onFocusLost);
        const unsubFocus = electronAPI?.onWindowFocus?.(onFocusGained);
        const unsubLock = electronAPI?.onOsLockScreen?.(onFocusLost);
        // Best-effort last heartbeat before the process dies — see main.ts's
        // 'before-quit' handler for why this can lose the race on a forced
        // quit (harmless: falls back to the pre-existing TTL-expiry behavior).
        const unsubQuit = electronAPI?.onBeforeQuit?.(() => sendAttentionNow(false));

        // Idle-time polling — reuses the SAME threshold/cadence useUserStatus
        // uses for auto-away (utils/idleThreshold.ts), never a second idle
        // notion. Runs an immediate check on mount (unlike useUserStatus,
        // which only checks on its interval) so a freshly-opened, focused,
        // actively-used app doesn't sit at the conservative "unknown" default
        // for up to IDLE_POLL_INTERVAL_MS before its first heartbeat can ever
        // report true.
        let idlePoll: ReturnType<typeof setInterval> | null = null;
        if (electronAPI?.getSystemIdleTime) {
            const pollOnce = () => {
                electronAPI.getSystemIdleTime!()
                    .then((secs: number) => {
                        idleSecondsRef.current = secs;
                    })
                    .catch(() => { /* leave idleSecondsRef at its last known value */ });
            };
            pollOnce();
            idlePoll = setInterval(pollOnce, IDLE_POLL_INTERVAL_MS);
        }

        return () => {
            window.removeEventListener('blur', onFocusLost);
            window.removeEventListener('focus', onFocusGained);
            document.removeEventListener('visibilitychange', onVisibility);
            unsubBlur?.();
            unsubMinimize?.();
            unsubHide?.();
            unsubFocus?.();
            unsubLock?.();
            unsubQuit?.();
            if (idlePoll) clearInterval(idlePoll);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // PERF: the composer calls this on EVERY keystroke. Sent as-is, that was
    // ~5-10 WS frames a second while typing — each one fanned out by the
    // server to every member of the conversation, each one a state update and
    // full Dashboard re-render on every receiving client, and each one spent
    // from this socket's gateway token bucket (10/s refill), so fast typing
    // could crowd out real events. One `typing:start` per conversation per
    // TYPING_START_MIN_GAP_MS carries the same information: receivers expire an
    // entry TYPING_EXPIRY_MS (5 s) after the last start, and the composer sends
    // `typing:stop` after 3 s idle, so the longest gap a receiver can see while
    // someone is typing is MIN_GAP + 3 s = 4 s. A stop always goes through and
    // re-arms the next start immediately.
    const lastTypingStartRef = useRef<Map<string, number>>(new Map());
    const sendTypingEvent = useCallback((event: 'typing:start' | 'typing:stop', conversation_id: string) => {
        const decision = typingSendDecision(lastTypingStartRef.current, event, conversation_id, Date.now());
        if (!decision) return;
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ event, data: { conversation_id } }));
        } else if (event === 'typing:start') {
            // Not actually sent — don't let the throttle swallow the next one.
            lastTypingStartRef.current.delete(conversation_id);
        }
    }, []);

    /**
     * `selfOnly` — the user has read receipts OFF. The read still has to reach
     * this user's other devices (or the badge on the phone never clears), but
     * nobody else: the gateway relays a `self_only` read to the sender's own
     * devices alone. An older gateway rejects the unknown field and drops the
     * event — what a receipts-off client sent before (nothing).
     */
    const sendReadReceipt = useCallback((conversation_id: string, last_read_message_id: string, opts?: { selfOnly?: boolean }) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
                event: 'message:read',
                data: opts?.selfOnly
                    ? { conversation_id, last_read_message_id, read_at: Date.now(), self_only: true }
                    : { conversation_id, last_read_message_id, read_at: Date.now() },
            }));
        }
    }, []);

    const respondToPairing = useCallback((approved: boolean, requesting_device_id: string, sync_key_b64?: string, iv_b64?: string) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            const eventTarget = approved ? 'device:pairing_approve' : 'device:pairing_deny';
            wsRef.current.send(JSON.stringify({
                event: eventTarget,
                data: {
                    device_id: requesting_device_id,
                    ...(sync_key_b64 && { sync_key_b64 }),
                    ...(iv_b64 && { iv_b64 })
                }
            }));
            setPairingRequest(null);
        }
    }, []);



    return {
        typingUsers, sendTypingEvent,
        // Exposed for the reconnect resync (Dashboard.tsx). typingStore.ts's
        // expiry (TYPING_EXPIRY_MS, pruned on an interval above) is what
        // guarantees a missed typing:stop never sticks forever, but a fresh
        // socket has no way to know whether a still-live entry is still
        // accurate — so reconnect clears eagerly rather than waiting out the
        // expiry.
        clearTypingUsers: () => setTypingTimestamps({}),
        readReceipts, sendReadReceipt,
        // Continuity — self-read sync (see isSelfReadEvent). Dashboard's
        // consumer clears the conversation's unread/mention badge and does
        // not need to explicitly reset this back to null (one-shot value
        // slot, same convention as every other *Event field here).
        selfReadEvent,
        pairingRequest, setPairingRequest,
        approvalRequest, setApprovalRequest, respondToPairing,
        historyRequest, setHistoryRequest,
        historyDeclined, setHistoryDeclined,
        deviceLinkedEvent,
        historyDelivered, clearHistoryDelivered: () => setHistoryDelivered(null),
        friendRemovedEvent, friendAcceptedEvent,
        friendRequestEvent,
        statusChangedEvent,
        sendPresenceIdle,
        callEndedEvent,
        soloKickEvent,
        answeredElsewhereEvent,
        groupMemberAddedEvent,
        groupUpdatedEvent,
        avatarUpdatedEvent,
        usernameUpdatedEvent,
        voiceStateEvent,
        huddleSpawnEvent,
        huddleDestroyEvent,
        huddleRenameEvent,
        huddleParticipantEvent,
        huddleForceMoveEvent,
        serverRemovedEvent,
        serverMemberJoinedEvent,
        permissionsChangedEvent,
        channelsChangedEvent,
        serverUpdatedEvent,
        serverMembersChangedEvent,
        channelPinsChangedEvent,
        emojisChangedEvent,
        serverGraceStatusEvent,
        channelKeyEnvelopesReadyEvents,
        setChannelKeyEnvelopesReadyEvents,
        channelReadEvents,
        setChannelReadEvents,
        keyRequestedEvents,
        setKeyRequestedEvents,
        channelKeyRotationEvents,
        setChannelKeyRotationEvents,
        channelSystemEvent,
        wsConnectCount,
    };
};
