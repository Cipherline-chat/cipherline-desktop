//! The proximity session engine: drives [`Machine`] from real events for every desktop role.
//!
//! * NEW DEVICE shows the rotating code (QR payload; typed `XXXX-XXXX` in typed mode), re-opening the
//!   link session before its 120 s end while the previous one stays alive (contract 11.1), rotating the
//!   on-screen secret every 30 s, and waits for the approver's `hello`.
//! * APPROVER either scans / types a code (`approver_start`), or shows an invite a phone scans
//!   (`invite_start`).
//! * Both then run `caps` -> proximity (Bluetooth via [`BleRadio`] first, then the local network, 4.1 / 4.2)
//!   -> the approver's gate + v2 approve + grant, and the optional history transfer over the 4.2 channel.
//!
//! THE GUARANTEE. Nothing that approves or transfers can run without a verified proof, and that is the
//! type system's doing, not a flag: [`link_approve_message_v2`] and `run_sender`/`run_receiver` take a
//! `&ProximityProof`, which only cl-near can mint (from a verified Bluetooth exchange or an authenticated
//! TLS connection). This module keeps the proof inside [`Verified`], whose only constructor is private to
//! the proximity stage, and the approver's command loop only exists once a `Verified` does. The server's
//! `approve` endpoint is therefore never called after `hello` alone (test: `no_approve_without_proof`).
//!
//! Platform seams (all traits, so the whole engine runs on Linux against fakes): [`BleRadio`],
//! [`ApprovalGate`], cl-near's `InterfaceProvider`, [`Identity`].
use super::api::{ApiError, Auth, HttpRelay, LinkApi, RelayToken};
use super::gate::{run_gate, ApprovalGate, Availability, Verification};
use super::parts::{assemble, FilePartsSource, PART_BYTES};
use super::radio::{probe_adapter, scan_for_proof, AdapterState, BleRadio, ScanCaps, ScanOutcome};
use super::state::*;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64URL};
use base64::Engine as _;
use cl_near::approval::{link_approve_message_v2, Proximity};
use cl_near::ble::{plan, FallReason};
use cl_near::code::{build_invite, build_invite_compact, build_near, build_near_compact, NearPayload, ProximitySecret, SecretRotor, TypedCode};
use cl_near::conn::{Conn, ConnConfig};
use cl_near::error::NearError;
use cl_near::keys::{self, SessionKeys};
use cl_near::lan::{dial, LanConn, LanListener, LanPolicy, LanTimeouts};
use cl_near::onlink::InterfaceProvider;
use cl_near::proof::ProximityProof;
use cl_near::relay::{Caps, DeviceKind, LanOffer, Message, RelayPeer, Side, Who};
use cl_near::transfer::{run_receiver, run_sender, CancelToken, FileRecordSink, FileStore, Progress, ReceiverStore, TransferOpts};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, watch};
use zeroize::Zeroizing;

/// What the host supplies about THIS device's account (vault-backed in the app, a key pair in tests).
pub trait Identity: Send + Sync + 'static {
    /// This device's Ed25519 identity public key, standard base64 (the new device registers it at session create).
    fn identity_pub_b64(&self) -> Option<String>;
    /// Sign a link-approval string with the identity key (standard base64 signature).
    fn sign(&self, message: &str) -> Option<String>;
    /// The new device hands its ephemeral link key to the bridge so `linkOpen(envelope, linkId)` can open the grant.
    fn install_link_session(&self, link_id: &str, ek_priv: &[u8; 32], ek_pub_b64: &str);
}

pub use cl_near::relay::Os;

pub struct Timing {
    /// Waiting for the other side's `hello_ack` (approver) before saying the code is no good.
    pub hello: Duration,
    /// The peer's next `caps` / `ble_start` / `lan_offer`.
    pub peer_step: Duration,
    /// Local-network proof when it is the only proof (listener accept / dialer wait).
    pub lan: Duration,
    /// Local-network probe after a Bluetooth proof (contract 11.5 cap).
    pub lan_probe: Duration,
    /// Server v14: a scan that lost the (provisional) pin to another scanner (404 / 409 `link_already_scanning`) is retried once after this.
    pub scan_retry: Duration,
    /// How often the new device (and an approver on the sheet) asks the server about the session.
    pub poll: Duration,
    /// Give up on a transfer that keeps failing to reconnect.
    pub transfer_giveup: Duration,
    /// Re-open the link session when this much of its life is left.
    pub reopen_margin: Duration,
    /// How long the new device keeps showing codes before it gives up.
    pub show_limit: Duration,
    /// A deliberate pause (either side's) is given up after this long (the phone core's `NearTuning::pause_cap`, 15 min): the side
    /// that paused stops waiting for its own resume, the side paused by its peer stops reconnecting. Reported as `timeout`.
    pub pause_cap: Duration,
}
impl Default for Timing {
    fn default() -> Self {
        Self { hello: Duration::from_secs(20), peer_step: Duration::from_secs(12), lan: Duration::from_secs(15), lan_probe: Duration::from_secs(9), scan_retry: Duration::from_secs(10), poll: Duration::from_secs(1), transfer_giveup: Duration::from_secs(300), reopen_margin: Duration::from_secs(10), show_limit: Duration::from_secs(600), pause_cap: Duration::from_secs(15 * 60) }
    }
}

pub struct NearEnv {
    pub radio: Arc<dyn BleRadio>,
    pub gate: Arc<dyn ApprovalGate>,
    pub ifaces: Arc<dyn InterfaceProvider>,
    pub identity: Arc<dyn Identity>,
    /// `<profile>`: transfer parts and progress live under `near-recv/`.
    pub profile: PathBuf,
    /// Where the received container is placed (the renderer reads it with `backupStat` / `backupReadRange`).
    pub staging_dir: PathBuf,
    pub version: String,
    pub attest_secret: Option<String>,
    pub device_label: String,
    /// `windows` | `mac` | `linux` ... as the server's `platform` field.
    pub platform: &'static str,
    pub os: Os,
    pub lan_policy: LanPolicy,
    pub scan_caps: ScanCaps,
    pub lan_timeouts: LanTimeouts,
    pub timing: Timing,
    /// Pause seam (contract 11.9): see `pause.rs`.
    pub stop: Arc<dyn super::pause::TransferStop>,
    /// Own-device transfer (contract 7): how a `near_*` control message leaves this device (the page puts it through the E2EE
    /// self-fan-out to the named device).
    pub own_send: Arc<dyn super::own::OwnSend>,
    /// How long the requester waits for the other device's person to answer.
    pub own_answer: Duration,
    /// Publishes every snapshot (`cl:near-state` in the app).
    pub emit: Arc<dyn Fn(&NearSnapshot) + Send + Sync>,
    /// Maps a renderer-supplied path to a readable file (confinement lives in the host).
    pub resolve_path: Arc<dyn Fn(&str) -> Result<PathBuf, String> + Send + Sync>,
    /// Test clock: milliseconds added to every `Instant::now()` the engine reads for rotation.
    pub skew_ms: Arc<AtomicU64>,
    /// TEST SEAM (compiled out of every non-test, non-`near-testkit` build, like cl-near's loopback policy): let the history move after a
    /// local-network-only proof. Two desktops can never have a Bluetooth proof (desktops only scan), so the pause / resume / keep tests of
    /// the transfer machinery run with this on; every policy test turns it off.
    #[cfg(any(test, feature = "near-testkit"))]
    pub test_history_over_lan: bool,
}

impl NearEnv {
    fn lan_history_override(&self) -> bool {
        #[cfg(any(test, feature = "near-testkit"))]
        {
            self.test_history_over_lan
        }
        #[cfg(not(any(test, feature = "near-testkit")))]
        {
            false
        }
    }
    fn now(&self) -> Instant {
        Instant::now() + Duration::from_millis(self.skew_ms.load(Ordering::SeqCst))
    }
}

#[derive(Clone, Debug)]
pub struct NearAuth {
    pub access_token: String,
    pub user_id: String,
    pub device_id: String,
}

pub enum ScanInput {
    Qr(String),
    Typed(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    Hello,
    NativeConfirm,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApproveOutcome {
    Approved(&'static str),
    Cancelled(&'static str),
    Failed(&'static str, String),
}

#[derive(Clone, Debug)]
pub struct Received {
    pub path: PathBuf,
    pub size: u64,
}

enum Cmd {
    Approve(oneshot::Sender<ApproveOutcome>),
    Refuse(oneshot::Sender<()>),
    Send(String, oneshot::Sender<Result<(), String>>),
    Receive(oneshot::Sender<Result<(), String>>),
}

// ---- stopping --------------------------------------------------------------------------------

#[derive(Debug)]
enum Stop {
    /// This side stopped.
    Cancelled,
    /// The OTHER device sent `abort { cancelled }`.
    PeerCancelled,
    /// This side's user refused ("Don't approve"): the `denied` abort and the server deny were already sent.
    Declined,
    Expired(String),
    Refused(NearRefusal, String),
    Failed(String, String),
}

impl From<NearError> for Stop {
    fn from(e: NearError) -> Self {
        match e {
            NearError::Cancelled => Stop::Cancelled,
            NearError::RelayLimit(m) if m.contains("expired") => Stop::Expired("session_expired".into()),
            NearError::Timeout("hello_ack") | NearError::Timeout("hello") => Stop::Failed("hello_timeout".into(), "the other device did not answer the code".into()),
            NearError::Auth(w) if w.contains("hello_ack") => Stop::Failed("hello_rejected".into(), "the other device's confirmation did not verify".into()),
            // F4: the sealed identity key is not the one the server gave us at scan. Final; nothing is shown or signed.
            NearError::IdentityMismatch => Stop::Failed("identity_mismatch".into(), "this sign-in does not match the device that is showing it".into()),
            NearError::PeerAbort(r) => abort_stop(&r, None, None, None),
            e => Stop::Failed("near_error".into(), e.to_string()),
        }
    }
}
impl From<ApiError> for Stop {
    fn from(e: ApiError) -> Self {
        if e.code == "link_session_expired" || (e.status == 404 && e.code.starts_with("http_")) {
            return Stop::Expired(e.code);
        }
        Stop::Failed(e.code.clone(), e.to_string())
    }
}

/// What this device knows about its access to the local network: the phone core's `LocalNetwork` (its `near_set_local_network`). A refused
/// permission, a firewall and "nothing there" look alike on a socket, so the refusal's `lan` cause is `denied` / `firewall` only when this is
/// set; otherwise it is `not_found`. The host sets it from what the OS actually says (below) or the shell calls `set_local_network`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LocalNetwork {
    #[default]
    Unknown,
    Granted,
    Denied,
    Firewall,
}
impl LocalNetwork {
    pub fn parse(s: &str) -> Self {
        match s {
            "granted" => Self::Granted,
            "denied" => Self::Denied,
            "firewall" => Self::Firewall,
            _ => Self::Unknown,
        }
    }
    /// The `lan` cause for a local-network leg that did not connect.
    pub fn lan_cause(self) -> &'static str {
        match self {
            Self::Denied => "denied",
            Self::Firewall => "firewall",
            _ => "not_found",
        }
    }
}

/// What a blocked socket looks like. Windows reports a bind/connect that policy forbids (Defender Firewall, a corporate rule) as
/// WSAEACCES (10013), which std maps to `PermissionDenied`; other OSes use the same kind for their local-network privacy gates. A silent
/// firewall (packets dropped) is a timeout and is NOT distinguishable from "nobody there" without querying the firewall policy.
fn io_blocked(e: &NearError) -> bool {
    matches!(e, NearError::Io(io) if io.kind() == std::io::ErrorKind::PermissionDenied)
}

/// The closed cause sets (contract 11.3), as `'static` names for the snapshot.
fn ble_cause_static(c: &str) -> Option<&'static str> {
    cl_near::relay::BLE_CAUSES.iter().find(|x| **x == c).copied()
}
fn lan_cause_static(c: &str) -> Option<&'static str> {
    cl_near::relay::LAN_CAUSES.iter().find(|x| **x == c).copied()
}

/// What an `abort` from the peer means here (contract 11.3). `own` is this side's view of the proofs, used only when the
/// abort carries no causes of its own. Reasons outside the closed set already read as `error` in cl-near.
fn abort_stop(reason: &str, ble: Option<&str>, lan: Option<&str>, own: Option<NearRefusal>) -> Stop {
    match reason {
        "no_proximity" => {
            let base = own.unwrap_or(NearRefusal { ble: "skipped", lan: "skipped" });
            Stop::Refused(NearRefusal { ble: ble.and_then(ble_cause_static).unwrap_or(base.ble), lan: lan.and_then(lan_cause_static).unwrap_or(base.lan) }, "no_proximity".into())
        }
        "denied" => Stop::Refused(NearRefusal { ble: "skipped", lan: "skipped" }, "denied".into()),
        "cancelled" => Stop::PeerCancelled,
        "expired" => Stop::Expired("expired".into()),
        "burned" => Stop::Failed("burned".into(), "too many wrong approvals: that code was cancelled".into()),
        _ => Stop::Failed("peer_error".into(), "the other device stopped".into()),
    }
}

/// The abort this side tells the peer when IT is the one stopping (best effort; the session may already be gone). A stop
/// that the peer caused (`PeerCancelled`, a refusal it sent) is never echoed back; refusals this side decides are sent
/// explicitly where they are decided (with their causes).
fn abort_for(stop: &Stop) -> Option<Message> {
    match stop {
        Stop::Cancelled => Some(Message::abort("cancelled")),
        Stop::Expired(c) if c == "session_expired" => Some(Message::abort("expired")),
        Stop::Failed(c, _) if c == "burned" || c.starts_with("peer_") || c.starts_with("hello_") || c == "bad_code" || c == "identity_mismatch" || c == "taken_over" => None,
        Stop::Failed(..) => Some(Message::abort("error")),
        _ => None,
    }
}

// ---- pure helpers (one place for each rule) ----------------------------------------------------

/// THE one place that decides "is this peer a phone". Today cl-near infers it from the Bluetooth-advertise
/// capability (phones advertise, desktops only scan); the shared crate is gaining an explicit `Caps.kind`
/// (contract section 10), at which point only this function changes.
pub fn peer_is_phone(c: &Caps) -> bool {
    c.is_phone()
}

/// Who listens for the local-network channel (4.2 + 11.6): decided by the shared crate from both sides' `caps`
/// (`kind`, `os`, listen/dial). `None` = no local path.
pub fn lan_listener(a: &Caps, n: &Caps) -> Option<Side> {
    plan(a, n, false).lan.map(|l| l.listener)
}

/// Contract 11.1: the typed code is accepted with `-`, `·`, spaces and any case, then normalised to the
/// canonical `XXXX-XXXX` before the hash. (Crockford look-alikes are mapped by `TypedCode::parse`.)
pub fn normalize_typed(s: &str) -> Option<String> {
    let c: Vec<char> = s.chars().filter(|c| c.is_alphanumeric()).map(|c| c.to_ascii_uppercase()).collect();
    (c.len() == 8 && c.iter().all(char::is_ascii_alphanumeric)).then(|| format!("{}-{}", c[..4].iter().collect::<String>(), c[4..].iter().collect::<String>()))
}

fn clean_label(s: &str) -> String {
    s.chars().filter(|c| !c.is_control() && !matches!(*c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')).collect::<String>().trim().chars().take(64).collect()
}

fn ble_cause(s: &AdapterState) -> &'static str {
    match s {
        AdapterState::Ready => "not_found",
        AdapterState::NoAdapter | AdapterState::Error(_) => "no_adapter",
        AdapterState::RadioOff => "off",
        AdapterState::Denied => "denied",
    }
}

/// What an approver's sheet shows, and therefore the only thing its approval may sign for (security review L3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovalShown {
    pub link_id: String,
    pub identity_key_b64: String,
    pub proximity: Proximity,
}

/// Is `msg` EXACTLY the v2 approval `cipherline-link-approve:v2:<user>:<device>:<link>:<newIdentityKey>:<ble|lan>:<ts>` for this account and
/// device and for what `shown` says (link, new identity key, proximity)? The same rule Electron main applies to the helper's signing request
/// (`electron/near-bridge.ts`): there it guards a process boundary, here the in-process engine and the Windows host.
pub fn approval_message_matches(msg: &str, user_id: &str, device_id: &str, shown: &ApprovalShown) -> bool {
    let p: Vec<&str> = msg.split(':').collect();
    p.len() == 8
        && p[0] == "cipherline-link-approve"
        && p[1] == "v2"
        && p[2] == user_id
        && p[3] == device_id
        && p[4] == shown.link_id
        && p[5] == shown.identity_key_b64
        && p[6] == shown.proximity.as_str()
        && p[7].len() >= 10
        && p[7].len() <= 16
        && p[7].bytes().all(|b| b.is_ascii_digit())
}

/// After a successful scan, a relay call that answers 403 `link_wrong_account` or 404 means another device took over the scan pin (v14).
fn takeover_or(e: NearError) -> Stop {
    let t = e.to_string();
    if t.contains("link_wrong_account") || t.contains("(404)") {
        Stop::Failed("taken_over".into(), "another device took over this sign-in".into())
    } else {
        Stop::from(e)
    }
}

#[cfg(test)]
pub(crate) fn takeover_or_for_test(e: NearError) -> (String, String) {
    match takeover_or(e) {
        Stop::Failed(c, m) => (c, m),
        other => (format!("{other:?}"), String::new()),
    }
}

fn clone_keys(k: &SessionKeys) -> SessionKeys {
    SessionKeys { conf: k.conf.clone(), relay: k.relay.clone(), ble: k.ble.clone(), lan: k.lan.clone(), xfer: k.xfer.clone() }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn decode_pub(b64: &str) -> Option<[u8; 32]> {
    let t = b64.trim_end_matches('=').replace('+', "-").replace('/', "_");
    B64URL.decode(t).ok()?.try_into().ok()
}

// ---- the message pipe: the link relay (sign-in) or the own-device channel (Settings transfer) ---------------------------

/// What the proximity stage needs from the channel carrying the sealed messages: the section 2 keys, the link id, and a
/// send / receive of typed messages. The link relay (`RelayPeer<HttpRelay>`) and the own-device channel
/// ([`super::own::OwnPipe`], `near_msg` control messages through the E2EE self-fan-out) both implement it, so section 4 and
/// section 6 run unchanged on either (contract 7).
pub trait Pipe: Send {
    fn keys(&self) -> &SessionKeys;
    fn link_id(&self) -> &str;
    fn send(&mut self, m: &Message) -> impl std::future::Future<Output = Result<(), NearError>> + Send;
    fn recv(&mut self, timeout: Duration) -> impl std::future::Future<Output = Result<Message, NearError>> + Send;
}

impl Pipe for RelayPeer<HttpRelay> {
    fn keys(&self) -> &SessionKeys {
        self.session().keys()
    }
    fn link_id(&self) -> &str {
        self.session().link_id()
    }
    async fn send(&mut self, m: &Message) -> Result<(), NearError> {
        RelayPeer::send(self, m).await
    }
    async fn recv(&mut self, timeout: Duration) -> Result<Message, NearError> {
        RelayPeer::recv(self, timeout).await
    }
}

// ---- shared machinery ----------------------------------------------------------------------------

struct Shared {
    m: Mutex<Machine>,
    sess: Mutex<Option<Sess>>,
    result: Mutex<Option<Received>>,
    /// The user asked to pause (or the transfer is paused): checked at the start of every attempt.
    paused: AtomicBool,
    /// The running attempt's token (single-use: a pause ends it; resume starts a new one).
    tok: Mutex<Option<CancelToken>>,
    resume: tokio::sync::Notify,
    /// Receiver: where the parts of the current / last transfer live, so a stopped one can be kept or discarded.
    recv_dir: Mutex<Option<PathBuf>>,
    /// `K_xfer` (contract 11.15): the key the page seals / opens the transfer container under. Held in memory only, for the
    /// life of the transfer, zeroed (`Zeroizing`) when dropped; never logged, never serialised, never written to disk.
    /// Set when the proximity stage knows it, released to the page only once this device is approved.
    xfer_key: Mutex<Option<Zeroizing<[u8; 32]>>>,
    xfer_released: AtomicBool,
    local_net: Mutex<LocalNetwork>,
    /// The running own-device session's inbound routes (contract 7).
    own: Mutex<Option<super::own::OwnRoute>>,
    /// L3: the approval this device's sheet is showing (set when the proof is verified, cleared when the session ends).
    shown: Mutex<Option<ApprovalShown>>,
    /// L3 (security round): per-peer cooldown for unsolicited own-device offers.
    cooldown: Mutex<super::own::OfferCooldown>,
    /// An own-device session that is still waiting on a person's decision (see [`Undecided`]): the only kind of session a newly
    /// arrived offer may replace.
    undecided: Mutex<Option<Undecided>>,
    /// The nonces of the last offers handed over: the same offer delivered twice opens one sheet and is never answered twice.
    seen_offers: Mutex<VecDeque<[u8; 16]>>,
}
/// What an own-device session is waiting on before anything was agreed ("the PC said no" fix, 2026-11-25).
#[derive(Clone, Debug, PartialEq, Eq)]
enum Undecided {
    /// This device's sheet for an offer from that device is up and the person has not pressed anything yet.
    Sheet(String),
    /// This device asked another one and has no answer yet.
    Asking,
}
/// How many recent offer nonces are remembered for de-duplication.
const SEEN_OFFERS: usize = 32;
struct Sess {
    cancel: CancelToken,
    cmd: mpsc::UnboundedSender<Cmd>,
}

#[derive(Clone)]
struct Ctx {
    env: Arc<NearEnv>,
    sh: Arc<Shared>,
    cancel: CancelToken,
}

impl Ctx {
    fn go(&self, to: NearState, edit: impl FnOnce(&mut NearSnapshot)) {
        if to.is_terminal() {
            super::parts::persist_pause(&self.env.profile, None);
        }
        let mut m = self.sh.m.lock().unwrap();
        match m.go(to, edit) {
            Ok(s) => (self.env.emit)(&s),
            Err(e) => crate::nlog!("near: {e}"),
        }
    }
    fn state(&self) -> NearState {
        self.sh.m.lock().unwrap().snapshot().state
    }
    /// The `lan` cause for a leg that failed, from what the OS told us (see [`LocalNetwork`]).
    fn lan_fail_cause(&self) -> &'static str {
        self.sh.local_net.lock().unwrap().lan_cause()
    }
    /// A bind / dial the OS refused: remember it (`firewall` on Windows, `denied` elsewhere).
    fn note_lan_blocked(&self) {
        *self.sh.local_net.lock().unwrap() = if self.env.os == Os::Windows { LocalNetwork::Firewall } else { LocalNetwork::Denied };
    }
    fn snap(&self) -> NearSnapshot {
        self.sh.m.lock().unwrap().snapshot().clone()
    }
    fn finish(&self, stop: Stop) {
        *self.sh.shown.lock().unwrap() = None;
        *self.sh.undecided.lock().unwrap() = None;
        match stop {
            Stop::Cancelled | Stop::Declined => self.go(NearState::Cancelled, |_| {}),
            Stop::PeerCancelled => self.go(NearState::Cancelled, |s| s.error = Some(NearError_ { code: "peer_cancelled".into(), message: "the other device cancelled".into() }.into())),
            Stop::Expired(c) => self.go(NearState::Expired, |s| s.error = Some(NearError_ { code: c, message: "the session ended".into() }.into())),
            Stop::Refused(r, c) => self.go(NearState::Refused, |s| {
                s.refusal = Some(r);
                s.error = Some(NearError_ { code: c, message: "refused".into() }.into());
            }),
            Stop::Failed(c, m) => self.go(NearState::Failed, |s| s.error = Some(NearError_ { code: c, message: m }.into())),
        }
    }
    async fn cx<T>(&self, f: impl std::future::Future<Output = T>) -> Result<T, Stop> {
        tokio::select! {
            _ = self.cancel.cancelled() => Err(Stop::Cancelled),
            v = f => Ok(v),
        }
    }
    async fn blocking<T: Send + 'static>(&self, f: impl FnOnce() -> T + Send + 'static) -> Result<T, Stop> {
        let h = tokio::task::spawn_blocking(f);
        self.cx(h).await?.map_err(|e| Stop::Failed("internal".into(), e.to_string()))
    }
    async fn call<T: Send + 'static>(&self, f: impl FnOnce() -> Result<T, ApiError> + Send + 'static) -> Result<T, Stop> {
        self.blocking(f).await?.map_err(Stop::from)
    }
    fn api(&self, auth: Option<&NearAuth>, base: &str) -> Result<LinkApi, Stop> {
        let a = auth.map(|a| Auth { access_token: a.access_token.clone(), device_id: a.device_id.clone() });
        LinkApi::new(base, a, self.env.attest_secret.clone(), &self.env.version).map_err(Stop::from)
    }
    fn my_caps(&self, ble_ready: bool) -> Caps {
        let lan = !self.env.ifaces.interfaces().is_empty();
        Caps { os: self.env.os, kind: DeviceKind::Desktop, ble_adv: false, ble_scan: ble_ready, lan_listen: lan, lan_dial: lan }
    }
}

// a tiny shim so `Stop` construction reads well (the serialised type lives in state.rs)
struct NearError_ {
    code: String,
    message: String,
}
impl From<NearError_> for super::state::NearError {
    fn from(e: NearError_) -> Self {
        super::state::NearError { code: e.code, message: e.message }
    }
}

impl Ctx {
    /// Receive messages until `want` matches; anything else is stashed for later; an `abort` ends the session. A `status`
    /// from the approver (contract 11.17) updates the snapshot and is never stashed.
    async fn expect<P: Pipe, F: Fn(&Message) -> bool>(&self, peer: &mut P, stash: &mut VecDeque<Message>, timeout: Duration, own: &NearRefusal, want: F) -> Result<Message, Stop> {
        if let Some(i) = stash.iter().position(&want) {
            return Ok(stash.remove(i).unwrap());
        }
        let end = tokio::time::Instant::now() + timeout;
        loop {
            let left = end.saturating_duration_since(tokio::time::Instant::now());
            if left.is_zero() {
                return Err(NearError::Timeout("peer message").into());
            }
            let m = self.cx(peer.recv(left)).await??;
            if let Some((r, ble, lan)) = m.abort_reason() {
                return Err(abort_stop(r, ble, lan, Some(own.clone())));
            }
            if self.note_status(&m) {
                continue;
            }
            if want(&m) {
                return Ok(m);
            }
            stash.push_back(m);
        }
    }

    /// Apply an approver `status` to the snapshot. Returns true when `m` was a status message.
    fn note_status(&self, m: &Message) -> bool {
        let Message::Status { stage, proximity } = m else { return false };
        if self.state().is_terminal() || self.state() == NearState::Idle {
            return true;
        }
        let stage = cl_near::relay::STATUS_STAGES.iter().find(|x| **x == stage).copied();
        let prox = match proximity.as_deref() {
            Some("ble") => Some("ble"),
            Some("lan") => Some("lan"),
            _ => None,
        };
        if let Some(stage) = stage {
            self.go(self.state(), |s| {
                s.peer_status = Some(NearPeerStatus { stage, proximity: prox });
                if stage == "proof_ok" {
                    s.proximity = prox;
                }
            });
        }
        true
    }
}

// ---- proximity -----------------------------------------------------------------------------------

/// A proof the approver itself verified. Constructed only by the proximity stage below.
struct Verified {
    /// What the approval is signed with (Bluetooth when held, else local network).
    approval: ProximityProof,
}

/// What a transfer needs to (re)connect: kept for the life of the session (contract 10: the listener keeps
/// its certificate and port, both sides keep `K_lan`, a resume repeats 4.2 against the same offer).
struct LanLink {
    how: LanHow,
    keys: SessionKeys,
    link_id: String,
    /// The connection the probe / proof already opened and nobody has used yet.
    held: Option<LanConn>,
}
enum LanHow {
    Listener(Arc<LanListener>),
    Dialer(LanOffer),
}

impl LanLink {
    async fn next_conn(&mut self, env: &NearEnv, wait: Duration) -> Result<LanConn, NearError> {
        if let Some(c) = self.held.take() {
            return Ok(c);
        }
        match &self.how {
            LanHow::Listener(l) => l.accept(wait).await,
            LanHow::Dialer(o) => {
                // the listener may take a moment to re-arm; retry the dial within `wait`
                let end = tokio::time::Instant::now() + wait;
                loop {
                    match dial(o, &self.keys, &self.link_id, env.ifaces.as_ref(), env.lan_policy, env.lan_timeouts).await {
                        Ok(c) => return Ok(c),
                        Err(e) if tokio::time::Instant::now() >= end => return Err(e),
                        Err(_) => tokio::time::sleep(Duration::from_millis(300)).await,
                    }
                }
            }
        }
    }
}

struct ProximityResult {
    verified: Option<Verified>,
    lan: Option<LanLink>,
    refusal: NearRefusal,
    /// The other device as it described itself in its sealed `caps`.
    peer_who: Who,
    /// Approver after a Bluetooth proof: the local-network leg still to run (who listens), once the sheet is on screen (F9 d).
    deferred: Option<Side>,
    /// Messages read ahead while negotiating (a `lan_offer` may already be in here).
    stash: VecDeque<Message>,
    keys: SessionKeys,
}

impl Ctx {
    /// The scanner side of 4.1 with the relay in the loop (L1): every distinct valid advertisement gets a `ble_heard`, and a verifying
    /// scanner (the approver) takes the proof only from the advertiser's `ble_ack`. The relay is read here while the radio scan runs on
    /// its own thread; anything that is not a `ble_ack` is stashed or handled like `expect` would (abort ends the session).
    async fn scan_ble<P: Pipe>(&self, peer: &mut P, stash: &mut VecDeque<Message>, keys: &SessionKeys, link_id: &str, verify: bool, own: &NearRefusal) -> Result<ScanOutcome, Stop> {
        let (radio, caps) = (self.env.radio.clone(), self.env.scan_caps);
        let (k, l) = (clone_keys(keys), link_id.to_owned());
        let flag = Arc::new(AtomicBool::new(false));
        let (f2, c2) = (flag.clone(), self.cancel.clone());
        let watcher = tokio::spawn(async move {
            c2.cancelled().await;
            f2.store(true, Ordering::SeqCst);
        });
        let (htx, mut hrx) = mpsc::unbounded_channel::<([u8; 12], [u8; 32])>();
        let (atx, arx) = std::sync::mpsc::channel::<[u8; 32]>();
        let scan = tokio::task::spawn_blocking(move || {
            scan_for_proof(&radio, &k, &l, caps, &flag, verify, &mut |r, mac| {
                let _ = htx.send((r, mac));
            }, &arx)
        });
        tokio::pin!(scan);
        enum Ev {
            Done(ScanOutcome),
            Heard([u8; 12], [u8; 32]),
            Msg(Result<Message, NearError>),
        }
        let result = loop {
            let ev = tokio::select! {
                o = &mut scan => Ev::Done(o.unwrap_or(ScanOutcome::FellThrough(FallReason::NoAdapter))),
                Some((r, mac)) = hrx.recv() => Ev::Heard(r, mac),
                m = peer.recv(Duration::from_millis(300)) => Ev::Msg(m),
            };
            match ev {
                Ev::Done(o) => break Ok(o),
                Ev::Heard(_, mac) => {
                    if let Err(e) = peer.send(&Message::ble_heard(&mac)).await {
                        break Err(Stop::from(e));
                    }
                }
                Ev::Msg(Ok(m)) => {
                    if let Some((r, ble, lan)) = m.abort_reason() {
                        break Err(abort_stop(r, ble, lan, Some(own.clone())));
                    }
                    if self.note_status(&m) {
                        continue;
                    }
                    match &m {
                        Message::BleAck { mac } => {
                            if let Some(a) = B64URL.decode(mac).ok().and_then(|v| <[u8; 32]>::try_from(v).ok()) {
                                let _ = atx.send(a);
                            }
                        }
                        _ => stash.push_back(m),
                    }
                }
                Ev::Msg(Err(NearError::Timeout(_))) => {}
                Ev::Msg(Err(e)) => break Err(Stop::from(e)),
            }
        };
        watcher.abort();
        if result.is_err() {
            // stop the radio thread before leaving
            drop(atx);
        }
        result
    }

    /// Bind a listener and wait for the peer; the offer goes out through `peer`.
    async fn lan_as_listener<P: Pipe>(&self, peer: &mut P, keys: &SessionKeys, link_id: &str, wait: Duration) -> Result<(LanLink, bool), Stop> {
        let l = match LanListener::bind(keys, link_id, self.env.ifaces.clone(), self.env.lan_policy, self.env.lan_timeouts).await {
            Ok(l) => l,
            Err(e) if io_blocked(&e) => {
                self.note_lan_blocked();
                return Err(Stop::Failed("lan_blocked".into(), e.to_string()));
            }
            Err(e) => return Err(e.into()),
        };
        peer.send(&Message::lan_offer(&l.offer())).await?;
        let l = Arc::new(l);
        let got = self.cx(l.accept(wait)).await?;
        let mut link = LanLink { how: LanHow::Listener(l), keys: clone_keys(keys), link_id: link_id.to_owned(), held: None };
        match got {
            Ok(c) => {
                link.held = Some(c);
                Ok((link, true))
            }
            Err(_) => Ok((link, false)),
        }
    }

    /// Wait for the peer's offer and dial it. Returns the link (with the connection held) or None. `probe` marks the
    /// result message `purpose: "transfer_probe"` (contract 11.5).
    #[allow(clippy::too_many_arguments)]
    async fn lan_as_dialer<P: Pipe>(&self, peer: &mut P, stash: &mut VecDeque<Message>, keys: &SessionKeys, link_id: &str, wait: Duration, own: &NearRefusal, probe: bool) -> Result<(Option<LanLink>, &'static str), Stop> {
        let offer = match self.expect(peer, stash, wait, own, |m| matches!(m, Message::LanOffer { .. })).await {
            Ok(m) => m.lan_offer_typed()?,
            Err(Stop::Failed(c, _)) if c == "near_error" => return Ok((None, self.lan_fail_cause())),
            Err(e) => return Err(e),
        };
        let (env, k, l) = (self.env.clone(), clone_keys(keys), link_id.to_owned());
        let o2 = offer.clone();
        let t = self.env.lan_timeouts;
        let got = self.cx(async move { dial(&o2, &k, &l, env.ifaces.as_ref(), env.lan_policy, t).await }).await?;
        let report = |ok: bool, reason: Option<&str>| if probe { Message::lan_probe_result(ok, reason) } else { Message::lan_result(ok, reason) };
        match got {
            Ok(c) => {
                let _ = peer.send(&report(true, None)).await;
                Ok((Some(LanLink { how: LanHow::Dialer(offer), keys: clone_keys(keys), link_id: link_id.to_owned(), held: Some(c) }), "ok"))
            }
            Err(e) => {
                if io_blocked(&e) {
                    self.note_lan_blocked();
                }
                // F9 (b): what goes to the peer about the local network is always `not_found` (no dial-failure causes on the wire: a hostile
                // peer must not learn which of its offers pointed at what). The sheet's own cause (`denied` / `firewall`) stays local.
                let cause = self.lan_fail_cause();
                let _ = peer.send(&report(false, Some("not_found"))).await;
                Ok((None, cause))
            }
        }
    }

    /// One run of 4.2 for `me`. `probe` = a Bluetooth proof already exists, so this is only the transfer probe (capped as a whole, never a
    /// refusal). Returns the link (connection held) when it came up, with the cause for the sheet. `announce` moves the machine to
    /// `proving_lan` (not wanted once the sheet is on screen).
    #[allow(clippy::too_many_arguments)]
    async fn lan_stage<P: Pipe>(&self, peer: &mut P, me: Side, l_side: Side, probe: bool, keys: &SessionKeys, link_id: &str, stash: &mut VecDeque<Message>, refusal: &mut NearRefusal, announce: bool) -> Result<(Option<LanLink>, &'static str), Stop> {
        let wait = if probe { self.env.timing.lan_probe } else { self.env.timing.lan };
        let attempt = NearAttempt { proof: "lan", hint: if probe { "probing_for_transfer" } else if l_side == me { "listening" } else { "dialing" } };
        if announce {
            self.go(NearState::ProvingLan, |s| s.attempt = Some(attempt));
        } else {
            self.go(self.state(), |s| s.attempt = Some(attempt));
        }
        if me == Side::A {
            let _ = peer.send(&Message::status("checking_lan", None)).await;
        }
        let own = refusal.clone();
        let stage = async {
            if l_side == me {
                let r = self.lan_as_listener(peer, keys, link_id, wait).await.map(|(l, ok)| (Some(l), if ok { "ok" } else { self.lan_fail_cause() }));
                // a bind the OS refused is the leg failing with its cause, not an engine failure
                let r = match r {
                    Err(Stop::Failed(c, _)) if c == "lan_blocked" => Ok((None, self.lan_fail_cause())),
                    other => other,
                };
                if probe && me == Side::A {
                    // A reports the probe outcome (the listener is the only one who knows it before the dialer says)
                    let ok = matches!(&r, Ok((_, "ok")));
                    let _ = peer.send(&Message::lan_probe_result(ok, if ok { None } else { Some("not_found") })).await;
                }
                r
            } else {
                self.lan_as_dialer(peer, stash, keys, link_id, wait, &own, probe).await
            }
        };
        // the probe is capped as a whole (offer wait + dial), not per step
        let r = if probe { tokio::time::timeout(self.env.timing.lan_probe + Duration::from_secs(1), stage).await.unwrap_or_else(|_| Ok((None, self.lan_fail_cause()))) } else { stage.await };
        match r {
            Ok((link, cause)) => {
                if !probe || cause == "ok" {
                    refusal.lan = cause;
                }
                Ok((link, cause))
            }
            Err(Stop::Failed(..)) if probe => Ok((None, "not_found")), // a probe failing is not a refusal
            Err(e) => Err(e),
        }
    }

    fn set_peer_sealed(&self, w: &Who) {
        let label = clean_label(&w.label);
        let sealed = !label.is_empty();
        let label = if sealed { label } else { "Unnamed device".to_owned() };
        let platform = Some(w.platform.clone()).filter(|p| !p.is_empty());
        self.go(self.state(), |s| s.peer = Some(NearPeer { label, platform, label_sealed: sealed, identity_key: None }));
    }

    /// Section 4 for both roles. `me` is our side. The approver (A) decides; the new device (N) helps. Everything the
    /// peer is called comes from ITS sealed `caps` (contract 11.2), and A narrates its progress to N with `status`
    /// messages (11.17) and reports the Bluetooth outcome with `ble_result` (11.4).
    async fn proximity<P: Pipe>(&self, peer: &mut P, me: Side, who: &Who, ble_allowed: bool) -> Result<ProximityResult, Stop> {
        let keys = clone_keys(peer.keys());
        *self.sh.xfer_key.lock().unwrap() = Some(keys.xfer.clone());
        let link_id = peer.link_id().to_owned();
        let mut refusal = NearRefusal { ble: "skipped", lan: "skipped" };
        let mut stash = VecDeque::new();
        self.go(NearState::PeerConnected, |_| {});
        // adapter state within the 3 s cap, once: it decides whether we advertise scanning in `caps`
        let adapter = if ble_allowed {
            self.cx(tokio::task::spawn_blocking({
                let (r, c) = (self.env.radio.clone(), self.env.scan_caps.adapter);
                move || probe_adapter(&r, c)
            }))
            .await?
            .unwrap_or(AdapterState::Error("join".into()))
        } else {
            AdapterState::NoAdapter // own-device transfer: no Bluetooth proof (contract 7)
        };
        let mine = self.my_caps(ble_allowed && adapter.usable());
        self.go(NearState::Negotiating, |s| s.ble = Some(NearBle { status: "idle", reason: None }));
        let theirs_msg = if me == Side::A {
            peer.send(&Message::caps_full(&mine, who)).await?;
            self.expect(peer, &mut stash, self.env.timing.peer_step, &refusal, |m| matches!(m, Message::Caps { .. })).await?
        } else {
            let t = self.expect(peer, &mut stash, self.env.timing.peer_step, &refusal, |m| matches!(m, Message::Caps { .. })).await?;
            peer.send(&Message::caps_full(&mine, who)).await?;
            t
        };
        // `kind` is required (contract 10): a `caps` without it is a protocol error and the session ends.
        let theirs = match theirs_msg.caps_checked() {
            Ok(c) => c,
            Err(_) => {
                let _ = peer.send(&Message::abort("error")).await;
                return Err(Stop::Failed("bad_caps".into(), "the other device did not say what kind of device it is".into()));
            }
        };
        let peer_who = theirs_msg.who().unwrap_or_default();
        self.set_peer_sealed(&peer_who);
        let (a_caps, n_caps) = if me == Side::A { (mine, theirs) } else { (theirs, mine) };
        let pl = plan(&a_caps, &n_caps, false);
        let ble_peer_advertises = pl.ble.is_some_and(|b| b.advertiser != me);
        if !ble_peer_advertises && theirs.ble_adv && !adapter.usable() {
            refusal.ble = ble_cause(&adapter); // the peer could have been heard but our radio is unusable
        }

        let mut approval: Option<ProximityProof> = None;
        let mut ble_proved = false;
        // -- 4.1 Bluetooth: we only ever scan
        if ble_peer_advertises {
            refusal.ble = "not_found";
            if me == Side::A {
                let _ = peer.send(&Message::status("checking_ble", None)).await;
                peer.send(&Message::ble_start(pl.ble.unwrap().advertiser)).await?;
            } else {
                // N waits for A's `ble_start` before it listens (A may also have none to give)
                let _ = self.expect(peer, &mut stash, self.env.timing.peer_step, &refusal, |m| matches!(m, Message::BleStart { .. })).await;
            }
            self.go(NearState::ProvingBle, |s| {
                s.attempt = Some(NearAttempt { proof: "ble", hint: "scanning" });
                s.ble = Some(NearBle { status: "scanning", reason: None });
            });
            // L1: the approver counts Bluetooth only on the advertiser's `ble_ack`; the new device only reports what it heard
            match self.scan_ble(peer, &mut stash, &keys, &link_id, me == Side::A, &refusal).await? {
                ScanOutcome::Heard { proof, .. } => {
                    refusal.ble = "ok";
                    self.go(NearState::ProvingBle, |s| s.ble = Some(NearBle { status: "heard", reason: None }));
                    approval = Some(proof);
                    ble_proved = true;
                    let _ = peer.send(&Message::ble_result(true, Some("ok"))).await;
                    let _ = peer.send(&Message::status("proof_ok", Some("ble"))).await;
                }
                ScanOutcome::Reported { .. } => {
                    refusal.ble = "ok";
                    self.go(NearState::ProvingBle, |s| s.ble = Some(NearBle { status: "heard", reason: None }));
                    // we scanned: the advertiser (A) verifies our `ble_heard` and answers with `ble_result`
                    match self.expect(peer, &mut stash, self.env.timing.peer_step.min(Duration::from_secs(4)), &refusal, |m| matches!(m, Message::BleResult { .. })).await {
                        Ok(Message::BleResult { ok, cause }) => {
                            ble_proved = ok;
                            if !ok {
                                refusal.ble = cause.as_deref().and_then(ble_cause_static).unwrap_or("not_found");
                            }
                        }
                        Ok(_) | Err(Stop::Failed(..)) => {}
                        Err(e) => return Err(e),
                    }
                }
                ScanOutcome::FellThrough(r) => {
                    let why = match r {
                        FallReason::NoAdapter => ble_cause(&adapter),
                        FallReason::AdapterTimeout => "no_adapter",
                        _ => "not_found",
                    };
                    refusal.ble = why;
                    self.go(NearState::ProvingBle, |s| s.ble = Some(NearBle { status: "fell_through", reason: Some(why) }));
                    if me == Side::A {
                        let _ = peer.send(&Message::ble_result(false, Some(why))).await;
                    }
                }
            }
            if self.cancel.is_cancelled() {
                return Err(Stop::Cancelled);
            }
        }

        // -- 4.2 local network: the proof when Bluetooth gave none, else the transfer probe (9 s cap, never a refusal).
        // F9 (d): after a Bluetooth proof the APPROVER does not start its local-network leg here: it starts it only after its sheet is on
        // screen (`approver_run`), so a stranger that merely holds the code cannot make the approver dial or listen before anybody looked.
        let mut lan_link: Option<LanLink> = None;
        let mut deferred = None;
        if let Some(l_side) = lan_listener(&a_caps, &n_caps) {
            if me == Side::A && ble_proved {
                deferred = Some(l_side);
            } else {
                let (link, cause) = self.lan_stage(peer, me, l_side, ble_proved, &keys, &link_id, &mut stash, &mut refusal, true).await?;
                if let Some(link) = link {
                    if cause == "ok" && approval.is_none() && me == Side::A {
                        approval = link.held.as_ref().map(|c| c.proof());
                        if approval.is_some() {
                            let _ = peer.send(&Message::status("proof_ok", Some("lan"))).await;
                        }
                    }
                    lan_link = Some(link);
                }
            }
        }
        match (me, approval) {
            (Side::A, Some(p)) => Ok(ProximityResult { verified: Some(Verified { approval: p }), lan: lan_link, refusal, peer_who, deferred, stash, keys }),
            (Side::A, None) => Ok(ProximityResult { verified: None, lan: None, refusal, peer_who, deferred: None, stash, keys }),
            (Side::N, _) => Ok(ProximityResult { verified: None, lan: lan_link, refusal, peer_who, deferred: None, stash, keys }),
        }
    }
}

// ---- the approver ----------------------------------------------------------------------------------

struct PeerFacts {
    label: String,
    platform: Option<String>,
    new_identity_key_b64: String,
    ek_pub_b64: String,
}

impl Ctx {
    /// This device as it introduces itself in its sealed `caps`.
    fn my_who(&self, label: Option<&str>) -> Who {
        Who { label: clean_label(label.unwrap_or(&self.env.device_label)), platform: self.env.platform.to_owned() }
    }

    async fn approver_main(&self, base: String, auth: NearAuth, scan: ScanInput, rx: &mut mpsc::UnboundedReceiver<Cmd>) -> Result<(), Stop> {
        self.go(NearState::CreatingSession, |s| s.role = Some("approver"));
        let api = Arc::new(self.api(Some(&auth), &base)?);
        let (link_id, en_pub, secret) = match scan {
            ScanInput::Qr(text) => match cl_near::code::parse(text.trim()) {
                Ok(NearPayload::Near(c)) => (c.link_id, c.en_pub, c.secret),
                Ok(NearPayload::Invite(_)) => return Err(Stop::Failed("wrong_code_kind".into(), "this is an invite code: show it, do not scan it".into())),
                Err(_) => return Err(Stop::Failed("bad_code".into(), "not a Cipherline near code".into())),
            },
            ScanInput::Typed(text) => {
                let typed = normalize_typed(&text).and_then(|n| TypedCode::parse(&n).ok()).ok_or(()).map_err(|_| Stop::Failed("bad_typed_code".into(), "the code is not 8 valid characters".into()))?;
                let t2 = typed.clone();
                let hash = self.blocking(move || t2.lookup_hash_hex()).await?;
                let a2 = api.clone();
                let l = self.call(move || a2.lookup(&hash)).await?;
                let en = decode_pub(&l.ek_pub_b64).ok_or_else(|| Stop::Failed("bad_response".into(), "lookup key".into()))?;
                // F8: argon2id (0.25 s, 64 MiB) off the async threads
                let (t3, lid) = (typed.clone(), l.link_id.clone());
                let secret = self.blocking(move || t3.derive_secret(&lid)).await?;
                (l.link_id, en, secret)
            }
        };
        self.go(NearState::CreatingSession, |s| s.link_id = Some(link_id.clone()));
        let info = self.scan_with_retry(&api, &link_id).await?;
        let key = info.identity_key_pub_b64.clone().filter(|_| info.near).ok_or_else(|| Stop::Failed("not_a_near_session".into(), "the session is not a proximity session".into()))?;
        // F4: the identity key the server named at scan is what the sealed `hello_ack` must carry
        let expected_ik = decode_pub(&key).ok_or_else(|| Stop::Failed("bad_response".into(), "identity key".into()))?;
        let t = HttpRelay::new(&api, Side::A, &link_id);
        // The first relay post (the hello) goes out right after the scan: it is what makes the server's scan pin final (v14).
        let peer = self.cx(RelayPeer::approver_connect(t, &link_id, &en_pub, &secret, &expected_ik, self.env.timing.hello)).await?.map_err(takeover_or)?;
        // the server-relayed label and platform (`info.device_label`) are deliberately NOT used: the approval sheet names the
        // device by what it says inside the sealed channel (contract 11.2)
        let facts = PeerFacts { label: String::new(), platform: None, new_identity_key_b64: key, ek_pub_b64: B64.encode(en_pub) };
        self.approver_after_hello(api, auth, peer, link_id, facts, rx).await
    }

    /// `POST scan`, with the v14 rule: a scan that loses the provisional pin (404, or 409 `link_already_scanning`) is retried once after
    /// `scan_retry` (10 s) instead of failing hard.
    async fn scan_with_retry(&self, api: &Arc<LinkApi>, link_id: &str) -> Result<super::api::ScanInfo, Stop> {
        for attempt in 0..2 {
            let (a2, id2) = (api.clone(), link_id.to_owned());
            match self.blocking(move || a2.scan(&id2)).await? {
                Ok(i) => return Ok(i),
                Err(e) if attempt == 0 && (e.status == 404 || e.code == "link_already_scanning") => {
                    self.cx(tokio::time::sleep(self.env.timing.scan_retry)).await?;
                }
                Err(e) => return Err(Stop::from(e)),
            }
        }
        unreachable!("the loop returns on its second pass")
    }

    async fn invite_main(&self, base: String, auth: NearAuth, rx: &mut mpsc::UnboundedReceiver<Cmd>) -> Result<(), Stop> {
        self.go(NearState::CreatingSession, |s| s.role = Some("approver"));
        let api = Arc::new(self.api(Some(&auth), &base)?);
        let limit = self.env.now() + self.env.timing.show_limit;
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        let mut last_poll = Instant::now() - Duration::from_secs(10);
        'outer: loop {
            let a2 = api.clone();
            let inv = self.call(move || a2.create_invite()).await?;
            let mut rotor = SecretRotor::new(self.env.now());
            let mut rotated_at = self.env.now();
            let ends = now_ms() + (inv.ttl_s as i64) * 1000;
            self.show_invite(&inv.link_id, &rotor, ends);
            loop {
                tokio::select! {
                    _ = self.cancel.cancelled() => return Err(Stop::Cancelled),
                    _ = tick.tick() => {}
                }
                let now = self.env.now();
                if now >= limit {
                    return Err(Stop::Expired("show_limit".into()));
                }
                if rotor.tick(now) {
                    rotated_at = now;
                    self.show_invite(&inv.link_id, &rotor, ends);
                }
                if rotor.session_expiring(now, self.env.timing.reopen_margin) {
                    continue 'outer; // a fresh invite; the old one simply lapses
                }
                if last_poll.elapsed() < self.env.timing.poll {
                    continue;
                }
                last_poll = Instant::now();
                let (a2, id) = (api.clone(), inv.link_id.clone());
                let p = self.call(move || a2.poll_invite(&id)).await?;
                if p.state == "expired" {
                    continue 'outer;
                }
                if p.state != "joined" && p.ek_pub_b64.is_none() {
                    continue;
                }
                let (Some(ek), Some(ik), true) = (p.ek_pub_b64.clone(), p.identity_key_pub_b64.clone(), p.near) else {
                    return Err(Stop::Failed("not_a_near_session".into(), "the joined session is not a proximity session".into()));
                };
                let en_pub = decode_pub(&ek).ok_or_else(|| Stop::Failed("bad_response".into(), "invite key".into()))?;
                // The joiner scanned the secret that was on screen a moment ago. hello can carry only one
                // secret (its seq is spent once), so: the previous one if the code rotated just now.
                let cands = rotor.candidates();
                let secret = if now.saturating_duration_since(rotated_at) < Duration::from_secs(3) && cands.len() > 1 { cands[1].clone() } else { cands[0].clone() };
                let t = HttpRelay::new(&api, Side::A, &inv.link_id);
                let expected_ik = decode_pub(&ik).ok_or_else(|| Stop::Failed("bad_response".into(), "identity key".into()))?;
                let peer = self.cx(RelayPeer::approver_connect(t, &inv.link_id, &en_pub, &secret, &expected_ik, self.env.timing.hello)).await?.map_err(takeover_or)?;
                let facts = PeerFacts { label: String::new(), platform: None, new_identity_key_b64: ik, ek_pub_b64: ek };
                self.go(NearState::PeerConnected, |s| s.link_id = Some(inv.link_id.clone()));
                return self.approver_after_hello(api, auth, peer, inv.link_id, facts, rx).await;
            }
        }
    }

    fn show_invite(&self, id: &str, rotor: &SecretRotor, ends_ms: i64) {
        let uri = build_invite_compact(id, rotor.current()).unwrap_or_else(|_| build_invite(id, rotor.current()));
        let rot = now_ms() + cl_near::code::ROTATE_EVERY.as_millis() as i64;
        self.go(NearState::ShowingCode, |s| {
            s.link_id = Some(id.to_owned());
            s.code = Some(NearCode { uri, typed: None, rotates_at_ms: rot, session_ends_at_ms: ends_ms });
        });
    }

    async fn approver_after_hello(&self, api: Arc<LinkApi>, auth: NearAuth, mut peer: RelayPeer<HttpRelay>, link_id: String, mut facts: PeerFacts, rx: &mut mpsc::UnboundedReceiver<Cmd>) -> Result<(), Stop> {
        self.go(NearState::PeerConnected, |s| s.link_id = Some(link_id.clone()));
        let r = self.approver_run(&api, &auth, &mut peer, &link_id, &mut facts, rx).await;
        if let Err(stop) = &r {
            if let Some(m) = abort_for(stop) {
                let _ = tokio::time::timeout(Duration::from_secs(3), peer.send(&m)).await;
            }
        }
        r
    }

    async fn approver_run(&self, api: &Arc<LinkApi>, auth: &NearAuth, peer: &mut RelayPeer<HttpRelay>, link_id: &str, facts: &mut PeerFacts, rx: &mut mpsc::UnboundedReceiver<Cmd>) -> Result<(), Stop> {
        let who = self.my_who(None);
        let res = self.proximity(peer, Side::A, &who, true).await?;
        facts.label = res.peer_who.label.clone();
        facts.platform = Some(res.peer_who.platform.clone()).filter(|p| !p.is_empty());
        let Some(verified) = res.verified else {
            let _ = peer.send(&Message::abort_no_proximity(res.refusal.ble, res.refusal.lan)).await;
            return Err(Stop::Refused(res.refusal, "no_proximity".into()));
        };
        let method = verified.approval.method();
        // F3 policy: the history may be offered at approval time only after a BLUETOOTH proof. A local-network proof only shows that a
        // device holding the code is on this network: approve-only, and the approver drops its end of that connection.
        let history_allowed = method == Proximity::Ble || self.env.lan_history_override();
        let mut lan = if history_allowed { res.lan } else { None };
        let offerable = lan.is_some();
        let refusal = res.refusal.clone();
        // L3: what the sheet will show, recorded as the one thing this approval may sign for
        *self.sh.shown.lock().unwrap() = Some(ApprovalShown { link_id: link_id.to_owned(), identity_key_b64: facts.new_identity_key_b64.clone(), proximity: method });
        let shown_key = facts.new_identity_key_b64.clone();
        self.go(NearState::ProofVerified, |s| {
            s.proximity = Some(method.as_str_static());
            s.transfer_offerable = Some(offerable);
            s.history_allowed = Some(history_allowed);
            s.refusal = Some(refusal);
            if let Some(p) = s.peer.as_mut() {
                p.identity_key = Some(shown_key);
            }
        });
        self.go(NearState::AwaitingApproval, |_| {});
        let _ = peer.send(&Message::status("awaiting_user", None)).await;
        // F9 (d): the sheet is on screen; only now does the approver start its local-network leg (the transfer probe).
        let mut pending: Option<Cmd> = None;
        if let (Some(l_side), true) = (res.deferred, history_allowed) {
            let (mut stash, mut refusal2) = (res.stash, res.refusal.clone());
            let outcome = {
                let probe = self.lan_stage(peer, Side::A, l_side, true, &res.keys, link_id, &mut stash, &mut refusal2, false);
                tokio::pin!(probe);
                tokio::select! {
                    r = &mut probe => Some(r),
                    c = rx.recv() => {
                        // The user answered before the probe finished: that is "approve only" (the button for the transfer is not enabled
                        // until `transfer_offerable`), so the probe ends here and the command is handled below.
                        match c { None => return Err(Stop::Cancelled), Some(c) => { pending = Some(c); None } }
                    }
                }
            };
            match outcome {
                Some(Ok((Some(link), "ok"))) => {
                    lan = Some(link);
                    self.go(NearState::AwaitingApproval, |s| {
                        s.transfer_offerable = Some(true);
                        s.refusal = Some(refusal2);
                    });
                }
                Some(Ok(_)) | None => {}
                Some(Err(e)) => return Err(e),
            }
        }
        let mut approved = false;
        let mut tick = tokio::time::interval(self.env.timing.poll.max(Duration::from_millis(50)) * 2);
        loop {
            tokio::select! {
                _ = self.cancel.cancelled() => {
                    if approved { self.go(NearState::Done, |_| {}); return Ok(()); }
                    return Err(Stop::Cancelled);
                }
                _ = tick.tick() => {
                    let (a2, id) = (api.clone(), link_id.to_owned());
                    if !approved {
                        if let Ok(Ok(p)) = tokio::task::spawn_blocking(move || a2.poll_session(&id)).await {
                            if p.state == "expired" { return Err(Stop::Expired("session_expired".into())); }
                        }
                    }
                }
                // Contract 11.16: the relay is read in EVERY state, so the new device's own `cancelled` shows at once.
                m = peer.recv(Duration::from_secs(30)), if !approved => match m {
                    Ok(m) => {
                        if let Some((r, b, l)) = m.abort_reason() { return Err(abort_stop(r, b, l, None)); }
                    }
                    Err(NearError::Timeout(_)) => {}
                    Err(e) => return Err(e.into()),
                },
                cmd = next_cmd(&mut pending, rx) => match cmd {
                    None => return Err(Stop::Cancelled),
                    Some(Cmd::Approve(reply)) => {
                        if approved || self.state() != NearState::AwaitingApproval {
                            let _ = reply.send(ApproveOutcome::Failed("not_awaiting_approval", "no approval is pending".into()));
                            continue;
                        }
                        match self.do_approve(api, auth, link_id, facts, &verified).await {
                            Ok(Ok(())) => { approved = true; let _ = reply.send(ApproveOutcome::Approved(self.last_gate())); }
                            Ok(Err(outcome)) => { let _ = reply.send(outcome); }
                            Err(stop) => { let _ = reply.send(ApproveOutcome::Failed("approve_failed", format!("{stop:?}"))); return Err(stop); }
                        }
                    }
                    Some(Cmd::Refuse(reply)) => {
                        let (a2, id) = (api.clone(), link_id.to_owned());
                        let _ = tokio::task::spawn_blocking(move || a2.deny(&id)).await;
                        let _ = peer.send(&Message::abort("denied")).await;
                        let _ = reply.send(());
                        return Err(Stop::Declined);
                    }
                    Some(Cmd::Send(path, reply)) => {
                        if !approved { let _ = reply.send(Err("approve first".into())); continue; }
                        if !history_allowed { let _ = reply.send(Err("a local-network proof is approve-only: the history moves from Settings once you are signed in".into())); continue; }
                        let Some(l) = lan.as_mut() else { let _ = reply.send(Err("no local-network path: a transfer cannot be offered".into())); continue; };
                        if verified_lan_missing(l) { let _ = reply.send(Err("no local-network path".into())); continue; }
                        let src = (self.env.resolve_path)(&path);
                        match src {
                            Err(e) => { let _ = reply.send(Err(e)); }
                            Ok(p) => { let _ = reply.send(Ok(())); return self.do_send(auth, l, p).await; }
                        }
                    }
                    Some(Cmd::Receive(reply)) => { let _ = reply.send(Err("this device is the sender".into())); }
                }
            }
        }
    }

    fn last_gate(&self) -> &'static str {
        match self.env.gate.availability() {
            Availability::Available => "hello",
            Availability::Unavailable => self.env.gate.confirm_kind().bridge_name(),
        }
    }

    /// Gate -> sign v2 -> approve -> seal -> grant. `Ok(Err(outcome))` = back to the screen; `Err` = session over.
    async fn do_approve(&self, api: &Arc<LinkApi>, auth: &NearAuth, link_id: &str, f: &PeerFacts, v: &Verified) -> Result<Result<(), ApproveOutcome>, Stop> {
        self.go(NearState::Approving, |_| {});
        let who = clean_label(&f.label);
        let plat = f.platform.clone().unwrap_or_default();
        let gate: Arc<dyn ApprovalGate> = self.env.gate.clone();
        let (title, detail) = ("Sign in a new device?".to_owned(), format!("\"{who}\" ({plat}) is asking to sign in to your account.\n\nApprove only if you are looking at that device right now."));
        let (_, verdict) = self.blocking(move || run_gate(gate.as_ref(), &title, &detail)).await?;
        let gate_name = self.last_gate();
        match verdict {
            Verification::Verified => {}
            other => {
                self.go(NearState::AwaitingApproval, |_| {});
                return Ok(Err(if other == Verification::Cancelled { ApproveOutcome::Cancelled(gate_name) } else { ApproveOutcome::Failed(gate_name, "the confirmation failed".into()) }));
            }
        }
        let ts = now_ms() / 1000;
        let msg = link_approve_message_v2(&auth.user_id, &auth.device_id, link_id, &f.new_identity_key_b64, &v.approval, ts)?;
        // L3: the signature is for what the sheet showed (link, new identity key, proximity) and for nothing else
        let shown = self.sh.shown.lock().unwrap().clone();
        if !shown.as_ref().is_some_and(|sh| approval_message_matches(&msg, &auth.user_id, &auth.device_id, sh)) {
            return Err(Stop::Failed("approval_mismatch".into(), "the approval does not match what is on screen".into()));
        }
        let sig = self.env.identity.sign(&msg).ok_or_else(|| Stop::Failed("sign_failed".into(), "no identity key".into()))?;
        let (a2, id, prox) = (api.clone(), link_id.to_owned(), v.approval.method().as_str());
        let ap = self.call(move || a2.approve_near(&id, &sig, ts, prox)).await?;
        let envelope = cl_crypto::link::seal_link_grant_v2(link_id, &ap.user_id, &ap.claim_secret, &ap.approved_by_device_id, &ap.approved_by_device_name, &crate::util::chrono_iso(now_ms()), &f.ek_pub_b64).map_err(|e| Stop::Failed("seal_failed".into(), e.to_string()))?;
        let (a3, id3) = (api.clone(), link_id.to_owned());
        self.call(move || a3.grant(&id3, &envelope)).await?;
        self.sh.xfer_released.store(true, Ordering::SeqCst);
        self.go(NearState::Approved, |_| {});
        Ok(Ok(()))
    }
}

async fn next_cmd(pending: &mut Option<Cmd>, rx: &mut mpsc::UnboundedReceiver<Cmd>) -> Option<Cmd> {
    match pending.take() {
        Some(c) => Some(c),
        None => rx.recv().await,
    }
}

trait AsStaticStr {
    fn as_str_static(self) -> &'static str;
}
impl AsStaticStr for Proximity {
    fn as_str_static(self) -> &'static str {
        self.as_str()
    }
}

fn verified_lan_missing(l: &LanLink) -> bool {
    l.held.is_none() && matches!(l.how, LanHow::Dialer(_)) && false
}

// ---- the new device -----------------------------------------------------------------------------------

struct Att {
    link_id: String,
    en_pub: [u8; 32],
    ek_b64: String,
    ek_priv: Zeroizing<[u8; 32]>,
    rotor: Arc<Mutex<SecretRotor>>,
    typed: Option<TypedCode>,
    ends_ms: i64,
}

#[derive(Clone, Debug, PartialEq)]
enum Poll {
    Waiting,
    Granted(String),
    Denied,
    Expired,
}

impl Ctx {
    fn show_att(&self, a: &Att) {
        // contract 11.14: the screen draws the compact `CLN1:` form (a smaller symbol); parsers accept both forms
        let uri = build_near_compact(&a.link_id, &a.en_pub, a.rotor.lock().unwrap().current()).unwrap_or_else(|_| build_near(&a.link_id, &a.en_pub, a.rotor.lock().unwrap().current()));
        let typed = a.typed.as_ref().map(|t| t.display());
        let rot = now_ms() + cl_near::code::ROTATE_EVERY.as_millis() as i64;
        let ends = a.ends_ms;
        self.go(NearState::ShowingCode, |s| {
            s.link_id = Some(a.link_id.clone());
            s.code = Some(NearCode { uri, typed, rotates_at_ms: rot, session_ends_at_ms: ends });
        });
    }

    async fn new_device_main(&self, base: String, typed_mode: bool, label: Option<String>, rx: &mut mpsc::UnboundedReceiver<Cmd>) -> Result<(), Stop> {
        self.go(NearState::CreatingSession, |s| s.role = Some("new_device"));
        let api = Arc::new(self.api(None, &base)?);
        let ident = self.env.identity.identity_pub_b64().ok_or_else(|| Stop::Failed("no_identity".into(), "this device has no identity key yet".into()))?;
        // F4: the 32 raw bytes of the identity key are sealed into every `hello_ack`
        let ik = decode_pub(&ident).ok_or_else(|| Stop::Failed("no_identity".into(), "the identity key is not 32 bytes".into()))?;
        let label = label.map(|l| clean_label(&l)).filter(|l| !l.is_empty()).unwrap_or_else(|| clean_label(&self.env.device_label));
        let limit = self.env.now() + self.env.timing.show_limit;
        let mut atts: Vec<Att> = vec![];
        let mut set: tokio::task::JoinSet<(String, Result<RelayPeer<HttpRelay>, NearError>)> = tokio::task::JoinSet::new();
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        let mut need_new = true;
        let winner: (Att, RelayPeer<HttpRelay>) = loop {
            if need_new {
                need_new = false;
                let (ek_priv, en_pub) = keys::generate_keypair();
                let ek_b64 = B64.encode(en_pub);
                let typed = typed_mode.then(TypedCode::generate);
                let hash = match &typed {
                    Some(t) => {
                        let t2 = t.clone();
                        Some(self.blocking(move || t2.lookup_hash_hex()).await?)
                    }
                    None => None,
                };
                // F5: this session's relay token. Memory only; the server gets its SHA-256 now, the token itself rides every side-n post.
                let token = Arc::new(RelayToken::generate());
                let relay_hash = token.auth_hash_b64();
                let (a2, ek2, l2, p2, i2) = (api.clone(), ek_b64.clone(), label.clone(), self.env.platform, ident.clone());
                let created = self.call(move || a2.create_near_session(&ek2, &l2, p2, &i2, hash.as_deref(), &relay_hash)).await?;
                // F8: the typed secret is argon2id now (0.25 s, 64 MiB): derived ONCE per session, off the async threads
                let typed_secret = match &typed {
                    Some(t) => {
                        let (t3, lid) = (t.clone(), created.link_id.clone());
                        Some(self.blocking(move || t3.derive_secret(&lid)).await?)
                    }
                    None => None,
                };
                let att = Att { link_id: created.link_id.clone(), en_pub, ek_b64, ek_priv, rotor: Arc::new(Mutex::new(SecretRotor::new(self.env.now()))), typed, ends_ms: now_ms() + (created.ttl_s as i64) * 1000 };
                let n_api = api.with_relay_token(token);
                let (t, rot, lid, secs) = (HttpRelay::new(&n_api, Side::N, &att.link_id), att.rotor.clone(), att.link_id.clone(), created.ttl_s.max(1));
                let sk = att.ek_priv.clone();
                set.spawn(async move {
                    let rot2 = rot.clone();
                    let r = RelayPeer::new_device_accept(t, &lid, &sk, &ik, move || {
                        let mut v: Vec<ProximitySecret> = rot2.lock().unwrap().candidates().into_iter().cloned().collect();
                        if let Some(t) = &typed_secret {
                            v.push(t.clone());
                        }
                        v
                    }, Duration::from_secs(secs))
                    .await;
                    (lid, r)
                });
                self.show_att(&att);
                atts.push(att);
            }
            tokio::select! {
                _ = self.cancel.cancelled() => { set.abort_all(); self.destroy_all(&api, &atts).await; return Err(Stop::Cancelled); }
                joined = set.join_next(), if !set.is_empty() => {
                    match joined {
                        Some(Ok((lid, Ok(peer)))) => {
                            let i = atts.iter().position(|a| a.link_id == lid).unwrap();
                            let w = atts.remove(i);
                            set.abort_all();
                            self.destroy_all(&api, &atts).await;
                            break (w, peer);
                        }
                        Some(Ok((_, Err(NearError::Auth(_))))) => return Err(Stop::Failed("hello_rejected".into(), "the other device's confirmation did not verify".into())),
                        Some(_) => { if set.is_empty() { need_new = true; } } // that session ended without a peer
                        None => {}
                    }
                }
                _ = tick.tick() => {
                    let now = self.env.now();
                    if now >= limit { set.abort_all(); self.destroy_all(&api, &atts).await; return Err(Stop::Expired("show_limit".into())); }
                    if let Some(newest) = atts.last() {
                        let (rotated, expiring) = { let mut r = newest.rotor.lock().unwrap(); (r.tick(now), r.session_expiring(now, self.env.timing.reopen_margin)) };
                        if rotated { self.show_att(newest); }
                        if expiring && atts.len() < 3 { need_new = true; }
                    }
                }
            }
        };
        let (att, mut peer) = winner;
        // From here the bridge can open the grant: hand it the link key (contract: linkOpen needs it).
        self.env.identity.install_link_session(&att.link_id, &att.ek_priv, &att.ek_b64);
        self.go(NearState::PeerConnected, |s| s.link_id = Some(att.link_id.clone()));
        // watch the server session (granted / denied / expired) while the proximity stages run
        let (ptx, mut prx) = watch::channel(Poll::Waiting);
        let (papi, plink, every) = (Arc::new(api.anonymous()), att.link_id.clone(), self.env.timing.poll);
        let poller = tokio::spawn(async move {
            loop {
                let (a, l) = (papi.clone(), plink.clone());
                let polled = tokio::task::spawn_blocking(move || a.poll_session(&l)).await;
                // a 429 from the throttler is back-off (its Retry-After), never the end of the session
                if let Ok(Err(e)) = &polled {
                    if e.status == 429 {
                        tokio::time::sleep(Duration::from_secs(e.retry_after_s.unwrap_or(1).clamp(1, 10))).await;
                    }
                }
                if let Ok(Ok(p)) = polled {
                    let v = match p.state.as_str() {
                        "granted" if p.envelope_b64.is_some() => Poll::Granted(p.envelope_b64.unwrap()),
                        "denied" => Poll::Denied,
                        "expired" => Poll::Expired,
                        _ => Poll::Waiting,
                    };
                    let done = v != Poll::Waiting;
                    // only a CHANGE wakes the waiting loop: `send` marks the value changed even when it is equal, and every wake
                    // restarts the relay read (an immediate GET), which turned a 1 s poll into ~10 relay GETs a second.
                    ptx.send_if_modified(|cur| {
                        if *cur != v {
                            *cur = v.clone();
                            true
                        } else {
                            false
                        }
                    });
                    if done {
                        return;
                    }
                }
                tokio::time::sleep(every).await;
            }
        });
        let who = self.my_who(Some(&label));
        let r = self.new_device_after_hello(&mut peer, &mut prx, rx, att.link_id.clone(), who).await;
        poller.abort();
        if let Err(stop) = &r {
            if let Some(m) = abort_for(stop) {
                let _ = tokio::time::timeout(Duration::from_secs(3), peer.send(&m)).await;
            }
        }
        r
    }

    async fn destroy_all(&self, api: &Arc<LinkApi>, atts: &[Att]) {
        for a in atts {
            let (a2, id) = (api.clone(), a.link_id.clone());
            let _ = tokio::task::spawn_blocking(move || a2.destroy_session(&id)).await;
        }
    }

    async fn new_device_after_hello(&self, peer: &mut RelayPeer<HttpRelay>, prx: &mut watch::Receiver<Poll>, rx: &mut mpsc::UnboundedReceiver<Cmd>, link_id: String, who: Who) -> Result<(), Stop> {
        let mut early = prx.clone();
        let res = tokio::select! {
            r = self.proximity(peer, Side::N, &who, true) => r?,
            w = early.wait_for(|p| matches!(p, Poll::Denied | Poll::Expired)) => {
                let denied = w.map(|v| *v == Poll::Denied).unwrap_or(false);
                return Err(if denied { Stop::Refused(NearRefusal { ble: "skipped", lan: "skipped" }, "denied".into()) } else { Stop::Expired("session_expired".into()) });
            }
        };
        let mut lan = res.lan;
        let own = res.refusal.clone();
        self.go(NearState::AwaitingApproval, |s| s.refusal = Some(res.refusal));
        let mut approved = false;
        loop {
            tokio::select! {
                _ = self.cancel.cancelled() => {
                    if approved { self.go(NearState::Done, |_| {}); return Ok(()); }
                    return Err(Stop::Cancelled);
                }
                changed = prx.changed(), if !approved => {
                    if changed.is_err() { continue; }
                    let v = prx.borrow().clone();
                    match v {
                        Poll::Granted(env) => { approved = true; self.sh.xfer_released.store(true, Ordering::SeqCst); self.go(NearState::Approved, |s| { s.envelope_b64 = Some(env); }); }
                        Poll::Denied => return Err(Stop::Refused(NearRefusal { ble: "skipped", lan: "skipped" }, "denied".into())),
                        Poll::Expired => return Err(Stop::Expired("session_expired".into())),
                        Poll::Waiting => {}
                    }
                }
                // Contract 11.16: keep reading the relay while waiting, so the approver's refusal / denial / cancel (and
                // its `status` lines) reach this screen at once and not at expiry. Once granted, nothing here can undo it.
                m = peer.recv(Duration::from_secs(30)), if !approved => match m {
                    Ok(m) => {
                        if let Some((r, b, l)) = m.abort_reason() { return Err(abort_stop(r, b, l, Some(own.clone()))); }
                        self.note_status(&m);
                    }
                    Err(NearError::Timeout(_)) => {}
                    Err(e) => return Err(e.into()),
                },
                cmd = rx.recv() => match cmd {
                    None => return Err(Stop::Cancelled),
                    Some(Cmd::Receive(reply)) => {
                        if !approved { let _ = reply.send(Err("not approved yet".into())); continue; }
                        // F3 policy: after a local-network-only proof the approver sends nothing and this side drops its end: the history
                        // then comes from Settings, between two signed-in devices.
                        if self.snap().proximity == Some("lan") && !self.env.lan_history_override() {
                            lan = None;
                            let _ = reply.send(Err("a local-network proof is approve-only: transfer the history from Settings once you are signed in".into()));
                            continue;
                        }
                        let Some(l) = lan.as_mut() else { let _ = reply.send(Err("no local-network path".into())); continue; };
                        let _ = reply.send(Ok(()));
                        return self.do_receive(l, &link_id).await;
                    }
                    Some(Cmd::Approve(r)) => { let _ = r.send(ApproveOutcome::Failed("wrong_role", "this device is the new device".into())); }
                    Some(Cmd::Refuse(r)) => { let _ = r.send(()); return Err(Stop::Cancelled); }
                    Some(Cmd::Send(_, r)) => { let _ = r.send(Err("this device is the receiver".into())); }
                }
            }
        }
    }
}

// ---- transfer ---------------------------------------------------------------------------------------------

fn progress_hook(ctx: &Ctx, direction: &'static str, attempt: Arc<AtomicU64>) -> Arc<dyn Fn(Progress) + Send + Sync> {
    let ctx = ctx.clone();
    let last = Mutex::new(Instant::now() - Duration::from_secs(1));
    Arc::new(move |p: Progress| {
        let mut l = last.lock().unwrap();
        let finished = p.records_done == p.records_total;
        if !finished && l.elapsed() < Duration::from_millis(200) {
            return;
        }
        *l = Instant::now();
        let att = attempt.load(Ordering::SeqCst) as u32;
        ctx.go(NearState::Transferring, |s| {
            s.transfer = Some(NearTransfer { direction, bytes_done: p.bytes_done, bytes_total: p.bytes_total, records_done: p.records_done, records_total: p.records_total, attempt: att, paused: false, paused_by: None, interrupted: false });
        });
    })
}

/// How an attempt ended.
enum Attempt<T> {
    Done(T),
    /// This side paused.
    Paused,
    /// The peer paused.
    PeerPaused,
    /// A broken connection or a transport failure: reconnect and resume.
    Broken(NearError),
}

fn wipe_key(sh: &Shared) {
    sh.xfer_released.store(false, Ordering::SeqCst);
    *sh.xfer_key.lock().unwrap() = None; // Zeroizing wipes on drop
}

impl Ctx {
    fn wipe_xfer_key(&self) {
        wipe_key(&self.sh);
    }

    /// A fresh single-use token for one attempt, linked to the session's cancel (a pause or a user cancel ends the attempt).
    fn attempt_token(&self) -> (CancelToken, tokio::task::JoinHandle<()>) {
        let tok = CancelToken::new();
        *self.sh.tok.lock().unwrap() = Some(tok.clone());
        let (t2, sess) = (tok.clone(), self.cancel.clone());
        let link = tokio::spawn(async move {
            tokio::select! {
                _ = sess.cancelled() => t2.cancel(),
                _ = t2.cancelled() => {}
            }
        });
        (tok, link)
    }

    fn classify<T>(&self, r: Result<T, NearError>) -> Result<Attempt<T>, Stop> {
        match r {
            Ok(v) => Ok(Attempt::Done(v)),
            Err(e) if self.env.stop.is_pause(&e) => Ok(Attempt::Paused),
            Err(e) if self.env.stop.is_peer_pause(&e) => Ok(Attempt::PeerPaused),
            Err(NearError::Cancelled) => Err(Stop::Cancelled),
            Err(e) => Ok(Attempt::Broken(e)),
        }
    }

    fn set_transfer_flags(&self, paused: bool, by: Option<&'static str>, interrupted: bool) {
        // contract 11.9: the paused flag is persisted on BOTH sides (a sender and a receiver paused by its peer alike)
        super::parts::persist_pause(&self.env.profile, if paused { by } else { None });
        let to = if paused || interrupted { NearState::TransferPaused } else { NearState::Transferring };
        self.go(to, |s| {
            if let Some(t) = &mut s.transfer {
                t.paused = paused;
                t.paused_by = by;
                t.interrupted = interrupted;
            }
        });
    }

    /// This side paused: wait for `resume` (or the session ending). The connection is already closed.
    async fn wait_resume(&self) -> Result<(), Stop> {
        self.set_transfer_flags(true, Some("me"), false);
        let deadline = tokio::time::Instant::now() + self.env.timing.pause_cap;
        loop {
            let notified = self.sh.resume.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self.sh.paused.load(Ordering::SeqCst) {
                break;
            }
            if self.cx(tokio::time::timeout_at(deadline, notified)).await?.is_err() {
                return Err(Stop::Failed("timeout".into(), "paused too long".into()));
            }
        }
        self.set_transfer_flags(false, None, false);
        Ok(())
    }

    async fn do_send(&self, auth: &NearAuth, lan: &mut LanLink, path: PathBuf) -> Result<(), Stop> {
        let dev = auth.device_id.clone();
        let key = self.sh.xfer_key.lock().unwrap().clone();
        let mut src = self.blocking(move || FilePartsSource::open_keyed(&path, &dev, PART_BYTES, key.as_deref())).await?.map_err(|e| Stop::Failed("source".into(), e.to_string()))?;
        let total = cl_near::transfer::RecordSource::manifest(&src).total_bytes;
        let nrec = cl_near::transfer::RecordSource::manifest(&src).record_count;
        let attempt = Arc::new(AtomicU64::new(1));
        self.go(NearState::Transferring, |s| s.transfer = Some(NearTransfer { direction: "send", bytes_done: 0, bytes_total: total, records_done: 0, records_total: nrec, attempt: 1, paused: false, paused_by: None, interrupted: false }));
        let mut started = Instant::now();
        let mut peer_paused = false;
        let mut peer_since = Instant::now();
        loop {
            if self.sh.paused.load(Ordering::SeqCst) {
                self.wait_resume().await?;
            }
            let conn = match lan.next_conn(&self.env, Duration::from_secs(20)).await {
                Ok(c) => c,
                Err(e) => {
                    if self.cancel.is_cancelled() {
                        return Err(Stop::Cancelled);
                    }
                    if !peer_paused && started.elapsed() > self.env.timing.transfer_giveup {
                        return Err(Stop::Failed("transfer_unreachable".into(), e.to_string()));
                    }
                    if peer_paused {
                        if peer_since.elapsed() > self.env.timing.pause_cap {
                            return Err(Stop::Failed("timeout".into(), "paused too long".into()));
                        }
                        self.set_transfer_flags(true, Some("peer"), false); // still waiting for the peer to resume
                        continue;
                    }
                    self.interrupted(&attempt, "send", total, nrec).await?;
                    continue;
                }
            };
            if peer_paused {
                peer_paused = false;
                started = Instant::now();
                self.set_transfer_flags(false, None, false);
            }
            let proof = conn.proof();
            let (tok, link) = self.attempt_token();
            let opts = TransferOpts { progress: Some(progress_hook(self, "send", attempt.clone())), cancel: tok, ..Default::default() };
            let r = run_sender(Conn::new(conn.stream, ConnConfig::default()), &proof, &mut src, &opts).await;
            link.abort();
            if self.sh.paused.load(Ordering::SeqCst) && !self.cancel.is_cancelled() && matches!(r, Err(NearError::Cancelled) | Err(NearError::Io(_)) | Err(NearError::Timeout(_))) {
                // our pause raced the attempt's own end: still a pause
                attempt.fetch_add(1, Ordering::SeqCst);
                continue;
            }
            match self.classify(r)? {
                Attempt::Done(_) => {
                    self.wipe_xfer_key(); // the sender needs the key only to have sealed the container
                    self.go(NearState::Done, |_| {});
                    return Ok(());
                }
                Attempt::Paused => {
                    attempt.fetch_add(1, Ordering::SeqCst);
                    continue; // the top of the loop waits for resume
                }
                Attempt::PeerPaused => {
                    peer_paused = true;
                    peer_since = Instant::now();
                    attempt.fetch_add(1, Ordering::SeqCst);
                    self.set_transfer_flags(true, Some("peer"), false);
                }
                Attempt::Broken(NearError::PeerAbort(r)) if r == "hash_mismatch" || r == "storage" => return Err(Stop::Failed(format!("peer_{r}"), "the other device could not store the history".into())),
                Attempt::Broken(e) => {
                    crate::nlog!("near: send attempt failed: {e}");
                    if started.elapsed() > self.env.timing.transfer_giveup {
                        return Err(Stop::Failed("transfer_failed".into(), e.to_string()));
                    }
                    self.interrupted(&attempt, "send", total, nrec).await?;
                }
            }
        }
    }

    async fn interrupted(&self, attempt: &Arc<AtomicU64>, dir: &'static str, total: u64, nrec: u32) -> Result<(), Stop> {
        let a = attempt.fetch_add(1, Ordering::SeqCst) as u32 + 1;
        let prev = self.snap().transfer;
        self.go(NearState::TransferPaused, |s| {
            let mut t = prev.unwrap_or(NearTransfer { direction: dir, bytes_done: 0, bytes_total: total, records_done: 0, records_total: nrec, attempt: a, paused: false, paused_by: None, interrupted: true });
            t.attempt = a;
            t.interrupted = true;
            t.paused = false;
            t.paused_by = None;
            s.transfer = Some(t);
        });
        self.cx(tokio::time::sleep(Duration::from_millis(500))).await?;
        self.set_transfer_flags(false, None, false);
        Ok(())
    }

    /// What a receive that stopped before `done` still holds, for the "Keep what arrived" screen.
    fn note_partial(&self, dir: &std::path::Path) {
        let mut store = FileStore::new(dir.join("progress.json"));
        if let Ok(Some(p)) = store.load() {
            let held: Vec<u32> = p.received.iter().copied().filter(|i| dir.join("parts").join(format!("{i}.rec")).exists()).collect();
            let bytes: u64 = held.iter().filter_map(|i| p.manifest.records.get(*i as usize)).map(|m| m.bytes).sum();
            let (h, t) = (held.len() as u32, p.manifest.record_count);
            self.go(self.state(), |s| s.partial = Some(NearPartial { records_held: h, records_total: t, bytes_held: bytes }));
        }
    }

    async fn do_receive(&self, lan: &mut LanLink, link_id: &str) -> Result<(), Stop> {
        let dir = super::parts::recv_dir(&self.env.profile).join(link_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect::<String>());
        *self.sh.recv_dir.lock().unwrap() = Some(dir.clone());
        let r = self.receive_inner(lan, &dir).await;
        match &r {
            Ok(()) => {}
            // stopped before `done`: what arrived stays on disk (verified parts) until kept or discarded
            Err(_) => self.note_partial(&dir),
        }
        r
    }

    async fn receive_inner(&self, lan: &mut LanLink, dir: &std::path::Path) -> Result<(), Stop> {
        let parts = dir.join("parts");
        let mut sink = FileRecordSink::new(&parts).map_err(|e| Stop::Failed("storage".into(), e.to_string()))?;
        // L5: where the OS has no portable free-space query the host injects one (Windows: GetDiskFreeSpaceExW); unix uses statvfs itself
        if let Some(probe) = crate::util::free_space_probe(&parts) {
            sink = sink.with_free_space_probe(probe);
        }
        let mut store = FileStore::new(dir.join("progress.json"));
        let attempt = Arc::new(AtomicU64::new(1));
        self.go(NearState::Transferring, |s| s.transfer = Some(NearTransfer { direction: "receive", bytes_done: 0, bytes_total: 0, records_done: 0, records_total: 0, attempt: 1, paused: false, paused_by: None, interrupted: false }));
        let mut started = Instant::now();
        let mut peer_paused = false;
        let mut peer_since = Instant::now();
        loop {
            if self.sh.paused.load(Ordering::SeqCst) {
                self.wait_resume().await?;
            }
            let conn = match lan.next_conn(&self.env, Duration::from_secs(20)).await {
                Ok(c) => c,
                Err(e) => {
                    if self.cancel.is_cancelled() {
                        return Err(Stop::Cancelled);
                    }
                    if !peer_paused && started.elapsed() > self.env.timing.transfer_giveup {
                        return Err(Stop::Failed("transfer_unreachable".into(), e.to_string()));
                    }
                    if peer_paused {
                        if peer_since.elapsed() > self.env.timing.pause_cap {
                            return Err(Stop::Failed("timeout".into(), "paused too long".into()));
                        }
                        self.set_transfer_flags(true, Some("peer"), false);
                        continue;
                    }
                    self.interrupted(&attempt, "receive", 0, 0).await?;
                    continue;
                }
            };
            if peer_paused {
                peer_paused = false;
                started = Instant::now();
                self.set_transfer_flags(false, None, false);
            }
            let proof = conn.proof();
            let (tok, link) = self.attempt_token();
            let opts = TransferOpts { progress: Some(progress_hook(self, "receive", attempt.clone())), cancel: tok, ..Default::default() };
            let r = run_receiver(Conn::new(conn.stream, ConnConfig::default()), &proof, &mut sink, &mut store, &opts).await;
            link.abort();
            if self.sh.paused.load(Ordering::SeqCst) && !self.cancel.is_cancelled() && matches!(r, Err(NearError::Cancelled) | Err(NearError::Io(_)) | Err(NearError::Timeout(_))) {
                attempt.fetch_add(1, Ordering::SeqCst);
                continue;
            }
            match self.classify(r)? {
                Attempt::Done(sum) if sum.complete => break,
                Attempt::Done(_) => return Err(Stop::Failed("incomplete".into(), "the sender ended early".into())),
                Attempt::Paused => {
                    attempt.fetch_add(1, Ordering::SeqCst);
                    continue;
                }
                Attempt::PeerPaused => {
                    peer_paused = true;
                    peer_since = Instant::now();
                    attempt.fetch_add(1, Ordering::SeqCst);
                    self.set_transfer_flags(true, Some("peer"), false);
                }
                Attempt::Broken(NearError::HashMismatch(_) | NearError::ManifestChanged | NearError::Storage(_)) => return Err(Stop::Failed("transfer_integrity".into(), "a part did not verify".into())),
                Attempt::Broken(e) => {
                    crate::nlog!("near: receive attempt failed: {e}");
                    if started.elapsed() > self.env.timing.transfer_giveup {
                        return Err(Stop::Failed("transfer_failed".into(), e.to_string()));
                    }
                    self.interrupted(&attempt, "receive", 0, 0).await?;
                }
            }
        }
        let link_id: String = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let manifest = store.load().ok().flatten().map(|p| p.manifest).ok_or_else(|| Stop::Failed("storage".into(), "no progress record".into()))?;
        std::fs::create_dir_all(&self.env.staging_dir).map_err(|e| Stop::Failed("storage".into(), e.to_string()))?;
        let out = self.env.staging_dir.join(format!("near-received-{}.container", link_id.chars().take(24).collect::<String>()));
        let (p2, o2) = (parts.clone(), out.clone());
        let size = self.blocking(move || assemble(&p2, &manifest, &o2)).await?.map_err(|e| Stop::Failed("assemble".into(), e.to_string()))?;
        let _ = std::fs::remove_dir_all(dir);
        *self.sh.recv_dir.lock().unwrap() = None;
        *self.sh.result.lock().unwrap() = Some(Received { path: out, size });
        self.go(NearState::Done, |_| {});
        Ok(())
    }
}

// ---- own-device transfer (contract section 7) ----------------------------------------------------------------------------

impl Ctx {
    /// The device that ASKED for the history (the receiver, side N): offer, wait for the other person's answer, prove proximity
    /// on the local network only, then receive.
    async fn own_receiver_main(&self, target: String, my_device: String, rx: &mut mpsc::UnboundedReceiver<Cmd>) -> Result<(), Stop> {
        self.go(NearState::CreatingSession, |s| s.role = Some("own_receiver"));
        let (en_priv, en_pub) = keys::generate_keypair();
        let nonce = super::own::random16();
        let (at, mut ar) = mpsc::unbounded_channel::<super::own::Answer>();
        let (mt, mr) = mpsc::unbounded_channel();
        *self.sh.own.lock().unwrap() = Some(super::own::OwnRoute { nonce, peer_device: target.clone(), answer: at, msgs: mt });
        *self.sh.undecided.lock().unwrap() = Some(Undecided::Asking);
        self.env.own_send.send(&target, super::own::offer_content(&en_pub, &nonce, now_ms()));
        self.go(NearState::AwaitingApproval, |s| s.peer = Some(NearPeer { label: "Your other device".into(), platform: None, label_sealed: false, identity_key: None }));
        let ans = tokio::select! {
            _ = self.cancel.cancelled() => return Err(Stop::Cancelled),
            a = tokio::time::timeout(self.env.own_answer, ar.recv()) => match a { Ok(Some(a)) => a, _ => return Err(Stop::Expired("own_no_answer".into())) },
        };
        *self.sh.undecided.lock().unwrap() = None;
        if ans.declined {
            // `busy`: the other device's ENGINE declined because it is in another session (revision 2); otherwise its person said not now
            return Err(Stop::Refused(NearRefusal { ble: "skipped", lan: "skipped" }, if ans.busy { "busy" } else { "denied" }.into()));
        }
        let Some(ea_pub) = ans.e_pub else { return Err(Stop::Failed("bad_answer".into(), "the answer carried no key".into())) };
        let link_id = super::own::link_id_for(&my_device);
        let skeys = keys::session_keys(&en_priv, &ea_pub, &nonce, &link_id).map_err(|e| Stop::Failed("keys".into(), e.to_string()))?;
        let mut pipe = super::own::OwnPipe::new(Side::N, &my_device, nonce, &target, skeys, self.env.own_send.clone(), mr);
        let who = self.my_who(None);
        let r = self.own_receiver_run(&mut pipe, &who, &link_id, rx).await;
        if let Err(stop) = &r {
            if let Some(m) = abort_for(stop) {
                let _ = tokio::time::timeout(Duration::from_secs(3), Pipe::send(&mut pipe, &m)).await;
            }
        }
        *self.sh.own.lock().unwrap() = None;
        r
    }

    async fn own_receiver_run(&self, pipe: &mut super::own::OwnPipe, who: &Who, link_id: &str, rx: &mut mpsc::UnboundedReceiver<Cmd>) -> Result<(), Stop> {
        let res = self.proximity(pipe, Side::N, who, false).await?;
        let Some(mut lan) = res.lan else {
            // no local-network path: the sender (A) says so with the causes; if it does not, this side's own view
            let mut stash = VecDeque::new();
            return match self.expect(pipe, &mut stash, self.env.timing.peer_step, &res.refusal, |_| false).await {
                Err(Stop::Failed(c, _)) if c == "near_error" => Err(Stop::Refused(res.refusal, "no_proximity".into())),
                Err(stop) => Err(stop),
                Ok(_) => Err(Stop::Refused(res.refusal, "no_proximity".into())),
            };
        };
        self.go(NearState::AwaitingApproval, |s| s.refusal = Some(res.refusal));
        self.sh.xfer_released.store(true, Ordering::SeqCst);
        self.go(NearState::Approved, |_| {});
        // like the sign-in flow, the page starts the receive when it is ready (the sender is still sealing its container)
        loop {
            tokio::select! {
                _ = self.cancel.cancelled() => return Err(Stop::Cancelled),
                cmd = rx.recv() => match cmd {
                    None => return Err(Stop::Cancelled),
                    Some(Cmd::Receive(reply)) => {
                        let _ = reply.send(Ok(()));
                        return self.do_receive(&mut lan, link_id).await;
                    }
                    Some(Cmd::Approve(r)) => { let _ = r.send(ApproveOutcome::Failed("wrong_role", "this device asked for the history".into())); }
                    Some(Cmd::Refuse(r)) => { let _ = r.send(()); return Err(Stop::Cancelled); }
                    Some(Cmd::Send(_, r)) => { let _ = r.send(Err("this device is the receiver".into())); }
                }
            }
        }
    }

    /// The device that HOLDS the history (the sender, side A): ask the person first (the gate), then answer, then prove
    /// proximity on the local network only and send what the page hands over.
    async fn own_sender_main(&self, offer: super::own::PendingOffer, label: String, rx: &mut mpsc::UnboundedReceiver<Cmd>) -> Result<(), Stop> {
        self.go(NearState::CreatingSession, |s| s.role = Some("own_sender"));
        self.go(NearState::AwaitingApproval, |s| s.peer = Some(NearPeer { label: clean_label(&label), platform: None, label_sealed: false, identity_key: None }));
        let mr = {
            let (mt, mr) = mpsc::unbounded_channel();
            let (at, _ar) = mpsc::unbounded_channel();
            *self.sh.own.lock().unwrap() = Some(super::own::OwnRoute { nonce: offer.nonce, peer_device: offer.from_device.clone(), answer: at, msgs: mt });
            mr
        };
        let end = tokio::time::Instant::now() + self.env.own_answer;
        *self.sh.undecided.lock().unwrap() = Some(Undecided::Sheet(offer.from_device.clone()));
        // the person decides first (biometric), THEN the answer goes out (the phone core's order)
        loop {
            tokio::select! {
                _ = self.cancel.cancelled() => return Err(Stop::Cancelled),
                _ = tokio::time::sleep_until(end) => return Err(Stop::Expired("own_no_decision".into())),
                cmd = rx.recv() => match cmd {
                    None => return Err(Stop::Cancelled),
                    Some(Cmd::Approve(reply)) => {
                        {
                            // the person pressed Send: from here on a re-ask no longer replaces this session. Checked under the same
                            // lock `own_deliver` replaces under, so a replacement that already cancelled this session wins cleanly.
                            let mut u = self.sh.undecided.lock().unwrap();
                            if self.cancel.is_cancelled() {
                                let _ = reply.send(ApproveOutcome::Cancelled(self.last_gate()));
                                return Err(Stop::Cancelled);
                            }
                            *u = None;
                        }
                        self.go(NearState::Approving, |_| {});
                        let who = clean_label(&label);
                        let gate: Arc<dyn ApprovalGate> = self.env.gate.clone();
                        let (title, detail) = ("Send your chat history?".to_owned(), format!("\"{who}\" is asking for your chat history over the local network.\n\nApprove only if you started this on that device just now."));
                        let (_, verdict) = self.blocking(move || run_gate(gate.as_ref(), &title, &detail)).await?;
                        let gate_name = self.last_gate();
                        if verdict != Verification::Verified {
                            *self.sh.undecided.lock().unwrap() = Some(Undecided::Sheet(offer.from_device.clone()));
                            self.go(NearState::AwaitingApproval, |_| {});
                            let _ = reply.send(if verdict == Verification::Cancelled { ApproveOutcome::Cancelled(gate_name) } else { ApproveOutcome::Failed(gate_name, "the confirmation failed".into()) });
                            continue;
                        }
                        let (ea_priv, ea_pub) = keys::generate_keypair();
                        let link_id = super::own::link_id_for(&offer.from_device);
                        let skeys = keys::session_keys(&ea_priv, &offer.e_pub, &offer.nonce, &link_id).map_err(|e| Stop::Failed("keys".into(), e.to_string()))?;
                        self.env.own_send.send(&offer.from_device, super::own::answer_content(&offer.nonce, Some(&ea_pub)));
                        self.sh.xfer_released.store(true, Ordering::SeqCst);
                        self.go(NearState::Approved, |_| {});
                        let _ = reply.send(ApproveOutcome::Approved(gate_name));
                        let mut pipe = super::own::OwnPipe::new(Side::A, &offer.from_device, offer.nonce, &offer.from_device, skeys, self.env.own_send.clone(), mr);
                        let who = self.my_who(None);
                        let r = self.own_sender_run(&mut pipe, &who, rx).await;
                        if let Err(stop) = &r {
                            if let Some(m) = abort_for(stop) {
                                let _ = tokio::time::timeout(Duration::from_secs(3), Pipe::send(&mut pipe, &m)).await;
                            }
                        }
                        *self.sh.own.lock().unwrap() = None;
                        return r;
                    }
                    Some(Cmd::Refuse(reply)) => {
                        self.env.own_send.send(&offer.from_device, super::own::answer_content(&offer.nonce, None));
                        self.sh.cooldown.lock().unwrap().record_decline(&offer.from_device, now_ms());
                        let _ = reply.send(());
                        *self.sh.own.lock().unwrap() = None;
                        return Err(Stop::Declined);
                    }
                    Some(Cmd::Send(_, r)) => { let _ = r.send(Err("approve first".into())); }
                    Some(Cmd::Receive(r)) => { let _ = r.send(Err("this device is the sender".into())); }
                }
            }
        }
    }

    async fn own_sender_run(&self, pipe: &mut super::own::OwnPipe, who: &Who, rx: &mut mpsc::UnboundedReceiver<Cmd>) -> Result<(), Stop> {
        let res = self.proximity(pipe, Side::A, who, false).await?;
        let Some(verified) = res.verified else {
            let _ = Pipe::send(pipe, &Message::abort_no_proximity(res.refusal.ble, res.refusal.lan)).await;
            return Err(Stop::Refused(res.refusal, "no_proximity".into()));
        };
        let Some(mut lan) = res.lan else { return Err(Stop::Refused(res.refusal, "no_proximity".into())) };
        let method = verified.approval.method();
        self.go(NearState::ProofVerified, |s| s.proximity = Some(method.as_str_static()));
        self.go(NearState::Approved, |_| {});
        // the page now seals the container under K_xfer and hands over the file
        loop {
            tokio::select! {
                _ = self.cancel.cancelled() => return Err(Stop::Cancelled),
                cmd = rx.recv() => match cmd {
                    None => return Err(Stop::Cancelled),
                    Some(Cmd::Send(path, reply)) => match (self.env.resolve_path)(&path) {
                        Err(e) => { let _ = reply.send(Err(e)); }
                        Ok(p) => { let _ = reply.send(Ok(())); return self.do_send(&NearAuth { access_token: String::new(), user_id: String::new(), device_id: "own".into() }, &mut lan, p).await; }
                    },
                    Some(Cmd::Approve(r)) => { let _ = r.send(ApproveOutcome::Failed("not_awaiting_approval", "already approved".into())); }
                    Some(Cmd::Refuse(r)) => { let _ = r.send(()); return Err(Stop::Declined); }
                    Some(Cmd::Receive(r)) => { let _ = r.send(Err("this device is the sender".into())); }
                }
            }
        }
    }
}

// ---- the engine --------------------------------------------------------------------------------------------

pub struct NearEngine {
    env: Arc<NearEnv>,
    rt: tokio::runtime::Runtime,
    sh: Arc<Shared>,
}

impl NearEngine {
    pub fn new(env: NearEnv) -> Self {
        let env = Arc::new(env);
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_name("near").enable_all().build().expect("near runtime");
        // a process start has no session, so no `K_xfer`: whatever a previous run spooled can never be opened (contract 11.15)
        let stale = super::parts::purge_stale(&env.profile, &env.staging_dir, None);
        if stale > 0 {
            crate::nlog!("near: discarded {stale} stale transfer file(s) left by an earlier run");
        }
        let sh = Arc::new(Shared { m: Mutex::new(Machine::new()), sess: Mutex::new(None), result: Mutex::new(None), paused: AtomicBool::new(false), tok: Mutex::new(None), resume: tokio::sync::Notify::new(), recv_dir: Mutex::new(None), xfer_key: Mutex::new(None), xfer_released: AtomicBool::new(false), local_net: Mutex::new(LocalNetwork::Unknown), own: Mutex::new(None), shown: Mutex::new(None), cooldown: Mutex::new(Default::default()), undecided: Mutex::new(None), seen_offers: Mutex::new(VecDeque::new()) });
        Self { env, rt, sh }
    }

    pub fn snapshot(&self) -> NearSnapshot {
        self.sh.m.lock().unwrap().snapshot().clone()
    }

    /// What the shell knows about local-network access (`granted` | `denied` | `firewall` | `unknown`), like the phone core's
    /// `near_set_local_network`: a local-network leg that then fails is reported as that cause instead of `not_found`, on both refusal screens.
    pub fn set_local_network(&self, state: &str) {
        *self.sh.local_net.lock().unwrap() = LocalNetwork::parse(state);
    }

    fn begin<F, Fut>(&self, f: F) -> Result<NearSnapshot, String>
    where
        F: FnOnce(Ctx, mpsc::UnboundedReceiver<Cmd>) -> Fut,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let mut sess = self.sh.sess.lock().unwrap();
        {
            let st = self.sh.m.lock().unwrap().snapshot().state;
            if !st.is_terminal() && st != NearState::Idle {
                return Err("a near session is already running".into());
            }
        }
        if let Some(old) = sess.take() {
            old.cancel.cancel();
        }
        // A new sign-in session has a new `K_xfer`: the previous session's spool (and an unimported received container) is unreadable
        // now, so it is discarded cleanly instead of being "resumed" into garbage. "Keep what arrived" is for the session that
        // just stopped and must be used before the next one starts.
        *self.sh.recv_dir.lock().unwrap() = None;
        let keep = self.sh.result.lock().unwrap().as_ref().map(|r| r.path.clone());
        let stale = super::parts::purge_stale(&self.env.profile, &self.env.staging_dir, keep.as_deref());
        if stale > 0 {
            crate::nlog!("near: discarded {stale} stale transfer file(s) from the previous session");
        }
        *self.sh.result.lock().unwrap() = None;
        self.sh.paused.store(false, Ordering::SeqCst);
        *self.sh.tok.lock().unwrap() = None;
        self.wipe_xfer_key();
        let (tx, rx) = mpsc::unbounded_channel();
        let cancel = CancelToken::new();
        let ctx = Ctx { env: self.env.clone(), sh: self.sh.clone(), cancel: cancel.clone() };
        // back to idle (terminal -> idle is legal), then the flow takes it from there
        ctx.go(NearState::Idle, |_| {});
        *sess = Some(Sess { cancel, cmd: tx });
        let snap = self.snapshot();
        self.rt.spawn(f(ctx, rx));
        Ok(snap)
    }

    fn start_with<F, Fut>(&self, flow: F) -> Result<NearSnapshot, String>
    where
        F: FnOnce(Ctx, mpsc::UnboundedReceiver<Cmd>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<(), Stop>> + Send + 'static,
    {
        self.begin(|ctx, rx| async move {
            let c2 = ctx.clone();
            if let Err(stop) = flow(ctx, rx).await {
                c2.finish(stop);
            }
        })
    }


    /// Own-device transfer, REQUESTER (receiver): ask `target_device`, another device of this account, for its history.
    pub fn own_request(&self, target_device: String, my_device: String) -> Result<NearSnapshot, String> {
        self.start_with(move |c, mut rx| async move { c.own_receiver_main(target_device, my_device, &mut rx).await })
    }

    /// An own-device control message arrived (the page verified its author is another device of THIS account and handed it
    /// over with `my_device` = this device). Offers start the approval sheet; answers and relay messages go to the running
    /// session. Everything else is ignored. `label` names the asking device for the sheet (the page's device list).
    pub fn own_deliver(&self, content: serde_json::Value, from_device: &str, my_device: &str, label: &str) -> &'static str {
        use super::own::{classify, Delivered};
        let d = {
            let route = self.sh.own.lock().unwrap();
            classify(&content, my_device, from_device, now_ms(), route.as_ref())
        };
        match d {
            Delivered::Routed => "routed",
            Delivered::Ignored => "ignored",
            Delivered::Offer(offer) => {
                // a device whose offers keep being declined is ignored for a while: no sheet, no answer (L3)
                if self.sh.cooldown.lock().unwrap().muted(from_device, now_ms()) {
                    return "ignored";
                }
                // the same offer handed over twice (a re-pulled envelope) opens one sheet and is answered once: a second answer
                // (it used to be a "busy" decline) would end the request the asker is still waiting on
                {
                    let mut seen = self.sh.seen_offers.lock().unwrap();
                    if seen.contains(&offer.nonce) {
                        return "ignored";
                    }
                    seen.push_back(offer.nonce);
                    while seen.len() > SEEN_OFFERS {
                        seen.pop_front();
                    }
                }
                let nonce = offer.nonce;
                let busy = { let st = self.sh.m.lock().unwrap().snapshot().state; !st.is_terminal() && st != NearState::Idle };
                let mut replaced = false;
                if busy {
                    // "The PC said no" (2026-11-25): a sheet nobody has acted on yet that the SAME device asked for is abandoned the
                    // moment that device asks again (its core runs one request at a time and has moved on to the new nonce), and this
                    // device's own unanswered request gives way to an incoming one (the phone core's B4 rule). Both are replaced. Every
                    // other session (another device's sheet, the person approving, a transfer, a sign-in) is not interrupted: the asker
                    // is told "busy", not left waiting for nothing.
                    if !self.yield_undecided_to(from_device) {
                        self.env.own_send.send(from_device, super::own::answer_busy(&nonce));
                        return "busy";
                    }
                    replaced = true;
                }
                let label = label.to_owned();
                match self.start_with(move |c, mut rx| async move { c.own_sender_main(offer, label, &mut rx).await }) {
                    Ok(_) if replaced => "replaced",
                    Ok(_) => "offer",
                    Err(_) => {
                        self.env.own_send.send(from_device, super::own::answer_busy(&nonce));
                        "busy"
                    }
                }
            }
        }
    }

    /// Cancel the running session if it is one a new offer from `from_device` may replace (see [`Undecided`]) and wait (bounded)
    /// until it has ended. `false` = not replaceable, or it did not end in time: the caller answers "busy".
    fn yield_undecided_to(&self, from_device: &str) -> bool {
        {
            let u = self.sh.undecided.lock().unwrap();
            let replaceable = match u.as_ref() {
                Some(Undecided::Sheet(d)) => d == from_device,
                Some(Undecided::Asking) => true,
                None => false,
            };
            if !replaceable {
                return false;
            }
            // cancelled under the lock the Approve branch checks: either the person's Send already cleared `undecided` (then we
            // returned above) or that branch will see the cancellation and stop without answering
            if let Some(s) = self.sh.sess.lock().unwrap().as_ref() {
                s.cancel.cancel();
            }
        }
        // an undecided session is parked in a select on its cancel token, so it ends at once; the bound is only a safety net
        let end = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let st = self.sh.m.lock().unwrap().snapshot().state;
            if st.is_terminal() || st == NearState::Idle {
                return true;
            }
            if std::time::Instant::now() >= end {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// NEW device: create a near session and show the rotating code.
    pub fn show_start(&self, api_base: String, typed: bool, label: Option<String>) -> Result<NearSnapshot, String> {
        self.start_with(move |c, mut rx| async move { c.new_device_main(api_base, typed, label, &mut rx).await })
    }
    /// Signed-in desktop approves a scanned / typed code.
    pub fn approver_start(&self, api_base: String, auth: NearAuth, scan: ScanInput) -> Result<NearSnapshot, String> {
        self.start_with(move |c, mut rx| async move { c.approver_main(api_base, auth, scan, &mut rx).await })
    }
    /// Signed-in desktop shows an invite a phone scans.
    pub fn invite_start(&self, api_base: String, auth: NearAuth) -> Result<NearSnapshot, String> {
        self.start_with(move |c, mut rx| async move { c.invite_main(api_base, auth, &mut rx).await })
    }

    pub fn approve(&self) -> ApproveOutcome {
        let tx = self.sh.sess.lock().unwrap().as_ref().map(|s| s.cmd.clone());
        let Some(tx) = tx else { return ApproveOutcome::Failed("no_session", "no near session".into()) };
        let (rtx, rrx) = oneshot::channel();
        if tx.send(Cmd::Approve(rtx)).is_err() {
            return ApproveOutcome::Failed("no_session", "the session ended".into());
        }
        self.rt.block_on(rrx).unwrap_or(ApproveOutcome::Failed("no_session", "the session ended".into()))
    }
    pub fn refuse(&self) {
        let tx = self.sh.sess.lock().unwrap().as_ref().map(|s| s.cmd.clone());
        if let Some(tx) = tx {
            let (rtx, rrx) = oneshot::channel();
            if tx.send(Cmd::Refuse(rtx)).is_ok() {
                let _ = self.rt.block_on(rrx);
            }
        }
    }
    pub fn cancel(&self) {
        if let Some(s) = self.sh.sess.lock().unwrap().as_ref() {
            s.cancel.cancel();
        }
    }
    pub fn transfer_send(&self, path: String) -> Result<(), String> {
        let tx = self.sh.sess.lock().unwrap().as_ref().map(|s| s.cmd.clone()).ok_or("no near session")?;
        let (rtx, rrx) = oneshot::channel();
        tx.send(Cmd::Send(path, rtx)).map_err(|_| "the session ended".to_string())?;
        self.rt.block_on(rrx).map_err(|_| "the session ended".to_string())?
    }
    pub fn transfer_receive(&self) -> Result<(), String> {
        let tx = self.sh.sess.lock().unwrap().as_ref().map(|s| s.cmd.clone()).ok_or("no near session")?;
        let (rtx, rrx) = oneshot::channel();
        tx.send(Cmd::Receive(rtx)).map_err(|_| "the session ended".to_string())?;
        self.rt.block_on(rrx).map_err(|_| "the session ended".to_string())?
    }
    pub fn transfer_result(&self) -> Option<Received> {
        self.sh.result.lock().unwrap().clone()
    }
    pub fn transfer_discard(&self) {
        if let Some(r) = self.sh.result.lock().unwrap().take() {
            let _ = std::fs::remove_file(r.path);
        }
        // a stopped transfer's verified parts too
        if let Some(d) = self.sh.recv_dir.lock().unwrap().take() {
            let _ = std::fs::remove_dir_all(d);
        }
        self.wipe_xfer_key();
    }

    fn wipe_xfer_key(&self) {
        wipe_key(&self.sh);
    }

    /// `K_xfer` for the page (contract 11.15), only once THIS device is approved: the sender needs it to seal the container,
    /// the receiver to open what arrived. The page zeroes its copy when it is done; the host's copy goes with
    /// `transfer_discard`, the next session, or the engine.
    pub fn transfer_key(&self) -> Result<Zeroizing<[u8; 32]>, String> {
        if !self.sh.xfer_released.load(Ordering::SeqCst) {
            return Err("the transfer key is released only after this device is approved".into());
        }
        self.sh.xfer_key.lock().unwrap().clone().ok_or_else(|| "no transfer key".to_string())
    }

    /// Does the shared crate carry the pause frame (so `nearTransferPause` / `nearTransferResume` mean something)?
    pub fn pause_supported(&self) -> bool {
        self.env.stop.supported()
    }

    /// Pause the running transfer: the connection closes after `abort { paused }`; resuming reconnects on the normal
    /// `want` path. Only while a transfer is actually running.
    pub fn transfer_pause(&self) -> Result<(), String> {
        if !self.env.stop.supported() {
            return Err("pausing is not supported by this build".into());
        }
        let st = self.snapshot().state;
        if !matches!(st, NearState::Transferring | NearState::TransferPaused) {
            return Err("no transfer is running".into());
        }
        self.sh.paused.store(true, Ordering::SeqCst);
        if let Some(t) = self.sh.tok.lock().unwrap().clone() {
            self.env.stop.pause(&t);
        }
        Ok(())
    }
    pub fn transfer_resume(&self) -> Result<(), String> {
        if !self.sh.paused.swap(false, Ordering::SeqCst) {
            return Err("the transfer is not paused".into());
        }
        self.sh.resume.notify_waiters();
        Ok(())
    }

    /// "Keep what arrived": for a receive that stopped before `done`, write a file of the full container size with every
    /// verified part in place and report which byte ranges are real. The page applies only the records inside them.
    pub fn transfer_keep_partial(&self) -> Result<(PathBuf, super::parts::PartialFile), String> {
        let st = self.snapshot().state;
        if !st.is_terminal() || st == NearState::Done {
            return Err("only a stopped transfer can be kept".into());
        }
        let dir = self.sh.recv_dir.lock().unwrap().clone().ok_or("nothing arrived")?;
        let mut store = FileStore::new(dir.join("progress.json"));
        let p = store.load().map_err(|e| e.to_string())?.ok_or("nothing arrived")?;
        std::fs::create_dir_all(&self.env.staging_dir).map_err(|e| e.to_string())?;
        let name: String = dir.file_name().map(|n| n.to_string_lossy().chars().take(24).collect()).unwrap_or_default();
        let out = self.env.staging_dir.join(format!("near-partial-{name}.container"));
        let pf = super::parts::assemble_partial(&dir.join("parts"), &p.manifest, &p.received, &out).map_err(|e| e.to_string())?;
        if pf.parts_held == 0 {
            let _ = std::fs::remove_file(&out);
            return Err("nothing arrived".into());
        }
        let _ = std::fs::remove_dir_all(&dir);
        *self.sh.recv_dir.lock().unwrap() = None;
        Ok((out, pf))
    }

    /// Adapter state within the 3 s cap and whether the local-network proof is possible at all.
    pub fn probe(&self) -> (AdapterState, bool, &'static str, &'static str) {
        let st = probe_adapter(&self.env.radio, self.env.scan_caps.adapter);
        let lan = !self.env.ifaces.interfaces().is_empty();
        let g = self.env.gate.availability();
        (st, lan, if g == Availability::Available { "available" } else { "unavailable" }, if g == Availability::Available { "hello" } else { self.env.gate.confirm_kind().bridge_name() })
    }
    pub fn biometric_availability(&self) -> Availability {
        self.env.gate.availability()
    }
    pub fn biometric_verify(&self, reason: &str) -> Verification {
        if self.env.gate.availability() != Availability::Available {
            return Verification::Failed;
        }
        self.env.gate.verify(reason)
    }
}

#[cfg(test)]
mod approval_policy_tests {
    use super::*;

    fn shown() -> ApprovalShown {
        ApprovalShown { link_id: "L".repeat(22), identity_key_b64: format!("{}=", "A".repeat(43)), proximity: Proximity::Ble }
    }
    fn msg(user: &str, dev: &str, link: &str, ik: &str, prox: &str, ts: &str) -> String {
        format!("cipherline-link-approve:v2:{user}:{dev}:{link}:{ik}:{prox}:{ts}")
    }

    #[test]
    fn only_the_exact_message_for_what_the_sheet_showed_is_signed() {
        let s = shown();
        let ok = msg("u1", "d1", &s.link_id, &s.identity_key_b64, "ble", "1795100000");
        assert!(approval_message_matches(&ok, "u1", "d1", &s));
        // another account / device / link / identity key / proximity, a v1 string, extra fields: each refused
        let other_key = format!("{}=", "B".repeat(43));
        for bad in [
            msg("u2", "d1", &s.link_id, &s.identity_key_b64, "ble", "1795100000"),
            msg("u1", "d2", &s.link_id, &s.identity_key_b64, "ble", "1795100000"),
            msg("u1", "d1", &"M".repeat(22), &s.identity_key_b64, "ble", "1795100000"),
            msg("u1", "d1", &s.link_id, &other_key, "ble", "1795100000"),
            msg("u1", "d1", &s.link_id, &s.identity_key_b64, "lan", "1795100000"),
            msg("u1", "d1", &s.link_id, &s.identity_key_b64, "ble", "17951x0000"),
            msg("u1", "d1", &s.link_id, &s.identity_key_b64, "ble", "1"),
            ok.replace(":v2:", ":v1:"),
            format!("{ok}:extra"),
            "cipherline-delete-account".to_owned(),
        ] {
            assert!(!approval_message_matches(&bad, "u1", "d1", &s), "{bad}");
        }
    }
}

#[cfg(test)]
mod blocked_tests {
    use super::*;
    #[test]
    fn only_a_refused_permission_reads_as_blocked_not_a_timeout_or_refusal() {
        assert!(io_blocked(&NearError::Io(std::io::Error::from(std::io::ErrorKind::PermissionDenied))));
        assert!(!io_blocked(&NearError::Io(std::io::Error::from(std::io::ErrorKind::ConnectionRefused))));
        assert!(!io_blocked(&NearError::Timeout("connect")));
        assert!(!io_blocked(&NearError::OffLink("x".into())));
    }
}
