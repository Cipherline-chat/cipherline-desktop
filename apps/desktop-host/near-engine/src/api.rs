//! HTTP client for the link / near routes (`apps/api/src/link/*` on `claude/near-api`; shapes and error codes
//! from `docs/qr-linking-server.md` there). Blocking `ureq` through the host's own agent builder (SChannel on
//! Windows), with the headers the renderer's axios stack sends: `X-Cipherline-Version`, `X-Cipherline-Attest`
//! (same HMAC as `attest.rs`), and for the approving device `Authorization: Bearer` + `x-device-id`.
//!
//! The access token is handed in by the renderer per session and lives only inside [`LinkApi`]; it is never
//! logged, never part of an error string, and the base URL is policed so it can only go to Cipherline's API.
use cl_near::error::NearError;
use cl_near::relay::{RelayBatch, RelayItem, RelayTransport, Side};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

const API_HOSTS: [&str; 2] = ["api.cipherline.chat", "api-staging.cipherline.chat"];

#[derive(Clone)]
pub struct Auth {
    pub access_token: String,
    pub device_id: String,
}

/// Validate where the bearer token may be sent. https to the two API hosts only. Debug/test builds also
/// accept `http://127.0.0.1:<port>` for the in-process fake server; that arm does not exist in release.
pub fn check_base(base: &str) -> Result<String, ApiError> {
    let bad = || ApiError::local("bad_api_base", "api base must be https://api.cipherline.chat or https://api-staging.cipherline.chat");
    let u = url::Url::parse(base).map_err(|_| bad())?;
    if !u.username().is_empty() || u.password().is_some() || u.query().is_some() || u.fragment().is_some() || !matches!(u.path(), "" | "/") {
        return Err(bad());
    }
    let host = u.host_str().unwrap_or("");
    let ok_prod = u.scheme() == "https" && API_HOSTS.contains(&host) && u.port().is_none();
    #[cfg(debug_assertions)]
    let ok_dev = u.scheme() == "http" && host == "127.0.0.1" && u.port().is_some();
    #[cfg(not(debug_assertions))]
    let ok_dev = false;
    if ok_prod || ok_dev {
        Ok(u.as_str().trim_end_matches('/').to_owned())
    } else {
        Err(bad())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ApiError {
    /// 0 = never reached the server.
    pub status: u16,
    /// The server's stable `error` code (`link_code_mismatch`, `link_near_locked`, ...), or a local one.
    pub code: String,
    pub message: String,
    pub attempts_left: Option<u32>,
    pub retry_after_s: Option<u64>,
}

impl ApiError {
    fn local(code: &str, message: &str) -> Self {
        Self { status: 0, code: code.into(), message: message.into(), attempts_left: None, retry_after_s: None }
    }
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({}): {}", self.code, self.status, self.message)
    }
}
impl From<ApiError> for NearError {
    fn from(e: ApiError) -> Self {
        // relay caps are protocol limits, everything else is transport
        if e.code == "link_relay_full" {
            NearError::RelayLimit("32 messages per session")
        } else if e.status == 429 && e.code != "link_near_locked" {
            // The throttler, not the session: back off what it asked (default 1 s). cl-near's poller waits and keeps
            // its own deadline, so this is never a failure of the exchange.
            NearError::Throttled { retry_after_ms: e.retry_after_s.unwrap_or(1).saturating_mul(1000).clamp(250, 10_000) }
        } else {
            NearError::Transport(e.to_string())
        }
    }
}

type R<T> = Result<T, ApiError>;

#[derive(Clone)]
pub struct LinkApi {
    base: String,
    auth: Option<Auth>,
    attest_secret: Option<String>,
    version: String,
    agent: ureq::Agent,
    /// F5: the new device's relay token (32 random bytes, memory only, zeroed on drop). Sent as `auth_b64` on every side-`n` post;
    /// the server holds only its SHA-256 (`relay_auth_b64`, sent at create). Never logged, never part of an error string.
    relay_token: Option<Arc<RelayToken>>,
}

/// The relay token of a near session this device created (F5). Not `Debug`/`Display`: it cannot reach a log by accident.
pub struct RelayToken(zeroize::Zeroizing<[u8; 32]>);

impl RelayToken {
    pub fn generate() -> Self {
        use rand_core::RngCore;
        let mut t = zeroize::Zeroizing::new([0u8; 32]);
        rand_core::OsRng.fill_bytes(&mut t[..]);
        Self(t)
    }
    /// `base64(SHA-256(token))`, standard alphabet with padding: what the server stores at create / invite join.
    pub fn auth_hash_b64(&self) -> String {
        use base64::Engine as _;
        use sha2::{Digest, Sha256};
        base64::engine::general_purpose::STANDARD.encode(Sha256::digest(&self.0[..]))
    }
    fn auth_b64(&self) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(&self.0[..])
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Created {
    pub link_id: String,
    pub ttl_s: u64,
}
#[derive(Debug, Clone, PartialEq)]
pub struct PollResult {
    pub state: String,
    pub envelope_b64: Option<String>,
    pub reason: Option<String>,
    pub expires_in_s: Option<u64>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct Lookup {
    pub link_id: String,
    pub ek_pub_b64: String,
    pub expires_in_s: u64,
}
#[derive(Debug, Clone, PartialEq)]
pub struct ScanInfo {
    pub device_label: String,
    pub platform: Option<String>,
    pub identity_key_pub_b64: Option<String>,
    pub near: bool,
    pub expires_in_s: u64,
}
#[derive(Debug, Clone, PartialEq)]
pub struct Approved {
    pub claim_secret: String,
    pub user_id: String,
    pub approved_by_device_id: String,
    pub approved_by_device_name: String,
}
#[derive(Debug, Clone, PartialEq)]
pub struct InvitePoll {
    pub state: String,
    pub device_label: Option<String>,
    pub platform: Option<String>,
    pub ek_pub_b64: Option<String>,
    pub identity_key_pub_b64: Option<String>,
    pub near: bool,
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}

impl LinkApi {
    pub fn new(base: &str, auth: Option<Auth>, attest_secret: Option<String>, version: &str) -> R<Self> {
        let base = check_base(base)?;
        let agent = crate::util::agent_builder().redirects(0).timeout(Duration::from_secs(15)).build();
        Ok(Self { base, auth, attest_secret: attest_secret.filter(|s| !s.is_empty()), version: version.into(), agent, relay_token: None })
    }

    fn request(&self, method: &str, path: &str) -> ureq::Request {
        let mut r = self.agent.request(method, &format!("{}{}", self.base, path)).set("X-Cipherline-Version", &self.version);
        if let Some(sec) = &self.attest_secret {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            r = r.set("X-Cipherline-Attest", &crate::util::attest_token(sec, now));
        }
        if let Some(a) = &self.auth {
            r = r.set("Authorization", &format!("Bearer {}", a.access_token)).set("x-device-id", &a.device_id);
        }
        r
    }

    fn finish(res: Result<ureq::Response, ureq::Error>) -> R<Value> {
        match res {
            Ok(r) => {
                let mut v = Vec::new();
                std::io::Read::read_to_end(&mut std::io::Read::take(r.into_reader(), 1 << 20), &mut v).ok();
                Ok(if v.is_empty() { Value::Null } else { serde_json::from_slice(&v).unwrap_or(Value::Null) })
            }
            Err(ureq::Error::Status(status, r)) => {
                // the throttler answers 429 with a `Retry-After` (seconds) header; a body field wins when present
                let header_retry = r.header("retry-after").and_then(|h| h.trim().parse::<u64>().ok());
                let mut v = Vec::new();
                std::io::Read::read_to_end(&mut std::io::Read::take(r.into_reader(), 1 << 16), &mut v).ok();
                let b: Value = serde_json::from_slice(&v).unwrap_or(Value::Null);
                // Nest puts `{error, message, ...extra}` for coded errors and `{statusCode, message, error: "Conflict"}` otherwise.
                let code = s(&b, "error").filter(|c| c.starts_with("link_")).unwrap_or_else(|| format!("http_{status}"));
                let message = match b.get("message") {
                    Some(Value::String(m)) => m.chars().take(200).collect(),
                    _ => String::new(),
                };
                Err(ApiError { status, code, message, attempts_left: b.get("attempts_left").and_then(Value::as_u64).map(|n| n as u32), retry_after_s: b.get("retry_after_s").and_then(Value::as_u64).or(header_retry) })
            }
            Err(e) => Err(ApiError::local("network", &format!("{}", e.kind()))),
        }
    }

    fn get(&self, path: &str) -> R<Value> {
        Self::finish(self.request("GET", path).call())
    }
    fn post(&self, path: &str, body: Value) -> R<Value> {
        Self::finish(self.request("POST", path).set("Content-Type", "application/json").send_string(&body.to_string()))
    }

    /// `POST /v1/link/sessions` with `near: true` (no code; the identity key is mandatory; `near_code_hash` for typed pairing).
    pub fn create_near_session(&self, ek_pub_b64: &str, label: &str, platform: &str, identity_key_pub_b64: &str, near_code_hash: Option<&str>, relay_auth_b64: &str) -> R<Created> {
        let mut b = json!({ "ek_pub_b64": ek_pub_b64, "device_label": label, "platform": platform, "identity_key_pub_b64": identity_key_pub_b64, "near": true, "relay_auth_b64": relay_auth_b64 });
        if let Some(h) = near_code_hash {
            b["near_code_hash"] = json!(h);
        }
        let v = self.post("/v1/link/sessions", b)?;
        Ok(Created { link_id: s(&v, "link_id").ok_or_else(|| ApiError::local("bad_response", "no link_id"))?, ttl_s: v.get("ttl_s").and_then(Value::as_u64).unwrap_or(120) })
    }

    pub fn poll_session(&self, id: &str) -> R<PollResult> {
        let v = self.get(&format!("/v1/link/sessions/{id}"))?;
        Ok(PollResult { state: s(&v, "state").unwrap_or_default(), envelope_b64: s(&v, "envelope_b64"), reason: s(&v, "reason"), expires_in_s: v.get("expires_in_s").and_then(Value::as_u64) })
    }

    pub fn destroy_session(&self, id: &str) -> R<()> {
        Self::finish(self.request("DELETE", &format!("/v1/link/sessions/{id}")).call()).map(|_| ())
    }

    /// Typed-code lookup (authenticated). 404 `link_near_code_unknown` for every miss; 429 `link_near_locked` + `retry_after_s`.
    pub fn lookup(&self, code_hash_hex: &str) -> R<Lookup> {
        let v = self.post("/v1/link/near/lookup", json!({ "code_hash": code_hash_hex }))?;
        Ok(Lookup { link_id: s(&v, "link_id").unwrap_or_default(), ek_pub_b64: s(&v, "ek_pub_b64").unwrap_or_default(), expires_in_s: v.get("expires_in_s").and_then(Value::as_u64).unwrap_or(0) })
    }

    /// Pins this device as the approver (first scan wins).
    pub fn scan(&self, id: &str) -> R<ScanInfo> {
        let v = self.post(&format!("/v1/link/sessions/{id}/scan"), json!({}))?;
        Ok(ScanInfo { device_label: s(&v, "device_label").unwrap_or_default(), platform: s(&v, "platform"), identity_key_pub_b64: s(&v, "identity_key_pub_b64"), near: v.get("near").and_then(Value::as_bool).unwrap_or(false), expires_in_s: v.get("expires_in_s").and_then(Value::as_u64).unwrap_or(0) })
    }

    /// v2 approval: `approver_sig_b64` over `link_approve_message_v2`, `proximity` = "ble" | "lan".
    pub fn approve_near(&self, id: &str, sig_b64: &str, ts: i64, proximity: &str) -> R<Approved> {
        let v = self.post(&format!("/v1/link/sessions/{id}/approve"), json!({ "approver_sig_b64": sig_b64, "approver_ts": ts, "proximity": proximity }))?;
        let need = |k: &str| s(&v, k).ok_or_else(|| ApiError::local("bad_response", &format!("approve response lacks {k}")));
        Ok(Approved { claim_secret: need("claim_secret")?, user_id: need("user_id")?, approved_by_device_id: need("approved_by_device_id")?, approved_by_device_name: need("approved_by_device_name")? })
    }

    pub fn grant(&self, id: &str, envelope_b64: &str) -> R<()> {
        self.post(&format!("/v1/link/sessions/{id}/grant"), json!({ "envelope_b64": envelope_b64 })).map(|_| ())
    }
    pub fn deny(&self, id: &str) -> R<()> {
        self.post(&format!("/v1/link/sessions/{id}/deny"), json!({})).map(|_| ())
    }
    /// Unauthenticated: the claim secret is the proof. Returns the raw token pair JSON (callers hand it to the renderer's auth, never log it).
    pub fn claim(&self, id: &str, claim_secret: &str) -> R<Value> {
        self.post(&format!("/v1/link/sessions/{id}/claim"), json!({ "claim_secret": claim_secret }))
    }

    pub fn create_invite(&self) -> R<Created> {
        let v = self.post("/v1/link/invites", json!({}))?;
        Ok(Created { link_id: s(&v, "invite_id").ok_or_else(|| ApiError::local("bad_response", "no invite_id"))?, ttl_s: v.get("ttl_s").and_then(Value::as_u64).unwrap_or(120) })
    }
    pub fn poll_invite(&self, id: &str) -> R<InvitePoll> {
        let v = self.get(&format!("/v1/link/invites/{id}"))?;
        Ok(InvitePoll { state: s(&v, "state").unwrap_or_default(), device_label: s(&v, "device_label"), platform: s(&v, "platform"), ek_pub_b64: s(&v, "ek_pub_b64"), identity_key_pub_b64: s(&v, "identity_key_pub_b64"), near: v.get("near").and_then(Value::as_bool).unwrap_or(false) })
    }

    #[cfg(test)]
    pub fn join_invite_for_tests(&self, id: &str, body: Value) -> R<Value> {
        self.post(&format!("/v1/link/invites/{id}/join"), body)
    }

    pub fn relay_post(&self, id: &str, side: Side, seq: u64, body: &[u8]) -> R<()> {
        use base64::Engine as _;
        let b = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(body);
        self.post_relay(id, side, json!({ "from": side.relay_char().to_string(), "seq": seq, "body_b64": b })).map(|_| ())
    }
    fn post_relay(&self, id: &str, side: Side, mut body: Value) -> R<Value> {
        // side N has no bearer / device id and proves itself with the relay token (F5); side A carries bearer + device id. A side-N
        // post without a token would only be a uniform 404 from the server, so it is refused here instead.
        if side == Side::N {
            let t = self.relay_token.as_ref().ok_or_else(|| ApiError::local("no_relay_token", "side n has no relay token"))?;
            body["auth_b64"] = json!(t.auth_b64());
        }
        let req = self.request("POST", &format!("/v1/link/sessions/{id}/relay"));
        Self::finish(req.set("Content-Type", "application/json").send_string(&body.to_string()))
    }
    pub fn relay_fetch(&self, id: &str, as_side: Side, after: u64) -> R<RelayBatch> {
        use base64::Engine as _;
        let req = self.request("GET", &format!("/v1/link/sessions/{id}/relay")).query("as", &as_side.relay_char().to_string()).query("after", &after.to_string());
        let v = Self::finish(req.call())?;
        let mut items = vec![];
        for m in v.get("messages").and_then(Value::as_array).cloned().unwrap_or_default() {
            let seq = m.get("seq").and_then(Value::as_u64).ok_or_else(|| ApiError::local("bad_response", "relay seq"))?;
            let b = m.get("body_b64").and_then(Value::as_str).ok_or_else(|| ApiError::local("bad_response", "relay body"))?;
            // the server may hold standard or url-safe, padded or not
            let body = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(b.trim_end_matches('=').replace('+', "-").replace('/', "_")).map_err(|_| ApiError::local("bad_response", "relay body encoding"))?;
            items.push(RelayItem { seq, body });
        }
        Ok(RelayBatch { messages: items, expires_in_s: v.get("expires_in_s").and_then(Value::as_u64).unwrap_or(0) })
    }
}

impl LinkApi {
    /// A clone that sends no credentials (the new device's side of the relay and `poll`/`claim`).
    pub fn anonymous(&self) -> Self {
        Self { auth: None, relay_token: None, ..self.clone() }
    }
    /// The new device's api for ONE session: no credentials, holding that session's relay token.
    pub fn with_relay_token(&self, token: Arc<RelayToken>) -> Self {
        Self { auth: None, relay_token: Some(token), ..self.clone() }
    }
}

/// cl-near's relay transport over the HTTP relay routes. One per side; `N` uses an anonymous api.
#[derive(Clone)]
pub struct HttpRelay {
    api: Arc<LinkApi>,
    link_id: String,
}

impl HttpRelay {
    pub fn new(api: &LinkApi, side: Side, link_id: &str) -> Self {
        // side N never sends the bearer; it keeps whatever relay token `api` carries (see `with_relay_token`)
        let api = if side == Side::N { LinkApi { auth: None, ..api.clone() } } else { api.clone() };
        Self { api: Arc::new(api), link_id: link_id.to_owned() }
    }
}

impl RelayTransport for HttpRelay {
    async fn post(&self, from: Side, seq: u64, body: Vec<u8>) -> cl_near::error::Result<()> {
        // A POST that is throttled is retried after the server's Retry-After (a few times): dropping a sealed message would
        // desynchronise the two sides.
        let mut tries = 0;
        loop {
            let (api, id, b) = (self.api.clone(), self.link_id.clone(), body.clone());
            let r = tokio::task::spawn_blocking(move || api.relay_post(&id, from, seq, &b)).await.map_err(|e| NearError::Transport(e.to_string()))?;
            match r.map_err(NearError::from) {
                Err(NearError::Throttled { retry_after_ms }) if tries < 4 => {
                    tries += 1;
                    tokio::time::sleep(std::time::Duration::from_millis(retry_after_ms)).await;
                }
                other => return other,
            }
        }
    }
    async fn fetch(&self, as_side: Side, after: u64) -> cl_near::error::Result<RelayBatch> {
        let (api, id) = (self.api.clone(), self.link_id.clone());
        tokio::task::spawn_blocking(move || api.relay_fetch(&id, as_side, after)).await.map_err(|e| NearError::Transport(e.to_string()))?.map_err(Into::into)
    }
}

#[cfg(test)]
mod tests;
