//! Message envelope v:3 — sealed-sender ECIES with per-device fan-out.
//!
//! Byte-exact port of desktop `electron/e2ee-engine.ts` (and the mobile app's
//! `src/core/crypto/e2ee-engine.ts`). Wire format:
//!
//! ```jsonc
//! base64(JSON({
//!   v: 3,
//!   eph: "<b64: 32-byte X25519 ephemeral public key>",
//!   recipients: { "<device_id>": { wrap: "<b64: IV(12) ‖ tag(16) ‖ wrapped content key>",
//!                                  otp_id: 42 } },   // otp_id only when one was mixed in
//!   iv:  "<b64: 12-byte content IV>",
//!   ct:  "<b64: AES-256-GCM({sp,su,sd,c}) ‖ tag(16)>",
//!   sig: "<b64: Ed25519 over SHA-256(eph ‖ iv ‖ ct ‖ sortedDeviceIdsCsv)>"
//! }))
//! ```
//!
//! Load-bearing rules (each one cost the desktop a production bug):
//! 1. The AAD is built from the devices ACTUALLY wrapped, never the input list.
//! 2. `wrap` puts the tag BEFORE the ciphertext; `ct` puts it AFTER.
//! 3. The signature is verified AFTER decryption, against the identity key inside the plaintext.
//! 4. Anything that is not `v:3` is rejected.
//! 5. Consuming a one-time prekey and recording the ephemeral key for replay protection are the
//!    CALLER's job, and only after this decrypt fully succeeds (see [`Decrypted`]).
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use ed25519_dalek::SigningKey;
use hkdf::Hkdf;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use x25519_dalek::PublicKey;
use zeroize::Zeroizing;

use crate::blob::{generate_iv, IV_LEN, TAG_LEN};
use crate::encoding::{b64, from_b64};
use crate::keys::{ecdh, generate_x25519, sign, verify, x25519_pub_from_b64, x25519_secret};
use crate::CryptoError;

pub const ENVELOPE_VERSION: u64 = 3;

/// Why an envelope could not be opened. Mirrors the desktop's `E2EE:*` codes.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EnvelopeError {
    #[error("malformed envelope: {0}")]
    Malformed(String),
    #[error("legacy (non-v3) envelope rejected")]
    Legacy,
    #[error("no recipient entry for this device")]
    NoRecipientEntry,
    #[error("low-order point")]
    LowOrderPoint,
    #[error("wrap authentication failed")]
    WrapAuthFailed,
    #[error("content authentication failed")]
    ContentAuthFailed,
    #[error("signature invalid")]
    SigInvalid,
    #[error("no device could be wrapped")]
    WrapNone,
}

/// One recipient device, as built from its published key bundle.
#[derive(Clone, Debug)]
pub struct RecipientDevice {
    pub device_id: String,
    pub identity_pub_b64: String,
    pub spk_pub_b64: String,
    /// Ed25519 signature (by `identity_pub_b64`) over the raw SPK public key bytes.
    pub spk_sig_b64: String,
    /// The one-time prekey claimed for this message, if any.
    pub otp: Option<(u32, String)>,
}

/// The sender's identity, used to sign the transcript and announced (sealed) inside the ciphertext.
pub struct SenderIdentity<'a> {
    pub signing_key: &'a SigningKey,
    pub identity_pub_b64: &'a str,
    pub user_id: &'a str,
    pub device_id: Option<&'a str>,
}

/// Test-only override of every random value, in the desktop's call order.
#[doc(hidden)]
pub struct EncryptRandomness {
    pub ephemeral_priv: [u8; 32],
    pub content_key: [u8; 32],
    pub wrap_ivs: Vec<[u8; IV_LEN]>,
    pub content_iv: [u8; IV_LEN],
}

pub struct Encrypted {
    pub envelope_b64: String,
    /// The devices that actually got a wrap (and so appear in the AAD), in input order.
    pub wrapped_device_ids: Vec<String>,
    /// The devices whose wrap actually mixed a one-time prekey in (a subset of `wrapped_device_ids`). A device that
    /// was offered an OTP but is NOT listed here fell back to signed-prekey-only (invalid or low-order OTP public key).
    pub otp_device_ids: Vec<String>,
}

/// HKDF-SHA256(ikm, salt = "", info = eph ‖ utf8(device_id) ‖ "v2" ‖ [BE32(otp_id)], 32).
fn derive_wrap_key(ikm: &[u8], eph_pub: &[u8; 32], device_id: &str, otp_id: Option<u32>) -> Zeroizing<[u8; 32]> {
    let mut info = Vec::with_capacity(32 + device_id.len() + 6);
    info.extend_from_slice(eph_pub);
    info.extend_from_slice(device_id.as_bytes());
    info.extend_from_slice(b"v2");
    if let Some(id) = otp_id {
        info.extend_from_slice(&id.to_be_bytes());
    }
    let mut out = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(&[]), ikm).expand(&info, out.as_mut()).expect("valid HKDF length");
    out
}

fn transcript_hash(eph: &[u8], iv: &[u8], ct: &[u8], sorted_ids_csv: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(eph);
    h.update(iv);
    h.update(ct);
    h.update(sorted_ids_csv.as_bytes());
    h.finalize().into()
}

fn sorted_csv<'a>(ids: impl Iterator<Item = &'a String>) -> String {
    let mut v: Vec<&str> = ids.map(|s| s.as_str()).collect();
    v.sort_unstable();
    v.join(",")
}

/// Encrypt `content_json` (a `ClientContent` JSON object) to every eligible device.
///
/// A device whose SPK signature does not verify, or whose ECDH is degenerate, is skipped and
/// left out of the AAD (rule 1). Returns [`EnvelopeError::WrapNone`] when nobody could be wrapped.
pub fn encrypt_for_devices(
    content_json: &str,
    sender: &SenderIdentity<'_>,
    devices: &[RecipientDevice],
    randomness: Option<&EncryptRandomness>,
) -> Result<Encrypted, EnvelopeError> {
    let content: Value =
        serde_json::from_str(content_json).map_err(|e| EnvelopeError::Malformed(format!("content JSON: {e}")))?;

    let (eph_priv, eph_pub_b64) = match randomness {
        Some(r) => {
            let s = x25519_secret(&r.ephemeral_priv).map_err(|e| EnvelopeError::Malformed(e.to_string()))?;
            let p = PublicKey::from(&s);
            (Zeroizing::new(r.ephemeral_priv), b64(p.as_bytes()))
        }
        None => generate_x25519(),
    };
    let eph_secret = x25519_secret(eph_priv.as_ref()).map_err(|e| EnvelopeError::Malformed(e.to_string()))?;
    let eph_pub: [u8; 32] = *PublicKey::from(&eph_secret).as_bytes();

    let content_key: Zeroizing<[u8; 32]> = match randomness {
        Some(r) => Zeroizing::new(r.content_key),
        None => crate::blob::generate_file_key(),
    };

    let mut recipients = Map::new();
    let mut wrapped = Vec::new();
    let mut otp_wrapped = Vec::new();
    let mut wrap_iv_index = 0usize;

    for d in devices {
        // The SPK must be signed by the device's identity key.
        let Ok(spk_raw) = from_b64(&d.spk_pub_b64) else { continue };
        let Ok(sig) = from_b64(&d.spk_sig_b64) else { continue };
        if !verify(&d.identity_pub_b64, &spk_raw, &sig) {
            continue;
        }
        let Ok(spk_pub) = x25519_pub_from_b64(&d.spk_pub_b64) else { continue };
        let Some(shared_spk) = ecdh(&eph_secret, &spk_pub) else { continue };

        let mut otp_used = None;
        let ikm: Zeroizing<Vec<u8>> = match &d.otp {
            Some((otp_id, otp_pub_b64)) => match x25519_pub_from_b64(otp_pub_b64).ok().and_then(|p| ecdh(&eph_secret, &p)) {
                Some(shared_otp) => {
                    otp_used = Some(*otp_id);
                    let mut v = Zeroizing::new(Vec::with_capacity(64));
                    v.extend_from_slice(shared_spk.as_ref());
                    v.extend_from_slice(shared_otp.as_ref());
                    v
                }
                // A degenerate OTP falls back to SPK-only (reduced forward secrecy), as desktop does.
                None => Zeroizing::new(shared_spk.to_vec()),
            },
            None => Zeroizing::new(shared_spk.to_vec()),
        };
        let wrap_key = derive_wrap_key(&ikm, &eph_pub, &d.device_id, otp_used);

        let wrap_iv = match randomness {
            Some(r) => *r.wrap_ivs.get(wrap_iv_index).ok_or_else(|| EnvelopeError::Malformed("missing wrap IV".into()))?,
            None => generate_iv(),
        };
        wrap_iv_index += 1;
        // wrap = IV ‖ tag ‖ ciphertext (tag BEFORE ciphertext — rule 2).
        let sealed = Aes256Gcm::new_from_slice(wrap_key.as_ref())
            .expect("32-byte key")
            .encrypt(Nonce::from_slice(&wrap_iv), &content_key[..])
            .map_err(|_| EnvelopeError::Malformed("wrap encrypt".into()))?;
        let (body, tag) = sealed.split_at(sealed.len() - TAG_LEN);
        let mut wrap = Vec::with_capacity(IV_LEN + TAG_LEN + body.len());
        wrap.extend_from_slice(&wrap_iv);
        wrap.extend_from_slice(tag);
        wrap.extend_from_slice(body);

        // Key order matches the desktop's JSON: {"wrap":…,"otp_id":…}.
        let mut entry = Map::new();
        entry.insert("wrap".into(), Value::String(b64(&wrap)));
        if let Some(id) = otp_used {
            entry.insert("otp_id".into(), Value::from(id));
        }
        recipients.insert(d.device_id.clone(), Value::Object(entry));
        wrapped.push(d.device_id.clone());
        if otp_used.is_some() { otp_wrapped.push(d.device_id.clone()); }
    }

    if wrapped.is_empty() {
        return Err(EnvelopeError::WrapNone);
    }

    let sorted = sorted_csv(recipients.keys());
    let mut aad = Vec::with_capacity(32 + sorted.len());
    aad.extend_from_slice(&eph_pub);
    aad.extend_from_slice(sorted.as_bytes());

    // Sealed sender: sp/su/sd live INSIDE the ciphertext. `sd` is omitted when unknown, exactly
    // like JSON.stringify drops an undefined field.
    let mut wrapper = Map::new();
    wrapper.insert("sp".into(), Value::String(sender.identity_pub_b64.to_owned()));
    wrapper.insert("su".into(), Value::String(sender.user_id.to_owned()));
    if let Some(sd) = sender.device_id {
        wrapper.insert("sd".into(), Value::String(sd.to_owned()));
    }
    wrapper.insert("c".into(), content);
    let wrapper_json = Zeroizing::new(serde_json::to_vec(&Value::Object(wrapper)).expect("serialisable"));

    let content_iv = match randomness {
        Some(r) => r.content_iv,
        None => generate_iv(),
    };
    let ct = Aes256Gcm::new_from_slice(content_key.as_ref())
        .expect("32-byte key")
        .encrypt(Nonce::from_slice(&content_iv), Payload { msg: &wrapper_json, aad: &aad })
        .map_err(|_| EnvelopeError::Malformed("content encrypt".into()))?;

    let sig = sign(sender.signing_key, &transcript_hash(&eph_pub, &content_iv, &ct, &sorted));

    let mut env = Map::new();
    env.insert("v".into(), Value::from(ENVELOPE_VERSION));
    env.insert("eph".into(), Value::String(eph_pub_b64));
    env.insert("recipients".into(), Value::Object(recipients));
    env.insert("iv".into(), Value::String(b64(&content_iv)));
    env.insert("ct".into(), Value::String(b64(&ct)));
    env.insert("sig".into(), Value::String(b64(&sig)));
    let json = serde_json::to_vec(&Value::Object(env)).expect("serialisable");
    Ok(Encrypted { envelope_b64: b64(&json), wrapped_device_ids: wrapped, otp_device_ids: otp_wrapped })
}

/// A successfully opened envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decrypted {
    /// `JSON.stringify(wrapper.c)` — the `ClientContent`.
    pub content_json: String,
    pub sender_identity_pub_b64: String,
    pub sender_user_id: Option<String>,
    pub sender_device_id: Option<String>,
    /// Canonical base64 of the ephemeral key. The caller adds it to the replay ledger once the
    /// message is stored.
    pub eph_key_b64: String,
    /// The one-time prekey this envelope used. The caller burns it once the message is stored.
    pub otp_consumed: Option<u32>,
}

/// Open a v:3 envelope addressed to `my_device_id`.
///
/// `otp_lookup(id)` returns the private bytes of a one-time prekey this device still holds.
/// Replay checking is the caller's (it owns the ledger): check [`peek_eph_key`] before calling.
pub fn decrypt_v3(
    envelope_b64: &str,
    my_device_id: &str,
    spk_priv: &[u8],
    otp_lookup: impl Fn(u32) -> Option<Zeroizing<[u8; 32]>>,
) -> Result<Decrypted, EnvelopeError> {
    let raw = from_b64(envelope_b64).map_err(|_| EnvelopeError::Malformed("not base64".into()))?;
    let env: Value = serde_json::from_slice(&raw).map_err(|_| EnvelopeError::Malformed("not JSON".into()))?;
    if env.get("v").and_then(Value::as_u64) != Some(ENVELOPE_VERSION) {
        return Err(EnvelopeError::Legacy);
    }
    let field = |k: &str| env.get(k).and_then(Value::as_str).ok_or_else(|| EnvelopeError::Malformed(format!("missing {k}")));
    let eph_bytes = from_b64(field("eph")?).map_err(|_| EnvelopeError::Malformed("eph".into()))?;
    let eph_pub: [u8; 32] = eph_bytes.as_slice().try_into().map_err(|_| EnvelopeError::Malformed("eph is not 32 bytes".into()))?;
    let recipients = env.get("recipients").and_then(Value::as_object).ok_or_else(|| EnvelopeError::Malformed("recipients".into()))?;
    let mine = recipients.get(my_device_id).ok_or(EnvelopeError::NoRecipientEntry)?;
    let wrap_b64 = mine.get("wrap").and_then(Value::as_str).ok_or(EnvelopeError::NoRecipientEntry)?;
    // An id outside u32 is malformed (desktop's writeUInt32BE throws); never truncate it onto another prekey.
    let otp_id = match mine.get("otp_id").and_then(Value::as_u64) {
        Some(v) => Some(u32::try_from(v).map_err(|_| EnvelopeError::Malformed("otp_id out of range".into()))?),
        None => None,
    };

    let spk = x25519_secret(spk_priv).map_err(|e| EnvelopeError::Malformed(e.to_string()))?;
    let eph = PublicKey::from(eph_pub);
    let shared_spk = ecdh(&spk, &eph).ok_or(EnvelopeError::LowOrderPoint)?;

    let mut otp_consumed = None;
    let ikm: Zeroizing<Vec<u8>> = match otp_id.and_then(|id| otp_lookup(id).map(|k| (id, k))) {
        Some((id, otp_priv)) => {
            let otp = x25519_secret(otp_priv.as_ref()).map_err(|e| EnvelopeError::Malformed(e.to_string()))?;
            let shared_otp = ecdh(&otp, &eph).ok_or(EnvelopeError::LowOrderPoint)?;
            otp_consumed = Some(id);
            let mut v = Zeroizing::new(Vec::with_capacity(64));
            v.extend_from_slice(shared_spk.as_ref());
            v.extend_from_slice(shared_otp.as_ref());
            v
        }
        // An OTP this device no longer holds: SPK-only fallback, as desktop does.
        None => Zeroizing::new(shared_spk.to_vec()),
    };
    let wrap_key = derive_wrap_key(&ikm, &eph_pub, my_device_id, otp_consumed);

    // wrap = IV ‖ tag ‖ ciphertext.
    let wrap = from_b64(wrap_b64).map_err(|_| EnvelopeError::Malformed("wrap".into()))?;
    if wrap.len() < IV_LEN + TAG_LEN {
        return Err(EnvelopeError::WrapAuthFailed);
    }
    let (iv, rest) = wrap.split_at(IV_LEN);
    let (tag, body) = rest.split_at(TAG_LEN);
    let mut ct_tag = body.to_vec();
    ct_tag.extend_from_slice(tag);
    let content_key = Zeroizing::new(
        Aes256Gcm::new_from_slice(wrap_key.as_ref())
            .expect("32-byte key")
            .decrypt(Nonce::from_slice(iv), ct_tag.as_slice())
            .map_err(|_| EnvelopeError::WrapAuthFailed)?,
    );

    let sorted = sorted_csv(recipients.keys());
    let mut aad = Vec::with_capacity(32 + sorted.len());
    aad.extend_from_slice(&eph_pub);
    aad.extend_from_slice(sorted.as_bytes());
    let content_iv = from_b64(field("iv")?).map_err(|_| EnvelopeError::Malformed("iv".into()))?;
    if content_iv.len() != IV_LEN {
        return Err(EnvelopeError::Malformed("iv is not 12 bytes".into()));
    }
    let ct = from_b64(field("ct")?).map_err(|_| EnvelopeError::Malformed("ct".into()))?;
    let plaintext = Zeroizing::new(
        Aes256Gcm::new_from_slice(&content_key)
            .map_err(|_| EnvelopeError::WrapAuthFailed)?
            .decrypt(Nonce::from_slice(&content_iv), Payload { msg: &ct, aad: &aad })
            .map_err(|_| EnvelopeError::ContentAuthFailed)?,
    );

    let wrapper: Value = serde_json::from_slice(&plaintext).map_err(|_| EnvelopeError::Malformed("wrapper JSON".into()))?;
    let sp = wrapper.get("sp").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or(EnvelopeError::SigInvalid)?;
    let sig = env.get("sig").and_then(Value::as_str).ok_or(EnvelopeError::SigInvalid)?;
    let sig = from_b64(sig).map_err(|_| EnvelopeError::SigInvalid)?;
    if !verify(sp, &transcript_hash(&eph_pub, &content_iv, &ct, &sorted), &sig) {
        return Err(EnvelopeError::SigInvalid);
    }

    let content = wrapper.get("c").cloned().unwrap_or(Value::Null);
    Ok(Decrypted {
        content_json: serde_json::to_string(&content).expect("serialisable"),
        sender_identity_pub_b64: sp.to_owned(),
        sender_user_id: wrapper.get("su").and_then(Value::as_str).map(str::to_owned),
        sender_device_id: wrapper.get("sd").and_then(Value::as_str).map(str::to_owned),
        eph_key_b64: b64(&eph_pub),
        otp_consumed,
    })
}

/// The canonical ephemeral key of an envelope, for the caller's replay check BEFORE decrypting.
pub fn peek_eph_key(envelope_b64: &str) -> Result<String, EnvelopeError> {
    let raw = from_b64(envelope_b64).map_err(|_| EnvelopeError::Malformed("not base64".into()))?;
    let env: Value = serde_json::from_slice(&raw).map_err(|_| EnvelopeError::Malformed("not JSON".into()))?;
    let eph = env.get("eph").and_then(Value::as_str).ok_or_else(|| EnvelopeError::Malformed("missing eph".into()))?;
    let bytes = from_b64(eph).map_err(|_| EnvelopeError::Malformed("eph".into()))?;
    if bytes.len() != 32 {
        return Err(EnvelopeError::Malformed("eph is not 32 bytes".into()));
    }
    Ok(b64(&bytes))
}

/// The one-time prekey id the envelope's entry for `my_device_id` names (None: no entry, or a signed-prekey-only wrap).
/// For diagnosing a failed open only; never used to decide anything about a key.
pub fn peek_otp_id(envelope_b64: &str, my_device_id: &str) -> Option<u32> {
    let raw = from_b64(envelope_b64).ok()?;
    let env: Value = serde_json::from_slice(&raw).ok()?;
    let id = env.get("recipients")?.get(my_device_id)?.get("otp_id")?.as_u64()?;
    u32::try_from(id).ok()
}

impl From<CryptoError> for EnvelopeError {
    fn from(e: CryptoError) -> Self {
        EnvelopeError::Malformed(e.to_string())
    }
}
