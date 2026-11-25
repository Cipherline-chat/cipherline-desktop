//! Client attestation header — API `common/attestation.util.ts`, desktop `main.ts` signer.
//!
//! `X-Cipherline-Attest: base64("<unixSeconds>:<hex HMAC-SHA256(secret, unixSeconds)>")`, or the
//! `attest=` query parameter on the WebSocket. Accepted within ±300 s by any secret in the
//! server's comma-separated rotation list; an empty list switches the check off.
//!
//! This is DETERRENCE, not access control: the secret ships inside the app and can be
//! extracted, so the server enforces every entitlement on its own.
use subtle::ConstantTimeEq;

use crate::encoding::{b64, from_b64_node};
use crate::pow::hmac_hex;

pub const ATTEST_WINDOW_S: f64 = 300.0;
pub const ATTEST_HEADER: &str = "X-Cipherline-Attest";
pub const ATTEST_QUERY_PARAM: &str = "attest";

/// The header value, or `None` when this build has no secret (dev).
pub fn attestation_token(secret: &str, now_ms: i64) -> Option<String> {
    if secret.is_empty() {
        return None;
    }
    let ts = now_ms.div_euclid(1000).to_string();
    Some(b64(format!("{ts}:{}", hmac_hex(secret, &ts)).as_bytes()))
}

/// `CLIENT_ATTEST_SECRETS` → list: split on commas, trim, drop empties.
pub fn parse_attest_secrets(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or("").split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect()
}

/// JavaScript `Number(s)` for the decimal forms a timestamp can take; `None` for `NaN`.
/// (`Number("")` is 0, which the time window then rejects, exactly as on the server.)
pub(crate) fn js_number(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    if t.contains(|c: char| c.is_ascii_alphabetic() && c != 'e' && c != 'E') {
        return None;
    }
    t.parse::<f64>().ok().filter(|f| f.is_finite())
}

/// API `verifyAttestation` — server side, here for tests.
pub fn verify_attestation(token: Option<&str>, secrets: &[&str], now_ms: i64) -> bool {
    if secrets.is_empty() {
        return true;
    }
    let Some(token) = token.filter(|t| !t.is_empty()) else { return false };
    let decoded = String::from_utf8_lossy(&from_b64_node(token)).into_owned();
    let Some((ts_str, sig)) = decoded.split_once(':') else { return false };
    let Some(ts) = js_number(ts_str) else { return false };
    if (now_ms as f64 / 1000.0 - ts).abs() > ATTEST_WINDOW_S || sig.is_empty() {
        return false;
    }
    secrets.iter().any(|secret| {
        let expected = hmac_hex(secret, ts_str);
        expected.len() == sig.len() && bool::from(expected.as_bytes().ct_eq(sig.as_bytes()))
    })
}
