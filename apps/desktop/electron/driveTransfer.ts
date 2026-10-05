/**
 * Google Drive file transfer for the single-file backup — main process.
 *
 * Upload uses Drive's resumable protocol, streamed from disk in 8 MiB
 * pieces, so a backup of any size goes up without ever being held in
 * memory, survives a dropped connection (the session is queried and resumed
 * from Drive's committed offset), and updates the EXISTING file in place
 * when one with the same name is already in the folder — same file ID, new
 * Drive revision, no extra files. Drive has no partial-content update, so
 * this whole-file re-upload is the only way to "modify" a file there.
 *
 * Every upload is verified: an MD5 is computed over the bytes as they're
 * read, and compared with the `md5Checksum` Drive reports for the stored
 * content. A mismatch is an error, not a warning — the caller treats the
 * backup as failed and leaves any older files alone.
 *
 * Download streams straight to a path (the restore then reads it by range
 * through the normal backup reader).
 *
 * Node built-ins only, like googleDriveAuth.ts. Google's hosts use publicly
 * trusted certificates, so no dev-mode TLS exceptions are needed here.
 */

import * as fs from 'fs';
import * as https from 'https';
import * as crypto from 'crypto';
import { URL } from 'url';

const API_HOST = 'www.googleapis.com';
const CHUNK_BYTES = 8 * 1024 * 1024; // must be a multiple of 256 KiB
const MAX_RETRIES = 6;

export interface TransferProgress { done: number; total: number }
type GetToken = () => Promise<string>;

interface HttpResponse { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }

function request(
    url: string,
    opts: { method: string; headers?: Record<string, string | number>; body?: Buffer },
): Promise<HttpResponse> {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !u.hostname.endsWith('.googleapis.com')) {
        throw new Error('Refusing to talk to a non-Google host');
    }
    return new Promise((resolve, reject) => {
        const req = https.request(u, { method: opts.method, headers: opts.headers }, (res) => {
            const parts: Buffer[] = [];
            res.on('data', (c: Buffer) => parts.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }));
            res.on('error', reject);
        });
        req.on('error', reject);
        if (opts.body) req.write(opts.body);
        req.end();
    });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Bytes Drive has committed, from a 308 response's `Range: bytes=0-N`. */
function parseCommitted(range: string | string[] | undefined): number | null {
    const m = typeof range === 'string' ? /bytes=0-(\d+)/.exec(range) : null;
    return m ? Number(m[1]) + 1 : null;
}
const backoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500;

/** Find a non-trashed file by exact name inside `folderId`. */
export async function findDriveFile(
    getToken: GetToken, folderId: string, name: string,
): Promise<{ id: string; size: number; md5Checksum?: string; modifiedTime?: string } | null> {
    const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`);
    const res = await request(
        `https://${API_HOST}/drive/v3/files?q=${q}&fields=files(id,size,md5Checksum,modifiedTime)&spaces=drive`,
        { method: 'GET', headers: { Authorization: `Bearer ${await getToken()}` } },
    );
    if (res.status !== 200) throw new Error(`Drive query failed: HTTP ${res.status}`);
    const f = JSON.parse(res.body.toString('utf8')).files?.[0];
    return f ? { id: f.id, size: Number(f.size ?? 0), md5Checksum: f.md5Checksum, modifiedTime: f.modifiedTime } : null;
}

/**
 * Upload `filePath` as `fileName` into `folderId`, replacing the content of
 * an existing file with that name if there is one. Resolves with Drive's
 * record of the stored file once its checksum has been verified.
 */
export async function uploadFileResumable(opts: {
    getToken: GetToken;
    folderId: string;
    fileName: string;
    filePath: string;
    onProgress?: (p: TransferProgress) => void;
}): Promise<{ id: string; size: number; md5Checksum: string }> {
    const { getToken, folderId, fileName, filePath, onProgress } = opts;
    const stat = await fs.promises.stat(filePath);
    const total = stat.size;
    if (total === 0) throw new Error('Refusing to upload an empty backup file');

    // Local checksum, computed as the file is read for upload.
    const md5 = crypto.createHash('md5');

    const existing = await findDriveFile(getToken, folderId, fileName);
    const initUrl = existing
        ? `https://${API_HOST}/upload/drive/v3/files/${existing.id}?uploadType=resumable&fields=id,size,md5Checksum`
        : `https://${API_HOST}/upload/drive/v3/files?uploadType=resumable&fields=id,size,md5Checksum`;
    const metadata = Buffer.from(JSON.stringify(existing ? { name: fileName } : { name: fileName, parents: [folderId] }));
    const init = await request(initUrl, {
        method: existing ? 'PATCH' : 'POST',
        headers: {
            Authorization: `Bearer ${await getToken()}`,
            'Content-Type': 'application/json; charset=UTF-8',
            'Content-Length': metadata.length,
            'X-Upload-Content-Type': 'application/octet-stream',
            'X-Upload-Content-Length': total,
        },
        body: metadata,
    });
    if (init.status !== 200) throw new Error(`Drive upload could not start: HTTP ${init.status}`);
    const sessionUri = init.headers['location'];
    if (typeof sessionUri !== 'string' || !sessionUri) throw new Error('Drive upload session missing Location header');
    new URL(sessionUri); // request() re-validates the host on every call

    const handle = await fs.promises.open(filePath, 'r');
    let hashed = 0; // bytes already fed to md5 (never re-hash on resume)
    let final: HttpResponse | null = null;
    try {
        let offset = 0;
        let attempt = 0;
        while (offset < total) {
            const len = Math.min(CHUNK_BYTES, total - offset);
            const chunk = Buffer.alloc(len);
            const { bytesRead } = await handle.read(chunk, 0, len, offset);
            if (bytesRead !== len) throw new Error('Backup file changed while uploading');
            if (offset + len > hashed) {
                md5.update(chunk.subarray(Math.max(0, hashed - offset)));
                hashed = offset + len;
            }

            let res: HttpResponse;
            try {
                res = await request(sessionUri, {
                    method: 'PUT',
                    headers: {
                        Authorization: `Bearer ${await getToken()}`,
                        'Content-Length': len,
                        'Content-Range': `bytes ${offset}-${offset + len - 1}/${total}`,
                    },
                    body: chunk,
                });
            } catch (err) {
                if (++attempt > MAX_RETRIES) throw err;
                await sleep(backoff(attempt));
                offset = await committedOffset(sessionUri, getToken, total);
                continue;
            }

            if (res.status === 308) {
                attempt = 0;
                offset = parseCommitted(res.headers['range']) ?? offset + len;
                onProgress?.({ done: offset, total });
                continue;
            }
            if (res.status === 200 || res.status === 201) {
                onProgress?.({ done: total, total });
                final = res;
                break;
            }
            if (res.status === 404 || res.status === 410) {
                throw new Error('Drive upload session expired — please run the backup again');
            }
            if (res.status >= 500 || res.status === 429) {
                if (++attempt > MAX_RETRIES) throw new Error(`Drive upload failed: HTTP ${res.status}`);
                await sleep(backoff(attempt));
                offset = await committedOffset(sessionUri, getToken, total);
                continue;
            }
            throw new Error(`Drive upload failed: HTTP ${res.status} ${res.body.toString('utf8').slice(0, 200)}`);
        }
        if (!final) {
            // Every chunk was acknowledged with 308 but Drive never sent the
            // final 200 — ask for status once more.
            const status = await request(sessionUri, {
                method: 'PUT',
                headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Length': 0, 'Content-Range': `bytes */${total}` },
            });
            if (status.status !== 200 && status.status !== 201) throw new Error(`Drive upload did not complete: HTTP ${status.status}`);
            final = status;
        }
    } finally {
        await handle.close();
    }

    if (hashed !== total) {
        // A resume skipped bytes we never hashed locally — hash the file once
        // more from disk so the comparison below is meaningful.
        const h2 = crypto.createHash('md5');
        await new Promise<void>((resolve, reject) => {
            fs.createReadStream(filePath).on('data', (c: string | Buffer) => h2.update(c)).on('end', () => resolve()).on('error', reject);
        });
        return verifyStored(final, total, h2.digest('hex'));
    }
    return verifyStored(final, total, md5.digest('hex'));
}

function verifyStored(final: HttpResponse, total: number, localMd5: string): { id: string; size: number; md5Checksum: string } {
    const body = JSON.parse(final.body.toString('utf8'));
    const storedSize = Number(body.size ?? -1);
    const storedMd5: string | undefined = body.md5Checksum;
    if (storedSize !== total) throw new Error(`Drive stored ${storedSize} bytes but ${total} were uploaded`);
    if (!storedMd5 || storedMd5.toLowerCase() !== localMd5) {
        throw new Error('Drive reported a different checksum than the file that was uploaded');
    }
    return { id: body.id, size: storedSize, md5Checksum: storedMd5 };
}

/** Ask Drive how much of a resumable session it has committed. */
async function committedOffset(sessionUri: string, getToken: GetToken, total: number): Promise<number> {
    const res = await request(sessionUri, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Length': 0, 'Content-Range': `bytes */${total}` },
    });
    if (res.status === 308) return parseCommitted(res.headers['range']) ?? 0;
    if (res.status === 200 || res.status === 201) return total;
    if (res.status === 404 || res.status === 410) throw new Error('Drive upload session expired — please run the backup again');
    return 0;
}

/** Stream a Drive file's content to `destPath`. */
export async function downloadFileToPath(opts: {
    getToken: GetToken;
    fileId: string;
    destPath: string;
    onProgress?: (p: TransferProgress) => void;
}): Promise<{ size: number }> {
    const { getToken, fileId, destPath, onProgress } = opts;
    const token = await getToken();
    let url = `https://${API_HOST}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
    for (let hop = 0; hop < 3; hop++) {
        const u = new URL(url);
        if (u.protocol !== 'https:' || !(u.hostname.endsWith('.googleapis.com') || u.hostname.endsWith('.googleusercontent.com'))) {
            throw new Error('Refusing to download from a non-Google host');
        }
        const result = await new Promise<{ redirect?: string; size?: number }>((resolve, reject) => {
            const req = https.request(u, { method: 'GET', headers: { Authorization: `Bearer ${token}` } }, (res) => {
                const status = res.statusCode ?? 0;
                if (status >= 300 && status < 400 && res.headers.location) {
                    res.resume();
                    resolve({ redirect: res.headers.location });
                    return;
                }
                if (status !== 200) {
                    res.resume();
                    reject(new Error(`Drive download failed: HTTP ${status}`));
                    return;
                }
                const total = Number(res.headers['content-length'] ?? 0);
                let done = 0;
                const out = fs.createWriteStream(destPath, { mode: 0o600 });
                res.on('data', (c: Buffer) => { done += c.length; onProgress?.({ done, total: total || done }); });
                res.on('error', reject);
                out.on('error', reject);
                out.on('finish', () => resolve({ size: done }));
                res.pipe(out);
            });
            req.on('error', reject);
            req.end();
        });
        if (result.redirect) { url = result.redirect; continue; }
        return { size: result.size ?? 0 };
    }
    throw new Error('Drive download: too many redirects');
}
