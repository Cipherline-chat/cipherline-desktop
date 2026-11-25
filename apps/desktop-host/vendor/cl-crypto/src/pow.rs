//! Registration proof-of-work — API `auth/pow.util.ts`.
//!
//! The server issues `<unixSeconds>.<randomHex>.<hmacHex>`. The client hashes the INNER
//! challenge `<unixSeconds>.<randomHex>` — never the whole token — and finds the smallest
//! decimal nonce `n` with `sha256("<challenge>:<n>")` having at least `difficulty` leading
//! zero bits, then submits the ORIGINAL token plus the nonce. (Desktop's live client hashes
//! the full 3-part token; the vectors document that bug and this port does not copy it.)
//! Difficulty 0 means off: the answer is `"0"`.
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::encoding::hex;

pub const POW_CHALLENGE_WINDOW_S: f64 = 600.0;
pub const POW_MAX_DIFFICULTY: u32 = 22;
pub const POW_MAX_ITERATIONS: u64 = 80_000_000;

/// `parseInt(raw, 10)` clamped to `0..=22` (`REGISTER_POW_DIFFICULTY`).
pub fn parse_pow_difficulty(raw: Option<&str>) -> u32 {
    let s = raw.unwrap_or("0").trim_start();
    let (neg, digits) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let lead: String = digits.chars().take_while(char::is_ascii_digit).collect();
    if neg || lead.is_empty() {
        return 0;
    }
    lead.parse::<u64>().map_or(POW_MAX_DIFFICULTY, |n| n.min(u64::from(POW_MAX_DIFFICULTY)) as u32)
}

/// `ts.rand` from a 3-part token, or `None`.
pub fn inner_challenge(token: &str) -> Option<String> {
    let parts: Vec<&str> = token.split('.').collect();
    match parts.as_slice() {
        [ts, rand, sig] if !ts.is_empty() && !rand.is_empty() && !sig.is_empty() => Some(format!("{ts}.{rand}")),
        _ => None,
    }
}

pub fn pow_hash(challenge: &str, nonce: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(challenge.as_bytes());
    h.update(b":");
    h.update(nonce.as_bytes());
    h.finalize().into()
}

pub fn leading_zero_bits(hash: &[u8]) -> u32 {
    let mut bits = 0;
    for b in hash {
        if *b == 0 {
            bits += 8;
        } else {
            return bits + b.leading_zeros();
        }
    }
    bits
}

pub fn meets_difficulty(challenge: &str, nonce: &str, difficulty: u32) -> bool {
    !nonce.is_empty() && nonce.len() <= 64 && leading_zero_bits(&pow_hash(challenge, nonce)) >= difficulty
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PowError {
    #[error("pow: challenge_token must have exactly three dot-separated segments")]
    BadToken,
    #[error("pow: no solution found within the iteration cap")]
    Exhausted,
    #[error("pow: solving was cancelled")]
    Cancelled,
}

/// Solve a challenge. `keep_going(iterations)` is polled every 65 536 hashes; return `false`
/// to cancel (the user left the screen).
pub fn solve(token: &str, difficulty: u32, mut keep_going: impl FnMut(u64) -> bool) -> Result<String, PowError> {
    let challenge = inner_challenge(token).ok_or(PowError::BadToken)?;
    if difficulty == 0 {
        return Ok("0".into());
    }
    let mut prefix = Sha256::new();
    prefix.update(challenge.as_bytes());
    prefix.update(b":");
    let mut buf = itoa_buf();
    for n in 0..POW_MAX_ITERATIONS {
        let nonce = fmt_u64(&mut buf, n);
        let mut h = prefix.clone();
        h.update(nonce.as_bytes());
        if leading_zero_bits(&h.finalize()) >= difficulty {
            return Ok(nonce.to_owned());
        }
        if n & 0xffff == 0xffff && !keep_going(n + 1) {
            return Err(PowError::Cancelled);
        }
    }
    Err(PowError::Exhausted)
}

fn itoa_buf() -> [u8; 20] {
    [0; 20]
}

fn fmt_u64(buf: &mut [u8; 20], mut n: u64) -> &str {
    let mut i = buf.len();
    loop {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    std::str::from_utf8(&buf[i..]).expect("ascii digits")
}

/// API `issueChallengeToken` — server side, here for tests.
pub fn issue_challenge_token(secret: &str, now_ms: i64, random_hex: &str) -> String {
    let challenge = format!("{}.{random_hex}", now_ms.div_euclid(1000));
    format!("{challenge}.{}", hmac_hex(secret, &challenge))
}

/// API `verifyChallengeToken` — server side, here for tests. Returns the inner challenge.
pub fn verify_challenge_token(token: &str, secret: &str, now_ms: i64) -> Option<String> {
    let challenge = inner_challenge(token)?;
    let sig = token.split('.').nth(2)?;
    let expected = hmac_hex(secret, &challenge);
    if sig.len() != expected.len() || !bool::from(sig.as_bytes().ct_eq(expected.as_bytes())) {
        return None;
    }
    let ts = crate::attestation::js_number(token.split('.').next()?)?;
    ((now_ms as f64 / 1000.0 - ts).abs() <= POW_CHALLENGE_WINDOW_S).then_some(challenge)
}

pub(crate) fn hmac_hex(secret: &str, msg: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC takes any key length");
    mac.update(msg.as_bytes());
    hex(&mac.finalize().into_bytes())
}
