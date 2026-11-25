//! Identity bundle, device registration proof, safety numbers, contact codes, PoW and
//! attestation against the desktop/API oracle vectors.
mod common;
use cl_crypto::encoding::{b64, from_b64};
use cl_crypto::{attestation, identity, keys, pow, verification};
use common::{s, vectors};

#[test]
fn identity_bundles_verify_like_the_api() {
    let v = vectors("identity.json");
    let fresh = &v["cases"][0];
    let b = &fresh["bundle"];
    assert!(identity::verify_signed_prekey(s(b, "identity_key_pub_b64"), s(&b["signed_prekey"], "pub_b64"), s(&b["signed_prekey"], "sig_b64")));
    assert_eq!(b["one_time_prekeys"].as_array().unwrap().len(), 100);
    let rot = &v["cases"][2]["new_bundle"];
    assert_eq!(rot["signed_prekey"]["id"], 2);
    assert_eq!(rot["one_time_prekeys"][0]["prekey_id"], 101);
    assert!(identity::verify_signed_prekey(s(rot, "identity_key_pub_b64"), s(&rot["signed_prekey"], "pub_b64"), s(&rot["signed_prekey"], "sig_b64")));
    // Control: the SPK signature does not verify against the OTHER bundle's prekey.
    assert!(!identity::verify_signed_prekey(s(b, "identity_key_pub_b64"), s(&rot["signed_prekey"], "pub_b64"), s(&b["signed_prekey"], "sig_b64")));

    // Our own bundles have the same shape and verify the same way.
    let id = keys::generate_ed25519();
    let mine = identity::generate_bundle(&id);
    assert!((1..16380).contains(&mine.registration_id));
    assert_eq!(mine.signed_prekey.id, 1);
    assert_eq!(mine.one_time_prekeys.iter().map(|p| p.id).collect::<Vec<_>>(), (1..=100).collect::<Vec<_>>());
    assert!(identity::verify_signed_prekey(&mine.identity_key_pub_b64, &mine.signed_prekey.pub_b64, &mine.signed_prekey.sig_b64));
    let next = identity::rotation_bundle(&id, mine.registration_id, 1, 100);
    assert_eq!((next.signed_prekey.id, next.one_time_prekeys[0].id, next.one_time_prekeys[99].id), (2, 101, 200));
}

#[test]
fn device_proofs_match_the_api() {
    let v = vectors("device-proof.json");
    for c in v["cases"].as_array().unwrap() {
        let i = &c["inputs"];
        let (uid, key, ts) = (s(i, "userId"), s(i, "identityKeyB64"), i["proofTs"].as_i64().unwrap());
        assert_eq!(identity::register_proof_message(uid, key, ts), s(c, "message_utf8"));
        let sig = s(c, "signature_b64");
        if let Some(verify) = c.get("verify") {
            let now = verify["nowSec"].as_i64().unwrap();
            assert_eq!(identity::verify_register_proof(uid, key, sig, ts, now), verify["expected_valid"].as_bool().unwrap());
        }
        for sub in c["subcases"].as_array().into_iter().flatten() {
            let raw_sig = from_b64(sig).unwrap();
            let raw_key = from_b64(key).unwrap();
            let (k, sg, now) = match s(sub, "name") {
                "signature-63-bytes-truncated" => (key.to_owned(), b64(&raw_sig[..63]), ts),
                "signature-65-bytes-padded" => (key.to_owned(), b64(&[raw_sig.as_slice(), &[0]].concat()), ts),
                "identity-key-31-bytes-short" => (b64(&raw_key[..31]), sig.to_owned(), ts),
                _ => (key.to_owned(), sig.to_owned(), sub["nowSec"].as_i64().unwrap()),
            };
            assert_eq!(identity::verify_register_proof(uid, &k, &sg, ts, now), sub["expected_valid"].as_bool().unwrap(), "{}", s(sub, "name"));
        }
    }
    // Our own proof verifies; a different user id does not.
    let id = keys::generate_ed25519();
    let p = identity::sign_register_proof(&id, "user-1", 1_780_000_000_123);
    assert_eq!(p.proof_ts, 1_780_000_000);
    assert!(identity::verify_register_proof("user-1", &p.identity_key_pub_b64, &p.proof_sig_b64, p.proof_ts, p.proof_ts));
    assert!(!identity::verify_register_proof("user-2", &p.identity_key_pub_b64, &p.proof_sig_b64, p.proof_ts, p.proof_ts));
}

#[test]
fn safety_numbers_match_desktop() {
    let v = vectors("safety-number.json");
    for c in v["cases"].as_array().unwrap() {
        let (a, b) = (s(c, "pub_a_b64"), s(c, "pub_b_b64"));
        assert_eq!(verification::safety_number(a, b), s(c, "safety_number_computed_a_then_b"));
        assert_eq!(verification::safety_number(b, a), s(c, "safety_number_computed_b_then_a"));
        let rows: Vec<Vec<String>> = serde_json::from_value(c["formatted_rows"].clone()).unwrap();
        assert_eq!(verification::format_safety_number(s(c, "safety_number_computed_a_then_b")), rows);
    }
}

#[test]
fn contact_codes_match_desktop() {
    let v = vectors("contact-code.json");
    let strs = |x: &serde_json::Value| x.as_array().unwrap().iter().map(|p| p.as_str().unwrap().to_owned()).collect::<Vec<_>>();
    for c in v["cases"].as_array().unwrap() {
        let name = s(c, "name");
        if let Some(code) = c["code"].as_str() {
            let pubs = strs(&c["device_pubs_b64"]);
            let refs: Vec<&str> = pubs.iter().map(String::as_str).collect();
            assert_eq!(verification::contact_code(s(c, "user_id"), &refs).unwrap(), code, "{name}");
            assert_eq!(verification::format_contact_code(code), s(c, "formatted"));
        }
        if let Some(fwd) = c["code_forward_order"].as_str() {
            let mut pubs = strs(&c["device_pubs_b64_in_directory_order"]);
            assert_eq!(verification::contact_code(s(c, "user_id"), &pubs.iter().map(String::as_str).collect::<Vec<_>>()).unwrap(), fwd);
            pubs.reverse();
            assert_eq!(verification::contact_code(s(c, "user_id"), &pubs.iter().map(String::as_str).collect::<Vec<_>>()).unwrap(), fwd);
        }
        if let Some(a) = c["code_for_user_a"].as_str() {
            let pubs = strs(&c["device_pubs_b64"]);
            let refs: Vec<&str> = pubs.iter().map(String::as_str).collect();
            assert_eq!(verification::contact_code(s(c, "user_id_a"), &refs).unwrap(), a);
            assert_eq!(verification::contact_code(s(c, "user_id_b"), &refs).unwrap(), s(c, "code_for_user_b"));
        }
        if let Some(out) = c["normalized_output"].as_str() {
            let input = c["mangled_input"].as_str().or(c["raw_input"].as_str()).unwrap();
            assert_eq!(verification::normalize_contact_code(input), out, "{name}");
        }
        if let Some(result) = c.get("check_result") {
            let expected = c["expected_code"].as_str().unwrap_or("");
            let input = c["pasted_input"].as_str().or(c["mangled_input"].as_str()).or(c["raw_input"].as_str()).unwrap();
            let got = verification::check_contact_code(expected, input);
            let want = match s(result, "result") {
                "match" => verification::CodeCheck::Match,
                "mismatch" => verification::CodeCheck::Mismatch,
                _ => verification::CodeCheck::Malformed(s(result, "reason").to_owned()),
            };
            assert_eq!(got, want, "{name}");
        }
    }
    // The safety-number embed vectors' codes come from the same function.
    let e = vectors("safety-number-embed.json");
    let (k, ids, codes) = (&e["keys"], &e["ids"], &e["codes"]);
    let code = |user: &str, pubs: &[&str]| verification::contact_code(user, pubs).unwrap();
    assert_eq!(code(s(ids, "sender"), &[s(k, "A"), s(k, "B")]), s(codes, "codeAB"));
    assert_eq!(code(s(ids, "sender"), &[s(k, "A")]), s(codes, "codeA"));
    assert_eq!(code(s(ids, "sender"), &[s(k, "EVIL")]), s(codes, "codeEvil"));
    assert_eq!(code(s(ids, "other"), &[s(k, "A"), s(k, "B")]), s(codes, "codeABforOther"));
}

#[test]
fn pow_matches_the_api() {
    let v = vectors("pow.json");
    for ex in v["parse_pow_difficulty_examples"].as_array().unwrap() {
        assert_eq!(pow::parse_pow_difficulty(ex["raw"].as_str()), ex["expected"].as_u64().unwrap() as u32);
    }
    let secret = "test-pow-secret";
    let mut solved = 0;
    for c in v["cases"].as_array().unwrap() {
        let token = s(c, "challenge_token");
        let Some(inner) = c["inner_challenge_hashed_by_client"].as_str() else {
            // The documented desktop bug: a nonce solved over the FULL token must not pass.
            let wrong = s(c, "nonce_solved_against_live_clients_wrong_input");
            assert!(!pow::meets_difficulty(s(c, "correct_inner_challenge_per_server"), wrong, 12));
            assert_eq!(pow::inner_challenge(token).as_deref(), Some(s(c, "correct_inner_challenge_per_server")));
            continue;
        };
        let difficulty = c["inputs"]["difficulty"].as_u64().unwrap() as u32;
        assert_eq!(pow::inner_challenge(token).as_deref(), Some(inner));
        assert_eq!(cl_crypto::encoding::hex(&pow::pow_hash(inner, s(c, "solved_nonce"))), s(c, "hash_hex"));
        assert_eq!(pow::leading_zero_bits(&pow::pow_hash(inner, s(c, "solved_nonce"))), c["leading_zero_bits"].as_u64().unwrap() as u32);
        // The solver finds desktop's (smallest) nonce.
        assert_eq!(pow::solve(token, difficulty, |_| true).unwrap(), s(c, "solved_nonce"));
        // Server round trip with our own secret.
        let ours = pow::issue_challenge_token(secret, c["inputs"]["nowMs"].as_i64().unwrap(), s(&c["inputs"], "randomHex"));
        assert_eq!(pow::verify_challenge_token(&ours, secret, 1_780_000_000_000 + 600_000).as_deref(), Some(inner));
        assert_eq!(pow::verify_challenge_token(&ours, secret, 1_780_000_000_000 + 601_000), None);
        assert_eq!(pow::verify_challenge_token(&ours, "other", 1_780_000_000_000), None);
        solved += 1;
    }
    assert_eq!(solved, 3);
    assert_eq!(pow::solve("a.b", 8, |_| true), Err(pow::PowError::BadToken));
    assert_eq!(pow::solve("1.ab.cd", 22, |_| false), Err(pow::PowError::Cancelled));
}

#[test]
fn attestation_matches_the_api() {
    let v = vectors("attestation.json");
    for ex in v["parse_attest_secrets_examples"].as_array().unwrap() {
        let want: Vec<String> = serde_json::from_value(ex["expected"].clone()).unwrap();
        assert_eq!(attestation::parse_attest_secrets(ex["raw"].as_str()), want);
    }
    for c in v["cases"].as_array().unwrap() {
        let i = &c["inputs"];
        let token = attestation::attestation_token(s(i, "secret"), i["unixSecs"].as_i64().unwrap() * 1000 + 999).unwrap();
        assert_eq!(token, s(c, "token_b64"));
        let secrets: Vec<&str> = c["verify"]["secrets_list"].as_array().unwrap().iter().map(|x| x.as_str().unwrap()).collect();
        assert!(attestation::verify_attestation(Some(&token), &secrets, c["verify"]["nowMs"].as_i64().unwrap()));
    }
    for c in v["failure_cases"].as_array().unwrap() {
        let secrets: Vec<&str> = match c["secrets_tried"].as_array() {
            Some(a) => a.iter().map(|x| x.as_str().unwrap()).collect(),
            None => vec!["attest-secret-rotation-slot-1"],
        };
        let now = c["nowMs"].as_i64().unwrap_or(1_780_000_000_000);
        assert_eq!(attestation::verify_attestation(Some(s(c, "token_b64")), &secrets, now), c["expected_valid"].as_bool().unwrap(), "{}", s(c, "name"));
    }
    assert_eq!(attestation::attestation_token("", 0), None);
}
