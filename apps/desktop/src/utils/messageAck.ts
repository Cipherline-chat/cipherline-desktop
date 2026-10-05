/**
 * messageAck — POST /messages/ack, wrapped so it can never throw.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 *
 * Before this wrapper, Dashboard's `pullMessagesOnce` awaited
 * `axios.post('/messages/ack', ...)` inline, with no try/catch of its own,
 * as the first statement inside the `if (ackIds.length > 0) { ... }` block
 * that ALSO contains every unread/mention counter update and every
 * `notify()` call for the batch of DMs that was just decrypted. A network
 * blip or a transient 5xx on that one POST threw straight past all of it
 * into the outer `catch (err) { console.error('Polling error', err) }` —
 * silently dropping the sound, the toast, and the badge for every DM in the
 * batch, even though the messages were already decrypted and about to be
 * shown.
 *
 * This is what makes "server/channel notifications still work" weak
 * evidence that DMs are healthy: channel messages arrive over the
 * already-open WS connection (`channel:message_new`) and are notified
 * synchronously with no REST round-trip in between. DMs are the only
 * notification path in the app with a network call sitting between
 * "message decrypted" and "user told about it" — so they are the only path
 * a flaky ack can silently break.
 *
 * Acking only tells the server "stop resending these" — it has nothing to
 * do with whether the user should be told a message arrived. A failed ack
 * is not silently lost either way: the envelope simply stays on the server
 * and is redelivered on the next poll (~5s later, or immediately on the
 * next `message:new` push).
 */

import axios from 'axios';

export interface AckMessagesResult {
    ok: boolean;
    error?: unknown;
}

/**
 * Ack a batch of envelope ids. Resolves with `{ ok: false, error }` instead
 * of throwing on any failure (network error, non-2xx, timeout) — callers
 * MUST be able to proceed with notifying/counting the messages in this batch
 * regardless of whether the ack itself succeeded.
 */
export async function ackMessageEnvelopes(
    apiBase: string,
    envelopeIds: string[],
    token: string,
    deviceId: string,
): Promise<AckMessagesResult> {
    try {
        await axios.post(`${apiBase}/messages/ack`, { envelope_ids: envelopeIds }, {
            headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId },
        });
        return { ok: true };
    } catch (error) {
        return { ok: false, error };
    }
}
