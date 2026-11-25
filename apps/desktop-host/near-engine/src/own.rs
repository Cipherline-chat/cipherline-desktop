//! Transfer between two devices of the SAME account that are both signed in (contract section 7; the phone core's version is
//! `core/cl-sync/src/near/own.rs`, whose message shapes this mirrors exactly).
//!
//! No scan and no link relay. The requester (the receiver, side `N`) sends a hidden control message to ITS OWN other device
//! through the app's normal E2EE self-fan-out; the holder of the history (the sender, side `A`) asks its person (the
//! approval gate), then answers:
//!
//! * `near_offer  { v: 1, e_pub, nonce, ts, to }`            requester -> holder
//! * `near_answer { v: 1, nonce, e_pub | declined, to }`      holder -> requester
//! * `near_msg    { v: 1, nonce, from, seq, body_b64, to }`   both ways: the sealed relay messages of the contract (`caps`,
//!   `lan_offer`, `status`, `abort`), AES-256-GCM under `K_relay`, `aad = "near-relay:v1:" || "own:" + requesterDeviceId || from || seq`.
//!
//! `K = HKDF(X25519(eN, eA), salt = nonce, info = "cipherline-near:v1:own:<requesterDeviceId>")` (section 2 with `salt = nonce`).
//! Device identity is authenticated by the E2EE envelope (the renderer's pipeline verified author and device before it hands a
//! message over), so there is no `hello`. The local-network proof and the transfer then run exactly as for a sign-in; a
//! Bluetooth proof is not used here.
//!
//! HOW MESSAGES MOVE. This module never touches the network: an outgoing message is handed to [`OwnSend`] (in the app it
//! becomes a `cl:near-own-out` event the page encrypts and posts to the target device) and an incoming one arrives through
//! [`super::engine::NearEngine::own_deliver`] after the page verified it came from one of this account's OTHER devices and was
//! addressed to this one.
use super::engine::Pipe;
use cl_near::error::{NearError, Result as NResult};
use cl_near::keys::SessionKeys;
use cl_near::relay::{open_body, relay_aad, seal_with_nonce, Message, Side};
use rand_core::{OsRng, RngCore};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

/// The three control types (they are hidden everywhere: `CONTROL_TYPES` in the renderer, `isControlContent`).
pub const NEAR_TYPES: [&str; 3] = ["near_offer", "near_answer", "near_msg"];
/// An offer older than this is ignored.
pub const OFFER_MAX_AGE_MS: i64 = 120_000;

fn b64url(b: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}
/// Strict: unpadded base64url of exactly `N` bytes (43 chars for 32, 22 for 16).
fn dec<const N: usize>(s: &str, chars: usize) -> Option<[u8; N]> {
    use base64::Engine as _;
    if s.len() != chars {
        return None;
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).ok()?.try_into().ok()
}
pub fn dec32(s: &str) -> Option<[u8; 32]> {
    dec::<32>(s, 43)
}
pub fn dec16(s: &str) -> Option<[u8; 16]> {
    dec::<16>(s, 22)
}

pub fn link_id_for(requester_device: &str) -> String {
    format!("own:{requester_device}")
}
pub fn random16() -> [u8; 16] {
    let mut n = [0u8; 16];
    OsRng.fill_bytes(&mut n);
    n
}

/// How an own-device message leaves this device: the page puts it through the E2EE self-fan-out to `to_device`.
pub trait OwnSend: Send + Sync {
    fn send(&self, to_device: &str, content: Value);
}

pub fn offer_content(e_pub: &[u8; 32], nonce: &[u8; 16], now_ms: i64) -> Value {
    json!({ "type": "near_offer", "v": 1, "e_pub": b64url(e_pub), "nonce": b64url(nonce), "ts": now_ms })
}
/// The answer revision this build speaks (`rev` in every `near_answer`; absent = 1). Revision 2 (2026-11-25, "the PC said no" fix): a re-ask
/// from the device whose sheet is still undecided REPLACES that sheet instead of being told no, the same offer delivered twice is ignored,
/// and a decline sent only because this device is busy says so (`busy: true`). An asker uses `rev` to tell a person's "not now" from an
/// older holder that answers every re-ask with a plain decline while it still shows the earlier request. Older builds ignore both fields.
pub const ANSWER_REV: u64 = 2;

pub fn answer_content(nonce: &[u8; 16], e_pub: Option<&[u8; 32]>) -> Value {
    match e_pub {
        Some(e) => json!({ "type": "near_answer", "v": 1, "nonce": b64url(nonce), "e_pub": b64url(e), "rev": ANSWER_REV }),
        None => json!({ "type": "near_answer", "v": 1, "nonce": b64url(nonce), "declined": true, "rev": ANSWER_REV }),
    }
}
/// "Not now" sent by the ENGINE, not the person: this device is in another session (a transfer, a sign-in, the person approving another
/// request). Still a decline for every older asker (`declined: true`); a revision-2 asker says "busy" instead of "said not now".
pub fn answer_busy(nonce: &[u8; 16]) -> Value {
    json!({ "type": "near_answer", "v": 1, "nonce": b64url(nonce), "declined": true, "busy": true, "rev": ANSWER_REV })
}

/// An offer this device received (already checked by the page to come from this account's other device `from_device`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingOffer {
    pub from_device: String,
    pub e_pub: [u8; 32],
    pub nonce: [u8; 16],
    pub ts: i64,
}

/// What the answer to our offer was.
pub struct Answer {
    pub e_pub: Option<[u8; 32]>,
    pub declined: bool,
    /// The holder declined only because it was busy (revision 2).
    pub busy: bool,
    /// The holder's answer revision (`rev`, 1 when absent).
    pub rev: u64,
}

/// What a delivered control message turned out to be.
#[derive(Debug, PartialEq, Eq)]
pub enum Delivered {
    Offer(PendingOffer),
    /// Routed to the running session.
    Routed,
    /// Not for us / stale / malformed / not an own-device message.
    Ignored,
}

/// L3: unsolicited offers are the only thing a hostile or buggy own device can push at a holder, so a device whose offers keep getting
/// declined is muted: after [`COOLDOWN_DECLINES`] declines inside [`COOLDOWN_WINDOW_MS`] its offers are ignored (no sheet, no answer) for
/// [`COOLDOWN_MUTE_MS`]. In memory, per helper process; the clock is passed in so the rule is tested without waiting.
pub const COOLDOWN_DECLINES: usize = 3;
pub const COOLDOWN_WINDOW_MS: i64 = 10 * 60_000;
pub const COOLDOWN_MUTE_MS: i64 = 10 * 60_000;

#[derive(Default)]
pub struct OfferCooldown {
    declines: std::collections::HashMap<String, Vec<i64>>,
    muted_until: std::collections::HashMap<String, i64>,
}

impl OfferCooldown {
    /// True while offers from `device` are being ignored.
    pub fn muted(&mut self, device: &str, now_ms: i64) -> bool {
        match self.muted_until.get(device) {
            Some(until) if now_ms < *until => true,
            Some(_) => { self.muted_until.remove(device); false }
            None => false,
        }
    }
    /// The person declined an offer from `device`.
    pub fn record_decline(&mut self, device: &str, now_ms: i64) {
        let v = self.declines.entry(device.to_owned()).or_default();
        v.retain(|t| now_ms - *t < COOLDOWN_WINDOW_MS);
        v.push(now_ms);
        if v.len() >= COOLDOWN_DECLINES {
            self.declines.remove(device);
            self.muted_until.insert(device.to_owned(), now_ms + COOLDOWN_MUTE_MS);
        }
        // bound the table: a device list is a handful, anything beyond is not one
        if self.declines.len() > 64 { self.declines.clear(); }
        if self.muted_until.len() > 64 { self.muted_until.retain(|_, u| *u > now_ms); }
    }
}

/// Where inbound `near_answer` / `near_msg` for the running own-device session go.
pub struct OwnRoute {
    pub nonce: [u8; 16],
    pub peer_device: String,
    pub answer: mpsc::UnboundedSender<Answer>,
    pub msgs: mpsc::UnboundedSender<(u64, Vec<u8>)>,
}

/// Parse and validate an inbound control message. `my_device` = this device; `from_device` = the verified author device (the
/// page checks the envelope: same account, not this device). Nothing is trusted that is not checked here: version, addressing,
/// nonce / key sizes, `ts` freshness for offers, body size for messages.
pub fn classify(content: &Value, my_device: &str, from_device: &str, now_ms: i64, route: Option<&OwnRoute>) -> Delivered {
    if from_device == my_device || content.get("to").and_then(Value::as_str) != Some(my_device) || content.get("v").and_then(Value::as_u64) != Some(1) {
        return Delivered::Ignored;
    }
    let s = |k: &str| content.get(k).and_then(Value::as_str);
    let Some(nonce) = s("nonce").and_then(dec16) else { return Delivered::Ignored };
    match s("type") {
        Some("near_offer") => {
            let (Some(e_pub), Some(ts)) = (s("e_pub").and_then(dec32), content.get("ts").and_then(Value::as_i64)) else { return Delivered::Ignored };
            if (now_ms - ts).abs() > OFFER_MAX_AGE_MS {
                return Delivered::Ignored;
            }
            Delivered::Offer(PendingOffer { from_device: from_device.to_owned(), e_pub, nonce, ts })
        }
        Some("near_answer") => {
            let Some(r) = route.filter(|r| r.nonce == nonce && r.peer_device == from_device) else { return Delivered::Ignored };
            let declined = content.get("declined").and_then(Value::as_bool) == Some(true);
            let e_pub = s("e_pub").and_then(dec32);
            let busy = declined && content.get("busy").and_then(Value::as_bool) == Some(true);
            let rev = content.get("rev").and_then(Value::as_u64).unwrap_or(1);
            if declined || e_pub.is_some() {
                // a session that is not waiting for an answer (the sender's) has no receiver on this channel: nothing to route to
                if r.answer.send(Answer { e_pub, declined, busy, rev }).is_ok() { Delivered::Routed } else { Delivered::Ignored }
            } else {
                Delivered::Ignored
            }
        }
        Some("near_msg") => {
            let Some(r) = route.filter(|r| r.nonce == nonce && r.peer_device == from_device) else { return Delivered::Ignored };
            let (Some(seq), Some(b)) = (content.get("seq").and_then(Value::as_u64), s("body_b64")) else { return Delivered::Ignored };
            if b.len() > 2048 || b.is_empty() {
                return Delivered::Ignored;
            }
            use base64::Engine as _;
            let Ok(body) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(b) else { return Delivered::Ignored };
            let _ = r.msgs.send((seq, body));
            Delivered::Routed
        }
        _ => Delivered::Ignored,
    }
}

/// One side of the own-device channel: the same sealing as the link relay, carried as `near_msg` control messages.
pub struct OwnPipe {
    side: Side,
    link_id: String,
    nonce: [u8; 16],
    peer_device: String,
    keys: SessionKeys,
    next_seq: u64,
    peer_last: u64,
    out: Arc<dyn OwnSend>,
    rx: mpsc::UnboundedReceiver<(u64, Vec<u8>)>,
}

impl OwnPipe {
    pub fn new(side: Side, requester_device: &str, nonce: [u8; 16], peer_device: &str, keys: SessionKeys, out: Arc<dyn OwnSend>, rx: mpsc::UnboundedReceiver<(u64, Vec<u8>)>) -> Self {
        Self { side, link_id: link_id_for(requester_device), nonce, peer_device: peer_device.to_owned(), keys, next_seq: 1, peer_last: 0, out, rx }
    }
}

impl Pipe for OwnPipe {
    fn keys(&self) -> &SessionKeys {
        &self.keys
    }
    fn link_id(&self) -> &str {
        &self.link_id
    }
    async fn send(&mut self, m: &Message) -> NResult<()> {
        m.validate()?;
        if self.next_seq > cl_near::relay::MAX_MESSAGES as u64 {
            return Err(NearError::RelayLimit("32 messages per session"));
        }
        let seq = self.next_seq;
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let pt = serde_json::to_vec(m).map_err(|_| NearError::Malformed("message"))?;
        let body = seal_with_nonce(&self.keys.relay, &relay_aad(&self.link_id, self.side, seq), nonce, &pt)?;
        if body.len() > cl_near::relay::MAX_BODY_BYTES {
            return Err(NearError::RelayLimit("message exceeds 2048 base64 characters"));
        }
        self.next_seq += 1;
        self.out.send(&self.peer_device, json!({ "type": "near_msg", "v": 1, "nonce": b64url(&self.nonce), "from": self.side.relay_char().to_string(), "seq": seq, "body_b64": b64url(&body) }));
        Ok(())
    }
    async fn recv(&mut self, timeout: Duration) -> NResult<Message> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            let (seq, body) = match tokio::time::timeout(left, self.rx.recv()).await {
                Ok(Some(i)) => i,
                Ok(None) => return Err(NearError::Transport("closed".into())),
                Err(_) => return Err(NearError::Timeout("relay message")),
            };
            // a seq is accepted once and only in increasing order per sender; anything that does not authenticate is dropped
            if seq == 0 || seq <= self.peer_last {
                continue;
            }
            let Ok(pt) = open_body(&self.keys.relay, &relay_aad(&self.link_id, self.side.other(), seq), &body) else { continue };
            let Ok(msg) = serde_json::from_slice::<Message>(&pt) else { continue };
            if msg.validate().is_err() || matches!(msg, Message::HelloAck { .. }) {
                continue;
            }
            self.peer_last = seq;
            return Ok(msg);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cl_near::keys;

    struct Chan(std::sync::Mutex<Vec<(String, Value)>>);
    impl OwnSend for Chan {
        fn send(&self, to: &str, mut c: Value) {
            c["to"] = to.into();
            self.0.lock().unwrap().push((to.to_owned(), c));
        }
    }

    fn pair() -> (OwnPipe, OwnPipe, Arc<Chan>, Arc<Chan>, mpsc::UnboundedSender<(u64, Vec<u8>)>, mpsc::UnboundedSender<(u64, Vec<u8>)>) {
        let (en_priv, en_pub) = keys::generate_keypair();
        let (ea_priv, ea_pub) = keys::generate_keypair();
        let nonce = random16();
        let link = link_id_for("dev-N");
        let kn = keys::session_keys(&en_priv, &ea_pub, &nonce, &link).unwrap();
        let ka = keys::session_keys(&ea_priv, &en_pub, &nonce, &link).unwrap();
        assert_eq!(*kn.relay, *ka.relay, "both sides derive the same K from the section 7 key schedule");
        let (on, oa) = (Arc::new(Chan(Default::default())), Arc::new(Chan(Default::default())));
        let (txn, rxn) = mpsc::unbounded_channel();
        let (txa, rxa) = mpsc::unbounded_channel();
        (OwnPipe::new(Side::N, "dev-N", nonce, "dev-A", kn, on.clone(), rxn), OwnPipe::new(Side::A, "dev-N", nonce, "dev-N", ka, oa.clone(), rxa), on, oa, txn, txa)
    }

    fn body_of(c: &Value) -> (u64, Vec<u8>) {
        use base64::Engine as _;
        (c["seq"].as_u64().unwrap(), base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(c["body_b64"].as_str().unwrap()).unwrap())
    }

    #[tokio::test]
    async fn sealed_messages_round_trip_in_order_and_replays_and_forgeries_are_dropped() {
        let (mut n, mut a, on, _oa, _txn, txa) = pair();
        n.send(&Message::status("checking_lan", None)).await.unwrap();
        n.send(&Message::abort("cancelled")).await.unwrap();
        let sent: Vec<Value> = on.0.lock().unwrap().iter().map(|(_, c)| c.clone()).collect();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0]["to"], "dev-A");
        assert_eq!((sent[0]["type"].as_str(), sent[0]["from"].as_str(), sent[0]["v"].as_u64()), (Some("near_msg"), Some("n"), Some(1)));
        // a replay of seq 1, a forged body, and the real messages
        txa.send(body_of(&sent[0])).unwrap();
        txa.send(body_of(&sent[0])).unwrap();
        txa.send((5, vec![7u8; 60])).unwrap();
        txa.send(body_of(&sent[1])).unwrap();
        assert_eq!(a.recv(Duration::from_millis(200)).await.unwrap(), Message::status("checking_lan", None));
        assert_eq!(a.recv(Duration::from_millis(200)).await.unwrap(), Message::abort("cancelled"));
        assert!(matches!(a.recv(Duration::from_millis(100)).await, Err(NearError::Timeout(_))), "the replay and the forgery never surface");
    }

    #[tokio::test]
    async fn a_message_sealed_for_one_side_does_not_open_as_the_other_and_the_relay_cap_holds() {
        let (mut n, _a, on, _oa, txn, _txa) = pair();
        n.send(&Message::status("checking_lan", None)).await.unwrap();
        let c = on.0.lock().unwrap()[0].1.clone();
        // fed back to the SAME side as if the peer had sent it: the aad names the sender, so it must not authenticate
        txn.send(body_of(&c)).unwrap();
        assert!(matches!(n.recv(Duration::from_millis(100)).await, Err(NearError::Timeout(_))));
        for _ in 0..31 {
            n.send(&Message::status("checking_lan", None)).await.unwrap();
        }
        assert!(matches!(n.send(&Message::status("checking_lan", None)).await, Err(NearError::RelayLimit(_))), "32 messages per session, as on the link relay");
    }

    fn route(nonce: [u8; 16], peer: &str) -> (OwnRoute, mpsc::UnboundedReceiver<Answer>, mpsc::UnboundedReceiver<(u64, Vec<u8>)>) {
        let (at, ar) = mpsc::unbounded_channel();
        let (mt, mr) = mpsc::unbounded_channel();
        (OwnRoute { nonce, peer_device: peer.into(), answer: at, msgs: mt }, ar, mr)
    }

    #[test]
    fn classify_enforces_addressing_version_freshness_and_sizes() {
        let (_, e_pub) = keys::generate_keypair();
        let nonce = random16();
        let now = 1_763_500_000_000i64;
        let offer = |to: &str, v: u64, ts: i64| { let mut c = offer_content(&e_pub, &nonce, ts); c["to"] = to.into(); c["v"] = v.into(); c };
        assert_eq!(classify(&offer("me", 1, now), "me", "other", now, None), Delivered::Offer(PendingOffer { from_device: "other".into(), e_pub, nonce, ts: now }));
        assert_eq!(classify(&offer("someone-else", 1, now), "me", "other", now, None), Delivered::Ignored, "addressed to another device");
        assert_eq!(classify(&offer("me", 2, now), "me", "other", now, None), Delivered::Ignored, "unknown version");
        assert_eq!(classify(&offer("me", 1, now - OFFER_MAX_AGE_MS - 1), "me", "other", now, None), Delivered::Ignored, "stale offer");
        assert_eq!(classify(&offer("me", 1, now), "me", "me", now, None), Delivered::Ignored, "never from this device");
        let mut short = offer("me", 1, now);
        short["e_pub"] = "AAAA".into();
        assert_eq!(classify(&short, "me", "other", now, None), Delivered::Ignored, "a key of the wrong size");
        // answers and messages need a running session with the SAME nonce and the SAME peer device
        let (r, mut ans, mut msgs) = route(nonce, "other");
        let mut a = answer_content(&nonce, Some(&e_pub));
        a["to"] = "me".into();
        assert_eq!(classify(&a, "me", "other", now, Some(&r)), Delivered::Routed);
        assert!(ans.try_recv().unwrap().e_pub == Some(e_pub));
        assert_eq!(classify(&a, "me", "intruder", now, Some(&r)), Delivered::Ignored, "an answer from a different device");
        assert_eq!(classify(&a, "me", "other", now, None), Delivered::Ignored, "no session is waiting");
        let mut other_nonce = a.clone();
        other_nonce["nonce"] = b64url(&random16()).into();
        assert_eq!(classify(&other_nonce, "me", "other", now, Some(&r)), Delivered::Ignored, "a different session's nonce");
        let mut b = answer_busy(&nonce);
        b["to"] = "me".into();
        assert_eq!(classify(&b, "me", "other", now, Some(&r)), Delivered::Routed);
        let got = ans.try_recv().unwrap();
        assert!(got.declined && got.busy && got.rev == ANSWER_REV, "a busy decline is told apart from a person's no");
        let mut old_decline = answer_content(&nonce, None);
        old_decline["to"] = "me".into();
        old_decline.as_object_mut().unwrap().remove("rev");
        old_decline["busy"] = true.into();
        old_decline["declined"] = true.into();
        assert_eq!(classify(&old_decline, "me", "other", now, Some(&r)), Delivered::Routed);
        let got = ans.try_recv().unwrap();
        assert_eq!((got.rev, got.busy), (1, true), "an answer without `rev` is revision 1");
        let mut empty = answer_content(&nonce, None);
        empty["to"] = "me".into();
        empty.as_object_mut().unwrap().remove("declined");
        assert_eq!(classify(&empty, "me", "other", now, Some(&r)), Delivered::Ignored, "neither a key nor a decline");
        let m = |body: String| json!({ "type": "near_msg", "v": 1, "nonce": b64url(&nonce), "from": "a", "seq": 1, "body_b64": body, "to": "me" });
        assert_eq!(classify(&m(b64url(&[1u8; 40])), "me", "other", now, Some(&r)), Delivered::Routed);
        assert_eq!(msgs.try_recv().unwrap().0, 1);
        assert_eq!(classify(&m("A".repeat(2049)), "me", "other", now, Some(&r)), Delivered::Ignored, "oversize body");
        assert_eq!(classify(&m(String::new()), "me", "other", now, Some(&r)), Delivered::Ignored);
    }

    // ---- interop with the phone core's own-device code (native 30ea21d5, core/cl-sync/src/near/own.rs) ----------------------
    //
    // The phone exports no serialized examples (no vector file, no test fixture), so these are TRANSCRIBED from its serializer code, line
    // for line: `offer_content` / `answer_content` build `json!({ "type": "near_offer", "v": 1, "e_pub": b64url(e_pub), "nonce":
    // b64url(nonce), "ts": now_ms() })` / `{ "type": "near_answer", "v": 1, "nonce", "e_pub" | "declined": true }`; `OwnPeer::send` builds
    // `{ "type": "near_msg", "v": 1, "nonce": b64url(nonce), "from": side.relay_char().to_string(), "seq": seq, "body_b64": b64url(body) }`
    // sealed with `seal_with_nonce(K_relay, relay_aad("own:" + requesterDevice, side, seq), iv, serde_json(Message))`, and `EngineOwnSend`
    // appends `"to": <device>`. b64url = `b64_nopad` with `+`->`-` and `/`->`_` (== unpadded URL-safe base64). What is NOT proven: a real phone
    // build producing these bytes (only its source, read), and the page/E2EE transport that carries them (tested on the page side).

    /// The phone's `b64url`, written the way ITS source writes it (not this module's helper).
    fn phone_b64url(b: &[u8]) -> String {
        cl_crypto::encoding::b64_nopad(b).replace('+', "-").replace('/', "_")
    }

    #[test]
    fn the_phones_serialized_offer_answer_and_decline_are_understood_and_ours_are_what_it_parses() {
        let (_, e_pub) = keys::generate_keypair();
        let nonce = random16();
        let now = 1_763_500_000_000i64;
        // phone -> desktop: exactly what the phone's `offer_content` + `EngineOwnSend` produce
        let phone_offer = json!({ "type": "near_offer", "v": 1, "e_pub": phone_b64url(&e_pub), "nonce": phone_b64url(&nonce), "ts": now, "to": "desktop-dev" });
        assert_eq!(classify(&phone_offer, "desktop-dev", "phone-dev", now + 5_000, None), Delivered::Offer(PendingOffer { from_device: "phone-dev".into(), e_pub, nonce, ts: now }));
        let phone_answer = json!({ "type": "near_answer", "v": 1, "nonce": phone_b64url(&nonce), "e_pub": phone_b64url(&e_pub), "to": "desktop-dev" });
        let phone_decline = json!({ "type": "near_answer", "v": 1, "nonce": phone_b64url(&nonce), "declined": true, "to": "desktop-dev" });
        let (r, mut ans, _m) = route(nonce, "phone-dev");
        assert_eq!(classify(&phone_answer, "desktop-dev", "phone-dev", now, Some(&r)), Delivered::Routed);
        let a = ans.try_recv().unwrap();
        assert_eq!((a.e_pub, a.declined), (Some(e_pub), false));
        assert_eq!(classify(&phone_decline, "desktop-dev", "phone-dev", now, Some(&r)), Delivered::Routed);
        let d = ans.try_recv().unwrap();
        assert_eq!((d.e_pub, d.declined), (None, true));
        // desktop -> phone: our builders produce the same JSON, key for key and value for value (the phone ignores key order)
        let mut mine = offer_content(&e_pub, &nonce, now);
        mine["to"] = "desktop-dev".into();
        assert_eq!(mine, phone_offer);
        assert_eq!(mine.as_object().unwrap().keys().collect::<Vec<_>>(), ["type", "v", "e_pub", "nonce", "ts", "to"], "the phone's field order too");
        // (answers also carry `rev: 2`, a field the phone's parser never reads: it takes `declined` / `e_pub` only)
        let strip_rev = |mut v: Value| { assert_eq!(v.as_object_mut().unwrap().remove("rev"), Some(json!(ANSWER_REV))); v };
        let mut mine = answer_content(&nonce, Some(&e_pub));
        mine["to"] = "desktop-dev".into();
        assert_eq!(strip_rev(mine), phone_answer);
        let mut mine = answer_content(&nonce, None);
        mine["to"] = "desktop-dev".into();
        assert_eq!(strip_rev(mine), phone_decline);
        // a busy decline is still a decline for an older phone (it reads `declined: true` and nothing else)
        let mut busy = answer_busy(&nonce);
        busy["to"] = "desktop-dev".into();
        assert_eq!(busy["declined"], true);
        assert_eq!(busy["busy"], true);
        // sizes the phone's `dec32` / `dec16` insist on
        assert_eq!((phone_b64url(&e_pub).len(), phone_b64url(&nonce).len()), (43, 22));
    }

    #[tokio::test]
    async fn a_near_msg_sealed_by_the_phones_formula_opens_here_and_ours_opens_by_the_phones_formula() {
        let (en_priv, en_pub) = keys::generate_keypair();
        let (ea_priv, ea_pub) = keys::generate_keypair();
        let nonce = random16();
        // the phone (holder, side A) and this desktop (requester, side N) derive the same keys; the requester's device id names the link
        let link = format!("own:{}", "desktop-dev");
        let kn = keys::session_keys(&en_priv, &ea_pub, &nonce, &link).unwrap();
        let ka = keys::session_keys(&ea_priv, &en_pub, &nonce, &link).unwrap();
        // phone -> desktop: the phone's `OwnPeer::send` formula (side A, seq 1), delivered through `classify`'s route into our pipe
        let msg = Message::status("checking_lan", None);
        let pt = serde_json::to_vec(&msg).unwrap();
        let body = seal_with_nonce(&ka.relay, &relay_aad(&link, Side::A, 1), [3u8; 12], &pt).unwrap();
        let phone_near_msg = json!({ "type": "near_msg", "v": 1, "nonce": phone_b64url(&nonce), "from": Side::A.relay_char().to_string(), "seq": 1, "body_b64": phone_b64url(&body), "to": "desktop-dev" });
        assert_eq!(phone_near_msg["from"], "a");
        let (r, _ans, mut msgs) = route(nonce, "phone-dev");
        assert_eq!(classify(&phone_near_msg, "desktop-dev", "phone-dev", 0, Some(&r)), Delivered::Routed);
        let (mtx, mrx) = mpsc::unbounded_channel();
        let out = Arc::new(Chan(Default::default()));
        let mut desktop = OwnPipe::new(Side::N, "desktop-dev", nonce, "phone-dev", kn, out.clone(), mrx);
        mtx.send(msgs.try_recv().unwrap()).unwrap();
        assert_eq!(desktop.recv(Duration::from_millis(200)).await.unwrap(), msg, "the phone's sealed message opens on the desktop");
        // desktop -> phone: our message, opened with the phone's `OwnPeer::recv` formula (aad names the SENDER's side, here N)
        desktop.send(&Message::abort("cancelled")).await.unwrap();
        let sent = out.0.lock().unwrap()[0].1.clone();
        assert_eq!(sent.as_object().unwrap().keys().collect::<Vec<_>>(), ["type", "v", "nonce", "from", "seq", "body_b64", "to"], "the phone's near_msg fields, in its order");
        assert_eq!((sent["type"].as_str(), sent["from"].as_str(), sent["seq"].as_u64(), sent["v"].as_u64(), sent["to"].as_str()), (Some("near_msg"), Some("n"), Some(1), Some(1), Some("phone-dev")));
        assert_eq!(sent["nonce"].as_str().unwrap(), phone_b64url(&nonce));
        let raw = cl_crypto::encoding::from_b64_node(sent["body_b64"].as_str().unwrap());
        let opened = open_body(&ka.relay, &relay_aad(&link, Side::N, 1), &raw).expect("the phone's formula opens our message");
        assert_eq!(serde_json::from_slice::<Message>(&opened).unwrap(), Message::abort("cancelled"));
        // and the other side's aad does not (the phone drops it)
        assert!(open_body(&ka.relay, &relay_aad(&link, Side::A, 1), &raw).is_err());
    }
}

#[cfg(test)]
mod cooldown_tests {
    use super::*;
    #[test]
    fn three_declines_in_ten_minutes_mute_that_device_for_ten_minutes() {
        let mut c = OfferCooldown::default();
        let t0 = 1_000_000i64;
        c.record_decline("d1", t0);
        c.record_decline("d1", t0 + 60_000);
        assert!(!c.muted("d1", t0 + 61_000), "two declines are not enough");
        c.record_decline("d1", t0 + 120_000);
        assert!(c.muted("d1", t0 + 121_000));
        assert!(!c.muted("d2", t0 + 121_000), "per device");
        assert!(c.muted("d1", t0 + 120_000 + COOLDOWN_MUTE_MS - 1));
        assert!(!c.muted("d1", t0 + 120_000 + COOLDOWN_MUTE_MS), "the mute ends");
    }
    #[test]
    fn declines_older_than_the_window_do_not_count() {
        let mut c = OfferCooldown::default();
        c.record_decline("d", 0);
        c.record_decline("d", 1);
        c.record_decline("d", COOLDOWN_WINDOW_MS + 5); // the first two aged out
        assert!(!c.muted("d", COOLDOWN_WINDOW_MS + 6));
    }
}
