//! Attachment / avatar / recovery-backup blob encryption. Port of desktop `crypto.ts`.
//!
//! | Producer | Layout |
//! |---|---|
//! | [`encrypt_blob`] (chat attachments, avatars) | `ciphertext ‖ tag`, IV travels separately as `file_nonce_b64` |
//! | [`encrypt_blob_bundled`] | `IV(12) ‖ ciphertext ‖ tag` |
//! | [`encrypt_with_key`] (reusable-key chunks) | `IV(12) ‖ ciphertext ‖ tag` |
//! | [`encrypt_backup_v2`] | `"CL" 0x02 ‖ salt(16) ‖ IV(12) ‖ ciphertext ‖ tag` |
//! | v1 backup (decode only) | `salt(16) ‖ IV(12) ‖ ciphertext ‖ tag` |
//!
//! AES-256-GCM throughout; the 16-byte tag is appended to the ciphertext (WebCrypto's layout).
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use rand_core::{OsRng, RngCore};
use zeroize::Zeroizing;

use crate::kdf::{backup_key, BackupKdf};
use crate::CryptoError;

pub const KEY_LEN: usize = 32;
pub const IV_LEN: usize = 12;
pub const TAG_LEN: usize = 16;
pub const SALT_LEN: usize = 16;
pub const BACKUP_MAGIC_V2: [u8; 3] = [0x43, 0x4c, 0x02];

/// A fresh random 32-byte file key (`file_key_b64` is its base64).
pub fn generate_file_key() -> Zeroizing<[u8; KEY_LEN]> {
    let mut k = Zeroizing::new([0u8; KEY_LEN]);
    OsRng.fill_bytes(k.as_mut());
    k
}

pub fn generate_iv() -> [u8; IV_LEN] {
    let mut iv = [0u8; IV_LEN];
    OsRng.fill_bytes(&mut iv);
    iv
}

/// Decode a `file_key_b64` and insist on exactly 32 bytes.
pub fn file_key_from_b64(s: &str) -> Result<Zeroizing<[u8; KEY_LEN]>, CryptoError> {
    let raw = Zeroizing::new(crate::encoding::from_b64(s)?);
    let arr: [u8; KEY_LEN] = raw
        .as_slice()
        .try_into()
        .map_err(|_| CryptoError::InvalidInput(format!("file key must be 32 bytes, got {}", raw.len())))?;
    Ok(Zeroizing::new(arr))
}

fn cipher(key: &[u8]) -> Result<Aes256Gcm, CryptoError> {
    Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::InvalidInput("AES key must be 32 bytes".into()))
}

/// AES-256-GCM seal: returns `ciphertext ‖ tag`.
pub fn seal(key: &[u8], iv: &[u8; IV_LEN], plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    cipher(key)?
        .encrypt(Nonce::from_slice(iv), plaintext)
        .map_err(|_| CryptoError::InvalidInput("encryption failed".into()))
}

/// AES-256-GCM open of `ciphertext ‖ tag`.
pub fn open(key: &[u8], iv: &[u8], ct_and_tag: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if iv.len() != IV_LEN {
        return Err(CryptoError::InvalidInput("IV must be 12 bytes".into()));
    }
    if ct_and_tag.len() < TAG_LEN {
        return Err(CryptoError::InvalidInput("ciphertext shorter than the GCM tag".into()));
    }
    cipher(key)?
        .decrypt(Nonce::from_slice(iv), ct_and_tag)
        .map(Zeroizing::new)
        .map_err(|_| CryptoError::DecryptFailed)
}

/// AES-256-GCM seal with associated data.
pub fn seal_aad(key: &[u8], iv: &[u8; IV_LEN], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
    cipher(key)?
        .encrypt(Nonce::from_slice(iv), Payload { msg: plaintext, aad })
        .map_err(|_| CryptoError::InvalidInput("encryption failed".into()))
}

/// AES-256-GCM open with associated data.
pub fn open_aad(key: &[u8], iv: &[u8], ct_and_tag: &[u8], aad: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if iv.len() != IV_LEN || ct_and_tag.len() < TAG_LEN {
        return Err(CryptoError::DecryptFailed);
    }
    cipher(key)?
        .decrypt(Nonce::from_slice(iv), Payload { msg: ct_and_tag, aad })
        .map(Zeroizing::new)
        .map_err(|_| CryptoError::DecryptFailed)
}

/// Chat-attachment layout. Returns `(ciphertext ‖ tag, iv)`; the IV travels as `file_nonce_b64`.
pub fn encrypt_blob(key: &[u8], plaintext: &[u8]) -> Result<(Vec<u8>, [u8; IV_LEN]), CryptoError> {
    let iv = generate_iv();
    Ok((seal(key, &iv, plaintext)?, iv))
}

pub fn decrypt_blob(key: &[u8], iv: &[u8], blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    open(key, iv, blob)
}

/// Self-contained layout: `IV ‖ ciphertext ‖ tag`.
pub fn encrypt_blob_bundled(key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let iv = generate_iv();
    let mut out = Vec::with_capacity(IV_LEN + plaintext.len() + TAG_LEN);
    out.extend_from_slice(&iv);
    out.extend(seal(key, &iv, plaintext)?);
    Ok(out)
}

pub fn decrypt_blob_bundled(key: &[u8], blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    if blob.len() < IV_LEN + TAG_LEN {
        return Err(CryptoError::InvalidInput("bundled blob too short".into()));
    }
    open(key, &blob[..IV_LEN], &blob[IV_LEN..])
}

/// Reusable-key chunk (same layout as bundled).
pub fn encrypt_with_key(key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    encrypt_blob_bundled(key, plaintext)
}

pub fn decrypt_with_key(key: &[u8], blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    decrypt_blob_bundled(key, blob)
}

/// v2 recovery backup: `"CL" 0x02 ‖ salt ‖ IV ‖ ciphertext ‖ tag`, PBKDF2-SHA512 600k.
pub fn encrypt_backup_v2(password: &str, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    let iv = generate_iv();
    let key = backup_key(password, &salt, BackupKdf::V2Sha512);
    let mut out = Vec::with_capacity(3 + SALT_LEN + IV_LEN + plaintext.len() + TAG_LEN);
    out.extend_from_slice(&BACKUP_MAGIC_V2);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&iv);
    out.extend(seal(key.as_ref(), &iv, plaintext)?);
    Ok(out)
}

/// Parsed header of a recovery backup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupHeader {
    pub kdf: BackupKdf,
    pub salt: [u8; SALT_LEN],
    pub iv: [u8; IV_LEN],
    /// Offset of `ciphertext ‖ tag` in the blob.
    pub body_offset: usize,
}

/// parseBackupHeader: v2 when the magic is present, else v1.
pub fn parse_backup_header(blob: &[u8]) -> Result<BackupHeader, CryptoError> {
    let (kdf, start) = if blob.starts_with(&BACKUP_MAGIC_V2) {
        (BackupKdf::V2Sha512, 3)
    } else {
        (BackupKdf::V1Sha256, 0)
    };
    if blob.len() < start + SALT_LEN + IV_LEN + TAG_LEN {
        return Err(CryptoError::InvalidInput("backup too short".into()));
    }
    let salt: [u8; SALT_LEN] = blob[start..start + SALT_LEN].try_into().unwrap();
    let iv: [u8; IV_LEN] = blob[start + SALT_LEN..start + SALT_LEN + IV_LEN].try_into().unwrap();
    Ok(BackupHeader { kdf, salt, iv, body_offset: start + SALT_LEN + IV_LEN })
}

/// decryptBackup: v2 or legacy v1.
pub fn decrypt_backup(password: &str, blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let h = parse_backup_header(blob)?;
    let key = backup_key(password, &h.salt, h.kdf);
    open(key.as_ref(), &h.iv, &blob[h.body_offset..])
}
