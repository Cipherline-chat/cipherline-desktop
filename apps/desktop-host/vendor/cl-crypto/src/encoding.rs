//! Base64 and hex, as every Cipherline wire field uses.
//!
//! Two decoders, on purpose:
//! - [`from_b64`] is strict standard base64 with padding — what this core writes.
//! - [`from_b64_node`] reproduces Node's `Buffer.from(s, 'base64')`, which is what desktop
//!   and the API use to READ wire fields. It skips characters outside the alphabet, accepts
//!   the URL-safe alphabet, stops at the first `=`, and drops a trailing partial byte. Where a
//!   desktop check depends on that leniency (a re-spelled nonce must still be recognised as
//!   the same nonce by the replay ledger), the port must decode the same way.
use base64::{engine::general_purpose::STANDARD, Engine};

use crate::CryptoError;

pub fn b64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

pub fn from_b64(s: &str) -> Result<Vec<u8>, CryptoError> {
    STANDARD.decode(s).map_err(|_| CryptoError::InvalidInput("not valid base64".into()))
}

/// Node `Buffer.from(s, 'base64')`. Never fails: garbage decodes to fewer (or zero) bytes,
/// exactly as on desktop, so callers check the decoded LENGTH.
pub fn from_b64_node(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// Standard base64 without trailing `=`.
pub fn b64_nopad(bytes: &[u8]) -> String {
    let mut s = b64(bytes);
    while s.ends_with('=') {
        s.pop();
    }
    s
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 15) as usize] as char);
    }
    s
}

pub fn from_hex(s: &str) -> Result<Vec<u8>, CryptoError> {
    let bad = || CryptoError::InvalidInput("not valid hex".into());
    if !s.len().is_multiple_of(2) {
        return Err(bad());
    }
    let nib = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    };
    s.as_bytes()
        .chunks(2)
        .map(|p| Some((nib(p[0])? << 4) | nib(p[1])?))
        .collect::<Option<Vec<u8>>>()
        .ok_or_else(bad)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_decoder_matches_buffer_from() {
        // Values checked against `Buffer.from(x, 'base64')` in Node 22.
        assert_eq!(from_b64_node(" VyPrSCxSmH4KEs4p"), from_b64("VyPrSCxSmH4KEs4p").unwrap());
        assert_eq!(from_b64_node("aGk"), b"hi");
        assert_eq!(from_b64_node("aGk="), b"hi");
        assert_eq!(from_b64_node("a-_A"), from_b64("a+/A").unwrap());
        assert_eq!(from_b64_node("aGk=AAAA"), b"hi");
        assert_eq!(from_b64_node("a"), Vec::<u8>::new());
        assert_eq!(hex(&from_b64_node("not-a-valid-token-at-all!!!")), "9e8b7e6bebda96277eb6891e9fe6adf9a965");
    }

    #[test]
    fn hex_round_trip() {
        assert_eq!(hex(&[0, 0xab, 0xff]), "00abff");
        assert_eq!(from_hex("00ABff").unwrap(), vec![0, 0xab, 0xff]);
        assert!(from_hex("0g").is_err());
        assert!(from_hex("abc").is_err());
    }
}
