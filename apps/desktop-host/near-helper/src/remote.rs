//! Everything the helper cannot do itself and asks its parent for: the device identity (Electron's keystore holds the
//! Ed25519 key), the link session (the app's `beginLinkSession` slot opens the grant), and the approval gate when the
//! platform has no biometric.
//!
//! A request is `{"t":"req","rid":N,"what":...}` on stdout; the parent answers `{"t":"reply","rid":N,...}` on stdin. The
//! engine's traits are synchronous, so [`Remote::ask`] blocks the calling engine thread (never the stdin reader) with a
//! deadline; a missing answer is a refusal, never an approval.
use crate::proto::Out;
use cl_near_engine::engine::Identity;
use cl_near_engine::gate::{ApprovalGate, Availability, GateKind, Verification};
use cl_near_engine::own::OwnSend;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use zeroize::Zeroizing;

type Pending = (Value, Option<String>);

pub struct Remote {
    out: Sender<Out>,
    pending: Mutex<HashMap<u64, Sender<Pending>>>,
    next: AtomicU64,
    /// The handshake nonce: keys the attestation of gate answers (see [`attest_gate`]).
    nonce: Zeroizing<String>,
    pub identity_timeout: Duration,
    pub gate_timeout: Duration,
}

/// `hex(HMAC-SHA256(key = nonce, "gate:<rid>:<verdict>"))`: what Electron main attaches to a gate answer. The renderer never
/// sees the nonce, so an answer that reaches the helper without passing through main (or for another request) cannot carry it.
pub fn attest_gate(nonce: &str, rid: u64, verdict: &str) -> String {
    let mut m = Hmac::<Sha256>::new_from_slice(nonce.as_bytes()).expect("any key length");
    m.update(format!("gate:{rid}:{verdict}").as_bytes());
    m.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect()
}

impl Remote {
    pub fn new(out: Sender<Out>, nonce: String) -> Arc<Self> {
        Arc::new(Self { out, pending: Default::default(), next: AtomicU64::new(1), nonce: Zeroizing::new(nonce), identity_timeout: Duration::from_secs(15), gate_timeout: Duration::from_secs(180) })
    }

    pub fn send(&self, o: Out) {
        let _ = self.out.send(o);
    }

    /// Ask the parent and wait. `None` = no answer in time, or the parent went away.
    pub fn ask(&self, what: &'static str, fields: Value, timeout: Duration) -> Option<(u64, Pending)> {
        let rid = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx): (Sender<Pending>, Receiver<Pending>) = channel();
        self.pending.lock().ok()?.insert(rid, tx);
        if self.out.send(Out::Req { rid, what, fields }).is_err() {
            self.pending.lock().ok()?.remove(&rid);
            return None;
        }
        let got = match rx.recv_timeout(timeout) {
            Ok(p) => Some((rid, p)),
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => None,
        };
        if let Ok(mut p) = self.pending.lock() {
            p.remove(&rid);
        }
        got
    }

    /// The reader thread hands a `reply` here. Unsolicited / repeated / late replies are dropped.
    pub fn deliver(&self, rid: u64, value: Value, attest: Option<String>) -> bool {
        let tx = self.pending.lock().ok().and_then(|mut p| p.remove(&rid));
        match tx {
            Some(tx) => tx.send((value, attest)).is_ok(),
            None => false,
        }
    }

    /// Parent is gone: fail every waiter at once.
    pub fn abandon_all(&self) {
        if let Ok(mut p) = self.pending.lock() {
            p.clear();
        }
    }
}

/// The identity key lives in the parent's keystore.
pub struct RemoteIdentity(pub Arc<Remote>);

impl Identity for RemoteIdentity {
    fn identity_pub_b64(&self) -> Option<String> {
        let (_, (v, _)) = self.0.ask("identity_pub", json!({}), self.0.identity_timeout)?;
        v.get("pub")?.as_str().filter(|s| !s.is_empty() && s.len() <= 128).map(str::to_owned)
    }
    fn sign(&self, message: &str) -> Option<String> {
        let (_, (v, _)) = self.0.ask("sign", json!({ "message": message }), self.0.identity_timeout)?;
        v.get("sig")?.as_str().filter(|s| !s.is_empty() && s.len() <= 256).map(str::to_owned)
    }
    fn install_link_session(&self, link_id: &str, ek_priv: &[u8; 32], ek_pub_b64: &str) {
        use base64::Engine as _;
        // The one secret that crosses the pipe outward. The parent's `link-grant` slot is the only thing that can open
        // the sealed grant, exactly like the QR flow; the helper keeps no copy beyond this call (the engine zeroizes its own).
        let priv_b64 = Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(ek_priv));
        let _ = self.0.ask("install_link", json!({ "linkId": link_id, "ekPrivB64": priv_b64.as_str(), "ekPubB64": ek_pub_b64 }), self.0.identity_timeout);
    }
}

/// The approval gate. With a platform biometric (macOS Touch ID) `availability` is `Available` and the platform answers
/// `verify`. Otherwise `confirm` asks the parent, which verifies the account password against the server ITSELF (the web
/// content only supplies the typed secret) and attests the verdict; anything else is a refusal.
pub struct RemoteGate {
    pub remote: Arc<Remote>,
    pub biometric: Option<Arc<dyn Biometric>>,
}

pub trait Biometric: Send + Sync {
    fn available(&self) -> bool;
    fn verify(&self, reason: &str) -> Verification;
}

impl ApprovalGate for RemoteGate {
    fn availability(&self) -> Availability {
        if self.biometric.as_ref().is_some_and(|b| b.available()) {
            Availability::Available
        } else {
            Availability::Unavailable
        }
    }
    fn verify(&self, reason: &str) -> Verification {
        match &self.biometric {
            Some(b) if b.available() => b.verify(reason),
            _ => Verification::Failed,
        }
    }
    fn confirm(&self, title: &str, detail: &str) -> bool {
        let Some((rid, (v, attest))) = self.remote.ask("gate_confirm", json!({ "title": title, "detail": detail }), self.remote.gate_timeout) else { return false };
        let verdict = v.get("verdict").and_then(Value::as_str).unwrap_or("declined");
        let expect = attest_gate(&self.remote.nonce, rid, verdict);
        let genuine = attest.as_deref().is_some_and(|a| {
            use subtle::ConstantTimeEq;
            a.len() == expect.len() && bool::from(a.as_bytes().ct_eq(expect.as_bytes()))
        });
        genuine && verdict == "approved"
    }
    fn confirm_kind(&self) -> GateKind {
        GateKind::Password
    }
}

/// Own-device control messages leave as an event; the page puts them through its E2EE self-fan-out.
pub struct OwnOut(pub Arc<Remote>);
impl OwnSend for OwnOut {
    /// The `OwnSend` contract (`near-engine/src/own.rs`, and the phone core's `own.rs` it mirrors) is that the SENDER appends
    /// `"to": <device>` as the last field. The engine's content has none, and the page (`utils/nearOwnTransport.ts`) refuses to send a
    /// message whose `content.to` is not the addressee, so without this every outgoing offer / answer / near_msg was dropped on the
    /// page and an own-device transfer never started.
    fn send(&self, to_device: &str, mut content: Value) {
        if let Some(o) = content.as_object_mut() {
            o.insert("to".to_owned(), Value::String(to_device.to_owned()));
        }
        self.0.send(Out::OwnOut { to: to_device.to_owned(), content });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rig() -> (Arc<Remote>, Receiver<Out>) {
        let (tx, rx) = channel();
        (Remote::new(tx, "n".repeat(64)), rx)
    }

    #[test]
    fn a_reply_reaches_the_waiting_engine_thread_and_a_stray_one_is_dropped() {
        let (r, rx) = rig();
        let r2 = r.clone();
        let h = std::thread::spawn(move || RemoteIdentity(r2).sign("m"));
        let Out::Req { rid, what, .. } = rx.recv().unwrap() else { panic!() };
        assert_eq!(what, "sign");
        assert!(!r.deliver(rid + 99, json!({ "sig": "x" }), None), "unknown rid");
        assert!(r.deliver(rid, json!({ "sig": "SIG" }), None));
        assert_eq!(h.join().unwrap().as_deref(), Some("SIG"));
        assert!(!r.deliver(rid, json!({ "sig": "again" }), None), "answered once only");
    }

    #[test]
    fn an_outgoing_own_device_message_names_its_addressee_last() {
        let (r, rx) = rig();
        OwnOut(r).send("dev-H", json!({ "type": "near_offer", "v": 1, "e_pub": "k", "nonce": "n", "ts": 1 }));
        let Out::OwnOut { to, content } = rx.recv().unwrap() else { panic!() };
        assert_eq!(to, "dev-H");
        assert_eq!(content["to"], "dev-H");
        assert_eq!(content.as_object().unwrap().keys().last().map(String::as_str), Some("to"), "appended: the phone's field order");
        // a sender-supplied `to` cannot point the message elsewhere
        let (r, rx) = rig();
        OwnOut(r).send("dev-H", json!({ "type": "near_msg", "to": "dev-EVIL" }));
        let Out::OwnOut { content, .. } = rx.recv().unwrap() else { panic!() };
        assert_eq!(content["to"], "dev-H");
    }

    #[test]
    fn no_answer_in_time_is_none() {
        let (tx, _rx) = channel();
        let mut r = Arc::try_unwrap(Remote::new(tx, "n".repeat(64))).ok().unwrap();
        r.identity_timeout = Duration::from_millis(50);
        assert_eq!(RemoteIdentity(Arc::new(r)).identity_pub_b64(), None);
    }

    fn gate_answer(verdict: &str, good_attest: bool) -> bool {
        let (r, rx) = rig();
        let gate = RemoteGate { remote: r.clone(), biometric: None };
        let v = verdict.to_owned();
        let h = std::thread::spawn(move || gate.confirm("t", "d"));
        let Out::Req { rid, what, .. } = rx.recv().unwrap() else { panic!() };
        assert_eq!(what, "gate_confirm");
        let a = if good_attest { attest_gate(&"n".repeat(64), rid, &v) } else { "00".repeat(32) };
        r.deliver(rid, json!({ "verdict": v }), Some(a));
        h.join().unwrap()
    }

    #[test]
    fn only_an_attested_approval_opens_the_gate() {
        assert!(gate_answer("approved", true));
        assert!(!gate_answer("approved", false), "a forged answer");
        assert!(!gate_answer("declined", true));
        // an answer attested for ANOTHER verdict or request does not verify
        assert_ne!(attest_gate("k", 1, "approved"), attest_gate("k", 2, "approved"));
        assert_ne!(attest_gate("k", 1, "approved"), attest_gate("k", 1, "declined"));
        assert_ne!(attest_gate("k", 1, "approved"), attest_gate("j", 1, "approved"));
    }

    #[test]
    fn an_unanswered_gate_is_a_refusal() {
        let (tx, _rx) = channel();
        let mut r = Arc::try_unwrap(Remote::new(tx, "n".repeat(64))).ok().unwrap();
        r.gate_timeout = Duration::from_millis(50);
        let gate = RemoteGate { remote: Arc::new(r), biometric: None };
        assert!(!gate.confirm("t", "d"));
        assert_eq!(gate.availability(), Availability::Unavailable);
        assert_eq!(gate.confirm_kind(), GateKind::Password);
    }
}
