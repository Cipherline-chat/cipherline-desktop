import { nearApiBase } from './nearBridge';
/**
 * Own-device transfer, the page's half of the transport (contract section 7).
 *
 * The host engine never touches the network for an own-device transfer. An OUTGOING `near_offer` / `near_answer` / `near_msg` arrives as
 * a `cl:near-own-out` event ({ to, content }); this module puts it through the app's normal E2EE path to exactly ONE of this account's
 * other devices (the same steps the personal-pin sync uses: find-or-create the self conversation, list its devices, encrypt, address,
 * post). An INCOMING one is only forwarded to the host after this page checked what the host cannot: that the envelope's verified
 * author is ANOTHER device of THIS account (the host checks version, addressing, freshness and sizes itself).
 *
 * Nothing here parses or logs message content beyond its `type`, and nothing is stored.
 */

export const NEAR_OWN_TYPES = ['near_offer', 'near_answer', 'near_msg'] as const;
export type NearOwnType = typeof NEAR_OWN_TYPES[number];

export function isNearOwnControl(content: unknown): content is { type: NearOwnType } & Record<string, unknown> {
    return typeof content === 'object' && content !== null && !Array.isArray(content)
        && (NEAR_OWN_TYPES as readonly string[]).includes((content as { type?: unknown }).type as string);
}

export interface OwnDeliverApi {
    nearOwnDeliver?: (a: { content: Record<string, unknown>; fromDeviceId: string; ownDeviceId: string; deviceLabel?: string; apiBase?: string; auth?: { accessToken: string; userId: string; deviceId: string } }) => Promise<string>;
}

export interface IncomingOwnControl {
    content: unknown;
    /** This account / device. */
    userId: string | null | undefined;
    deviceId: string | null | undefined;
    /** The envelope's VERIFIED author, from the E2EE pipeline. */
    senderUserId: string | null | undefined;
    senderDeviceId: string | null | undefined;
    /** What to call the asking device on the sheet (the device list's name). */
    deviceLabel?: string;
    /** This account's session. Only the Electron build uses it: its approval gate (the account password) is verified by MAIN against the
     *  server and needs the token; the Windows host ignores the extra fields. */
    token?: string | null;
}

/**
 * Forward an incoming own-device control message to the host, only if it came from another device of this account.
 * Returns what happened; never throws.
 */
export async function deliverOwnNearControl(m: IncomingOwnControl, api: OwnDeliverApi | null | undefined = typeof window !== 'undefined' ? window.electronAPI as OwnDeliverApi | undefined : undefined): Promise<'delivered' | 'not_own' | 'unavailable' | 'failed'> {
    if (!isNearOwnControl(m.content)) return 'not_own';
    if (!m.userId || !m.deviceId || !m.senderUserId || !m.senderDeviceId) return 'not_own';
    // Own devices only, and never this device: a friend (or a forged claim) cannot start a transfer on this one.
    if (m.senderUserId !== m.userId || m.senderDeviceId === m.deviceId) return 'not_own';
    if (typeof api?.nearOwnDeliver !== 'function') return 'unavailable';
    try {
        await api.nearOwnDeliver({
            content: m.content, fromDeviceId: m.senderDeviceId, ownDeviceId: m.deviceId, deviceLabel: m.deviceLabel,
            ...(m.token ? { apiBase: nearApiBase(), auth: { accessToken: m.token, userId: m.userId, deviceId: m.deviceId } } : {}),
        });
        return 'delivered';
    } catch {
        return 'failed';
    }
}

export interface OwnSendDeps {
    userId: string;
    deviceId: string;
    /** Find-or-create this account's self conversation. */
    selfConversationId(): Promise<string>;
    /** `GET /conversations/:id/devices?claim_otp=1`. */
    listDevices(conversationId: string): Promise<{ device_id: string; spk_pub_b64: string; user_id: string }[]>;
    encryptAndAddress(plaintext: string, userId: string, devices: { device_id: string; spk_pub_b64: string }[], senderDeviceId: string): Promise<{ ciphertext_b64: string; recipient_device_ids: string[] }>;
    /** `POST /messages/send`. */
    post(body: { conversation_id: string; recipient_device_ids: string[]; envelope_type: 'signal_chat'; ciphertext_b64: string; sent_at_client: string }): Promise<void>;
}

/**
 * Build the function that carries one outgoing control message to ONE device of this account. Best effort: a failure resolves to
 * `false` (the host's own timeouts end the session); it never throws.
 */
export function createOwnControlSender(deps: OwnSendDeps): (to: string, content: Record<string, unknown>) => Promise<boolean> {
    let conv: Promise<string> | null = null;
    return async (to, content) => {
        try {
            if (!isNearOwnControl(content) || content.to !== to) return false;
            const id = await (conv ??= deps.selfConversationId().catch(e => { conv = null; throw e; }));
            const devices = (await deps.listDevices(id)).filter(d => d.user_id === deps.userId && d.device_id === to && d.device_id !== deps.deviceId);
            if (devices.length === 0) return false; // the target is not one of this account's other devices (or it is this one)
            const { ciphertext_b64, recipient_device_ids } = await deps.encryptAndAddress(JSON.stringify({ client_msg_id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `near-${Date.now()}`, ...content }), deps.userId, devices, deps.deviceId);
            if (!recipient_device_ids.includes(to)) return false;
            await deps.post({ conversation_id: id, recipient_device_ids: [to], envelope_type: 'signal_chat', ciphertext_b64, sent_at_client: new Date().toISOString() });
            return true;
        } catch {
            return false;
        }
    };
}
