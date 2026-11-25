//! Key derivations. Port of desktop `localMasterKey.ts` (deriveUserSubkey) and
//! `crypto.ts` (deriveBackupKey).
use hkdf::Hkdf;
use sha2::{Sha256, Sha512};
use zeroize::Zeroizing;

/// The per-account local-storage subkey:
/// HKDF-SHA256(ikm = 32-byte master key, salt = empty, info = "cl-user-vault:" + userId, len 32).
pub fn user_subkey(master_key: &[u8; 32], user_id: &str) -> Zeroizing<[u8; 32]> {
    let hk = Hkdf::<Sha256>::new(Some(&[]), master_key);
    let mut out = Zeroizing::new([0u8; 32]);
    let info = format!("cl-user-vault:{user_id}");
    hk.expand(info.as_bytes(), out.as_mut()).expect("32 bytes is a valid HKDF-SHA256 length");
    out
}

/// Which PBKDF2 parameter set a backup uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackupKdf {
    /// v1 recovery backup (legacy, read-only): PBKDF2-SHA256, 100 000 iterations.
    V1Sha256,
    /// v2 recovery backup AND the v3 backup container: PBKDF2-SHA512, 600 000 iterations.
    V2Sha512,
}

impl BackupKdf {
    pub fn iterations(self) -> u32 {
        match self {
            BackupKdf::V1Sha256 => 100_000,
            BackupKdf::V2Sha512 => 600_000,
        }
    }
}

/// deriveBackupKey: password + 16-byte salt -> 32-byte AES-256-GCM key.
pub fn backup_key(password: &str, salt: &[u8], kdf: BackupKdf) -> Zeroizing<[u8; 32]> {
    let mut out = Zeroizing::new([0u8; 32]);
    match kdf {
        BackupKdf::V1Sha256 => {
            pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, kdf.iterations(), out.as_mut())
        }
        BackupKdf::V2Sha512 => {
            pbkdf2::pbkdf2_hmac::<Sha512>(password.as_bytes(), salt, kdf.iterations(), out.as_mut())
        }
    }
    out
}

/// PBKDF2-SHA256 with an explicit iteration count (desktop's Screen Lock PIN verifier).
pub fn backup_key_sha256(password: &str, salt: &[u8], iterations: u32) -> Zeroizing<[u8; 32]> {
    let mut out = Zeroizing::new([0u8; 32]);
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iterations, out.as_mut());
    out
}

/// PBKDF2-SHA512 with an explicit iteration count — the v3 backup container reads its count
/// from the file header.
pub fn backup_key_sha512(password: &str, salt: &[u8], iterations: u32) -> Zeroizing<[u8; 32]> {
    let mut out = Zeroizing::new([0u8; 32]);
    pbkdf2::pbkdf2_hmac::<Sha512>(password.as_bytes(), salt, iterations, out.as_mut());
    out
}

/// Prefix of the HKDF `info` for server voice-channel call keys (desktop `voiceChannelKey.ts`).
pub const VOICE_KEY_INFO_PREFIX: &str = "cipherline/voice-key/v1/";

fn is_canonical_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36 && b.iter().enumerate().all(|(i, &c)| if matches!(i, 8 | 13 | 18 | 23) { c == b'-' } else { c.is_ascii_hexdigit() })
}

/// The media key of a server voice channel / Calls channel for one epoch: HKDF-SHA256 over the
/// channel's Sender Key (32 bytes), empty salt, info `cipherline/voice-key/v1/<channel uuid,
/// lowercase>/<epoch>`, 32 bytes. Port of desktop `deriveVoiceChannelKey`. Errors (without
/// echoing the channel id — it is routing metadata) on a non-UUID channel id or an epoch < 1.
pub fn voice_channel_key(channel_sender_key: &[u8; 32], channel_id: &str, epoch: u32) -> Result<Zeroizing<[u8; 32]>, crate::CryptoError> {
    if !is_canonical_uuid(channel_id) {
        return Err(crate::CryptoError::InvalidInput("voice key derivation: channelId must be a canonical UUID".into()));
    }
    if epoch < 1 {
        return Err(crate::CryptoError::InvalidInput("voice key derivation: epoch must be a positive integer".into()));
    }
    let info = format!("{VOICE_KEY_INFO_PREFIX}{}/{epoch}", channel_id.to_ascii_lowercase());
    let hk = Hkdf::<Sha256>::new(Some(&[]), channel_sender_key);
    let mut out = Zeroizing::new([0u8; 32]);
    hk.expand(info.as_bytes(), out.as_mut()).expect("32 bytes is a valid HKDF-SHA256 length");
    Ok(out)
}

#[cfg(test)]
mod voice_key_tests {
    use super::*;

    #[test]
    fn matches_node_hkdf_vector() {
        // node: crypto.hkdfSync('sha256', Buffer.alloc(32, 7), Buffer.alloc(0), 'cipherline/voice-key/v1/<id>/3', 32)
        let k = voice_channel_key(&[7u8; 32], "0B1C2D3E-0000-4000-8000-0123456789AB", 3).unwrap();
        assert_eq!(crate::encoding::b64(k.as_ref()), "ZTq7x1DqLFkQDNIKPlejHY0Dyw3fFSFTZhVSAgLuJe8=");
    }

    #[test]
    fn rejects_bad_inputs_and_binds_channel_and_epoch() {
        assert!(voice_channel_key(&[7u8; 32], "not-a-uuid", 1).is_err());
        assert!(voice_channel_key(&[7u8; 32], "0b1c2d3e-0000-4000-8000-0123456789ab", 0).is_err());
        let a = voice_channel_key(&[7u8; 32], "0b1c2d3e-0000-4000-8000-0123456789ab", 1).unwrap();
        let b = voice_channel_key(&[7u8; 32], "0b1c2d3e-0000-4000-8000-0123456789ab", 2).unwrap();
        let c = voice_channel_key(&[7u8; 32], "0b1c2d3e-0000-4000-8000-0123456789ac", 1).unwrap();
        assert_ne!(a.as_ref() as &[u8], b.as_ref() as &[u8]);
        assert_ne!(a.as_ref() as &[u8], c.as_ref() as &[u8]);
    }
}
