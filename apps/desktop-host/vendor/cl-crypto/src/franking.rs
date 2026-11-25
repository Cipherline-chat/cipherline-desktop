//! Message franking, client half (protocol v1). Byte-exact port of desktop
//! `utils/franking.ts`; `testdata/franking.vectors.json` is desktop's golden vector file, which
//! the API (`franking.protocol.spec.ts`) reproduces too.
//!
//! The sender makes a random 256-bit `kf` per message, computes the commitment
//! `c = HMAC-SHA256(kf, canon(kind, body, sender user, sender device, conversation|channel,
//! sender clock))`, seals `_fk = {v:1, kf, ts}` INSIDE the E2EE payload and sends `c` OUTSIDE the
//! ciphertext in the `x-franking-commitment` header. Nothing here is a new primitive. Every
//! function fails SOFT: a franking problem never stops a message from being sent or shown.
use hmac::{Hmac, Mac};
use rand_core::{OsRng, RngCore};
use serde_json::{json, Value};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::encoding::{b64, from_b64};

pub const FRANK_VERSION: u64 = 1;
pub const FRANK_MSG_MAGIC: &str = "CLFRANK1";
pub const FRANK_TAG_MAGIC: &str = "CLFTAG01";
pub const FRANKING_HEADER: &str = "x-franking-commitment";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind { Text, Attachment, KlipyGif }
impl Kind {
    pub fn as_str(self) -> &'static str { match self { Kind::Text => "text", Kind::Attachment => "attachment", Kind::KlipyGif => "klipy_gif" } }
    pub fn parse(s: &str) -> Option<Self> { Some(match s { "text" => Kind::Text, "attachment" => Kind::Attachment, "klipy_gif" => Kind::KlipyGif, _ => return None }) }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Context { Dm, Channel }
impl Context {
    pub fn as_str(self) -> &'static str { match self { Context::Dm => "dm", Context::Channel => "channel" } }
    pub fn parse(s: &str) -> Option<Self> { Some(match s { "dm" => Context::Dm, "channel" => Context::Channel, _ => return None }) }
}

pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36 && b.iter().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { *c == b'-' } else { c.is_ascii_hexdigit() })
}

/// base64 of exactly 32 bytes, padded (desktop `B64_32_RE`).
pub fn is_b64_32(s: &str) -> bool {
    s.len() == 44 && s.ends_with('=') && s.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'=')) && from_b64(s).map(|v| v.len() == 32).unwrap_or(false)
}

fn lp(out: &mut Vec<u8>, s: &[u8]) {
    out.extend_from_slice(&(s.len() as u32).to_be_bytes());
    out.extend_from_slice(s);
}

pub struct CommitInput<'a> {
    pub kind: Kind,
    pub body: &'a str,
    pub sender_user_id: &'a str,
    pub sender_device_id: &'a str,
    pub context: Context,
    pub context_id: &'a str,
    pub client_ts_ms: u64,
}

/// The exact byte string the sender commits to. None when an id is not a UUID.
pub fn canon_message(i: &CommitInput) -> Option<Vec<u8>> {
    if !is_uuid(i.sender_user_id) || !is_uuid(i.sender_device_id) || !is_uuid(i.context_id) { return None; }
    let mut o = FRANK_MSG_MAGIC.as_bytes().to_vec();
    lp(&mut o, i.kind.as_str().as_bytes());
    lp(&mut o, i.body.as_bytes());
    lp(&mut o, i.sender_user_id.to_lowercase().as_bytes());
    lp(&mut o, i.sender_device_id.to_lowercase().as_bytes());
    lp(&mut o, i.context.as_str().as_bytes());
    lp(&mut o, i.context_id.to_lowercase().as_bytes());
    lp(&mut o, i.client_ts_ms.to_string().as_bytes());
    Some(o)
}

fn hmac(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
    m.update(data);
    m.finalize().into_bytes().into()
}

pub fn commit(kf: &[u8; 32], i: &CommitInput) -> Option<[u8; 32]> {
    Some(hmac(kf, &canon_message(i)?))
}

/// The relay's tag canon (test / verification helper; the real key lives only on the API).
pub fn canon_tag(kid: &str, context: Context, c: &[u8; 32], sender: &str, context_id: &str, subject: &str, received_at_ms: u64) -> Vec<u8> {
    let mut o = FRANK_TAG_MAGIC.as_bytes().to_vec();
    lp(&mut o, kid.as_bytes());
    lp(&mut o, context.as_str().as_bytes());
    lp(&mut o, c);
    lp(&mut o, sender.to_lowercase().as_bytes());
    lp(&mut o, context_id.to_lowercase().as_bytes());
    lp(&mut o, subject.to_lowercase().as_bytes());
    lp(&mut o, received_at_ms.to_string().as_bytes());
    o
}

pub fn server_tag(key: &[u8], canon: &[u8]) -> [u8; 32] { hmac(key, canon) }

pub fn mac_equal(a: &[u8], b: &[u8]) -> bool { a.len() == b.len() && a.ct_eq(b).into() }

/// SHA-256 of a file's bytes, base64 (what an attachment message commits to).
pub fn sha256_b64(data: &[u8]) -> String {
    use sha2::Digest;
    b64(&Sha256::digest(data))
}

// ── what is reportable ──

/// The reportable fields of an attachment content object; None without a valid content hash.
pub fn attachment_of(c: &Value) -> Option<Value> {
    let sha = c.get("content_sha256_b64")?.as_str().filter(|s| is_b64_32(s))?;
    let size = c.get("byte_size")?.as_u64()?;
    Some(json!({
        "attachment_id": c.get("attachment_id")?.as_str()?,
        "byte_size": size,
        "filename": c.get("filename")?.as_str()?,
        "mime": c.get("mime")?.as_str()?,
        "sha256_b64": sha,
    }))
}

/// Same key order as the API's `attachmentBody()` (the crate uses serde_json `preserve_order`).
pub fn attachment_body(a: &Value) -> String { a.to_string() }

pub fn klipy_of(c: &Value) -> Option<Value> {
    let slug = c.get("slug")?.as_str()?;
    let url = c.get("media")?.get("url")?.as_str()?;
    Some(json!({ "slug": slug, "url": url }))
}

/// The kind and canonical body of a message's reportable content, or None when it has none.
pub fn frank_body(content: &Value) -> Option<(Kind, String)> {
    match content.get("type")?.as_str()? {
        "text" | "edit" => content.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()).map(|t| (Kind::Text, t.to_owned())),
        "attachment" => attachment_of(content).map(|a| (Kind::Attachment, attachment_body(&a))),
        "klipy_gif" => klipy_of(content).map(|g| (Kind::KlipyGif, g.to_string())),
        _ => None,
    }
}

// ── send ──

pub struct FrankedSend {
    /// The content JSON to ENCRYPT (carries `_fk` when franked).
    pub content_json: String,
    /// The commitment to send outside the ciphertext, if franked.
    pub commitment_b64: Option<String>,
}

/// Prepare one outgoing message. Unchanged content and no commitment for anything not
/// reportable, for missing ids, or on any error: the send always proceeds.
pub fn frank_for_send(content_json: &str, context: Context, context_id: &str, sender_user_id: &str, sender_device_id: &str, now_ms: u64) -> FrankedSend {
    let plain = || FrankedSend { content_json: content_json.to_owned(), commitment_b64: None };
    let Ok(mut parsed) = serde_json::from_str::<Value>(content_json) else { return plain() };
    let Some((kind, body)) = frank_body(&parsed) else { return plain() };
    let mut kf = [0u8; 32];
    OsRng.fill_bytes(&mut kf);
    let Some(c) = commit(&kf, &CommitInput { kind, body: &body, sender_user_id, sender_device_id, context, context_id, client_ts_ms: now_ms }) else { return plain() };
    let Some(obj) = parsed.as_object_mut() else { return plain() };
    obj.insert("_fk".into(), json!({ "v": FRANK_VERSION, "kf": b64(&kf), "ts": now_ms }));
    let out = FrankedSend { content_json: parsed.to_string(), commitment_b64: Some(b64(&c)) };
    kf.fill(0);
    out
}

// ── receive ──

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sealed { pub kf_b64: String, pub ts: u64 }

/// Remove `_fk` from a freshly decrypted content object (ALWAYS, so the key never reaches a
/// stored row, a quote or a backup) and return it only if well formed.
pub fn take_sealed(content: &mut Value) -> Option<Sealed> {
    let fk = content.as_object_mut()?.remove("_fk")?;
    if fk.get("v").and_then(Value::as_u64) != Some(FRANK_VERSION) { return None; }
    let kf = fk.get("kf").and_then(Value::as_str).filter(|k| is_b64_32(k))?;
    let ts = fk.get("ts").and_then(Value::as_u64).filter(|t| *t <= (1u64 << 53))?;
    Some(Sealed { kf_b64: kf.to_owned(), ts })
}

fn kid_ok(k: &str) -> bool { (1..=16).contains(&k.len()) && k.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') }

/// The relay's `{c, t, kid, ts}` if well formed.
pub fn parse_wire(w: &Value) -> Option<(String, String, String, u64)> {
    let c = w.get("c")?.as_str().filter(|s| is_b64_32(s))?;
    let t = w.get("t")?.as_str().filter(|s| is_b64_32(s))?;
    let kid = w.get("kid")?.as_str().filter(|k| kid_ok(k))?;
    let ts = w.get("ts")?.as_u64()?;
    Some((c.into(), t.into(), kid.into(), ts))
}

/// What the recipient keeps beside a received message (desktop `StoredFranking`), as JSON.
/// None unless BOTH halves (sealed + relay tag) are present and well formed.
pub fn build_stored(sealed: Option<&Sealed>, wire: Option<&Value>, context: Context, context_id: &str, sender_user_id: &str, sender_device_id: &str, message_id: Option<&str>) -> Option<Value> {
    let sealed = sealed?;
    let (c, t, kid, ts) = parse_wire(wire?)?;
    if !is_uuid(context_id) || !is_uuid(sender_user_id) || !is_uuid(sender_device_id) { return None; }
    if context == Context::Channel && !message_id.is_some_and(is_uuid) { return None; }
    let mut v = json!({
        "v": 1, "kf_b64": sealed.kf_b64, "client_ts_ms": sealed.ts, "c_b64": c, "t_b64": t, "kid": kid, "received_at_ms": ts,
        "context_kind": context.as_str(), "context_id": context_id.to_lowercase(),
        "sender_user_id": sender_user_id.to_lowercase(), "sender_device_id": sender_device_id.to_lowercase(),
    });
    if context == Context::Channel { v["message_id"] = message_id.unwrap().to_lowercase().into(); }
    Some(v)
}

// ── report ──

#[derive(Debug, PartialEq, Eq)]
pub enum ReportFailure { NoFranking, NoContent, SenderMismatch, ContentChanged, Malformed }

impl ReportFailure {
    pub fn code(&self) -> &'static str {
        match self { Self::NoFranking => "no_franking", Self::NoContent => "no_content", Self::SenderMismatch => "sender_mismatch", Self::ContentChanged => "content_changed", Self::Malformed => "malformed" }
    }
}

/// Build the `franked_message` a report carries (API `FrankedMessageDto`), checking it locally
/// first so the reporter learns up front whether it will verify.
pub fn build_franked_report(content: &Value, stored: Option<&Value>, row_sender: Option<&str>) -> std::result::Result<Value, ReportFailure> {
    let f = stored.ok_or(ReportFailure::NoFranking)?;
    let s = |k: &str| f.get(k).and_then(Value::as_str);
    let (kind, body) = frank_body(content).ok_or(ReportFailure::NoContent)?;
    let sender = s("sender_user_id").ok_or(ReportFailure::Malformed)?;
    if row_sender.is_some_and(|r| r.to_lowercase() != sender) { return Err(ReportFailure::SenderMismatch); }
    let ctx = s("context_kind").and_then(Context::parse).ok_or(ReportFailure::Malformed)?;
    let kf: [u8; 32] = from_b64(s("kf_b64").ok_or(ReportFailure::Malformed)?).ok().and_then(|v| v.try_into().ok()).ok_or(ReportFailure::Malformed)?;
    let ts = f.get("client_ts_ms").and_then(Value::as_u64).ok_or(ReportFailure::Malformed)?;
    let expected = commit(&kf, &CommitInput {
        kind, body: &body, sender_user_id: sender, sender_device_id: s("sender_device_id").ok_or(ReportFailure::Malformed)?,
        context: ctx, context_id: s("context_id").ok_or(ReportFailure::Malformed)?, client_ts_ms: ts,
    }).ok_or(ReportFailure::Malformed)?;
    let c = from_b64(s("c_b64").ok_or(ReportFailure::Malformed)?).map_err(|_| ReportFailure::Malformed)?;
    if !mac_equal(&expected, &c) { return Err(ReportFailure::ContentChanged); }
    let mut o = json!({ "kind": kind.as_str() });
    match kind {
        Kind::Text => o["text"] = body.into(),
        Kind::Attachment => o["attachment"] = attachment_of(content).ok_or(ReportFailure::Malformed)?,
        Kind::KlipyGif => o["klipy"] = klipy_of(content).ok_or(ReportFailure::Malformed)?,
    }
    for k in ["sender_user_id", "sender_device_id", "context_kind", "context_id"] { o[k] = f.get(k).cloned().unwrap_or(Value::Null); }
    if let Some(m) = f.get("message_id") { o["message_id"] = m.clone(); }
    for k in ["client_ts_ms", "received_at_ms", "kid", "kf_b64", "c_b64", "t_b64"] { o[k] = f.get(k).cloned().unwrap_or(Value::Null); }
    Ok(o)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vectors() -> Value { serde_json::from_str(include_str!("../testdata/franking.vectors.json")).unwrap() }

    #[test]
    fn matches_desktop_golden_vectors_byte_for_byte() {
        let v = vectors();
        let kf: [u8; 32] = crate::encoding::from_hex(v["kf_hex"].as_str().unwrap()).unwrap().try_into().unwrap();
        let key = crate::encoding::from_hex(v["server_key_hex"].as_str().unwrap()).unwrap();
        let mut n = 0;
        for case in v["cases"].as_array().unwrap() {
            let m = &case["message"];
            let kind = Kind::parse(m["kind"].as_str().unwrap()).unwrap();
            let ctx = Context::parse(m["contextKind"].as_str().unwrap()).unwrap();
            // The attachment / GIF body is rebuilt from the fixture fields, not copied.
            let body = match kind {
                Kind::Text => m["body"].as_str().unwrap().to_owned(),
                Kind::Attachment => {
                    let a = &v["attachment"];
                    let content = json!({ "type": "attachment", "attachment_id": a["attachment_id"], "filename": a["filename"], "mime": a["mime"], "byte_size": a["byte_size"], "content_sha256_b64": a["sha256_b64"] });
                    frank_body(&content).unwrap().1
                }
                Kind::KlipyGif => frank_body(&json!({ "type": "klipy_gif", "slug": v["klipy"]["slug"], "media": { "url": v["klipy"]["url"] } })).unwrap().1,
            };
            assert_eq!(body, m["body"].as_str().unwrap_or(&body), "{}: body", case["name"]);
            let i = CommitInput { kind, body: &body, sender_user_id: m["senderUserId"].as_str().unwrap(), sender_device_id: m["senderDeviceId"].as_str().unwrap(),
                context: ctx, context_id: m["contextId"].as_str().unwrap(), client_ts_ms: m["clientTsMs"].as_u64().unwrap() };
            assert_eq!(crate::encoding::hex(&canon_message(&i).unwrap()), case["canon_message_hex"].as_str().unwrap(), "{}: canon", case["name"]);
            let c = commit(&kf, &i).unwrap();
            assert_eq!(b64(&c), case["commitment_b64"].as_str().unwrap(), "{}: commitment", case["name"]);
            let t = &case["tag"];
            let canon = canon_tag(t["kid"].as_str().unwrap(), ctx, &c, t["senderUserId"].as_str().unwrap(), t["contextId"].as_str().unwrap(), t["subjectId"].as_str().unwrap(), t["receivedAtMs"].as_u64().unwrap());
            assert_eq!(crate::encoding::hex(&canon), case["canon_tag_hex"].as_str().unwrap(), "{}: canon tag", case["name"]);
            assert_eq!(b64(&server_tag(&key, &canon)), case["tag_b64"].as_str().unwrap(), "{}: tag", case["name"]);
            n += 1;
        }
        assert_eq!(n, 4);
    }

    const U: &str = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const D: &str = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
    const CV: &str = "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";

    /// Franked send -> receive-side join -> report: verifies; tampering fails.
    #[test]
    fn round_trip_and_negative_controls() {
        let sent = frank_for_send(r#"{"type":"text","text":"héllo 😀","mentions":[]}"#, Context::Dm, CV, U, D, 1_761_840_000_123);
        let c = sent.commitment_b64.clone().unwrap();
        let mut content: Value = serde_json::from_str(&sent.content_json).unwrap();
        assert!(content.get("_fk").is_some());
        let sealed = take_sealed(&mut content).unwrap();
        assert!(content.get("_fk").is_none());
        let t = b64(&[7u8; 32]);
        let wire = json!({ "c": c, "t": t, "kid": "k1", "ts": 1_761_840_000_456u64 });
        let stored = build_stored(Some(&sealed), Some(&wire), Context::Dm, CV, U, D, None).unwrap();
        let ok = build_franked_report(&content, Some(&stored), Some(U)).unwrap();
        assert_eq!(ok["kind"], "text");
        assert_eq!(ok["text"], "héllo 😀");
        // tampered body
        let mut bad = content.clone();
        bad["text"] = "héllo 😈".into();
        assert_eq!(build_franked_report(&bad, Some(&stored), Some(U)), Err(ReportFailure::ContentChanged));
        // tampered commitment / key / ts / ids
        for (k, v) in [("c_b64", Value::from(b64(&[1u8; 32]))), ("kf_b64", b64(&[2u8; 32]).into()), ("client_ts_ms", 5.into()), ("context_id", "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e70".into())] {
            let mut s2 = stored.clone();
            s2[k] = v;
            assert_eq!(build_franked_report(&content, Some(&s2), Some(U)), Err(ReportFailure::ContentChanged), "{k}");
        }
        // wrong sender / no franking / no content
        assert_eq!(build_franked_report(&content, Some(&stored), Some(D)), Err(ReportFailure::SenderMismatch));
        assert_eq!(build_franked_report(&content, None, Some(U)), Err(ReportFailure::NoFranking));
        assert_eq!(build_franked_report(&json!({"type":"reaction"}), Some(&stored), Some(U)), Err(ReportFailure::NoContent));
        // a half-present record is never built
        assert!(build_stored(None, Some(&wire), Context::Dm, CV, U, D, None).is_none());
        assert!(build_stored(Some(&sealed), None, Context::Dm, CV, U, D, None).is_none());
        assert!(build_stored(Some(&sealed), Some(&json!({"c": "x", "t": t, "kid": "k1", "ts": 1})), Context::Dm, CV, U, D, None).is_none());
        // a channel record needs the row id
        assert!(build_stored(Some(&sealed), Some(&wire), Context::Channel, CV, U, D, None).is_none());
    }

    #[test]
    fn not_reportable_content_is_untouched_and_bad_ids_fail_soft() {
        for c in [r#"{"type":"reaction","target_id":"x","emoji":"a"}"#, r#"{"type":"text","text":""}"#, r#"{"type":"attachment","attachment_id":"a"}"#, "not json"] {
            let f = frank_for_send(c, Context::Dm, CV, U, D, 1);
            assert_eq!(f.content_json, c);
            assert!(f.commitment_b64.is_none());
        }
        assert!(frank_for_send(r#"{"type":"text","text":"x"}"#, Context::Dm, "nope", U, D, 1).commitment_b64.is_none());
    }

    #[test]
    fn attachment_and_gif_bodies_match_api_key_order() {
        let a = json!({ "type": "attachment", "attachment_id": "5f6a7b8c-9d0e-4f1a-8b3c-4d5e6f7a8b9c", "filename": "cat.png", "mime": "image/png", "byte_size": 12345,
            "content_sha256_b64": "Cw2z2I6lhGEs9PEK4LItbgN8sGUwFPTSaICZjfQtD+s=", "key": "k" });
        assert_eq!(frank_body(&a).unwrap().1,
            r#"{"attachment_id":"5f6a7b8c-9d0e-4f1a-8b3c-4d5e6f7a8b9c","byte_size":12345,"filename":"cat.png","mime":"image/png","sha256_b64":"Cw2z2I6lhGEs9PEK4LItbgN8sGUwFPTSaICZjfQtD+s="}"#);
        let g = json!({ "type": "klipy_gif", "slug": "funny-cat", "media": { "url": "https://static.klipy.com/ii/x/y.gif" } });
        assert_eq!(frank_body(&g).unwrap().1, r#"{"slug":"funny-cat","url":"https://static.klipy.com/ii/x/y.gif"}"#);
        // no content hash = not attachment-reportable
        let mut b = a.clone();
        b.as_object_mut().unwrap().remove("content_sha256_b64");
        assert!(frank_body(&b).is_none());
    }
}
