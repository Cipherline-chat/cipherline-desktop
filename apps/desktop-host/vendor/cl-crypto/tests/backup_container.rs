//! The v3 backup container against desktop-written files (`backup-container-v3.json`).
mod common;
use cl_crypto::backup_container::{open_container, sha256_hex, ContainerError, ContainerIndex, ContainerWriter, KeyMaterial, HEADER_LEN};
use cl_crypto::encoding::from_b64;
use common::{s, vectors};
use serde_json::Value;

fn index_of(v: &Value) -> ContainerIndex {
    serde_json::from_value(v.clone()).unwrap()
}

/// Opens both desktop generations, checks the index and that every record decrypts to bytes
/// whose SHA-256 is the hash desktop recorded.
#[test]
fn reads_desktop_containers() {
    let v = vectors("backup-container-v3.json");
    let password = s(&v, "password");
    let mut km: Option<KeyMaterial> = None;
    for gen in ["generation_1_fresh_write", "generation_2_in_place_update"] {
        let g = &v[gen];
        let file = from_b64(s(g, "container_b64")).unwrap();
        assert_eq!(file.len() as u64, g["container_byte_length"].as_u64().unwrap());
        let opened = open_container(&file, password, km.as_ref()).unwrap();
        assert_eq!(opened.index, index_of(&g["index"]), "{gen}");
        for r in &opened.index.records {
            let bytes = opened.read_bytes(&file, &r.id).unwrap();
            assert_eq!(sha256_hex(&bytes), r.hash, "{gen} {}", r.id);
        }
        if gen.starts_with("generation_2") {
            let meta: Value = serde_json::from_slice(&opened.read_bytes(&file, "meta").unwrap()).unwrap();
            assert_eq!(meta, g["changed_record_new_value"]);
            // Dead space = the superseded generation-1 meta record + the generation-1 index
            // (which ran from the end of its last record to the end of that file).
            let g1 = &v["generation_1_fresh_write"];
            let last = g1["index"]["records"].as_array().unwrap().last().unwrap().clone();
            let g1_index_len = g1["total_bytes"].as_u64().unwrap() - last["offset"].as_u64().unwrap() - last["len"].as_u64().unwrap();
            assert_eq!(opened.dead_bytes, 85 + g1_index_len);
        } else {
            assert_eq!(opened.dead_bytes, g["dead_bytes"].as_u64().unwrap());
        }
        km = Some(opened.key_material.clone());
    }
}

#[test]
fn wrong_password_and_tampering_fail() {
    let v = vectors("backup-container-v3.json");
    let file = from_b64(s(&v["generation_1_fresh_write"], "container_b64")).unwrap();
    let err = open_container(&file, "not the password", None).err().unwrap();
    assert_eq!(err.to_string(), s(&v["generation_1_fresh_write"]["wrong_password_MUST_FAIL"], "actual_error"));

    let opened = open_container(&file, s(&v, "password"), None).unwrap();
    // One flipped ciphertext byte inside the "meta" record.
    let mut bad = file.clone();
    bad[HEADER_LEN as usize + 20] ^= 1;
    assert_eq!(opened.read_bytes(&bad, "meta").err(), Some(ContainerError::AuthFailed));
    // Record AAD binds the id: the dm record's bytes cannot be read back as "meta".
    let mut swapped = opened.clone();
    let dm = swapped.index.records[1].clone();
    swapped.index.records[0].offset = dm.offset;
    swapped.index.records[0].len = dm.len;
    assert_eq!(swapped.read_bytes(&file, "meta").err(), Some(ContainerError::AuthFailed));
    // A pointer past the end of the file.
    let mut truncated = file.clone();
    truncated.truncate(file.len() - 1);
    assert!(matches!(open_container(&truncated, "x", None), Err(ContainerError::Format(_))));
}

/// Resume a DESKTOP file in place the way desktop does (one record changed, four carried),
/// then reopen it: the carried records keep their desktop offsets and still decrypt.
#[test]
fn updates_a_desktop_container_in_place() {
    let v = vectors("backup-container-v3.json");
    let password = s(&v, "password");
    let mut file = from_b64(s(&v["generation_1_fresh_write"], "container_b64")).unwrap();
    let gen1_len = file.len() as u64;
    let opened = open_container(&file, password, None).unwrap();
    let new_meta = serde_json::to_vec(&v["generation_2_in_place_update"]["changed_record_new_value"]).unwrap();
    let ids: Vec<String> = opened.index.records.iter().map(|r| r.id.clone()).collect();
    let mut w = ContainerWriter::resume(&mut file, &opened);
    for id in &ids {
        if id == "meta" {
            assert_ne!(w.previous_hash(id), Some(sha256_hex(&new_meta).as_str()));
            w.add_bytes(id, &new_meta, None).unwrap();
        } else {
            w.carry(id).unwrap();
        }
    }
    assert!(w.carry("meta").is_err(), "duplicate id must be refused");
    let done = w.finish("11111111-1111-4111-8111-111111111111", "fingerprint-gen-2", "2026-09-07T16:40:24.941Z").unwrap();
    assert_eq!(done.index.generation, 2);
    assert_eq!(done.index.records[0].offset, gen1_len);
    // Same sizes as desktop's own generation 2 (`changed_record_new_value` serialises alike).
    let desktop_gen2 = index_of(&v["generation_2_in_place_update"]["index"]);
    assert_eq!(done.index.records, desktop_gen2.records);
    assert_eq!(done.bytes, v["generation_2_in_place_update"]["container_byte_length"].as_u64().unwrap());

    let reopened = open_container(&file, password, Some(&opened.key_material)).unwrap();
    assert_eq!(reopened.index, done.index);
    for r in &reopened.index.records {
        assert_eq!(sha256_hex(&reopened.read_bytes(&file, &r.id).unwrap()), r.hash);
    }
}

#[test]
fn fresh_container_round_trips() {
    let mut file = Vec::new();
    let km = KeyMaterial::fresh("correct horse battery staple");
    let mut w = ContainerWriter::create(&mut file, km.clone()).unwrap();
    w.add_bytes("meta", br#"{"schemaVersion":4}"#, None).unwrap();
    w.add_bytes("att:1", &vec![9u8; 100_000], Some("immutable")).unwrap();
    let done = w.finish("u", "fp", "2026-11-10T00:00:00.000Z").unwrap();
    assert_eq!(done.dead_bytes, 0);
    let opened = open_container(&file, "correct horse battery staple", None).unwrap();
    assert_eq!(&*opened.read_bytes(&file, "att:1").unwrap(), &vec![9u8; 100_000][..]);
    assert_eq!(opened.index.records[1].hash, "immutable");
    assert!(open_container(&file, "wrong", Some(&km)).is_ok(), "matching salt reuses the derived key");
}
