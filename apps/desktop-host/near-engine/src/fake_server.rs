//! In-process fake of the link server, for the host's near tests (`cfg(test)` or the `near-testkit` feature,
//! which only the dev harness examples enable). Derived by reading `apps/api/src/link/link.service.ts`, the two
//! controllers and `link.dto.ts` on `claude/near-api`, plus contract section 11 items 7 and 8.
//!
//! MIRRORED: route paths, DTO field names, status codes and `error` codes; near-session rules (identity key
//! mandatory, no code); relay rules (seq strictly increasing -> 409, 32 per sender -> 409, base64 alphabet and
//! 2048 limit, side `a` needs bearer + x-device-id AND the scan pin); typed lookup (uniform 404, 5-miss 429);
//! scan pin with 409 `link_already_scanning` for a second device (11.8); session lifetime extended 120 s at a time
//! on relay activity up to 300 s from creation, `expires_in_s` authoritative (11.7); invites (create / poll /
//! join, owner pinned); deny; approve (proximity required, bad signature counts attempts, and when the test
//! registered the approver's identity key the REAL Ed25519 signature over the v2 string is verified); claim
//! single use.
//! v14 (security review 2026-11-20, `claude/near-api-v14`): relay token (`relay_auth_b64` at create and invite join, required for near
//! sessions; every side-`n` post carries `auth_b64` = base64(token), checked against the stored SHA-256; missing / wrong / malformed =
//! the uniform 404), `seq <= count + 8`, a refused post never extends the lifetime, and the scan pin is PROVISIONAL until the approver's
//! first valid relay post (a second scanner inside 10 s gets 409 `link_already_scanning`; after 10 s of silence it takes the pin over,
//! and the first device's later relay calls answer 403 `link_wrong_account`).
//! NOT MIRRORED: Redis atomicity / Lua, real wall-clock TTL (tests advance a virtual clock with `advance`), the
//! per-IP / per-account lookup budgets, every throttler bucket EXCEPT the relay GET one (100 per 10 s per side, real time,
//! fixed window, 429 + Retry-After), TOTP, attestation enforcement, JWT validation (any
//! bearer is accepted).
use super::api::{Auth, LinkApi};
use base64::Engine as _;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct Sess {
    pub near: bool,
    pub ek: String,
    pub label: String,
    pub platform: String,
    pub identity_key: String,
    pub code_hash: Option<String>,
    pub pinned: Option<String>,
    /// SHA-256 of the new device's relay token (standard base64), from create / join.
    pub relay_auth: Option<String>,
    /// The approver has made a valid relay post: the pin is final.
    pub pin_committed: bool,
    /// Virtual time of the (provisional) pin.
    pub pinned_at: u64,
    pub a: Vec<(u64, String)>,
    pub n: Vec<(u64, String)>,
    pub claim_secret: Option<String>,
    pub claimed: bool,
    pub envelope: Option<String>,
    pub denied: bool,
    pub bad: u32,
    pub approved_proximity: Option<String>,
    /// TEST: answer `scan` with this identity key instead of the registered one (a lying server, F4).
    pub scan_lie: Option<String>,
    deadline: u64,
    created: u64,
}

#[derive(Default)]
pub struct St {
    pub sessions: HashMap<String, Sess>,
    pub invites: HashMap<String, (String, Option<String>, u64)>, // id -> (owner device, joined?, deadline)
    pub misses: u32,
    pub seen_headers: Vec<(String, HashMap<String, String>)>,
    /// device id -> approver identity public key (b64): when present the approve signature is really verified.
    pub approver_keys: HashMap<String, String>,
    pub now: u64,
    /// Every relay GET the server received (real time, side `a`/`n`): the e2e counts these against the real bucket.
    pub relay_gets: Vec<(std::time::Instant, char)>,
    /// Emulate the relay GET bucket (100 per 10 s per caller, fixed window; the real server answers 429 + Retry-After).
    pub throttle_relay_gets: bool,
    /// How many GETs were refused with 429 so far.
    pub throttled: u32,
    /// Bucket size and window (the real server: 100 per 10 s). A test can shrink them to provoke a 429.
    pub bucket: u32,
    pub window_s: u64,
    windows: HashMap<char, (std::time::Instant, u32)>,
}

/// The relay GET budget the real server enforces: 100 per 10 s per caller.
pub const RELAY_GET_BUCKET: u32 = 100;
pub const RELAY_GET_WINDOW_S: u64 = 10;

pub struct Fake {
    pub port: u16,
    pub st: Arc<Mutex<St>>,
}

fn err(code: u16, e: &str, extra: Value) -> (u16, Value) {
    let mut b = json!({ "error": e, "message": format!("fake {e}") });
    if let Value::Object(m) = extra {
        for (k, v) in m {
            b[k] = v;
        }
    }
    (code, b)
}
fn left(s: &Sess, now: u64) -> u64 {
    s.deadline.saturating_sub(now.saturating_sub(s.created))
}
fn touch(s: &mut Sess, now: u64) {
    let age = now.saturating_sub(s.created);
    s.deadline = s.deadline.max((age + 120).min(300));
}

fn verify_sig(pubkey_b64: &str, msg: &str, sig_b64: &str) -> bool {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let dec = |s: &str| base64::engine::general_purpose::STANDARD.decode(s).ok();
    let (Some(k), Some(sig)) = (dec(pubkey_b64), dec(sig_b64)) else { return false };
    let (Ok(k), Ok(sig)) = (<[u8; 32]>::try_from(k), <[u8; 64]>::try_from(sig)) else { return false };
    VerifyingKey::from_bytes(&k).and_then(|vk| vk.verify(msg.as_bytes(), &Signature::from_bytes(&sig))).is_ok()
}

fn new_session(st: &mut St, id: String, body: &Value, pinned: Option<String>) -> Result<(), (u16, Value)> {
    if body["near"] != json!(true) || body["identity_key_pub_b64"].as_str().is_none() || body.get("code").is_some() {
        return Err(err(400, "bad", json!({})));
    }
    // F5: near sessions need the relay token's hash (standard base64 of a SHA-256 = 32 bytes)
    let dec = |s: &str| base64::engine::general_purpose::STANDARD.decode(s).ok();
    let relay_auth = match body["relay_auth_b64"].as_str() {
        Some(a) if dec(a).is_some_and(|v| v.len() == 32) => a.to_owned(),
        _ => return Err(err(400, "bad", json!({ "message": "relay_auth_b64 required" }))),
    };
    let hash = body["near_code_hash"].as_str().map(str::to_owned);
    if let Some(hh) = &hash {
        if st.sessions.values().any(|s| s.code_hash.as_deref() == Some(hh) && left(s, st.now) > 0) {
            return Err(err(409, "link_near_code_in_use", json!({})));
        }
    }
    let t = |k: &str| body[k].as_str().unwrap_or("").to_owned();
    st.sessions.insert(id, Sess { near: true, ek: t("ek_pub_b64"), label: t("device_label"), platform: t("platform"), identity_key: t("identity_key_pub_b64"), code_hash: hash, pinned, relay_auth: Some(relay_auth), pin_committed: false, pinned_at: st.now, deadline: 120, created: st.now, ..Default::default() });
    Ok(())
}

fn handle(st: &mut St, method: &str, path: &str, query: &str, h: &HashMap<String, String>, body: Value) -> (u16, Value) {
    let authed = h.get("authorization").is_some_and(|a| a.starts_with("Bearer ")) && h.contains_key("x-device-id");
    let now = st.now;
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    match (method, parts.as_slice()) {
        ("POST", ["v1", "link", "sessions"]) => {
            let id = cl_near::code::new_link_id();
            match new_session(st, id.clone(), &body, None) {
                Ok(()) => (201, json!({ "link_id": id, "ttl_s": 120, "expires_at": "x" })),
                Err(e) => e,
            }
        }
        ("DELETE", ["v1", "link", "sessions", id]) => {
            st.sessions.remove(*id);
            (200, json!({ "success": true }))
        }
        ("GET", ["v1", "link", "sessions", id]) => match st.sessions.get(*id) {
            None => (200, json!({ "state": "expired" })),
            Some(s) if left(s, now) == 0 => (200, json!({ "state": "expired" })),
            Some(s) if s.denied => (200, json!({ "state": "denied" })),
            Some(s) if s.envelope.is_some() => (200, json!({ "state": "granted", "envelope_b64": s.envelope })),
            Some(s) if s.claim_secret.is_some() => (200, json!({ "state": "approving" })),
            Some(s) if s.pinned.is_some() => (200, json!({ "state": "scanned", "expires_in_s": left(s, now) })),
            Some(s) => (200, json!({ "state": "pending", "expires_in_s": left(s, now) })),
        },
        ("POST", ["v1", "link", "near", "lookup"]) => {
            if !authed {
                return err(401, "unauth", json!({}));
            }
            if st.misses >= 5 {
                return err(429, "link_near_locked", json!({ "retry_after_s": 600 }));
            }
            let want = body["code_hash"].as_str().unwrap_or("");
            match st.sessions.iter().find(|(_, s)| s.code_hash.as_deref() == Some(want) && left(s, now) > 0 && s.claim_secret.is_none() && !s.denied) {
                Some((id, s)) => (200, json!({ "link_id": id, "ek_pub_b64": s.ek, "expires_in_s": left(s, now) })),
                None => {
                    st.misses += 1;
                    err(404, "link_near_code_unknown", json!({}))
                }
            }
        }
        ("POST", ["v1", "link", "sessions", id, "scan"]) => {
            if !authed {
                return err(401, "unauth", json!({}));
            }
            let dev = h["x-device-id"].clone();
            let Some(s) = st.sessions.get_mut(*id) else { return err(404, "nf", json!({})) };
            if left(s, now) == 0 {
                return err(404, "nf", json!({}));
            }
            match &s.pinned {
                // provisional pin: another scanner takes it over only after 10 s without the approver's first valid post (CAS)
                Some(p) if *p != dev && (s.pin_committed || now.saturating_sub(s.pinned_at) < 10) => return err(409, "link_already_scanning", json!({})),
                Some(p) if *p != dev => {
                    s.pinned = Some(dev);
                    s.pinned_at = now;
                }
                Some(_) => {}
                None => {
                    s.pinned = Some(dev);
                    s.pinned_at = now;
                }
            }
            (200, json!({ "v": 2, "device_label": s.label, "platform": s.platform, "expires_in_s": left(s, now), "requires_code": false, "requires_2fa": null, "identity_key_pub_b64": s.scan_lie.clone().unwrap_or_else(|| s.identity_key.clone()), "near": true, "requires_proximity": true }))
        }
        ("POST", ["v1", "link", "sessions", id, "relay"]) => {
            let Some(s) = st.sessions.get_mut(*id) else { return err(404, "nf", json!({})) };
            if left(s, now) == 0 {
                return err(404, "nf", json!({}));
            }
            let from = body["from"].as_str().unwrap_or("");
            let seq = body["seq"].as_u64().unwrap_or(0);
            let b = body["body_b64"].as_str().unwrap_or("");
            if seq < 1 || b.is_empty() || b.len() > 2048 || !b.bytes().all(|c| c.is_ascii_alphanumeric() || b"+/-_=".contains(&c)) || !matches!(from, "a" | "n") {
                return err(400, "bad", json!({}));
            }
            if from == "a" {
                if !authed {
                    return err(401, "unauth", json!({}));
                }
                match s.pinned.as_deref() {
                    None => return err(403, "link_not_scanned", json!({})),
                    Some(p) if p != h["x-device-id"].as_str() => return err(403, "link_wrong_account", json!({})),
                    _ => {}
                }
            } else {
                // F5: side n proves itself with the relay token; anything else is the uniform 404 of an unknown session
                let tok = body["auth_b64"].as_str().and_then(|t| base64::engine::general_purpose::STANDARD.decode(t).ok()).filter(|t| t.len() == 32);
                let ok = match (&tok, &s.relay_auth) {
                    (Some(t), Some(want)) => {
                        use sha2::{Digest, Sha256};
                        base64::engine::general_purpose::STANDARD.encode(Sha256::digest(t)) == *want
                    }
                    _ => false,
                };
                if !ok {
                    return err(404, "nf", json!({}));
                }
            }
            let count = if from == "a" { s.a.len() } else { s.n.len() } as u64;
            if seq > count + 8 {
                return err(400, "bad", json!({ "message": "seq too far ahead" }));
            }
            let list = if from == "a" { &mut s.a } else { &mut s.n };
            if list.len() >= 32 {
                return err(409, "link_relay_full", json!({}));
            }
            if list.last().is_some_and(|l| l.0 >= seq) {
                return err(409, "link_relay_seq", json!({}));
            }
            list.push((seq, b.to_owned()));
            let count = list.len();
            if from == "a" {
                s.pin_committed = true;
            }
            touch(s, now);
            (200, json!({ "success": true, "count": count }))
        }
        ("GET", ["v1", "link", "sessions", id, "relay"]) => {
            let side = if query.contains("as=a") { 'a' } else { 'n' };
            let at = std::time::Instant::now();
            st.relay_gets.push((at, side));
            if st.throttle_relay_gets {
                let w = st.windows.entry(side).or_insert((at, 0));
                if at.duration_since(w.0).as_secs() >= st.window_s {
                    *w = (at, 0);
                }
                w.1 += 1;
                if w.1 > st.bucket {
                    let wait = st.window_s.saturating_sub(at.duration_since(w.0).as_secs()).max(1);
                    st.throttled += 1;
                    return err(429, "throttled", json!({ "retry_after_s": wait }));
                }
            }
            let Some(s) = st.sessions.get_mut(*id) else { return err(404, "nf", json!({})) };
            let q: HashMap<_, _> = query.split('&').filter_map(|p| p.split_once('=')).collect();
            let after: u64 = q.get("after").and_then(|a| a.parse().ok()).unwrap_or(0);
            let as_a = q.get("as") == Some(&"a");
            if as_a && !authed {
                return err(403, "link_not_scanned", json!({}));
            }
            if as_a && s.pinned.as_deref() != Some(h["x-device-id"].as_str()) {
                return err(403, if s.pinned.is_some() { "link_wrong_account" } else { "link_not_scanned" }, json!({}));
            }
            if left(s, now) > 0 {
                touch(s, now);
            }
            let theirs = if as_a { &s.n } else { &s.a };
            (200, json!({ "messages": theirs.iter().filter(|m| m.0 > after).map(|m| json!({ "seq": m.0, "body_b64": m.1 })).collect::<Vec<_>>(), "expires_in_s": left(s, now) }))
        }
        ("POST", ["v1", "link", "sessions", id, "approve"]) => {
            if !authed {
                return err(401, "unauth", json!({}));
            }
            let dev = h["x-device-id"].clone();
            let key = st.approver_keys.get(&dev).cloned();
            let Some(s) = st.sessions.get_mut(*id) else { return err(404, "nf", json!({})) };
            if s.pinned.as_deref() != Some(dev.as_str()) {
                return err(403, "link_not_scanned", json!({}));
            }
            let prox = body["proximity"].as_str().unwrap_or("");
            if prox.is_empty() {
                return err(400, "link_proximity_required", json!({}));
            }
            if !matches!(prox, "ble" | "lan") {
                return err(400, "bad", json!({}));
            }
            let sig = body["approver_sig_b64"].as_str().unwrap_or("");
            let ts = body["approver_ts"].as_i64().unwrap_or(0);
            let msg = format!("cipherline-link-approve:v2:u1:{dev}:{id}:{}:{prox}:{ts}", s.identity_key);
            let good = match &key {
                Some(k) => verify_sig(k, &msg, sig),
                None => sig != "bad",
            };
            if !good {
                s.bad += 1;
                return err(403, "link_proximity_bad_signature", json!({ "attempts_left": 5u32.saturating_sub(s.bad) }));
            }
            s.claim_secret = Some("S".repeat(43));
            s.approved_proximity = Some(prox.to_owned());
            (200, json!({ "v": 2, "claim_secret": "S".repeat(43), "user_id": "u1", "approved_by_device_id": dev, "approved_by_device_name": "Old PC" }))
        }
        ("POST", ["v1", "link", "sessions", id, "grant"]) => {
            let Some(s) = st.sessions.get_mut(*id) else { return err(404, "nf", json!({})) };
            s.envelope = body["envelope_b64"].as_str().map(str::to_owned);
            (200, json!({ "success": true }))
        }
        ("POST", ["v1", "link", "sessions", id, "deny"]) => {
            let Some(s) = st.sessions.get_mut(*id) else { return err(404, "nf", json!({})) };
            s.denied = true;
            (200, json!({ "success": true }))
        }
        ("POST", ["v1", "link", "sessions", id, "claim"]) => {
            let Some(s) = st.sessions.get_mut(*id) else { return err(404, "nf", json!({})) };
            if s.claimed {
                return err(409, "conflict", json!({}));
            }
            if s.claim_secret.as_deref() != body["claim_secret"].as_str() {
                return err(403, "forbidden", json!({}));
            }
            s.claimed = true;
            (200, json!({ "access_token": "AT", "refresh_token": "RT", "user_id": "u1" }))
        }
        ("POST", ["v1", "link", "invites"]) => {
            if !authed {
                return err(401, "unauth", json!({}));
            }
            let id = cl_near::code::new_link_id();
            st.invites.insert(id.clone(), (h["x-device-id"].clone(), None, now + 120));
            (201, json!({ "invite_id": id, "ttl_s": 120 }))
        }
        ("GET", ["v1", "link", "invites", id]) => {
            if !authed {
                return err(401, "unauth", json!({}));
            }
            match st.invites.get(*id) {
                Some((_, _, dl)) if now >= *dl => (200, json!({ "state": "expired" })),
                Some((_, Some(sid), _)) => {
                    let s = &st.sessions[sid];
                    (200, json!({ "state": "joined", "device_label": s.label, "platform": s.platform, "ek_pub_b64": s.ek, "identity_key_pub_b64": s.identity_key, "near": true }))
                }
                Some(_) => (200, json!({ "state": "pending" })),
                None => (200, json!({ "state": "expired" })),
            }
        }
        ("POST", ["v1", "link", "invites", id, "join"]) => {
            let Some((owner, joined, dl)) = st.invites.get(*id).cloned() else { return err(404, "nf", json!({})) };
            if joined.is_some() || now >= dl {
                return err(404, "nf", json!({}));
            }
            match new_session(st, (*id).to_owned(), &body, Some(owner.clone())) {
                Ok(()) => {
                    st.invites.insert((*id).to_owned(), (owner, Some((*id).to_owned()), dl));
                    (200, json!({ "link_id": id, "ttl_s": 120 }))
                }
                Err(e) => e,
            }
        }
        _ => err(404, "nf", json!({})),
    }
}

impl Fake {
    pub fn start() -> Fake {
        Self::start_on(0)
    }
    /// Listen on a fixed loopback port (the browser harness builds the renderer against it); 0 = any free port.
    pub fn start_on(port: u16) -> Fake {
        let server = tiny_http::Server::http(("127.0.0.1", port)).unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let st = Arc::new(Mutex::new(St { throttle_relay_gets: true, bucket: RELAY_GET_BUCKET, window_s: RELAY_GET_WINDOW_S, ..St::default() }));
        let st2 = st.clone();
        std::thread::spawn(move || {
            for mut req in server.incoming_requests() {
                let url = req.url().to_owned();
                let (path, query) = url.split_once('?').unwrap_or((&url, ""));
                let h: HashMap<String, String> = req.headers().iter().map(|x| (x.field.as_str().as_str().to_ascii_lowercase(), x.value.as_str().to_owned())).collect();
                let mut b = String::new();
                let _ = req.as_reader().read_to_string(&mut b);
                let body: Value = serde_json::from_str(&b).unwrap_or(Value::Null);
                let method = req.method().as_str().to_owned();
                let (code, out) = {
                    let mut g = st2.lock().unwrap();
                    g.seen_headers.push((format!("{method} {path}"), h.clone()));
                    handle(&mut g, &method, path, query, &h, body)
                };
                let ct = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap();
                let mut resp = tiny_http::Response::from_string(out.to_string()).with_status_code(code).with_header(ct);
                if code == 429 && out["error"] == "throttled" {
                    // Nest's throttler: `Retry-After` in seconds, and a body WITHOUT our link_* code
                    let ra = tiny_http::Header::from_bytes(&b"Retry-After"[..], out["retry_after_s"].to_string().as_bytes()).unwrap();
                    resp = resp.with_header(ra);
                }
                let _ = req.respond(resp);
            }
        });
        Fake { port, st }
    }
    pub fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
    pub fn api(&self, auth: Option<&str>, attest: Option<&str>) -> LinkApi {
        LinkApi::new(&self.base(), auth.map(|d| Auth { access_token: "tok-secret".into(), device_id: d.into() }), attest.map(str::to_owned), "9.9.9").unwrap()
    }
    /// Move the virtual clock (session lifetimes).
    pub fn advance(&self, secs: u64) {
        self.st.lock().unwrap().now += secs;
    }
}
