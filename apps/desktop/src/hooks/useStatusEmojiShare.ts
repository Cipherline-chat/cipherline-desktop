/**
 * Delivers the image behind a personal-emoji custom status to the user's
 * accepted friends, device to device and end to end encrypted.
 *
 * The server only ever stores the `cl:p_<id>` reference (apps/api: the image
 * column is unused), so this is the ONLY way a friend can see the emoji. It runs
 * whenever the status emoji, the set of friends with a DM, or the session
 * changes, and the per-friend ledger (utils/personalEmoji/statusEmoji.ts) makes
 * a repeat a no-op: a status change to an emoji a friend already has sends
 * nothing. Nothing is sent to anyone who is not an accepted friend.
 *
 * The control message is a `profile_update` with an extra `status_emoji` field:
 * old clients apply and drop `profile_update` without a chat row.
 */
import { useEffect, useMemo } from 'react';
import axios from 'axios';
import { API_BASE } from '../constants';
import { apiUrl } from '../utils/apiPath';
import { encryptAndAddress } from '../utils/encryptAndAddress';
import secureLocalStore from '../utils/secureLocalStore';
import { personalEmojis } from '../utils/personalEmoji/service';
import {
    parseStatusEmojiLedger, personalIdOfStatusEmoji, shareStatusEmoji, statusEmojiTargets,
    type ShareDeps,
} from '../utils/personalEmoji/statusEmoji';

export const statusEmojiLedgerKey = (userId: string) => `cipherline_status_emoji_shared_${userId}`;

const RETRY_MS = 30_000;
const MAX_ATTEMPTS = 5;

interface Args {
    token: string | null | undefined;
    deviceId: string | null | undefined;
    userId: string | null | undefined;
    /** The status emoji as stored (`cl:p_…`, unicode, or empty). */
    emoji: string | null | undefined;
    /** Accepted friends only. */
    friendIds: readonly string[];
    /** DM conversations: the friend each one is with. */
    dms: readonly { conversationId: string; otherUserId: string | null | undefined }[];
}

export function useStatusEmojiShare({ token, deviceId, userId, emoji, friendIds, dms }: Args): void {
    const targets = useMemo(() => statusEmojiTargets(friendIds, dms), [friendIds, dms]);
    const targetsKey = useMemo(() => targets.map(t => `${t.userId}:${t.conversationId}`).sort().join('|'), [targets]);

    useEffect(() => {
        if (!token || !deviceId || !userId || !personalIdOfStatusEmoji(emoji) || targets.length === 0) return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const headers = { Authorization: `Bearer ${token}`, 'x-device-id': deviceId };
        const deps: ShareDeps = {
            store: personalEmojis().store,
            load: () => parseStatusEmojiLedger(secureLocalStore.getItem(statusEmojiLedgerKey(userId))),
            save: ledger => secureLocalStore.setItem(statusEmojiLedgerKey(userId), JSON.stringify(ledger)),
            now: () => Date.now(),
            sleep: ms => new Promise(r => setTimeout(r, ms)),
            newId: () => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `se-${Date.now()}`),
            cancelled: () => cancelled,
            async send(target, content) {
                try {
                    // claim_otp=1: one one-time prekey per recipient device, like every other send.
                    const res = await axios.get(
                        apiUrl`/conversations/${target.conversationId}/devices?claim_otp=1`,
                        { headers },
                    );
                    if (!Array.isArray(res.data)) return 'failed';
                    const theirs = (res.data as { device_id: string; spk_pub_b64: string; user_id: string }[])
                        .filter(d => d.user_id === target.userId);
                    if (theirs.length === 0) return 'skipped';
                    const { ciphertext_b64, recipient_device_ids } = await encryptAndAddress(
                        JSON.stringify(content), userId, theirs, deviceId,
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
            },
        };
        const run = async (attempt: number) => {
            const outcome = await shareStatusEmoji(emoji, userId, targets, deps).catch(() => ({ retry: false }));
            if (outcome.retry && !cancelled && attempt < MAX_ATTEMPTS) {
                timer = setTimeout(() => { void run(attempt + 1); }, RETRY_MS);
            }
        };
        void run(1);
        return () => { cancelled = true; if (timer) clearTimeout(timer); };
        // `targets` is represented by its key: a refetched friends list with the same people must not restart a run.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token, deviceId, userId, emoji, targetsKey]);
}
