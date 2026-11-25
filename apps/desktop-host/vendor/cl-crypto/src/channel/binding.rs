//! Channel-message context binding, format v2 (`_cb` inside the plaintext) — desktop "G4".
//!
//! Port of `apps/desktop/electron/e2ee-engine.ts` (`encryptChannelMessage` /
//! `decryptChannelMessage`, merge `afa7ee64`) via the mobile port `channel-binding.ts`.
//!
//! A channel message is one AES-GCM ciphertext under the channel's epoch key plus an Ed25519
//! signature over the raw ciphertext. Neither says WHERE the message belongs, so the server
//! could re-post a row under a new id, re-label its sender, or move it to another channel or
//! epoch sharing the key. v2 puts
//!
//! ```text
//! { ...content, _cb: { v: 2, c: channel_id, e: epoch, n: nonce_b64, m: message id,
//!                      d: sender device, u: sender user } }
//! ```
//!
//! inside the plaintext, where the GCM tag and the signature cover it. `n` separates a genuine
//! binding from a `_cb` that rode along in copied content: no one knows a fresh message's nonce
//! before it is chosen. `_cb` is stripped in EVERY case (genuine, copied, future version).
//! Legacy unbound (v1) messages are still accepted.
use serde_json::{Map, Value};

use super::ChannelError;
use crate::js_json;

/// The `v` a binding carries.
pub const CHANNEL_BINDING_VERSION: i64 = 2;
/// Max length (UTF-16 units, like JS `.length`) of a `client_msg_id` reused as the bound `m`.
pub const MAX_BOUND_MSG_ID_LEN: usize = 128;

/// The sending device's own ids, bound into the message as `d` / `u`.
#[derive(Clone, Copy, Debug, Default)]
pub struct ChannelSender<'a> {
    pub user_id: Option<&'a str>,
    pub device_id: Option<&'a str>,
}

/// Where a message ARRIVED — what a genuine binding is checked against.
#[derive(Clone, Copy, Debug)]
pub struct BindingArrival<'a> {
    pub channel_id: &'a str,
    pub epoch: u32,
    /// The canonical re-encoding of the decoded nonce.
    pub nonce_canon: &'a str,
    /// The server row's labels; compared only when present.
    pub sender_user_id: Option<&'a str>,
    pub sender_device_id: Option<&'a str>,
}

fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn non_empty_str(v: Option<&Value>, max: usize) -> Option<&str> {
    match v {
        Some(Value::String(s)) if !s.is_empty() && js_len(s) <= max => Some(s),
        _ => None,
    }
}

fn non_empty(s: Option<&str>, max: usize) -> Option<&str> {
    s.filter(|s| !s.is_empty() && js_len(s) <= max)
}

/// Add a v2 binding to `content_json`, about to be sealed under `nonce_b64`.
///
/// Non-object content (an array, not JSON at all) is returned UNBOUND, because wrapping it
/// would change what an old client parses. An existing `_cb` keeps its key position and takes
/// the new value; otherwise `_cb` is appended last — desktop's `{ ...parsed, _cb }`.
/// `fallback_msg_id` supplies `m` when the content has no usable `client_msg_id` (desktop:
/// `crypto.randomUUID()`).
pub fn bind_channel_content(
    content_json: &str,
    channel_id: &str,
    epoch: u32,
    nonce_b64: &str,
    sender: ChannelSender<'_>,
    fallback_msg_id: impl FnOnce() -> String,
) -> String {
    let Some(Value::Object(mut obj)) = js_json::parse(content_json) else {
        return content_json.to_owned();
    };
    let m = non_empty_str(obj.get("client_msg_id"), MAX_BOUND_MSG_ID_LEN)
        .map(str::to_owned)
        .unwrap_or_else(fallback_msg_id);
    let mut cb = Map::new();
    cb.insert("v".into(), CHANNEL_BINDING_VERSION.into());
    cb.insert("c".into(), channel_id.into());
    cb.insert("e".into(), epoch.into());
    cb.insert("n".into(), nonce_b64.into());
    cb.insert("m".into(), m.into());
    if let Some(d) = non_empty(sender.device_id, 256) {
        cb.insert("d".into(), d.into());
    }
    if let Some(u) = non_empty(sender.user_id, 256) {
        cb.insert("u".into(), u.into());
    }
    // IndexMap::insert keeps an existing key's position, exactly like a JS spread override.
    obj.insert("_cb".into(), Value::Object(cb));
    js_json::stringify(&Value::Object(obj))
}

fn num_eq(v: Option<&Value>, want: i64) -> bool {
    v.and_then(Value::as_f64) == Some(want as f64)
}

/// Check a decrypted plaintext's binding against where it arrived, and strip `_cb`.
///
/// Returns `plaintext` unchanged when it carries no `_cb` (the byte-identical legacy path),
/// otherwise the content re-serialised without it. Same checks, same order as desktop.
pub fn verify_and_strip(plaintext: &str, arrival: &BindingArrival<'_>) -> Result<String, ChannelError> {
    let Some(Value::Object(mut obj)) = js_json::parse(plaintext) else {
        return Ok(plaintext.to_owned());
    };
    let Some(cb) = obj.get("_cb") else {
        return Ok(plaintext.to_owned());
    };
    if let Value::Object(cb) = cb {
        let genuine = num_eq(cb.get("v"), CHANNEL_BINDING_VERSION)
            && cb.get("n").and_then(Value::as_str) == Some(arrival.nonce_canon);
        if genuine {
            let fail = |what: &'static str| ChannelError::Binding {
                what,
                channel_id: arrival.channel_id.to_owned(),
                epoch: arrival.epoch,
            };
            if cb.get("c").and_then(Value::as_str) != Some(arrival.channel_id) {
                return Err(fail("channel"));
            }
            if !num_eq(cb.get("e"), i64::from(arrival.epoch)) {
                return Err(fail("epoch"));
            }
            if non_empty_str(cb.get("m"), MAX_BOUND_MSG_ID_LEN).is_none() {
                return Err(fail("message id"));
            }
            // `cb.d !== undefined && label && cb.d !== label` — a non-string `d` mismatches too.
            if let (Some(d), Some(label)) = (cb.get("d"), arrival.sender_device_id.filter(|s| !s.is_empty())) {
                if d.as_str() != Some(label) {
                    return Err(fail("sender device"));
                }
            }
            if let (Some(u), Some(label)) = (cb.get("u"), arrival.sender_user_id.filter(|s| !s.is_empty())) {
                if u.as_str() != Some(label) {
                    return Err(fail("sender user"));
                }
            }
        }
    }
    obj.shift_remove("_cb");
    Ok(js_json::stringify(&Value::Object(obj)))
}
