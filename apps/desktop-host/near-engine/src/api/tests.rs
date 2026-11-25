//! Tests against the in-process fake link server (`near::fake_server`; what it mirrors and does not is
//! documented there).
use super::*;
use base64::Engine as _;
use crate::fake_server::Fake;

/// A fresh relay token and the hash the server is given for it.
fn tok() -> (Arc<RelayToken>, String) {
    let t = Arc::new(RelayToken::generate());
    let h = t.auth_hash_b64();
    (t, h)
}

#[test]
fn base_policy_allows_only_cipherline_api_hosts() {
    assert!(check_base("https://api.cipherline.chat").is_ok());
    assert!(check_base("https://api-staging.cipherline.chat/").is_ok());
    for bad in ["http://api.cipherline.chat", "https://evil.example", "https://api.cipherline.chat.evil.example", "https://u:p@api.cipherline.chat", "https://api.cipherline.chat/v1", "https://api.cipherline.chat:8443", "http://localhost:3005", "http://10.0.0.1:3005", "file:///etc/passwd"] {
        assert!(check_base(bad).is_err(), "{bad}");
    }
    assert!(LinkApi::new("https://evil.example", Some(Auth { access_token: "t".into(), device_id: "d".into() }), None, "1").is_err(), "the token can never be pointed at another host");
}

#[test]
fn headers_new_device_is_anonymous_approver_carries_token_and_device() {
    let f = Fake::start();
    let approver = f.api(Some("dev-A"), Some("attest-secret"));
    let (token, hash) = tok();
    let c = approver.anonymous().create_near_session("ek", "New PC", "windows", "idk", None, &hash).unwrap();
    approver.scan(&c.link_id).unwrap();
    approver.relay_post(&c.link_id, Side::A, 1, b"hi").unwrap();
    approver.anonymous().with_relay_token(token).relay_post(&c.link_id, Side::N, 1, b"yo").unwrap();
    let g = f.st.lock().unwrap();
    let find = |k: &str, n: usize| g.seen_headers.iter().filter(|(p, _)| p.contains(k)).nth(n).unwrap().1.clone();
    let create = find("POST /v1/link/sessions", 0);
    assert!(!create.contains_key("authorization") && !create.contains_key("x-device-id"), "the new device sends no credentials");
    assert_eq!(create["x-cipherline-version"], "9.9.9");
    assert!(create.contains_key("x-cipherline-attest"));
    let a_post = find("/relay", 0);
    assert_eq!(a_post["authorization"], "Bearer tok-secret");
    assert_eq!(a_post["x-device-id"], "dev-A");
    let n_post = find("/relay", 1);
    assert!(!n_post.contains_key("authorization") && !n_post.contains_key("x-device-id"));
    let create_body = g.seen_headers.iter().filter(|(p, _)| p.contains("POST /v1/link/sessions")).count();
    assert!(create_body >= 1);
}

#[test]
fn relay_round_trip_binary_bodies_and_after_cursor() {
    let f = Fake::start();
    let a = f.api(Some("dev-A"), None);
    let c = a.anonymous().create_near_session("ek", "x", "windows", "idk", None, &tok().1).unwrap();
    a.scan(&c.link_id).unwrap();
    let body: Vec<u8> = (0..=255u8).collect();
    a.relay_post(&c.link_id, Side::A, 1, &body).unwrap();
    a.relay_post(&c.link_id, Side::A, 5, b"second").unwrap();
    let n = a.anonymous();
    let b = n.relay_fetch(&c.link_id, Side::N, 0).unwrap();
    assert_eq!(b.messages, vec![RelayItem { seq: 1, body: body.clone() }, RelayItem { seq: 5, body: b"second".to_vec() }]);
    assert_eq!(b.expires_in_s, 120);
    assert_eq!(n.relay_fetch(&c.link_id, Side::N, 1).unwrap().messages.len(), 1, "after is the OTHER side's seq");
}

#[test]
fn relay_rules_seq_cap_and_pin_map_to_stable_codes() {
    let f = Fake::start();
    let a = f.api(Some("dev-A"), None);
    let c = a.anonymous().create_near_session("ek", "x", "windows", "idk", None, &tok().1).unwrap();
    // side a before any scan: not pinned
    assert_eq!(a.relay_post(&c.link_id, Side::A, 1, b"x").unwrap_err().code, "link_not_scanned");
    a.scan(&c.link_id).unwrap();
    // a second device cannot take the pin or speak as a
    let other = f.api(Some("dev-B"), None);
    let e = other.scan(&c.link_id).unwrap_err();
    assert_eq!((e.status, e.code.as_str()), (409, "link_already_scanning"));
    assert_eq!(other.relay_post(&c.link_id, Side::A, 1, b"x").unwrap_err().code, "link_wrong_account");
    a.relay_post(&c.link_id, Side::A, 2, b"x").unwrap();
    assert_eq!(a.relay_post(&c.link_id, Side::A, 2, b"x").unwrap_err().code, "link_relay_seq");
    assert_eq!(a.relay_post(&c.link_id, Side::A, 1, b"x").unwrap_err().code, "link_relay_seq");
    for i in 3..=33u64 {
        a.relay_post(&c.link_id, Side::A, i, b"x").unwrap();
    }
    let full = a.relay_post(&c.link_id, Side::A, 40, b"x").unwrap_err();
    assert_eq!(full.code, "link_relay_full");
    assert!(matches!(NearError::from(full), NearError::RelayLimit(_)), "the cap surfaces as cl-near's RelayLimit");
}

#[test]
fn typed_lookup_hits_misses_uniformly_and_locks_after_five() {
    let f = Fake::start();
    let n = f.api(None, None);
    let hash = "a".repeat(64);
    let c = n.create_near_session("EK", "x", "windows", "idk", Some(&hash), &tok().1).unwrap();
    assert_eq!(n.create_near_session("EK", "x", "windows", "idk", Some(&hash), &tok().1).unwrap_err().code, "link_near_code_in_use");
    let a = f.api(Some("dev-A"), None);
    let l = a.lookup(&hash).unwrap();
    assert_eq!((l.link_id.as_str(), l.ek_pub_b64.as_str()), (c.link_id.as_str(), "EK"));
    for _ in 0..5 {
        let e = a.lookup(&"b".repeat(64)).unwrap_err();
        assert_eq!((e.status, e.code.as_str()), (404, "link_near_code_unknown"));
    }
    let locked = a.lookup(&hash).unwrap_err();
    assert_eq!((locked.status, locked.code.as_str(), locked.retry_after_s), (429, "link_near_locked", Some(600)), "even the right code is refused once the budget is spent");
}

#[test]
fn approve_grant_claim_flow_and_error_shapes() {
    let f = Fake::start();
    let a = f.api(Some("dev-A"), None);
    let n = a.anonymous();
    let c = n.create_near_session("ek", "x", "windows", "idk", None, &tok().1).unwrap();
    let info = a.scan(&c.link_id).unwrap();
    assert!(info.near && info.device_label == "x" && info.platform.as_deref() == Some("windows"));
    let bad = a.approve_near(&c.link_id, "bad", 1, "lan").unwrap_err();
    assert_eq!((bad.status, bad.code.as_str(), bad.attempts_left), (403, "link_proximity_bad_signature", Some(4)));
    let ok = a.approve_near(&c.link_id, "sig", 1, "ble").unwrap();
    assert_eq!((ok.user_id.as_str(), ok.approved_by_device_id.as_str()), ("u1", "dev-A"));
    assert_eq!(n.poll_session(&c.link_id).unwrap().state, "approving");
    a.grant(&c.link_id, "ENV").unwrap();
    let p = n.poll_session(&c.link_id).unwrap();
    assert_eq!((p.state.as_str(), p.envelope_b64.as_deref()), ("granted", Some("ENV")));
    assert_eq!(n.claim(&c.link_id, "wrong").unwrap_err().status, 403);
    let t = n.claim(&c.link_id, &ok.claim_secret).unwrap();
    assert_eq!(t["user_id"], "u1");
    assert_eq!(n.claim(&c.link_id, &ok.claim_secret).unwrap_err().status, 409, "single use");
}

#[test]
fn unreachable_server_is_a_network_error_without_secrets() {
    let api = LinkApi::new("http://127.0.0.1:9", Some(Auth { access_token: "tok-secret".into(), device_id: "d".into() }), None, "1").unwrap();
    let e = api.scan("x").unwrap_err();
    assert_eq!((e.status, e.code.as_str()), (0, "network"));
    assert!(!e.to_string().contains("tok-secret"));
}

#[tokio::test]
async fn http_relay_drives_cl_near_hello_both_ways() {
    use cl_near::code::{build_near, parse_near, ProximitySecret};
    use cl_near::relay::{Message, RelayPeer};
    let f = Fake::start();
    let a_api = f.api(Some("dev-A"), None);
    let (en_priv, en_pub) = cl_near::keys::generate_keypair();
    let (token, hash) = tok();
    let ik = [7u8; 32];
    let ik_b64 = base64::engine::general_purpose::STANDARD.encode(ik);
    let created = a_api.anonymous().create_near_session("ek", "x", "windows", &ik_b64, None, &hash).unwrap();
    let info = a_api.scan(&created.link_id).unwrap();
    assert_eq!(info.identity_key_pub_b64.as_deref(), Some(ik_b64.as_str()));
    let secret = ProximitySecret::generate();
    let uri = build_near(&created.link_id, &en_pub, &secret);
    let code = parse_near(&uri).unwrap();
    let t = Duration::from_secs(10);
    let (a_t, n_t) = (HttpRelay::new(&a_api, Side::A, &created.link_id), HttpRelay::new(&a_api.with_relay_token(token), Side::N, &created.link_id));
    let (sec2, lid) = (secret.clone(), created.link_id.clone());
    let n_task = tokio::spawn(async move { RelayPeer::new_device_accept(n_t, &lid, &en_priv, &ik, move || vec![sec2.clone()], t).await });
    let mut a = RelayPeer::approver_connect(a_t, &code.link_id, &code.en_pub, &code.secret, &ik, t).await.unwrap();
    let mut n = n_task.await.unwrap().unwrap();
    a.send(&Message::abort("no_proximity")).await.unwrap();
    assert!(matches!(n.recv(t).await.unwrap(), Message::Abort { .. }));
}

#[test]
fn session_lifetime_extends_on_relay_activity_to_five_minutes_and_expires_authoritatively() {
    let f = Fake::start();
    let a = f.api(Some("dev-A"), None);
    let c = a.anonymous().create_near_session("ek", "x", "windows", "idk", None, &tok().1).unwrap();
    a.scan(&c.link_id).unwrap();
    assert_eq!(a.relay_fetch(&c.link_id, Side::A, 0).unwrap().expires_in_s, 120);
    f.advance(100);
    assert_eq!(a.relay_fetch(&c.link_id, Side::A, 0).unwrap().expires_in_s, 120, "activity at t=100 renews 120 s");
    f.advance(100); // t=200: renewed again, but only up to the 300 s cap
    assert_eq!(a.relay_fetch(&c.link_id, Side::A, 0).unwrap().expires_in_s, 100);
    f.advance(50); // t=250
    assert_eq!(a.relay_fetch(&c.link_id, Side::A, 0).unwrap().expires_in_s, 50, "capped at 300 s from creation");
    f.advance(60);
    assert_eq!(a.anonymous().poll_session(&c.link_id).unwrap().state, "expired");
}

#[test]
fn invite_flow_owner_is_pinned_and_sees_the_join() {
    let f = Fake::start();
    let a = f.api(Some("dev-A"), None);
    let inv = a.create_invite().unwrap();
    assert_eq!(a.poll_invite(&inv.link_id).unwrap().state, "pending");
    let r = a.anonymous().poll_invite(&inv.link_id);
    assert_eq!(r.unwrap_err().status, 401);
    let body = json!({ "ek_pub_b64": "EK", "device_label": "Phone", "platform": "ios", "identity_key_pub_b64": "IK", "near": true, "relay_auth_b64": tok().1 });
    // join is unauthenticated: go through the raw agent via a second LinkApi
    let n = a.anonymous();
    let v = n.join_invite_for_tests(&inv.link_id, body).unwrap();
    assert_eq!(v["link_id"], json!(inv.link_id));
    let p = a.poll_invite(&inv.link_id).unwrap();
    assert!(p.near && p.ek_pub_b64.as_deref() == Some("EK") && p.device_label.as_deref() == Some("Phone"));
    a.relay_post(&inv.link_id, Side::A, 1, b"x").unwrap();
    assert_eq!(f.api(Some("dev-B"), None).relay_post(&inv.link_id, Side::A, 1, b"x").unwrap_err().code, "link_wrong_account");
}

// ---- v14 server rules (security review 2026-11-20) the desktop client must meet, enforced by the fake the way the real server does

#[test]
fn a_near_session_without_the_relay_hash_is_refused_at_create() {
    let f = Fake::start();
    let n = f.api(None, None);
    let mut b = json!({ "ek_pub_b64": "ek", "device_label": "x", "platform": "windows", "identity_key_pub_b64": "idk", "near": true });
    let e = n.join_invite_for_tests("nope", b.clone()).unwrap_err();
    assert_eq!(e.status, 404);
    // the create route itself
    let r = FakeRaw::post(&f, "/v1/link/sessions", &b);
    assert_eq!(r, 400, "no relay_auth_b64");
    b["relay_auth_b64"] = json!("not-base64!");
    assert_eq!(FakeRaw::post(&f, "/v1/link/sessions", &b), 400, "malformed");
    b["relay_auth_b64"] = json!(tok().1);
    assert_eq!(FakeRaw::post(&f, "/v1/link/sessions", &b), 201);
}

struct FakeRaw;
impl FakeRaw {
    fn post(f: &Fake, path: &str, body: &Value) -> u16 {
        match ureq::post(&format!("{}{}", f.base(), path)).set("Content-Type", "application/json").send_string(&body.to_string()) {
            Ok(r) => r.status(),
            Err(ureq::Error::Status(c, _)) => c,
            Err(e) => panic!("{e}"),
        }
    }
}

#[test]
fn side_n_needs_the_token_and_the_wrong_one_is_the_uniform_404() {
    let f = Fake::start();
    let a = f.api(Some("dev-A"), None);
    let (token, hash) = tok();
    let c = a.anonymous().create_near_session("ek", "x", "windows", "idk", None, &hash).unwrap();
    a.scan(&c.link_id).unwrap();
    // an api without the token cannot even build a side-n post (and would only get a 404 from the server)
    let e = a.anonymous().relay_post(&c.link_id, Side::N, 1, b"x").unwrap_err();
    assert_eq!(e.code, "no_relay_token");
    // somebody who saw the QR (but never had the token) is refused as an unknown session
    let (other, _) = tok();
    let e = a.anonymous().with_relay_token(other).relay_post(&c.link_id, Side::N, 1, b"x").unwrap_err();
    assert_eq!(e.status, 404);
    assert_eq!(f.st.lock().unwrap().sessions[&c.link_id].n.len(), 0, "a refused post stores nothing");
    a.anonymous().with_relay_token(token).relay_post(&c.link_id, Side::N, 1, b"x").unwrap();
    // the token is never in a header
    let g = f.st.lock().unwrap();
    assert!(g.seen_headers.iter().all(|(_, h)| h.values().all(|v| !v.contains("auth_b64"))));
}

#[test]
fn a_seq_far_ahead_is_refused_and_does_not_extend_the_lifetime() {
    let f = Fake::start();
    let a = f.api(Some("dev-A"), None);
    let c = a.anonymous().create_near_session("ek", "x", "windows", "idk", None, &tok().1).unwrap();
    a.scan(&c.link_id).unwrap();
    f.advance(100);
    let e = a.relay_post(&c.link_id, Side::A, 10, b"x").unwrap_err();
    assert_eq!(e.status, 400, "seq must be <= count + 8");
    assert_eq!(a.anonymous().poll_session(&c.link_id).unwrap().expires_in_s, Some(20), "the refused post bought no time");
    a.relay_post(&c.link_id, Side::A, 8, b"x").unwrap();
}

#[test]
fn the_scan_pin_is_provisional_until_the_first_valid_post_and_can_be_taken_over_after_ten_seconds() {
    let f = Fake::start();
    let a = f.api(Some("dev-A"), None);
    let b = f.api(Some("dev-B"), None);
    let c = a.anonymous().create_near_session("ek", "x", "windows", "idk", None, &tok().1).unwrap();
    a.scan(&c.link_id).unwrap();
    let e = b.scan(&c.link_id).unwrap_err();
    assert_eq!((e.status, e.code.as_str()), (409, "link_already_scanning"), "inside 10 s");
    f.advance(11);
    b.scan(&c.link_id).unwrap();
    // the first device lost it: its next relay calls say so
    assert_eq!(a.relay_post(&c.link_id, Side::A, 1, b"x").unwrap_err().code, "link_wrong_account");
    assert_eq!(a.relay_fetch(&c.link_id, Side::A, 0).unwrap_err().code, "link_wrong_account");
    // once the pinned approver posts, the pin is final
    b.relay_post(&c.link_id, Side::A, 1, b"x").unwrap();
    f.advance(30);
    assert_eq!(a.scan(&c.link_id).unwrap_err().code, "link_already_scanning");
}
