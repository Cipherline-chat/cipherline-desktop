/**
 * Send one hidden CONTROL message (a `profile_update` carrying extra fields)
 * to ONE accepted friend's devices, end to end encrypted, over the DM you
 * share with them. Used by the friend-to-friend deliveries that must never
 * become a chat row: the personal-emoji status image (useStatusEmojiShare)
 * and the listening-cover activity key (useActivityKeyShare).
 *
 * Only that friend's devices are addressed (never the sender's own other
 * devices, never anyone else in the conversation). `claim_otp=1`: one
 * one-time prekey per recipient device, like every other send.
 *
 * 'skipped' = the friend has no registered device (nothing to deliver to);
 * 'throttled' = messages/send said 429 (5 per 3 s per user, shared with chat).
 */
import axios from 'axios';
import { API_BASE } from '../constants';
import { apiUrl } from './apiPath';
import { encryptAndAddress } from './encryptAndAddress';

export type FriendControlResult = 'sent' | 'skipped' | 'failed' | 'throttled';

export interface FriendControlTarget { userId: string; conversationId: string }

export async function sendFriendControl(
    target: FriendControlTarget,
    content: object,
    me: { token: string; deviceId: string; userId: string },
): Promise<FriendControlResult> {
    const headers = { Authorization: `Bearer ${me.token}`, 'x-device-id': me.deviceId };
    try {
        const res = await axios.get(
            apiUrl`/conversations/${target.conversationId}/devices?claim_otp=1`,
            { headers },
        );
        if (!Array.isArray(res.data)) return 'failed';
        const theirs = (res.data as { device_id: string; spk_pub_b64: string; user_id: string }[])
            .filter(d => d.user_id === target.userId);
        if (theirs.length === 0) return 'skipped';
        const { ciphertext_b64, recipient_device_ids } = await encryptAndAddress(
            JSON.stringify(content), me.userId, theirs, me.deviceId,
        );
        if (recipient_device_ids.length === 0) return 'skipped';
        await axios.post(
            `${API_BASE}/messages/send`,
            {
                conversation_id: target.conversationId,
                recipient_device_ids,
                envelope_type: 'signal_chat',
                ciphertext_b64,
                sent_at_client: new Date().toISOString(),
            },
            { headers },
        );
        return 'sent';
    } catch (e) {
        return axios.isAxiosError(e) && e.response?.status === 429 ? 'throttled' : 'failed';
    }
}
