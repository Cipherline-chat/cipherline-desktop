//! Byte-compatibility with the desktop client, driven by the oracle vectors in
//! `test-vectors/` (generated from the real desktop TypeScript; see SOURCE.md).
use cl_crypto::blob::{self, IV_LEN};
use cl_crypto::encoding::{b64, from_b64};
use cl_crypto::kdf::{self, BackupKdf};
use cl_crypto::CryptoError;
use serde_json::Value;
use sha2::{Digest, Sha256};

fn vectors(name: &str) -> Value {
    let path = format!("{}/../../test-vectors/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_else(|| panic!("missing string field {k}"))
}

fn sha256_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

fn pattern(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 256) as u8).collect()
}

#[test]
fn kdf_user_subkey_matches_desktop() {
    let v = vectors("kdf.json");
    let cases = v["cases"].as_array().unwrap();
    let mut n = 0;
    for c in cases {
        if !s(c, "name").starts_with("secure-local-store-subkey") {
            continue;
        }
        let master: [u8; 32] = from_b64(s(c, "master_key_b64")).unwrap().try_into().unwrap();
        let got = kdf::user_subkey(&master, s(c, "user_id"));
        assert_eq!(hex::encode(got.as_ref()), s(c, "derived_subkey_raw_hex"), "{}", s(c, "name"));
        // The desktop encrypted with its real (non-extractable) key; our key must decrypt it.
        let x = &c["cross_check_real_vs_independently_derived"];
        let iv = hex::decode(s(x, "iv_hex")).unwrap();
        let ct = hex::decode(s(x, "ciphertext_hex")).unwrap();
        blob::open(got.as_ref(), &iv, &ct).expect("desktop ciphertext must open with the derived key");
        n += 1;
    }
    assert!(n >= 2, "expected at least two subkey cases, found {n}");
}

#[test]
fn chat_attachment_and_bundled_layouts_match_desktop() {
    let v = vectors("file-crypto.json");
    let c = &v["cases"]["attachment_1mib"];
    let pt = pattern(c["plaintext_byte_length"].as_u64().unwrap() as usize);
    assert_eq!(sha256_hex(&pt), s(c, "plaintext_sha256"));
    let key = blob::file_key_from_b64(s(c, "file_key_b64")).unwrap();

    // Chat layout: ciphertext ‖ tag, IV separate.
    let chat = &c["chat_attachment_variant"];
    let iv: [u8; IV_LEN] = from_b64(s(chat, "iv_b64")).unwrap().try_into().unwrap();
    let ct = blob::seal(key.as_ref(), &iv, &pt).unwrap();
    assert_eq!(ct.len() as u64, chat["encrypted_byte_length"].as_u64().unwrap());
    assert_eq!(sha256_hex(&ct), s(chat, "encrypted_sha256"));
    assert_eq!(&blob::decrypt_blob(key.as_ref(), &iv, &ct).unwrap()[..], &pt[..]);

    // Bundled layout: IV ‖ ciphertext ‖ tag.
    let bundled = &c["bundled_iv_variant"];
    let iv2: [u8; IV_LEN] = hex::decode(s(bundled, "first_12_bytes_hex_is_iv")).unwrap().try_into().unwrap();
    let mut out = iv2.to_vec();
    out.extend(blob::seal(key.as_ref(), &iv2, &pt).unwrap());
    assert_eq!(out.len() as u64, bundled["encrypted_byte_length"].as_u64().unwrap());
    assert_eq!(sha256_hex(&out), s(bundled, "encrypted_sha256"));
    assert_eq!(&blob::decrypt_blob_bundled(key.as_ref(), &out).unwrap()[..], &pt[..]);
}

#[test]
fn avatar_blob_matches_desktop() {
    let v = vectors("file-crypto.json");
    let c = &v["cases"]["avatar_banner_group_icon"];
    let pt = pattern(c["plaintext_byte_length"].as_u64().unwrap() as usize);
    assert_eq!(sha256_hex(&pt), s(c, "plaintext_sha256"));
    let key = blob::file_key_from_b64(s(c, "file_key_b64")).unwrap();
    let iv: [u8; IV_LEN] = from_b64(s(c, "iv_b64")).unwrap().try_into().unwrap();
    assert_eq!(sha256_hex(&blob::seal(key.as_ref(), &iv, &pt).unwrap()), s(c, "encrypted_sha256"));
}

#[test]
fn recovery_backup_v2_and_v1_decrypt_and_wrong_password_fails() {
    let v = vectors("file-crypto.json");
    for (name, kdf) in [
        ("local_recovery_backup_v2_current", BackupKdf::V2Sha512),
        ("local_recovery_backup_v1_legacy", BackupKdf::V1Sha256),
    ] {
        let c = &v["cases"][name];
        let bytes = from_b64(s(c, "encrypted_b64")).unwrap();
        let h = blob::parse_backup_header(&bytes).unwrap();
        assert_eq!(h.kdf, kdf, "{name}");
        assert_eq!(hex::encode(h.salt), s(&c["parsed_header"], "salt_hex"), "{name}");
        assert_eq!(hex::encode(h.iv), s(&c["parsed_header"], "iv_hex"), "{name}");
        assert_eq!(h.kdf.iterations() as u64, c["parsed_header"]["iterations"].as_u64().unwrap());
        let pt = blob::decrypt_backup(s(c, "password"), &bytes).unwrap();
        assert_eq!(std::str::from_utf8(&pt).unwrap(), s(c, "plaintext_payload"), "{name}");
        assert_eq!(blob::decrypt_backup("wrong password", &bytes).unwrap_err(), CryptoError::DecryptFailed);
    }
}

#[test]
fn backup_v2_round_trip_and_tamper_detection() {
    let pt = b"{\"hello\":1}";
    let mut enc = blob::encrypt_backup_v2("pw one two three", pt).unwrap();
    assert!(enc.starts_with(&blob::BACKUP_MAGIC_V2));
    assert_eq!(&blob::decrypt_backup("pw one two three", &enc).unwrap()[..], pt);
    let last = enc.len() - 1;
    enc[last] ^= 1;
    assert_eq!(blob::decrypt_backup("pw one two three", &enc).unwrap_err(), CryptoError::DecryptFailed);
}

#[test]
fn file_key_must_be_32_bytes() {
    assert!(blob::file_key_from_b64(&b64(&[0u8; 31])).is_err());
    assert!(blob::file_key_from_b64(&b64(&[0u8; 32])).is_ok());
}
