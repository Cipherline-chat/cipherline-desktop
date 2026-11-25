//! The transfer profile of the v4 container (contract 11.15): a RAW 32-byte container key, no key derivation.
use cl_crypto::backup_container::{sha256_hex, ContainerError, KeyMaterial};
use cl_crypto::backup_v4::{open_any, open_v4, open_v4_raw, seal_record_frame, WriterV4, XferLayout, XferRecordFacts, FLAG_RAW_KEY, HEADER_LEN_V4};

const KEY: [u8; 32] = [0x5a; 32];
const SALT: [u8; 16] = [0x11; 16];
const AT: &str = "2026-11-20T00:00:00.000Z";

fn records() -> Vec<(String, Vec<u8>)> {
    vec![
        ("meta".into(), br#"{"version":1,"userId":"u-1"}"#.to_vec()),
        ("att:a1:1:2".into(), (0u8..40).collect()),
        ("att:a1:2:2".into(), (100u8..125).collect()),
    ]
}

fn facts(r: &[(String, Vec<u8>)]) -> Vec<XferRecordFacts> {
    r.iter().map(|(id, b)| XferRecordFacts { id: id.clone(), size: b.len() as u64, hash: sha256_hex(b) }).collect()
}

fn assemble(layout: &XferLayout, r: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut f = layout.header.clone();
    for (id, b) in r {
        f.extend_from_slice(&seal_record_frame(&KEY, id, b));
    }
    f.extend_from_slice(&layout.index_frame);
    f
}

#[test]
fn a_planned_container_opens_with_the_raw_key_and_every_record_reads_back() {
    let r = records();
    let layout = XferLayout::plan(&KEY, SALT, "u-1", AT, "xfer", &facts(&r)).unwrap();
    let file = assemble(&layout, &r);
    assert_eq!(file.len() as u64, layout.total);
    assert_eq!(layout.header.len() as u64, HEADER_LEN_V4);
    assert_eq!(layout.header[3], FLAG_RAW_KEY);
    let o = open_v4_raw(&file, &KEY).unwrap();
    assert_eq!(o.index, layout.index);
    for (id, b) in &r {
        assert_eq!(&*o.read_bytes(&file, id).unwrap(), b, "{id}");
    }
    for (i, rec) in o.index.records.iter().enumerate() {
        assert_eq!(rec.offset, layout.offsets[i]);
    }
}

#[test]
fn the_streaming_plan_and_the_writer_make_the_same_bytes() {
    let r = records();
    let layout = XferLayout::plan(&KEY, SALT, "u-1", AT, "xfer", &facts(&r)).unwrap();
    let mut buf = Vec::new();
    let mut w = WriterV4::create_raw(&mut buf, &KEY, SALT).unwrap();
    for (id, b) in &r {
        w.add_bytes(id, b, None).unwrap();
    }
    w.finish("u-1", "xfer", AT).unwrap();
    assert_eq!(buf, assemble(&layout, &r));
}

#[test]
fn a_wrong_key_or_a_flipped_byte_fails_authentication() {
    let r = records();
    let layout = XferLayout::plan(&KEY, SALT, "u-1", AT, "xfer", &facts(&r)).unwrap();
    let file = assemble(&layout, &r);
    assert_eq!(open_v4_raw(&file, &[0x5b; 32]).err(), Some(ContainerError::AuthFailed));
    let mut bad = file.clone();
    bad[layout.offsets[1] as usize + 20] ^= 1;
    let o = open_v4_raw(&bad, &KEY).unwrap();
    assert_eq!(o.read_bytes(&bad, "att:a1:1:2").err(), Some(ContainerError::AuthFailed));
    // a record swapped into another id's place does not authenticate (the id is in the AAD)
    let mut swapped = file.clone();
    let (a, b) = (layout.offsets[1] as usize, layout.offsets[2] as usize);
    let (la, lb) = (40 + 32, 25 + 32);
    let fa = file[a..a + la].to_vec();
    let fb = file[b..b + lb].to_vec();
    assert_ne!(la, lb);
    swapped.splice(a..a + la, fb.iter().copied());
    assert!(open_v4_raw(&swapped, &KEY).is_err() || { let o = open_v4_raw(&swapped, &KEY).unwrap(); o.read_bytes(&swapped, "att:a1:1:2").is_err() });
    let _ = fa;
}

#[test]
fn a_transfer_container_is_never_a_backup_and_a_backup_is_never_a_transfer() {
    let r = records();
    let layout = XferLayout::plan(&KEY, SALT, "u-1", AT, "xfer", &facts(&r)).unwrap();
    let file = assemble(&layout, &r);
    assert_eq!(open_v4(&file, "any passphrase", None).err(), Some(ContainerError::TransferContainer));
    assert!(matches!(open_any(&file, "x", None), Err(ContainerError::TransferContainer)));
    // a passphrase backup is refused by the raw opener, and its bytes keep flags = 0
    let mut backup = Vec::new();
    let mut w = WriterV4::create(&mut backup, KeyMaterial::derive("pw", SALT)).unwrap();
    w.add_bytes("meta", b"{}", None).unwrap();
    w.finish("u", "fp", AT).unwrap();
    assert_eq!(backup[3], 0);
    assert!(matches!(open_v4_raw(&backup, &KEY), Err(ContainerError::Format(_))));
    open_v4(&backup, "pw", None).unwrap();
}

#[test]
fn the_same_inputs_give_the_same_bytes_and_distinct_ids_get_distinct_ivs() {
    let r = records();
    let a = XferLayout::plan(&KEY, SALT, "u-1", AT, "xfer", &facts(&r)).unwrap();
    let b = XferLayout::plan(&KEY, SALT, "u-1", AT, "xfer", &facts(&r)).unwrap();
    assert_eq!(assemble(&a, &r), assemble(&b, &r));
    let f1 = seal_record_frame(&KEY, "att:a1:1:2", &r[1].1);
    let f2 = seal_record_frame(&KEY, "att:a1:2:2", &r[1].1);
    assert_ne!(f1[4..16], f2[4..16], "the IV depends on the AAD, which carries the id");
    // a duplicate id is refused when planning
    let mut dup = facts(&r);
    dup.push(dup[0].clone());
    assert!(XferLayout::plan(&KEY, SALT, "u-1", AT, "xfer", &dup).is_err());
}

#[test]
fn a_resumed_transfer_container_seals_with_random_ivs() {
    let r = records();
    let layout = XferLayout::plan(&KEY, SALT, "u-1", AT, "xfer", &facts(&r)).unwrap();
    let mut file = assemble(&layout, &r);
    let o = open_v4_raw(&file, &KEY).unwrap();
    let before = file.len();
    let mut w = WriterV4::resume(&mut file, &o);
    w.add_bytes("meta", b"{\"v\":2}", None).unwrap();
    w.finish("u-1", "xfer2", AT).unwrap();
    assert!(file.len() > before);
    let g2 = open_v4_raw(&file, &KEY).unwrap();
    assert_eq!(g2.index.generation, 2);
    assert_eq!(&*g2.read_bytes(&file, "meta").unwrap(), b"{\"v\":2}");
}

#[test]
fn reads_a_transfer_container_written_by_the_desktop_typescript_writer() {
    let path = format!("{}/../cl-near/test-vectors/ts-transfer-container.json", env!("CARGO_MANIFEST_DIR"));
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let unhex = |s: &str| -> Vec<u8> { (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect() };
    let key: [u8; 32] = unhex(v["ck_hex"].as_str().unwrap()).try_into().unwrap();
    let file = unhex(v["container_hex"].as_str().unwrap());
    let o = open_v4_raw(&file, &key).unwrap();
    assert_eq!(o.index.user_id, "u-ts");
    assert_eq!(o.index.fingerprint, "ts-fixture");
    assert_eq!(&*o.read_bytes(&file, "meta").unwrap(), v["records"][0]["plain_text"].as_str().unwrap().as_bytes());
    assert_eq!(hex_of(&o.read_bytes(&file, "att:ts-att-1").unwrap()), v["records"][1]["plain_hex"].as_str().unwrap());
    assert_eq!(open_v4(&file, "pw", None).err(), Some(ContainerError::TransferContainer));
}

fn hex_of(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }
