//! Signatures produced by `@noble/ed25519` 3.1.0 (the library desktop signs with: SPK signatures, channel-message signatures,
//! history-request proofs) must keep verifying under the core's STRICT Ed25519 verification (sec-fix-core L7). Honest signers
//! produce canonical signatures over non-small-order keys, which is the only thing strict verification refuses to accept less of.
use cl_crypto::encoding::from_b64;

#[test]
fn every_noble_signature_verifies_in_strict_mode() {
    let doc: serde_json::Value = serde_json::from_str(include_str!("data/noble-ed25519-3.1.0-vectors.json")).unwrap();
    let vectors = doc["vectors"].as_array().unwrap();
    assert!(vectors.len() >= 25);
    for v in vectors {
        let (pub_b64, msg, sig) = (v["pub_b64"].as_str().unwrap(), from_b64(v["msg_b64"].as_str().unwrap()).unwrap(), from_b64(v["sig_b64"].as_str().unwrap()).unwrap());
        assert!(cl_crypto::keys::verify(pub_b64, &msg, &sig), "{} did not verify", v["kind"]);
        let mut bad = msg.clone();
        bad.push(1);
        assert!(!cl_crypto::keys::verify(pub_b64, &bad, &sig), "{}: a different message must not verify", v["kind"]);
    }
}
