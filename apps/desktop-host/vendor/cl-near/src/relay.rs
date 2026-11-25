//! Section 3: the blind relay. hello / hello_ack confirmations, sealed messages, the typed message enum,
//! and the transport trait the HTTP relay (cl-sync, later) and the own-device control-message relay
//! (section 7) both implement.
use std::collections::VecDeque;
use std::future::Future;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hmac::{Hmac, Mac};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::b64;
use crate::code::ProximitySecret;
use crate::error::{NearError, Result};
use crate::keys::{self, SessionKeys};

/// The server accepts at most 2048 base64 characters per message: 1536 bytes.
pub const MAX_BODY_BYTES: usize = 1536;
/// The server keeps at most 32 messages per session.
pub const MAX_MESSAGES: usize = 32;
const MAX_ADDRS: usize = 8;
const MAX_REASON: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    /// The approving device.
    A,
    /// The new device.
    N,
}

impl Side {
    /// The relay API's `from` / `as` value; also what the AAD carries.
    pub fn relay_char(self) -> char { match self { Side::A => 'a', Side::N => 'n' } }
    pub fn other(self) -> Side { match self { Side::A => Side::N, Side::N => Side::A } }
    fn mac_tag(self) -> &'static [u8] { match self { Side::A => b"A", Side::N => b"N" } }
    pub fn from_relay_char(c: &str) -> Result<Side> {
        match c { "a" => Ok(Side::A), "n" => Ok(Side::N), _ => Err(NearError::Malformed("relay side")) }
    }
}

/// What kind of device this is, declared explicitly in `caps` (contract section 10). It decides who listens on the local
/// network ("the phone when exactly one side is a phone; otherwise A").
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DeviceKind {
    Phone,
    #[default]
    Desktop,
}

impl DeviceKind {
    pub fn as_str(self) -> &'static str { match self { DeviceKind::Phone => "phone", DeviceKind::Desktop => "desktop" } }
    pub fn parse(s: &str) -> Option<DeviceKind> { match s { "phone" => Some(DeviceKind::Phone), "desktop" => Some(DeviceKind::Desktop), _ => None } }
}

/// The operating system, stated in `caps` (contract section 11.6): on desktop to desktop the side that is NOT Windows listens,
/// because a listening socket on Windows raises a firewall prompt.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Os { Windows, Mac, Linux, Ios, Android, #[default] Other }

impl Os {
    pub fn as_str(self) -> &'static str {
        match self { Os::Windows => "windows", Os::Mac => "mac", Os::Linux => "linux", Os::Ios => "ios", Os::Android => "android", Os::Other => "other" }
    }
    pub fn parse(s: &str) -> Os {
        match s { "windows" => Os::Windows, "mac" => Os::Mac, "linux" => Os::Linux, "ios" => Os::Ios, "android" => Os::Android, _ => Os::Other }
    }
}

/// What a device says about itself inside the sealed channel (contract section 11.2). The approval sheet names the device by THIS
/// label, never by the server-relayed session label, so the server cannot change what the sheet says.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Who {
    pub label: String,
    pub platform: String,
}

/// At most 64 characters; control characters and bidirectional / zero-width marks removed (the same set the server strips).
pub fn sanitize_label(raw: &str) -> String {
    let cleaned: String = raw.chars().filter(|c| {
        !(c.is_control() || matches!(*c as u32, 0x061C | 0x200B..=0x200F | 0x202A..=0x202E | 0x2066..=0x2069 | 0xFEFF))
    }).collect();
    cleaned.trim().chars().take(64).collect()
}

/// What a device can do (section 3 `caps`) and what it is (`kind`, `os`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Caps {
    pub os: Os,
    pub kind: DeviceKind,
    pub ble_adv: bool,
    pub ble_scan: bool,
    pub lan_listen: bool,
    pub lan_dial: bool,
}

impl Caps {
    pub fn is_phone(&self) -> bool { self.kind == DeviceKind::Phone }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LanOffer {
    pub addrs: Vec<IpAddr>,
    pub port: u16,
    /// SHA-256 of the listener's certificate DER.
    pub fp: [u8; 32],
}

/// Typed relay messages. `t` is the discriminator on the wire; unknown fields are refused.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case", deny_unknown_fields)]
pub enum Message {
    /// N's confirmation, sent as its first (sealed) message. `conf` is base64url. `ik` is N's own identity public key (32 bytes,
    /// base64url): the MAC covers it ([`conf_mac_n`]) and A refuses to sign unless it equals the key the server announced at scan (F4).
    HelloAck { conf: String, ik: String },
    /// Capability names: `ble_adv`, `ble_scan`, `lan_listen`, `lan_dial`. Unknown names are ignored.
    /// `kind` is `phone` | `desktop` and is REQUIRED (contract section 10): a missing or unknown value makes
    /// [`Message::caps_checked`] fail, and the caller aborts the session.
    Caps {
        caps: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] kind: Option<String>,
        /// Contract 11.2 / 11.6: what the device calls itself, its platform and its OS. All optional on the wire.
        #[serde(default, skip_serializing_if = "Option::is_none")] label: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] platform: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] os: Option<String>,
    },
    /// A tells N which side advertises: `"a"` or `"n"`. (Field set not fixed by the contract.)
    BleStart { advertiser: String },
    /// `mac` = base64url HMAC(K_conf, "ble" || r).
    BleHeard { mac: String },
    /// The advertiser's answer to a verified `ble_heard` (L1): `mac` = base64url HMAC(K_conf, "ble-ack" || r). A scanning A accepts the
    /// Bluetooth proof only when this arrives, so hearing a UUID alone (a 32-bit tag) is not the proof.
    BleAck { mac: String },
    LanOffer { addrs: Vec<String>, port: u16, fp: String },
    /// Outcome of the LAN proof. (Field set not fixed by the contract.)
    /// `purpose: "transfer_probe"` marks the local-network probe run after a Bluetooth proof (contract 11.5): its failure is not a refusal.
    LanResult { ok: bool, #[serde(default, skip_serializing_if = "Option::is_none")] reason: Option<String>, #[serde(default, skip_serializing_if = "Option::is_none")] purpose: Option<String> },
    /// Sent by the verifier of the Bluetooth proof (A) as soon as the outcome is known (contract 11.4). `cause` is one of
    /// [`BLE_CAUSES`] when `ok` is false.
    BleResult { ok: bool, #[serde(default, skip_serializing_if = "Option::is_none")] cause: Option<String> },
    /// Informational progress from A for N's screen (contract 11.17): never unlocks anything on N. `stage` is one of [`STATUS_STAGES`];
    /// `proximity` (`ble` | `lan`) accompanies `proof_ok`.
    Status { stage: String, #[serde(default, skip_serializing_if = "Option::is_none")] proximity: Option<String> },
    /// `reason` is one of [`ABORT_REASONS`]; a `no_proximity` carries the per-proof causes (contract 11.3).
    Abort {
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")] ble: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")] lan: Option<String>,
    },
}

/// The closed set of `abort` reasons (contract 11.3). Unknown reasons parse (so a newer peer does not break an older one) and are
/// treated as `error` by [`Message::abort_reason`].
pub const ABORT_REASONS: [&str; 6] = ["no_proximity", "denied", "cancelled", "expired", "burned", "error"];
pub const STATUS_STAGES: [&str; 4] = ["checking_ble", "checking_lan", "proof_ok", "awaiting_user"];
pub const BLE_CAUSES: [&str; 6] = ["ok", "off", "denied", "no_adapter", "not_found", "skipped"];
pub const LAN_CAUSES: [&str; 5] = ["ok", "not_found", "denied", "firewall", "skipped"];

impl Message {
    pub fn caps(c: &Caps) -> Message {
        let mut v = vec![];
        if c.ble_adv { v.push("ble_adv".to_owned()) }
        if c.ble_scan { v.push("ble_scan".to_owned()) }
        if c.lan_listen { v.push("lan_listen".to_owned()) }
        if c.lan_dial { v.push("lan_dial".to_owned()) }
        Message::Caps { caps: v, kind: Some(c.kind.as_str().to_owned()), label: None, platform: None, os: Some(c.os.as_str().to_owned()) }
    }
    /// `caps` with the device's own label and platform (contract 11.2). The label is sanitised here.
    pub fn caps_full(c: &Caps, who: &Who) -> Message {
        match Message::caps(c) {
            Message::Caps { caps, kind, os, .. } => Message::Caps { caps, kind, os, label: Some(sanitize_label(&who.label)), platform: Some(who.platform.chars().take(16).collect()) },
            other => other,
        }
    }
    pub fn status(stage: &str, proximity: Option<&str>) -> Message { Message::Status { stage: stage.to_owned(), proximity: proximity.map(str::to_owned) } }
    pub fn ble_result(ok: bool, cause: Option<&str>) -> Message { Message::BleResult { ok, cause: cause.map(str::to_owned) } }
    pub fn abort_no_proximity(ble: &str, lan: &str) -> Message { Message::Abort { reason: "no_proximity".into(), ble: Some(ble.to_owned()), lan: Some(lan.to_owned()) } }
    /// The sanitised label and platform a `caps` message carries.
    pub fn who(&self) -> Option<Who> {
        if let Message::Caps { label, platform, .. } = self {
            Some(Who { label: sanitize_label(label.as_deref().unwrap_or("")), platform: platform.clone().unwrap_or_default() })
        } else { None }
    }
    /// An `abort` as one of the closed reasons plus its causes (`ble`, `lan`); unknown reasons read as `error`.
    pub fn abort_reason(&self) -> Option<(&str, Option<&str>, Option<&str>)> {
        if let Message::Abort { reason, ble, lan } = self {
            let r = ABORT_REASONS.iter().find(|x| **x == reason).copied().unwrap_or("error");
            Some((r, ble.as_deref(), lan.as_deref()))
        } else { None }
    }
    pub fn ble_start(advertiser: Side) -> Message { Message::BleStart { advertiser: advertiser.relay_char().to_string() } }
    pub fn ble_heard(mac: &[u8; 32]) -> Message { Message::BleHeard { mac: b64::enc(mac) } }
    pub fn ble_ack(mac: &[u8; 32]) -> Message { Message::BleAck { mac: b64::enc(mac) } }
    pub fn lan_offer(o: &LanOffer) -> Message {
        Message::LanOffer { addrs: o.addrs.iter().map(|a| a.to_string()).collect(), port: o.port, fp: b64::enc(&o.fp) }
    }
    pub fn lan_result(ok: bool, reason: Option<&str>) -> Message { Message::LanResult { ok, reason: reason.map(str::to_owned), purpose: None } }
    pub fn lan_probe_result(ok: bool, reason: Option<&str>) -> Message { Message::LanResult { ok, reason: reason.map(str::to_owned), purpose: Some("transfer_probe".into()) } }
    pub fn abort(reason: &str) -> Message { Message::Abort { reason: reason.to_owned(), ble: None, lan: None } }

    /// Field-level validation. [`NearSession::open`] runs it on every message it returns.
    pub fn validate(&self) -> Result<()> {
        match self {
            Message::HelloAck { conf, ik } => { b64::dec_arr::<32>(conf, "conf")?; b64::dec_arr::<32>(ik, "identity key")?; }
            Message::Caps { caps, kind, label, platform, os } => {
                if kind.as_ref().is_some_and(|k| k.len() > 16) || os.as_ref().is_some_and(|k| k.len() > 16) || platform.as_ref().is_some_and(|k| k.len() > 16) { return Err(NearError::Malformed("caps kind")); }
                if label.as_ref().is_some_and(|l| l.chars().count() > 64) { return Err(NearError::Malformed("caps label")); }
                if caps.len() > 16 || caps.iter().any(|c| c.len() > 32) { return Err(NearError::Malformed("caps")); }
            }
            Message::BleStart { advertiser } => { Side::from_relay_char(advertiser)?; }
            Message::BleHeard { mac } | Message::BleAck { mac } => { b64::dec_arr::<32>(mac, "ble mac")?; }
            Message::LanOffer { .. } => { self.lan_offer_typed()?; }
            Message::LanResult { reason, purpose, .. } => {
                if let Some(r) = reason { check_reason(r)?; }
                if let Some(p) = purpose { check_reason(p)?; }
            }
            Message::Status { stage, proximity } => {
                if !STATUS_STAGES.contains(&stage.as_str()) || proximity.as_deref().is_some_and(|p| p != "ble" && p != "lan") { return Err(NearError::Malformed("status")); }
            }
            Message::BleResult { cause, .. } => { if let Some(c) = cause { check_reason(c)?; } }
            Message::Abort { reason, ble, lan } => {
                check_reason(reason)?;
                if ble.as_deref().is_some_and(|c| !BLE_CAUSES.contains(&c)) || lan.as_deref().is_some_and(|c| !LAN_CAUSES.contains(&c)) { return Err(NearError::Malformed("abort cause")); }
            }
        }
        Ok(())
    }

    /// `None` for anything but a `caps` message with a known `kind`.
    pub fn caps_typed(&self) -> Option<Caps> {
        if let Message::Caps { caps, kind, os, .. } = self {
            let kind = DeviceKind::parse(kind.as_deref()?)?;
            let os = os.as_deref().map(Os::parse).unwrap_or_default();
            let has = |n: &str| caps.iter().any(|c| c == n);
            Some(Caps { os, kind, ble_adv: has("ble_adv"), ble_scan: has("ble_scan"), lan_listen: has("lan_listen"), lan_dial: has("lan_dial") })
        } else { None }
    }

    /// As [`Message::caps_typed`], but a `caps` message with a missing or unknown `kind` is a protocol error (the caller aborts).
    pub fn caps_checked(&self) -> Result<Caps> {
        self.caps_typed().ok_or_else(|| NearError::Protocol("caps without a known device kind".into()))
    }

    pub fn lan_offer_typed(&self) -> Result<LanOffer> {
        let Message::LanOffer { addrs, port, fp } = self else { return Err(NearError::Malformed("not a lan_offer")) };
        // F9: ports below 1024 are well-known services, never an ephemeral Cipherline listener.
        if addrs.is_empty() || addrs.len() > MAX_ADDRS || *port < crate::lan::MIN_OFFER_PORT {
            return Err(NearError::Malformed("lan_offer"));
        }
        let mut out = Vec::with_capacity(addrs.len());
        for a in addrs {
            // IP literals only; a zone id (`%eth0`) is refused: the dialer picks its own scope.
            out.push(a.parse::<IpAddr>().map_err(|_| NearError::Malformed("lan_offer address"))?);
        }
        Ok(LanOffer { addrs: out, port: *port, fp: b64::dec_arr::<32>(fp, "lan_offer fp")? })
    }
}

fn check_reason(r: &str) -> Result<()> {
    if r.len() > MAX_REASON || !r.bytes().all(|b| b.is_ascii_graphic()) { Err(NearError::Malformed("reason")) } else { Ok(()) }
}

// ---- cleartext hello ------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HelloWire {
    t: String,
    ea: String,
    conf: String,
}

/// `HMAC(K_conf, side_tag || linkId || eN_pub || eA_pub)` with side_tag `"A"` or `"N"`.
pub fn conf_mac(keys: &SessionKeys, side: Side, link_id: &str, en_pub: &[u8; 32], ea_pub: &[u8; 32]) -> [u8; 32] {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(keys.conf.as_ref()).expect("any key length");
    m.update(side.mac_tag());
    m.update(link_id.as_bytes());
    m.update(en_pub);
    m.update(ea_pub);
    m.finalize().into_bytes().into()
}

/// N's confirmation: `HMAC(K_conf, "N" || linkId || eN_pub || eA_pub || ik)` (F4). `ik` is N's identity public key, 32 raw bytes.
pub fn conf_mac_n(keys: &SessionKeys, link_id: &str, en_pub: &[u8; 32], ea_pub: &[u8; 32], ik: &[u8; 32]) -> [u8; 32] {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(keys.conf.as_ref()).expect("any key length");
    m.update(Side::N.mac_tag());
    m.update(link_id.as_bytes());
    m.update(en_pub);
    m.update(ea_pub);
    m.update(ik);
    m.finalize().into_bytes().into()
}

fn verify_conf(keys: &SessionKeys, side: Side, link_id: &str, en_pub: &[u8; 32], ea_pub: &[u8; 32], got: &[u8]) -> bool {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(keys.conf.as_ref()).expect("any key length");
    m.update(side.mac_tag());
    m.update(link_id.as_bytes());
    m.update(en_pub);
    m.update(ea_pub);
    m.verify_slice(got).is_ok()
}

fn verify_conf_n(keys: &SessionKeys, link_id: &str, en_pub: &[u8; 32], ea_pub: &[u8; 32], ik: &[u8; 32], got: &[u8]) -> bool {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(keys.conf.as_ref()).expect("any key length");
    m.update(Side::N.mac_tag());
    m.update(link_id.as_bytes());
    m.update(en_pub);
    m.update(ea_pub);
    m.update(ik);
    m.verify_slice(got).is_ok()
}

// ---- sealing --------------------------------------------------------------------------------

/// `"near-relay:v1:" || linkId || from || seq`, `from` the relay's `a`/`n`, `seq` in decimal ASCII.
pub fn relay_aad(link_id: &str, from: Side, seq: u64) -> Vec<u8> {
    let mut a = b"near-relay:v1:".to_vec();
    a.extend_from_slice(link_id.as_bytes());
    a.push(from.relay_char() as u8);
    a.extend_from_slice(seq.to_string().as_bytes());
    a
}

/// `nonce(12) || ciphertext || tag(16)`. Exposed with an explicit nonce for known-answer vectors only.
pub fn seal_with_nonce(key: &[u8; 32], aad: &[u8], nonce: [u8; 12], plaintext: &[u8]) -> Result<Vec<u8>> {
    let ct = Aes256Gcm::new_from_slice(key).expect("32-byte key")
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad })
        .map_err(|_| NearError::Auth("seal"))?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    if out.len() > MAX_BODY_BYTES { return Err(NearError::RelayLimit("message exceeds 2048 base64 characters")); }
    Ok(out)
}

pub fn open_body(key: &[u8; 32], aad: &[u8], body: &[u8]) -> Result<Vec<u8>> {
    if body.len() < 12 + 16 || body.len() > MAX_BODY_BYTES { return Err(NearError::Malformed("relay body size")); }
    Aes256Gcm::new_from_slice(key).expect("32-byte key")
        .decrypt(Nonce::from_slice(&body[..12]), Payload { msg: &body[12..], aad })
        .map_err(|_| NearError::Auth("relay message"))
}

/// A message ready for `RelayTransport::post`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outgoing {
    pub seq: u64,
    pub body: Vec<u8>,
}

/// One side's view of an established (or establishing) near session.
pub struct NearSession {
    side: Side,
    link_id: String,
    en_pub: [u8; 32],
    ea_pub: [u8; 32],
    keys: SessionKeys,
    next_seq: u64,
    peer_last_seq: u64,
    confirmed: bool,
}

impl NearSession {
    pub fn side(&self) -> Side { self.side }
    pub fn link_id(&self) -> &str { &self.link_id }
    pub fn keys(&self) -> &SessionKeys { &self.keys }
    pub fn is_confirmed(&self) -> bool { self.confirmed }

    /// A: generate `eA`, derive keys from N's `eN_pub` and the scanned secret, and build the cleartext
    /// hello (A's seq 1). The ephemeral private key is dropped (zeroed) here; only `K*` survive.
    pub fn approver_start(link_id: &str, en_pub: &[u8; 32], salt: &[u8]) -> Result<(NearSession, Outgoing)> {
        let (ea_priv, ea_pub) = keys::generate_keypair();
        Self::approver_start_with(link_id, en_pub, salt, &ea_priv, &ea_pub)
    }

    /// As [`approver_start`] with a caller-chosen ephemeral key (known-answer tests).
    pub fn approver_start_with(link_id: &str, en_pub: &[u8; 32], salt: &[u8], ea_priv: &[u8; 32], ea_pub: &[u8; 32]) -> Result<(NearSession, Outgoing)> {
        let keys = keys::session_keys(ea_priv, en_pub, salt, link_id)?;
        let conf = conf_mac(&keys, Side::A, link_id, en_pub, ea_pub);
        let body = serde_json::to_vec(&HelloWire { t: "hello".into(), ea: b64::enc(ea_pub), conf: b64::enc(&conf) })
            .map_err(|_| NearError::Malformed("hello"))?;
        let s = NearSession {
            side: Side::A, link_id: link_id.to_owned(), en_pub: *en_pub, ea_pub: *ea_pub, keys,
            next_seq: 2, peer_last_seq: 0, confirmed: false,
        };
        Ok((s, Outgoing { seq: 1, body }))
    }

    /// N: take A's hello. Derive `K` with each candidate salt in order (current secret, then previous);
    /// the first whose `conf` verifies wins. If none does the session must be dropped.
    /// Returns the session and N's sealed `hello_ack` (N's seq 1), which carries `ik`, N's own identity public key, under the confirmation (F4).
    pub fn accept_hello(link_id: &str, en_priv: &[u8; 32], salts: &[&[u8]], hello_seq: u64, hello_body: &[u8], ik: &[u8; 32]) -> Result<(NearSession, Outgoing)> {
        if hello_seq == 0 || hello_body.len() > MAX_BODY_BYTES { return Err(NearError::Malformed("hello")); }
        let h: HelloWire = serde_json::from_slice(hello_body).map_err(|_| NearError::Malformed("hello"))?;
        if h.t != "hello" { return Err(NearError::Malformed("hello")); }
        let ea_pub = b64::dec_arr::<32>(&h.ea, "hello ea")?;
        let conf = b64::dec_arr::<32>(&h.conf, "hello conf")?;
        let en_pub = keys::public_of(en_priv);
        let mut found = None;
        for salt in salts {
            // A low-order `ea` fails here for every candidate.
            let keys = keys::session_keys(en_priv, &ea_pub, salt, link_id)?;
            if verify_conf(&keys, Side::A, link_id, &en_pub, &ea_pub, &conf) {
                found = Some(keys);
                break;
            }
        }
        let keys = found.ok_or(NearError::Auth("hello confirmation"))?;
        let mut s = NearSession {
            side: Side::N, link_id: link_id.to_owned(), en_pub, ea_pub, keys,
            next_seq: 1, peer_last_seq: hello_seq, confirmed: true,
        };
        let ack_conf = conf_mac_n(&s.keys, link_id, &en_pub, &ea_pub, ik);
        let ack = s.seal(&Message::HelloAck { conf: b64::enc(&ack_conf), ik: b64::enc(ik) })?;
        Ok((s, ack))
    }

    /// A: verify N's `hello_ack` and that the identity key it carries is `expected_ik`, the key the SERVER announced for the new device at
    /// scan (F4). Until this succeeds A must do nothing else. `Auth("hello_ack confirmation")` = wrong secret / key; `IdentityMismatch` =
    /// the MAC is right but names a different identity key than the server said (both are final for the session).
    pub fn accept_hello_ack(&mut self, seq: u64, body: &[u8], expected_ik: &[u8; 32]) -> Result<()> {
        if self.side != Side::A || self.confirmed { return Err(NearError::Protocol("unexpected hello_ack".into())); }
        let msg = self.open_inner(seq, body)?;
        let Message::HelloAck { conf, ik } = msg else { return Err(NearError::Protocol("expected hello_ack".into())) };
        let conf = b64::dec_arr::<32>(&conf, "conf")?;
        let ik = b64::dec_arr::<32>(&ik, "identity key")?;
        if !verify_conf_n(&self.keys, &self.link_id, &self.en_pub, &self.ea_pub, &ik, &conf) {
            return Err(NearError::Auth("hello_ack confirmation"));
        }
        if !bool::from(subtle::ConstantTimeEq::ct_eq(&ik[..], &expected_ik[..])) { return Err(NearError::IdentityMismatch); }
        self.peer_last_seq = seq;
        self.confirmed = true;
        Ok(())
    }

    pub fn seal(&mut self, msg: &Message) -> Result<Outgoing> {
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        self.seal_with_nonce(msg, nonce)
    }

    pub fn seal_with_nonce(&mut self, msg: &Message, nonce: [u8; 12]) -> Result<Outgoing> {
        msg.validate()?;
        let seq = self.next_seq;
        let pt = serde_json::to_vec(msg).map_err(|_| NearError::Malformed("message"))?;
        let body = seal_with_nonce(&self.keys.relay, &relay_aad(&self.link_id, self.side, seq), nonce, &pt)?;
        self.next_seq += 1;
        Ok(Outgoing { seq, body })
    }

    fn open_inner(&self, seq: u64, body: &[u8]) -> Result<Message> {
        if seq == 0 { return Err(NearError::Malformed("seq")); }
        if seq <= self.peer_last_seq { return Err(NearError::Replay); }
        let aad = relay_aad(&self.link_id, self.side.other(), seq);
        let pt = open_body(&self.keys.relay, &aad, body)?;
        let msg: Message = serde_json::from_slice(&pt).map_err(|_| NearError::Malformed("message"))?;
        msg.validate()?;
        Ok(msg)
    }

    /// Open the peer's message. Accepted only after confirmation, only once, only in increasing `seq`
    /// order per sender; a message that fails authentication does not advance the counter.
    pub fn open(&mut self, seq: u64, body: &[u8]) -> Result<Message> {
        if !self.confirmed { return Err(NearError::Protocol("session not confirmed".into())); }
        let msg = self.open_inner(seq, body)?;
        if matches!(msg, Message::HelloAck { .. }) { return Err(NearError::Protocol("late hello_ack".into())); }
        self.peer_last_seq = seq;
        Ok(msg)
    }
}

// ---- transports -----------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelayItem {
    pub seq: u64,
    pub body: Vec<u8>,
}

/// What a GET returns: `{ messages: [{ seq, body_b64 }], expires_in_s }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RelayBatch {
    pub messages: Vec<RelayItem>,
    /// Seconds until the server drops the session (and the relay with it).
    pub expires_in_s: u64,
}

/// "Post a blob / fetch blobs after seq". The HTTP link relay and the own-device `near_msg` relay both
/// implement this; bodies are raw bytes (the HTTP layer base64-encodes them).
pub trait RelayTransport: Send + Sync {
    fn post(&self, from: Side, seq: u64, body: Vec<u8>) -> impl Future<Output = Result<()>> + Send;
    /// The OTHER side's messages with `seq > after`, in order.
    fn fetch(&self, as_side: Side, after: u64) -> impl Future<Output = Result<RelayBatch>> + Send;
}

#[derive(Default)]
struct MemState {
    a: Vec<RelayItem>,
    n: Vec<RelayItem>,
}

/// In-memory relay that enforces the server's limits (so a client bug shows up in tests).
#[derive(Clone, Default)]
pub struct MemoryRelay(Arc<Mutex<MemState>>);

impl MemoryRelay {
    pub fn new() -> Self { Self::default() }
    /// Everything stored, for adversarial tests: (from_a, from_n).
    pub fn snapshot(&self) -> (Vec<RelayItem>, Vec<RelayItem>) {
        let g = self.0.lock().unwrap();
        (g.a.clone(), g.n.clone())
    }
    /// Test hook: write without the server's checks (a hostile or buggy server).
    pub fn inject(&self, from: Side, item: RelayItem) {
        let mut g = self.0.lock().unwrap();
        match from { Side::A => g.a.push(item), Side::N => g.n.push(item) }
    }
}

impl RelayTransport for MemoryRelay {
    async fn post(&self, from: Side, seq: u64, body: Vec<u8>) -> Result<()> {
        let mut g = self.0.lock().unwrap();
        if seq == 0 { return Err(NearError::Transport("seq must be >= 1".into())); }
        if body.len() > MAX_BODY_BYTES { return Err(NearError::RelayLimit("message exceeds 2048 base64 characters")); }
        if g.a.len() + g.n.len() >= MAX_MESSAGES { return Err(NearError::RelayLimit("32 messages per session")); }
        let mine = match from { Side::A => &mut g.a, Side::N => &mut g.n };
        if mine.last().is_some_and(|l| l.seq >= seq) { return Err(NearError::Transport("seq not increasing".into())); }
        mine.push(RelayItem { seq, body });
        Ok(())
    }
    async fn fetch(&self, as_side: Side, after: u64) -> Result<RelayBatch> {
        let g = self.0.lock().unwrap();
        let theirs = match as_side { Side::A => &g.n, Side::N => &g.a };
        Ok(RelayBatch { messages: theirs.iter().filter(|i| i.seq > after).cloned().collect(), expires_in_s: 120 })
    }
}

/// A session bound to a transport: send, and poll for the next authentic message.
pub struct RelayPeer<T: RelayTransport> {
    transport: T,
    session: NearSession,
    fetched_through: u64,
    queue: VecDeque<Message>,
    /// Messages this side has posted (the 32-per-session cap is shared with the peer's, so this is a floor).
    posted: usize,
    pacer: Pacer,
}

/// Client-side enforcement of the relay's caps and expiry on what a GET returned.
fn check_batch(b: RelayBatch) -> Result<Vec<RelayItem>> {
    if b.expires_in_s == 0 { return Err(NearError::RelayLimit("session expired")); }
    if b.messages.len() > MAX_MESSAGES || b.messages.iter().any(|m| m.body.len() > MAX_BODY_BYTES) {
        return Err(NearError::RelayLimit("server returned more than the relay caps allow"));
    }
    Ok(b.messages)
}

/// How often the relay is polled. The server's relay GET bucket is 100 per 10 s per caller (10 per second), sized for about one poll a
/// second per device: the default polls every 400 ms while an exchange is active (a message arrived within the last 5 s) and every 1 s
/// when idle, and never faster than 250 ms whatever is configured.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PollPolicy {
    pub active: Duration,
    pub idle: Duration,
    /// Idle after this long without a message.
    pub idle_after: Duration,
}

pub const MIN_POLL: Duration = Duration::from_millis(250);

impl Default for PollPolicy {
    fn default() -> Self { Self { active: Duration::from_millis(400), idle: Duration::from_secs(1), idle_after: Duration::from_secs(5) } }
}

struct Pacer {
    policy: PollPolicy,
    last_activity: tokio::time::Instant,
}

impl Pacer {
    fn new(policy: PollPolicy) -> Self { Self { policy, last_activity: tokio::time::Instant::now() } }
    fn activity(&mut self) { self.last_activity = tokio::time::Instant::now(); }
    fn wait(&self) -> Duration {
        let d = if self.last_activity.elapsed() >= self.policy.idle_after { self.policy.idle } else { self.policy.active };
        d.max(MIN_POLL)
    }
}

/// One GET with the caps checked. A throttled answer (`NearError::Throttled`) is back-off, never failure: wait what the server asked
/// (at least the minimum poll) and report an empty batch, so the caller's own deadline still applies.
async fn fetch_batch<T: RelayTransport>(transport: &T, side: Side, after: u64, pacer: &mut Pacer) -> Result<Vec<RelayItem>> {
    match transport.fetch(side, after).await {
        Ok(b) => {
            let v = check_batch(b)?;
            if !v.is_empty() { pacer.activity(); }
            Ok(v)
        }
        Err(NearError::Throttled { retry_after_ms }) => {
            tokio::time::sleep(Duration::from_millis(retry_after_ms).clamp(MIN_POLL, Duration::from_secs(10))).await;
            Ok(vec![])
        }
        Err(e) => Err(e),
    }
}

impl<T: RelayTransport> RelayPeer<T> {
    pub fn session(&self) -> &NearSession { &self.session }
    fn fetched_count(&self) -> usize { self.fetched_through.min(MAX_MESSAGES as u64) as usize }
    pub fn into_session(self) -> NearSession { self.session }

    /// A: post hello, wait for N's `hello_ack` (verified before anything else happens). `expected_ik`: the new device's identity key as the
    /// server announced it at scan; the handshake fails with `IdentityMismatch` if N's sealed `hello_ack` names another (F4).
    pub async fn approver_connect(transport: T, link_id: &str, en_pub: &[u8; 32], secret: &ProximitySecret, expected_ik: &[u8; 32], timeout: Duration) -> Result<Self> {
        Self::approver_connect_with(transport, link_id, en_pub, secret, expected_ik, timeout, PollPolicy::default()).await
    }

    pub async fn approver_connect_with(transport: T, link_id: &str, en_pub: &[u8; 32], secret: &ProximitySecret, expected_ik: &[u8; 32], timeout: Duration, poll: PollPolicy) -> Result<Self> {
        let mut pacer = Pacer::new(poll);
        let (mut session, hello) = NearSession::approver_start(link_id, en_pub, secret.as_bytes())?;
        transport.post(Side::A, hello.seq, hello.body).await?;
        let deadline = tokio::time::Instant::now() + timeout;
        let mut fetched = 0;
        loop {
            for item in fetch_batch(&transport, Side::A, fetched, &mut pacer).await? {
                fetched = fetched.max(item.seq);
                match session.accept_hello_ack(item.seq, &item.body, expected_ik) {
                    Ok(()) => return Ok(Self { transport, session, fetched_through: fetched, queue: VecDeque::new(), posted: 1, pacer }),
                    // A forged / replayed blob is dropped, never trusted; but a WRONG confirmation or a swapped identity key is final.
                    Err(NearError::Auth(w)) if w == "hello_ack confirmation" => return Err(NearError::Auth(w)),
                    Err(NearError::IdentityMismatch) => return Err(NearError::IdentityMismatch),
                    Err(_) => continue,
                }
            }
            if tokio::time::Instant::now() >= deadline { return Err(NearError::Timeout("hello_ack")); }
            tokio::time::sleep(pacer.wait()).await;
        }
    }

    /// N: wait for A's hello, verify it against the shower's current and previous secrets (re-read on
    /// every poll, since the shower keeps rotating), then post the sealed `hello_ack`.
    /// `ik`: this device's own identity public key (the one it registered with the session), sealed into the `hello_ack` (F4).
    pub async fn new_device_accept(transport: T, link_id: &str, en_priv: &[u8; 32], ik: &[u8; 32], secrets: impl Fn() -> Vec<ProximitySecret>, timeout: Duration) -> Result<Self> {
        Self::new_device_accept_with(transport, link_id, en_priv, ik, secrets, timeout, PollPolicy::default()).await
    }

    pub async fn new_device_accept_with(transport: T, link_id: &str, en_priv: &[u8; 32], ik: &[u8; 32], secrets: impl Fn() -> Vec<ProximitySecret>, timeout: Duration, poll: PollPolicy) -> Result<Self> {
        let mut pacer = Pacer::new(poll);
        let deadline = tokio::time::Instant::now() + timeout;
        let mut fetched = 0;
        loop {
            for item in fetch_batch(&transport, Side::N, fetched, &mut pacer).await? {
                fetched = fetched.max(item.seq);
                let cands = secrets();
                let salts: Vec<&[u8]> = cands.iter().map(|s| &s.as_bytes()[..]).collect();
                match NearSession::accept_hello(link_id, en_priv, &salts, item.seq, &item.body, ik) {
                    Ok((session, ack)) => {
                        transport.post(Side::N, ack.seq, ack.body).await?;
                        return Ok(Self { transport, session, fetched_through: fetched, queue: VecDeque::new(), posted: 1, pacer });
                    }
                    Err(_) => continue, // not our hello (stale secret or junk): keep waiting, session stays open
                }
            }
            if tokio::time::Instant::now() >= deadline { return Err(NearError::Timeout("hello")); }
            tokio::time::sleep(pacer.wait()).await;
        }
    }

    pub async fn send(&mut self, msg: &Message) -> Result<()> {
        if self.posted + self.fetched_count() >= MAX_MESSAGES { return Err(NearError::RelayLimit("32 messages per session")); }
        let out = self.session.seal(msg)?;
        self.posted += 1;
        self.transport.post(self.session.side, out.seq, out.body).await
    }

    /// Next authentic message from the peer, or `Timeout`. Items that fail authentication or replay
    /// rules are dropped silently (the server is untrusted; it can only delay or discard).
    pub async fn recv(&mut self, timeout: Duration) -> Result<Message> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if let Some(m) = self.queue.pop_front() { return Ok(m); }
            let items = fetch_batch(&self.transport, self.session.side, self.fetched_through, &mut self.pacer).await?;
            for item in items {
                self.fetched_through = self.fetched_through.max(item.seq);
                if let Ok(m) = self.session.open(item.seq, &item.body) { self.queue.push_back(m); }
            }
            if !self.queue.is_empty() { continue; }
            if tokio::time::Instant::now() >= deadline { return Err(NearError::Timeout("relay message")); }
            tokio::time::sleep(self.pacer.wait()).await;
        }
    }

    /// Change the poll policy (the 250 ms floor still applies).
    pub fn set_poll(&mut self, p: PollPolicy) { self.pacer.policy = p; }
}

#[cfg(test)]
mod poll_tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    const LINK: &str = "AQEBAQEBAQEBAQEBAQEBAQ";
    const IK: [u8; 32] = [0x99; 32];

    /// Counts GETs per side and can answer `Throttled` for a while.
    #[derive(Clone)]
    struct Counting { inner: MemoryRelay, gets: Arc<[AtomicU32; 2]>, throttle_first: Arc<AtomicU32> }

    impl RelayTransport for Counting {
        async fn post(&self, from: Side, seq: u64, body: Vec<u8>) -> Result<()> { self.inner.post(from, seq, body).await }
        async fn fetch(&self, as_side: Side, after: u64) -> Result<RelayBatch> {
            self.gets[if as_side == Side::A { 0 } else { 1 }].fetch_add(1, Ordering::SeqCst);
            if self.throttle_first.load(Ordering::SeqCst) > 0 {
                self.throttle_first.fetch_sub(1, Ordering::SeqCst);
                return Err(NearError::Throttled { retry_after_ms: 1000 });
            }
            self.inner.fetch(as_side, after).await
        }
    }

    fn counting(throttle: u32) -> Counting {
        Counting { inner: MemoryRelay::new(), gets: Arc::new([AtomicU32::new(0), AtomicU32::new(0)]), throttle_first: Arc::new(AtomicU32::new(throttle)) }
    }

    /// A simulated 10 s exchange (handshake, then 10 s waiting for a message that never comes): each side stays far under the
    /// server's 100 GETs per 10 s per caller (the budget is 10 per second; headroom asked for: at most half).
    #[tokio::test(start_paused = true)]
    async fn a_ten_second_exchange_stays_under_the_servers_bucket_with_headroom() {
        let t = counting(0);
        let (en_priv, en_pub) = keys::generate_keypair();
        let s = ProximitySecret::generate();
        let sc = s.clone();
        let tn = t.clone();
        let n = tokio::spawn(async move { RelayPeer::new_device_accept(tn, LINK, &en_priv, &IK, move || vec![sc.clone()], Duration::from_secs(30)).await });
        let mut a = RelayPeer::approver_connect(t.clone(), LINK, &en_pub, &s, &IK, Duration::from_secs(30)).await.unwrap();
        let mut n = n.await.unwrap().unwrap();
        let start = tokio::time::Instant::now();
        let (ra, rn) = tokio::join!(a.recv(Duration::from_secs(10)), n.recv(Duration::from_secs(10)));
        assert!(matches!(ra, Err(NearError::Timeout(_))) && matches!(rn, Err(NearError::Timeout(_))));
        assert!(start.elapsed() >= Duration::from_secs(10));
        let (ga, gn) = (t.gets[0].load(Ordering::SeqCst), t.gets[1].load(Ordering::SeqCst));
        assert!(ga <= 50 && gn <= 50, "GETs over the exchange: A {ga}, N {gn} (bucket: 100 per 10 s)");
        assert!(ga >= 8 && gn >= 8, "and it does still poll: A {ga}, N {gn}");
    }

    #[tokio::test(start_paused = true)]
    async fn the_floor_holds_even_when_a_caller_asks_for_faster() {
        let t = counting(0);
        let (en_priv, en_pub) = keys::generate_keypair();
        let s = ProximitySecret::generate();
        let fast = PollPolicy { active: Duration::from_millis(1), idle: Duration::from_millis(1), idle_after: Duration::from_millis(1) };
        let sc = s.clone();
        let tn = t.clone();
        let n = tokio::spawn(async move { RelayPeer::new_device_accept_with(tn, LINK, &en_priv, &IK, move || vec![sc.clone()], Duration::from_secs(30), fast).await });
        let _a = RelayPeer::approver_connect_with(t.clone(), LINK, &en_pub, &s, &IK, Duration::from_secs(30), fast).await.unwrap();
        let mut n = n.await.unwrap().unwrap();
        n.set_poll(fast);
        let before = t.gets[1].load(Ordering::SeqCst);
        let _ = n.recv(Duration::from_secs(10)).await;
        let used = t.gets[1].load(Ordering::SeqCst) - before;
        assert!(used <= 41, "never faster than 250 ms: {used} GETs in 10 s");
    }

    #[tokio::test(start_paused = true)]
    async fn a_throttled_answer_is_back_off_not_failure() {
        let t = counting(3); // the first three GETs are answered 429 (retry after 1 s)
        let (en_priv, en_pub) = keys::generate_keypair();
        let s = ProximitySecret::generate();
        let sc = s.clone();
        let tn = t.clone();
        let n = tokio::spawn(async move { RelayPeer::new_device_accept(tn, LINK, &en_priv, &IK, move || vec![sc.clone()], Duration::from_secs(60)).await });
        let a = RelayPeer::approver_connect(t.clone(), LINK, &en_pub, &s, &IK, Duration::from_secs(60)).await;
        assert!(a.is_ok(), "the handshake completes through the throttling: {:?}", a.err());
        assert!(n.await.unwrap().is_ok());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINK: &str = "AQEBAQEBAQEBAQEBAQEBAQ";
    const IK: [u8; 32] = [0x99; 32];

    fn pair() -> (NearSession, NearSession, [u8; 32]) {
        let (en_priv, en_pub) = keys::generate_keypair();
        let s = ProximitySecret::generate();
        let (mut a, hello) = NearSession::approver_start(LINK, &en_pub, s.as_bytes()).unwrap();
        let (n, ack) = NearSession::accept_hello(LINK, &en_priv, &[s.as_bytes()], hello.seq, &hello.body, &IK).unwrap();
        a.accept_hello_ack(ack.seq, &ack.body, &IK).unwrap();
        (a, n, *en_priv)
    }

    #[test]
    fn handshake_and_messages_both_directions() {
        let (mut a, mut n, _) = pair();
        assert!(a.is_confirmed() && n.is_confirmed());
        let m = Message::caps(&Caps { ble_scan: true, lan_dial: true, ..Default::default() });
        let o = n.seal(&m).unwrap();
        assert_eq!(o.seq, 2, "hello_ack consumed N's seq 1");
        assert_eq!(a.open(o.seq, &o.body).unwrap(), m);
        let o = a.seal(&Message::abort("no_proximity")).unwrap();
        assert_eq!(o.seq, 2, "hello consumed A's seq 1");
        assert_eq!(n.open(o.seq, &o.body).unwrap(), Message::abort("no_proximity"));
    }

    #[test]
    fn previous_secret_is_accepted_and_wrong_one_is_not() {
        let (en_priv, en_pub) = keys::generate_keypair();
        let (cur, prev, wrong) = (ProximitySecret::generate(), ProximitySecret::generate(), ProximitySecret::generate());
        let (_, hello) = NearSession::approver_start(LINK, &en_pub, prev.as_bytes()).unwrap();
        // shower has rotated: current = cur, previous = prev
        assert!(NearSession::accept_hello(LINK, &en_priv, &[cur.as_bytes(), prev.as_bytes()], 1, &hello.body, &IK).is_ok());
        let (_, hello_old) = NearSession::approver_start(LINK, &en_pub, wrong.as_bytes()).unwrap();
        assert!(matches!(NearSession::accept_hello(LINK, &en_priv, &[cur.as_bytes(), prev.as_bytes()], 1, &hello_old.body, &IK), Err(NearError::Auth(_))));
    }

    #[test]
    fn hello_bound_to_link_and_keys() {
        let (en_priv, en_pub) = keys::generate_keypair();
        let s = ProximitySecret::generate();
        let (_, hello) = NearSession::approver_start(LINK, &en_pub, s.as_bytes()).unwrap();
        assert!(NearSession::accept_hello("AgICAgICAgICAgICAgICAg", &en_priv, &[s.as_bytes()], 1, &hello.body, &IK).is_err(), "other link id");
        let (other_priv, _) = keys::generate_keypair();
        assert!(NearSession::accept_hello(LINK, &other_priv, &[s.as_bytes()], 1, &hello.body, &IK).is_err(), "other eN");
        // tampered conf / extra field / wrong t
        let mut v: serde_json::Value = serde_json::from_slice(&hello.body).unwrap();
        v["x"] = 1.into();
        assert!(NearSession::accept_hello(LINK, &en_priv, &[s.as_bytes()], 1, &serde_json::to_vec(&v).unwrap(), &IK).is_err());
        let mut v: serde_json::Value = serde_json::from_slice(&hello.body).unwrap();
        v["t"] = "hello2".into();
        assert!(NearSession::accept_hello(LINK, &en_priv, &[s.as_bytes()], 1, &serde_json::to_vec(&v).unwrap(), &IK).is_err());
        // low-order eA: refused rather than derived
        let mut v: serde_json::Value = serde_json::from_slice(&hello.body).unwrap();
        v["ea"] = b64::enc(&[0u8; 32]).into();
        assert!(NearSession::accept_hello(LINK, &en_priv, &[s.as_bytes()], 1, &serde_json::to_vec(&v).unwrap(), &IK).is_err());
        // seq 0 is not a valid relay seq
        assert!(NearSession::accept_hello(LINK, &en_priv, &[s.as_bytes()], 0, &hello.body, &IK).is_err());
    }

    #[test]
    fn replay_and_reorder_are_refused_and_failed_auth_does_not_advance() {
        let (mut a, mut n, _) = pair();
        let m1 = n.seal(&Message::caps(&Caps::default())).unwrap();
        let m2 = n.seal(&Message::abort("x")).unwrap();
        // tampered body first: must not burn the seq
        let mut bad = m2.body.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(matches!(a.open(m2.seq, &bad), Err(NearError::Auth(_))));
        assert!(a.open(m2.seq, &m2.body).is_ok());
        // m1 is older than m2: reordered
        assert!(matches!(a.open(m1.seq, &m1.body), Err(NearError::Replay)));
        // replay of m2
        assert!(matches!(a.open(m2.seq, &m2.body), Err(NearError::Replay)));
        // gaps are fine (the server may drop), going backwards is not
        let m3 = n.seal(&Message::abort("y")).unwrap();
        let m4 = n.seal(&Message::abort("z")).unwrap();
        assert!(a.open(m4.seq, &m4.body).is_ok());
        assert!(matches!(a.open(m3.seq, &m3.body), Err(NearError::Replay)));
    }

    #[test]
    fn aad_binds_link_sender_and_seq() {
        let (mut a, mut n, _) = pair();
        let m = n.seal(&Message::abort("x")).unwrap();
        // wrong seq claimed by the server
        assert!(a.open(m.seq + 1, &m.body).is_err());
        // a reflection: A's own message fed back to A as if from N, and N's to N
        let own = a.seal(&Message::abort("x")).unwrap();
        assert!(a.open(own.seq + 5, &own.body).is_err());
        assert!(n.open(m.seq + 9, &m.body).is_err());
        assert!(n.open(m.seq, &m.body).is_err(), "N's own message is not authentic to N");
        // different link id => different AAD even under the same key
        let aad1 = relay_aad("L1", Side::N, 2);
        let aad2 = relay_aad("L2", Side::N, 2);
        let aad3 = relay_aad("L1", Side::A, 2);
        let k = [7u8; 32];
        let body = seal_with_nonce(&k, &aad1, [1; 12], b"{}").unwrap();
        assert!(open_body(&k, &aad1, &body).is_ok());
        assert!(open_body(&k, &aad2, &body).is_err());
        assert!(open_body(&k, &aad3, &body).is_err());
        assert!(open_body(&k, &relay_aad("L1", Side::N, 3), &body).is_err());
    }

    #[test]
    fn unconfirmed_session_refuses_messages() {
        let (_, en_pub) = keys::generate_keypair();
        let (mut a, _) = NearSession::approver_start(LINK, &en_pub, &[1; 16]).unwrap();
        assert!(a.open(2, &[0u8; 64]).is_err());
        assert!(a.seal(&Message::abort("x")).is_ok(), "sealing is local; the flow code gates sending");
    }

    #[test]
    fn hello_ack_with_wrong_conf_is_final_and_ack_is_not_reusable() {
        let (en_priv, en_pub) = keys::generate_keypair();
        let s = ProximitySecret::generate();
        let (mut a, hello) = NearSession::approver_start(LINK, &en_pub, s.as_bytes()).unwrap();
        let (mut n, ack) = NearSession::accept_hello(LINK, &en_priv, &[s.as_bytes()], 1, &hello.body, &IK).unwrap();
        // an impostor N' with the wrong conf, sealed under the right relay key (cannot happen without K, simulated)
        let forged = n.seal(&Message::HelloAck { conf: b64::enc(&[0u8; 32]), ik: b64::enc(&IK) }).unwrap();
        assert!(matches!(a.accept_hello_ack(forged.seq, &forged.body, &IK), Err(NearError::Auth(_))));
        assert!(!a.is_confirmed());
        a.accept_hello_ack(ack.seq, &ack.body, &IK).unwrap();
        assert!(a.accept_hello_ack(ack.seq, &ack.body, &IK).is_err());
    }

    /// F4: the new device's identity key is sealed into its `hello_ack`, covered by the confirmation, and the approver refuses a key other than
    /// the one the server announced.
    #[test]
    fn the_hello_ack_binds_the_new_devices_identity_key() {
        let (en_priv, en_pub) = keys::generate_keypair();
        let s = ProximitySecret::generate();
        let swapped = [0x77u8; 32];
        // the server swapped the key at scan: A expects `swapped`, N really holds IK
        let (mut a, hello) = NearSession::approver_start(LINK, &en_pub, s.as_bytes()).unwrap();
        let (n, ack) = NearSession::accept_hello(LINK, &en_priv, &[s.as_bytes()], 1, &hello.body, &IK).unwrap();
        assert!(matches!(a.accept_hello_ack(ack.seq, &ack.body, &swapped), Err(NearError::IdentityMismatch)));
        assert!(!a.is_confirmed(), "A stays unconfirmed: it can open nothing and sign nothing");
        assert!(a.open(2, &[0u8; 64]).is_err());
        // the right key confirms
        a.accept_hello_ack(ack.seq, &ack.body, &IK).unwrap();
        assert!(a.is_confirmed());
        // the MAC covers ik: the same conf with ANOTHER ik in the message fails the confirmation (not the mismatch check)
        let (mut a2, hello2) = NearSession::approver_start(LINK, &en_pub, s.as_bytes()).unwrap();
        let (mut n2, _ack2) = NearSession::accept_hello(LINK, &en_priv, &[s.as_bytes()], 1, &hello2.body, &IK).unwrap();
        let conf_real = b64::enc(&conf_mac_n(&n2.keys, LINK, &n2.en_pub, &n2.ea_pub, &IK));
        let forged = n2.seal(&Message::HelloAck { conf: conf_real, ik: b64::enc(&swapped) }).unwrap();
        assert!(matches!(a2.accept_hello_ack(forged.seq, &forged.body, &swapped), Err(NearError::Auth("hello_ack confirmation"))), "ik is under the MAC");
        // the pre-F4 confirmation (without ik) no longer verifies
        let pre_f4 = conf_mac(&n.keys, Side::N, LINK, &n.en_pub, &n.ea_pub);
        let (mut a3, h3) = NearSession::approver_start(LINK, &en_pub, s.as_bytes()).unwrap();
        let (mut n3, _) = NearSession::accept_hello(LINK, &en_priv, &[s.as_bytes()], 1, &h3.body, &IK).unwrap();
        let old = n3.seal(&Message::HelloAck { conf: b64::enc(&pre_f4), ik: b64::enc(&IK) }).unwrap();
        assert!(matches!(a3.accept_hello_ack(old.seq, &old.body, &IK), Err(NearError::Auth(_))));
        // a hello_ack without ik, or with a malformed one, is not a message at all
        assert!(serde_json::from_str::<Message>(r#"{"t":"hello_ack","conf":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}"#).is_err());
        assert!(Message::HelloAck { conf: b64::enc(&[0u8; 32]), ik: "short".into() }.validate().is_err());
    }

    #[tokio::test]
    async fn the_handshake_fails_final_and_fast_on_a_swapped_identity_key() {
        let t = MemoryRelay::new();
        let (en, en_pub) = keys::generate_keypair();
        let s = ProximitySecret::generate();
        let sc = s.clone();
        let tn = t.clone();
        let n = tokio::spawn(async move { RelayPeer::new_device_accept(tn, LINK, &en, &IK, move || vec![sc.clone()], Duration::from_secs(5)).await });
        let start = std::time::Instant::now();
        let r = RelayPeer::approver_connect(t.clone(), LINK, &en_pub, &s, &[0x55; 32], Duration::from_secs(30)).await;
        assert!(matches!(r, Err(NearError::IdentityMismatch)), "{:?}", r.err());
        assert!(start.elapsed() < Duration::from_secs(5), "final: it does not wait out the 30 s timeout");
        let _ = n.await;
    }

    #[test]
    fn message_validation() {
        assert!(Message::lan_offer(&LanOffer { addrs: vec!["192.168.1.5".parse().unwrap(), "fe80::1".parse().unwrap()], port: 4000, fp: [1; 32] }).validate().is_ok());
        let bad = |m: Message| assert!(m.validate().is_err(), "{m:?}");
        bad(Message::LanOffer { addrs: vec![], port: 1, fp: b64::enc(&[1; 32]) });
        bad(Message::LanOffer { addrs: vec!["192.168.1.5".into()], port: 0, fp: b64::enc(&[1; 32]) });
        bad(Message::LanOffer { addrs: vec!["fe80::1%eth0".into()], port: 1, fp: b64::enc(&[1; 32]) });
        bad(Message::LanOffer { addrs: vec!["example.com".into()], port: 1, fp: b64::enc(&[1; 32]) });
        bad(Message::LanOffer { addrs: vec!["10.0.0.1".into(); 9], port: 1, fp: b64::enc(&[1; 32]) });
        bad(Message::LanOffer { addrs: vec!["10.0.0.1".into()], port: 1, fp: b64::enc(&[1; 31]) });
        bad(Message::BleHeard { mac: "short".into() });
        bad(Message::BleStart { advertiser: "x".into() });
        bad(Message::abort("has space"));
        bad(Message::abort(&"x".repeat(65)));
        // unknown field / unknown t are parse errors
        assert!(serde_json::from_str::<Message>(r#"{"t":"abort","reason":"x","extra":1}"#).is_err());
        assert!(serde_json::from_str::<Message>(r#"{"t":"nope"}"#).is_err());
        assert!(serde_json::from_str::<Message>(r#"{"reason":"x"}"#).is_err());
        let c = Message::caps(&Caps { ble_adv: true, lan_listen: true, ..Default::default() });
        assert_eq!(c.caps_typed().unwrap(), Caps { os: Os::Other, kind: DeviceKind::Desktop, ble_adv: true, ble_scan: false, lan_listen: true, lan_dial: false });
        // `kind` is required: missing or unknown is a protocol error, never a guess
        let no_kind = Message::Caps { caps: vec!["lan_dial".into()], kind: None, label: None, platform: None, os: None };
        assert!(no_kind.caps_typed().is_none() && matches!(no_kind.caps_checked(), Err(NearError::Protocol(_))));
        let odd = Message::Caps { caps: vec![], kind: Some("tablet".into()), label: None, platform: None, os: None };
        assert!(odd.caps_typed().is_none() && odd.caps_checked().is_err());
        let phone = Message::caps(&Caps { kind: DeviceKind::Phone, ..Default::default() });
        assert_eq!(phone.caps_checked().unwrap().kind, DeviceKind::Phone);
        assert!(serde_json::to_string(&phone).unwrap().contains(r#""kind":"phone""#));
        // 11.2: label and platform ride in the sealed caps, sanitised and bounded
        let full = Message::caps_full(&Caps::default(), &Who { label: format!("Da\u{202e}wson\u{0}'s {}", "x".repeat(80)), platform: "android".into() });
        let who = full.who().unwrap();
        assert!(who.label.chars().count() <= 64 && !who.label.contains('\u{202e}') && !who.label.contains('\0'), "{who:?}");
        assert_eq!(who.platform, "android");
        assert!(Message::Caps { caps: vec![], kind: Some("phone".into()), label: Some("x".repeat(65)), platform: None, os: None }.validate().is_err());
        // 11.3: closed abort reasons with per-proof causes; unknown causes are refused, unknown reasons read as `error`
        let ab = Message::abort_no_proximity("off", "not_found");
        assert!(ab.validate().is_ok());
        assert_eq!(ab.abort_reason(), Some(("no_proximity", Some("off"), Some("not_found"))));
        assert!(Message::Abort { reason: "no_proximity".into(), ble: Some("loud".into()), lan: None }.validate().is_err());
        assert_eq!(Message::abort("brand_new").abort_reason().unwrap().0, "error");
        assert!(Message::status("proof_ok", Some("ble")).validate().is_ok() && Message::status("nope", None).validate().is_err() && Message::status("proof_ok", Some("x")).validate().is_err());
        // 11.4 / 11.5
        assert!(Message::ble_result(false, Some("not_found")).validate().is_ok());
        assert!(matches!(Message::lan_probe_result(false, Some("firewall")), Message::LanResult { purpose: Some(ref p), .. } if p == "transfer_probe"));
    }

    #[tokio::test]
    async fn end_to_end_over_memory_relay_with_rotation() {
        let relay = MemoryRelay::new();
        let (en_priv, en_pub) = keys::generate_keypair();
        let s_prev = ProximitySecret::generate();
        let s_cur = ProximitySecret::generate();
        let secrets = { let (p, c) = (s_prev.clone(), s_cur.clone()); move || vec![c.clone(), p.clone()] };
        let t_a = relay.clone();
        let en = *en_priv;
        let n_task = tokio::spawn(async move {
            RelayPeer::new_device_accept(t_a, LINK, &en, &IK, secrets, Duration::from_secs(5)).await
        });
        // A scanned the PREVIOUS code
        let mut a = RelayPeer::approver_connect(relay.clone(), LINK, &en_pub, &s_prev, &IK, Duration::from_secs(5)).await.unwrap();
        let mut n = n_task.await.unwrap().unwrap();
        a.send(&Message::ble_start(Side::N)).await.unwrap();
        assert_eq!(n.recv(Duration::from_secs(2)).await.unwrap(), Message::ble_start(Side::N));
        n.send(&Message::ble_heard(&[3; 32])).await.unwrap();
        assert_eq!(a.recv(Duration::from_secs(2)).await.unwrap(), Message::ble_heard(&[3; 32]));
        assert!(matches!(a.recv(Duration::from_millis(150)).await, Err(NearError::Timeout(_))));
    }

    #[tokio::test]
    async fn relay_caps_are_enforced_client_side() {
        // oversized message: refused before it is ever posted
        let (mut a, mut n, _) = pair();
        let big = Message::abort(&"x".repeat(64));
        assert!(a.seal(&big).is_ok());
        let _ = &mut n;
        let too_big = seal_with_nonce(&[1; 32], b"aad", [0; 12], &vec![0u8; MAX_BODY_BYTES]);
        assert!(matches!(too_big, Err(NearError::RelayLimit(_))));
        // expired session and over-long batch from the server
        assert!(matches!(check_batch(RelayBatch { messages: vec![], expires_in_s: 0 }), Err(NearError::RelayLimit("session expired"))));
        let many = (1..=33).map(|i| RelayItem { seq: i, body: vec![0; 40] }).collect();
        assert!(matches!(check_batch(RelayBatch { messages: many, expires_in_s: 5 }), Err(NearError::RelayLimit(_))));
        // the 32-message cap surfaces a clear error from the peer wrapper
        let relay = MemoryRelay::new();
        let (en_priv, en_pub) = keys::generate_keypair();
        let s = ProximitySecret::generate();
        let (t, sc, en) = (relay.clone(), s.clone(), *en_priv);
        let n_task = tokio::spawn(async move { RelayPeer::new_device_accept(t, LINK, &en, &IK, move || vec![sc.clone()], Duration::from_secs(5)).await });
        let mut a = RelayPeer::approver_connect(relay.clone(), LINK, &en_pub, &s, &IK, Duration::from_secs(5)).await.unwrap();
        let _n = n_task.await.unwrap().unwrap();
        let mut last = Ok(());
        for _ in 0..40 { last = a.send(&Message::abort("x")).await; if last.is_err() { break } }
        assert!(matches!(last, Err(NearError::RelayLimit(_))), "{last:?}");
    }

    #[tokio::test]
    async fn hostile_server_junk_and_replays_are_dropped() {
        let relay = MemoryRelay::new();
        let (en_priv, en_pub) = keys::generate_keypair();
        let s = ProximitySecret::generate();
        let sc = s.clone();
        let t = relay.clone();
        let en = *en_priv;
        let n_task = tokio::spawn(async move { RelayPeer::new_device_accept(t, LINK, &en, &IK, move || vec![sc.clone()], Duration::from_secs(5)).await });
        // junk the server fabricates "from a" before the real hello
        relay.inject(Side::A, RelayItem { seq: 1, body: b"junk".to_vec() });
        let a_relay = relay.clone();
        let mut a = RelayPeer::approver_connect(a_relay, LINK, &en_pub, &s, &IK, Duration::from_secs(5)).await;
        // the junk occupied seq 1, so the real hello (seq 1) was refused by the memory relay: the client surfaces a transport error
        assert!(a.is_err());
        n_task.abort();
        // a clean run, then the server replays N's ack and old messages
        let relay = MemoryRelay::new();
        let t = relay.clone();
        let sc = s.clone();
        let n_task = tokio::spawn(async move { RelayPeer::new_device_accept(t, LINK, &en, &IK, move || vec![sc.clone()], Duration::from_secs(5)).await });
        a = RelayPeer::approver_connect(relay.clone(), LINK, &en_pub, &s, &IK, Duration::from_secs(5)).await;
        let mut a = a.unwrap();
        let mut n = n_task.await.unwrap().unwrap();
        n.send(&Message::abort("one")).await.unwrap();
        assert_eq!(a.recv(Duration::from_secs(1)).await.unwrap(), Message::abort("one"));
        let (_, from_n) = relay.snapshot();
        for it in from_n { relay.inject(Side::N, RelayItem { seq: it.seq + 10, body: it.body }); } // replays under new seq
        assert!(matches!(a.recv(Duration::from_millis(200)).await, Err(NearError::Timeout(_))));
    }
}
