//! Section 1: code payloads, the typed code, and the 30 s secret rotation.
use std::time::{Duration, Instant};

use rand_core::{OsRng, RngCore};
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::b64;
use crate::error::{NearError, Result};

pub const NEAR_PREFIX: &str = "cipherline://near/1?";
pub const INVITE_PREFIX: &str = "cipherline://near-invite/1?";
/// A shower re-renders its code with a fresh secret this often.
pub const ROTATE_EVERY: Duration = Duration::from_secs(30);
/// A link session lives this long; the shower opens a new one before it expires.
pub const SESSION_TTL: Duration = Duration::from_secs(120);

/// The 16-byte proximity secret `s`. Never sent to the server. Zeroed on drop; Debug is redacted.
#[derive(Clone, PartialEq, Eq, ZeroizeOnDrop)]
pub struct ProximitySecret([u8; 16]);

impl ProximitySecret {
    pub fn generate() -> Self {
        let mut s = [0u8; 16];
        OsRng.fill_bytes(&mut s);
        Self(s)
    }
    pub fn from_bytes(b: [u8; 16]) -> Self { Self(b) }
    pub fn as_bytes(&self) -> &[u8; 16] { &self.0 }
}
impl std::fmt::Debug for ProximitySecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("ProximitySecret(..)") }
}

/// `cipherline://near/1?i=<linkId>&k=<eN_pub>&s=<secret>`: N shows, A scans.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NearCode {
    pub link_id: String,
    pub en_pub: [u8; 32],
    pub secret: ProximitySecret,
}

/// `cipherline://near-invite/1?i=<inviteId>&s=<secret>`: A shows, N scans.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InviteCode {
    pub invite_id: String,
    pub secret: ProximitySecret,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NearPayload {
    Near(NearCode),
    Invite(InviteCode),
}

/// A fresh 16-byte session id in its wire form (22 base64url characters). The API normally allocates
/// link ids; this is for tests, demos and own-device flows.
pub fn new_link_id() -> String {
    let mut b = [0u8; 16];
    OsRng.fill_bytes(&mut b);
    b64::enc(&b)
}

pub fn build_near(link_id: &str, en_pub: &[u8; 32], secret: &ProximitySecret) -> String {
    format!("{NEAR_PREFIX}i={link_id}&k={}&s={}", b64::enc(en_pub), b64::enc(secret.as_bytes()))
}

pub fn build_invite(invite_id: &str, secret: &ProximitySecret) -> String {
    format!("{INVITE_PREFIX}i={invite_id}&s={}", b64::enc(secret.as_bytes()))
}

// ---- compact form (contract 11.14) ---------------------------------------------------------

pub const COMPACT_PREFIX: &str = "CLN1:";
const B32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

fn b32_enc(bytes: &[u8]) -> String {
    let (mut out, mut acc, mut bits) = (String::new(), 0u32, 0u32);
    for b in bytes {
        acc = (acc << 8) | u32::from(*b);
        bits += 8;
        while bits >= 5 { bits -= 5; out.push(B32[((acc >> bits) & 31) as usize] as char); }
        acc &= (1 << bits) - 1;
    }
    if bits > 0 { out.push(B32[((acc << (5 - bits)) & 31) as usize] as char); }
    out
}

/// RFC 4648 base32, upper case, no padding, canonical (spare trailing bits must be zero).
fn b32_dec(s: &str) -> Result<Vec<u8>> {
    let (mut out, mut acc, mut bits) = (Vec::new(), 0u32, 0u32);
    for c in s.bytes() {
        let v = B32.iter().position(|a| *a == c).ok_or(NearError::Malformed("compact code symbol"))? as u32;
        acc = (acc << 5) | v;
        bits += 5;
        if bits >= 8 { bits -= 8; out.push((acc >> bits) as u8); acc &= (1 << bits) - 1; }
    }
    if acc != 0 || bits >= 5 { return Err(NearError::Malformed("compact code padding bits")); }
    Ok(out)
}

/// What screens draw (contract 11.14): `CLN1:` + base32(`0x01` || `0x01` || linkId(16) || eN_pub(32) || s(16)).
pub fn build_near_compact(link_id: &str, en_pub: &[u8; 32], secret: &ProximitySecret) -> Result<String> {
    let id = b64::dec_exact(link_id, 16, "session id")?;
    let mut raw = vec![0x01, 0x01];
    raw.extend_from_slice(&id);
    raw.extend_from_slice(en_pub);
    raw.extend_from_slice(secret.as_bytes());
    Ok(format!("{COMPACT_PREFIX}{}", b32_enc(&raw)))
}

/// `CLN1:` + base32(`0x01` || `0x02` || inviteId(16) || s(16)).
pub fn build_invite_compact(invite_id: &str, secret: &ProximitySecret) -> Result<String> {
    let id = b64::dec_exact(invite_id, 16, "session id")?;
    let mut raw = vec![0x01, 0x02];
    raw.extend_from_slice(&id);
    raw.extend_from_slice(secret.as_bytes());
    Ok(format!("{COMPACT_PREFIX}{}", b32_enc(&raw)))
}

/// Strict: known version and kind, exact length for that kind, canonical base32.
pub fn parse_compact(text: &str) -> Result<NearPayload> {
    let body = text.strip_prefix(COMPACT_PREFIX).ok_or(NearError::Malformed("compact code prefix"))?;
    let raw = b32_dec(body)?;
    if raw.len() < 2 || raw[0] != 0x01 { return Err(NearError::Malformed("compact code version")); }
    let s16 = |b: &[u8]| -> ProximitySecret { let mut a = [0u8; 16]; a.copy_from_slice(b); ProximitySecret(a) };
    match raw[1] {
        0x01 if raw.len() == 66 => {
            let mut k = [0u8; 32];
            k.copy_from_slice(&raw[18..50]);
            Ok(NearPayload::Near(NearCode { link_id: b64::enc(&raw[2..18]), en_pub: k, secret: s16(&raw[50..66]) }))
        }
        0x02 if raw.len() == 34 => Ok(NearPayload::Invite(InviteCode { invite_id: b64::enc(&raw[2..18]), secret: s16(&raw[18..34]) })),
        0x01 | 0x02 => Err(NearError::Malformed("compact code length")),
        _ => Err(NearError::Malformed("compact code kind")),
    }
}

/// Split `a=b&c=d` into exactly the allowed names, each once. No percent-decoding: every value is base64url,
/// so a `%`, `+`, space or `#` simply fails the value decode.
fn params<'a, const N: usize>(rest: &'a str, names: [&str; N]) -> Result<[&'a str; N]> {
    let mut out: [Option<&str>; N] = [None; N];
    for part in rest.split('&') {
        let (name, val) = part.split_once('=').ok_or(NearError::Malformed("code parameter"))?;
        let slot = names.iter().position(|n| *n == name).ok_or(NearError::Malformed("unknown code parameter"))?;
        if out[slot].is_some() {
            return Err(NearError::Malformed("duplicate code parameter"));
        }
        out[slot] = Some(val);
    }
    let mut res = [""; N];
    for (i, o) in out.into_iter().enumerate() {
        res[i] = o.ok_or(NearError::Malformed("missing code parameter"))?;
    }
    Ok(res)
}

fn id16(s: &str) -> Result<String> {
    b64::dec_exact(s, 16, "session id")?;
    Ok(s.to_owned())
}

pub fn parse_near(text: &str) -> Result<NearCode> {
    let rest = text.strip_prefix(NEAR_PREFIX).ok_or(NearError::Malformed("near code prefix"))?;
    let [i, k, s] = params(rest, ["i", "k", "s"])?;
    Ok(NearCode {
        link_id: id16(i)?,
        en_pub: b64::dec_arr::<32>(k, "ephemeral key")?,
        secret: ProximitySecret(b64::dec_arr::<16>(s, "proximity secret")?),
    })
}

pub fn parse_invite(text: &str) -> Result<InviteCode> {
    let rest = text.strip_prefix(INVITE_PREFIX).ok_or(NearError::Malformed("invite code prefix"))?;
    let [i, s] = params(rest, ["i", "s"])?;
    Ok(InviteCode { invite_id: id16(i)?, secret: ProximitySecret(b64::dec_arr::<16>(s, "proximity secret")?) })
}

/// Parse whichever of the two near forms `text` is. The legacy `link/1`, `invite/1`, `xfer/1` forms are
/// NOT handled here (cl-crypto's `parse_link_qr` keeps them); this returns an error for them.
pub fn parse(text: &str) -> Result<NearPayload> {
    if text.starts_with(COMPACT_PREFIX) {
        parse_compact(text)
    } else if text.starts_with(NEAR_PREFIX) {
        parse_near(text).map(NearPayload::Near)
    } else if text.starts_with(INVITE_PREFIX) {
        parse_invite(text).map(NearPayload::Invite)
    } else {
        Err(NearError::Malformed("not a near code"))
    }
}

// ---- typed code -----------------------------------------------------------------------------

const LOOKUP_SALT: &[u8] = b"cipherline-near-code:v1";
/// Version of the typed-code `s` derivation. v1 (plain HKDF) let an active-MITM server search the 40-bit code offline at HMAC speed against A's
/// `hello` (F8); v2 stretches it with the same argon2id parameters as the lookup hash, so each guess costs ~64 MiB and ~0.25 s. Both ends must run
/// the same version; the label inside the salt is the marker, and a mismatch simply fails the hello confirmation (it can never weaken it).
pub const TYPED_SECRET_VERSION: u8 = 2;
const SECRET_SALT_PREFIX: &[u8] = b"cipherline-near-typed:v2:";
const LOOKUP_M_KIB: u32 = 64 * 1024;
const LOOKUP_T: u32 = 3;

const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// `XXXX-XXXX`: 40 random bits in Crockford base32, no checksum (as specified).
#[derive(Clone, PartialEq, Eq, ZeroizeOnDrop)]
pub struct TypedCode([u8; 5]);

impl std::fmt::Debug for TypedCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("TypedCode(..)") }
}

impl TypedCode {
    pub fn generate() -> Self {
        let mut b = [0u8; 5];
        OsRng.fill_bytes(&mut b);
        Self(b)
    }
    pub fn from_bytes(b: [u8; 5]) -> Self { Self(b) }

    /// Canonical display form, upper case with the hyphen: `XXXX-XXXX`.
    /// The on-screen form `XXXX·XXXX` (contract 11.1). The canonical text that is hashed stays `XXXX-XXXX` ([`TypedCode::display`]).
    pub fn display_dotted(&self) -> String { self.display().replace('-', "\u{00B7}") }

    pub fn display(&self) -> String {
        let mut acc: u64 = 0;
        for b in self.0 {
            acc = (acc << 8) | u64::from(b);
        }
        let mut s = String::with_capacity(9);
        for i in 0..8 {
            if i == 4 {
                s.push('-');
            }
            s.push(CROCKFORD[((acc >> (35 - 5 * i)) & 31) as usize] as char);
        }
        s
    }

    /// Parse what a person typed. Case-insensitive; the hyphen is optional and spaces around groups are
    /// ignored; Crockford's O -> 0 and I / L -> 1 are accepted; `U` and everything else is refused.
    /// Exactly 8 symbols; anything else is an error (never silently trimmed or padded).
    pub fn parse(text: &str) -> Result<Self> {
        let mut acc: u64 = 0;
        let mut n = 0u32;
        for c in text.chars() {
            if c == '-' || c == '\u{00B7}' || c == '\u{2022}' || c == '\u{2010}' || c == '\u{2013}' || c.is_whitespace() {
                continue;
            }
            let c = c.to_ascii_uppercase();
            let c = match c {
                'O' => '0',
                'I' | 'L' => '1',
                other => other,
            };
            let v = CROCKFORD.iter().position(|a| *a as char == c).ok_or(NearError::Malformed("typed code symbol"))?;
            if n == 8 {
                return Err(NearError::Malformed("typed code length"));
            }
            acc = (acc << 5) | v as u64;
            n += 1;
        }
        if n != 8 {
            return Err(NearError::Malformed("typed code length"));
        }
        let b = acc.to_be_bytes();
        Ok(Self([b[3], b[4], b[5], b[6], b[7]]))
    }

    /// The value N registers as `near_code_hash`:
    /// `argon2id(code, salt = "cipherline-near-code:v1", t = 3, m = 64 MiB, p = 1)`, 32 bytes, argon2 v1.3.
    /// `code` is the canonical `XXXX-XXXX` text. Allocates 64 MiB for the duration of the call.
    pub fn lookup_hash(&self) -> [u8; 32] {
        use argon2::{Algorithm, Argon2, Params, Version};
        let params = Params::new(LOOKUP_M_KIB, LOOKUP_T, 1, Some(32)).expect("fixed valid parameters");
        let mut pw = self.display().into_bytes();
        let mut out = [0u8; 32];
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
            .hash_password_into(&pw, LOOKUP_SALT, &mut out)
            .expect("fixed valid parameters");
        pw.zeroize();
        out
    }

    /// [`lookup_hash`](Self::lookup_hash) as 64 lowercase hex characters, the wire form.
    pub fn lookup_hash_hex(&self) -> String { self.lookup_hash().iter().map(|b| format!("{b:02x}")).collect() }

    /// `s` for a typed code, version [`TYPED_SECRET_VERSION`] = 2 (F8):
    /// `argon2id(code, salt = "cipherline-near-typed:v2:" || linkId, t = 3, m = 64 MiB, p = 1, tag length 32)[0..16]`, argon2 v1.3,
    /// `code` the canonical `XXXX-XXXX` text, `linkId` its ASCII base64url string. The salt differs from the lookup hash's, so the value the
    /// server stores for lookup tells it nothing about `s`. Allocates 64 MiB and takes ~0.25 s: call it off the UI thread.
    pub fn derive_secret(&self, link_id: &str) -> ProximitySecret {
        use argon2::{Algorithm, Argon2, Params, Version};
        let params = Params::new(LOOKUP_M_KIB, LOOKUP_T, 1, Some(32)).expect("fixed valid parameters");
        let mut pw = self.display().into_bytes();
        let mut salt = SECRET_SALT_PREFIX.to_vec();
        salt.extend_from_slice(link_id.as_bytes());
        let mut out = [0u8; 32];
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
            .hash_password_into(&pw, &salt, &mut out)
            .expect("fixed valid parameters");
        pw.zeroize();
        let mut s = [0u8; 16];
        s.copy_from_slice(&out[..16]);
        out.zeroize();
        ProximitySecret(s)
    }
}

impl TypedCode {
    pub fn ct_eq(&self, other: &Self) -> bool { self.0.ct_eq(&other.0).into() }
}

// ---- rotation -------------------------------------------------------------------------------

/// Shower-side rotation: a fresh secret every [`ROTATE_EVERY`], remembering the current and the previous.
pub struct SecretRotor {
    current: ProximitySecret,
    previous: Option<ProximitySecret>,
    rotated_at: Instant,
    started_at: Instant,
}

impl SecretRotor {
    pub fn new(now: Instant) -> Self {
        Self { current: ProximitySecret::generate(), previous: None, rotated_at: now, started_at: now }
    }
    /// Rotate if 30 s have passed. Returns true when the shower must re-render its code.
    pub fn tick(&mut self, now: Instant) -> bool {
        if now.saturating_duration_since(self.rotated_at) < ROTATE_EVERY {
            return false;
        }
        let next = ProximitySecret::generate();
        self.previous = Some(std::mem::replace(&mut self.current, next));
        self.rotated_at = now;
        true
    }
    pub fn current(&self) -> &ProximitySecret { &self.current }
    /// The secrets a hello may have been computed under: current first, then previous.
    pub fn candidates(&self) -> Vec<&ProximitySecret> {
        let mut v = vec![&self.current];
        if let Some(p) = &self.previous {
            v.push(p);
        }
        v
    }
    /// True once the session is within `margin` of its 120 s lifetime: open a new one now.
    pub fn session_expiring(&self, now: Instant, margin: Duration) -> bool {
        now.saturating_duration_since(self.started_at) + margin >= SESSION_TTL
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id() -> String { b64::enc(&[1u8; 16]) }

    #[test]
    fn near_round_trip_and_strictness() {
        let s = ProximitySecret::from_bytes([9; 16]);
        let t = build_near(&id(), &[5; 32], &s);
        let p = parse_near(&t).unwrap();
        assert_eq!(p.link_id, id());
        assert_eq!(p.en_pub, [5; 32]);
        assert_eq!(p.secret, s);
        assert!(matches!(parse(&t), Ok(NearPayload::Near(_))));
        // unknown / duplicate / missing / reordered-ok / wrong-length / non-canonical / extras
        assert!(parse_near(&format!("{t}&x=1")).is_err());
        assert!(parse_near(&format!("{t}&s={}", b64::enc(&[1; 16]))).is_err(), "duplicate");
        assert!(parse_near(&t.replace("&s=", "&z=")).is_err());
        assert!(parse_near(&format!("{NEAR_PREFIX}i={}&k={}", id(), b64::enc(&[5; 32]))).is_err(), "missing s");
        assert!(parse_near(&format!("{t}\n")).is_err(), "trailing newline is not trimmed");
        assert!(parse_near(&format!("{t}#frag")).is_err());
        assert!(parse_near(&format!(" {t}")).is_err());
        assert!(parse_near(&t.replace("near/1", "near/2")).is_err());
        assert!(parse_near(&t.replace(&id(), &id()[..21])).is_err());
        assert!(parse_near(&format!("{NEAR_PREFIX}i={}&k={}&s={}=", id(), b64::enc(&[5; 32]), b64::enc(&[9; 16]))).is_err());
        assert!(parse_near(&format!("{NEAR_PREFIX}i={}&k={}&s={}", id(), b64::enc(&[5; 31]), b64::enc(&[9; 16]))).is_err());
        assert!(parse_near("cipherline://link/1?i=AAAAAAAAAAAAAAAAAAAAAA&k=x").is_err(), "legacy form is not ours");
        assert!(parse_near(&format!("{NEAR_PREFIX}i={}&k=%41&s=x", id())).is_err());
    }

    #[test]
    fn invite_round_trip() {
        let s = ProximitySecret::from_bytes([3; 16]);
        let t = build_invite(&id(), &s);
        let p = parse_invite(&t).unwrap();
        assert_eq!((p.invite_id.as_str(), p.secret.clone()), (id().as_str(), s));
        assert!(matches!(parse(&t), Ok(NearPayload::Invite(_))));
        assert!(parse_invite(&format!("{t}&k={}", b64::enc(&[0; 32]))).is_err(), "no key in an invite");
        assert!(parse_invite(&t.replace("&s=", "&s=&s=")).is_err());
        assert!(parse(&t.replace("near-invite", "near")).is_err());
    }

    #[test]
    fn compact_form_round_trips_and_is_strict() {
        let id = new_link_id();
        let (_, en) = crate::keys::generate_keypair();
        let s = ProximitySecret::generate();
        let c = build_near_compact(&id, &en, &s).unwrap();
        assert!(c.starts_with("CLN1:") && c.len() == 5 + 106 && c.len() < build_near(&id, &en, &s).len());
        assert_eq!(parse(&c).unwrap(), NearPayload::Near(NearCode { link_id: id.clone(), en_pub: en, secret: s.clone() }));
        let i = build_invite_compact(&id, &s).unwrap();
        assert_eq!(i.len(), 5 + 55);
        assert_eq!(parse(&i).unwrap(), NearPayload::Invite(InviteCode { invite_id: id.clone(), secret: s.clone() }));
        // strict: lower case, padding, extra / missing symbols, wrong version / kind, non-canonical spare bits
        assert!(parse(&c.to_lowercase()).is_err() && parse(&format!("{c}=")).is_err() && parse(&format!("{c}A")).is_err() && parse(&c[..c.len() - 1]).is_err());
        let body = &c[5..];
        let mut last: Vec<char> = body.chars().collect();
        let l = last.len() - 1;
        let idx = B32.iter().position(|a| *a as char == last[l]).unwrap();
        last[l] = B32[idx ^ 1] as char;
        assert!(parse(&format!("CLN1:{}", last.iter().collect::<String>())).is_err(), "spare bits must be zero");
        for bad in [[0x02u8, 0x01], [0x01, 0x03]] {
            let mut raw = vec![bad[0], bad[1]];
            raw.extend_from_slice(&[0u8; 64]);
            assert!(parse(&format!("CLN1:{}", b32_enc(&raw))).is_err());
        }
        // the URI forms still parse
        assert!(parse(&build_near(&id, &en, &s)).is_ok());
        // RFC 4648 known answer
        assert_eq!(b32_enc(b"foobar"), "MZXW6YTBOI");
    }

    #[test]
    fn typed_code_format_and_parse() {
        let c = TypedCode::from_bytes([0, 0, 0, 0, 0]);
        assert_eq!(c.display(), "0000-0000");
        let c = TypedCode::from_bytes([0xFF; 5]);
        assert_eq!(c.display(), "ZZZZ-ZZZZ");
        let c = TypedCode::from_bytes([0x12, 0x34, 0x56, 0x78, 0x9A]);
        let d = c.display();
        assert_eq!(d.len(), 9);
        assert_eq!(TypedCode::parse(&d).unwrap(), c);
        assert_eq!(TypedCode::parse(&d.to_lowercase()).unwrap(), c);
        assert_eq!(TypedCode::parse(&d.replace('-', "")).unwrap(), c);
        assert_eq!(TypedCode::parse(&format!(" {} ", d.replace('-', " "))).unwrap(), c);
        // 11.1: the on-screen dotted form and look-alike separators are accepted
        assert_eq!(TypedCode::parse(&c.display_dotted()).unwrap(), c);
        assert_eq!(TypedCode::parse(&d.replace('-', "\u{2013}")).unwrap(), c);
        // Crockford aliases
        assert_eq!(TypedCode::parse("oooo-iiii").unwrap(), TypedCode::parse("0000-1111").unwrap());
        assert_eq!(TypedCode::parse("llll-0000").unwrap(), TypedCode::parse("1111-0000").unwrap());
        // refusals
        assert!(TypedCode::parse("UUUU-UUUU").is_err());
        assert!(TypedCode::parse("0000-000").is_err());
        assert!(TypedCode::parse("0000-00000").is_err());
        assert!(TypedCode::parse("0000-000!").is_err());
        assert!(TypedCode::parse("").is_err());
        // every 5-byte value round-trips (sampled)
        for i in 0u64..2000 {
            let b = (i * 0x9E37_79B9_7F4A).to_be_bytes();
            let c = TypedCode::from_bytes([b[3], b[4], b[5], b[6], b[7]]);
            assert_eq!(TypedCode::parse(&c.display()).unwrap(), c);
        }
    }

    #[test]
    fn typed_code_hash_and_secret_depend_on_inputs() {
        let a = TypedCode::from_bytes([1, 2, 3, 4, 5]);
        let b = TypedCode::from_bytes([1, 2, 3, 4, 6]);
        assert_ne!(a.lookup_hash(), b.lookup_hash());
        assert_eq!(a.lookup_hash(), a.lookup_hash());
        assert_eq!(a.lookup_hash_hex().len(), 64);
        assert!(a.lookup_hash_hex().bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
        assert_ne!(a.derive_secret("x").as_bytes(), a.derive_secret("y").as_bytes(), "salt is bound to the link id");
        assert_ne!(a.derive_secret("x").as_bytes(), b.derive_secret("x").as_bytes());
        assert_eq!(a.derive_secret("x"), a.derive_secret("x"));
        assert!(a.ct_eq(&a) && !a.ct_eq(&b));
    }

    /// F8: `s` from a typed code is argon2id-stretched, not plain HKDF.
    #[test]
    fn typed_secret_is_stretched_with_argon2id_not_plain_hkdf() {
        use hkdf::Hkdf;
        use sha2::Sha256;
        let c = TypedCode::from_bytes([1, 2, 3, 4, 5]);
        let link = "AQEBAQEBAQEBAQEBAQEBAQ";
        // the old v1 value: HKDF(code, salt = linkId, info = "cipherline-near-typed:v1")[0..16]
        let mut v1 = [0u8; 16];
        Hkdf::<Sha256>::new(Some(link.as_bytes()), c.display().as_bytes()).expand(b"cipherline-near-typed:v1", &mut v1).unwrap();
        let s = c.derive_secret(link);
        assert_ne!(s.as_bytes(), &v1, "an offline attacker's one-HMAC-per-guess shortcut no longer computes s");
        assert_eq!(TYPED_SECRET_VERSION, 2);
        // independent recomputation of the documented construction
        use argon2::{Algorithm, Argon2, Params, Version};
        let mut out = [0u8; 32];
        let mut salt = b"cipherline-near-typed:v2:".to_vec();
        salt.extend_from_slice(link.as_bytes());
        Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::new(64 * 1024, 3, 1, Some(32)).unwrap()).hash_password_into(c.display().as_bytes(), &salt, &mut out).unwrap();
        assert_eq!(s.as_bytes(), &out[..16]);
        // the value the server stores for lookup (different salt) reveals nothing about s
        assert_ne!(&c.lookup_hash()[..16], s.as_bytes());
    }

    /// `cargo test --release -p cl-near argon_timing -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn argon_timing() {
        let c = TypedCode::from_bytes([1, 2, 3, 4, 5]);
        for _ in 0..3 {
            let t = Instant::now();
            let _ = c.lookup_hash();
            eprintln!("argon2id t=3 m=64MiB p=1: {:?}", t.elapsed());
        }
    }

    #[test]
    fn rotation_keeps_current_and_previous() {
        let t0 = Instant::now();
        let mut r = SecretRotor::new(t0);
        let s0 = r.current().clone();
        assert!(!r.tick(t0 + Duration::from_secs(29)));
        assert_eq!(r.candidates().len(), 1);
        assert!(r.tick(t0 + Duration::from_secs(30)));
        assert_eq!(r.candidates().len(), 2);
        assert_eq!(*r.candidates()[1], s0);
        assert_ne!(*r.candidates()[0], s0);
        let s1 = r.current().clone();
        assert!(!r.tick(t0 + Duration::from_secs(59)));
        assert!(r.tick(t0 + Duration::from_secs(60)));
        // s0 is gone after a second rotation, s1 is now the previous
        assert_eq!(*r.candidates()[1], s1);
        assert!(!r.candidates().iter().any(|c| **c == s0));
        assert!(!r.session_expiring(t0 + Duration::from_secs(60), Duration::from_secs(20)));
        assert!(r.session_expiring(t0 + Duration::from_secs(100), Duration::from_secs(20)));
    }
}
