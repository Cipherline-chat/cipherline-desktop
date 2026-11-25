//! Known-answer vectors, written to `test-vectors/near-v1.json` so the Electron / Node side can be
//! checked against them. `UPDATE_VECTORS=1 cargo test -p cl-near vectors` regenerates the file; a normal
//! run fails if the code's output differs from the committed file. `test-vectors/verify.py` recomputes the
//! same values with an independent implementation (Python `cryptography` + stdlib).
use std::net::IpAddr;

use serde_json::{json, Value};

use crate::approval::{link_approve_message_v2, Proximity};
use crate::ble;
use crate::code::{build_invite, build_invite_compact, build_near, build_near_compact, ProximitySecret, TypedCode};
use crate::frame::{write_frame, T_AUTH};
use crate::keys;
use crate::lan::{role_mac_bytes, LanRole};
use crate::onlink::{classify, LocalInterface};
use crate::relay::{conf_mac, conf_mac_n, relay_aad, Caps, LanOffer, Message, NearSession, Side};
use sha2::{Digest, Sha256};

fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }

const LINK: &str = "AQEBAQEBAQEBAQEBAQEBAQ";
/// The new device's identity public key (F4): any 32 bytes for the vector.
const IK: [u8; 32] = [0x88; 32];

fn build() -> Value {
    let en_priv = [0x11u8; 32];
    let ea_priv = [0x22u8; 32];
    let secret = ProximitySecret::from_bytes([0x33; 16]);
    let en_pub = keys::public_of(&en_priv);
    let ea_pub = keys::public_of(&ea_priv);
    let s = keys::dh(&en_priv, &ea_pub).unwrap();
    assert_eq!(*s, *keys::dh(&ea_priv, &en_pub).unwrap());
    let (k, big_k) = keys::derive_with_k(&s, secret.as_bytes(), LINK).unwrap();

    // hello / hello_ack
    let (mut a, hello) = NearSession::approver_start_with(LINK, &en_pub, secret.as_bytes(), &ea_priv, &ea_pub).unwrap();
    let conf_a = conf_mac(&k, Side::A, LINK, &en_pub, &ea_pub);
    let conf_n = conf_mac_n(&k, LINK, &en_pub, &ea_pub, &IK);
    let (mut n, ack) = NearSession::accept_hello(LINK, &en_priv, &[secret.as_bytes()], hello.seq, &hello.body, &IK).unwrap();
    a.accept_hello_ack(ack.seq, &ack.body, &IK).unwrap();
    let ack_plain = serde_json::to_string(&Message::HelloAck { conf: crate::b64::enc(&conf_n), ik: crate::b64::enc(&IK) }).unwrap();

    // sealed message with a fixed nonce
    let caps = Message::caps_full(&Caps { os: crate::relay::Os::Linux, kind: crate::relay::DeviceKind::Desktop, ble_adv: false, ble_scan: true, lan_listen: true, lan_dial: true }, &crate::relay::Who { label: "Dawson's laptop".into(), platform: "linux".into() });
    let sealed = n.seal_with_nonce(&caps, [0x44; 12]).unwrap();
    let a_msg = a.open(sealed.seq, &sealed.body).unwrap();
    assert_eq!(a_msg, caps);
    let offer = Message::lan_offer(&LanOffer { addrs: vec!["192.168.1.5".parse().unwrap(), "fe80::1".parse().unwrap()], port: 40123, fp: [0x77; 32] });
    let sealed_a = a.seal_with_nonce(&offer, [0x45; 12]).unwrap();

    // BLE
    let r = [0x55u8; 12];
    let u = ble::advert_uuid(&k.ble, &r);
    assert_eq!(ble::open_uuid(&k.ble, &u), Some(r));

    // LAN role MACs for a fixed exporter value
    let e = [0x66u8; 32];

    // typed code
    let tc = TypedCode::from_bytes([0x12, 0x34, 0x56, 0x78, 0x9a]);
    let tc_secret = tc.derive_secret(LINK);

    // frame bytes
    let mut fb = vec![];
    futures_block(write_frame(&mut fb, T_AUTH, &[&role_mac_bytes(&k.lan, LanRole::Dialer, &e)])).unwrap();

    // approval
    let approval = link_approve_message_v2("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", LINK, "a2V5LWZvci10ZXN0cy1vbmx5LTMyLWJ5dGVzISE=", &crate::proof::ProximityProof::for_tests(Proximity::Ble, LINK), 1_763_500_000).unwrap();

    // on-link table
    let ifaces = vec![
        LocalInterface::new(2, "wlan0", "192.168.1.20".parse().unwrap(), 24),
        LocalInterface::new(2, "wlan0", "fe80::1".parse().unwrap(), 64),
        LocalInterface::new(2, "wlan0", "fd12:3456:789a:1::5".parse().unwrap(), 64),
    ];
    // F3: a /16 interface only matches its own /24; virtual interfaces never match
    let wide = vec![LocalInterface::new(2, "wlan0", "10.1.2.3".parse().unwrap(), 16), LocalInterface::new(2, "wlan0", "fd12:3456:789a:1::5".parse().unwrap(), 48)];
    let virt = vec![LocalInterface::new(3, "docker0", "172.17.0.1".parse().unwrap(), 24), LocalInterface::new(4, "tun0", "10.8.0.2".parse().unwrap(), 24), LocalInterface::new(5, "vEthernet (WSL)", "172.28.80.1".parse().unwrap(), 20)];
    let wide_cands = ["10.1.2.9", "10.1.2.0", "10.1.2.255", "10.1.3.9", "10.1.200.9", "10.2.0.1", "fd12:3456:789a:1::77", "fd12:3456:789a:2::77"];
    let virt_cands = ["172.17.0.5", "10.8.0.9", "172.28.80.5", "172.28.95.5"];
    let table = |ifs: &[LocalInterface], cs: &[&str]| -> Vec<Value> { cs.iter().map(|c| json!({ "candidate": c, "on_link": !classify(c.parse::<IpAddr>().unwrap(), ifs).is_empty() })).collect() };
    let relay_token = [0x5au8; 32];
    let relay_auth = json!({
        "token_hex": hex(&relay_token),
        "relay_auth_b64": cl_crypto::encoding::b64(&Sha256::digest(relay_token)),
        "auth_b64": cl_crypto::encoding::b64(&relay_token),
        "rule": "relay_auth_b64 (at near session create / invite join) = STANDARD base64 with padding of SHA-256(token); auth_b64 (every relay POST as side n) = STANDARD base64 with padding of the raw 32-byte token; token = 32 random bytes kept in memory only, never in the QR or the typed code",
    });
    let cands = ["192.168.1.5", "192.168.2.5", "192.168.1.20", "192.168.1.255", "10.0.0.1", "8.8.8.8", "127.0.0.1", "100.64.0.9", "169.254.1.1", "::ffff:192.168.1.5", "::ffff:8.8.8.8", "fe80::abcd", "fe80::1", "fd12:3456:789a:1::77", "fd12:3456:789a:2::77", "2001:db8::1", "::1"];
    let onlink: Vec<Value> = cands.iter().map(|c| json!({ "candidate": c, "on_link": !classify(c.parse::<IpAddr>().unwrap(), &ifaces).is_empty() })).collect();

    json!({
        "format": "cl-near test vectors v2 (security round: near-sec)",
        "contract": "docs/plans/proximity-signin-protocol.md",
        "inputs": {
            "link_id": LINK,
            "eN_priv_hex": hex(&en_priv), "eA_priv_hex": hex(&ea_priv), "secret_hex": hex(secret.as_bytes()),
        },
        "keys": {
            "eN_pub_hex": hex(&en_pub), "eA_pub_hex": hex(&ea_pub), "S_hex": hex(&*s), "K_hex": hex(&*big_k),
            "K_conf_hex": hex(&*k.conf), "K_relay_hex": hex(&*k.relay), "K_ble_hex": hex(&*k.ble),
            "K_lan_hex": hex(&*k.lan), "K_xfer_hex": hex(&*k.xfer),
        },
        "qr": {
            "near": build_near(LINK, &en_pub, &secret),
            "invite": build_invite(LINK, &secret),
            "near_compact": build_near_compact(LINK, &en_pub, &secret).unwrap(),
            "invite_compact": build_invite_compact(LINK, &secret).unwrap(),
        },
        "typed_code": {
            "bytes_hex": "123456789a", "display": tc.display(),
            "lookup_hash_hex": tc.lookup_hash_hex(), "lookup_hash_algo": "argon2id v1.3, t=3, m=65536 KiB, p=1, salt=ASCII 'cipherline-near-code:v1', password=display string, 32-byte output",
            "typed_s_hex": hex(tc_secret.as_bytes()),
            "typed_secret_version": crate::code::TYPED_SECRET_VERSION,
            "typed_s_algo": "v2 (F8): argon2id v1.3, t=3, m=65536 KiB, p=1, 32-byte tag, salt = ASCII 'cipherline-near-typed:v2:' || linkId, password = display string; s = tag[0..16]",
            "typed_s_v1_hkdf_retired": "HKDF-SHA256(ikm = display string bytes, salt = linkId string bytes, info = 'cipherline-near-typed:v1')[0..16] (offline-searchable at HMAC speed; NOT used)",
        },
        "hello": {
            "seq": hello.seq, "body": String::from_utf8(hello.body.clone()).unwrap(), "conf_A_hex": hex(&conf_a),
            "mac_input": "'A' || linkId (ASCII) || eN_pub || eA_pub",
        },
        "hello_ack": {
            "conf_N_hex": hex(&conf_n), "seq": ack.seq, "mac_input": "'N' || linkId (ASCII) || eN_pub || eA_pub || ik (32 raw bytes)",
            "ik_hex": hex(&IK), "plaintext": ack_plain,
            "note": "F4: the ack body is random-nonce sealed under K_relay; the plaintext is {\"t\":\"hello_ack\",\"conf\":b64url(conf_N),\"ik\":b64url(ik)}. A verifies conf over the ik IN the message, then refuses (identity_mismatch) unless ik equals the identity key the server announced at scan. The hello (A -> N) is unchanged.",
        },
        "sealed_from_n": {
            "seq": sealed.seq, "nonce_hex": hex(&[0x44u8; 12]), "plaintext": String::from_utf8(serde_json::to_vec(&caps).unwrap()).unwrap(),
            "aad": String::from_utf8(relay_aad(LINK, Side::N, sealed.seq)).unwrap(), "body_hex": hex(&sealed.body),
            "format": "nonce(12) || AES-256-GCM(K_relay, nonce, aad, plaintext) ciphertext || tag(16)",
        },
        "sealed_from_a": {
            "seq": sealed_a.seq, "nonce_hex": hex(&[0x45u8; 12]), "plaintext": String::from_utf8(serde_json::to_vec(&offer).unwrap()).unwrap(),
            "aad": String::from_utf8(relay_aad(LINK, Side::A, sealed_a.seq)).unwrap(), "body_hex": hex(&sealed_a.body),
        },
        "ble": {
            "r_hex": hex(&r), "uuid_hex": hex(&u), "uuid": ble::uuid_string(&u),
            "heard_mac_hex": hex(&ble::heard_mac(&k, &r)), "heard_mac_input": "'ble' || r",
            "ack_mac_hex": hex(&ble::ack_mac(&k, &r)), "ack_mac_input": "'ble-ack' || r (HMAC key K_conf), sent as {\"t\":\"ble_ack\",\"mac\":b64url(..)} by the advertiser after it verified a ble_heard; a scanning A takes the proof ONLY from a verified ble_ack (L1)",
            "block": "AES-128-Encrypt(K_ble, r || 'CLN1') single block",
        },
        "lan": {
            "exporter_label": crate::lan::EXPORTER_LABEL, "exporter_context": "linkId (ASCII)", "exporter_hex_for_mac_vector": hex(&e),
            "mac_dialer_hex": hex(&role_mac_bytes(&k.lan, LanRole::Dialer, &e)),
            "mac_listener_hex": hex(&role_mac_bytes(&k.lan, LanRole::Listener, &e)),
            "mac_input": "role ('dialer' | 'listener') (ASCII) || E",
            "first_frame_hex": hex(&fb), "frame": "u32 BE length of (type + payload) || u8 type || payload",
        },
        "approval_v2": approval,
        "transfer_container": transfer_container(&k.xfer),
        "on_link": {
            "interfaces": ["wlan0 192.168.1.20/24", "wlan0 fe80::1/64 (scope 2)", "wlan0 fd12:3456:789a:1::5/64"],
            "cases": onlink,
            "effective_prefix_rule": "F3: the effective on-link prefix is max(interface prefix, 24) for IPv4 and max(interface prefix, 64) for IPv6 ULA; a /8, /12 or /16 interface matches only its own /24",
            "wide_interfaces": ["wlan0 10.1.2.3/16", "wlan0 fd12:3456:789a:1::5/48"],
            "wide_cases": table(&wide, &wide_cands),
            "virtual_rule": "F3: interfaces of kind Virtual (container/VM bridges, VPN and tunnel adapters, cellular) never match; kind from the platform, else from the name deny-list (kind_from_name)",
            "virtual_interfaces": ["docker0 172.17.0.1/24", "tun0 10.8.0.2/24", "vEthernet (WSL) 172.28.80.1/20"],
            "virtual_cases": table(&virt, &virt_cands),
        },
        "relay_auth": relay_auth,
        "limits": { "lan_offer_min_port": crate::lan::MIN_OFFER_PORT, "lan_hop_limit": crate::lan::LAN_HOP_LIMIT, "max_transfer_bytes_default": crate::transfer::DEFAULT_MAX_TRANSFER_BYTES, "free_space_margin_bytes": crate::transfer::FREE_SPACE_MARGIN },
    })
}

/// Contract 11.15: a transfer container under a raw container key (here `K_xfer` of the vectors above). Every intermediate value a second
/// implementation needs: the plaintexts, their hashes, every AAD, the sender-local IVs, the frames, the index text, the commit slot, the
/// header, the whole container, and the transfer manifest (header and index first, then one record per frame).
fn transfer_container(k_xfer: &[u8; 32]) -> Value {
    use cl_crypto::backup_container::sha256_hex;
    use cl_crypto::backup_v4::{seal_record_frame, xfer_iv, XferLayout, XferRecordFacts, FRAME_OVERHEAD};
    use sha2::{Digest, Sha256};
    use crate::transfer::{Manifest, RecordMeta, TransferOptions};

    let salt = [0x6bu8; 16];
    let user = "11111111-1111-4111-8111-111111111111";
    let created = "2026-11-20T00:00:00.000Z";
    let fingerprint = "near-transfer";
    let att = "0f0e0d0c0b0a";
    let binary_a: Vec<u8> = (0..40u32).map(|i| ((i * 7 + 3) % 256) as u8).collect();
    let binary_b: Vec<u8> = (0..25u32).map(|i| ((i * 11 + 200) % 256) as u8).collect();
    let recs: Vec<(String, Vec<u8>)> = vec![
        ("meta".into(), format!(r#"{{"version":1,"userId":"{user}","note":"small json record"}}"#).into_bytes()),
        (format!("att:{att}:1:2"), binary_a),
        (format!("att:{att}:2:2"), binary_b),
    ];
    let facts: Vec<XferRecordFacts> = recs.iter().map(|(id, b)| XferRecordFacts { id: id.clone(), size: b.len() as u64, hash: sha256_hex(b) }).collect();
    let layout = XferLayout::plan(k_xfer, salt, user, created, fingerprint, &facts).unwrap();
    let prefix = &layout.header[..24];
    let slot1 = &layout.header[24 + 44..24 + 88];
    let mut commit_aad = b"cl4:commit:1:".to_vec();
    commit_aad.extend_from_slice(prefix);
    let mut commit_pt = layout.index_offset.to_be_bytes().to_vec();
    commit_pt.extend_from_slice(&(layout.index_frame.len() as u32).to_be_bytes());
    commit_pt.extend_from_slice(&1u32.to_be_bytes());

    let mut container = layout.header.clone();
    let mut record_vectors = vec![];
    for (i, (id, pt)) in recs.iter().enumerate() {
        let aad = format!("cl4:rec:1:{id}");
        let frame = seal_record_frame(k_xfer, id, pt);
        assert_eq!(frame.len() as u64, FRAME_OVERHEAD + pt.len() as u64);
        let iv = xfer_iv(k_xfer, aad.as_bytes());
        assert_eq!(&frame[4..16], &iv);
        container.extend_from_slice(&frame);
        record_vectors.push(json!({
            "id": id, "plain_hex": hex(pt), "plain_sha256_hex": sha256_hex(pt), "aad": aad, "iv_hex": hex(&iv),
            "frame_hex": hex(&frame), "frame_len": frame.len(), "container_offset": layout.offsets[i],
        }));
    }
    container.extend_from_slice(&layout.index_frame);
    assert_eq!(container.len() as u64, layout.total);
    // the transfer unit: parts of the container FILE (the desktop host's scheme), listed in send order
    let part = 256u64;
    let nparts = (container.len() as u64).div_ceil(part);
    let first_index_part = layout.index_offset / part;
    let mut order: Vec<u64> = vec![0];
    order.extend((first_index_part..nparts).filter(|p| *p != 0));
    order.extend(1..first_index_part);
    let mut part_vectors = vec![];
    let mut manifest_records = vec![];
    for n in &order {
        let (s0, e0) = ((n * part) as usize, (((n + 1) * part) as usize).min(container.len()));
        let bytes = &container[s0..e0];
        manifest_records.push(RecordMeta { id: format!("part:{n:06}"), bytes: bytes.len() as u64, sha256: hex(&Sha256::digest(bytes)), optional: false });
        part_vectors.push(json!({ "id": format!("part:{n:06}"), "container_offset": s0, "bytes": bytes.len(), "sha256": hex(&Sha256::digest(bytes)) }));
    }
    let manifest = Manifest::new(4, manifest_records, TransferOptions { include_attachments: true, ..Default::default() }, "dev-vector").unwrap();
    let mbytes = manifest.to_bytes().unwrap();
    let straddles = recs.iter().enumerate().any(|(i, _)| layout.offsets[i] / part != (layout.offsets[i] + FRAME_OVERHEAD + recs[i].1.len() as u64 - 1) / part);
    assert!(straddles, "the vector has a record split across two parts");
    json!({
        "format": "backup container v4, raw container key profile (contract 11.15)",
        "container_k_ref": "keys.K_xfer_hex",
        "header_flags": "byte 3 = 0x01; bytes 4..20 = salt; bytes 20..24 = u32 BE 1 (no key derivation; the container key IS K_xfer)",
        "iv_rule": "sender-local, readers use the IV in the frame: HMAC-SHA256(K_xfer, 'cl4:xfer:iv:' || aad)[0..12]",
        "frame_rule": "u32 BE (12 + len(ct) + 16) || IV(12) || AES-256-GCM(K_xfer, IV, aad, plaintext) ciphertext || tag(16)",
        "inputs": { "salt_hex": hex(&salt), "user_id": user, "created_at": created, "fingerprint": fingerprint },
        "records": record_vectors,
        "index": {
            "json": String::from_utf8(layout.index_json.clone()).unwrap(), "aad": "cl4:index", "iv_hex": hex(&xfer_iv(k_xfer, b"cl4:index")),
            "frame_hex": hex(&layout.index_frame), "container_offset": layout.index_offset,
        },
        "commit": {
            "slot": 1, "generation": 1, "plain_hex": hex(&commit_pt), "aad_hex": hex(&commit_aad),
            "iv_hex": hex(&xfer_iv(k_xfer, &commit_aad)), "slot_hex": hex(slot1), "slot_0": "44 zero bytes",
            "layout": "header = prefix(24) || slot 0 (44) || slot 1 (44); a slot = IV(12) || ct(16) || tag(16); plain = index_offset u64 BE || index_len u32 BE || generation u32 BE; AAD = 'cl4:commit:<slot>:' || prefix",
        },
        "prefix_hex": hex(prefix),
        "header_hex": hex(&layout.header),
        "container_hex": hex(&container),
        "container_layout": "header || data frames in record order || index frame",
        "transfer": {
            "unit": "a part of at most part_bytes of the container FILE (not a record); ids part:<6-digit number>; the manifest lists parts in SEND order: the part(s) holding the header, then those holding the index, then the rest",
            "part_bytes": part, "send_order": order, "parts": part_vectors,
            "manifest_json": String::from_utf8(mbytes.clone()).unwrap(),
            "manifest_sha256_hex": hex(&Manifest::digest(&mbytes)),
            "manifest_note": "bytes and sha256 are over the exact bytes of the part; no per-record optional flag is needed (attachments off = not written into the container)",
        },
    })
}

/// A tiny single-poll executor for the one synchronous use of an async writer into a `Vec`.
fn futures_block<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(f)
}

#[test]
fn vectors_match_the_committed_file() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("test-vectors/near-v1.json");
    let now = build();
    if std::env::var("UPDATE_VECTORS").is_ok() {
        std::fs::write(&path, serde_json::to_string_pretty(&now).unwrap() + "\n").unwrap();
        return;
    }
    let committed: Value = serde_json::from_slice(&std::fs::read(&path).expect("run with UPDATE_VECTORS=1 once")).unwrap();
    assert_eq!(now, committed, "the code no longer produces the committed vectors (or the vectors changed on purpose: UPDATE_VECTORS=1)");
}

#[test]
fn vectors_are_deterministic() {
    assert_eq!(build(), build());
}

#[test]
fn the_committed_transfer_container_opens_with_the_raw_key_and_is_not_a_backup() {
    use cl_crypto::backup_container::ContainerError;
    use cl_crypto::backup_v4::{open_any, open_v4, open_v4_raw};
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("test-vectors/near-v1.json");
    let v: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    let t = &v["transfer_container"];
    let unhex = |s: &str| -> Vec<u8> { (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect() };
    let key: [u8; 32] = unhex(v["keys"]["K_xfer_hex"].as_str().unwrap()).try_into().unwrap();
    let file = unhex(t["container_hex"].as_str().unwrap());
    let o = open_v4_raw(&file, &key).unwrap();
    assert_eq!(o.index.records.len(), 3);
    for r in t["records"].as_array().unwrap() {
        assert_eq!(hex(&o.read_bytes(&file, r["id"].as_str().unwrap()).unwrap()), r["plain_hex"].as_str().unwrap());
    }
    assert_eq!(open_v4(&file, "anything", None).err(), Some(ContainerError::TransferContainer));
    assert!(matches!(open_any(&file, "anything", None), Err(ContainerError::TransferContainer)));
}
