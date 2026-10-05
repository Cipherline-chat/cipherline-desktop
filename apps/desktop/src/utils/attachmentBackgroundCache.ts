/**
 * Background, one-at-a-time caching of attachment ENCRYPTED bytes.
 *
 * ChatPane used to download-and-decrypt every attachment in a conversation's
 * loaded history the moment it opened. Only the rows near the viewport are
 * decrypted now (see ChatPane's `decryptScope`), but the old behaviour had one
 * property worth keeping: every loaded attachment's ciphertext ended up in the
 * local cache, so it outlives the server's attachment sweep for users whose
 * local retention is longer. This keeps that property without the decrypts,
 * the resident plaintext blobs or the re-renders: off-screen attachments are
 * checked (and, if missing, fetched still-encrypted) one at a time, when the
 * renderer is idle. Each id is handled at most once per session.
 */
import { hasEncryptedAttachment, putEncryptedAttachment } from './attachmentCache';
import { downloadEncryptedAttachment } from './attachmentDownload';
import { API_BASE } from '../constants';

const handled = new Set<string>();
const queue: Array<{ attachmentId: string; token: string }> = [];
let running = false;

type IdleFn = (cb: () => void) => void;
const whenIdle: IdleFn = (cb) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(cb, { timeout: 5_000 });
    else setTimeout(cb, 200);
};

async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
        while (queue.length) {
            const job = queue.shift()!;
            await new Promise<void>(r => whenIdle(r));
            try {
                if (await hasEncryptedAttachment(job.attachmentId)) continue;
                const blob = await downloadEncryptedAttachment(job.attachmentId, job.token, API_BASE);
                await putEncryptedAttachment(job.attachmentId, blob);
            } catch {
                // Gone (404) or offline: the row's own decrypt path reports it
                // properly when it scrolls into view. Nothing to do here.
            }
        }
    } finally {
        running = false;
    }
}

/** Make sure this attachment's ciphertext is in the local cache, eventually. */
export function backgroundCacheEncryptedAttachment(attachmentId: string, token: string): void {
    if (!attachmentId || handled.has(attachmentId)) return;
    handled.add(attachmentId);
    queue.push({ attachmentId, token });
    void pump();
}

/** Test-only. */
export function __resetAttachmentBackgroundCache(): void {
    handled.clear();
    queue.length = 0;
    running = false;
}
