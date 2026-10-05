/**
 * backupContainer — the single-file encrypted backup format (v4; v3 still
 * readable).
 *
 * One `.enc` file holds the entire vault as a log of independently-encrypted
 * records plus an encrypted index that says which record is live and where.
 * The file is designed to be UPDATED IN PLACE: a later run appends only the
 * records whose content changed, writes a new index after them, then commits
 * by writing a pointer to it in the header. Records that didn't change are
 * neither read nor rewritten — the new index simply keeps pointing at them.
 *
 *   header   [ 'C' 'L' 0x04 ][ flags u8 ][ salt 16B ][ iterations u32 BE ]    24 bytes, plaintext
 *            [ commit slot 0: 44B ][ commit slot 1: 44B ]                     88 bytes, ENCRYPTED
 *                                                                           = 112 bytes
 *   record*  [ len u32 BE ][ IV 12B ][ AES-256-GCM ciphertext + tag ]         len = 12 + ct
 *   index    one more record (JSON `ContainerIndex`, AAD "cl4:index"),
 *            located by the live commit slot — normally the last thing in the file
 *
 * ── Why the commit slots are encrypted (the v3 rollback hole) ───────────────
 *
 * v3 stored the index pointer as 12 PLAINTEXT bytes at offset 24. An attacker
 * with write access to the backup file but no passphrase could patch those 12
 * bytes to point at any EARLIER index still sitting in the file — and because
 * an in-place update never erases superseded data, every previous generation
 * is right there. Twelve keyless bytes silently rolled the vault back to any
 * prior state. v3's per-record AAD bound a record to its id but not to a
 * generation, so a same-length record frame from an older generation could
 * also be pasted over the live one and would still authenticate.
 *
 * v4 closes both:
 *
 *   • The commit slot is an AES-GCM sealing of
 *     `[indexOffset u64][indexLen u32][generation u32]` under the file's own
 *     backup key, with the plaintext header prefix (magic+version, flags,
 *     salt, iterations) as additional data. Finding the index therefore
 *     requires the passphrase, and forging or repointing it requires forging
 *     AES-GCM. The pointer is not read before the key exists — only the salt
 *     and iteration count are, and those are exactly what the key derivation
 *     needs. Tampering with them yields a different key, which fails to open
 *     either slot: fail-closed, never a silent wrong answer.
 *
 *   • Every record's AAD binds the generation that wrote it
 *     (`cl4:rec:<gen>:<id>`), and the generation of each live record is
 *     recorded in the (authenticated) index. A frame from another generation
 *     no longer authenticates in a live record's slot, so single records —
 *     one conversation-month, say — can't be spliced back either.
 *
 *   • Every AAD is version-tagged (`cl4:…` vs v3's `cl3:…`), so a v4 file
 *     whose version byte is flipped back to 0x03 does not become a v3 file
 *     with an unauthenticated pointer: the v3 reader would look for a frame
 *     sealed under `cl3:index` and find only `cl4:index` frames. Downgrade
 *     fails closed.
 *
 * What this does NOT defend against, by construction: an attacker who can
 * replace the whole file with an older COPY of it (a Drive revision, a
 * filesystem snapshot), or who destroys the newer of the two commit slots to
 * force the file back by one generation. A single mutable file carries no
 * trusted external anchor for "how new should this be", so in-band bytes
 * cannot settle it; note that anyone able to do either of those can equally
 * just delete the backup. Closing it properly needs a generation floor
 * remembered outside the file — that now exists, in
 * `services/backupGenerationFloor.ts`: this device records the generation and
 * `createdAt` of the container it last wrote to each destination, in
 * `secureLocalStore`, and a restore that looks older than that mark WARNS.
 * It is advisory by design (a legitimate older-revision restore is the likely
 * cause, and blocking one costs real user data), and silent whenever there is
 * no mark to compare against — so nothing in THIS file's guarantees changes:
 * the format still cannot tell the difference, and must not pretend to.
 *
 * ── Two commit slots, and crash safety ─────────────────────────────────────
 *
 * New records and the new index are appended AFTER everything the old index
 * references, and the commit is written last. Generation G commits into slot
 * `G % 2`, i.e. always the slot the PREVIOUS generation did not use, so a
 * crash that tears the 44-byte commit write damages only the inactive slot
 * and the file still opens exactly as it did before the run. A reader opens
 * both slots and takes the valid one with the higher generation. (v3's
 * single 12-byte pointer leaned on sector-level write atomicity for this;
 * a 44-byte sealed slot can't, hence the pair.)
 *
 * A crash therefore cannot produce a readable-but-wrong vault, and neither
 * can tampering: every path that isn't the real, committed, current vault
 * fails AES-GCM authentication rather than returning different content.
 * Superseded and dropped records become dead space; driveBackup.ts compacts
 * (a fresh write + atomic rename) once dead space passes a threshold.
 *
 * ── Keys and compatibility ─────────────────────────────────────────────────
 *
 * The key is PBKDF2-SHA-512 over the passphrase with the header's salt (same
 * KDF as the v2 recovery format in crypto.ts) — unchanged from v3, so no
 * existing file needs rekeying; an in-place update reuses the file's existing
 * salt/key so old records stay readable, with a fresh random IV for every new
 * record and every commit.
 *
 * v3 files stay READABLE forever (`openContainer` dispatches on the version
 * byte and keeps v3's reader verbatim, unauthenticated pointer and all —
 * nothing in the wild becomes unreadable). They are not UPDATED in place,
 * because v4's header is longer and every record offset would shift: a
 * destination still holding a v3 file gets one fresh full write, which lands
 * it on v4 and authenticated from then on. Writers only ever emit v4.
 *
 * Google Drive can't do partial updates at all (`files.update` replaces the
 * whole file), so the Drive copy is always a fresh full write that's then
 * uploaded whole — see driveBackup.ts.
 *
 * Pure: no IPC, no DOM. Byte I/O goes through the `ByteSink` / `ByteSource`
 * interfaces so the same code runs against the streamed IPC file writer, a
 * Drive download, or an in-memory buffer in tests.
 */

import { deriveBackupKey } from './crypto';

/** The version every writer emits. */
export const CONTAINER_VERSION = 4;
/** Versions `openContainer` can read. */
export const READABLE_VERSIONS: readonly number[] = [3, 4];

const MAGIC_C = 0x43;
const MAGIC_L = 0x4c;

/** v3: magic+flags+salt+iterations, then a 12-byte PLAINTEXT index pointer. */
const HEADER_LEN_V3 = 36;
const PTR_OFFSET_V3 = 24;

/** Plaintext prefix shared by both versions: magic+flags+salt+iterations. */
const HEADER_PREFIX_LEN = 24;
/** One sealed commit: [IV 12][ct 16 + tag 16]. */
const COMMIT_SLOT_LEN = 44;
const COMMIT_SLOTS = 2;
/** Sealed plaintext: [indexOffset u64 BE][indexLen u32 BE][generation u32 BE]. */
const COMMIT_PLAINTEXT_LEN = 16;
/** v4 header length. Exported because callers do byte arithmetic with it. */
export const HEADER_LEN = HEADER_PREFIX_LEN + COMMIT_SLOTS * COMMIT_SLOT_LEN; // 112

const IV_LEN = 12;
const GCM_TAG_LEN = 16;
const FRAME_LEN_BYTES = 4;
const KDF_ITERATIONS = 600_000;
const KDF_HASH = 'SHA-512' as const;

const indexAad = (version: number) => `cl${version}:index`;
/** v3 bound only the record id; v4 binds the generation that wrote it too. */
const recordAad = (version: number, id: string, gen?: number) =>
    version >= 4 ? `cl${version}:rec:${gen}:${id}` : `cl${version}:rec:${id}`;

/** Destination for a container being written. `write` appends at the
 *  current end; `writeAt` patches bytes already written (a commit slot). */
export interface ByteSink {
    write(bytes: Uint8Array): Promise<void>;
    writeAt(offset: number, bytes: Uint8Array): Promise<void>;
}

/** Random-access source for a container being read. */
export interface ByteSource {
    size(): Promise<number>;
    read(offset: number, length: number): Promise<Uint8Array>;
}

export interface ContainerRecordRef {
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
    /** Generation that WROTE this frame — part of its AAD, so a reader needs
     *  it to decrypt. Carried records keep the generation they were written
     *  at, not the generation of the index carrying them. Absent in v3. */
    gen?: number;
}

export interface ContainerIndex {
    v: number;
    userId: string;
    createdAt: string;
    /** Content fingerprint of the vault this file holds (see driveBackup.ts). */
    fingerprint: string;
    /** Incremented on every write, fresh or in-place. */
    generation: number;
    records: ContainerRecordRef[];
}

/** Hash marker for records whose content never changes for a given id. */
export const IMMUTABLE_HASH = 'immutable';

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
function readU32be(bytes: Uint8Array, at: number): number {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, false);
}
function readU64be(bytes: Uint8Array, at: number): number {
    return Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(at, false));
}
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

/** SHA-256 hex of a UTF-8 string or raw bytes. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    const digest = await subtle().digest('SHA-256', bytes as BufferSource);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Container version from the first bytes of a file, or 0 if it isn't one. */
export function containerVersion(head: Uint8Array): number {
    if (head.length < 3 || head[0] !== MAGIC_C || head[1] !== MAGIC_L) return 0;
    return READABLE_VERSIONS.includes(head[2]) ? head[2] : 0;
}

/** True iff `head` (the first bytes of a file) starts with a container magic
 *  this module can read — v3 or v4. Callers use it to tell a single-file
 *  backup from the legacy v2/chunked layouts. */
export function isContainerFile(head: Uint8Array): boolean {
    return containerVersion(head) !== 0;
}

function headerLenFor(version: number): number {
    return version >= 4 ? HEADER_LEN : HEADER_LEN_V3;
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
    if (framed.length < FRAME_LEN_BYTES + IV_LEN + GCM_TAG_LEN) throw new Error('Backup record is truncated');
    const declared = readU32be(framed, 0);
    if (declared !== framed.length - FRAME_LEN_BYTES) throw new Error('Backup record length mismatch');
    const iv = framed.subarray(FRAME_LEN_BYTES, FRAME_LEN_BYTES + IV_LEN);
    const ct = framed.subarray(FRAME_LEN_BYTES + IV_LEN);
    const pt = await subtle().decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource, additionalData: enc.encode(aad) }, key, ct as BufferSource,
    );
    return new Uint8Array(pt);
}

// ── The commit slot (v4) ────────────────────────────────────────────────────

interface Commit { indexOffset: number; indexLen: number; generation: number }

const commitSlotOffset = (slot: number) => HEADER_PREFIX_LEN + slot * COMMIT_SLOT_LEN;
/** The generation that wrote a commit picks its slot, so consecutive
 *  generations never write the same one. */
const slotForGeneration = (generation: number) => generation % COMMIT_SLOTS;

/** AAD for a commit: the slot it lives in, plus the whole plaintext header
 *  prefix (magic+version, flags, salt, iterations) so those bytes are
 *  authenticated rather than merely load-bearing for key derivation. */
function commitAad(slot: number, headerPrefix: Uint8Array): Uint8Array {
    return concatBytes(enc.encode(`cl${CONTAINER_VERSION}:commit:${slot}:`), headerPrefix);
}

async function sealCommit(key: CryptoKey, slot: number, headerPrefix: Uint8Array, c: Commit): Promise<Uint8Array> {
    const pt = new Uint8Array(COMMIT_PLAINTEXT_LEN);
    const dv = new DataView(pt.buffer);
    dv.setBigUint64(0, BigInt(c.indexOffset), false);
    dv.setUint32(8, c.indexLen >>> 0, false);
    dv.setUint32(12, c.generation >>> 0, false);
    const iv = randomBytes(IV_LEN);
    const ct = new Uint8Array(await subtle().encrypt(
        { name: 'AES-GCM', iv: iv as BufferSource, additionalData: commitAad(slot, headerPrefix) as BufferSource },
        key, pt as BufferSource,
    ));
    const out = new Uint8Array(COMMIT_SLOT_LEN);
    out.set(iv, 0);
    out.set(ct, IV_LEN);
    return out;
}

/** Decrypt one commit slot. Returns null when the slot was never written
 *  (all zero), or fails authentication — a torn write, a tampered pointer,
 *  or the wrong passphrase. Callers can't tell those apart and must not try. */
async function openCommitSlot(key: CryptoKey, slot: number, headerPrefix: Uint8Array, bytes: Uint8Array): Promise<Commit | null> {
    if (bytes.length !== COMMIT_SLOT_LEN || bytes.every(b => b === 0)) return null;
    try {
        const pt = new Uint8Array(await subtle().decrypt(
            {
                name: 'AES-GCM',
                iv: bytes.subarray(0, IV_LEN) as BufferSource,
                additionalData: commitAad(slot, headerPrefix) as BufferSource,
            },
            key, bytes.subarray(IV_LEN) as BufferSource,
        ));
        if (pt.length !== COMMIT_PLAINTEXT_LEN) return null;
        const dv = new DataView(pt.buffer, pt.byteOffset, pt.byteLength);
        return {
            indexOffset: Number(dv.getBigUint64(0, false)),
            indexLen: dv.getUint32(8, false),
            generation: dv.getUint32(12, false),
        };
    } catch {
        return null;
    }
}

function buildHeader(salt: Uint8Array): Uint8Array {
    const header = new Uint8Array(HEADER_LEN);
    header[0] = MAGIC_C;
    header[1] = MAGIC_L;
    header[2] = CONTAINER_VERSION;
    header[3] = 0; // flags — reserved
    header.set(salt, 4);
    header.set(u32be(KDF_ITERATIONS), 20);
    // Both commit slots stay zero until finish() seals one.
    return header;
}

// ── Writing ─────────────────────────────────────────────────────────────────

export interface KeyMaterial { key: CryptoKey; salt: Uint8Array }

export class ContainerWriter {
    private offset: number;
    private readonly refs = new Map<string, ContainerRecordRef>();
    private finished = false;
    private readonly generation: number;
    private readonly key: CryptoKey;
    private readonly sink: ByteSink;
    /** The file's plaintext header prefix — AAD for this run's commit. */
    private readonly headerPrefix: Uint8Array;
    /** Refs from the file being updated in place; `carry` promotes them. */
    private readonly previous: Map<string, ContainerRecordRef>;
    /** Whether a byte range in `previous` is still referenced (for dead-space accounting). */
    private carried = 0;

    private constructor(
        key: CryptoKey, sink: ByteSink, startOffset: number,
        previous: ContainerRecordRef[], generation: number, headerPrefix: Uint8Array,
    ) {
        this.key = key;
        this.sink = sink;
        this.offset = startOffset;
        this.previous = new Map(previous.map(r => [r.id, r]));
        this.generation = generation;
        this.headerPrefix = headerPrefix;
    }

    /** Start a fresh file: derive a key (from a fresh salt, or `salt` to
     *  share a key with another file written this run), write the header. */
    static async create(password: string, sink: ByteSink, opts: { keyMaterial?: KeyMaterial } = {}): Promise<ContainerWriter> {
        const km = opts.keyMaterial ?? await ContainerWriter.newKey(password);
        const header = buildHeader(km.salt);
        const w = new ContainerWriter(km.key, sink, 0, [], 1, header.slice(0, HEADER_PREFIX_LEN));
        await w.emit(header);
        return w;
    }

    static async newKey(password: string, salt: Uint8Array = randomBytes(16)): Promise<KeyMaterial> {
        return { key: await deriveBackupKey(password, salt, KDF_ITERATIONS, KDF_HASH), salt };
    }

    /** Continue an existing file in place: new records go after its current
     *  end, unchanged ones are carried into the new index by `carry`. The
     *  sink must be positioned at `existing.size`.
     *
     *  Only a v4 file can be resumed — v3's header is 76 bytes shorter, so
     *  upgrading it in place would shift every record offset. The caller
     *  writes a fresh file instead, which lands the destination on v4. */
    static resume(existing: OpenedContainer, sink: ByteSink): ContainerWriter {
        if (existing.version !== CONTAINER_VERSION) {
            throw new Error(`Cannot update a v${existing.version} backup in place; write a fresh file instead`);
        }
        return new ContainerWriter(
            existing.keyMaterial.key, sink, existing.size, existing.index.records,
            existing.index.generation + 1, existing.headerPrefix,
        );
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
        if (typeof prev.gen !== 'number') throw new Error(`Existing record "${id}" has no generation to carry`);
        this.refs.set(id, prev);
        this.carried += prev.len;
    }

    /** Append one record. `hash` defaults to SHA-256 of the plaintext. */
    async addBytes(id: string, plaintext: Uint8Array, hash?: string): Promise<void> {
        if (this.finished) throw new Error('Container already finished');
        if (this.refs.has(id)) throw new Error(`Duplicate backup record id "${id}"`);
        const h = hash ?? await sha256Hex(plaintext);
        const framed = await encryptRecord(this.key, recordAad(CONTAINER_VERSION, id, this.generation), plaintext);
        this.refs.set(id, { id, offset: this.offset, len: framed.length, size: plaintext.length, hash: h, gen: this.generation });
        await this.emit(framed);
    }

    async addJson(id: string, value: unknown, hash?: string): Promise<void> {
        await this.addBytes(id, enc.encode(JSON.stringify(value)), hash);
    }

    /** Append the index, then seal a commit pointing at it into this
     *  generation's slot. Returns the index, the file's total size, and how
     *  much of it is now dead space. */
    async finish(meta: { userId: string; fingerprint: string }): Promise<{ index: ContainerIndex; bytes: number; deadBytes: number }> {
        if (this.finished) throw new Error('Container already finished');
        this.finished = true;
        const index: ContainerIndex = {
            v: CONTAINER_VERSION,
            userId: meta.userId,
            createdAt: new Date().toISOString(),
            fingerprint: meta.fingerprint,
            generation: this.generation,
            records: [...this.refs.values()],
        };
        const framed = await encryptRecord(this.key, indexAad(CONTAINER_VERSION), enc.encode(JSON.stringify(index)));
        const indexOffset = this.offset;
        await this.emit(framed);

        // Commit last, into the slot the previous generation didn't use: a
        // torn write here can only damage the inactive slot, leaving the
        // file exactly as openable as it was before this run.
        const slot = slotForGeneration(this.generation);
        const sealed = await sealCommit(this.key, slot, this.headerPrefix, {
            indexOffset, indexLen: framed.length, generation: this.generation,
        });
        await this.sink.writeAt(commitSlotOffset(slot), sealed);

        const live = index.records.reduce((n, r) => n + r.len, 0);
        return { index, bytes: this.offset, deadBytes: this.offset - HEADER_LEN - live - framed.length };
    }
}

// ── Reading ─────────────────────────────────────────────────────────────────

export interface OpenedContainer {
    index: ContainerIndex;
    /** On-disk format version: 4 for files this build writes, 3 for older
     *  ones (readable, but not updatable in place). */
    version: number;
    /** Total file size in bytes. */
    size: number;
    /** Bytes not referenced by the live index (superseded records, old indexes). */
    deadBytes: number;
    keyMaterial: KeyMaterial;
    /** The file's plaintext header prefix, needed to seal a further commit. */
    headerPrefix: Uint8Array;
    has(id: string): boolean;
    readBytes(id: string): Promise<Uint8Array>;
    readJson<T = unknown>(id: string): Promise<T>;
}

/**
 * Open a container: parse the header, derive the key, locate and decrypt the
 * live index, and expose records for lazy decryption on demand.
 *
 * v4 finds the index through the sealed commit slots — the pointer is
 * authenticated, so a rolled-back or repointed file fails to open instead of
 * quietly restoring older content. v3 is read exactly as it always was
 * (plaintext pointer included) so no existing backup becomes unreadable;
 * v3 files are upgraded by the next fresh write, not by this function.
 *
 * Throws a clear error on a file that is not a container, one that was never
 * finished or whose pointer is out of range, and one that can't be decrypted
 * with the given passphrase.
 */
export async function openContainer(source: ByteSource, password: string): Promise<OpenedContainer> {
    const total = await source.size();
    if (total < HEADER_PREFIX_LEN) throw new Error('Backup file too small');

    const probe = await source.read(0, Math.min(total, HEADER_LEN));
    const version = containerVersion(probe);
    if (version === 0) throw new Error('Not a Cipherline backup container file');
    const headerLen = headerLenFor(version);
    if (total < headerLen) throw new Error('Backup file too small');

    const header = probe.length >= headerLen ? probe.subarray(0, headerLen) : await source.read(0, headerLen);
    const salt = header.slice(4, 20);
    const iterations = readU32be(header, 20);
    if (iterations < 1 || iterations > 10_000_000) throw new Error('Backup header is corrupted');

    const key = await deriveBackupKey(password, salt, iterations, KDF_HASH);
    const headerPrefix = header.slice(0, HEADER_PREFIX_LEN);

    const { indexOffset, indexLen } = version >= 4
        ? await readCommit(key, header, headerPrefix)
        : readV3Pointer(header);
    if (indexLen <= 0 || indexOffset < headerLen || indexOffset + indexLen > total) {
        throw new Error('Backup file is incomplete or corrupted (bad index pointer)');
    }

    let index: ContainerIndex;
    try {
        const raw = await decryptFrame(key, indexAad(version), await source.read(indexOffset, indexLen));
        index = JSON.parse(dec.decode(raw));
    } catch {
        throw new Error('Could not decrypt this backup with the given passphrase.');
    }
    if (index?.v !== version || !Array.isArray(index.records)) {
        throw new Error('Backup index is malformed');
    }
    if (typeof index.generation !== 'number') index.generation = 1;
    const byId = new Map(index.records.map(r => [r.id, r] as const));
    for (const r of index.records) {
        if (r.offset < headerLen || r.offset + r.len > total) throw new Error(`Backup record "${r.id}" points outside the file`);
        // v4 needs the writing generation to rebuild the record's AAD; a v4
        // index that doesn't carry one can't be read, and must not silently
        // fall back to v3's generation-free AAD.
        if (version >= 4 && typeof r.gen !== 'number') throw new Error(`Backup record "${r.id}" has no generation`);
    }
    const live = index.records.reduce((n, r) => n + r.len, 0);

    const readBytes = async (id: string): Promise<Uint8Array> => {
        const ref = byId.get(id);
        if (!ref) throw new Error(`Backup has no record "${id}"`);
        return decryptFrame(key, recordAad(version, id, ref.gen), await source.read(ref.offset, ref.len));
    };

    return {
        index,
        version,
        size: total,
        deadBytes: Math.max(0, total - headerLen - live - indexLen),
        keyMaterial: { key, salt },
        headerPrefix,
        has: (id) => byId.has(id),
        readBytes,
        readJson: async <T,>(id: string) => JSON.parse(dec.decode(await readBytes(id))) as T,
    };
}

/** v4: open both commit slots and take the valid one with the higher
 *  generation. Neither opening means either the passphrase is wrong, the
 *  file was never committed, or the header was tampered with — all of which
 *  must fail rather than fall back to scanning for an index. */
async function readCommit(key: CryptoKey, header: Uint8Array, headerPrefix: Uint8Array): Promise<Commit> {
    const slots = await Promise.all(
        Array.from({ length: COMMIT_SLOTS }, (_, slot) => openCommitSlot(
            key, slot, headerPrefix,
            header.slice(commitSlotOffset(slot), commitSlotOffset(slot) + COMMIT_SLOT_LEN),
        )),
    );
    const live = slots.filter((c): c is Commit => c !== null).sort((a, b) => b.generation - a.generation)[0];
    if (!live) {
        const blank = header
            .subarray(commitSlotOffset(0), commitSlotOffset(0) + COMMIT_SLOTS * COMMIT_SLOT_LEN)
            .every(b => b === 0);
        throw new Error(blank
            ? 'Backup file is incomplete or corrupted (bad index pointer)'
            : 'Could not decrypt this backup with the given passphrase.');
    }
    return live;
}

/** v3: the pointer is plaintext and unauthenticated. Kept exactly as it was
 *  so files written before v4 still open; this is the hole v4 closes. */
function readV3Pointer(header: Uint8Array): Commit {
    return {
        indexOffset: readU64be(header, PTR_OFFSET_V3),
        indexLen: readU32be(header, PTR_OFFSET_V3 + 8),
        generation: 0,
    };
}

// ── Helpers shared by callers/tests ────────────────────────────────────────

/** In-memory container that is both a sink and a source — including
 *  in-place updates (append + patch) on the same buffer. */
export class MemoryContainer implements ByteSink, ByteSource {
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

/** `ByteSource` over bytes already in memory (e.g. a downloaded file). */
export function memorySource(bytes: Uint8Array): ByteSource {
    return {
        size: async () => bytes.length,
        read: async (offset, length) => {
            if (offset < 0 || offset + length > bytes.length) throw new Error('Read out of range');
            return bytes.slice(offset, offset + length);
        },
    };
}

/** Fan one write out to several sinks (encrypt once, land everywhere). */
export function teeSink(sinks: ByteSink[]): ByteSink {
    return {
        write: async (bytes) => { for (const s of sinks) await s.write(bytes); },
        writeAt: async (offset, bytes) => { for (const s of sinks) await s.writeAt(offset, bytes); },
    };
}
