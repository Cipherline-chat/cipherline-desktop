//! The v3 encrypted backup container — desktop `src/utils/backupContainer.ts`.
//!
//! ONE file per destination, updated IN PLACE:
//!
//! ```text
//! header (36 B)  "CL" 0x03 ‖ flags(1) ‖ salt(16) ‖ PBKDF2 iterations u32BE ‖ indexOffset u64BE ‖ indexLen u32BE
//! record         frameLen u32BE ‖ IV(12) ‖ AES-256-GCM(ct ‖ tag), AAD "cl3:rec:<id>"; frameLen = 12 + ct
//! index          a record with AAD "cl3:index": JSON {v, userId, createdAt, fingerprint, generation,
//!                records:[{id, offset, len, size, hash}]}   (len = the whole frame incl. its 4-byte length)
//! ```
//!
//! An update appends only changed records, then a new index, then flips the header pointer —
//! a crash before the flip leaves the previous generation intact. Unchanged records are
//! `carry`'d by reference. The key is PBKDF2-SHA512 over the password and the header salt
//! (600 000 iterations when written here). Record AAD binds each record to its id, so the
//! index cannot be edited to swap records around.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::blob::{self, IV_LEN, SALT_LEN, TAG_LEN};
use crate::encoding::hex;
use crate::kdf::{backup_key_sha512, BackupKdf};

pub const CONTAINER_VERSION: u32 = 3;
pub const MAGIC: [u8; 3] = [0x43, 0x4c, 0x03];
pub const HEADER_LEN: u64 = 36;
pub const IMMUTABLE_HASH: &str = "immutable";
const PTR_OFFSET: u64 = 24;
const FRAME_LEN_BYTES: usize = 4;
const INDEX_AAD: &[u8] = b"cl3:index";
const MAX_ITERATIONS: u32 = 10_000_000;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ContainerError {
    #[error("{0}")]
    Format(String),
    #[error("Could not decrypt this backup with the given passphrase.")]
    AuthFailed,
    #[error("{0}")]
    InvalidInput(String),
    #[error("i/o: {0}")]
    Io(String),
    /// A device-to-device transfer container (raw-key profile of v4, header flag bit 0): it has no passphrase and is not a backup file.
    #[error("This file is a device-to-device transfer, not a backup.")]
    TransferContainer,
}

fn fmt(msg: impl Into<String>) -> ContainerError {
    ContainerError::Format(msg.into())
}

/// Where a container is written: append, plus one in-place write for the header pointer.
pub trait ByteSink {
    fn write(&mut self, bytes: &[u8]) -> Result<(), ContainerError>;
    fn write_at(&mut self, offset: u64, bytes: &[u8]) -> Result<(), ContainerError>;
}

/// Where a container is read from: random access.
pub trait ByteSource {
    fn size(&self) -> Result<u64, ContainerError>;
    fn read(&self, offset: u64, len: usize) -> Result<Vec<u8>, ContainerError>;
}

impl ByteSink for Vec<u8> {
    fn write(&mut self, bytes: &[u8]) -> Result<(), ContainerError> {
        self.extend_from_slice(bytes);
        Ok(())
    }
    fn write_at(&mut self, offset: u64, bytes: &[u8]) -> Result<(), ContainerError> {
        let start = usize::try_from(offset).map_err(|_| ContainerError::InvalidInput("writeAt is out of range".into()))?;
        let end = start.checked_add(bytes.len()).filter(|e| *e <= self.len());
        let end = end.ok_or_else(|| ContainerError::InvalidInput("writeAt is out of range".into()))?;
        self[start..end].copy_from_slice(bytes);
        Ok(())
    }
}

impl ByteSource for [u8] {
    fn size(&self) -> Result<u64, ContainerError> {
        Ok(self.len() as u64)
    }
    fn read(&self, offset: u64, len: usize) -> Result<Vec<u8>, ContainerError> {
        let start = usize::try_from(offset).ok();
        let range = start.and_then(|s| Some(s..s.checked_add(len)?)).filter(|r| r.end <= self.len());
        range.map(|r| self[r].to_vec()).ok_or_else(|| ContainerError::InvalidInput("Read is out of range".into()))
    }
}

impl ByteSource for Vec<u8> {
    fn size(&self) -> Result<u64, ContainerError> {
        self.as_slice().size()
    }
    fn read(&self, offset: u64, len: usize) -> Result<Vec<u8>, ContainerError> {
        self.as_slice().read(offset, len)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordRef {
    pub id: String,
    pub offset: u64,
    pub len: u64,
    pub size: u64,
    pub hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerIndex {
    pub v: u32,
    pub user_id: String,
    pub created_at: String,
    pub fingerprint: String,
    #[serde(default = "one")]
    pub generation: u64,
    pub records: Vec<RecordRef>,
}

fn one() -> u64 {
    1
}

/// The derived key and the salt it came from, so a reopen can skip the 600k-round PBKDF2.
#[derive(Clone)]
pub struct KeyMaterial {
    pub key: Zeroizing<[u8; 32]>,
    pub salt: [u8; SALT_LEN],
}

impl KeyMaterial {
    /// A raw 32-byte container key with the salt the header carries (the transfer profile: no key derivation, see `backup_v4`).
    pub fn from_raw(key: [u8; 32], salt: [u8; SALT_LEN]) -> Self {
        Self { key: Zeroizing::new(key), salt }
    }

    pub fn derive(password: &str, salt: [u8; SALT_LEN]) -> Self {
        Self { key: backup_key_sha512(password, &salt, BackupKdf::V2Sha512.iterations()), salt }
    }

    pub fn fresh(password: &str) -> Self {
        let mut salt = [0u8; SALT_LEN];
        rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut salt);
        Self::derive(password, salt)
    }
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

pub fn is_v3_container(head: &[u8]) -> bool {
    head.len() >= 3 && head[..3] == MAGIC
}

fn record_aad(id: &str) -> Vec<u8> {
    format!("cl3:rec:{id}").into_bytes()
}

fn encrypt_frame(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Vec<u8> {
    let iv = blob::generate_iv();
    let ct = blob::seal_aad(key, &iv, plaintext, aad).expect("a 32-byte key always seals");
    let mut out = Vec::with_capacity(FRAME_LEN_BYTES + IV_LEN + ct.len());
    out.extend_from_slice(&((IV_LEN + ct.len()) as u32).to_be_bytes());
    out.extend_from_slice(&iv);
    out.extend_from_slice(&ct);
    out
}

fn decrypt_frame(key: &[u8; 32], aad: &[u8], framed: &[u8]) -> Result<Zeroizing<Vec<u8>>, ContainerError> {
    if framed.len() < FRAME_LEN_BYTES + IV_LEN + TAG_LEN {
        return Err(fmt("Backup record is truncated"));
    }
    let declared = u32::from_be_bytes(framed[..4].try_into().expect("4 bytes")) as usize;
    if declared != framed.len() - FRAME_LEN_BYTES {
        return Err(fmt("Backup record length mismatch"));
    }
    blob::open_aad(key, &framed[4..4 + IV_LEN], &framed[4 + IV_LEN..], aad).map_err(|_| ContainerError::AuthFailed)
}

pub struct ContainerWriter<'s, S: ByteSink> {
    sink: &'s mut S,
    key: KeyMaterial,
    offset: u64,
    generation: u64,
    previous: Vec<RecordRef>,
    refs: Vec<RecordRef>,
}

impl<'s, S: ByteSink> ContainerWriter<'s, S> {
    /// A brand-new container (generation 1): writes the header with a zero index pointer.
    pub fn create(sink: &'s mut S, key: KeyMaterial) -> Result<Self, ContainerError> {
        let mut header = [0u8; HEADER_LEN as usize];
        header[..3].copy_from_slice(&MAGIC);
        header[4..20].copy_from_slice(&key.salt);
        header[20..24].copy_from_slice(&BackupKdf::V2Sha512.iterations().to_be_bytes());
        sink.write(&header)?;
        Ok(Self { sink, key, offset: HEADER_LEN, generation: 1, previous: Vec::new(), refs: Vec::new() })
    }

    /// Continue an existing container in place: new records are appended after its end.
    pub fn resume(sink: &'s mut S, existing: &OpenedContainer) -> Self {
        Self {
            sink,
            key: existing.key_material.clone(),
            offset: existing.size,
            generation: existing.index.generation + 1,
            previous: existing.index.records.clone(),
            refs: Vec::new(),
        }
    }

    /// The previous generation's hash for `id` — compare with the new content's to decide
    /// between [`Self::carry`] and [`Self::add_bytes`].
    pub fn previous_hash(&self, id: &str) -> Option<&str> {
        self.previous.iter().find(|r| r.id == id).map(|r| r.hash.as_str())
    }

    fn assert_new(&self, id: &str) -> Result<(), ContainerError> {
        if self.refs.iter().any(|r| r.id == id) {
            return Err(ContainerError::InvalidInput(format!("Duplicate backup record id \"{id}\"")));
        }
        Ok(())
    }

    /// Keep an unchanged record by reference; its bytes are never rewritten.
    pub fn carry(&mut self, id: &str) -> Result<(), ContainerError> {
        let prev = self.previous.iter().find(|r| r.id == id).cloned();
        let prev = prev.ok_or_else(|| fmt(format!("No existing record \"{id}\" to carry")))?;
        self.assert_new(id)?;
        self.refs.push(prev);
        Ok(())
    }

    /// Append a record. `hash` defaults to the SHA-256 of `plaintext` (hex); pass
    /// [`IMMUTABLE_HASH`] for content that never changes under the same id.
    pub fn add_bytes(&mut self, id: &str, plaintext: &[u8], hash: Option<&str>) -> Result<(), ContainerError> {
        self.assert_new(id)?;
        let framed = encrypt_frame(&self.key.key, &record_aad(id), plaintext);
        self.refs.push(RecordRef {
            id: id.to_owned(),
            offset: self.offset,
            len: framed.len() as u64,
            size: plaintext.len() as u64,
            hash: hash.map_or_else(|| sha256_hex(plaintext), str::to_owned),
        });
        self.sink.write(&framed)?;
        self.offset += framed.len() as u64;
        Ok(())
    }

    /// Append the index, then flip the header pointer to it.
    pub fn finish(self, user_id: &str, fingerprint: &str, created_at: &str) -> Result<FinishedContainer, ContainerError> {
        let index = ContainerIndex {
            v: CONTAINER_VERSION,
            user_id: user_id.to_owned(),
            created_at: created_at.to_owned(),
            fingerprint: fingerprint.to_owned(),
            generation: self.generation,
            records: self.refs,
        };
        let json = serde_json::to_vec(&index).map_err(|e| ContainerError::InvalidInput(e.to_string()))?;
        let framed = encrypt_frame(&self.key.key, INDEX_AAD, &json);
        let index_offset = self.offset;
        self.sink.write(&framed)?;
        let mut ptr = [0u8; 12];
        ptr[..8].copy_from_slice(&index_offset.to_be_bytes());
        ptr[8..].copy_from_slice(&(framed.len() as u32).to_be_bytes());
        self.sink.write_at(PTR_OFFSET, &ptr)?;
        let total = index_offset + framed.len() as u64;
        let live: u64 = index.records.iter().map(|r| r.len).sum();
        Ok(FinishedContainer { dead_bytes: total - HEADER_LEN - live - framed.len() as u64, bytes: total, index })
    }
}

#[derive(Clone, Debug)]
pub struct FinishedContainer {
    pub index: ContainerIndex,
    pub bytes: u64,
    /// Superseded record bytes still in the file; compact (fresh write + atomic rename) once
    /// this passes 30 % of the file.
    pub dead_bytes: u64,
}

#[derive(Clone)]
pub struct OpenedContainer {
    pub index: ContainerIndex,
    pub size: u64,
    pub dead_bytes: u64,
    pub key_material: KeyMaterial,
}

impl OpenedContainer {
    pub fn has(&self, id: &str) -> bool {
        self.index.records.iter().any(|r| r.id == id)
    }

    pub fn read_bytes<R: ByteSource + ?Sized>(&self, source: &R, id: &str) -> Result<Zeroizing<Vec<u8>>, ContainerError> {
        let r = self.index.records.iter().find(|r| r.id == id).ok_or_else(|| fmt(format!("Backup has no record \"{id}\"")))?;
        let framed = source.read(r.offset, r.len as usize)?;
        decrypt_frame(&self.key_material.key, &record_aad(id), &framed)
    }
}

/// Open a container: derive the key from the header (or reuse `key_material` when its salt
/// matches), decrypt the index, and check every record lies inside the file.
pub fn open_container<R: ByteSource + ?Sized>(
    source: &R,
    password: &str,
    key_material: Option<&KeyMaterial>,
) -> Result<OpenedContainer, ContainerError> {
    let total = source.size()?;
    if total < HEADER_LEN {
        return Err(fmt("Backup file is too small"));
    }
    let header = source.read(0, HEADER_LEN as usize)?;
    if !is_v3_container(&header) {
        return Err(fmt("Not a Cipherline v3 backup file"));
    }
    let salt: [u8; SALT_LEN] = header[4..20].try_into().expect("16 bytes");
    let iterations = u32::from_be_bytes(header[20..24].try_into().expect("4 bytes"));
    if !(1..=MAX_ITERATIONS).contains(&iterations) {
        return Err(fmt("Backup header is corrupted"));
    }
    let index_offset = u64::from_be_bytes(header[24..32].try_into().expect("8 bytes"));
    let index_len = u64::from(u32::from_be_bytes(header[32..36].try_into().expect("4 bytes")));
    if index_len == 0 || index_offset < HEADER_LEN || index_offset.saturating_add(index_len) > total {
        return Err(fmt("Backup file is incomplete or corrupted (bad index pointer)"));
    }
    let key = match key_material {
        Some(km) if km.salt == salt => km.key.clone(),
        _ => backup_key_sha512(password, &salt, iterations),
    };
    let framed = source.read(index_offset, index_len as usize)?;
    let raw = decrypt_frame(&key, INDEX_AAD, &framed).map_err(|_| ContainerError::AuthFailed)?;
    let index: ContainerIndex = serde_json::from_slice(&raw).map_err(|_| ContainerError::AuthFailed)?;
    if index.v != CONTAINER_VERSION {
        return Err(fmt("Backup index is malformed"));
    }
    for r in &index.records {
        if r.offset < HEADER_LEN || r.offset.saturating_add(r.len) > total {
            return Err(fmt(format!("Backup record \"{}\" points outside the file", r.id)));
        }
    }
    let live: u64 = index.records.iter().map(|r| r.len).sum();
    Ok(OpenedContainer {
        dead_bytes: total.saturating_sub(HEADER_LEN + live + index_len),
        size: total,
        key_material: KeyMaterial { key, salt },
        index,
    })
}
