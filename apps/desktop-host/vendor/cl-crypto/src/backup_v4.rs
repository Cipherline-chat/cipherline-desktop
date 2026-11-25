//! The v4 backup container — desktop `src/utils/backupContainer.ts` (what desktop WRITES today;
//! v3, in [`crate::backup_container`], stays readable). Plus [`open_any`], one reader over both.
//!
//! ```text
//! header (112 B)  "CL" 0x04 ‖ flags(1) ‖ salt(16) ‖ PBKDF2 iterations u32BE      (24 B plaintext prefix)
//!                 ‖ commit slot 0 (44 B) ‖ commit slot 1 (44 B)
//! commit slot     IV(12) ‖ AES-256-GCM(indexOffset u64 ‖ indexLen u32 ‖ generation u32) + tag(16)
//!                 AAD = "cl4:commit:<slot>:" ‖ header prefix; generation G writes slot G % 2
//! record          frameLen u32BE ‖ IV(12) ‖ ct ‖ tag, AAD "cl4:rec:<gen>:<id>" (gen = the generation that WROTE it)
//! index           a record with AAD "cl4:index": JSON {v:4, userId, createdAt, fingerprint, generation,
//!                 records:[{id, offset, len, size, hash, gen}]}
//! ```
//! The commit slots are sealed, so the index pointer cannot be repointed without the passphrase;
//! a crash while writing a commit can only damage the slot the previous generation did not use.
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::backup_container::{
    open_container, sha256_hex, ByteSink, ByteSource, ContainerError, KeyMaterial, OpenedContainer, IMMUTABLE_HASH,
};
use crate::blob::{self, IV_LEN, SALT_LEN, TAG_LEN};
use crate::kdf::{backup_key_sha512, BackupKdf};

pub const V4: u8 = 4;
pub const HEADER_LEN_V4: u64 = 112;
const PREFIX_LEN: usize = 24;
const SLOT_LEN: usize = 44;
const FRAME_LEN_BYTES: usize = 4;
const MAX_ITERATIONS: u32 = 10_000_000;

fn fmt(m: impl Into<String>) -> ContainerError {
    ContainerError::Format(m.into())
}

fn rec_aad(gen: u64, id: &str) -> Vec<u8> {
    format!("cl4:rec:{gen}:{id}").into_bytes()
}

fn commit_aad(slot: usize, prefix: &[u8]) -> Vec<u8> {
    let mut a = format!("cl4:commit:{slot}:").into_bytes();
    a.extend_from_slice(prefix);
    a
}

/// Header flag bit 0: the container key is a RAW 32-byte key (no key derivation). Only the device-to-device transfer writes it.
pub const FLAG_RAW_KEY: u8 = 0x01;
/// Frame overhead: length(4) + IV(12) + tag(16).
pub const FRAME_OVERHEAD: u64 = (FRAME_LEN_BYTES + IV_LEN + TAG_LEN) as u64;

/// The sender-local IV rule of the transfer profile: `HMAC-SHA256(key, "cl4:xfer:iv:" || aad)[0..12]`. Readers take the IV from the frame,
/// so this is not interop-critical; it lets a sender hash a frame now and rebuild the identical bytes later without storing them.
/// Safe because one raw key seals exactly one plaintext per AAD (a record id is written once; the index and commit slots once).
pub fn xfer_iv(key: &[u8; 32], aad: &[u8]) -> [u8; IV_LEN] {
    use hmac::{Hmac, Mac};
    let mut m = <Hmac<sha2::Sha256> as Mac>::new_from_slice(key).expect("hmac takes any key length");
    m.update(b"cl4:xfer:iv:");
    m.update(aad);
    let d = m.finalize().into_bytes();
    d[..IV_LEN].try_into().expect("12 bytes")
}

fn frame_with(key: &[u8; 32], aad: &[u8], plaintext: &[u8], det: Option<()>) -> Vec<u8> {
    let iv = if det.is_some() { xfer_iv(key, aad) } else { blob::generate_iv() };
    let ct = blob::seal_aad(key, &iv, plaintext, aad).expect("a 32-byte key always seals");
    let mut out = Vec::with_capacity(FRAME_LEN_BYTES + IV_LEN + ct.len());
    out.extend_from_slice(&((IV_LEN + ct.len()) as u32).to_be_bytes());
    out.extend_from_slice(&iv);
    out.extend_from_slice(&ct);
    out
}

fn unframe(key: &[u8; 32], aad: &[u8], framed: &[u8]) -> Result<Zeroizing<Vec<u8>>, ContainerError> {
    if framed.len() < FRAME_LEN_BYTES + IV_LEN + TAG_LEN {
        return Err(fmt("Backup record is truncated"));
    }
    let declared = u32::from_be_bytes(framed[..4].try_into().expect("4 bytes")) as usize;
    if declared != framed.len() - FRAME_LEN_BYTES {
        return Err(fmt("Backup record length mismatch"));
    }
    blob::open_aad(key, &framed[4..4 + IV_LEN], &framed[4 + IV_LEN..], aad).map_err(|_| ContainerError::AuthFailed)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordRefV4 {
    pub id: String,
    pub offset: u64,
    pub len: u64,
    pub size: u64,
    pub hash: String,
    #[serde(default)]
    pub gen: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexV4 {
    pub v: u32,
    pub user_id: String,
    pub created_at: String,
    pub fingerprint: String,
    #[serde(default)]
    pub generation: u64,
    pub records: Vec<RecordRefV4>,
}

#[derive(Clone, Copy)]
struct Commit {
    index_offset: u64,
    index_len: u64,
    generation: u64,
}

fn seal_commit_with(key: &[u8; 32], slot: usize, prefix: &[u8], c: Commit, det: Option<()>) -> [u8; SLOT_LEN] {
    let mut pt = [0u8; 16];
    pt[..8].copy_from_slice(&c.index_offset.to_be_bytes());
    pt[8..12].copy_from_slice(&(c.index_len as u32).to_be_bytes());
    pt[12..].copy_from_slice(&(c.generation as u32).to_be_bytes());
    let aad = commit_aad(slot, prefix);
    let iv = if det.is_some() { xfer_iv(key, &aad) } else { blob::generate_iv() };
    let ct = blob::seal_aad(key, &iv, &pt, &aad).expect("a 32-byte key always seals");
    let mut out = [0u8; SLOT_LEN];
    out[..IV_LEN].copy_from_slice(&iv);
    out[IV_LEN..].copy_from_slice(&ct);
    out
}

fn open_commit(key: &[u8; 32], slot: usize, prefix: &[u8], bytes: &[u8]) -> Option<Commit> {
    if bytes.len() != SLOT_LEN || bytes.iter().all(|b| *b == 0) {
        return None;
    }
    let pt = blob::open_aad(key, &bytes[..IV_LEN], &bytes[IV_LEN..], &commit_aad(slot, prefix)).ok()?;
    if pt.len() != 16 {
        return None;
    }
    Some(Commit {
        index_offset: u64::from_be_bytes(pt[..8].try_into().ok()?),
        index_len: u64::from(u32::from_be_bytes(pt[8..12].try_into().ok()?)),
        generation: u64::from(u32::from_be_bytes(pt[12..16].try_into().ok()?)),
    })
}

pub struct WriterV4<'s, S: ByteSink> {
    sink: &'s mut S,
    key: KeyMaterial,
    prefix: [u8; PREFIX_LEN],
    offset: u64,
    generation: u64,
    previous: Vec<RecordRefV4>,
    refs: Vec<RecordRefV4>,
    /// Transfer profile: IVs come from [`xfer_iv`] so the output is reproducible (see there).
    det: Option<()>,
}

impl<'s, S: ByteSink> WriterV4<'s, S> {
    /// A brand-new v4 file (generation 1). Reusing `key` shares one derived key (and salt).
    pub fn create(sink: &'s mut S, key: KeyMaterial) -> Result<Self, ContainerError> {
        let mut header = [0u8; HEADER_LEN_V4 as usize];
        header[..3].copy_from_slice(&[0x43, 0x4c, V4]);
        header[4..20].copy_from_slice(&key.salt);
        header[20..24].copy_from_slice(&BackupKdf::V2Sha512.iterations().to_be_bytes());
        let prefix: [u8; PREFIX_LEN] = header[..PREFIX_LEN].try_into().expect("24 bytes");
        sink.write(&header)?;
        Ok(Self { sink, key, prefix, offset: HEADER_LEN_V4, generation: 1, previous: vec![], refs: vec![], det: None })
    }

    /// A brand-new TRANSFER container (generation 1): the key is a raw 32-byte key used as is (no derivation), header flag
    /// [`FLAG_RAW_KEY`], iterations field 1, deterministic IVs. Passphrase backups are unaffected.
    pub fn create_raw(sink: &'s mut S, key: &[u8; 32], salt: [u8; SALT_LEN]) -> Result<Self, ContainerError> {
        let header = raw_header_prefix(&salt);
        let prefix: [u8; PREFIX_LEN] = header[..PREFIX_LEN].try_into().expect("24 bytes");
        sink.write(&header)?;
        Ok(Self { sink, key: KeyMaterial::from_raw(*key, salt), prefix, offset: HEADER_LEN_V4, generation: 1, previous: vec![], refs: vec![], det: Some(()) })
    }

    /// Continue an existing v4 file in place. A v3 file cannot be resumed (its header is shorter).
    pub fn resume(sink: &'s mut S, existing: &OpenedV4) -> Self {
        Self {
            sink,
            key: existing.key_material.clone(),
            prefix: existing.prefix,
            offset: existing.size,
            generation: existing.index.generation + 1,
            previous: existing.index.records.clone(),
            refs: vec![],
            // never reuse a deterministic IV on a second generation: a resumed raw container seals with random IVs
            det: None,
        }
    }

    pub fn previous_hash(&self, id: &str) -> Option<&str> {
        self.previous.iter().find(|r| r.id == id).map(|r| r.hash.as_str())
    }

    fn assert_new(&self, id: &str) -> Result<(), ContainerError> {
        if self.refs.iter().any(|r| r.id == id) {
            return Err(ContainerError::InvalidInput(format!("Duplicate backup record id \"{id}\"")));
        }
        Ok(())
    }

    pub fn carry(&mut self, id: &str) -> Result<(), ContainerError> {
        let prev = self.previous.iter().find(|r| r.id == id).cloned().ok_or_else(|| fmt(format!("No existing record \"{id}\" to carry")))?;
        self.assert_new(id)?;
        if prev.gen.is_none() {
            return Err(fmt(format!("Existing record \"{id}\" has no generation to carry")));
        }
        self.refs.push(prev);
        Ok(())
    }

    pub fn add_bytes(&mut self, id: &str, plaintext: &[u8], hash: Option<&str>) -> Result<(), ContainerError> {
        self.assert_new(id)?;
        let framed = frame_with(&self.key.key, &rec_aad(self.generation, id), plaintext, self.det);
        self.refs.push(RecordRefV4 {
            id: id.to_owned(),
            offset: self.offset,
            len: framed.len() as u64,
            size: plaintext.len() as u64,
            hash: hash.map_or_else(|| sha256_hex(plaintext), str::to_owned),
            gen: Some(self.generation),
        });
        self.sink.write(&framed)?;
        self.offset += framed.len() as u64;
        Ok(())
    }

    /// Append the index, then seal a commit pointing at it into this generation's slot.
    pub fn finish(self, user_id: &str, fingerprint: &str, created_at: &str) -> Result<FinishedV4, ContainerError> {
        let index = IndexV4 {
            v: u32::from(V4),
            user_id: user_id.to_owned(),
            created_at: created_at.to_owned(),
            fingerprint: fingerprint.to_owned(),
            generation: self.generation,
            records: self.refs,
        };
        let json = serde_json::to_vec(&index).map_err(|e| ContainerError::InvalidInput(e.to_string()))?;
        let framed = frame_with(&self.key.key, b"cl4:index", &json, self.det);
        let index_offset = self.offset;
        self.sink.write(&framed)?;
        let slot = (self.generation % 2) as usize;
        let sealed = seal_commit_with(&self.key.key, slot, &self.prefix, Commit { index_offset, index_len: framed.len() as u64, generation: self.generation }, self.det);
        self.sink.write_at(PREFIX_LEN as u64 + (slot * SLOT_LEN) as u64, &sealed)?;
        let total = index_offset + framed.len() as u64;
        let live: u64 = index.records.iter().map(|r| r.len).sum();
        Ok(FinishedV4 { dead_bytes: total - HEADER_LEN_V4 - live - framed.len() as u64, bytes: total, index })
    }
}

#[derive(Clone, Debug)]
pub struct FinishedV4 {
    pub index: IndexV4,
    pub bytes: u64,
    pub dead_bytes: u64,
}

#[derive(Clone)]
pub struct OpenedV4 {
    pub index: IndexV4,
    pub size: u64,
    pub dead_bytes: u64,
    pub key_material: KeyMaterial,
    prefix: [u8; PREFIX_LEN],
}

fn read_verified<R: ByteSource + ?Sized>(
    source: &R,
    key: &[u8; 32],
    id: &str,
    offset: u64,
    len: u64,
    hash: &str,
    aad: &[u8],
) -> Result<Zeroizing<Vec<u8>>, ContainerError> {
    let framed = source.read(offset, len as usize)?;
    let plain = unframe(key, aad, &framed)?;
    // The sealed index declares each record's hash; a frame spliced in from an older revision
    // still decrypts under the same key, so the hash is what pins THIS revision.
    let sha = hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if sha && sha256_hex(&plain) != hash {
        return Err(fmt(format!("Backup record \"{id}\" does not match its index (the file was modified)")));
    }
    Ok(plain)
}

impl OpenedV4 {
    pub fn read_bytes<R: ByteSource + ?Sized>(&self, source: &R, id: &str) -> Result<Zeroizing<Vec<u8>>, ContainerError> {
        let r = self.index.records.iter().find(|r| r.id == id).ok_or_else(|| fmt(format!("Backup has no record \"{id}\"")))?;
        let gen = r.gen.ok_or_else(|| fmt(format!("Backup record \"{id}\" has no generation")))?;
        read_verified(source, &self.key_material.key, id, r.offset, r.len, &r.hash, &rec_aad(gen, id))
    }
}

fn raw_header_prefix(salt: &[u8; SALT_LEN]) -> [u8; HEADER_LEN_V4 as usize] {
    let mut header = [0u8; HEADER_LEN_V4 as usize];
    header[..3].copy_from_slice(&[0x43, 0x4c, V4]);
    header[3] = FLAG_RAW_KEY;
    header[4..20].copy_from_slice(salt);
    header[20..24].copy_from_slice(&1u32.to_be_bytes());
    header
}

/// Open a v4 BACKUP with its passphrase. A transfer container (header flag [`FLAG_RAW_KEY`]) is refused cleanly with
/// [`ContainerError::TransferContainer`]: it has no passphrase and is never a backup file.
pub fn open_v4<R: ByteSource + ?Sized>(source: &R, password: &str, key_material: Option<&KeyMaterial>) -> Result<OpenedV4, ContainerError> {
    let total = source.size()?;
    if total < HEADER_LEN_V4 {
        return Err(fmt("Backup file too small"));
    }
    let header = source.read(0, HEADER_LEN_V4 as usize)?;
    if header[..3] != [0x43, 0x4c, V4] {
        return Err(fmt("Not a Cipherline v4 backup file"));
    }
    if header[3] & FLAG_RAW_KEY != 0 {
        return Err(ContainerError::TransferContainer);
    }
    let salt: [u8; SALT_LEN] = header[4..20].try_into().expect("16 bytes");
    let iterations = u32::from_be_bytes(header[20..24].try_into().expect("4 bytes"));
    if !(1..=MAX_ITERATIONS).contains(&iterations) {
        return Err(fmt("Backup header is corrupted"));
    }
    let key = match key_material {
        Some(km) if km.salt == salt => km.key.clone(),
        _ => backup_key_sha512(password, &salt, iterations),
    };
    open_with_key(source, &header, total, key, salt)
}

/// Open a v4 TRANSFER container with the raw 32-byte container key (`K_xfer`): the key-derivation step is skipped, the salt
/// is whatever the header carries. Refuses a container whose header does not carry [`FLAG_RAW_KEY`] (a passphrase backup).
pub fn open_v4_raw<R: ByteSource + ?Sized>(source: &R, key: &[u8; 32]) -> Result<OpenedV4, ContainerError> {
    let total = source.size()?;
    if total < HEADER_LEN_V4 {
        return Err(fmt("Transfer container too small"));
    }
    let header = source.read(0, HEADER_LEN_V4 as usize)?;
    if header[..3] != [0x43, 0x4c, V4] || header[3] & FLAG_RAW_KEY == 0 {
        return Err(fmt("Not a Cipherline transfer container"));
    }
    let salt: [u8; SALT_LEN] = header[4..20].try_into().expect("16 bytes");
    let km = KeyMaterial::from_raw(*key, salt);
    open_with_key(source, &header, total, km.key.clone(), salt)
}

fn open_with_key<R: ByteSource + ?Sized>(source: &R, header: &[u8], total: u64, key: Zeroizing<[u8; 32]>, salt: [u8; SALT_LEN]) -> Result<OpenedV4, ContainerError> {
    let prefix: [u8; PREFIX_LEN] = header[..PREFIX_LEN].try_into().expect("24 bytes");
    let commits: Vec<Commit> = (0..2)
        .filter_map(|slot| open_commit(&key, slot, &prefix, &header[PREFIX_LEN + slot * SLOT_LEN..PREFIX_LEN + (slot + 1) * SLOT_LEN]))
        .collect();
    let live = commits.iter().max_by_key(|c| c.generation).copied();
    let Some(commit) = live else {
        // Both slots unreadable: never committed (all zero) or the passphrase is wrong / header tampered.
        return if header[PREFIX_LEN..].iter().all(|b| *b == 0) {
            Err(fmt("Backup file is incomplete or corrupted (bad index pointer)"))
        } else {
            Err(ContainerError::AuthFailed)
        };
    };
    if commit.index_len == 0 || commit.index_offset < HEADER_LEN_V4 || commit.index_offset.saturating_add(commit.index_len) > total {
        return Err(fmt("Backup file is incomplete or corrupted (bad index pointer)"));
    }
    let framed = source.read(commit.index_offset, commit.index_len as usize)?;
    let raw = unframe(&key, b"cl4:index", &framed).map_err(|_| ContainerError::AuthFailed)?;
    let mut index: IndexV4 = serde_json::from_slice(&raw).map_err(|_| ContainerError::AuthFailed)?;
    if index.v != u32::from(V4) {
        return Err(fmt("Backup index is malformed"));
    }
    if index.generation == 0 {
        index.generation = 1;
    }
    for r in &index.records {
        if r.offset < HEADER_LEN_V4 || r.offset.saturating_add(r.len) > total {
            return Err(fmt(format!("Backup record \"{}\" points outside the file", r.id)));
        }
        if r.gen.is_none() {
            return Err(fmt(format!("Backup record \"{}\" has no generation", r.id)));
        }
    }
    let live_bytes: u64 = index.records.iter().map(|r| r.len).sum();
    Ok(OpenedV4 {
        dead_bytes: total.saturating_sub(HEADER_LEN_V4 + live_bytes + commit.index_len),
        size: total,
        key_material: KeyMaterial { key, salt },
        prefix,
        index,
    })
}

/// A container of either version.
pub enum Opened {
    V3(OpenedContainer),
    V4(OpenedV4),
}

/// What a restore needs to know about one record without reading it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordInfo {
    pub id: String,
    pub size: u64,
    pub hash: String,
}

pub fn is_container(head: &[u8]) -> bool {
    head.len() >= 3 && head[..2] == [0x43, 0x4c] && (head[2] == 3 || head[2] == 4)
}

pub fn open_any<R: ByteSource + ?Sized>(source: &R, password: &str, key_material: Option<&KeyMaterial>) -> Result<Opened, ContainerError> {
    let head = source.read(0, 3.min(source.size()? as usize))?;
    match head.get(2) {
        Some(&V4) if head[..2] == [0x43, 0x4c] => open_v4(source, password, key_material).map(Opened::V4),
        Some(&3) if head[..2] == [0x43, 0x4c] => open_container(source, password, key_material).map(Opened::V3),
        _ => Err(fmt("Not a Cipherline backup container file")),
    }
}

impl Opened {
    pub fn version(&self) -> u8 {
        match self {
            Opened::V3(_) => 3,
            Opened::V4(_) => 4,
        }
    }
    pub fn user_id(&self) -> &str {
        match self {
            Opened::V3(o) => &o.index.user_id,
            Opened::V4(o) => &o.index.user_id,
        }
    }
    pub fn generation(&self) -> u64 {
        match self {
            Opened::V3(o) => o.index.generation,
            Opened::V4(o) => o.index.generation,
        }
    }
    pub fn created_at(&self) -> &str {
        match self {
            Opened::V3(o) => &o.index.created_at,
            Opened::V4(o) => &o.index.created_at,
        }
    }
    pub fn fingerprint(&self) -> &str {
        match self {
            Opened::V3(o) => &o.index.fingerprint,
            Opened::V4(o) => &o.index.fingerprint,
        }
    }
    pub fn size(&self) -> u64 {
        match self {
            Opened::V3(o) => o.size,
            Opened::V4(o) => o.size,
        }
    }
    pub fn dead_bytes(&self) -> u64 {
        match self {
            Opened::V3(o) => o.dead_bytes,
            Opened::V4(o) => o.dead_bytes,
        }
    }
    pub fn records(&self) -> Vec<RecordInfo> {
        match self {
            Opened::V3(o) => o.index.records.iter().map(|r| RecordInfo { id: r.id.clone(), size: r.size, hash: r.hash.clone() }).collect(),
            Opened::V4(o) => o.index.records.iter().map(|r| RecordInfo { id: r.id.clone(), size: r.size, hash: r.hash.clone() }).collect(),
        }
    }
    pub fn key_material(&self) -> &KeyMaterial {
        match self {
            Opened::V3(o) => &o.key_material,
            Opened::V4(o) => &o.key_material,
        }
    }
    /// Decrypt one record and check it against the hash the sealed index declares.
    pub fn read_bytes<R: ByteSource + ?Sized>(&self, source: &R, id: &str) -> Result<Zeroizing<Vec<u8>>, ContainerError> {
        match self {
            Opened::V4(o) => o.read_bytes(source, id),
            Opened::V3(o) => {
                let plain = o.read_bytes(source, id)?;
                let hash = &o.index.records.iter().find(|r| r.id == id).expect("read_bytes found it").hash;
                if hash != IMMUTABLE_HASH && hash.len() == 64 && sha256_hex(&plain) != *hash {
                    return Err(fmt(format!("Backup record \"{id}\" does not match its index (the file was modified)")));
                }
                Ok(plain)
            }
        }
    }
}

// ── the transfer profile (contract 11.15) ───────────────────────────────────────────────────────────────────────
//
// A device-to-device transfer is a v4 container sealed under a RAW 32-byte key (`K_xfer`) instead of a passphrase-derived one:
//   * header byte 3 (flags) = 0x01 ([`FLAG_RAW_KEY`]), bytes 4..20 = a 16-byte salt (any value; readers take the header's), bytes 20..24 = 1;
//   * the key that feeds every AES-256-GCM seal/open below is `K_xfer` itself (PBKDF2 is skipped);
//   * everything else is byte-for-byte the v4 layout: records `u32BE(12+ct+16) || IV || ct || tag` with AAD `cl4:rec:1:<id>`,
//     the index `cl4:index`, the two commit slots `cl4:commit:<slot>:` || the 24 prefix bytes (generation 1 writes slot 1).
// The sender streams the container record by record (the transfer's manifest lists header, index, then one frame per record), so it
// plans every offset up front: [`XferLayout`].

/// What the sender knows about one logical record before it is sealed: its id, plaintext size and plaintext SHA-256 (hex).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct XferRecordFacts {
    pub id: String,
    pub size: u64,
    pub hash: String,
}

/// The sealed frame of one logical record (generation 1, deterministic IV): exactly the bytes a container stores for it.
pub fn seal_record_frame(key: &[u8; 32], id: &str, plaintext: &[u8]) -> Vec<u8> {
    frame_with(key, &rec_aad(1, id), plaintext, Some(()))
}

/// The container's fixed parts and offsets, planned from the records' plaintext facts. The container file is
/// `header || data frames (in `records` order) || index_frame`.
#[derive(Clone, Debug)]
pub struct XferLayout {
    /// 112 bytes: flagged prefix + both commit slots (slot 0 zeros, slot 1 sealed: generation 1).
    pub header: Vec<u8>,
    /// The sealed index frame (last in the file).
    pub index_frame: Vec<u8>,
    /// The index plaintext (JSON) before sealing.
    pub index_json: Vec<u8>,
    pub index: IndexV4,
    /// Container offset of each data frame, in `records` order.
    pub offsets: Vec<u64>,
    /// Container offset of the index frame.
    pub index_offset: u64,
    /// Whole container size.
    pub total: u64,
}

impl XferLayout {
    pub fn plan(key: &[u8; 32], salt: [u8; SALT_LEN], user_id: &str, created_at: &str, fingerprint: &str, records: &[XferRecordFacts]) -> Result<Self, ContainerError> {
        let mut header = raw_header_prefix(&salt);
        let prefix: [u8; PREFIX_LEN] = header[..PREFIX_LEN].try_into().expect("24 bytes");
        let mut offset = HEADER_LEN_V4;
        let mut offsets = Vec::with_capacity(records.len());
        let mut refs = Vec::with_capacity(records.len());
        let mut seen = std::collections::BTreeSet::new();
        for r in records {
            if !seen.insert(r.id.as_str()) {
                return Err(ContainerError::InvalidInput(format!("Duplicate backup record id \"{}\"", r.id)));
            }
            let len = FRAME_OVERHEAD + r.size;
            offsets.push(offset);
            refs.push(RecordRefV4 { id: r.id.clone(), offset, len, size: r.size, hash: r.hash.clone(), gen: Some(1) });
            offset += len;
        }
        let index = IndexV4 { v: u32::from(V4), user_id: user_id.to_owned(), created_at: created_at.to_owned(), fingerprint: fingerprint.to_owned(), generation: 1, records: refs };
        let index_json = serde_json::to_vec(&index).map_err(|e| ContainerError::InvalidInput(e.to_string()))?;
        let index_frame = frame_with(key, b"cl4:index", &index_json, Some(()));
        let sealed = seal_commit_with(key, 1, &prefix, Commit { index_offset: offset, index_len: index_frame.len() as u64, generation: 1 }, Some(()));
        header[PREFIX_LEN + SLOT_LEN..PREFIX_LEN + 2 * SLOT_LEN].copy_from_slice(&sealed);
        Ok(Self { header: header.to_vec(), total: offset + index_frame.len() as u64, index_offset: offset, index_frame, index_json, index, offsets })
    }
}
