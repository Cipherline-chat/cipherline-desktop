//! X25519 / Ed25519 key handling. Private keys are the raw 32 bytes the desktop stores as
//! hex (the JWK `d`); public keys are the raw 32 bytes, base64 on the wire.
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand_core::OsRng;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::encoding::{b64, from_b64};
use crate::CryptoError;

fn arr32(bytes: &[u8], what: &str) -> Result<[u8; 32], CryptoError> {
    bytes.try_into().map_err(|_| CryptoError::InvalidInput(format!("{what} must be 32 bytes, got {}", bytes.len())))
}

pub fn x25519_pub_from_b64(s: &str) -> Result<PublicKey, CryptoError> {
    Ok(PublicKey::from(arr32(&from_b64(s)?, "X25519 public key")?))
}

pub fn x25519_secret(raw: &[u8]) -> Result<StaticSecret, CryptoError> {
    Ok(StaticSecret::from(arr32(raw, "X25519 private key")?))
}

/// A fresh X25519 pair: (private raw bytes, public base64).
pub fn generate_x25519() -> (Zeroizing<[u8; 32]>, String) {
    let secret = StaticSecret::random_from_rng(OsRng);
    let public = PublicKey::from(&secret);
    (Zeroizing::new(secret.to_bytes()), b64(public.as_bytes()))
}

/// ECDH. Returns `None` for an all-zero result (a low-order point), which callers must refuse.
/// The X25519 public key (base64) that belongs to `private`.
pub fn x25519_public_b64(private: &[u8; 32]) -> String {
    crate::encoding::b64(PublicKey::from(&StaticSecret::from(*private)).as_bytes())
}

pub fn ecdh(secret: &StaticSecret, public: &PublicKey) -> Option<Zeroizing<[u8; 32]>> {
    let shared = secret.diffie_hellman(public);
    if !shared.was_contributory() {
        return None;
    }
    Some(Zeroizing::new(shared.to_bytes()))
}

/// An Ed25519 identity from its 32-byte seed (the desktop's `identity_priv`).
pub fn ed25519_signing_key(seed: &[u8]) -> Result<SigningKey, CryptoError> {
    Ok(SigningKey::from_bytes(&arr32(seed, "Ed25519 private key")?))
}

pub fn generate_ed25519() -> SigningKey {
    let mut seed = Zeroizing::new([0u8; 32]);
    rand_core::RngCore::fill_bytes(&mut OsRng, seed.as_mut());
    SigningKey::from_bytes(&seed)
}

pub fn sign(key: &SigningKey, data: &[u8]) -> [u8; 64] {
    key.sign(data).to_bytes()
}

/// Ed25519 verify. `false` — never an error — for a malformed key or signature, so a hostile
/// peer cannot turn a bad key into an exception path.
pub fn verify(pub_b64: &str, data: &[u8], signature: &[u8]) -> bool {
    let Ok(pk_bytes) = from_b64(pub_b64) else { return false };
    let Ok(pk_arr) = <[u8; 32]>::try_from(pk_bytes.as_slice()) else { return false };
    let Ok(vk) = VerifyingKey::from_bytes(&pk_arr) else { return false };
    let Ok(sig_arr) = <[u8; 64]>::try_from(signature) else { return false };
    // Strict: rejects small-order public keys and non-canonical signatures. Every honest signer (this crate, desktop's
    // @noble/ed25519) produces canonical signatures over a non-small-order key, so only adversarial inputs differ.
    vk.verify_strict(data, &Signature::from_bytes(&sig_arr)).is_ok()
}

#[cfg(test)]
mod strict_tests {
    use super::*;
    use ed25519_dalek::Verifier;

    #[test]
    fn an_honest_signature_verifies_and_a_small_order_key_forgery_does_not() {
        let key = generate_ed25519();
        let pubk = crate::encoding::b64(key.verifying_key().as_bytes());
        let sig = sign(&key, b"hello");
        assert!(verify(&pubk, b"hello", &sig));
        assert!(!verify(&pubk, b"other", &sig));
        // L7: the identity element as public key and (R = identity, S = 0) "signs" ANY message under the lenient rule.
        let mut identity_point = [0u8; 32];
        identity_point[0] = 1;
        let forged = {
            let mut s = [0u8; 64];
            s[0] = 1;
            s
        };
        assert!(VerifyingKey::from_bytes(&identity_point).unwrap().verify(b"anything", &Signature::from_bytes(&forged)).is_ok(), "control: the lenient rule accepts it");
        assert!(!verify(&crate::encoding::b64(&identity_point), b"anything", &forged), "strict verification refuses it");
    }
}
