/**
 * FROZEN COPY of the v3 backupContainer, exactly as shipped before the
 * authenticated-header work (extracted from the integration base commit).
 *
 * It exists for two jobs a hand-written fixture could not do honestly:
 *
 *   1. COMPATIBILITY. backupContainer.test.ts writes real v3 vaults with this
 *      module — the actual code that produced every v3 file in the wild — and
 *      proves the current reader still opens them and returns identical
 *      content. A reimplementation "of what v3 probably did" would prove
 *      nothing: a bug in it would look like a passing compat test.
 *   2. THE ROLLBACK PROOF-OF-CONCEPT. The same test rolls a v3 vault back by
 *      patching 12 plaintext bytes with no key, against this module, and shows
 *      the v3 reader hands back the older vault. That is the vulnerability;
 *      the paired v4 test shows the same edit no longer works.
 *
 * DO NOT EDIT, and never import it from application code. The point is that
 * it is a historical artefact, not a maintained module. Exports are suffixed
 * `V3` so nothing shadows the live module by accident.
 *
 * Original header comment follows.
 */

import { deriveBackupKey } from '../crypto';

export const CONTAINER_VERSION_V3 = 3;
const MAGIC = new Uint8Array([0x43, 0x4c, 0x03]); // "CL" + version 3
export const HEADER_LEN_V3 = 36;
const PTR_OFFSET = 24;       // indexOffset u64 + indexLen u32 live here
const PTR_LEN = 12;
const IV_LEN = 12;
const FRAME_LEN_BYTES = 4;
const KDF_ITERATIONS = 600_000;
const KDF_HASH = 'SHA-512' as const;

const INDEX_AAD = 'cl3:index';
const recordAad = (id: string) => `cl3:rec:${id}`;

/** Destination for a container being written. `write` appends at the
 *  current end; `writeAt` patches bytes already written (the header pointer). */
export interface ByteSinkV3 {
    write(bytes: Uint8Array): Promise<void>;
    writeAt(offset: number, bytes: Uint8Array): Promise<void>;
}

/** Random-access source for a container being read. */
export interface ByteSourceV3 {
    size(): Promise<number>;
    read(offset: number, length: number): Promise<Uint8Array>;
}

export interface ContainerRecordRefV3 {
    id: string;
    /** Byte offset of the record's frame (its 4-byte length prefix) in the file. */
    offset: number;
    /** Total framed length: 4 + 12 + ciphertext. */
    len: number;
    /** Plaintext size in bytes — lets a restore show progress before decrypting. */
    size: number;
    /** Content hash of the plaintext (SHA-256 hex for JSON records; blobs
     *  are immutable per id and carry a fixed marker). An in-place update
     *  compares this to decide whether a record needs rewriting — no
     *  decryption involved. */
    hash: string;
}

export interface ContainerIndexV3 {
    v: number;
    userId: string;
    createdAt: string;
    /** Content fingerprint of the vault this file holds (see driveBackup.ts). */
    fingerprint: string;
    /** Incremented on every write, fresh or in-place. */
    generation: number;
    records: ContainerRecordRefV3[];
}

/** Hash marker for records whose content never changes for a given id. */
export const IMMUTABLE_HASH_V3 = 'immutable';

const enc = new TextEncoder();
const dec = new TextDecoder();

function subtle(): SubtleCrypto {
    return globalThis.crypto.subtle;
}
function randomBytes(n: number): Uint8Array {
    return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

function u32be(n: number): Uint8Array {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, n >>> 0, false);
    return out;
}
function u64be(n: number): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt(n), false);
    return out;
}
function readU32be(bytes: Uint8Array, at: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, false);
}
function readU64be(bytes: Uint8Array, at: number): number {
    return Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(at, false));
}

/** SHA-256 hex of a UTF-8 string or raw bytes. */
export async function sha256HexV3(data: string | Uint8Array): Promise<string> {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    const digest = await subtle().digest('SHA-256', bytes as BufferSource);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** True iff `head` (the first bytes of a file) starts with the v3 magic. */
export function isV3ContainerV3(head: Uint8Array): boolean {
    return head.length >= 3 && head[0] === MAGIC[0] && head[1] === MAGIC[1] && head[2] === MAGIC[2];
}

async function encryptRecord(key: CryptoKey, aad: string, plaintext: Uint8Array): Promise<Uint8Array> {
    const iv = randomBytes(IV_LEN);
    const ct = new Uint8Array(await subtle().encrypt(
        { name: 'AES-GCM', iv: iv as BufferSource, additionalData: enc.encode(aad) }, key, plaintext as BufferSource,
    ));
    const framed = new Uint8Array(FRAME_LEN_BYTES + IV_LEN + ct.length);
    framed.set(u32be(IV_LEN + ct.length), 0);
    framed.set(iv, FRAME_LEN_BYTES);
    framed.set(ct, FRAME_LEN_BYTES + IV_LEN);
    return framed;
}

async function decryptFrame(key: CryptoKey, aad: string, framed: Uint8Array): Promise<Uint8Array> {
    if (framed.length < FRAME_LEN_BYTES + IV_LEN + 16) throw new Error('Backup record is truncated');
    const declared = readU32be(framed, 0);
    if (declared !== framed.length - FRAME_LEN_BYTES) throw new Error('Backup record length mismatch');
    const iv = framed.subarray(FRAME_LEN_BYTES, FRAME_LEN_BYTES + IV_LEN);
    const ct = framed.subarray(FRAME_LEN_BYTES + IV_LEN);
    const pt = await subtle().decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource, additionalData: enc.encode(aad) }, key, ct as BufferSource,
    );
    return new Uint8Array(pt);
}

function buildHeader(salt: Uint8Array): Uint8Array {
    const header = new Uint8Array(HEADER_LEN_V3);
    header.set(MAGIC, 0);
    header[3] = 0; // flags — reserved
    header.set(salt, 4);
    header.set(u32be(KDF_ITERATIONS), 20);
    // index pointer left zero until finish()
    return header;
}

// ── Writing ─────────────────────────────────────────────────────────────────

export interface KeyMaterialV3 { key: CryptoKey; salt: Uint8Array }

export class ContainerWriterV3 {
    private offset: number;
    private readonly refs = new Map<string, ContainerRecordRefV3>();
    private finished = false;
    private readonly generation: number;
    private readonly key: CryptoKey;
    private readonly sink: ByteSinkV3;
    /** Refs from the file being updated in place; `carry` promotes them. */
    private readonly previous: Map<string, ContainerRecordRefV3>;
    /** Whether a byte range in `previous` is still referenced (for dead-space accounting). */
    private carried = 0;

    private constructor(key: CryptoKey, sink: ByteSinkV3, startOffset: number, previous: ContainerRecordRefV3[], generation: number) {
        this.key = key;
        this.sink = sink;
        this.offset = startOffset;
        this.previous = new Map(previous.map(r => [r.id, r]));
        this.generation = generation;
    }

    /** Start a fresh file: derive a key (from a fresh salt, or `salt` to
     *  share a key with another file written this run), write the header. */
    static async create(password: string, sink: ByteSinkV3, opts: { keyMaterial?: KeyMaterialV3 } = {}): Promise<ContainerWriterV3> {
        const km = opts.keyMaterial ?? await ContainerWriterV3.newKey(password);
        const w = new ContainerWriterV3(km.key, sink, 0, [], 1);
        await w.emit(buildHeader(km.salt));
        return w;
    }

    static async newKey(password: string, salt: Uint8Array = randomBytes(16)): Promise<KeyMaterialV3> {
        return { key: await deriveBackupKey(password, salt, KDF_ITERATIONS, KDF_HASH), salt };
    }

    /** Continue an existing file in place: new records go after its current
     *  end, unchanged ones are carried into the new index by `carry`. The
     *  sink must be positioned at `existing.size`. */
    static resume(existing: OpenedContainerV3, sink: ByteSinkV3): ContainerWriterV3 {
        return new ContainerWriterV3(existing.keyMaterial.key, sink, existing.size, existing.index.records, existing.index.generation + 1);
    }

    private async emit(bytes: Uint8Array): Promise<void> {
        await this.sink.write(bytes);
        this.offset += bytes.length;
    }

    /** Whether the file being updated already holds `id`, and with what hash. */
    has(id: string): boolean { return this.previous.has(id); }
    hashOf(id: string): string | undefined { return this.previous.get(id)?.hash; }

    /** Keep the existing record for `id` as-is (in-place update only). */
    carry(id: string): void {
        if (this.finished) throw new Error('Container already finished');
        const prev = this.previous.get(id);
        if (!prev) throw new Error(`No existing record "${id}" to carry`);
        if (this.refs.has(id)) throw new Error(`Duplicate backup record id "${id}"`);
        this.refs.set(id, prev);
        this.carried += prev.len;
    }

    /** Append one record. `hash` defaults to SHA-256 of the plaintext. */
    async addBytes(id: string, plaintext: Uint8Array, hash?: string): Promise<void> {
        if (this.finished) throw new Error('Container already finished');
        if (this.refs.has(id)) throw new Error(`Duplicate backup record id "${id}"`);
        const h = hash ?? await sha256HexV3(plaintext);
        const framed = await encryptRecord(this.key, recordAad(id), plaintext);
        this.refs.set(id, { id, offset: this.offset, len: framed.length, size: plaintext.length, hash: h });
        await this.emit(framed);
    }

    async addJson(id: string, value: unknown, hash?: string): Promise<void> {
        await this.addBytes(id, enc.encode(JSON.stringify(value)), hash);
    }

    /** Append the index, then flip the header pointer to it. Returns the
     *  index, the file's total size, and how much of it is now dead space. */
    async finish(meta: { userId: string; fingerprint: string }): Promise<{ index: ContainerIndexV3; bytes: number; deadBytes: number }> {
        if (this.finished) throw new Error('Container already finished');
        this.finished = true;
        const index: ContainerIndexV3 = {
            v: CONTAINER_VERSION_V3,
            userId: meta.userId,
            createdAt: new Date().toISOString(),
            fingerprint: meta.fingerprint,
            generation: this.generation,
            records: [...this.refs.values()],
        };
        const framed = await encryptRecord(this.key, INDEX_AAD, enc.encode(JSON.stringify(index)));
        const indexOffset = this.offset;
        await this.emit(framed);
        const ptr = new Uint8Array(PTR_LEN);
        ptr.set(u64be(indexOffset), 0);
        ptr.set(u32be(framed.length), 8);
        await this.sink.writeAt(PTR_OFFSET, ptr);
        const live = index.records.reduce((n, r) => n + r.len, 0);
        return { index, bytes: this.offset, deadBytes: this.offset - HEADER_LEN_V3 - live - framed.length };
    }
}

// ── Reading ─────────────────────────────────────────────────────────────────

export interface OpenedContainerV3 {
    index: ContainerIndexV3;
    /** Total file size in bytes. */
    size: number;
    /** Bytes not referenced by the live index (superseded records, old indexes). */
    deadBytes: number;
    keyMaterial: KeyMaterialV3;
    has(id: string): boolean;
    readBytes(id: string): Promise<Uint8Array>;
    readJson<T = unknown>(id: string): Promise<T>;
}

/**
 * Open a v3 container: parse the header, derive the key, decrypt the index
 * the header points at. Throws a clear error on a non-v3 file, a file whose
 * pointer is unset/out of range (never finished), or a wrong passphrase
 * (index fails AES-GCM authentication). Records decrypt lazily on demand.
 */
export async function openContainerV3(source: ByteSourceV3, password: string): Promise<OpenedContainerV3> {
    const total = await source.size();
    if (total < HEADER_LEN_V3) throw new Error('Backup file too small');

    const header = await source.read(0, HEADER_LEN_V3);
    if (!isV3ContainerV3(header)) throw new Error('Not a Cipherline v3 backup file');
    const salt = header.slice(4, 20);
    const iterations = readU32be(header, 20);
    if (iterations < 1 || iterations > 10_000_000) throw new Error('Backup header is corrupted');
    const indexOffset = readU64be(header, PTR_OFFSET);
    const indexLen = readU32be(header, PTR_OFFSET + 8);
    if (indexLen <= 0 || indexOffset < HEADER_LEN_V3 || indexOffset + indexLen > total) {
        throw new Error('Backup file is incomplete or corrupted (bad index pointer)');
    }

    const key = await deriveBackupKey(password, salt, iterations, KDF_HASH);
    let index: ContainerIndexV3;
    try {
        const raw = await decryptFrame(key, INDEX_AAD, await source.read(indexOffset, indexLen));
        index = JSON.parse(dec.decode(raw));
    } catch {
        throw new Error('Could not decrypt this backup with the given passphrase.');
    }
    if (index?.v !== CONTAINER_VERSION_V3 || !Array.isArray(index.records)) {
        throw new Error('Backup index is malformed');
    }
    if (typeof index.generation !== 'number') index.generation = 1;
    const byId = new Map(index.records.map(r => [r.id, r] as const));
    for (const r of index.records) {
        if (r.offset < HEADER_LEN_V3 || r.offset + r.len > total) throw new Error(`Backup record "${r.id}" points outside the file`);
    }
    const live = index.records.reduce((n, r) => n + r.len, 0);

    const readBytes = async (id: string): Promise<Uint8Array> => {
        const ref = byId.get(id);
        if (!ref) throw new Error(`Backup has no record "${id}"`);
        return decryptFrame(key, recordAad(id), await source.read(ref.offset, ref.len));
    };

    return {
        index,
        size: total,
        deadBytes: Math.max(0, total - HEADER_LEN_V3 - live - indexLen),
        keyMaterial: { key, salt },
        has: (id) => byId.has(id),
        readBytes,
        readJson: async <T,>(id: string) => JSON.parse(dec.decode(await readBytes(id))) as T,
    };
}

// ── Helpers shared by callers/tests ────────────────────────────────────────

/** In-memory container that is both a sink and a source — including
 *  in-place updates (append + patch) on the same buffer. */
export class MemoryContainerV3 implements ByteSinkV3, ByteSourceV3 {
    private buf: Uint8Array;
    private len: number;
    constructor(initial?: Uint8Array) {
        this.buf = initial ? initial.slice() : new Uint8Array(0);
        this.len = this.buf.length;
    }
    private ensure(n: number): void {
        if (n <= this.buf.length) return;
        const grown = new Uint8Array(Math.max(n, this.buf.length * 2, 1024));
        grown.set(this.buf.subarray(0, this.len));
        this.buf = grown;
    }
    async write(bytes: Uint8Array): Promise<void> {
        this.ensure(this.len + bytes.length);
        this.buf.set(bytes, this.len);
        this.len += bytes.length;
    }
    async writeAt(offset: number, bytes: Uint8Array): Promise<void> {
        if (offset < 0 || offset + bytes.length > this.len) throw new Error('writeAt out of range');
        this.buf.set(bytes, offset);
    }
    async size(): Promise<number> { return this.len; }
    bytes(): Uint8Array { return this.buf.slice(0, this.len); }
    async read(offset: number, length: number): Promise<Uint8Array> {
        if (offset < 0 || offset + length > this.len) throw new Error('Read out of range');
        return this.buf.slice(offset, offset + length);
    }
}

/** `ByteSourceV3` over bytes already in memory (e.g. a downloaded file). */
export function memorySourceV3(bytes: Uint8Array): ByteSourceV3 {
    return {
        size: async () => bytes.length,
        read: async (offset, length) => {
            if (offset < 0 || offset + length > bytes.length) throw new Error('Read out of range');
            return bytes.slice(offset, offset + length);
        },
    };
}

/** Fan one write out to several sinks (encrypt once, land everywhere). */
export function teeSinkV3(sinks: ByteSinkV3[]): ByteSinkV3 {
    return {
        write: async (bytes) => { for (const s of sinks) await s.write(bytes); },
        writeAt: async (offset, bytes) => { for (const s of sinks) await s.writeAt(offset, bytes); },
    };
}
