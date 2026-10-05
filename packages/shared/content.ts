import type { KlipyGifMedia } from './klipy';

/**
 * Embedded mention tokens stored in message text (encrypted):
 *   <@u:USER_ID:username>   — specific user
 *   <@r:ROLE_ID:rolename>  — role
 *   @everyone              — all members
 *   @here                  — online members
 *
 * The `mentions` array carries the same data in structured form so the server
 * can route notifications without decrypting the text. Only `type` and `id`
 * are meaningful server-side; the display label stays encrypted in the text.
 */
export type MentionEntry =
    | { type: 'everyone' }
    | { type: 'here' }
    | { type: 'user'; id: string }
    | { type: 'role'; id: string };

export type ClientContent =
    | { client_msg_id?: string; type: 'text'; text: string; reply_to_id?: string; mentions?: MentionEntry[] }
    | {
        client_msg_id?: string;
        type: 'attachment';
        attachment_id: string;
        filename: string;
        byte_size: number;
        mime: string;
        file_key_b64: string;
        file_nonce_b64: string;
        enc_alg: 'xchacha20poly1305' | 'aes256gcm';
        chunk_size: number;
    }
    | {
        client_msg_id?: string;
        type: 'call_key';
        call_id: string;
        epoch: number;
        e2ee_key_b64: string;
        key_id: string;
        rotates_at: string;
    }
    | {
        client_msg_id?: string;
        type: 'call_event';
        call_id: string;
        event: 'started' | 'ended' | 'participant_joined' | 'participant_left';
        user_id?: string;
    }
    | { client_msg_id?: string; type: 'edit'; target_id: string; text: string }
    | { client_msg_id?: string; type: 'delete'; target_id: string }
    | { client_msg_id?: string; type: 'reaction'; target_id: string; emoji: string; action: 'add' | 'remove' }
    /**
     * A personal pin, synced between the SENDER'S OWN DEVICES ONLY.
     *
     * Unlike every other control type here, this one is deliberately not
     * addressed to the other conversation members: a pin is a private
     * bookmark ("Pin (local only)" in the UI, as opposed to a channel Server
     * Save, which is a shared moderation artifact). The sender filters the
     * device list to its own user before wrapping, so the other party never
     * receives an envelope at all and cannot learn that a message was pinned.
     *
     * `at` is the sending device's wall clock, used for last-write-wins —
     * delivery is per-device store-and-forward and therefore unordered, so
     * without it two devices can settle on opposite answers permanently.
     * See apps/desktop/src/utils/pinSync.ts.
     */
    | { client_msg_id?: string; type: 'pin'; conversation_id: string; target_id: string; action: 'add' | 'remove'; at: number }
    | {
        client_msg_id?: string;
        type: 'profile_update';
        user_id: string;
        avatar_attachment_id?: string;
        avatar_file_key_b64?: string;
        avatar_file_nonce_b64?: string;
        banner_attachment_id?: string;
        banner_file_key_b64?: string;
        banner_file_nonce_b64?: string;
    }
    | {
        client_msg_id?: string;
        type: 'group_update';
        conversation_id: string;
        title?: string;
        avatar_attachment_id?: string;
        avatar_file_key_b64?: string;
        avatar_file_nonce_b64?: string;
    }
    | { client_msg_id?: string; type: 'system'; kind: string; data: any }
    | { client_msg_id?: string; type: 'server_invite'; code: string }
    /**
     * ── A GIF from KLIPY, sent as a REFERENCE ─────────────────────────────────
     *
     * No bytes are uploaded: the payload names one KLIPY rendition, and each
     * recipient's client loads it straight from KLIPY's CDN — but only if that
     * recipient opted in to KLIPY (or taps to load it once). Travels inside the
     * ordinary E2EE envelope / channel ciphertext like any other message, so the
     * server learns nothing new.
     *
     * The URL is SENDER-CONTROLLED and therefore untrusted: a recipient must
     * validate the whole payload with `klipyGifProblem` / `parseKlipyGifRef`
     * (packages/shared/klipy.ts) and load nothing unless `media.url` passes the
     * exact KLIPY media-host allowlist — otherwise a GIF message is a tracking
     * pixel. Full rules: docs/klipy-client-contract.md.
     */
    | {
        client_msg_id?: string;
        type: 'klipy_gif';
        /** KLIPY slug (`[A-Za-z0-9._-]{1,200}`). Stable; used to re-fetch. */
        slug: string;
        /** The one rendition the sender chose. */
        media: KlipyGifMedia;
        /** KLIPY's title, for alt text. Optional, <= 200 chars. */
        title?: string;
    }
    /**
     * ── Safety-number share ─────────────────────────────────────────────────
     *
     * The sender's Contact Verification Code (`utils/verificationCode.ts`) —
     * a 40-character Crockford-base32 commitment to their whole published
     * identity-key set — delivered as a clickable embed so the recipient does
     * not have to transcribe forty characters by hand.
     *
     * Safe to send: a safety number is a fingerprint of PUBLIC keys. It
     * discloses nothing the key directory does not already serve to anyone who
     * asks, so this leaks no secret and no new metadata.
     *
     * **There is deliberately no verdict in this payload, and there never may
     * be one.** No `verified`, no `expected`, no `result`. The recipient's
     * client recomputes the expected code from ITS OWN copy of the sender's
     * keys and compares — so the only thing a sender (or anyone who can forge
     * one of these) controls is the value being compared, never the outcome of
     * the comparison. Adding any outcome-shaped field here would make a forged
     * "verified" representable on the wire, which is the one thing this shape
     * exists to prevent. See `apps/desktop/src/utils/safetyNumberEmbed.ts`.
     *
     * Equally deliberately, a match is NOT by itself a verification. The code
     * travels over the very channel a safety number exists to police, so an
     * attacker who has substituted keys can trivially send a code matching the
     * keys they substituted. The embed therefore reports agreement and still
     * requires the user to attest they compared it out of band before any
     * trust state changes. The asymmetry is the point: a MISMATCH is real
     * evidence of a problem, a match is only the absence of one.
     */
    | {
        client_msg_id?: string;
        type: 'safety_number';
        /**
         * The account whose identity-key set `code` commits to. Display and
         * consistency-check ONLY — the verdict is always computed against the
         * sender id on the envelope, never against this field, so a mismatch
         * between the two is itself reported rather than silently followed.
         */
        user_id: string;
        /** Crockford-base32 contact verification code (40 chars). */
        code: string;
        /** How many devices the sender committed to. Display only. */
        device_count?: number;
    }
    // ── Sender Keys — channel key distribution (one per rotation event) ──────
    // Delivered through the existing per-recipient envelope pipeline so the
    // key bytes are E2EE and never visible to the server.
    | {
        client_msg_id?: string;
        type: 'channel_key';
        channel_id: string;
        /** Epoch counter. Starts at 1, increments on every rotation. */
        epoch: number;
        /** 32-byte AES-256-GCM channel key, base64-encoded. */
        key_b64: string;
        /** ISO8601 — when this epoch key should be rotated (7-day default). */
        rotates_at: string;
        /** Human-readable reason: 'initial' | 'member_removed' | 'periodic' | 'permission_change' */
        rotation_reason: string;
    }
    // ── Sender Keys — one ciphertext per message, regardless of member count ──
    // NOT delivered via per-recipient envelopes. Stored server-side as a single
    // ChannelMessage row and fanned out via the `channel:message_new` WS event.
    | {
        client_msg_id?: string;
        type: 'channel_message';
        channel_id: string;
        /** Must match the epoch of the channel key used for encryption. */
        epoch: number;
        /** AES-GCM nonce, base64. */
        nonce_b64: string;
        /** AES-GCM ciphertext ‖ 16-byte tag, base64. */
        ciphertext_b64: string;
        /** device_id of the sender — clients use this to look up the sender's identity pub. */
        sender_device_id: string;
        /** Ed25519 signature over the ciphertext bytes (base64). */
        signature_b64: string;
        reply_to_id?: string;
        created_at: string;
    };
