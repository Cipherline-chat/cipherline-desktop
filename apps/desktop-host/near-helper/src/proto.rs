//! The stdio wire format between Electron main (parent) and the helper: ONE JSON object per line, UTF-8, `\n` terminated.
//!
//! parent -> helper (`In`):
//!   `{"t":"hello","v":1,"nonce":"<64 hex>","config":{...}}`   first line, exactly once
//!   `{"t":"call","id":7,"action":"nearProbe","args":[...]}`  a bridge member (`cl_near_engine::dispatch::MEMBERS`)
//!   `{"t":"reply","rid":3,"value":{...},"attest":"<hex>"}`   answer to a helper `req`
//!   (testkit builds only) `{"t":"test","op":"advert","uuid":"<32 hex>"}` | `{"t":"test","op":"skew","ms":1000}`
//! helper -> parent (`Out`):
//!   `{"t":"ready","v":1,"pid":123}`                          after a good hello
//!   `{"t":"result","id":7,"ok":true,"value":...}` / `{"t":"result","id":7,"ok":false,"error":"..."}`
//!   `{"t":"state","snapshot":{...}}`                         every engine snapshot (the `cl:near-state` event)
//!   `{"t":"own_out","to":"<device id>","content":{...}}`     an own-device control message for the page to send
//!   `{"t":"req","rid":3,"what":"identity_pub"|"sign"|"install_link"|"gate_confirm",...}`  the helper asks main
//!   `{"t":"fatal","error":"..."}`                            just before exiting on a protocol violation
//!
//! Unknown fields and unknown `t` values are REFUSED (the parent is trusted but not assumed correct); a line over
//! [`MAX_IN_LINE`] ends the process. Nothing here is logged.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{self, BufRead};
use zeroize::Zeroize;

pub const PROTOCOL_VERSION: u32 = 1;
/// The biggest legitimate command is an `nearOwnDeliver` content (4 KiB) or an approver start (token 4 KiB + code 2 KiB).
pub const MAX_IN_LINE: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case", deny_unknown_fields)]
pub enum In {
    Hello { v: u32, nonce: String, config: Config },
    Call { id: u64, action: String, #[serde(default)] args: Vec<Value> },
    Reply { rid: u64, #[serde(default)] value: Value, #[serde(default)] attest: Option<String> },
    #[cfg(feature = "testkit")]
    Test(TestOp),
}

#[cfg(feature = "testkit")]
#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum TestOp {
    /// The 128-bit service UUID the scripted phone is advertising (feeds the fake radio).
    Advert { uuid: String },
    /// Advance the engine's rotation clock.
    Skew { ms: u64 },
}

/// What the parent decides, sent once inside `hello` (so no secret ever rides in argv or the environment).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Config {
    /// Absolute. Transfer spool (`near-recv/`) and the paused flag live here. Created 0700.
    pub profile: String,
    /// Absolute. Where a received container is placed (the page reads it back through the existing `backup*` bridge).
    pub staging_dir: String,
    pub version: String,
    pub device_label: String,
    /// `linux` | `mac` | `windows`.
    pub platform: String,
    /// The deterrence-only attestation HMAC secret (the parent's `CLIENT_ATTEST_SECRET`); absent = no header.
    #[serde(default)]
    pub attest_secret: Option<String>,
}

impl Config {
    pub fn validate(&self) -> Result<(), String> {
        let abs = |p: &str, what: &str| {
            let path = std::path::Path::new(p);
            if p.is_empty() || p.len() > 1024 || !path.is_absolute() || p.contains('\0') || path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
                Err(format!("{what} must be a plain absolute path"))
            } else {
                Ok(())
            }
        };
        abs(&self.profile, "profile")?;
        abs(&self.staging_dir, "stagingDir")?;
        if self.version.is_empty() || self.version.len() > 32 || !self.version.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+')) {
            return Err("version is not a version string".into());
        }
        if self.device_label.is_empty() || self.device_label.chars().count() > 64 || self.device_label.chars().any(char::is_control) {
            return Err("deviceLabel must be 1-64 printable characters".into());
        }
        if !matches!(self.platform.as_str(), "linux" | "mac" | "windows") {
            return Err("platform must be linux, mac or windows".into());
        }
        if self.attest_secret.as_deref().is_some_and(|s| s.len() > 256) {
            return Err("attestSecret is too long".into());
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Out {
    Ready { v: u32, pid: u32 },
    Result { id: u64, ok: bool, #[serde(skip_serializing_if = "Option::is_none")] value: Option<Value>, #[serde(skip_serializing_if = "Option::is_none")] error: Option<String> },
    State { snapshot: Value },
    OwnOut { to: String, content: Value },
    Req { rid: u64, what: &'static str, #[serde(flatten)] fields: Value },
    Fatal { error: String },
}

/// Read one line of at most `max` bytes into `buf` (cleared first), without the newline. `Ok(false)` = clean EOF.
/// A longer line is an error: the caller exits, it never buffers without bound.
pub fn read_line_bounded<R: BufRead>(r: &mut R, max: usize, buf: &mut Vec<u8>) -> io::Result<bool> {
    buf.clear();
    loop {
        let chunk = match r.fill_buf() {
            Ok(c) => c,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if chunk.is_empty() {
            return if buf.is_empty() { Ok(false) } else { Err(io::Error::new(io::ErrorKind::UnexpectedEof, "line without a newline")) };
        }
        let (take, found) = match chunk.iter().position(|b| *b == b'\n') {
            Some(i) => (i, true),
            None => (chunk.len(), false),
        };
        if buf.len() + take > max {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "line too long"));
        }
        buf.extend_from_slice(&chunk[..take]);
        r.consume(take + usize::from(found));
        if found {
            return Ok(true);
        }
    }
}

/// Parse a command line, wiping the raw bytes (they may hold an access token) afterwards.
pub fn parse_in(buf: &mut Vec<u8>) -> Result<In, String> {
    let r = serde_json::from_slice::<In>(buf).map_err(|e| format!("bad command: {}", e.classify_name()));
    buf.zeroize();
    r
}

trait ClassifyName {
    fn classify_name(&self) -> &'static str;
}
impl ClassifyName for serde_json::Error {
    /// Fixed words only: the full serde message can quote the input (a token).
    fn classify_name(&self) -> &'static str {
        match self.classify() {
            serde_json::error::Category::Io => "io",
            serde_json::error::Category::Syntax => "syntax",
            serde_json::error::Category::Data => "unknown shape or field",
            serde_json::error::Category::Eof => "truncated",
        }
    }
}

/// Serialize one outgoing line (with the trailing `\n`).
pub fn encode_out(o: &Out) -> Vec<u8> {
    let mut v = serde_json::to_vec(o).unwrap_or_else(|_| br#"{"t":"fatal","error":"encode"}"#.to_vec());
    v.push(b'\n');
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn p(s: &str) -> Result<In, String> {
        parse_in(&mut s.as_bytes().to_vec())
    }

    #[test]
    fn commands_parse_and_unknown_shapes_are_refused() {
        assert!(matches!(p(r#"{"t":"call","id":1,"action":"nearProbe"}"#), Ok(In::Call { id: 1, .. })));
        assert!(matches!(p(r#"{"t":"call","id":1,"action":"nearProbe","args":[{"a":1}]}"#), Ok(In::Call { .. })));
        assert!(matches!(p(r#"{"t":"reply","rid":2,"value":{"x":1}}"#), Ok(In::Reply { rid: 2, .. })));
        for bad in [
            r#"{"t":"call","id":-1,"action":"x"}"#,
            r#"{"t":"call","id":1}"#,
            r#"{"t":"call","id":1,"action":"nearProbe","extra":true}"#,
            r#"{"t":"nope"}"#,
            r#"{}"#,
            r#"[]"#,
            r#"not json"#,
            r#"{"t":"hello","v":1,"nonce":"x"}"#,
        ] {
            assert!(p(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn an_error_never_quotes_the_input() {
        let e = p(r#"{"t":"call","id":1,"action":"nearApproverStart","args":[{"accessToken":"SECRET-TOKEN-VALUE"}],"zzz":1}"#).unwrap_err();
        assert!(!e.contains("SECRET"), "{e}");
    }

    #[test]
    fn the_raw_line_is_wiped_after_parsing() {
        let mut b = br#"{"t":"call","id":1,"action":"nearProbe"}"#.to_vec();
        let (ptr, cap) = (b.as_ptr(), b.capacity());
        parse_in(&mut b).unwrap();
        // Vec::zeroize wipes the whole allocation, then truncates
        assert!(b.is_empty());
        // SAFETY: the Vec still owns `cap` initialised-then-zeroed bytes at `ptr`
        let raw = unsafe { std::slice::from_raw_parts(ptr, cap) };
        assert!(raw.iter().all(|x| *x == 0));
    }

    #[test]
    fn lines_are_bounded_and_split_on_newlines() {
        let mut r = io::BufReader::with_capacity(4, Cursor::new(b"abc\nsecond line\n\nlast".to_vec()));
        let mut b = Vec::new();
        assert!(read_line_bounded(&mut r, 100, &mut b).unwrap());
        assert_eq!(b, b"abc");
        assert!(read_line_bounded(&mut r, 100, &mut b).unwrap());
        assert_eq!(b, b"second line");
        assert!(read_line_bounded(&mut r, 100, &mut b).unwrap());
        assert_eq!(b, b"");
        assert!(read_line_bounded(&mut r, 100, &mut b).is_err(), "an unterminated tail is an error, not a command");
        let mut r2 = io::BufReader::new(Cursor::new(vec![b'a'; 200]));
        assert!(read_line_bounded(&mut r2, 100, &mut b).is_err());
        let mut r3 = io::BufReader::new(Cursor::new(Vec::new()));
        assert!(!read_line_bounded(&mut r3, 100, &mut b).unwrap());
    }

    #[test]
    fn config_validation() {
        // An absolute path is platform-shaped: "/home/u/..." is relative on Windows (no drive letter).
        let root = if cfg!(windows) { r"C:\Users\u\AppData\Roaming\Cipherline" } else { "/home/u/.config/Cipherline" };
        let ok = || Config { profile: format!("{root}/near"), staging_dir: format!("{root}/backup-staging"), version: "0.1.2".into(), device_label: "My PC".into(), platform: "linux".into(), attest_secret: None };
        assert!(ok().validate().is_ok());
        let mut c = ok();
        c.profile = "relative/dir".into();
        assert!(c.validate().is_err());
        let mut c = ok();
        c.staging_dir = if cfg!(windows) { r"C:\a\..\etc".into() } else { "/a/../etc".into() };
        assert!(c.validate().is_err());
        let mut c = ok();
        c.platform = "plan9".into();
        assert!(c.validate().is_err());
        let mut c = ok();
        c.platform = "windows".into();
        assert!(c.validate().is_ok());
        let mut c = ok();
        c.version = "1 2".into();
        assert!(c.validate().is_err());
        let mut c = ok();
        c.device_label = "bad\nlabel".into();
        assert!(c.validate().is_err());
    }

    #[test]
    fn out_lines_are_single_line_json() {
        let l = encode_out(&Out::Req { rid: 3, what: "sign", fields: serde_json::json!({ "message": "a\nb" }) });
        let s = String::from_utf8(l).unwrap();
        assert_eq!(s.matches('\n').count(), 1);
        assert!(s.starts_with(r#"{"t":"req","rid":3,"what":"sign","message":"a\nb"}"#));
    }
}
