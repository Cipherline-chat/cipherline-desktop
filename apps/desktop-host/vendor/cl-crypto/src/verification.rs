//! Out-of-band identity checks: the pairwise safety number and the per-user contact code.
//!
//! Safety number — desktop `src/utils/safetyNumber.ts`: SHA-512 over the two identity keys'
//! raw bytes, ordered by their base64 STRINGS, read as six 5-byte big-endian integers mod
//! 100 000. Symmetric. (The desktop header comment says twelve groups; the code — and every
//! client — produces six.)
//!
//! Contact code — desktop `src/utils/verificationCode.ts`: SHA-512 over
//! `"cipherline-contact-fingerprint-v1" ‖ 0 ‖ userId ‖ (0 ‖ pub)*` with the device keys sorted
//! as base64 strings, first 25 bytes in Crockford-style base32 (40 characters). It commits to
//! the user's whole device SET, so any added or replaced device changes it.
use sha2::{Digest, Sha512};
use subtle::ConstantTimeEq;

use crate::encoding::from_b64_node;

pub const SAFETY_NUMBER_GROUPS: usize = 6;
pub const CONTACT_CODE_LENGTH: usize = 40;
pub const CONTACT_FINGERPRINT_BYTES: usize = 25;
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CONTACT_DOMAIN: &str = "cipherline-contact-fingerprint-v1";

/// Six space-separated 5-digit groups.
pub fn safety_number(pub_a_b64: &str, pub_b_b64: &str) -> String {
    let (first, second) = if pub_a_b64 <= pub_b_b64 { (pub_a_b64, pub_b_b64) } else { (pub_b_b64, pub_a_b64) };
    let mut h = Sha512::new();
    h.update(from_b64_node(first));
    h.update(from_b64_node(second));
    let hash = h.finalize();
    (0..SAFETY_NUMBER_GROUPS)
        .map(|g| {
            let n = hash[g * 5..g * 5 + 5].iter().fold(0u64, |n, b| n * 256 + u64::from(*b));
            format!("{:05}", n % 100_000)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Safety number v2 (desktop `safetyNumber.ts`, `docs/safety-number-v2.md`): one 30-digit half per
/// party, from PBKDF2-HMAC-SHA-512(identity key, "cipherline-safety-number-v2" 0x00 userId, 5200
/// rounds, 30 bytes), the two halves sorted as strings and concatenated: twelve groups of five.
/// `Err` when a key is not a 32-byte Ed25519 public key or an id is empty.
pub const SAFETY_NUMBER_V2_GROUPS: usize = 12;

pub fn safety_half_v2(user_id: &str, pub_b64: &str) -> Result<String, String> {
    use base64::Engine as _;
    if user_id.is_empty() { return Err("userId required".into()); }
    let pubkey = base64::engine::general_purpose::STANDARD.decode(pub_b64.trim()).map_err(|_| "identity key is not base64".to_string())?;
    if pubkey.len() != 32 { return Err(format!("identity key must be 32 bytes, got {}", pubkey.len())); }
    let mut salt = b"cipherline-safety-number-v2\0".to_vec();
    salt.extend_from_slice(user_id.as_bytes());
    let mut okm = [0u8; 30];
    pbkdf2::pbkdf2_hmac::<Sha512>(&pubkey, &salt, 5200, &mut okm);
    Ok((0..6).map(|g| {
        let n = okm[g * 5..g * 5 + 5].iter().fold(0u64, |n, b| n * 256 + u64::from(*b));
        format!("{:05}", n % 100_000)
    }).collect())
}

/// The v2 number for one device pair; order-independent.
pub fn safety_number_v2(local_user: &str, local_pub_b64: &str, remote_user: &str, remote_pub_b64: &str) -> Result<String, String> {
    let (a, b) = (safety_half_v2(local_user, local_pub_b64)?, safety_half_v2(remote_user, remote_pub_b64)?);
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let all = format!("{lo}{hi}");
    Ok(all.as_bytes().chunks(5).map(|c| std::str::from_utf8(c).unwrap_or("")).collect::<Vec<_>>().join(" "))
}

/// Display rows of three groups.
pub fn format_safety_number(number: &str) -> Vec<Vec<String>> {
    let groups: Vec<String> = number.split(' ').map(str::to_owned).collect();
    groups.chunks(3).map(<[String]>::to_vec).collect()
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ContactCodeError {
    #[error("userId required")]
    NoUser,
    #[error("no device keys to commit to")]
    NoDevices,
}

pub fn contact_code(user_id: &str, device_pubs_b64: &[&str]) -> Result<String, ContactCodeError> {
    if user_id.is_empty() {
        return Err(ContactCodeError::NoUser);
    }
    if device_pubs_b64.is_empty() {
        return Err(ContactCodeError::NoDevices);
    }
    let mut pubs = device_pubs_b64.to_vec();
    pubs.sort_unstable();
    let mut h = Sha512::new();
    h.update(CONTACT_DOMAIN.as_bytes());
    h.update([0]);
    h.update(user_id.as_bytes());
    for p in pubs {
        h.update([0]);
        h.update(from_b64_node(p));
    }
    Ok(base32(&h.finalize()[..CONTACT_FINGERPRINT_BYTES]))
}

fn base32(bytes: &[u8]) -> String {
    let (mut bits, mut value, mut out) = (0u32, 0u32, String::new());
    for b in bytes {
        value = (value << 8) | u32::from(*b);
        bits += 8;
        while bits >= 5 {
            out.push(ALPHABET[((value >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
        value &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(ALPHABET[((value << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// Ten space-separated groups of four.
pub fn format_contact_code(code: &str) -> String {
    let chars: Vec<char> = code.chars().collect();
    chars.chunks(4).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join(" ")
}

/// Uppercase, keep only `[A-Z0-9]`, then read I/L as 1, O as 0, U as V.
pub fn normalize_contact_code(input: &str) -> String {
    input
        .to_uppercase()
        .chars()
        .filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        .map(|c| match c {
            'I' | 'L' => '1',
            'O' => '0',
            'U' => 'V',
            c => c,
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodeCheck {
    Malformed(String),
    Match,
    Mismatch,
}

/// Compare a typed or pasted code with the expected one, constant-time.
pub fn check_contact_code(expected: &str, supplied: &str) -> CodeCheck {
    let got = normalize_contact_code(supplied);
    if got.is_empty() {
        return CodeCheck::Malformed("Paste or type their code to compare it.".into());
    }
    if got.len() != CONTACT_CODE_LENGTH {
        return CodeCheck::Malformed(format!(
            "That code is {} characters — it should be {CONTACT_CODE_LENGTH}. Check you copied all of it.",
            got.len()
        ));
    }
    if !got.bytes().all(|c| ALPHABET.contains(&c)) {
        return CodeCheck::Malformed("That code contains characters a Cipherline code never uses.".into());
    }
    let want = normalize_contact_code(expected);
    if want.len() == got.len() && bool::from(want.as_bytes().ct_eq(got.as_bytes())) {
        CodeCheck::Match
    } else {
        CodeCheck::Mismatch
    }
}

#[cfg(test)]
mod v2_tests {
    use super::*;
    const A: &str = "00000000-0000-4000-8000-00000000000a";
    const B: &str = "00000000-0000-4000-8000-00000000000b";
    const P1: &str = "/M05mfNvcN7SRFXllrfxRraq2ETnyjmg6tS198yXLyc=";
    const P2: &str = "zTpON7ndkloGJuubvDlhPxHp5tvVh3JC3GH86KZIsAI=";
    const P4: &str = "XzF8lxrFHapGCut7kNkgV0jq8YyS5wMGXfCfxDvIBl8=";

    #[test]
    fn halves_match_desktop_vectors() {
        assert_eq!(safety_half_v2(A, P1).unwrap(), "662597989781171735386021190662");
        assert_eq!(safety_half_v2(B, P2).unwrap(), "500160725101472737568301572504");
        assert_eq!(safety_half_v2(B, P1).unwrap(), "427565661249207095951100760153");
        assert_eq!(safety_half_v2(A, P2).unwrap(), "076525382228650161268530505362");
    }

    #[test]
    fn displays_match_desktop_vectors_both_orders() {
        let want = "50016 07251 01472 73756 83015 72504 66259 79897 81171 73538 60211 90662";
        assert_eq!(safety_number_v2(A, P1, B, P2).unwrap(), want);
        assert_eq!(safety_number_v2(B, P2, A, P1).unwrap(), want);
        // Bob rekeyed: Alice's half stays, only Bob's moves.
        assert_eq!(safety_number_v2(A, P1, B, P4).unwrap(), "59137 81170 62529 99410 71014 43458 66259 79897 81171 73538 60211 90662");
        // Users swapped: the user id is part of the half.
        assert_eq!(safety_number_v2(B, P1, A, P2).unwrap(), "07652 53822 28650 16126 85305 05362 42756 56612 49207 09595 11007 60153");
    }

    /// ui-3 #6: the code a phone SENDS in a `safety_number` card must be byte-identical to desktop's
    /// `computeContactCode` (vectors computed by running desktop's verificationCode.ts algorithm under Node).
    #[test]
    fn contact_code_matches_desktop_vectors() {
        let p1 = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
        let p2 = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";
        let p3 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
        let u = "11111111-2222-3333-4444-555555555555";
        assert_eq!(contact_code(u, &[p1]).unwrap(), "G7AJWK6GBFQ8J4DKS29MNB14N2F8B1802JDS5W25");
        // Device order never matters (desktop sorts the base64 strings).
        assert_eq!(contact_code(u, &[p3, p2, p1]).unwrap(), "KEFJN0QN93F51FK5V6GETAE358BMAXSD73V0PCB9");
        assert_eq!(contact_code(u, &[p1, p3, p2]).unwrap(), "KEFJN0QN93F51FK5V6GETAE358BMAXSD73V0PCB9");
        assert_eq!(contact_code("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", &[p2, p1]).unwrap(), "B305WHMKK8S1D9NV8CTR3KY65WYKJW4TR21Q56G7");
    }

    #[test]
    fn rejects_bad_keys() {
        assert!(safety_half_v2(A, "AAAA").is_err());
        assert!(safety_half_v2("", P1).is_err());
        assert!(safety_half_v2(A, "!!!").is_err());
    }
}
