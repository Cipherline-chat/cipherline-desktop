//! Section 5: the v2 approval string the approving device signs (Ed25519, with its device identity key).
//!
//! `cipherline-link-approve:v2:<userId>:<approverDeviceId>:<linkId>:<newIdentityKeyB64>:<proximity>:<ts>`
//!
//! Same style as cl-crypto's v1 builder (`cipherline-link-approve:v1:...:<ts>`), plus the proximity method
//! that was actually verified. Every field is refused if empty or if it contains `:`, so no field can bleed
//! into its neighbour and change what was signed.
use crate::error::{NearError, Result};
use crate::proof::ProximityProof;

pub const LINK_APPROVE_V2_PREFIX: &str = "cipherline-link-approve:v2";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Proximity {
    Ble,
    Lan,
}

impl Proximity {
    pub fn as_str(self) -> &'static str { match self { Proximity::Ble => "ble", Proximity::Lan => "lan" } }
}

fn field(s: &str, what: &'static str) -> Result<()> {
    if s.is_empty() || s.contains(':') || s.chars().any(|c| c.is_control() || c.is_whitespace()) { Err(NearError::Malformed(what)) } else { Ok(()) }
}

/// Requires the proof A itself verified: there is no way to call this after `hello` alone. The proof must
/// belong to `link_id`; the proximity value signed is the proof's method.
pub fn link_approve_message_v2(user_id: &str, approver_device_id: &str, link_id: &str, new_identity_key_b64: &str, proof: &ProximityProof, ts: i64) -> Result<String> {
    if proof.link_id() != link_id { return Err(NearError::NoProof("proof belongs to another session")); }
    let proximity = proof.method();
    field(user_id, "user id")?;
    field(approver_device_id, "approver device id")?;
    field(link_id, "link id")?;
    field(new_identity_key_b64, "identity key")?;
    Ok(format!("{LINK_APPROVE_V2_PREFIX}:{user_id}:{approver_device_id}:{link_id}:{new_identity_key_b64}:{}:{ts}", proximity.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_string() {
        let s = link_approve_message_v2("u-1", "d-1", "AQEBAQEBAQEBAQEBAQEBAQ", "a2V5/+=", &ProximityProof::for_tests(Proximity::Ble, "AQEBAQEBAQEBAQEBAQEBAQ"), 1_763_500_000).unwrap();
        assert_eq!(s, "cipherline-link-approve:v2:u-1:d-1:AQEBAQEBAQEBAQEBAQEBAQ:a2V5/+=:ble:1763500000");
        let s = link_approve_message_v2("u-1", "d-1", "L", "K", &ProximityProof::for_tests(Proximity::Lan, "L"), -5).unwrap();
        assert!(s.ends_with(":lan:-5"));
    }

    #[test]
    fn injection_is_refused() {
        let p = ProximityProof::for_tests(Proximity::Ble, "l");
        for bad in ["", "a:b", "a b", "a\n", "a\u{0}"] {
            assert!(link_approve_message_v2(bad, "d", "l", "k", &p, 1).is_err(), "{bad:?}");
            assert!(link_approve_message_v2("u", bad, "l", "k", &p, 1).is_err());
            assert!(link_approve_message_v2("u", "d", bad, "k", &ProximityProof::for_tests(Proximity::Ble, bad), 1).is_err());
            assert!(link_approve_message_v2("u", "d", "l", bad, &p, 1).is_err());
        }
    }

    #[test]
    fn a_proof_for_another_session_is_refused() {
        let p = ProximityProof::for_tests(Proximity::Lan, "other");
        assert!(matches!(link_approve_message_v2("u", "d", "l", "k", &p, 1), Err(NearError::NoProof(_))));
    }

    #[test]
    fn v1_and_v2_differ_in_prefix_only_shape() {
        let v1 = cl_crypto::link::link_approve_message("u", "d", "l", Some("k"), 7);
        let v2 = link_approve_message_v2("u", "d", "l", "k", &ProximityProof::for_tests(Proximity::Lan, "l"), 7).unwrap();
        assert_eq!(v1, "cipherline-link-approve:v1:u:d:l:k:7");
        assert_eq!(v2, "cipherline-link-approve:v2:u:d:l:k:lan:7");
        assert_ne!(v1.replace(":v1:", ":v2:"), v2, "a v1 signature can never validate a v2 string");
    }
}
