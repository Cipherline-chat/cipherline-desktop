//! Emit a `cipherline.mobile-output.v1` file from THIS core, for the reverse oracle:
//! `cipherline-mobile/scripts/test-vectors/verify-mobile-vectors.mjs` decrypts and verifies
//! every entry with the REAL desktop/API TypeScript.
//!
//!     cargo run -p cl-crypto --example oracle_output -- out.json [--corrupt]
//!
//! `--corrupt` flips one byte in every entry: the oracle must then FAIL every case, which
//! proves it is not rubber-stamping.
use cl_crypto::channel::{self, ChannelSender};
use cl_crypto::encoding::{b64, hex};
use cl_crypto::envelope::{self, RecipientDevice, SenderIdentity};
use cl_crypto::{attestation, blob, identity, keys, pow};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn flip_b64(s: &str) -> String {
    let mut raw = cl_crypto::encoding::from_b64(s).unwrap();
    let i = raw.len() / 2;
    raw[i] ^= 0x01;
    b64(&raw)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let out = args.get(1).expect("usage: oracle_output <out.json> [--corrupt]");
    let corrupt = args.iter().any(|a| a == "--corrupt");
    let now_ms: i64 = 1_780_000_000_000;

    // ── device proof ──
    let id = keys::generate_ed25519();
    let id_pub = b64(id.verifying_key().as_bytes());
    let proof = identity::sign_register_proof(&id, "11111111-1111-4111-8111-111111111111", now_ms);
    let proof_sig = if corrupt { flip_b64(&proof.proof_sig_b64) } else { proof.proof_sig_b64.clone() };
    let device_proofs = json!([{
        "case_name": "rust-core-proof",
        "userId": "11111111-1111-4111-8111-111111111111",
        "identityKeyB64": proof.identity_key_pub_b64, "proofTs": proof.proof_ts,
        "signature_b64": proof_sig, "expected_valid": true,
    }]);

    // ── DM envelope, with and without a one-time prekey ──
    let mut dm = Vec::new();
    for (name, with_otp) in [("rust-core-dm-otp", true), ("rust-core-dm-spk-only", false)] {
        let recipient = keys::generate_ed25519();
        let spk = identity::new_signed_prekey(&recipient, 7);
        let (otp_priv, otp_pub) = keys::generate_x25519();
        let device_id = "22222222-2222-4222-8222-222222222222";
        let content = r#"{"type":"text","text":"from the rust core 🦀","client_msg_id":"rc-1"}"#;
        let enc = envelope::encrypt_for_devices(
            content,
            &SenderIdentity { signing_key: &id, identity_pub_b64: &id_pub, user_id: "11111111-1111-4111-8111-111111111111", device_id: Some("11111111-1111-4111-8111-111111111112") },
            &[RecipientDevice {
                device_id: device_id.into(),
                identity_pub_b64: b64(recipient.verifying_key().as_bytes()),
                spk_pub_b64: spk.pub_b64.clone(),
                spk_sig_b64: spk.sig_b64.clone(),
                otp: with_otp.then(|| (42, otp_pub.clone())),
            }],
            None,
        )
        .unwrap();
        let env = if corrupt {
            // Flip a byte INSIDE the ciphertext field, keeping the JSON parseable.
            let mut v: Value = serde_json::from_slice(&cl_crypto::encoding::from_b64(&enc.envelope_b64).unwrap()).unwrap();
            v["ct"] = flip_b64(v["ct"].as_str().unwrap()).into();
            b64(serde_json::to_string(&v).unwrap().as_bytes())
        } else {
            enc.envelope_b64
        };
        let mut e = json!({
            "case_name": name, "envelope_b64": env, "recipient_device_id": device_id,
            "spk_priv_hex": hex(spk.private.as_ref()), "spk_pub_b64": spk.pub_b64, "spk_id": spk.id,
            "expected_content_json": content,
        });
        if with_otp {
            e["otp_priv_hex"] = hex(otp_priv.as_ref()).into();
            e["otp_pub_b64"] = otp_pub.into();
            e["otp_id"] = 42.into();
        }
        dm.push(e);
    }

    // ── channel messages: bound with sender, bound without, unbound array ──
    let channel_key = *blob::generate_file_key();
    let channel_id = "55555555-5555-4555-8555-555555555555";
    let mut chans = Vec::new();
    for (name, content, sender) in [
        ("rust-core-channel-v2", r#"{"client_msg_id":"rc-2","type":"text","text":"héllo   \"q\" 👋"}"#, true),
        ("rust-core-channel-v2-no-sender", r#"{"type":"reaction","target_id":"t","emoji":"x","action":"add"}"#, false),
        ("rust-core-channel-unbound-array", "[1,2,3]", false),
    ] {
        let s = if sender {
            ChannelSender { user_id: Some("11111111-1111-4111-8111-111111111111"), device_id: Some("11111111-1111-4111-8111-111111111112") }
        } else {
            ChannelSender::default()
        };
        let w = channel::encrypt_channel_message(&channel_key, channel_id, 3, content, s, &id).unwrap();
        let mut e = json!({
            "case_name": name, "channel_id": channel_id, "epoch": 3,
            "nonce_b64": w.nonce_b64,
            "ciphertext_b64": if corrupt { flip_b64(&w.ciphertext_b64) } else { w.ciphertext_b64.clone() },
            "signature_b64": w.signature_b64, "sender_identity_pub_b64": id_pub,
            "channel_key_b64": b64(&channel_key), "expected_plaintext_json": content,
            "message_id": format!("row-{name}"),
        });
        if sender {
            e["sender_user_id"] = "11111111-1111-4111-8111-111111111111".into();
            e["sender_device_id"] = "11111111-1111-4111-8111-111111111112".into();
        }
        chans.push(e);
    }
    // A re-labelled sender: the G4 engine must refuse it with CHANNEL_BINDING.
    let s = ChannelSender { user_id: Some("11111111-1111-4111-8111-111111111111"), device_id: Some("11111111-1111-4111-8111-111111111112") };
    let w = channel::encrypt_channel_message(&channel_key, channel_id, 3, r#"{"client_msg_id":"rc-3","type":"text","text":"x"}"#, s, &id).unwrap();
    chans.push(json!({
        "case_name": "rust-core-channel-relabelled-sender", "channel_id": channel_id, "epoch": 3,
        "nonce_b64": w.nonce_b64, "ciphertext_b64": w.ciphertext_b64, "signature_b64": w.signature_b64,
        "sender_identity_pub_b64": id_pub, "channel_key_b64": b64(&channel_key), "message_id": "row-relabel",
        "sender_user_id": "11111111-1111-4111-8111-111111111111",
        "sender_device_id": if corrupt { "11111111-1111-4111-8111-111111111112" } else { "99999999-9999-4999-8999-999999999999" },
        "g4_expected_error_tag": "CHANNEL_BINDING",
        "expected_plaintext_json": r#"{"client_msg_id":"rc-3","type":"text","text":"x"}"#,
    }));

    // ── file blobs: separate-IV and bundled layouts ──
    let file_key = blob::generate_file_key();
    let data: Vec<u8> = (0..70_000u32).map(|i| (i * 31 % 251) as u8).collect();
    let digest = hex(&Sha256::digest(&data));
    let (ct, iv) = blob::encrypt_blob(file_key.as_ref(), &data).unwrap();
    let bundled = blob::encrypt_blob_bundled(file_key.as_ref(), &data).unwrap();
    let maybe = |b: &[u8]| if corrupt { flip_b64(&b64(b)) } else { b64(b) };
    let file_blobs = json!([
        { "case_name": "rust-core-blob", "key_b64": b64(file_key.as_ref()), "iv_b64": b64(&iv), "bundle_iv": false, "encrypted_b64": maybe(&ct), "expected_sha256": digest },
        { "case_name": "rust-core-blob-bundled", "key_b64": b64(file_key.as_ref()), "bundle_iv": true, "encrypted_b64": maybe(&bundled), "expected_sha256": digest },
    ]);

    // ── PoW (the API's own token format, solved by this core) ──
    let secret = "oracle-pow-secret";
    let token = pow::issue_challenge_token(secret, now_ms, "aabbccddeeff00112233445566778899");
    let nonce = pow::solve(&token, 12, |_| true).unwrap();
    let pow_solutions = json!([{
        "case_name": "rust-core-pow-12", "challenge_token": token, "secret": secret,
        "nonce": if corrupt { format!("{nonce}1") } else { nonce }, "difficulty": 12, "nowMs": now_ms, "expected_valid": true,
    }]);

    // ── attestation ──
    let att = attestation::attestation_token("oracle-attest-secret", now_ms).unwrap();
    let attest_headers = json!([{
        "case_name": "rust-core-attest", "token_b64": if corrupt { flip_b64(&att) } else { att }, "secret": "oracle-attest-secret",
        "nowMs": now_ms, "expected_valid": true,
    }]);

    let doc = json!({
        "schema": "cipherline.mobile-output.v1",
        "note": format!("Produced by cl-crypto {} (cipherline-native){}", env!("CARGO_PKG_VERSION"), if corrupt { " — CORRUPTED copy" } else { "" }),
        "device_proofs": device_proofs, "dm_envelopes": dm, "channel_messages": chans,
        "file_blobs": file_blobs, "pow_solutions": pow_solutions, "attest_headers": attest_headers,
    });
    std::fs::write(out, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
    eprintln!("wrote {out}");
}
