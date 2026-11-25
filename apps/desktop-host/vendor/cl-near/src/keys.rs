//! Section 2: the key schedule.
//!
//! ```text
//! S       = X25519(eN, eA)
//! K       = HKDF-SHA256(ikm = S, salt = s, info = "cipherline-near:v1:" + linkId)      32 bytes
//! K_conf  = HKDF-Expand(K, "confirm", 32)     K_relay = HKDF-Expand(K, "relay", 32)
//! K_ble   = HKDF-Expand(K, "ble", 16)         K_lan   = HKDF-Expand(K, "lan", 32)
//! K_xfer  = HKDF-Expand(K, "xfer", 32)        (reserved)
//! ```
//! An all-zero `S` (a low-order peer key) is refused. Every secret is zeroed on drop.
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize, Zeroizing};

use crate::error::{NearError, Result};

/// A fresh X25519 pair: (private, public).
pub fn generate_keypair() -> (Zeroizing<[u8; 32]>, [u8; 32]) {
    let sk = StaticSecret::random_from_rng(rand_core::OsRng);
    let pk = PublicKey::from(&sk);
    (Zeroizing::new(sk.to_bytes()), *pk.as_bytes())
}

pub fn public_of(private: &[u8; 32]) -> [u8; 32] {
    *PublicKey::from(&StaticSecret::from(*private)).as_bytes()
}

/// `S = X25519(private, peer_pub)`; refuses an all-zero result.
pub fn dh(private: &[u8; 32], peer_pub: &[u8; 32]) -> Result<Zeroizing<[u8; 32]>> {
    let shared = StaticSecret::from(*private).diffie_hellman(&PublicKey::from(*peer_pub));
    if !shared.was_contributory() {
        return Err(NearError::Auth("low-order peer key"));
    }
    Ok(Zeroizing::new(shared.to_bytes()))
}

/// All per-session keys. `Debug` is redacted; every field is zeroed on drop.
pub struct SessionKeys {
    pub conf: Zeroizing<[u8; 32]>,
    pub relay: Zeroizing<[u8; 32]>,
    pub ble: Zeroizing<[u8; 16]>,
    pub lan: Zeroizing<[u8; 32]>,
    pub xfer: Zeroizing<[u8; 32]>,
}

impl std::fmt::Debug for SessionKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("SessionKeys(..)") }
}

impl Clone for SessionKeys {
    fn clone(&self) -> Self {
        Self {
            conf: self.conf.clone(),
            relay: self.relay.clone(),
            ble: self.ble.clone(),
            lan: self.lan.clone(),
            xfer: self.xfer.clone(),
        }
    }
}

/// Derive from an already-computed `S`. `salt` is the 16-byte proximity secret `s` for scanned flows
/// and the `nonce` for the own-device flow of section 7.
pub fn derive(shared: &[u8; 32], salt: &[u8], link_id: &str) -> Result<SessionKeys> {
    derive_with_k(shared, salt, link_id).map(|(keys, _)| keys)
}

/// As [`derive`] but also returns `K` itself, for known-answer vectors. `K` is zeroed on drop.
pub(crate) fn derive_with_k(shared: &[u8; 32], salt: &[u8], link_id: &str) -> Result<(SessionKeys, Zeroizing<[u8; 32]>)> {
    if link_id.is_empty() {
        return Err(NearError::Malformed("empty link id"));
    }
    if shared.iter().all(|b| *b == 0) {
        return Err(NearError::Auth("all-zero shared secret"));
    }
    let mut info = b"cipherline-near:v1:".to_vec();
    info.extend_from_slice(link_id.as_bytes());
    let hk = Hkdf::<Sha256>::new(Some(salt), shared);
    let mut k = Zeroizing::new([0u8; 32]);
    hk.expand(&info, k.as_mut()).expect("32 bytes");
    let prk = Hkdf::<Sha256>::from_prk(k.as_ref()).expect("32-byte PRK");
    let mut out = SessionKeys {
        conf: Zeroizing::new([0; 32]),
        relay: Zeroizing::new([0; 32]),
        ble: Zeroizing::new([0; 16]),
        lan: Zeroizing::new([0; 32]),
        xfer: Zeroizing::new([0; 32]),
    };
    prk.expand(b"confirm", out.conf.as_mut()).expect("len");
    prk.expand(b"relay", out.relay.as_mut()).expect("len");
    prk.expand(b"ble", out.ble.as_mut()).expect("len");
    prk.expand(b"lan", out.lan.as_mut()).expect("len");
    prk.expand(b"xfer", out.xfer.as_mut()).expect("len");
    info.zeroize();
    Ok((out, k))
}

/// `S = X25519(my_private, peer_pub)` then [`derive`].
pub fn session_keys(my_private: &[u8; 32], peer_pub: &[u8; 32], salt: &[u8], link_id: &str) -> Result<SessionKeys> {
    let s = dh(my_private, peer_pub)?;
    derive(&s, salt, link_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_sides_agree_and_labels_separate() {
        let (en, en_pub) = generate_keypair();
        let (ea, ea_pub) = generate_keypair();
        let a = session_keys(&ea, &en_pub, &[1; 16], "link").unwrap();
        let n = session_keys(&en, &ea_pub, &[1; 16], "link").unwrap();
        assert_eq!(*a.conf, *n.conf);
        assert_eq!(*a.relay, *n.relay);
        assert_eq!(*a.ble, *n.ble);
        assert_eq!(*a.lan, *n.lan);
        assert_eq!(*a.xfer, *n.xfer);
        let all = [&*a.conf, &*a.relay, &*a.lan, &*a.xfer];
        for i in 0..4 {
            for j in i + 1..4 {
                assert_ne!(all[i], all[j]);
            }
        }
        assert_ne!(&a.conf[..16], &a.ble[..]);
    }

    #[test]
    fn every_input_matters() {
        let (en, _) = generate_keypair();
        let (_, ea_pub) = generate_keypair();
        let base = session_keys(&en, &ea_pub, &[1; 16], "link").unwrap();
        assert_ne!(*base.conf, *session_keys(&en, &ea_pub, &[2; 16], "link").unwrap().conf, "salt");
        assert_ne!(*base.conf, *session_keys(&en, &ea_pub, &[1; 16], "link2").unwrap().conf, "link id");
        let (_, other_pub) = generate_keypair();
        assert_ne!(*base.conf, *session_keys(&en, &other_pub, &[1; 16], "link").unwrap().conf, "peer key");
    }

    #[test]
    fn low_order_and_zero_are_refused() {
        let (sk, _) = generate_keypair();
        // the all-zero public key is a low-order point: X25519 yields the all-zero secret
        assert!(dh(&sk, &[0u8; 32]).is_err());
        // so is the point of order 1 (u = 1) and order 8 (u = 325606...)
        let mut one = [0u8; 32];
        one[0] = 1;
        assert!(dh(&sk, &one).is_err());
        assert!(derive(&[0u8; 32], &[1; 16], "l").is_err());
        assert!(derive(&[1u8; 32], &[1; 16], "").is_err());
    }
}
