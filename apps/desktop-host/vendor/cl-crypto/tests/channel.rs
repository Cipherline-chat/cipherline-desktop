//! Channel messages against desktop's G4 vectors (`channel-binding-v2.json`) and the Sender-Key
//! vectors (`channel-sender-key.json`). Every `expect` there is what the REAL desktop engine
//! returned or threw.
mod common;
use std::collections::HashMap;

use cl_crypto::channel::{
    self, channel_message_id_tag, channel_replay_key, oldest_first, ChannelArrival, ChannelError, ChannelKeyring,
    ChannelSender, ReplayLedger, SetKeyResult,
};
use cl_crypto::encoding::from_b64;
use cl_crypto::keys;
use common::{s, vectors};
use serde_json::Value;
use zeroize::Zeroizing;

fn keyring_from(v: &Value) -> ChannelKeyring {
    let mut ring = ChannelKeyring::new();
    for k in v["keys"].as_array().unwrap() {
        let r = ring
            .set(s(k, "channel_id"), k["epoch"].as_i64().unwrap(), s(k, "key_b64"), "2030-01-01T00:00:00.000Z", None)
            .unwrap();
        assert_eq!(r, SetKeyResult::Stored);
    }
    ring
}

fn opt(v: &Value, k: &str) -> Option<String> {
    v[k].as_str().map(str::to_owned)
}

/// Decrypt one arrival through the keyring, then claim the ledger exactly as the pipeline does.
fn receive(ring: &ChannelKeyring, ledger: Option<&mut ReplayLedger>, a: &Value) -> Result<String, ChannelError> {
    let (uid, did) = (opt(a, "sender_user_id"), opt(a, "sender_device_id"));
    let channel_id = s(a, "channel_id");
    let arrival = ChannelArrival {
        channel_id,
        epoch: a["epoch"].as_u64().unwrap() as u32,
        nonce_b64: s(a, "nonce_b64"),
        ciphertext_b64: s(a, "ciphertext_b64"),
        signature_b64: s(a, "signature_b64"),
        sender_identity_pub_b64: s(a, "sender_identity_pub_b64"),
        sender_user_id: uid.as_deref(),
        sender_device_id: did.as_deref(),
    };
    let opened = channel::open_channel_message(&arrival, |e| ring.key(channel_id, e))?;
    if let Some(ledger) = ledger {
        ledger.claim(channel_id, &opened.nonce_canon, s(a, "message_id"))?;
    }
    Ok(opened.content_json)
}

fn check(name: &str, got: Result<String, ChannelError>, expect: &Value) {
    if expect["ok"].as_bool().unwrap() {
        assert_eq!(got.as_deref().map_err(ToString::to_string), Ok(s(expect, "content_json")), "{name}");
        return;
    }
    let err = got.expect_err(name);
    let want = expect["error"].as_str().or_else(|| expect["error_code"].as_str()).unwrap();
    assert_eq!(err.tag(), expect["tag"].as_str(), "{name}: tag");
    // Desktop's text is matched exactly for every error this port raises itself.
    assert_eq!(err.to_string(), want, "{name}: message");
}

#[test]
fn binding_decrypt_cases_match_desktop() {
    let v = vectors("channel-binding-v2.json");
    let ring = keyring_from(&v);
    let cases = v["decrypt_cases"].as_array().unwrap();
    assert_eq!(cases.len(), 27);
    for c in cases {
        check(s(c, "name"), receive(&ring, None, &c["arrival"]), &c["expect"]);
    }
}

#[test]
fn replay_sequences_match_desktop() {
    let v = vectors("channel-binding-v2.json");
    let ring = keyring_from(&v);
    for seq in v["sequences"].as_array().unwrap() {
        let name = s(seq, "name");
        let mut ledger = ReplayLedger::new();
        for (i, step) in seq["steps"].as_array().unwrap().iter().enumerate() {
            let got = receive(&ring, Some(&mut ledger), &step["arrival"]);
            let expect = &step["expect"];
            if expect["ok"].as_bool().unwrap() {
                assert_eq!(got.map_err(|e| e.to_string()).as_deref(), Ok(s(expect, "content_json")), "{name} step {i}");
            } else {
                let err = got.expect_err(name).to_string();
                let want = expect["error"].as_str().unwrap();
                assert!(err == want, "{name} step {i}: {err} != {want}");
            }
            if seq["restart_after_step"].as_u64() == Some(i as u64) {
                // A restart reloads the ledger from its persisted entries.
                ledger = ReplayLedger::from_entries(ledger.entries().clone());
            }
        }
    }
}

#[test]
fn ledger_keys_match_desktop() {
    let v = vectors("channel-binding-v2.json");
    for e in v["ledger_entries"].as_array().unwrap() {
        assert_eq!(channel_replay_key(s(e, "channel_id"), s(e, "nonce_canonical_b64")), s(e, "replay_key"));
        assert_eq!(channel_message_id_tag(s(e, "message_id")), s(e, "id_tag"));
    }
}

#[test]
fn oldest_first_matches_desktop() {
    let v = vectors("channel-binding-v2.json");
    let rows: Vec<(String, String)> = v["oldest_first"]["input"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (s(r, "id").to_owned(), s(r, "created_at").to_owned()))
        .collect();
    let ids: Vec<String> = oldest_first(rows, |r| &r.1).into_iter().map(|r| r.0).collect();
    let want: Vec<&str> = v["oldest_first"]["expected_ids"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
    assert_eq!(ids, want);
}

/// Re-seal every desktop G4 message with ITS nonce and message id: the plaintext and the
/// ciphertext must come out byte for byte (Ed25519 is deterministic, so the signature too —
/// but the sender's private key is not in the vectors, so only the ciphertext is compared).
#[test]
fn sealing_reproduces_desktop_ciphertext_byte_for_byte() {
    let v = vectors("channel-binding-v2.json");
    let ring = keyring_from(&v);
    let throwaway = keys::generate_ed25519();
    let mut checked = 0;
    for (name, m) in v["messages"].as_object().unwrap() {
        if m["sealed_by"].as_str().is_none_or(|x| !x.starts_with("desktop encryptChannelMessage")) {
            continue;
        }
        let input = &m["input"];
        let sender = (!input["sender"].is_null()).then(|| ChannelSender {
            user_id: input["sender"]["user_id"].as_str(),
            device_id: input["sender"]["device_id"].as_str(),
        });
        let nonce: [u8; 12] = from_b64(s(m, "nonce_b64")).unwrap().try_into().unwrap();
        // The vectors' random-UUID `m` values are read back from the desktop plaintext.
        let plain: Value = serde_json::from_str(s(m, "plaintext_json")).unwrap_or(Value::Null);
        let bound_m = plain["_cb"]["m"].as_str().unwrap_or("").to_owned();
        let key = ring.key(s(m, "channel_id"), m["epoch"].as_u64().unwrap() as u32).unwrap();
        let wire = channel::encrypt_channel_message_with(
            &key,
            s(m, "channel_id"),
            m["epoch"].as_u64().unwrap() as u32,
            s(input, "content_json"),
            sender.unwrap_or_default(),
            &throwaway,
            nonce,
            || bound_m,
        )
        .unwrap();
        assert_eq!(wire.ciphertext_b64, s(m, "ciphertext_b64"), "{name}");
        checked += 1;
    }
    assert_eq!(checked, 10);
}

/// Positive control for the test above: a one-character change to the content breaks it.
#[test]
fn sealing_control_detects_a_changed_byte() {
    let v = vectors("channel-binding-v2.json");
    let ring = keyring_from(&v);
    let m = &v["messages"]["v2_text"];
    let nonce: [u8; 12] = from_b64(s(m, "nonce_b64")).unwrap().try_into().unwrap();
    let key = ring.key(s(m, "channel_id"), 1).unwrap();
    let content = s(&m["input"], "content_json").replace("approve", "Approve");
    let sender = ChannelSender { user_id: m["input"]["sender"]["user_id"].as_str(), device_id: m["input"]["sender"]["device_id"].as_str() };
    let wire = channel::encrypt_channel_message_with(&key, s(m, "channel_id"), 1, &content, sender, &keys::generate_ed25519(), nonce, || "x".into()).unwrap();
    assert_ne!(wire.ciphertext_b64, s(m, "ciphertext_b64"));
}

#[test]
fn own_messages_round_trip_and_reject_relabelling() {
    let identity = keys::generate_ed25519();
    let pub_b64 = cl_crypto::encoding::b64(identity.verifying_key().as_bytes());
    let mut ring = ChannelKeyring::new();
    let minted = ring.rotate("chan", None, 1_780_000_000_000).unwrap();
    assert_eq!(minted.epoch, 1);
    let sender = ChannelSender { user_id: Some("u1"), device_id: Some("d1") };
    let wire = channel::encrypt_channel_message(&ring.key("chan", 1).unwrap(), "chan", 1, r#"{"type":"text","text":"hi"}"#, sender, &identity).unwrap();
    let arrival = |device: &'static str| ChannelArrival {
        channel_id: "chan",
        epoch: 1,
        nonce_b64: &wire.nonce_b64,
        ciphertext_b64: &wire.ciphertext_b64,
        signature_b64: &wire.signature_b64,
        sender_identity_pub_b64: &pub_b64,
        sender_user_id: Some("u1"),
        sender_device_id: Some(device),
    };
    let ok = channel::open_channel_message(&arrival("d1"), |e| ring.key("chan", e)).unwrap();
    assert_eq!(ok.content_json, r#"{"type":"text","text":"hi"}"#);
    let err = channel::open_channel_message(&arrival("d2"), |e| ring.key("chan", e)).unwrap_err();
    assert!(err.is_serve_rejection(), "{err}");
    let missing = channel::open_channel_message(&arrival("d1"), |_| None::<Zeroizing<[u8; 32]>>).unwrap_err();
    assert!(matches!(missing, ChannelError::KeyMissing { .. }) && !missing.is_serve_rejection());
}

#[test]
fn sender_key_vectors_decrypt_across_rotation() {
    let v = vectors("channel-sender-key.json");
    let cases = v["cases"].as_array().unwrap();
    let creator = s(&v["parties"], "creator_identity_pub_b64");
    let mut ring = ChannelKeyring::new();
    let mut messages = Vec::new();
    for c in &cases[..2] {
        let content = &c["key_handshake"]["channelKeyContent"];
        let got = ring
            .set(s(content, "channel_id"), content["epoch"].as_i64().unwrap(), s(content, "key_b64"), s(content, "rotates_at"), None)
            .unwrap();
        assert_eq!(format!("{got:?}").to_lowercase(), s(&c["key_handshake"]["installs"][0], "install_result"));
        // Same content again is a no-op; a DIFFERENT key for the same epoch is refused.
        assert_eq!(ring.set(s(content, "channel_id"), content["epoch"].as_i64().unwrap(), s(content, "key_b64"), s(content, "rotates_at"), None).unwrap(), SetKeyResult::Duplicate);
        let other = cl_crypto::encoding::b64(&[7u8; 32]);
        assert_eq!(ring.set(s(content, "channel_id"), content["epoch"].as_i64().unwrap(), &other, s(content, "rotates_at"), None).unwrap(), SetKeyResult::Conflict);
        // The handshake envelope is an ordinary v:3 DM envelope.
        let env = s(&c["key_handshake"]["wrapResult"], "envelope_b64");
        assert!(cl_crypto::envelope::peek_eph_key(env).is_ok());
        messages.push((s(content, "channel_id").to_owned(), c["channel_message"]["wire"].clone(), c["channel_message"]["plaintext_content"].clone()));
    }
    assert_eq!(ring.latest_epoch(&messages[0].0), Some(2));
    // Both epochs still decrypt after the rotation.
    for (channel_id, wire, plain) in &messages {
        let arrival = ChannelArrival {
            channel_id,
            epoch: wire["epoch"].as_u64().unwrap() as u32,
            nonce_b64: s(wire, "nonce_b64"),
            ciphertext_b64: s(wire, "ciphertext_b64"),
            signature_b64: s(wire, "signature_b64"),
            sender_identity_pub_b64: creator,
            sender_user_id: None,
            sender_device_id: None,
        };
        let out = channel::open_channel_message(&arrival, |e| ring.key(channel_id, e)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&out.content_json).unwrap(), *plain);
    }
    // Wrong sender identity and a tampered ciphertext both fail at the SIGNATURE, before GCM.
    for c in &cases[2..] {
        let (ct, sender) = match c["inputs"].is_object() {
            true => (s(&c["inputs"], "ciphertext_b64").to_owned(), s(&c["inputs"], "sender_identity_pub_b64_used").to_owned()),
            false => (s(c, "tampered_ciphertext_b64").to_owned(), creator.to_owned()),
        };
        let wire = &messages[0].1;
        let arrival = ChannelArrival {
            channel_id: &messages[0].0,
            epoch: 1,
            nonce_b64: s(wire, "nonce_b64"),
            ciphertext_b64: &ct,
            signature_b64: s(wire, "signature_b64"),
            sender_identity_pub_b64: &sender,
            sender_user_id: None,
            sender_device_id: None,
        };
        let err = channel::open_channel_message(&arrival, |e| ring.key(&messages[0].0, e)).unwrap_err();
        assert!(matches!(err, ChannelError::SignatureInvalid { .. }), "{}", s(c, "name"));
        assert!(err.to_string().starts_with(&s(c, "actual_error")[..60]));
    }
}

#[test]
fn keyring_rejects_poisonous_installs_and_keeps_old_epochs_on_prune() {
    let mut ring = ChannelKeyring::new();
    let key = cl_crypto::encoding::b64(&[1u8; 32]);
    for bad_epoch in [0, -1, 1_000_001] {
        assert!(ring.set("c", bad_epoch, &key, "2030-01-01T00:00:00Z", None).is_err());
    }
    assert!(ring.set("c", 1, &cl_crypto::encoding::b64(&[1u8; 31]), "2030-01-01T00:00:00Z", None).is_err());
    assert!(ring.set("c", 1, &key, "not a date", None).is_err());
    // Arbitrated replacement only for the matching fingerprint.
    ring.set("c", 1, &key, "2030-01-01T00:00:00Z", None).unwrap();
    let winner = [2u8; 32];
    let fp = cl_crypto::channel::keyring::key_fingerprint(&winner);
    assert_eq!(ring.set("c", 1, &cl_crypto::encoding::b64(&winner), "2030-01-01T00:00:00Z", Some("nope")).unwrap(), SetKeyResult::Conflict);
    assert_eq!(ring.set("c", 1, &cl_crypto::encoding::b64(&winner), "2030-01-01T00:00:00Z", Some(&fp)).unwrap(), SetKeyResult::Stored);
    assert_eq!(*ring.key("c", 1).unwrap(), winner);

    // 60 old epochs: prune keeps the newest 50 plus a protected one.
    let mut ring = ChannelKeyring::new();
    for e in 1..=60 {
        ring.set("c", e, &key, "2020-01-01T00:00:00.000Z", None).unwrap();
    }
    let protected = HashMap::from([("c".to_owned(), [3u32].into_iter().collect())]);
    ring.prune(1_780_000_000_000, &protected);
    let epochs = ring.epochs("c");
    assert_eq!(epochs.len(), 51);
    assert!(epochs.contains(&3) && epochs.contains(&60) && !epochs.contains(&4));

    // Stored form round-trips, and junk entries from older builds are skipped on load.
    let json = ring.to_json("c");
    let mut back = ChannelKeyring::new();
    back.load_json("c", &json);
    assert_eq!(back.epochs("c"), epochs);
    let mut junk = ChannelKeyring::new();
    junk.load_json("c", r#"{"5.5":{"keyHex":"00","rotatesAt":"x"},"2000000":{"keyHex":"0101010101010101010101010101010101010101010101010101010101010101","rotatesAt":"x"},"7":{"keyHex":"0101010101010101010101010101010101010101010101010101010101010101","rotatesAt":"2030-01-01T00:00:00.000Z"}}"#);
    assert_eq!(junk.epochs("c"), vec![7]);
}
