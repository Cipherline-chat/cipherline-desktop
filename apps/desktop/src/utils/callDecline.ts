/**
 * The ring card's Decline button.
 *
 * Declining used to be purely local (the card disappeared and nothing was sent), so the account's other devices kept ringing, and a phone
 * that was never rung would later announce a "Missed call" for a call the person had refused. `POST /calls/:id/decline` is the server's
 * "I am not taking this on this device": it stops the account's OTHER devices ringing (iOS VoIP end, silent call_end, a
 * `call:declined_elsewhere` event), records the decline so no missed call is made for this person, and leaves the call running for everyone
 * else. The caller is NOT told (owner decision).
 *
 * Fire and forget by design: the card is dismissed first and a failure (offline, 403, an old server without the route) changes nothing the
 * person sees. The 15 s ring timeout is NOT a decline and never calls this: an unanswered ring is exactly what a missed call is.
 */
export interface DeclinePoster {
    post: (url: string, body: unknown, config: { headers: Record<string, string> }) => Promise<unknown>;
}

export function declineCallOnServer(
    http: DeclinePoster,
    url: string,
    token: string | null | undefined,
    deviceId: string | null | undefined,
): void {
    if (!token) return;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (deviceId) headers['x-device-id'] = deviceId;
    void Promise.resolve(http.post(url, {}, { headers })).catch(() => undefined);
}
