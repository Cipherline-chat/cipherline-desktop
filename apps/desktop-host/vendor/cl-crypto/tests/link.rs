//! Link grant / approval vectors generated from desktop's real `link-grant.ts` and the API's
//! `device-approval.util.ts` (oracle). Also writes a Rust-sealed envelope for the reverse check.
use cl_crypto::encoding::{from_b64_node, hex};
use cl_crypto::link::*;
use serde_json::Value;

fn vectors() -> Value {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../test-vectors/link-grant.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

#[test]
fn opens_what_desktop_sealed() {
    for g in vectors()["grants"].as_array().unwrap() {
        let s = |k: &str| g[k].as_str().unwrap();
        let priv_raw = cl_crypto::encoding::from_hex(s("ek_priv_hex")).unwrap();
        let got = open_link_grant(s("envelope_b64"), &priv_raw, s("ek_pub_b64"), s("link_id")).unwrap();
        assert_eq!(got.claim_secret.as_deref(), g["payload"]["claim_secret"].as_str());
        assert_eq!(got.user_id, g["payload"]["user_id"].as_str().unwrap());
        assert_eq!(got.approved_by_device_name, g["payload"]["approved_by_device_name"].as_str().unwrap());
    }
}

#[test]
fn fingerprints_codes_and_messages_match_desktop() {
    let v = vectors();
    for f in v["fingerprints"].as_array().unwrap() {
        assert_eq!(link_fingerprint(f["ek_pub_b64"].as_str().unwrap()).unwrap(), f["fingerprint"].as_str().unwrap());
    }
    let c = &v["approval_codes"][0];
    assert_eq!(derive_approval_code(c["user_id"].as_str().unwrap(), c["key"].as_str().unwrap(), c["nonce"].as_str().unwrap()), c["code"].as_str().unwrap());
    let m = &v["messages"];
    assert_eq!(link_approve_message("u", "dev", "LID", Some("KEY"), 1780000000), m["link_approve"]["msg"].as_str().unwrap());
    assert_eq!(link_approve_message("u", "dev", "LID", None, 5), m["link_approve"]["none"].as_str().unwrap());
    assert_eq!(approval_decision_message("u", "a", "p", "K", true, 9), m["decision"]["approve"].as_str().unwrap());
    assert_eq!(approval_decision_message("u", "a", "p", "K", false, 9), m["decision"]["deny"].as_str().unwrap());
}

/// Emits a Rust-sealed envelope to the path in `LINK_RUST_SEAL_OUT` so the oracle can open it.
#[test]
fn rust_sealed_envelope_for_desktop_to_open() {
    let (sk, pk) = new_link_keypair();
    let id = "AbCdEfGhIjKlMnOpQrStUv";
    let secret = "b".repeat(43);
    let env = seal_link_grant_v2(id, "u9", &secret, "d9", "Phone", "2026-11-14T00:00:00Z", &pk).unwrap();
    assert!(from_b64_node(&env).len() > 50);
    if let Ok(out) = std::env::var("LINK_RUST_SEAL_OUT") {
        let j = serde_json::json!({ "envelope_b64": env, "ek_priv_hex": hex(sk.as_ref()), "ek_pub_b64": pk, "link_id": id });
        std::fs::write(out, j.to_string()).unwrap();
    }
}

fn qr_vectors() -> Value {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../test-vectors/link-qr.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// QR strings produced by desktop's real `linkQr.ts` (`tools/qr-rig qrvectors`): native parses each, and rebuilds the SAME bytes.
#[test]
fn parses_and_rebuilds_what_desktop_renders() {
    let v = qr_vectors();
    let links = v["links"].as_array().unwrap();
    assert!(links.len() >= 6);
    // The set must include keys whose standard base64 has '+' and '/' (the base64url conversion is where ports go wrong).
    assert!(links.iter().any(|l| l["ek_pub_b64"].as_str().unwrap().contains('+')));
    assert!(links.iter().any(|l| l["ek_pub_b64"].as_str().unwrap().contains('/')));
    for l in links {
        let (id, ek, text) = (l["link_id"].as_str().unwrap(), l["ek_pub_b64"].as_str().unwrap(), l["text"].as_str().unwrap());
        assert_eq!(parse_link_qr(text), Some(LinkQr::Link { link_id: id.into(), ek_pub_b64: ek.into() }), "{text}");
        assert_eq!(build_link_qr(id, ek), text);
    }
    for i in v["invites"].as_array().unwrap() {
        let (id, text) = (i["invite_id"].as_str().unwrap(), i["text"].as_str().unwrap());
        assert_eq!(parse_link_qr(text), Some(LinkQr::Invite { invite_id: id.into() }));
        assert_eq!(build_invite_qr(id), text);
    }
}

/// What desktop refuses to emit cleanly (a hostile server-supplied id) native must also refuse to act on.
#[test]
fn refuses_desktops_percent_encoded_hostile_ids() {
    for h in qr_vectors()["hostile"].as_array().unwrap() {
        assert_eq!(parse_link_qr(h["text"].as_str().unwrap()), None, "{}", h["why"]);
    }
}
