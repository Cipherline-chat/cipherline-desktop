//! A scripted PHONE for the host's end-to-end tests: built from the vendored cl-near crate only (the same
//! protocol code a phone runs), against the fake link server. Runs in-process (unit tests) or as the
//! separate `near_peer` process (`examples/near_e2e.rs`). It needs cl-near's `dangerous-loopback`
//! (loopback is the only network two processes on one box share), which only dev-dependencies enable, so
//! this module cannot be part of a release build (see `fence.rs`).
//!
//! Roles: [`phone_new_device`] shows a code and waits for the host's hello (the host is the approver);
//! [`phone_approver`] scans the host's code (the host is the new device). Both honour the contract's
//! Bluetooth-first order: a phone ADVERTISES, so the advertisement goes out through [`PeerIo::advertise`]
//! (in tests that feeds the host's `FakeRadio`).
use super::api::{Auth, HttpRelay, LinkApi};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use cl_near::approval::link_approve_message_v2;
use cl_near::ble::{plan, Advertiser};
use cl_near::code::{build_near_compact, SecretRotor};
use cl_near::conn::{Conn, ConnConfig};
use cl_near::keys;
use cl_near::lan::{dial, LanConn, LanListener, LanPolicy, LanTimeouts};
use cl_near::onlink::{InterfaceProvider, LocalInterface, StaticInterfaces};
use cl_near::proof::ProximityProof;
use cl_near::relay::{Caps, Message, RelayPeer, Side};
use cl_near::testutil::{peak_rss_kb, FaultyStream};
use cl_near::transfer::{run_receiver, run_sender, FileRecordSink, FileStore, ReceiverStore, TransferOpts};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub trait PeerIo: Send + Sync {
    /// The code this phone shows (called again after every rotation).
    fn publish_code(&self, uri: &str);
    /// The code the host shows (blocks until known).
    fn wait_for_code(&self) -> String;
    /// The 128-bit service UUID the phone is now advertising.
    fn advertise(&self, uuid: [u8; 16]);
}

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct PhoneCfg {
    pub base: String,
    pub device_id: String,
    /// Ed25519 seed of the phone's identity key (approver role).
    pub seed_hex: String,
    /// Advertise over Bluetooth (the phone has a radio).
    pub ble: bool,
    /// Take part in the local-network proof (false = a phone that never answers on the LAN).
    pub lan: bool,
    /// Approver role: approve (true) or deny (false).
    pub approve: bool,
    /// Approver role: send this file after approving.
    pub send_file: Option<PathBuf>,
    /// New-device role: write the received container here.
    pub recv_out: Option<PathBuf>,
    /// Receiver: kill the first transfer connection after this many bytes.
    pub drop_after: Option<u64>,
    pub work_dir: PathBuf,
    pub timeout_s: u64,
    /// Approver role, when `approve` is false: how the refusal travels. `deny_http` (the server `deny`, the old path),
    /// `deny_relay` (only `abort { denied }` on the relay: what contract 11.16 requires the new device to hear),
    /// `deny_both`, or `cancel_relay` (`abort { cancelled }`). Empty = `deny_http`.
    #[serde(default)]
    pub decision: String,
    /// Approver role: hold the decision this long after the proof and the `awaiting_user` status (a "late" deny).
    #[serde(default)]
    pub hold_ms: u64,
    /// Label this phone calls itself in its sealed `caps` (empty = "Test Phone").
    #[serde(default)]
    pub label: String,
    /// Approver role: after approving, run no transfer but wait for the host (new device) to finish.
    #[serde(default)]
    pub skip_status: bool,
    /// Send `caps` WITHOUT the device `kind` (a non-conforming peer: the host must end the session).
    #[serde(default)]
    pub omit_kind: bool,
    /// Approver role: instead of sending `send_file`'s bytes, build a REAL transfer container under THIS session's `K_xfer` (cl-crypto's raw-key
    /// writer, with a split attachment) and send it in 1 KiB parts in the phone core's order. `send_file` only has to be `Some`.
    #[serde(default)]
    pub send_container: bool,
    /// New-device role, advertising: hear the host's `ble_heard` but never answer with `ble_ack` (a rogue advertiser, L1).
    #[serde(default)]
    pub no_ack: bool,
}

#[derive(Default, Serialize, Deserialize, Debug, Clone)]
#[serde(default)]
pub struct PhoneReport {
    pub role: String,
    pub proximity: Option<String>,
    pub granted: bool,
    pub denied: bool,
    pub refused: Option<String>,
    pub error: Option<String>,
    pub transfer_bytes: u64,
    pub transfer_sha256: Option<String>,
    pub attempts: u32,
    pub transfer_secs: f64,
    pub peak_rss_kb: u64,
    /// The label the host sent in its sealed `caps` (contract 11.2).
    pub peer_label: Option<String>,
    /// `status` messages seen from the host (approver role of the host), as `stage` or `stage:proximity`.
    pub statuses: Vec<String>,
    /// The host's `ble_result`: `ok` or its cause.
    pub ble_result: Option<String>,
    /// The `purpose: "transfer_probe"` `lan_result` this phone saw (`true` = ok).
    pub probe_result: Option<bool>,
    /// An `abort` this phone received: `reason` and the per-proof causes.
    pub abort: Option<String>,
    /// The phone's own view of how long its relay reads took to see an abort, unused unless set.
    pub refuse_sent_ms: Option<u64>,
}

/// Record what an informational or result message says in the report; true when it was one of those.
fn absorb(rep: &mut PhoneReport, m: &Message) -> bool {
    match m {
        Message::Status { stage, proximity } => {
            rep.statuses.push(match proximity { Some(p) => format!("{stage}:{p}"), None => stage.clone() });
            true
        }
        Message::BleResult { ok, cause } => {
            rep.ble_result = Some(if *ok { "ok".into() } else { cause.clone().unwrap_or_else(|| "failed".into()) });
            true
        }
        Message::LanResult { ok, purpose: Some(p), .. } if p == "transfer_probe" => {
            rep.probe_result = Some(*ok);
            true
        }
        _ => false,
    }
}

fn ifaces() -> Arc<dyn InterfaceProvider> {
    Arc::new(StaticInterfaces(vec![LocalInterface { index: 1, name: "test0".into(), addr: "10.255.0.2".parse().unwrap(), prefix_len: 24, kind: cl_near::onlink::IfaceKind::Virtual }]))
}
fn t(s: u64) -> Duration {
    Duration::from_secs(s)
}
fn lan_policy() -> LanPolicy {
    LanPolicy::DangerousAllowLoopback
}

pub fn signing_key(seed_hex: &str) -> SigningKey {
    let b: Vec<u8> = (0..seed_hex.len() / 2).map(|i| u8::from_str_radix(&seed_hex[2 * i..2 * i + 2], 16).unwrap()).collect();
    SigningKey::from_bytes(&b.try_into().expect("32-byte seed"))
}
pub fn identity_pub_b64(seed_hex: &str) -> String {
    B64.encode(signing_key(seed_hex).verifying_key().as_bytes())
}

enum Link {
    Listener(Arc<LanListener>),
    Dialer(cl_near::relay::LanOffer),
}

async fn next_conn(link: &Link, keys: &cl_near::keys::SessionKeys, link_id: &str, wait: Duration) -> Result<LanConn, String> {
    match link {
        Link::Listener(l) => l.accept(wait).await.map_err(|e| e.to_string()),
        Link::Dialer(o) => {
            let end = tokio::time::Instant::now() + wait;
            loop {
                match dial(o, keys, link_id, ifaces().as_ref(), lan_policy(), LanTimeouts::default()).await {
                    Ok(c) => return Ok(c),
                    Err(e) if tokio::time::Instant::now() >= end => return Err(e.to_string()),
                    Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
                }
            }
        }
    }
}

fn clone_keys(k: &cl_near::keys::SessionKeys) -> cl_near::keys::SessionKeys {
    cl_near::keys::SessionKeys { conf: k.conf.clone(), relay: k.relay.clone(), ble: k.ble.clone(), lan: k.lan.clone(), xfer: k.xfer.clone() }
}

fn phone_caps(cfg: &PhoneCfg) -> Caps {
    Caps { os: cl_near::relay::Os::Android, kind: cl_near::relay::DeviceKind::Phone, ble_adv: cfg.ble, ble_scan: false, lan_listen: cfg.lan, lan_dial: cfg.lan }
}
fn phone_caps_msg(cfg: &PhoneCfg) -> Message {
    let label = if cfg.label.is_empty() { "Test Phone" } else { cfg.label.as_str() };
    let mut m = Message::caps_full(&phone_caps(cfg), &cl_near::relay::Who { label: label.into(), platform: "android".into() });
    if cfg.omit_kind {
        if let Message::Caps { kind, .. } = &mut m {
            *kind = None;
        }
    }
    m
}

/// The phone shows the code, the host approves it.
pub async fn phone_new_device(cfg: PhoneCfg, io: Arc<dyn PeerIo>, skew: Arc<AtomicU64>) -> PhoneReport {
    let mut rep = PhoneReport { role: "phone_new_device".into(), ..Default::default() };
    if let Err(e) = phone_n_inner(&cfg, io, skew, &mut rep).await {
        rep.error = Some(e);
    }
    rep.peak_rss_kb = peak_rss_kb();
    rep
}

async fn phone_n_inner(cfg: &PhoneCfg, io: Arc<dyn PeerIo>, skew: Arc<AtomicU64>, rep: &mut PhoneReport) -> Result<(), String> {
    let now = || Instant::now() + Duration::from_millis(skew.load(Ordering::SeqCst));
    let api = LinkApi::new(&cfg.base, None, None, "9.9.9").map_err(|e| e.to_string())?;
    let (ek_priv, en_pub) = keys::generate_keypair();
    let token = Arc::new(crate::api::RelayToken::generate());
    let idk = identity_pub_b64(&cfg.seed_hex);
    let ik: [u8; 32] = B64.decode(&idk).ok().and_then(|v| v.try_into().ok()).ok_or("identity key")?;
    let created = {
        let (a, ek, idk2, rh) = (api.clone(), B64.encode(en_pub), idk.clone(), token.auth_hash_b64());
        tokio::task::spawn_blocking(move || a.create_near_session(&ek, "Test Phone", "android", &idk2, None, &rh)).await.unwrap().map_err(|e| e.to_string())?
    };
    let rotor = Arc::new(std::sync::Mutex::new(SecretRotor::new(now())));
    io.publish_code(&build_near_compact(&created.link_id, &en_pub, rotor.lock().unwrap().current()).unwrap());
    let (r2, link) = (rotor.clone(), created.link_id.clone());
    // rotation keeps running while we wait for hello
    let (io2, skew2, r3, l3) = (io.clone(), skew.clone(), rotor.clone(), created.link_id.clone());
    let ticker = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let n = Instant::now() + Duration::from_millis(skew2.load(Ordering::SeqCst));
            let rotated = r3.lock().unwrap().tick(n);
            if rotated {
                io2.publish_code(&build_near_compact(&l3, &en_pub, r3.lock().unwrap().current()).unwrap());
            }
        }
    });
    let http = HttpRelay::new(&api.with_relay_token(token), Side::N, &link);
    let mut peer = RelayPeer::new_device_accept(http, &link, &ek_priv, &ik, move || r2.lock().unwrap().candidates().into_iter().cloned().collect(), t(cfg.timeout_s)).await.map_err(|e| format!("hello: {e}"))?;
    ticker.abort();
    let k = clone_keys(peer.session().keys());
    // caps
    let a_caps = loop {
        match peer.recv(t(10)).await.map_err(|e| e.to_string())? {
            m @ Message::Caps { .. } => {
                rep.peer_label = m.who().map(|w| w.label);
                break m.caps_checked().map_err(|e| e.to_string())?;
            }
            m @ Message::Abort { .. } => {
                note_abort(rep, &m);
                return Ok(());
            }
            m => {
                absorb(rep, &m);
            }
        }
    };
    let mine = phone_caps(cfg);
    peer.send(&phone_caps_msg(cfg)).await.map_err(|e| e.to_string())?;
    let pl = plan(&a_caps, &mine, false);
    // Bluetooth: N advertises when the plan says so
    let mut adv = Advertiser::new();
    let mut stash: Vec<Message> = vec![];
    if pl.ble.is_some_and(|b| b.advertiser == Side::N) {
        // A tells us to start
        loop {
            match peer.recv(t(10)).await.map_err(|e| e.to_string())? {
                Message::BleStart { .. } => break,
                m @ Message::Abort { .. } => {
                    note_abort(rep, &m);
                    return Ok(());
                }
                m => {
                    if !absorb(rep, &m) {
                        stash.push(m);
                    }
                }
            }
        }
        let (_r, u) = adv.next_advert(&k);
        io.advertise(u);
        // L1: verify A's `ble_heard` and answer with the `ble_ack` (the approver's proof); stop at A's verdict
        let end = Instant::now() + t(20);
        while Instant::now() < end {
            match peer.recv(Duration::from_millis(200)).await {
                Ok(Message::BleHeard { mac }) => {
                    if let Some(m) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(mac.trim_end_matches('=')).ok().and_then(|v| <[u8; 32]>::try_from(v).ok()) {
                        if let Some(a) = adv.ack_for_heard(&k, &m).filter(|_| !cfg.no_ack) {
                            let _ = peer.send(&Message::ble_ack(&a)).await;
                        }
                    }
                }
                Ok(m @ Message::Abort { .. }) => {
                    note_abort(rep, &m);
                    return Ok(());
                }
                Ok(m) => {
                    let done = matches!(m, Message::BleResult { .. });
                    if !absorb(rep, &m) {
                        stash.push(m);
                    }
                    if done {
                        break;
                    }
                }
                Err(_) => {}
            }
        }
    }
    // local network
    let listener_side = cl_near::ble::plan(&a_caps, &mine, false).lan.map(|l| l.listener);
    let mut link_lan: Option<(Link, Option<LanConn>)> = None;
    if cfg.lan {
        match listener_side {
            Some(Side::N) => {
                let l = LanListener::bind(&k, &link, ifaces(), lan_policy(), LanTimeouts::default()).await.map_err(|e| e.to_string())?;
                // offer only after the BLE stage window: A decides when it wants the LAN
                tokio::time::sleep(Duration::from_millis(300)).await;
                peer.send(&Message::lan_offer(&l.offer())).await.map_err(|e| e.to_string())?;
                let l = Arc::new(l);
                let c = l.accept(t(12)).await.ok();
                link_lan = Some((Link::Listener(l), c));
            }
            Some(Side::A) => {
                let offer = loop {
                    let m = match stash.pop() {
                        Some(m) => m,
                        None => match peer.recv(t(15)).await {
                            Ok(m) => m,
                            Err(_) => break None,
                        },
                    };
                    match m {
                        Message::LanOffer { .. } => break m.lan_offer_typed().ok(),
                        m @ Message::Abort { .. } => {
                            note_abort(rep, &m);
                            return Ok(());
                        }
                        m => {
                            absorb(rep, &m);
                        }
                    }
                };
                if let Some(o) = offer {
                    let l = Link::Dialer(o);
                    let c = next_conn(&l, &k, &link, t(8)).await.ok();
                    // after a Bluetooth proof this dial is the transfer probe (contract 11.5)
                    let msg = if rep.ble_result.as_deref() == Some("ok") { Message::lan_probe_result(c.is_some(), None) } else { Message::lan_result(c.is_some(), None) };
                    let _ = peer.send(&msg).await;
                    link_lan = Some((l, c));
                }
            }
            None => {}
        }
    }
    // outcome: the host approves or denies; poll the session
    let end = Instant::now() + t(cfg.timeout_s);
    let envelope = loop {
        if Instant::now() > end {
            return Err("timed out waiting for the approver".into());
        }
        // A `no_proximity` abort from A arrives on the relay
        match peer.recv(Duration::from_millis(150)).await {
            Ok(m @ Message::Abort { .. }) => {
                note_abort(rep, &m);
                return Ok(());
            }
            Ok(m) => {
                absorb(rep, &m);
            }
            Err(_) => {}
        }
        let (a, l) = (api.clone(), link.clone());
        let p = tokio::task::spawn_blocking(move || a.poll_session(&l)).await.unwrap().map_err(|e| e.to_string())?;
        match p.state.as_str() {
            "granted" => break p.envelope_b64.unwrap_or_default(),
            "denied" => {
                rep.denied = true;
                return Ok(());
            }
            "expired" => return Err("session expired".into()),
            _ => {}
        }
    };
    // the grant must open with OUR key (proves the host sealed it to the key we registered)
    let g = cl_crypto::link::open_link_grant(&envelope, ek_priv.as_ref(), &B64.encode(en_pub), &link).map_err(|e| format!("grant: {e}"))?;
    rep.granted = g.claim_secret.is_some();
    // transfer
    if let (Some(out), Some((l, held))) = (cfg.recv_out.clone(), link_lan) {
        let dir = cfg.work_dir.join("recv");
        let parts = dir.join("parts");
        let mut sink = FileRecordSink::new(&parts).map_err(|e| e.to_string())?;
        let mut store = FileStore::new(dir.join("progress.json"));
        let mut held = held;
        let opts = TransferOpts::default();
        let started = Instant::now();
        loop {
            rep.attempts += 1;
            let c = match held.take() {
                Some(c) => c,
                None => next_conn(&l, &k, &link, t(25)).await?,
            };
            let proof: ProximityProof = c.proof();
            let r = if rep.attempts == 1 && cfg.drop_after.is_some() {
                run_receiver(Conn::new(FaultyStream::new(c.stream, cfg.drop_after.unwrap()), ConnConfig::default()), &proof, &mut sink, &mut store, &opts).await
            } else {
                run_receiver(Conn::new(c.stream, ConnConfig::default()), &proof, &mut sink, &mut store, &opts).await
            };
            match r {
                Ok(s) if s.complete => break,
                Ok(_) => return Err("incomplete".into()),
                Err(_) if rep.attempts < 8 => continue,
                Err(e) => return Err(format!("transfer: {e}")),
            }
        }
        rep.transfer_secs = started.elapsed().as_secs_f64();
        let m = store.load().map_err(|e| e.to_string())?.ok_or("no progress")?.manifest;
        rep.transfer_bytes = super::parts::assemble(&parts, &m, &out).map_err(|e| e.to_string())?;
        rep.transfer_sha256 = Some(sha_file(&out));
    }
    Ok(())
}

fn note_abort(rep: &mut PhoneReport, m: &Message) {
    let (reason, ble, lan) = m.abort_reason().map(|(r, b, l)| (r.to_owned(), b.map(str::to_owned), l.map(str::to_owned))).unwrap_or_default();
    rep.abort = Some(match (&ble, &lan) {
        (None, None) => reason.clone(),
        _ => format!("{reason} ble={} lan={}", ble.as_deref().unwrap_or("-"), lan.as_deref().unwrap_or("-")),
    });
    if reason == "denied" {
        rep.denied = true;
    } else {
        rep.refused = Some(reason);
    }
}

pub fn sha_file(p: &std::path::Path) -> String {
    use std::io::Read;
    let mut f = std::fs::File::open(p).unwrap();
    let mut h = Sha256::new();
    let mut b = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut b).unwrap();
        if n == 0 {
            break;
        }
        h.update(&b[..n]);
    }
    h.finalize().iter().map(|x| format!("{x:02x}")).collect()
}

/// The phone scans the code the host shows (host = new device) and approves it.
pub async fn phone_approver(cfg: PhoneCfg, io: Arc<dyn PeerIo>) -> PhoneReport {
    let mut rep = PhoneReport { role: "phone_approver".into(), ..Default::default() };
    if let Err(e) = phone_a_inner(&cfg, io, &mut rep).await {
        rep.error = Some(e);
    }
    rep.peak_rss_kb = peak_rss_kb();
    rep
}

async fn phone_a_inner(cfg: &PhoneCfg, io: Arc<dyn PeerIo>, rep: &mut PhoneReport) -> Result<(), String> {
    let uri = io.wait_for_code();
    let cl_near::code::NearPayload::Near(code) = cl_near::code::parse(&uri).map_err(|e| e.to_string())? else { return Err("not a near code".into()) };
    let api = LinkApi::new(&cfg.base, Some(Auth { access_token: "tok".into(), device_id: cfg.device_id.clone() }), None, "9.9.9").map_err(|e| e.to_string())?;
    let (a2, id) = (api.clone(), code.link_id.clone());
    let info = tokio::task::spawn_blocking(move || a2.scan(&id)).await.unwrap().map_err(|e| e.to_string())?;
    let expected_ik: [u8; 32] = info.identity_key_pub_b64.as_deref().and_then(|s| B64.decode(s).ok()).and_then(|v| v.try_into().ok()).ok_or("scan: identity key")?;
    let mut peer = RelayPeer::approver_connect(HttpRelay::new(&api, Side::A, &code.link_id), &code.link_id, &code.en_pub, &code.secret, &expected_ik, t(10)).await.map_err(|e| format!("hello: {e}"))?;
    let k = clone_keys(peer.session().keys());
    let mine = phone_caps(cfg);
    peer.send(&phone_caps_msg(cfg)).await.map_err(|e| e.to_string())?;
    let n_caps = loop {
        match peer.recv(t(10)).await.map_err(|e| e.to_string())? {
            m @ Message::Caps { .. } => {
                rep.peer_label = m.who().map(|w| w.label);
                break m.caps_checked().map_err(|e| e.to_string())?;
            }
            _ => {}
        }
    };
    let pl = plan(&mine, &n_caps, false);
    let mut proof: Option<ProximityProof> = None;
    let mut ble_cause: &str = "skipped";
    let mut adv = Advertiser::new();
    if pl.ble.is_some_and(|b| b.advertiser == Side::A) {
        ble_cause = "not_found";
        let _ = peer.send(&Message::status("checking_ble", None)).await;
        peer.send(&Message::ble_start(Side::A)).await.map_err(|e| e.to_string())?;
        let (_r, u) = adv.next_advert(&k);
        io.advertise(u);
        let end = Instant::now() + t(12);
        while Instant::now() < end && proof.is_none() {
            if let Ok(Message::BleHeard { mac }) = peer.recv(Duration::from_millis(200)).await {
                if let Ok(m) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(mac.trim_end_matches('=')) {
                    if let Ok(m) = <[u8; 32]>::try_from(m) {
                        proof = adv.prove_heard(&k, &code.link_id, &m);
                        // uniform: the advertiser always acks a verified ble_heard (L1)
                        if let Some(a) = adv.ack_for_heard(&k, &m) {
                            let _ = peer.send(&Message::ble_ack(&a)).await;
                        }
                    }
                }
            }
        }
        // the verifier of the Bluetooth proof (A) reports as soon as it knows (contract 11.4)
        let _ = peer.send(&Message::ble_result(proof.is_some(), Some(if proof.is_some() { "ok" } else { "not_found" }))).await;
        if proof.is_some() {
            ble_cause = "ok";
            let _ = peer.send(&Message::status("proof_ok", Some("ble"))).await;
        }
    }
    // LAN: listener per plan
    let ble_proved = proof.is_some();
    let mut lan: Option<(Link, Option<LanConn>)> = None;
    let mut lan_cause: &str = "skipped";
    if cfg.lan {
        match pl.lan.map(|l| l.listener) {
            Some(Side::A) => {
                let _ = peer.send(&Message::status("checking_lan", None)).await;
                let l = LanListener::bind(&k, &code.link_id, ifaces(), lan_policy(), LanTimeouts::default()).await.map_err(|e| e.to_string())?;
                peer.send(&Message::lan_offer(&l.offer())).await.map_err(|e| e.to_string())?;
                let l = Arc::new(l);
                let c = l.accept(t(12)).await.ok();
                lan_cause = if c.is_some() { "ok" } else { "not_found" };
                if ble_proved {
                    let _ = peer.send(&Message::lan_probe_result(c.is_some(), None)).await;
                }
                lan = Some((Link::Listener(l), c));
            }
            Some(Side::N) => {
                let _ = peer.send(&Message::status("checking_lan", None)).await;
                let end = Instant::now() + t(12);
                while Instant::now() < end {
                    if let Ok(m @ Message::LanOffer { .. }) = peer.recv(Duration::from_millis(200)).await {
                        if let Ok(o) = m.lan_offer_typed() {
                            let l = Link::Dialer(o);
                            let c = next_conn(&l, &k, &code.link_id, t(8)).await.ok();
                            lan_cause = if c.is_some() { "ok" } else { "not_found" };
                            if ble_proved {
                                let _ = peer.send(&Message::lan_probe_result(c.is_some(), None)).await;
                            }
                            lan = Some((l, c));
                        }
                        break;
                    }
                }
            }
            None => {}
        }
    }
    if proof.is_none() {
        proof = lan.as_ref().and_then(|(_, c)| c.as_ref().map(|c| c.proof()));
        if proof.is_some() {
            let _ = peer.send(&Message::status("proof_ok", Some("lan"))).await;
        }
    }
    let Some(proof) = proof else {
        peer.send(&Message::abort_no_proximity(ble_cause, lan_cause)).await.ok();
        rep.refused = Some("no_proximity".into());
        return Ok(());
    };
    rep.proximity = Some(proof.method().as_str().into());
    let _ = peer.send(&Message::status("awaiting_user", None)).await;
    // DEV harness only: hold the decision so a browser can capture the "waiting for the other device" screen.
    let mut hold = cfg.hold_ms;
    if let Some(ms) = std::env::var("NEAR_PEER_APPROVE_DELAY_MS").ok().and_then(|v| v.parse::<u64>().ok()) {
        hold = hold.max(ms);
    }
    if hold > 0 {
        tokio::time::sleep(Duration::from_millis(hold)).await;
    }
    if !cfg.approve {
        let how = if cfg.decision.is_empty() { "deny_http" } else { cfg.decision.as_str() };
        rep.refuse_sent_ms = Some(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0));
        if how == "deny_http" || how == "deny_both" {
            let (a2, id) = (api.clone(), code.link_id.clone());
            tokio::task::spawn_blocking(move || a2.deny(&id)).await.unwrap().map_err(|e| e.to_string())?;
        }
        if how == "deny_relay" || how == "deny_both" {
            peer.send(&Message::abort("denied")).await.map_err(|e| e.to_string())?;
        }
        if how == "cancel_relay" {
            peer.send(&Message::abort("cancelled")).await.map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let ik = info.identity_key_pub_b64.clone().ok_or("no identity key")?;
    let ts = 1_763_500_000i64;
    let msg = link_approve_message_v2("u1", &cfg.device_id, &code.link_id, &ik, &proof, ts).map_err(|e| e.to_string())?;
    let sig = B64.encode(signing_key(&cfg.seed_hex).sign(msg.as_bytes()).to_bytes());
    let (a2, id, prox) = (api.clone(), code.link_id.clone(), proof.method().as_str());
    let ap = tokio::task::spawn_blocking(move || a2.approve_near(&id, &sig, ts, prox)).await.unwrap().map_err(|e| e.to_string())?;
    let env = cl_crypto::link::seal_link_grant_v2(&code.link_id, &ap.user_id, &ap.claim_secret, &ap.approved_by_device_id, &ap.approved_by_device_name, "2026-11-19T00:00:00.000Z", &B64.encode(code.en_pub)).map_err(|e| e.to_string())?;
    let (a2, id) = (api.clone(), code.link_id.clone());
    tokio::task::spawn_blocking(move || a2.grant(&id, &env)).await.unwrap().map_err(|e| e.to_string())?;
    rep.granted = true;
    if let (Some(file), Some((l, held))) = (cfg.send_file.clone(), lan) {
        let mut src = if cfg.send_container {
            let path = cfg.work_dir.join("container.bin");
            std::fs::create_dir_all(&cfg.work_dir).map_err(|e| e.to_string())?;
            std::fs::write(&path, near_test_container(&k.xfer)).map_err(|e| e.to_string())?;
            super::parts::FilePartsSource::open_keyed(&path, &cfg.device_id, 1024, Some(&k.xfer)).map_err(|e| e.to_string())?
        } else {
            super::parts::FilePartsSource::open(&file, &cfg.device_id, super::parts::PART_BYTES).map_err(|e| e.to_string())?
        };
        let mut held = held;
        let opts = TransferOpts::default();
        let started = Instant::now();
        loop {
            rep.attempts += 1;
            let c = match held.take() {
                Some(c) => c,
                None => next_conn(&l, &k, &code.link_id, t(25)).await?,
            };
            let p = c.proof();
            let r = if rep.attempts == 1 && cfg.drop_after.is_some() {
                run_sender(Conn::new(FaultyStream::new(c.stream, cfg.drop_after.unwrap()), ConnConfig::default()), &p, &mut src, &opts).await
            } else {
                run_sender(Conn::new(c.stream, ConnConfig::default()), &p, &mut src, &opts).await
            };
            match r {
                Ok(s) => {
                    rep.transfer_bytes = s.bytes_sent;
                    break;
                }
                Err(_) if rep.attempts < 8 => continue,
                Err(e) => return Err(format!("transfer: {e}")),
            }
        }
        rep.transfer_secs = started.elapsed().as_secs_f64();
    }
    Ok(())
}

/// A radio whose single advertisement is supplied later (by the scripted phone), emitted repeatedly.
pub struct CellRadio {
    pub state: super::radio::AdapterState,
    pub cell: Arc<std::sync::Mutex<Option<[u8; 16]>>>,
}
impl super::radio::BleRadio for CellRadio {
    fn adapter_state(&self) -> super::radio::AdapterState {
        self.state.clone()
    }
    fn scan(&self, stop: &std::sync::atomic::AtomicBool, on_uuid: &mut dyn FnMut([u8; 16])) -> Result<(), String> {
        while !stop.load(Ordering::SeqCst) {
            if let Some(u) = *self.cell.lock().unwrap() {
                on_uuid([7u8; 16]); // noise first, like a real air
                on_uuid(u);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(())
    }
}


// ---- host-side scaffolding shared by the unit tests and the two-process harness --------------------------------

pub struct TestIdent {
    pub seed: &'static str,
    pub installed: std::sync::Mutex<Vec<(String, [u8; 32], String)>>,
}
impl super::engine::Identity for TestIdent {
    fn identity_pub_b64(&self) -> Option<String> {
        Some(identity_pub_b64(self.seed))
    }
    fn sign(&self, m: &str) -> Option<String> {
        Some(B64.encode(signing_key(self.seed).sign(m.as_bytes()).to_bytes()))
    }
    fn install_link_session(&self, l: &str, k: &[u8; 32], e: &str) {
        self.installed.lock().unwrap().push((l.into(), *k, e.into()));
    }
}

pub struct TestGate {
    pub avail: super::gate::Availability,
    pub next: std::sync::Mutex<super::gate::Verification>,
    pub prompts: std::sync::Mutex<Vec<String>>,
}
impl super::gate::ApprovalGate for TestGate {
    fn availability(&self) -> super::gate::Availability {
        self.avail
    }
    fn verify(&self, r: &str) -> super::gate::Verification {
        self.prompts.lock().unwrap().push(r.into());
        *self.next.lock().unwrap()
    }
    fn confirm(&self, _t: &str, d: &str) -> bool {
        self.prompts.lock().unwrap().push(d.into());
        *self.next.lock().unwrap() == super::gate::Verification::Verified
    }
}

#[allow(clippy::type_complexity)]
pub fn test_env(dir: &std::path::Path, name: &str, seed: &'static str, radio: Arc<dyn super::radio::BleRadio>, os: super::engine::Os, emit: Arc<dyn Fn(&super::state::NearSnapshot) + Send + Sync>) -> (super::engine::NearEnv, Arc<TestIdent>, Arc<TestGate>, Arc<AtomicU64>) {
    use super::engine::{NearEnv, Timing};
    use super::netdiag::AdapterCensus;
    let ident = Arc::new(TestIdent { seed, installed: Default::default() });
    let gate = Arc::new(TestGate { avail: super::gate::Availability::Available, next: std::sync::Mutex::new(super::gate::Verification::Verified), prompts: Default::default() });
    let skew = Arc::new(AtomicU64::new(0));
    let env = NearEnv {
        radio,
        gate: gate.clone(),
        ifaces: Arc::new(StaticInterfaces(vec![LocalInterface { index: 1, name: "test0".into(), addr: "10.255.0.1".parse().unwrap(), prefix_len: 24, kind: cl_near::onlink::IfaceKind::Virtual }])),
        census: Arc::new(AdapterCensus::default),
        identity: ident.clone(),
        profile: dir.to_path_buf(),
        staging_dir: dir.join("staging"),
        version: "9.9.9".into(),
        attest_secret: None,
        device_label: format!("{name} PC"),
        platform: "windows",
        os,
        lan_policy: LanPolicy::DangerousAllowLoopback,
        scan_caps: super::radio::ScanCaps { adapter: Duration::from_millis(300), scan: Duration::from_millis(1500) },
        lan_timeouts: LanTimeouts::default(),
        timing: Timing { hello: Duration::from_secs(3), peer_step: Duration::from_secs(5), lan: Duration::from_secs(6), lan_probe: Duration::from_secs(4), scan_retry: Duration::from_millis(300), poll: Duration::from_millis(100), transfer_giveup: Duration::from_secs(20), reopen_margin: Duration::from_secs(10), show_limit: Duration::from_secs(600), pause_cap: Duration::from_secs(900) },
        stop: Arc::new(super::pause::FramePause),
        own_send: Arc::new(NullOwnSend),
        own_answer: Duration::from_secs(30),
        emit,
        resolve_path: Arc::new(|p| Ok(PathBuf::from(p))),
        skew_ms: skew.clone(),
        // the transfer-machinery tests run two desktops (no Bluetooth between them); the policy tests turn this off
        test_history_over_lan: true,
    };
    (env, ident, gate, skew)
}

/// Own-device messages go nowhere (the sign-in tests never use them).
pub struct NullOwnSend;
impl super::own::OwnSend for NullOwnSend {
    fn send(&self, _to: &str, _content: serde_json::Value) {}
}

/// What the container of [`PhoneCfg::send_container`] holds: `meta`, one whole attachment and one attachment split in three
/// (`att:<id>:<n>:3`), sealed under `key` with cl-crypto's raw-key writer. Shared with the e2e's checks.
pub fn near_test_records() -> Vec<(String, Vec<u8>)> {
    let bytes = |n: usize, seed: u8| (0..n).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect::<Vec<u8>>();
    vec![
        ("meta".into(), br#"{"version":1,"userId":"u1","topics":[]}"#.to_vec()),
        ("att:whole-1".into(), bytes(700, 1)),
        ("att:split-1:1:3".into(), bytes(1500, 2)),
        ("att:split-1:2:3".into(), bytes(1500, 3)),
        ("att:split-1:3:3".into(), bytes(400, 4)),
    ]
}
pub fn near_test_container(key: &[u8; 32]) -> Vec<u8> {
    let mut out: Vec<u8> = vec![];
    let mut w = cl_crypto::backup_v4::WriterV4::create_raw(&mut out, key, [7u8; 16]).expect("raw writer");
    for (id, b) in near_test_records() {
        w.add_bytes(&id, &b, None).expect("record");
    }
    w.finish("u1", "near-transfer", "2026-11-20T00:00:00.000Z").expect("finish");
    out
}
