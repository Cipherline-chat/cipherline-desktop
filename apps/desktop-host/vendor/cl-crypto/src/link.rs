//! QR sign-in / device linking crypto — byte-compatible with desktop `electron/link-grant.ts`
//! and `apps/api/src/devices/device-approval.util.ts`.
//!
//! Grant = X25519 seal-to-a-public-key: `key = HKDF-SHA256(ecdh, salt = es_pub ‖ ek_pub,
//! info = LABEL ‖ ":" ‖ linkId)`, AES-256-GCM with the same string as AAD, envelope =
//! base64(JSON{v, es_pub_b64, nonce_b64, ct_b64}). Ported, not invented.
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::encoding::{b64, from_b64_node};
use crate::{keys, CryptoError};

pub const LINK_GRANT_LABEL: &str = "cipherline-link-grant:v1";
pub const LINK_GRANT_VERSION: u64 = 1;
const FP_ALPHABET: &[u8; 32] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

fn bad(m: &str) -> CryptoError { CryptoError::InvalidInput(m.into()) }

/// A decrypted grant (v1 tokens inside, v2 claim secret).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkGrant {
    pub v: u8,
    pub link_id: String,
    pub user_id: String,
    pub claim_secret: Option<String>,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub approved_by_device_id: String,
    pub approved_by_device_name: String,
}

fn pub32(b64s: &str, what: &str) -> Result<[u8; 32], CryptoError> {
    from_b64_node(b64s).try_into().map_err(|_| bad(&format!("{what} must be exactly 32 bytes")))
}

fn derive(shared: &[u8; 32], es_pub: &[u8; 32], ek_pub: &[u8; 32], link_id: &str) -> Zeroizing<[u8; 32]> {
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(es_pub);
    salt[32..].copy_from_slice(ek_pub);
    let info = format!("{LINK_GRANT_LABEL}:{link_id}");
    let mut out = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(&salt), shared).expand(info.as_bytes(), out.as_mut()).expect("32 bytes");
    out
}

/// Seal a v2 grant to the new device's ephemeral public key (`ek_pub_b64`, base64 or base64url).
pub fn seal_link_grant_v2(link_id: &str, user_id: &str, claim_secret: &str, approved_by_device_id: &str,
                          approved_by_device_name: &str, issued_at: &str, ek_pub_b64: &str) -> Result<String, CryptoError> {
    let payload = json!({
        "type": "link_grant", "v": 2, "link_id": link_id, "user_id": user_id, "claim_secret": claim_secret,
        "approved_by_device_id": approved_by_device_id, "approved_by_device_name": approved_by_device_name,
        "issued_at": issued_at,
    });
    seal_raw(&payload.to_string(), ek_pub_b64, link_id)
}

pub fn seal_raw(plaintext: &str, ek_pub_b64: &str, link_id: &str) -> Result<String, CryptoError> {
    let ek_pub = pub32(ek_pub_b64, "ephemeral public key")?;
    if link_id.is_empty() { return Err(bad("refusing to seal without a link id")); }
    let (es_priv_raw, es_pub_b64) = keys::generate_x25519();
    let es_pub = pub32(&es_pub_b64, "own key")?;
    let es_priv = keys::x25519_secret(es_priv_raw.as_ref())?;
    let shared = keys::ecdh(&es_priv, &PublicKey::from(ek_pub)).ok_or_else(|| bad("low-order public key"))?;
    let key = derive(&shared, &es_pub, &ek_pub, link_id);
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let aad = format!("{LINK_GRANT_LABEL}:{link_id}");
    let ct = Aes256Gcm::new_from_slice(key.as_ref()).unwrap()
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext.as_bytes(), aad: aad.as_bytes() })
        .map_err(|_| bad("seal failed"))?;
    let env = json!({ "v": LINK_GRANT_VERSION, "es_pub_b64": es_pub_b64, "nonce_b64": b64(&nonce), "ct_b64": b64(&ct) });
    Ok(b64(env.to_string().as_bytes()))
}

/// Open a grant sealed to `ek_priv`. Any failure is "discard and show an error".
pub fn open_link_grant(envelope_b64: &str, ek_priv: &[u8], ek_pub_b64: &str, expected_link_id: &str) -> Result<LinkGrant, CryptoError> {
    if ek_priv.len() != 32 { return Err(bad("ephemeral private key must be exactly 32 bytes")); }
    let env: Value = serde_json::from_slice(&from_b64_node(envelope_b64)).map_err(|_| bad("envelope is not valid base64 JSON"))?;
    if env.get("v").and_then(Value::as_u64) != Some(LINK_GRANT_VERSION) { return Err(bad("unsupported envelope version")); }
    let s = |k: &str| env.get(k).and_then(Value::as_str).unwrap_or("");
    let es_pub = pub32(s("es_pub_b64"), "sender ephemeral public key")?;
    let ek_pub = pub32(ek_pub_b64, "own ephemeral public key")?;
    let nonce = from_b64_node(s("nonce_b64"));
    let ct = from_b64_node(s("ct_b64"));
    if nonce.len() != 12 { return Err(bad("bad nonce length")); }
    if ct.len() < 16 { return Err(bad("ciphertext shorter than its tag")); }
    let sec = keys::x25519_secret(ek_priv)?;
    let shared = keys::ecdh(&sec, &PublicKey::from(es_pub)).ok_or_else(|| bad("low-order public key"))?;
    let key = derive(&shared, &es_pub, &ek_pub, expected_link_id);
    let aad = format!("{LINK_GRANT_LABEL}:{expected_link_id}");
    let pt = Zeroizing::new(Aes256Gcm::new_from_slice(key.as_ref()).unwrap()
        .decrypt(Nonce::from_slice(&nonce), Payload { msg: &ct, aad: aad.as_bytes() })
        .map_err(|_| CryptoError::DecryptFailed)?);
    let p: Value = serde_json::from_slice(&pt).map_err(|_| bad("decrypted grant was not valid JSON"))?;
    let g = |k: &str| p.get(k).and_then(Value::as_str).map(str::to_owned);
    let v = p.get("v").and_then(Value::as_u64).unwrap_or(0);
    if g("type").as_deref() != Some("link_grant") || (v != 1 && v != 2) { return Err(bad("unexpected payload in grant envelope")); }
    if g("link_id").as_deref() != Some(expected_link_id) { return Err(bad("grant was sealed for a different link session")); }
    let user_id = g("user_id").filter(|u| !u.is_empty()).ok_or_else(|| bad("grant is missing required session fields"))?;
    let (mut claim, mut at, mut rt) = (None, None, None);
    if v == 1 {
        at = g("access_token").filter(|x| !x.is_empty());
        rt = g("refresh_token").filter(|x| !x.is_empty());
        if at.is_none() || rt.is_none() { return Err(bad("grant is missing required session fields")); }
    } else {
        let c = g("claim_secret").unwrap_or_default();
        if c.len() != 43 || !c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') { return Err(bad("grant is missing a usable claim secret")); }
        claim = Some(c);
    }
    Ok(LinkGrant { v: v as u8, link_id: expected_link_id.into(), user_id, claim_secret: claim, access_token: at, refresh_token: rt,
        approved_by_device_id: g("approved_by_device_id").unwrap_or_default(), approved_by_device_name: g("approved_by_device_name").unwrap_or_default() })
}

/// `XXXX-XXXX` fingerprint of an ephemeral public key (both screens compute it locally).
pub fn link_fingerprint(ek_pub_b64: &str) -> Result<String, CryptoError> {
    let raw = pub32(ek_pub_b64, "ephemeral public key")?;
    let d = Sha256::digest(raw);
    let (mut bits, mut acc, mut out) = (0u32, 0u32, String::new());
    for i in 0..5 {
        acc = (acc << 8) | u32::from(d[i]);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(FP_ALPHABET[((acc >> bits) & 31) as usize] as char);
        }
    }
    Ok(format!("{}-{}", &out[..4], &out[4..8]))
}

/// The QR text a NEW device shows: `cipherline://link/1?i=<id>&k=<base64url key>`.
pub fn build_link_qr(link_id: &str, ek_pub_b64: &str) -> String {
    let k = ek_pub_b64.replace('+', "-").replace('/', "_").trim_end_matches('=').to_owned();
    format!("cipherline://link/1?i={}&k={}", url_enc(link_id), url_enc(&k))
}

pub fn build_invite_qr(invite_id: &str) -> String { format!("cipherline://invite/1?i={}", url_enc(invite_id)) }

/// `cipherline://xfer/1?t=<transfer_id>`: a signed-in device offering to send its history. No key.
pub fn build_xfer_qr(transfer_id: &str) -> String { format!("cipherline://xfer/1?t={}", url_enc(transfer_id)) }

fn url_enc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkQr {
    /// A new device's session QR: the approver scans it. `ek_pub_b64` is standard base64.
    Link { link_id: String, ek_pub_b64: String },
    /// A signed-in device's invite QR: the new phone scans it.
    Invite { invite_id: String },
    /// A signed-in device's "Transfer data" QR: a device that WANTS the data scans it (no key in it).
    Xfer { transfer_id: String },
}

/// Strict QR parser. Duplicate parameters are refused (a smuggled second `k=` must not win).
pub fn parse_link_qr(text: &str) -> Option<LinkQr> {
    let t = text.trim();
    let (kind, rest) = if let Some(r) = t.strip_prefix("cipherline://link/1?") { ("link", r) }
        else if let Some(r) = t.strip_prefix("cipherline://invite/1?") { ("invite", r) }
        else if let Some(r) = t.strip_prefix("cipherline://xfer/1?") { ("xfer", r) } else { return None };
    let (mut i, mut k) = (None::<String>, None::<String>);
    for part in rest.split('&') {
        let (name, val) = part.split_once('=')?;
        // The transfer id rides in `t`; it is parsed through the same strict id slot.
        let slot = match name { "i" if kind != "xfer" => &mut i, "t" if kind == "xfer" => &mut i, "k" if kind == "link" => &mut k, _ => return None };
        if slot.is_some() { return None; }
        *slot = Some(url_dec(val)?);
    }
    let id = i?;
    if id.len() != 22 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') { return None; }
    if kind == "xfer" { return if k.is_none() { Some(LinkQr::Xfer { transfer_id: id }) } else { None }; }
    if kind == "invite" { return if k.is_none() { Some(LinkQr::Invite { invite_id: id }) } else { None }; }
    let raw = from_b64_node(&k?);
    if raw.len() != 32 { return None; }
    Some(LinkQr::Link { link_id: id, ek_pub_b64: b64(&raw) })
}

fn url_dec(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            out.push(u8::from_str_radix(s.get(i + 1..i + 3)?, 16).ok()?);
            i += 3;
        } else { out.push(b[i]); i += 1; }
    }
    String::from_utf8(out).ok()
}

// ── device approval ────────────────────────────────────────────────────────

pub const APPROVAL_CODE_PREFIX: &str = "cipherline-device-approval-code:v1";
pub const APPROVE_DECISION_PREFIX: &str = "cipherline-device-approve:v1";
pub const LINK_APPROVE_PREFIX: &str = "cipherline-link-approve:v1";

/// Six-digit comparison code shown on BOTH screens of a device approval.
pub fn derive_approval_code(user_id: &str, identity_key_b64: &str, nonce_b64: &str) -> String {
    let d = Sha256::digest(format!("{APPROVAL_CODE_PREFIX}:{user_id}:{identity_key_b64}:{nonce_b64}").as_bytes());
    let n = u32::from_be_bytes([d[0], d[1], d[2], d[3]]) % 1_000_000;
    format!("{n:06}")
}

pub fn approval_decision_message(user_id: &str, approver_device_id: &str, pending_device_id: &str,
                                 pending_key_b64: &str, approve: bool, ts: i64) -> String {
    let dec = if approve { "approve" } else { "deny" };
    format!("{APPROVE_DECISION_PREFIX}:{user_id}:{approver_device_id}:{pending_device_id}:{pending_key_b64}:{dec}:{ts}")
}

pub fn link_approve_message(user_id: &str, approver_device_id: &str, link_id: &str, new_key_b64: Option<&str>, ts: i64) -> String {
    format!("{LINK_APPROVE_PREFIX}:{user_id}:{approver_device_id}:{link_id}:{}:{ts}", new_key_b64.unwrap_or("-"))
}

/// Six random decimal digits, rejection-sampled.
pub fn generate_verification_code() -> String {
    loop {
        let n = OsRng.next_u32();
        if n < 4_294_000_000 { return format!("{:06}", n % 1_000_000); }
    }
}

/// A fresh ephemeral X25519 pair for a link session: (private raw, public standard-base64).
pub fn new_link_keypair() -> (Zeroizing<[u8; 32]>, String) { keys::generate_x25519() }

#[allow(dead_code)]
fn _unused(_: StaticSecret) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grant_round_trips_and_binds_link_id() {
        let (sk, pk) = new_link_keypair();
        let id = "AbCdEfGhIjKlMnOpQrStUv";
        let secret = "a".repeat(43);
        let env = seal_link_grant_v2(id, "u1", &secret, "d1", "Laptop", "2026-11-14T00:00:00Z", &pk).unwrap();
        let g = open_link_grant(&env, sk.as_ref(), &pk, id).unwrap();
        assert_eq!(g.claim_secret.as_deref(), Some(secret.as_str()));
        assert!(open_link_grant(&env, sk.as_ref(), &pk, "ZZZZZZZZZZZZZZZZZZZZZZ").is_err());
        let (sk2, _) = new_link_keypair();
        assert!(open_link_grant(&env, sk2.as_ref(), &pk, id).is_err());
    }

    #[test]
    fn qr_round_trip_and_duplicate_param_refused() {
        let (_, pk) = new_link_keypair();
        let id = "AbCdEfGhIjKlMnOpQrStUv";
        let q = build_link_qr(id, &pk);
        assert_eq!(parse_link_qr(&q), Some(LinkQr::Link { link_id: id.into(), ek_pub_b64: pk.clone() }));
        assert_eq!(parse_link_qr(&format!("{q}&k=AAAA")), None);
        assert_eq!(parse_link_qr(&build_invite_qr(id)), Some(LinkQr::Invite { invite_id: id.into() }));
        assert_eq!(parse_link_qr("https://evil/x"), None);
        // QR transfer authorisation: the id only, strictly parsed, no key, no duplicates, no mixing of kinds.
        assert_eq!(parse_link_qr(&build_xfer_qr(id)), Some(LinkQr::Xfer { transfer_id: id.into() }));
        assert_eq!(parse_link_qr(&format!("{}&t={id}", build_xfer_qr(id))), None);
        assert_eq!(parse_link_qr(&format!("{}&k=AAAA", build_xfer_qr(id))), None);
        assert_eq!(parse_link_qr(&format!("cipherline://xfer/1?i={id}")), None);
        assert_eq!(parse_link_qr(&format!("cipherline://invite/1?t={id}")), None);
        assert_eq!(parse_link_qr("cipherline://xfer/1?t=short"), None);
        assert_eq!(parse_link_qr("cipherline://xfer/1?t=../../etc/passwd/........"), None);
    }

    #[test]
    fn approval_code_shape() {
        let c = derive_approval_code("u", "k", "n");
        assert_eq!(c.len(), 6);
        assert_eq!(c, derive_approval_code("u", "k", "n"));
    }
}
