/**
 * Which message a `message:read` receipt names.
 *
 * `last_read_message_id` is load-bearing beyond "seen" ticks (Message integrity
 * §5, 2026-09-24): mobile's gap detector (cipherline-mobile
 * `features/messages/gaps.ts`) compares it with its own rows, and when one of
 * the user's devices reports reading a message the phone never received, the
 * phone offers a history sync ("A message you read on another device didn't
 * arrive here"). The gateway relays it verbatim and validates it as a UUID
 * (`MessageReadEventDto`).
 *
 * So the id must be one EVERY participating device can know: the id of a real
 * message (`client_msg_id`, falling back to the envelope id only for senders
 * that never set one). A row this device made up locally is not that:
 *  - a group "X added Y" row (`system-<ts>-<rand>`) is not a UUID, so the
 *    gateway rejected the whole receipt;
 *  - an undecryptable placeholder is keyed by THIS device's envelope id, which
 *    no other device has, so a phone would report a message as missing.
 * Every local row is `content.type === 'system'`; the receipt names the newest
 * message that is not.
 */
export function lastReadableMessageId(messages: ReadonlyArray<{ id?: unknown; content?: { type?: unknown } | null }>): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!m || m.content?.type === 'system') continue;
        // A non-UUID id is a row this device minted (the global-call banner's
        // `global-<ts>` call_key row, for one): the gateway rejects the WHOLE
        // receipt for it, which silently stalled read sync — and the badge on
        // the user's other devices — until the next real message arrived.
        if (typeof m.id === 'string' && UUID.test(m.id)) return m.id;
    }
    return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What ChatPane should send for the newest readable message, if anything.
 *
 * Multi-device audit (2026-10-03), two bugs this closes:
 *
 *  - **Read while nobody was looking.** The receipt went out whenever the
 *    open chat's messages changed — including on a minimised or unfocused
 *    window, and at start-up with the last chat restored in the tray. That told
 *    the other person "seen" and, through self-read sync, cleared the badge on
 *    the user's PHONE for a message no one had read. A read now needs a window
 *    that is focused and visible (`attended`); the id is not marked sent, so it
 *    goes out the moment the user actually looks.
 *  - **Receipts off meant no sync at all.** With "show read receipts" off the
 *    effect returned early, so reading on the desktop never cleared the phone.
 *    It now sends a `self_only` read: the user's own devices learn, nobody else.
 *
 * Notification-reliability audit (2026-11-25): focus alone is not a reader
 * either. A focused window on an idle PC is not looked at, so an auto read also
 * needs `recentInput`; the id is not marked sent, and the effect re-runs when
 * input returns, so it goes out then.
 */
export function readReceiptToSend(p: {
    lastId: string | null;
    lastSentId: string | null;
    attended: boolean;
    /** Real input (OS idle clock or this window) within AUTO_READ_MAX_IDLE_MS.
     *  An AUTO read needs it; explicit user actions pass `true`. See
     *  utils/inputRecency.ts: an idle PC with a chat focused used to "read"
     *  every arriving message and cancel the phone's notification. */
    recentInput: boolean;
    showReadReceipts: boolean;
}): { id: string; selfOnly: boolean } | null {
    if (!p.lastId || p.lastId === p.lastSentId) return null;
    if (!p.attended) return null;
    if (!p.recentInput) return null;
    return { id: p.lastId, selfOnly: !p.showReadReceipts };
}

/**
 * The `message:read` WS payload. `idle_ms` (ms since real input, same source as
 * the heartbeat's) lets the server cancel the phone's pending notification only
 * for a read a person plausibly made; omitted when unknown. Minimal on purpose.
 */
export function buildMessageReadData(
    conversationId: string,
    lastReadMessageId: string,
    opts: { selfOnly?: boolean } | undefined,
    idleMs: number | undefined,
    readAt: number = Date.now(),
): Record<string, unknown> {
    return {
        conversation_id: conversationId,
        last_read_message_id: lastReadMessageId,
        read_at: readAt,
        ...(opts?.selfOnly ? { self_only: true } : {}),
        ...(idleMs !== undefined && Number.isInteger(idleMs) && idleMs >= 0 ? { idle_ms: idleMs } : {}),
    };
}
