/**
 * Message franking, client half (protocol v1 - apps/api/src/franking/franking.protocol.ts
 * is the other implementation; utils/franking.vectors.json pins both to the same
 * bytes).
 *
 *   SEND     The sender makes a random 256-bit key kf per message, computes the
 *            commitment  c = HMAC-SHA256(kf, canon(kind, body, sender user,
 *            sender device, conversation|channel, sender clock))  and:
 *              - seals  _fk = { v:1, kf, ts }  INSIDE the end-to-end encrypted
 *                payload, so only the recipients learn kf;
 *              - sends  c  OUTSIDE the ciphertext, in the `x-franking-commitment`
 *                header (a header so an API that predates franking ignores it
 *                instead of rejecting the body).
 *   RECEIVE  The relay returns, with each message, {c, t, kid, ts}: t is its
 *            tag over c, the authenticated sender, the conversation/channel,
 *            this recipient (or the channel row) and the server time. The
 *            recipient keeps (kf, c, t, kid, ts) WITH the message, encrypted at
 *            rest like the message itself (the `franking` field).
 *   REPORT   The reporter submits those with the message text; the API checks
 *            t (the server relayed it) and c (the sender wrote it).
 *
 * Nothing here is a new primitive: HMAC-SHA256 and a CSPRNG from WebCrypto,
 * nothing custom. kf never leaves the E2EE channel except to the reporter's
 * own report. Every function here fails SOFT: a franking problem must never
 * stop a message from being sent or shown, it only makes that message
 * "unverified" if reported.
 */

export const FRANK_VERSION = 1;
export const FRANK_MSG_MAGIC = 'CLFRANK1';

export type FrankKind = 'text' | 'attachment' | 'klipy_gif';
export type FrankContextKind = 'dm' | 'channel';

/** What the recipient keeps beside a received message. */
export interface StoredFranking {
    v: 1;
    kf_b64: string;
    /** The sender's clock (ms) the commitment was made at - from `_fk.ts`. */
    client_ts_ms: number;
    c_b64: string;
    t_b64: string;
    kid: string;
    /** The relay's time (ms) bound into t. */
    received_at_ms: number;
    context_kind: FrankContextKind;
    context_id: string;
    sender_user_id: string;
    sender_device_id: string;
    /** channel only: the channel_messages row id t is bound to. */
    message_id?: string;
}

/** The relay's `franking` object on a pulled envelope / channel row. */
export interface WireFranking { c: string; t: string; kid: string; ts: number }

/** The object a report carries (FrankedMessageDto on the API). */
export interface FrankedMessagePayload {
    kind: FrankKind;
    text?: string;
    attachment?: { attachment_id: string; filename: string; mime: string; byte_size: number; sha256_b64: string };
    klipy?: { slug: string; url: string };
    sender_user_id: string;
    sender_device_id: string;
    context_kind: FrankContextKind;
    context_id: string;
    message_id?: string;
    client_ts_ms: number;
    received_at_ms: number;
    kid: string;
    kf_b64: string;
    c_b64: string;
    t_b64: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64_32_RE = /^[A-Za-z0-9+/]{43}=$/;
const KID_RE = /^[A-Za-z0-9_-]{1,16}$/;
const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);
const isMs = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Header carrying the commitment; absent when this message is not franked. */
export const FRANKING_HEADER = 'x-franking-commitment';

// ---- bytes -----------------------------------------------------------------

const enc = new TextEncoder();

function toB64(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}
function fromB64(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
function lp(s: string): Uint8Array {
    const b = enc.encode(s);
    const out = new Uint8Array(4 + b.length);
    new DataView(out.buffer).setUint32(0, b.length, false);
    out.set(b, 4);
    return out;
}
function concat(parts: Uint8Array[]): Uint8Array {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

export interface CommitInput {
    kind: FrankKind;
    body: string;
    senderUserId: string;
    senderDeviceId: string;
    contextKind: FrankContextKind;
    contextId: string;
    clientTsMs: number;
}

/** The exact byte string the sender commits to (golden-vector tested). */
export function canonMessage(i: CommitInput): Uint8Array {
    if (!isMs(i.clientTsMs)) throw new Error('franking: bad client time');
    if (!isUuid(i.senderUserId) || !isUuid(i.senderDeviceId) || !isUuid(i.contextId)) throw new Error('franking: ids must be UUIDs');
    return concat([
        enc.encode(FRANK_MSG_MAGIC),
        lp(i.kind),
        lp(i.body),
        lp(i.senderUserId.toLowerCase()),
        lp(i.senderDeviceId.toLowerCase()),
        lp(i.contextKind),
        lp(i.contextId.toLowerCase()),
        lp(String(i.clientTsMs)),
    ]);
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
    const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, data as BufferSource));
}

export async function commit(kf: Uint8Array, i: CommitInput): Promise<Uint8Array> {
    if (kf.length !== 32) throw new Error('franking: kf must be 32 bytes');
    return hmac(kf, canonMessage(i));
}

function macEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
}

/** SHA-256 of a file's bytes, base64 - what an attachment message commits to. */
export async function sha256B64(data: ArrayBuffer | Uint8Array): Promise<string> {
    const buf = data instanceof Uint8Array ? (data as unknown as BufferSource) : data;
    return toB64(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)));
}

/** Files above this are sent without a content hash (and so are not attachment-verifiable). */
export const MAX_HASHED_FILE_BYTES = 64 * 1024 * 1024;

/** Hash a File for the attachment commitment, or undefined (too big / unreadable). Never throws. */
export async function hashFileForCommitment(file: Blob): Promise<string | undefined> {
    try {
        if (file.size > MAX_HASHED_FILE_BYTES) return undefined;
        return await sha256B64(await file.arrayBuffer());
    } catch {
        return undefined;
    }
}

// ---- what is reportable ------------------------------------------------------

interface AnyContent { type?: unknown; [k: string]: unknown }

/**
 * The kind and canonical body of a message's reportable content, or null when
 * it has none (a reaction, a call key, a pin, an empty string, an attachment
 * with no content hash...). The SAME function builds the body at send time and
 * rebuilds it at report time.
 */
export function frankBody(content: unknown): { kind: FrankKind; body: string } | null {
    if (!isObj(content)) return null;
    const c = content as AnyContent;
    switch (c.type) {
        case 'text':
        case 'edit':
            return typeof c.text === 'string' && c.text.length > 0 ? { kind: 'text', body: c.text } : null;
        case 'attachment': {
            const a = attachmentOf(c);
            return a ? { kind: 'attachment', body: attachmentBody(a) } : null;
        }
        case 'klipy_gif': {
            const g = klipyOf(c);
            return g ? { kind: 'klipy_gif', body: klipyBody(g) } : null;
        }
        default:
            return null;
    }
}

export type FrankAttachment = NonNullable<FrankedMessagePayload['attachment']>;

/** The reportable fields of an attachment message, or null when it has no content hash. */
export function attachmentOf(c: AnyContent): FrankAttachment | null {
    const sha = c.content_sha256_b64;
    if (typeof c.attachment_id !== 'string' || typeof c.filename !== 'string' || typeof c.mime !== 'string'
        || !isMs(c.byte_size) || typeof sha !== 'string' || !B64_32_RE.test(sha)) return null;
    return { attachment_id: c.attachment_id, filename: c.filename, mime: c.mime, byte_size: c.byte_size, sha256_b64: sha };
}

/** Same key order as the API's attachmentBody() - byte for byte. */
export function attachmentBody(a: FrankAttachment): string {
    return JSON.stringify({
        attachment_id: a.attachment_id,
        byte_size: a.byte_size,
        filename: a.filename,
        mime: a.mime,
        sha256_b64: a.sha256_b64,
    });
}

function klipyOf(c: AnyContent): { slug: string; url: string } | null {
    const media = c.media;
    if (typeof c.slug !== 'string' || !isObj(media) || typeof media.url !== 'string') return null;
    return { slug: c.slug, url: media.url };
}
function klipyBody(g: { slug: string; url: string }): string {
    return JSON.stringify({ slug: g.slug, url: g.url });
}

// ---- send ------------------------------------------------------------------

export interface FrankedSend {
    /** The content JSON to ENCRYPT (carries `_fk` when franked). */
    contentJson: string;
    /** The commitment to send outside the ciphertext, if franked. */
    commitment_b64?: string;
}

export interface SendContext {
    contextKind: FrankContextKind;
    /** conversation_id (dm) or channel_id (channel). */
    contextId: string;
    senderUserId: string | null | undefined;
    senderDeviceId: string | null | undefined;
}

/**
 * Prepare one outgoing message for franking. Returns the content unchanged
 * (and no commitment) for anything not reportable, for missing ids, or on any
 * error: the send always proceeds.
 */
export async function frankForSend(contentJson: string, ctx: SendContext, now: () => number = Date.now): Promise<FrankedSend> {
    try {
        if (!isUuid(ctx.senderUserId) || !isUuid(ctx.senderDeviceId) || !isUuid(ctx.contextId)) return { contentJson };
        const parsed: unknown = JSON.parse(contentJson);
        const fb = frankBody(parsed);
        if (!fb || !isObj(parsed)) return { contentJson };
        const kf = crypto.getRandomValues(new Uint8Array(32));
        const ts = now();
        const c = await commit(kf, {
            kind: fb.kind, body: fb.body, senderUserId: ctx.senderUserId, senderDeviceId: ctx.senderDeviceId,
            contextKind: ctx.contextKind, contextId: ctx.contextId, clientTsMs: ts,
        });
        // Any `_fk` already on the object (copied content) is overwritten.
        const sealed = JSON.stringify({ ...parsed, _fk: { v: FRANK_VERSION, kf: toB64(kf), ts } });
        kf.fill(0);
        return { contentJson: sealed, commitment_b64: toB64(c) };
    } catch {
        return { contentJson };
    }
}

/** Request headers for a franked send (empty when not franked). */
export function frankingHeaders(f: { commitment_b64?: string }): Record<string, string> {
    return f.commitment_b64 ? { [FRANKING_HEADER]: f.commitment_b64 } : {};
}

// ---- receive ---------------------------------------------------------------

export interface SealedFk { kf_b64: string; ts: number }

/**
 * Pull `_fk` out of a freshly decrypted content object, ALWAYS removing it (so
 * the key never reaches thread state, a quote, a forward or a backup of the
 * content) and returning it only if it is well formed.
 */
export function takeSealedFranking<T>(content: T): { content: T; fk: SealedFk | null } {
    if (!isObj(content) || !('_fk' in content)) return { content, fk: null };
    const { _fk, ...rest } = content as Record<string, unknown>;
    let fk: SealedFk | null = null;
    if (isObj(_fk) && _fk.v === FRANK_VERSION && typeof _fk.kf === 'string' && B64_32_RE.test(_fk.kf) && isMs(_fk.ts)) {
        fk = { kf_b64: _fk.kf, ts: _fk.ts };
    }
    return { content: rest as T, fk };
}

/**
 * In-place variant for the receive paths: reads `_fk` off a freshly parsed content
 * object and DELETES it from that object (which the caller owns), so the key never
 * reaches state. Same validation as {@link takeSealedFranking}.
 */
export function liftSealedFranking(content: unknown): SealedFk | null {
    if (!isObj(content) || !('_fk' in content)) return null;
    const { fk } = takeSealedFranking(content);
    delete (content as Record<string, unknown>)._fk;
    return fk;
}

export function isWireFranking(x: unknown): x is WireFranking {
    return isObj(x) && typeof x.c === 'string' && B64_32_RE.test(x.c) && typeof x.t === 'string' && B64_32_RE.test(x.t)
        && typeof x.kid === 'string' && KID_RE.test(x.kid) && isMs(x.ts);
}

/**
 * Join what the sender sealed with what the relay returned into the record that
 * is stored with the message. Undefined unless BOTH halves are present and
 * well formed - a message missing either is simply reportable as unverified.
 */
export function buildStoredFranking(args: {
    fk: SealedFk | null;
    wire: unknown;
    contextKind: FrankContextKind;
    contextId: string | null | undefined;
    senderUserId: string | null | undefined;
    senderDeviceId: string | null | undefined;
    messageId?: string | null;
}): StoredFranking | undefined {
    const { fk, wire } = args;
    if (!fk || !isWireFranking(wire)) return undefined;
    if (!isUuid(args.contextId) || !isUuid(args.senderUserId) || !isUuid(args.senderDeviceId)) return undefined;
    if (args.contextKind === 'channel' && !isUuid(args.messageId)) return undefined;
    // kf and the sender's clock come from the sender (sealed in the payload); c, t, kid and the
    // relay's time come from the relay. The report is only verifiable if the two halves agree.
    return {
        v: 1,
        kf_b64: fk.kf_b64,
        client_ts_ms: fk.ts,
        c_b64: wire.c,
        t_b64: wire.t,
        kid: wire.kid,
        received_at_ms: wire.ts,
        context_kind: args.contextKind,
        context_id: args.contextId.toLowerCase(),
        sender_user_id: args.senderUserId.toLowerCase(),
        sender_device_id: args.senderDeviceId.toLowerCase(),
        ...(args.contextKind === 'channel' ? { message_id: (args.messageId as string).toLowerCase() } : {}),
    };
}

/** Convenience: strip `_fk` and build the stored record in one step. */
export function ingestInboundFranking<T>(content: T, args: Omit<Parameters<typeof buildStoredFranking>[0], 'fk'>): { content: T; franking?: StoredFranking } {
    const { content: clean, fk } = takeSealedFranking(content);
    const franking = buildStoredFranking({ ...args, fk });
    return franking ? { content: clean, franking } : { content: clean };
}

/**
 * An EDIT replaces what a message says, so it must replace what vouches for it.
 * The edited text is covered by the EDIT's own commitment (or by none, if the
 * editor's client predates franking): carrying the original's franking over
 * would make the new text fail verification, or worse look verified.
 */
export function frankingFieldsAfterEdit(editMsg: { franking?: StoredFranking | undefined }): { franking?: StoredFranking } {
    return editMsg.franking ? { franking: editMsg.franking } : {};
}

/** Drop a stale `franking` from a message row that is being re-based on an edit. */
export function withoutFranking<T extends { franking?: unknown }>(row: T): Omit<T, 'franking'> {
    const { franking: _drop, ...rest } = row;
    void _drop;
    return rest;
}

// ---- report ----------------------------------------------------------------

/** The slice of a message row the report flow needs (the row itself is never altered). */
export interface ReportedMessageRef {
    content?: unknown;
    franking?: StoredFranking | null;
    sender_user_id?: string | null;
    /** A `blob:` URL of the decrypted attachment, when this device has loaded it. */
    attachmentUrl?: string | null;
}

export type FrankedReportResult =
    | { ok: true; franked: FrankedMessagePayload }
    | { ok: false; reason: 'no_franking' | 'no_content' | 'sender_mismatch' | 'content_changed' | 'malformed' };

/**
 * Build the franking payload for a report from a message row, checking it
 * LOCALLY first so the reporter learns up front whether it will verify:
 *  - the row has franking at all (sent by a franking client, relayed by a
 *    franking server);
 *  - the content still says what the sender committed to (not edited without a
 *    new commitment);
 *  - the franking names the same sender the row does.
 * The API repeats every check against its own secret; this is only for the UI.
 */
export async function buildFrankedReport(msg: {
    content?: unknown;
    franking?: StoredFranking | null;
    sender_user_id?: string | null;
}): Promise<FrankedReportResult> {
    const f = msg.franking;
    if (!f) return { ok: false, reason: 'no_franking' };
    const fb = frankBody(msg.content);
    if (!fb) return { ok: false, reason: 'no_content' };
    if (msg.sender_user_id && msg.sender_user_id.toLowerCase() !== f.sender_user_id) return { ok: false, reason: 'sender_mismatch' };
    try {
        const expected = await commit(fromB64(f.kf_b64), {
            kind: fb.kind, body: fb.body, senderUserId: f.sender_user_id, senderDeviceId: f.sender_device_id,
            contextKind: f.context_kind, contextId: f.context_id, clientTsMs: f.client_ts_ms,
        });
        if (!macEqual(expected, fromB64(f.c_b64))) return { ok: false, reason: 'content_changed' };
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    const c = msg.content as AnyContent;
    return {
        ok: true,
        franked: {
            kind: fb.kind,
            ...(fb.kind === 'text' ? { text: fb.body } : {}),
            ...(fb.kind === 'attachment' ? { attachment: attachmentOf(c)! } : {}),
            ...(fb.kind === 'klipy_gif' ? { klipy: klipyOf(c)! } : {}),
            sender_user_id: f.sender_user_id,
            sender_device_id: f.sender_device_id,
            context_kind: f.context_kind,
            context_id: f.context_id,
            ...(f.message_id ? { message_id: f.message_id } : {}),
            client_ts_ms: f.client_ts_ms,
            received_at_ms: f.received_at_ms,
            kid: f.kid,
            kf_b64: f.kf_b64,
            c_b64: f.c_b64,
            t_b64: f.t_b64,
        },
    };
}
