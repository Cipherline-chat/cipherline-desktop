//! DM envelope v:3 against the desktop oracle (`test-vectors/dm-envelope-v3.json`).
use cl_crypto::encoding::{b64, from_b64};
use cl_crypto::envelope::{self, EncryptRandomness, EnvelopeError, RecipientDevice, SenderIdentity};
use cl_crypto::keys;
use serde_json::Value;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

fn vectors() -> Value {
    let path = format!("{}/../../test-vectors/dm-envelope-v3.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or_else(|| panic!("missing {k}")).to_owned()
}

fn h32(hex_str: &str) -> [u8; 32] {
    hex::decode(hex_str).unwrap().try_into().unwrap()
}

fn h12(hex_str: &str) -> [u8; 12] {
    hex::decode(hex_str).unwrap().try_into().unwrap()
}

fn replay_case(v: &Value) -> &Value {
    v["cases"].as_array().unwrap().iter().find(|c| c["name"] == "encrypt-replay-worked-example").unwrap()
}

#[test]
fn decrypts_the_desktop_envelope_then_reencrypts_it_byte_for_byte() {
    let v = vectors();
    let c = replay_case(&v);
    let r = &c["recipient_device_used"];
    let device_id = s(r, "device_id");
    let spk_priv = h32(&s(r, "spk_priv_hex_for_recomputing_ecdh"));
    let otp_id = r["otp_id"].as_u64().unwrap() as u32;
    let otp_priv = h32(&s(r, "otp_priv_hex_for_recomputing_ecdh"));
    let desktop_env = s(c, "envelope_b64");

    // 1. Decrypt what the desktop produced.
    let d = envelope::decrypt_v3(&desktop_env, &device_id, &spk_priv, |id| (id == otp_id).then(|| Zeroizing::new(otp_priv)))
        .expect("desktop envelope must open");
    let want: Value = c["plaintext_content"].clone();
    assert_eq!(serde_json::from_str::<Value>(&d.content_json).unwrap(), want);
    assert_eq!(d.otp_consumed, Some(otp_id));
    let parties = &v["parties"];
    assert_eq!(d.sender_identity_pub_b64, s(&parties["sender_device_1"]["bundle"], "identity_key_pub_b64"));
    assert_eq!(d.sender_user_id.as_deref(), Some(s(parties, "sender_user_id").as_str()));

    // 2. Re-encrypt with the captured randomness: the whole envelope must be identical.
    let rnd = &c["captured_randomness"];
    let randomness = EncryptRandomness {
        ephemeral_priv: h32(&s(&rnd["ephemeral_x25519_keypair"], "priv_hex")),
        content_key: h32(&s(rnd, "content_key_hex_PRE_ZERO")),
        wrap_ivs: vec![h12(&s(rnd, "wrap_iv_hex"))],
        content_iv: h12(&s(rnd, "content_iv_hex")),
    };
    let bundle = &parties["recipient_device_1"]["bundle"];
    let device = RecipientDevice {
        device_id: device_id.clone(),
        identity_pub_b64: s(bundle, "identity_key_pub_b64"),
        spk_pub_b64: s(r, "spk_pub_b64"),
        spk_sig_b64: s(&bundle["signed_prekey"], "sig_b64"),
        otp: Some((otp_id, s(r, "otp_pub_b64"))),
    };
    assert_eq!(device.spk_pub_b64, s(&bundle["signed_prekey"], "pub_b64"), "vector's SPK is the bundle's");
    let signing = keys::ed25519_signing_key(&hex::decode(s(c, "sender_identity_priv_hex")).unwrap()).unwrap();
    let sender = SenderIdentity {
        signing_key: &signing,
        identity_pub_b64: &d.sender_identity_pub_b64,
        user_id: d.sender_user_id.as_deref().unwrap(),
        device_id: d.sender_device_id.as_deref(),
    };
    let ours = envelope::encrypt_for_devices(&d.content_json, &sender, &[device], Some(&randomness)).unwrap();
    assert_eq!(ours.wrapped_device_ids, vec![device_id]);
    assert_eq!(ours.envelope_b64, desktop_env, "Rust envelope must equal the desktop's byte for byte");
}

#[test]
fn tampered_ciphertext_and_wrong_device_are_rejected() {
    let v = vectors();
    let c = replay_case(&v);
    let r = &c["recipient_device_used"];
    let device_id = s(r, "device_id");
    let spk_priv = h32(&s(r, "spk_priv_hex_for_recomputing_ecdh"));
    let otp_priv = h32(&s(r, "otp_priv_hex_for_recomputing_ecdh"));
    let lookup = |_id: u32| Some(Zeroizing::new(otp_priv));

    let mut env: serde_json::Map<String, Value> =
        serde_json::from_slice(&from_b64(&s(c, "envelope_b64")).unwrap()).unwrap();
    let mut ct = from_b64(env["ct"].as_str().unwrap()).unwrap();
    ct[10] ^= 1;
    env.insert("ct".into(), Value::String(b64(&ct)));
    let tampered = b64(&serde_json::to_vec(&env).unwrap());
    assert_eq!(envelope::decrypt_v3(&tampered, &device_id, &spk_priv, lookup).unwrap_err(), EnvelopeError::ContentAuthFailed);

    assert_eq!(
        envelope::decrypt_v3(&s(c, "envelope_b64"), "33333333-3333-4333-8333-333333333332", &spk_priv, lookup).unwrap_err(),
        EnvelopeError::NoRecipientEntry
    );

    // Swapping the signature for garbage fails the post-decrypt signature check.
    let mut env2: serde_json::Map<String, Value> =
        serde_json::from_slice(&from_b64(&s(c, "envelope_b64")).unwrap()).unwrap();
    env2.insert("sig".into(), Value::String(b64(&[7u8; 64])));
    let bad_sig = b64(&serde_json::to_vec(&env2).unwrap());
    assert_eq!(envelope::decrypt_v3(&bad_sig, &device_id, &spk_priv, lookup).unwrap_err(), EnvelopeError::SigInvalid);

    // A v:2 envelope is refused outright (downgrade protection).
    env2.insert("v".into(), Value::from(2));
    let legacy = b64(&serde_json::to_vec(&env2).unwrap());
    assert_eq!(envelope::decrypt_v3(&legacy, &device_id, &spk_priv, lookup).unwrap_err(), EnvelopeError::Legacy);
}

struct TestDevice {
    id: String,
    spk: Zeroizing<[u8; 32]>,
    otp: Zeroizing<[u8; 32]>,
    pub_device: RecipientDevice,
}

fn make_device(id: &str, otp_id: u32, forge_sig: bool) -> TestDevice {
    let identity = keys::generate_ed25519();
    let identity_pub = b64(identity.verifying_key().as_bytes());
    let (spk, spk_pub) = keys::generate_x25519();
    let (otp, otp_pub) = keys::generate_x25519();
    let spk_raw = from_b64(&spk_pub).unwrap();
    let mut sig = keys::sign(&identity, &spk_raw);
    if forge_sig {
        sig[0] ^= 1;
    }
    TestDevice {
        id: id.into(),
        spk,
        otp,
        pub_device: RecipientDevice {
            device_id: id.into(),
            identity_pub_b64: identity_pub,
            spk_pub_b64: spk_pub,
            spk_sig_b64: b64(&sig),
            otp: Some((otp_id, otp_pub)),
        },
    }
}

#[test]
fn fan_out_skips_a_device_with_a_bad_spk_signature_and_everyone_else_decrypts() {
    let sender_key = keys::generate_ed25519();
    let sender_pub = b64(sender_key.verifying_key().as_bytes());
    let a = make_device("aaaa", 5, false);
    let b = make_device("bbbb", 6, true); // forged SPK signature
    let c = make_device("cccc", 7, false);
    let sender = SenderIdentity { signing_key: &sender_key, identity_pub_b64: &sender_pub, user_id: "u1", device_id: Some("d1") };
    let content = r#"{"type":"text","text":"héllo ✨","client_msg_id":"m1"}"#;
    let out = envelope::encrypt_for_devices(content, &sender, &[a.pub_device.clone(), b.pub_device.clone(), c.pub_device.clone()], None).unwrap();
    assert_eq!(out.wrapped_device_ids, vec!["aaaa".to_string(), "cccc".to_string()]);
    for dev in [&a, &c] {
        let otp = dev.otp.clone();
        let d = envelope::decrypt_v3(&out.envelope_b64, &dev.id, dev.spk.as_ref(), |_| Some(otp.clone())).unwrap();
        assert_eq!(d.content_json, content);
        assert_eq!(d.sender_device_id.as_deref(), Some("d1"));
        assert!(d.otp_consumed.is_some());
    }
    assert_eq!(envelope::decrypt_v3(&out.envelope_b64, "bbbb", b.spk.as_ref(), |_| None).unwrap_err(), EnvelopeError::NoRecipientEntry);
    // A recipient that no longer holds the OTP cannot derive the right wrap key.
    assert_eq!(envelope::decrypt_v3(&out.envelope_b64, "aaaa", a.spk.as_ref(), |_| None).unwrap_err(), EnvelopeError::WrapAuthFailed);
}

#[test]
fn nobody_wrappable_is_an_error() {
    let sender_key = keys::generate_ed25519();
    let sender_pub = b64(sender_key.verifying_key().as_bytes());
    let bad = make_device("x", 1, true);
    let sender = SenderIdentity { signing_key: &sender_key, identity_pub_b64: &sender_pub, user_id: "u", device_id: None };
    assert_eq!(
        envelope::encrypt_for_devices(r#"{"type":"text","text":"x"}"#, &sender, &[bad.pub_device], None).err(),
        Some(EnvelopeError::WrapNone)
    );
    // Silence unused-import warnings for the types used only in helper signatures.
    let _ = (PublicKey::from([9u8; 32]), StaticSecret::from([1u8; 32]));
}
