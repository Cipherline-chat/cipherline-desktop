//! History transfer storage: the container file (spooled by the renderer through the existing `backup*`
//! bridge, so the bytes never take a second IPC path) is split into parts of at most [`PART_BYTES`] that
//! become cl-near records. The host hashes and serves them in 1 MiB frames with constant memory; the
//! receiver keeps each committed part on disk (`FileRecordSink`) with resume bookkeeping in a progress file,
//! then [`assemble`] concatenates them into the container the renderer opens with `backupReadRange`.
use cl_crypto::backup_v4::HEADER_LEN_V4;
use cl_near::transfer::{Manifest, RecordMeta, RecordSource, TransferOptions};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// Contract section 10: parts of at most 16 MiB.
pub const PART_BYTES: u64 = 16 * 1024 * 1024;

/// The index and the header of a container sit at its two ENDS (header first, index last), so a transfer that is stopped
/// part-way is only useful if it already holds both: the sender therefore sends part 0 and the LAST part first, then the
/// rest in order. `send_order(4) == [0, 3, 1, 2]`. A record's id is `part:<part number>`, whatever its manifest position.
pub fn send_order(parts: u32) -> Vec<u32> {
    if parts <= 2 {
        return (0..parts).collect();
    }
    let mut v = vec![0, parts - 1];
    v.extend(1..parts - 1);
    v
}

/// The phone core's order (contract 11.15, hand-off "Transfer container"): the part(s) holding the header (part 0), then every
/// part from the one holding the index's first byte to the last, then the rest ascending. `index_part` is `index_offset /
/// part_bytes`; with it unknown this falls back to [`send_order`]. For a container whose index fits in the last part the two agree.
pub fn send_order_for(parts: u32, index_part: Option<u32>) -> Vec<u32> {
    let Some(ip) = index_part.filter(|ip| *ip < parts) else { return send_order(parts) };
    let mut v = vec![0u32];
    v.extend((ip.max(1))..parts);
    v.extend(1..ip.max(1));
    v
}

/// Where the index frame of a transfer container starts and whether it holds attachments, read through the raw key (`None` when the file is not a transfer
/// container under that key: tests spool opaque bytes).
pub fn index_facts(path: &Path, key: &[u8; 32]) -> Option<(u64, bool)> {
    struct FileSource(std::cell::RefCell<File>);
    impl cl_crypto::backup_container::ByteSource for FileSource {
        fn size(&self) -> Result<u64, cl_crypto::backup_container::ContainerError> {
            self.0.borrow().metadata().map(|m| m.len()).map_err(|e| cl_crypto::backup_container::ContainerError::InvalidInput(e.to_string()))
        }
        fn read(&self, offset: u64, len: usize) -> Result<Vec<u8>, cl_crypto::backup_container::ContainerError> {
            let mut f = self.0.borrow_mut();
            let mut out = vec![0u8; len];
            f.seek(SeekFrom::Start(offset)).and_then(|_| f.read_exact(&mut out)).map_err(|e| cl_crypto::backup_container::ContainerError::InvalidInput(e.to_string()))?;
            Ok(out)
        }
    }
    let src = FileSource(std::cell::RefCell::new(File::open(path).ok()?));
    let opened = cl_crypto::backup_v4::open_v4_raw(&src, key).ok()?;
    // the index frame sits after every data frame: the end of the last record, or the header when there are none
    let end = opened.index.records.iter().map(|r| r.offset + r.len).max().unwrap_or(HEADER_LEN_V4);
    Some((end, opened.index.records.iter().any(|r| r.id.starts_with("att:"))))
}

/// The part number an id names (`part:000007` -> 7).
pub fn part_number(id: &str) -> Option<u32> {
    id.strip_prefix("part:")?.parse().ok()
}

pub struct FilePartsSource {
    manifest: Manifest,
    file: File,
    part: u64,
    /// Manifest position -> part number (the manifest is in send order).
    order: Vec<u32>,
}

impl FilePartsSource {
    /// Streams the file once to hash every part (constant memory), then serves chunks on demand.
    pub fn open(path: &Path, sender_device_id: &str, part: u64) -> io::Result<Self> {
        Self::open_keyed(path, sender_device_id, part, None)
    }

    /// As [`open`], with the transfer key when it is known: the manifest then lists the index part(s) exactly as the phone core
    /// does (header part, then every part from the index's first byte to the last, then the rest).
    pub fn open_keyed(path: &Path, sender_device_id: &str, part: u64, key: Option<&[u8; 32]>) -> io::Result<Self> {
        let facts = key.and_then(|k| index_facts(path, k));
        let index_part = facts.map(|(o, _)| (o / part) as u32);
        let mut f = File::open(path)?;
        let size = f.metadata()?.len();
        let mut metas = vec![];
        let mut buf = vec![0u8; 1 << 20];
        let mut idx = 0u64;
        let mut off = 0u64;
        while off < size || (size == 0 && idx == 0) {
            let len = (size - off).min(part);
            let mut h = Sha256::new();
            let mut left = len;
            while left > 0 {
                let cap = (left as usize).min(buf.len());
                let n = f.read(&mut buf[..cap])?;
                if n == 0 {
                    return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "file shrank while hashing"));
                }
                h.update(&buf[..n]);
                left -= n as u64;
            }
            metas.push(RecordMeta { id: format!("part:{idx:06}"), bytes: len, sha256: h.finalize().iter().map(|b| format!("{b:02x}")).collect(), optional: false });
            off += len;
            idx += 1;
            if size == 0 {
                break;
            }
        }
        let order = send_order_for(metas.len() as u32, index_part);
        let metas: Vec<RecordMeta> = order.iter().map(|n| metas[*n as usize].clone()).collect();
        let manifest = Manifest::new(4, metas, TransferOptions { include_attachments: facts.map(|(_, a)| a).unwrap_or(TransferOptions::default().include_attachments), ..TransferOptions::default() }, sender_device_id).map_err(|e| io::Error::other(e.to_string()))?;
        Ok(Self { manifest, file: f, part, order })
    }
}

impl RecordSource for FilePartsSource {
    fn manifest(&self) -> &Manifest {
        &self.manifest
    }
    fn read_chunk(&mut self, index: u32, offset: u64, max: usize, out: &mut Vec<u8>) -> io::Result<()> {
        let meta = self.manifest.records.get(index as usize).ok_or_else(|| io::Error::other("no such record"))?;
        if offset >= meta.bytes {
            return Ok(());
        }
        let n = (meta.bytes - offset).min(max as u64) as usize;
        let number = *self.order.get(index as usize).ok_or_else(|| io::Error::other("no such record"))?;
        self.file.seek(SeekFrom::Start(u64::from(number) * self.part + offset))?;
        out.resize(n, 0);
        self.file.read_exact(out)
    }
}

/// The manifest's part layout, validated like the phone's `SpoolSource::new` (the peer chose every id and size): every id names a part
/// number, the numbers are unique and exactly `0..n`, every part is the full (largest) size except the last one, and the sizes add up
/// to `total_bytes`. Returns the part size and, per manifest position, the part number. Nothing here trusts a number to be small:
/// callers place a part at `checked_part_offset`.
pub fn validated_layout(manifest: &Manifest) -> io::Result<(u64, Vec<u32>)> {
    let bad = |what: &str| io::Error::other(format!("transfer manifest refused: {what}"));
    let r = &manifest.records;
    let part = r.iter().map(|m| m.bytes).max().filter(|p| *p > 0).ok_or_else(|| bad("no parts"))?;
    let mut by_number: std::collections::BTreeMap<u32, usize> = std::collections::BTreeMap::new();
    for (i, m) in r.iter().enumerate() {
        let n = part_number(&m.id).ok_or_else(|| bad("a part id is not a part number"))?;
        if by_number.insert(n, i).is_some() {
            return Err(bad("a part number appears twice"));
        }
    }
    let n = by_number.len() as u32;
    if by_number.keys().copied().ne(0..n) {
        return Err(bad("part numbers are not 0..n-1"));
    }
    let mut sum = 0u64;
    for (num, i) in &by_number {
        if r[*i].bytes != part && *num != n - 1 {
            return Err(bad("a part other than the last is not full-size"));
        }
        sum = sum.checked_add(r[*i].bytes).ok_or_else(|| bad("sizes overflow"))?;
    }
    if sum != manifest.total_bytes {
        return Err(bad("part sizes do not add up to the total"));
    }
    let numbers = r.iter().map(|m| part_number(&m.id).expect("validated above")).collect();
    Ok((part, numbers))
}

/// `number * part`, refusing an overflow.
fn checked_part_offset(number: u32, part: u64) -> io::Result<u64> {
    u64::from(number).checked_mul(part).ok_or_else(|| io::Error::other("part offset overflows"))
}

/// Concatenate the committed parts (`<dir>/<index>.rec`) into `out` after re-checking each size and hash.
/// Written to a temp name and renamed, so a half-assembled file is never mistaken for a container; the temp file is removed on ANY error.
pub fn assemble(dir: &Path, manifest: &Manifest, out: &Path) -> io::Result<u64> {
    let (_, numbers) = validated_layout(manifest)?;
    let tmp = out.with_extension("assembling");
    let res = assemble_into(dir, manifest, &numbers, &tmp);
    match res {
        Ok(total) => std::fs::rename(&tmp, out).map(|_| total).inspect_err(|_| { let _ = std::fs::remove_file(&tmp); }),
        Err(e) => { let _ = std::fs::remove_file(&tmp); Err(e) }
    }
}

fn assemble_into(dir: &Path, manifest: &Manifest, numbers: &[u32], tmp: &Path) -> io::Result<u64> {
    let mut w = File::create(tmp)?;
    let mut total = 0u64;
    let mut buf = vec![0u8; 1 << 20];
    // the manifest is in SEND order; the file is in part order
    let mut in_file_order: Vec<(u32, usize)> = numbers.iter().copied().zip(0..).collect();
    in_file_order.sort_unstable();
    for (_, i) in in_file_order {
        let meta = &manifest.records[i];
        let mut f = File::open(dir.join(format!("{i}.rec")))?;
        let mut h = Sha256::new();
        let mut n_total = 0u64;
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
            w.write_all(&buf[..n])?;
            n_total += n as u64;
        }
        let hex: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if n_total != meta.bytes || hex != meta.sha256 {
            return Err(io::Error::other(format!("part {i} does not match the manifest")));
        }
        total += n_total;
    }
    w.sync_all()?;
    Ok(total)
}

/// What a stopped transfer left: a file of the full size with every VERIFIED part in place (the rest zero) and the byte
/// ranges that are real. Nothing here is a complete container; the page applies only the records whose bytes lie inside
/// `ranges` (contract 11.10 "keep what arrived").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartialFile {
    pub size: u64,
    /// `(offset, length)`, sorted and coalesced.
    pub ranges: Vec<(u64, u64)>,
    pub parts_held: u32,
    pub parts_total: u32,
}

/// Build the sparse file for [`PartialFile`]. `held` = manifest positions the progress file says were committed; each is
/// re-hashed against the manifest before it is trusted, and one that does not match is simply not held.
pub fn assemble_partial(dir: &Path, manifest: &Manifest, held: &[u32], out: &Path) -> io::Result<PartialFile> {
    let (part, _) = validated_layout(manifest)?;
    let tmp = out.with_extension("assembling");
    match assemble_partial_into(dir, manifest, held, part, &tmp) {
        Ok(pf) => match std::fs::rename(&tmp, out) {
            Ok(()) => Ok(pf),
            Err(e) => { let _ = std::fs::remove_file(&tmp); Err(e) }
        },
        Err(e) => { let _ = std::fs::remove_file(&tmp); Err(e) }
    }
}

fn assemble_partial_into(dir: &Path, manifest: &Manifest, held: &[u32], part: u64, tmp: &Path) -> io::Result<PartialFile> {
    let total = manifest.total_bytes;
    let mut w = File::create(tmp)?;
    w.set_len(total)?;
    let mut ranges: Vec<(u64, u64)> = vec![];
    let mut parts_held = 0u32;
    let mut buf = vec![0u8; 1 << 20];
    for &i in held {
        let Some(meta) = manifest.records.get(i as usize) else { continue };
        let Some(number) = part_number(&meta.id) else { continue };
        let Ok(mut f) = File::open(dir.join(format!("{i}.rec"))) else { continue };
        let mut h = Sha256::new();
        let mut data = Vec::with_capacity(meta.bytes as usize);
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            h.update(&buf[..n]);
            data.extend_from_slice(&buf[..n]);
        }
        let hex: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if data.len() as u64 != meta.bytes || hex != meta.sha256 {
            continue;
        }
        let off = checked_part_offset(number, part)?;
        if off.checked_add(meta.bytes).is_none_or(|e| e > total) {
            return Err(io::Error::other("part lies outside the container"));
        }
        w.seek(SeekFrom::Start(off))?;
        w.write_all(&data)?;
        ranges.push((off, meta.bytes));
        parts_held += 1;
    }
    w.sync_all()?;
    drop(w);
    ranges.sort_unstable();
    let mut merged: Vec<(u64, u64)> = vec![];
    for (o, l) in ranges {
        match merged.last_mut() {
            Some(last) if last.0 + last.1 == o => last.1 += l,
            _ => merged.push((o, l)),
        }
    }
    Ok(PartialFile { size: total, ranges: merged, parts_held, parts_total: manifest.record_count })
}

pub fn recv_dir(profile: &Path) -> PathBuf {
    profile.join("near-recv")
}

/// The persisted paused flag (contract 11.9, "persisted flag on both sides"): `<profile>/near-paused` holds `me` or `peer` while a transfer
/// is paused on purpose, and is gone otherwise. Best effort (a failed write is only a lost hint).
pub fn paused_flag_path(profile: &Path) -> PathBuf {
    profile.join("near-paused")
}
pub fn persist_pause(profile: &Path, by: Option<&str>) {
    let p = paused_flag_path(profile);
    match by {
        Some(b) => {
            let _ = std::fs::write(p, b);
        }
        None => {
            if p.exists() {
                let _ = std::fs::remove_file(p);
            }
        }
    }
}
pub fn read_paused_flag(profile: &Path) -> Option<String> {
    std::fs::read_to_string(paused_flag_path(profile)).ok().filter(|s| matches!(s.as_str(), "me" | "peer"))
}

/// A transfer cannot resume across a NEW sign-in session: `K_xfer` (the key the spooled container is sealed under) is per session and
/// lives only in memory, so whatever an older session left is unreadable and unreachable. Remove every spool directory, every received
/// container awaiting import (except `keep`: the file a page may still be importing) and the persisted paused flag. Returns how many spools/containers were removed.
pub fn purge_stale(profile: &Path, staging: &Path, keep: Option<&Path>) -> usize {
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(recv_dir(profile)) {
        for e in rd.flatten() {
            let p = e.path();
            if (if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) }).is_ok() {
                n += 1;
            }
        }
    }
    if let Ok(rd) = std::fs::read_dir(staging) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if (name.starts_with("near-received-") || name.starts_with("near-partial-")) && (name.ends_with(".container") || name.ends_with(".assembling")) && keep != Some(e.path().as_path()) && std::fs::remove_file(e.path()).is_ok() {
                n += 1;
            }
        }
    }
    persist_pause(profile, None);
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    use cl_near::approval::Proximity;
    use cl_near::conn::{Conn, ConnConfig};
    use cl_near::proof::ProximityProof;
    use cl_near::testutil::FaultyStream;
    use cl_near::transfer::{run_receiver, run_sender, FileRecordSink, FileStore, TransferOpts};

    fn data(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i.wrapping_mul(2654435761) >> 7) as u8).collect()
    }

    #[test]
    fn manifest_splits_hashes_and_serves_exact_bytes() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("c.enc");
        let bytes = data(10_000);
        std::fs::write(&p, &bytes).unwrap();
        let mut s = FilePartsSource::open(&p, "dev", 4096).unwrap();
        assert_eq!(s.manifest().records.iter().map(|r| r.bytes).collect::<Vec<_>>(), vec![4096, 1808, 4096], "send order: part 0, the LAST part, then the rest");
        let mut by_part: Vec<(u32, Vec<u8>)> = vec![];
        for i in 0..3u32 {
            let (mut off, mut part) = (0u64, vec![]);
            loop {
                let mut c = vec![];
                s.read_chunk(i, off, 1000, &mut c).unwrap();
                if c.is_empty() {
                    break;
                }
                off += c.len() as u64;
                part.extend(c);
            }
            let hex: String = Sha256::digest(&part).iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(hex, s.manifest().records[i as usize].sha256);
            by_part.push((part_number(&s.manifest().records[i as usize].id).unwrap(), part));
        }
        by_part.sort();
        assert_eq!(by_part.into_iter().flat_map(|(_, p)| p).collect::<Vec<u8>>(), bytes);
    }

    #[tokio::test]
    async fn transfer_survives_a_dropped_connection_and_resumes_by_part() {
        let d = tempfile::tempdir().unwrap();
        let src_path = d.path().join("src.enc");
        let bytes = data(3 * 1024 * 1024 + 123);
        std::fs::write(&src_path, &bytes).unwrap();
        let mut src = FilePartsSource::open(&src_path, "dev-a", 1024 * 1024).unwrap();
        let rdir = d.path().join("recv");
        let mut sink = FileRecordSink::new(&rdir).unwrap();
        let mut store = FileStore::new(d.path().join("progress.json"));
        let proof = ProximityProof::for_tests(Proximity::Lan, "link");
        let opts = TransferOpts::default();
        // attempt 1: the receiver's connection dies after ~1.5 MiB
        let (a, b) = tokio::io::duplex(256 * 1024);
        let s1 = run_sender(Conn::new(a, ConnConfig::default()), &proof, &mut src, &opts);
        let r1 = run_receiver(Conn::new(FaultyStream::new(b, 1_500_000), ConnConfig::default()), &proof, &mut sink, &mut store, &opts);
        let (rs, rr) = tokio::join!(s1, r1);
        assert!(rs.is_err() || rr.is_err(), "the injected drop must surface");
        // attempt 2: a NEW connection finishes it
        let (a, b) = tokio::io::duplex(256 * 1024);
        let s2 = run_sender(Conn::new(a, ConnConfig::default()), &proof, &mut src, &opts);
        let r2 = run_receiver(Conn::new(b, ConnConfig::default()), &proof, &mut sink, &mut store, &opts);
        let (rs, rr) = tokio::join!(s2, r2);
        rs.unwrap();
        let sum = rr.unwrap();
        assert!(sum.complete);
        assert!(sum.records_received < 4, "resume skipped the parts already held (got {})", sum.records_received);
        let out = d.path().join("history.container");
        let m = src.manifest().clone();
        assert_eq!(assemble(&rdir, &m, &out).unwrap(), bytes.len() as u64);
        assert_eq!(std::fs::read(&out).unwrap(), bytes);
    }

    #[test]
    fn parts_go_out_header_and_index_first_and_reassemble_in_file_order() {
        assert_eq!(send_order(1), [0]);
        assert_eq!(send_order(2), [0, 1]);
        assert_eq!(send_order(5), [0, 4, 1, 2, 3]);
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("c.enc");
        let bytes = data(4096 * 4 + 100);
        std::fs::write(&p, &bytes).unwrap();
        let s = FilePartsSource::open(&p, "dev", 4096).unwrap();
        let ids: Vec<&str> = s.manifest().records.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["part:000000", "part:000004", "part:000001", "part:000002", "part:000003"]);
        // write every part under its MANIFEST position, as the receiver does, and reassemble
        let r = d.path().join("r");
        std::fs::create_dir_all(&r).unwrap();
        let mut src = s;
        for i in 0..5u32 {
            let (mut off, mut part) = (0u64, vec![]);
            loop {
                let mut c = vec![];
                src.read_chunk(i, off, 1000, &mut c).unwrap();
                if c.is_empty() {
                    break;
                }
                off += c.len() as u64;
                part.extend(c);
            }
            std::fs::write(r.join(format!("{i}.rec")), part).unwrap();
        }
        let out = d.path().join("o");
        assert_eq!(assemble(&r, src.manifest(), &out).unwrap(), bytes.len() as u64);
        assert_eq!(std::fs::read(&out).unwrap(), bytes, "back in FILE order");
        // a stopped transfer: only manifest positions 0 (part 0), 1 (the last part) and 2 (part 1) arrived
        let po = d.path().join("partial");
        let pf = assemble_partial(&r, src.manifest(), &[0, 1, 2], &po).unwrap();
        assert_eq!((pf.parts_held, pf.parts_total, pf.size), (3, 5, bytes.len() as u64));
        assert_eq!(pf.ranges, vec![(0, 8192), (16384, 100)], "parts 0 and 1 are contiguous; the last part (the index) stands alone");
        let got = std::fs::read(&po).unwrap();
        assert_eq!(&got[..8192], &bytes[..8192]);
        assert_eq!(&got[16384..], &bytes[16384..]);
        assert!(got[8192..16384].iter().all(|b| *b == 0), "what did not arrive is zero, never guessed");
        // a held part whose bytes were damaged on disk is not held
        std::fs::write(r.join("1.rec"), vec![9u8; 100]).unwrap();
        let pf2 = assemble_partial(&r, src.manifest(), &[0, 1, 2], &po).unwrap();
        assert_eq!(pf2.parts_held, 2);
    }

    fn manifest_of(parts: &[(&str, u64)]) -> Manifest {
        let h = "0".repeat(64);
        let recs = parts.iter().map(|(id, b)| RecordMeta { id: (*id).into(), bytes: *b, sha256: h.clone(), optional: false }).collect();
        Manifest::new(4, recs, TransferOptions::default(), "dev").unwrap()
    }

    #[test]
    fn a_hostile_manifest_layout_is_refused_before_anything_is_written() {
        let d = tempfile::tempdir().unwrap();
        let out = d.path().join("o");
        let tmp = out.with_extension("assembling");
        let bad: Vec<(&str, Vec<(&str, u64)>)> = vec![
            ("duplicate number (two spellings)", vec![("part:000000", 10), ("part:0", 10)]),
            ("a gap in the numbers", vec![("part:000000", 10), ("part:000002", 10)]),
            ("a number far outside the manifest", vec![("part:000000", 10), ("part:4000000000", 10)]),
            ("not a part id", vec![("part:000000", 10), ("other", 10)]),
            ("a short part that is not last", vec![("part:000000", 4), ("part:000001", 10)]),
            ("all zero sized", vec![("part:000000", 0)]),
        ];
        for (what, parts) in bad {
            let m = manifest_of(&parts);
            assert!(validated_layout(&m).is_err(), "{what}");
            assert!(assemble(d.path(), &m, &out).is_err(), "assemble: {what}");
            assert!(assemble_partial(d.path(), &m, &[0, 1], &out).is_err(), "partial: {what}");
            assert!(!tmp.exists() && !out.exists(), "nothing left behind: {what}");
        }
        // a sane one passes: full parts, a shorter last part, sent out of order
        let ok = manifest_of(&[("part:000000", 10), ("part:000002", 3), ("part:000001", 10)]);
        assert_eq!(validated_layout(&ok).unwrap(), (10, vec![0, 2, 1]));
        assert!(checked_part_offset(u32::MAX, u64::MAX).is_err(), "an overflowing offset is refused, never wrapped");
    }

    #[test]
    fn the_temp_file_is_removed_when_a_part_is_missing_or_wrong() {
        let d = tempfile::tempdir().unwrap();
        let m = manifest_of(&[("part:000000", 4), ("part:000001", 2)]);
        let out = d.path().join("o");
        std::fs::write(d.path().join("0.rec"), [1u8; 4]).unwrap(); // 1.rec is absent; hashes are wrong anyway
        assert!(assemble(d.path(), &m, &out).is_err());
        assert!(!out.with_extension("assembling").exists() && !out.exists());
        assert!(assemble_partial(d.path(), &m, &[0], &out).is_ok(), "an unverifiable held part is simply not held");
    }

    #[test]
    fn send_order_follows_the_phones_rule_header_then_index_parts_then_the_rest() {
        assert_eq!(send_order_for(4, Some(1)), vec![0, 1, 2, 3]); // index starts in part 1 and runs to the end
        assert_eq!(send_order_for(6, Some(4)), vec![0, 4, 5, 1, 2, 3]);
        assert_eq!(send_order_for(4, Some(3)), vec![0, 3, 1, 2]); // index fits in the last part: same as the legacy order
        assert_eq!(send_order_for(3, Some(0)), vec![0, 1, 2]); // index starts in part 0 (tiny container)
        assert_eq!(send_order_for(4, None), send_order(4));
        assert_eq!(send_order_for(1, Some(0)), vec![0]);
        assert_eq!(send_order_for(4, Some(9)), send_order(4)); // a pointer past the end is ignored
    }

    #[test]
    fn assemble_refuses_a_part_that_does_not_match() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("c.enc");
        std::fs::write(&p, data(5000)).unwrap();
        let s = FilePartsSource::open(&p, "dev", 4096).unwrap();
        let rdir = d.path().join("r");
        std::fs::create_dir_all(&rdir).unwrap();
        std::fs::write(rdir.join("0.rec"), data(4096)).unwrap();
        let mut bad = data(904);
        bad[3] ^= 1;
        std::fs::write(rdir.join("1.rec"), bad).unwrap();
        let out = d.path().join("o");
        assert!(assemble(&rdir, s.manifest(), &out).is_err());
        assert!(!out.exists() && !out.with_extension("assembling").exists());
    }
}
