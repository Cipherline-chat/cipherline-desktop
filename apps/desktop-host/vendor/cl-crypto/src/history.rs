//! Device-to-device history transfer — the crypto half. Desktop `utils/historyRequestProof.ts`,
//! `utils/historyTransferKey.ts` and the `HistoryRequestModal` / `HistorySyncBanner` encryption.
//!
//! The protocol, in this layer's terms:
//!
//! 1. The NEW device signs a *capability advertisement* with its identity key:
//!    `cipherline-history-request:v1:<user>:<device>:<identity_b64>:wrapped:<ts>` (UTF-8,
//!    PureEdDSA). The server only relays it; the APPROVER verifies it against the identity key
//!    it reads for that device itself ([`verify_request_advertisement`]).
//! 2. The approver encrypts the history under a fresh AES-256-GCM key (`IV(12) ‖ ct ‖ tag`,
//!    [`seal_transfer`]), uploads the ciphertext, and delivers the KEY wrapped to the new
//!    device as an ordinary v:3 envelope ([`wrap_transfer_key`]) — the server never holds the
//!    key. There is no plaintext-key form: a delivery that carries one is refused upstream.
//! 3. The new device opens the envelope ([`open_transfer_key`]), which names the approver
//!    (user, device, identity key) inside the ciphertext; the caller judges that identity.
use ed25519_dalek::SigningKey;
use serde_json::{json, Value};
use zeroize::Zeroizing;

use crate::encoding::{b64, from_b64};
use crate::envelope::{self, Decrypted, EnvelopeError, RecipientDevice, SenderIdentity};
use crate::{blob, keys, CryptoError};

pub const REQUEST_PROOF_PREFIX: &str = "cipherline-history-request:v1";
pub const CAPABILITY_WRAPPED: &str = "wrapped";
/// The advertisement's timestamp must be within this many seconds of the verifier's clock.
pub const REQUEST_PROOF_WINDOW_S: i64 = 300;
/// How long an unanswered request stays acceptable on the requesting device.
pub const REQUEST_TTL_MS: i64 = 15 * 60 * 1000;
/// `device:history_declined` reason: the requester could not prove it can receive a wrapped key.
pub const REFUSED_LEGACY_REQUESTER: &str = "requester_cannot_receive_wrapped_key";
/// `device:history_declined` reason the MOBILE app sends when asked by a desktop that cannot
/// read a phone's format. This core writes desktop's format, so it never sends it.
pub const REFUSED_MOBILE_TO_DESKTOP: &str = "requester_cannot_import_mobile_history";
/// Plain "no" from the person at the approving device.
pub const DECLINED_BY_USER: &str = "user_declined";
pub const TRANSFER_KEY_TYPE: &str = "history_transfer_key";

pub fn request_proof_message(user_id: &str, requesting_device_id: &str, identity_key_pub_b64: &str, ts: i64) -> String {
    format!("{REQUEST_PROOF_PREFIX}:{user_id}:{requesting_device_id}:{identity_key_pub_b64}:{CAPABILITY_WRAPPED}:{ts}")
}

/// The requester's advertisement: `(identity_pub_b64, signature_b64)` over [`request_proof_message`].
pub fn sign_request_proof(identity: &SigningKey, user_id: &str, device_id: &str, ts: i64) -> (String, String) {
    let pubkey = b64(identity.verifying_key().as_bytes());
    let msg = request_proof_message(user_id, device_id, &pubkey, ts);
    let sig = b64(&keys::sign(identity, msg.as_bytes()));
    (pubkey, sig)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdvertisementRejection {
    NoSignature,
    NoTimestamp,
    StaleTimestamp,
    MalformedSignature,
    MalformedIdentityKey,
    BadSignature,
}

/// The approver's check. A missing and a forged signature are deliberately the same outcome
/// to the caller (decline with [`REFUSED_LEGACY_REQUESTER`]); the distinct variants are for tests.
pub fn verify_request_advertisement(
    user_id: &str,
    requesting_device_id: &str,
    identity_key_pub_b64: &str,
    capability_sig_b64: Option<&str>,
    capability_ts: Option<i64>,
    now_sec: i64,
) -> Result<(), AdvertisementRejection> {
    use AdvertisementRejection::*;
    let sig_b64 = capability_sig_b64.filter(|s| !s.is_empty()).ok_or(NoSignature)?;
    let ts = capability_ts.ok_or(NoTimestamp)?;
    if (now_sec - ts).abs() > REQUEST_PROOF_WINDOW_S {
        return Err(StaleTimestamp);
    }
    let sig = from_b64(sig_b64).map_err(|_| MalformedSignature)?;
    if sig.len() != 64 {
        return Err(MalformedSignature);
    }
    let pk = from_b64(identity_key_pub_b64).map_err(|_| MalformedIdentityKey)?;
    if pk.len() != 32 {
        return Err(MalformedIdentityKey);
    }
    let msg = request_proof_message(user_id, requesting_device_id, identity_key_pub_b64, ts);
    if keys::verify(identity_key_pub_b64, msg.as_bytes(), &sig) { Ok(()) } else { Err(BadSignature) }
}

/// A fresh one-time AES-256 transfer key.
pub fn new_transfer_key() -> Zeroizing<[u8; 32]> {
    blob::generate_file_key()
}

/// `IV(12) ‖ AES-256-GCM(plaintext) ‖ tag(16)` — what desktop uploads to `POST /history/upload`.
pub fn seal_transfer(key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
    blob::encrypt_with_key(key, plaintext)
}

pub fn open_transfer(key: &[u8], blob_bytes: &[u8]) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    blob::decrypt_with_key(key, blob_bytes)
}

/// The `history_transfer_key` payload. `request_ts` binds the delivery to the request it answers.
fn transfer_key_payload(key: &[u8; 32], target_device_id: &str, issued_at_iso: &str, request_ts: Option<i64>) -> Zeroizing<String> {
    let mut v = json!({ "type": TRANSFER_KEY_TYPE, "key_b64": b64(key), "device_id": target_device_id, "issued_at": issued_at_iso });
    if let Some(ts) = request_ts {
        v["request_ts"] = ts.into();
    }
    Zeroizing::new(v.to_string())
}

/// Approver: wrap `key` to the requesting device's signed prekey as a v:3 envelope. Fails
/// (rather than falling back to anything) when that device's prekey signature does not verify.
pub fn wrap_transfer_key(
    key: &[u8; 32],
    target: &RecipientDevice,
    sender: &SenderIdentity<'_>,
    issued_at_iso: &str,
    request_ts: Option<i64>,
) -> Result<String, EnvelopeError> {
    let payload = transfer_key_payload(key, &target.device_id, issued_at_iso, request_ts);
    let enc = envelope::encrypt_for_devices(&payload, sender, std::slice::from_ref(target), None)?;
    if !enc.wrapped_device_ids.iter().any(|d| d == &target.device_id) {
        return Err(EnvelopeError::WrapNone);
    }
    Ok(enc.envelope_b64)
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TransferKeyError {
    #[error("unexpected payload in the transfer-key envelope")]
    UnexpectedPayload,
    #[error("the transfer key was addressed to a different device")]
    WrongDevice,
    #[error("the transfer key is not a 32-byte key")]
    BadKey,
}

pub struct OpenedTransferKey {
    pub key: Zeroizing<[u8; 32]>,
    /// `request_ts` from the payload; `None` from an approver that predates the binding.
    pub request_ts: Option<i64>,
}

/// Parse a decrypted transfer-key payload and check it was addressed to `my_device_id`.
/// The envelope's sender is NOT judged here — see [`Decrypted::sender_user_id`] and friends.
pub fn open_transfer_key(content_json: &str, my_device_id: &str) -> Result<OpenedTransferKey, TransferKeyError> {
    let v: Value = serde_json::from_str(content_json).map_err(|_| TransferKeyError::UnexpectedPayload)?;
    let s = |k: &str| v.get(k).and_then(Value::as_str);
    if s("type") != Some(TRANSFER_KEY_TYPE) {
        return Err(TransferKeyError::UnexpectedPayload);
    }
    let key_b64 = s("key_b64").filter(|k| !k.is_empty()).ok_or(TransferKeyError::UnexpectedPayload)?;
    if s("device_id") != Some(my_device_id) {
        return Err(TransferKeyError::WrongDevice);
    }
    let raw = Zeroizing::new(from_b64(key_b64).map_err(|_| TransferKeyError::BadKey)?);
    let key: [u8; 32] = raw.as_slice().try_into().map_err(|_| TransferKeyError::BadKey)?;
    // Desktop: only a safe integer counts as a request timestamp.
    let request_ts = v.get("request_ts").and_then(Value::as_i64).filter(|t| t.unsigned_abs() <= (1u64 << 53) - 1);
    Ok(OpenedTransferKey { key: Zeroizing::new(key), request_ts })
}

/// Convenience for callers that hold a [`Decrypted`] envelope.
pub fn open_transfer_key_from(d: &Decrypted, my_device_id: &str) -> Result<OpenedTransferKey, TransferKeyError> {
    open_transfer_key(&d.content_json, my_device_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::ed25519_signing_key;

    const USER: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const DEV: &str = "dddddddd-dddd-dddd-dddd-dddddddddd01";
    const TS: i64 = 1_800_000_000;

    fn seed_key() -> SigningKey {
        let seed: Vec<u8> = (1u8..=32).collect();
        ed25519_signing_key(&seed).unwrap()
    }

    /// Vector produced by desktop's `@noble/curves` ed25519 over `historyRequestProofMessage`.
    #[test]
    fn proof_matches_the_desktop_vector() {
        let (pubkey, sig) = sign_request_proof(&seed_key(), USER, DEV, TS);
        assert_eq!(pubkey, "ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=");
        assert_eq!(
            request_proof_message(USER, DEV, &pubkey, TS),
            "cipherline-history-request:v1:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:dddddddd-dddd-dddd-dddd-dddddddddd01:ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=:wrapped:1800000000"
        );
        assert_eq!(sig, "dOaKBrh7jGXP4dXwwN1rcWEBWh0Ia6+bCvnopUoO536gQ4lnG74cPnPf7Z8jietnXCm37dqzKFbDSLP9CFAhCg==");
    }

    #[test]
    fn advertisement_verification_cases() {
        use AdvertisementRejection::*;
        let (pubkey, sig) = sign_request_proof(&seed_key(), USER, DEV, TS);
        let ok = |sig: Option<&str>, ts: Option<i64>, now: i64| verify_request_advertisement(USER, DEV, &pubkey, sig, ts, now);
        // Positive control first: without it every refusal below could be a broken helper.
        assert_eq!(ok(Some(&sig), Some(TS), TS), Ok(()));
        assert_eq!(ok(Some(&sig), Some(TS), TS + 300), Ok(()));
        assert_eq!(ok(None, Some(TS), TS), Err(NoSignature));
        assert_eq!(ok(Some(""), Some(TS), TS), Err(NoSignature));
        assert_eq!(ok(Some(&sig), None, TS), Err(NoTimestamp));
        assert_eq!(ok(Some(&sig), Some(TS), TS + 301), Err(StaleTimestamp));
        assert_eq!(ok(Some(&sig), Some(TS), TS - 301), Err(StaleTimestamp));
        assert_eq!(ok(Some("!!!"), Some(TS), TS), Err(MalformedSignature));
        assert_eq!(ok(Some(&b64(&[1u8; 63])), Some(TS), TS), Err(MalformedSignature));
        assert_eq!(ok(Some(&b64(&[1u8; 64])), Some(TS), TS), Err(BadSignature));
        // Replay across device, account and time.
        assert_eq!(verify_request_advertisement(USER, "other-device", &pubkey, Some(&sig), Some(TS), TS), Err(BadSignature));
        assert_eq!(verify_request_advertisement("other-user", DEV, &pubkey, Some(&sig), Some(TS), TS), Err(BadSignature));
        assert_eq!(verify_request_advertisement(USER, DEV, &pubkey, Some(&sig), Some(TS + 1), TS), Err(BadSignature));
        // A different identity key.
        let other = b64(crate::keys::generate_ed25519().verifying_key().as_bytes());
        assert_eq!(verify_request_advertisement(USER, DEV, &other, Some(&sig), Some(TS), TS), Err(BadSignature));
        assert_eq!(verify_request_advertisement(USER, DEV, &b64(&[1u8; 5]), Some(&sig), Some(TS), TS), Err(MalformedIdentityKey));
    }

    /// Vector produced by desktop's WebCrypto: key bytes 255,254,…; IV bytes 0,3,6,…
    #[test]
    fn transfer_blob_matches_the_desktop_vector() {
        let key = from_b64("//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA=").unwrap();
        let blob_bytes = from_b64("AAMGCQwPEhUYGx4hUOs9I40QVPN1LaGFwYCkaA1dJrdxajQIUrt/B4cg/mXh1V5RWC7oZtcJIc+uzVBxdD1DdAVoz3dkrYCsBI7v/0Md+g7WeQT31uCK/CV7GNSgerAsWo23FntKmZd2Wma0JLBugEH9").unwrap();
        let plain = open_transfer(&key, &blob_bytes).unwrap();
        assert_eq!(
            std::str::from_utf8(&plain).unwrap(),
            r#"{"version":4,"userId":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","topics":[],"history":{}}"#
        );
        // Our own seal opens with the same routine, and a flipped bit is refused.
        let sealed = seal_transfer(&key, b"hello").unwrap();
        assert_eq!(&*open_transfer(&key, &sealed).unwrap(), b"hello");
        let mut bad = sealed.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(open_transfer(&key, &bad).is_err());
        assert!(open_transfer(&key, &sealed[..20]).is_err());
    }

    #[test]
    fn transfer_key_payload_round_trips_through_a_real_envelope() {
        // Approver (identity A) wraps to the requester's device; the requester opens it.
        let approver = crate::keys::generate_ed25519();
        let approver_pub = b64(approver.verifying_key().as_bytes());
        let requester = crate::keys::generate_ed25519();
        let bundle = crate::identity::generate_bundle(&requester);
        let target = RecipientDevice {
            device_id: DEV.into(),
            identity_pub_b64: bundle.identity_key_pub_b64.clone(),
            spk_pub_b64: bundle.signed_prekey.pub_b64.clone(),
            spk_sig_b64: bundle.signed_prekey.sig_b64.clone(),
            otp: None,
        };
        let sender = SenderIdentity { signing_key: &approver, identity_pub_b64: &approver_pub, user_id: USER, device_id: Some("approver-dev") };
        let key = new_transfer_key();
        let env = wrap_transfer_key(&key, &target, &sender, "2026-11-12T00:00:00.000Z", Some(TS)).unwrap();
        let dec = envelope::decrypt_v3(&env, DEV, bundle.signed_prekey.private.as_ref(), |_| None).unwrap();
        assert_eq!((dec.sender_user_id.as_deref(), dec.sender_device_id.as_deref()), (Some(USER), Some("approver-dev")));
        assert_eq!(dec.sender_identity_pub_b64, approver_pub);
        let opened = open_transfer_key_from(&dec, DEV).unwrap();
        assert_eq!((*opened.key, opened.request_ts), (*key, Some(TS)));
        // Addressed to another device: refused even if that device could open the envelope.
        assert_eq!(open_transfer_key_from(&dec, "someone-else").err(), Some(TransferKeyError::WrongDevice));
        // Another device cannot even open it (structural targeting).
        assert!(envelope::decrypt_v3(&env, "someone-else", bundle.signed_prekey.private.as_ref(), |_| None).is_err());
        // A tampered spk signature is refused rather than wrapped to.
        let mut bad = target.clone();
        bad.spk_sig_b64 = b64(&[7u8; 64]);
        assert!(wrap_transfer_key(&key, &bad, &sender, "t", None).is_err());
    }

    #[test]
    fn transfer_key_payload_parsing_is_strict() {
        let good = |extra: &str| format!(r#"{{"type":"history_transfer_key","key_b64":"{}","device_id":"d"{extra}}}"#, b64(&[9u8; 32]));
        assert!(open_transfer_key(&good(""), "d").is_ok());
        assert_eq!(open_transfer_key(&good(r#","request_ts":12"#), "d").unwrap().request_ts, Some(12));
        assert_eq!(open_transfer_key(&good(r#","request_ts":1.5"#), "d").unwrap().request_ts, None);
        assert_eq!(open_transfer_key(&good(r#","request_ts":"12""#), "d").unwrap().request_ts, None);
        assert_eq!(open_transfer_key("not json", "d").err(), Some(TransferKeyError::UnexpectedPayload));
        assert_eq!(open_transfer_key(r#"{"type":"text","text":"x"}"#, "d").err(), Some(TransferKeyError::UnexpectedPayload));
        assert_eq!(open_transfer_key(&good(""), "e").err(), Some(TransferKeyError::WrongDevice));
        let short = format!(r#"{{"type":"history_transfer_key","key_b64":"{}","device_id":"d"}}"#, b64(&[1u8; 16]));
        assert_eq!(open_transfer_key(&short, "d").err(), Some(TransferKeyError::BadKey));
    }
}
