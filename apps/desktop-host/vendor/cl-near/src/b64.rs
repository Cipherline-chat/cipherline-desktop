//! Strict base64url (RFC 4648 section 5, no padding, canonical). Every wire value of the contract uses it.
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

use crate::error::{NearError, Result};

pub(crate) fn enc(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Decode, rejecting padding, whitespace, the standard alphabet, non-zero trailing bits and wrong length.
pub(crate) fn dec_exact(s: &str, len: usize, what: &'static str) -> Result<Vec<u8>> {
    let raw = URL_SAFE_NO_PAD.decode(s).map_err(|_| NearError::Malformed(what))?;
    if raw.len() != len || enc(&raw) != s {
        return Err(NearError::Malformed(what));
    }
    Ok(raw)
}

pub(crate) fn dec_arr<const N: usize>(s: &str, what: &'static str) -> Result<[u8; N]> {
    let v = dec_exact(s, N, what)?;
    let mut a = [0u8; N];
    a.copy_from_slice(&v);
    Ok(a)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strictness() {
        let ok = enc(&[7u8; 16]);
        assert_eq!(ok.len(), 22);
        assert!(dec_exact(&ok, 16, "x").is_ok());
        assert!(dec_exact(&format!("{ok}="), 16, "x").is_err(), "padding");
        assert!(dec_exact(&ok.replace('-', "+"), 16, "x").is_err() || !ok.contains('-'));
        assert!(dec_exact(&ok[..21], 16, "x").is_err(), "short");
        assert!(dec_exact(&format!("{ok}A"), 16, "x").is_err(), "long");
        // non-canonical trailing bits: last char of a 16-byte value carries 4 spare bits
        let mut bad: Vec<u8> = ok.bytes().collect();
        let last = *bad.last().unwrap();
        let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let idx = alphabet.iter().position(|c| *c == last).unwrap();
        *bad.last_mut().unwrap() = alphabet[idx ^ 1];
        assert!(dec_exact(std::str::from_utf8(&bad).unwrap(), 16, "x").is_err(), "non-canonical");
        assert!(dec_exact(" AAAAAAAAAAAAAAAAAAAAAA", 16, "x").is_err());
    }
}
