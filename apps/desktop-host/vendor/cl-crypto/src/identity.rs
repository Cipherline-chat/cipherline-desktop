//! Device identity: the Signal-style key bundle and the registration proof.
//!
//! Bundle — desktop `electron/signal-identity.ts` (`ensureSignalIdentity`,
//! `generateRotationBundle`): an Ed25519 identity key, a random registration id in
//! `[1, 16380)`, an X25519 signed prekey whose signature covers its RAW 32 public-key bytes
//! (not the base64 string), and 100 one-time prekeys. Rotation mints SPK id + 1 and OTP ids
//! continuing from the previous maximum; the old SPK private key must be kept so envelopes
//! already wrapped to it still open.
//!
//! Registration proof — API `devices/identity-proof.util.ts`: the new device signs
//! `cipherline-device-register:v1:<userId>:<identity_key_pub_b64>:<proofTs>` (UTF-8,
//! PureEdDSA) with its fresh identity key; the server accepts it within ±300 s.
use ed25519_dalek::SigningKey;
use rand_core::{OsRng, RngCore};
use zeroize::Zeroizing;

use crate::encoding::{b64, from_b64, from_b64_node};
use crate::keys;

pub const ONE_TIME_PREKEY_COUNT: u32 = 100;
pub const REGISTER_PROOF_WINDOW_S: i64 = 300;
const PROOF_PREFIX: &str = "cipherline-device-register:v1";

/// One X25519 prekey: the private half stays on the device.
#[derive(Clone)]
pub struct Prekey {
    pub id: u32,
    pub private: Zeroizing<[u8; 32]>,
    pub pub_b64: String,
}

#[derive(Clone)]
pub struct SignedPrekey {
    pub id: u32,
    pub private: Zeroizing<[u8; 32]>,
    pub pub_b64: String,
    pub sig_b64: String,
}

/// What `POST /v1/keys/upload_bundle` carries, minus `device_id`.
#[derive(Clone)]
pub struct KeyBundle {
    pub identity_key_pub_b64: String,
    pub registration_id: u32,
    pub signed_prekey: SignedPrekey,
    pub one_time_prekeys: Vec<Prekey>,
}

fn new_prekey(id: u32) -> Prekey {
    let (private, pub_b64) = keys::generate_x25519();
    Prekey { id, private, pub_b64 }
}

/// A signed prekey, signed by `identity` over the raw public-key bytes.
pub fn new_signed_prekey(identity: &SigningKey, id: u32) -> SignedPrekey {
    let (private, pub_b64) = keys::generate_x25519();
    let raw = from_b64(&pub_b64).expect("own encoding");
    SignedPrekey { id, private, sig_b64: b64(&keys::sign(identity, &raw)), pub_b64 }
}

/// A brand-new device identity: the bundle for `upload_bundle` (the identity's own seed is
/// `identity.to_bytes()`, stored by the platform keystore, never sent).
pub fn generate_bundle(identity: &SigningKey) -> KeyBundle {
    KeyBundle {
        identity_key_pub_b64: b64(identity.verifying_key().as_bytes()),
        registration_id: 1 + OsRng.next_u32() % 16_379,
        signed_prekey: new_signed_prekey(identity, 1),
        one_time_prekeys: (1..=ONE_TIME_PREKEY_COUNT).map(new_prekey).collect(),
    }
}

/// A rotation: the next SPK id and 100 OTPs numbered on from `previous_max_otp_id`.
pub fn rotation_bundle(identity: &SigningKey, registration_id: u32, previous_spk_id: u32, previous_max_otp_id: u32) -> KeyBundle {
    KeyBundle {
        identity_key_pub_b64: b64(identity.verifying_key().as_bytes()),
        registration_id,
        signed_prekey: new_signed_prekey(identity, previous_spk_id + 1),
        one_time_prekeys: (1..=ONE_TIME_PREKEY_COUNT).map(|i| new_prekey(previous_max_otp_id + i)).collect(),
    }
}

/// API `verifySignedPrekey`: the identity key's signature over the raw SPK public key.
pub fn verify_signed_prekey(identity_key_b64: &str, spk_pub_b64: &str, spk_sig_b64: &str) -> bool {
    let spk = from_b64_node(spk_pub_b64);
    let sig = from_b64_node(spk_sig_b64);
    spk.len() == 32 && sig.len() == 64 && keys::verify(identity_key_b64, &spk, &sig)
}

pub fn register_proof_message(user_id: &str, identity_key_b64: &str, proof_ts: i64) -> String {
    format!("{PROOF_PREFIX}:{user_id}:{identity_key_b64}:{proof_ts}")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegistrationProof {
    pub identity_key_pub_b64: String,
    pub proof_ts: i64,
    pub proof_sig_b64: String,
}

pub fn sign_register_proof(identity: &SigningKey, user_id: &str, now_ms: i64) -> RegistrationProof {
    let identity_key_pub_b64 = b64(identity.verifying_key().as_bytes());
    let proof_ts = now_ms.div_euclid(1000);
    let msg = register_proof_message(user_id, &identity_key_pub_b64, proof_ts);
    RegistrationProof { proof_sig_b64: b64(&keys::sign(identity, msg.as_bytes())), identity_key_pub_b64, proof_ts }
}

/// API `verifyRegisterProof`, for tests and the self-test: fresh within ±300 s, a 32-byte key,
/// a 64-byte signature over the exact message.
pub fn verify_register_proof(user_id: &str, identity_key_b64: &str, proof_sig_b64: &str, proof_ts: i64, now_sec: i64) -> bool {
    if identity_key_b64.is_empty() || proof_sig_b64.is_empty() || (now_sec - proof_ts).abs() > REGISTER_PROOF_WINDOW_S {
        return false;
    }
    let key = from_b64_node(identity_key_b64);
    let sig = from_b64_node(proof_sig_b64);
    if key.len() != 32 || sig.len() != 64 {
        return false;
    }
    let msg = register_proof_message(user_id, identity_key_b64, proof_ts);
    keys::verify(&b64(&key), msg.as_bytes(), &sig)
}
