/**
 * Dedicated worker for attachment / saved-GIF AES-GCM (see utils/attachmentCryptoWorker.ts).
 * Blobs and CryptoKeys cross the boundary by structured clone (handles, not
 * bytes), so the multi-MB reads, the cipher's input/output copies and the
 * result Blob's copy into blob storage all happen here instead of on the UI
 * thread.
 */
import { encryptBlobCore, decryptBlobCore } from '../utils/attachmentCryptoCore';

const post = (msg: unknown) => (self as unknown as Worker).postMessage(msg);

type Req =
    | { id: number; op: 'enc'; blob: Blob; key: CryptoKey; bundleIv: boolean }
    | { id: number; op: 'dec'; blob: Blob; key: CryptoKey; ivB64: string | null; type: string };

self.onmessage = async (e: MessageEvent<Req>) => {
    const m = e.data;
    try {
        if (m.op === 'enc') {
            const { encryptedBlob, ivB64 } = await encryptBlobCore(m.blob, m.key, m.bundleIv);
            post({ id: m.id, ok: true, blob: encryptedBlob, ivB64 });
        } else {
            const blob = await decryptBlobCore(m.blob, m.key, m.ivB64, m.type);
            post({ id: m.id, ok: true, blob });
        }
    } catch (err) {
        const er = err as { name?: string; message?: string };
        post({ id: m.id, ok: false, name: er?.name ?? 'Error', message: er?.message ?? String(err) });
    }
};
