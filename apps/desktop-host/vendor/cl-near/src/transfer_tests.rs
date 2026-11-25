use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sha2::{Digest, Sha256};

use crate::conn::{Conn, ConnConfig};
use crate::error::NearError;
use crate::frame::*;
use crate::testutil::*;
use crate::transfer::*;

fn pair() -> (Conn, Conn) {
    let (a, b) = tokio::io::duplex(256 * 1024);
    (Conn::new(a, ConnConfig::default()), Conn::new(b, ConnConfig::default()))
}

fn lanproof() -> crate::proof::ProximityProof { crate::proof::ProximityProof::for_tests(crate::approval::Proximity::Lan, "L") }

fn opts() -> TransferOpts { TransferOpts { step_timeout: Duration::from_secs(10), ..Default::default() } }

#[tokio::test]
async fn full_transfer_delivers_identical_bytes() {
    // sizes: empty, tiny, exactly one chunk, one chunk + 1, multi-chunk
    let sizes = [0, 5, CHUNK as u64, CHUNK as u64 + 1, 3 * CHUNK as u64 + 17];
    let mut src = SyntheticSource::with_sizes(&sizes, 42);
    let want_total = src.manifest().total_bytes;
    let (cs, cr) = pair();
    let mut sink = MemSink::new(true);
    let mut store = SharedStore::default();
    let progress_log = Arc::new(Mutex::new(vec![]));
    let log = progress_log.clone();
    let o = TransferOpts { progress: Some(Arc::new(move |p| log.lock().unwrap().push(p))), ..opts() };
    let tx = tokio::spawn(async move { let r = run_sender(cs, &lanproof(), &mut src, &opts()).await; (r, src) });
    let rx = run_receiver(cr, &lanproof(), &mut sink, &mut store, &o).await.unwrap();
    let (tx_r, mut src) = tx.await.unwrap();
    let tx_r = tx_r.unwrap();
    assert!(rx.complete);
    assert_eq!((rx.records_received, tx_r.records_sent), (5, 5));
    assert_eq!(rx.bytes_received, want_total);
    for (i, s) in sizes.iter().enumerate() {
        let got = &sink.records[&(i as u32)];
        assert_eq!(got.len() as u64, *s);
        let mut expect = vec![];
        let mut off = 0;
        loop {
            let mut b = vec![];
            use crate::transfer::RecordSource;
            src.read_chunk(i as u32, off, CHUNK, &mut b).unwrap();
            if b.is_empty() { break }
            off += b.len() as u64;
            expect.extend_from_slice(&b);
        }
        assert_eq!(*got, expect, "record {i}");
    }
    let log = progress_log.lock().unwrap();
    assert_eq!(log.last().unwrap().bytes_done, want_total);
    assert!(log.windows(2).all(|w| w[0].bytes_done <= w[1].bytes_done), "progress is monotonic");
    assert!(log.iter().any(|p| p.bytes_done > 0 && p.bytes_done < want_total), "byte-level progress inside a record");
}

#[tokio::test]
async fn drop_then_resume_on_a_new_connection_sends_only_what_is_missing() {
    let sizes = vec![2 * CHUNK as u64 + 100; 8];
    let total: u64 = sizes.iter().sum();
    let mut src = SyntheticSource::with_sizes(&sizes, 7);
    let mut sink = MemSink::new(false);
    let store = SharedStore::default();

    // connection 1: dies after ~45% of the bytes
    let (a, b) = tokio::io::duplex(256 * 1024);
    let limit = total * 45 / 100;
    let cs = Conn::new(FaultyStream::new(a, limit), ConnConfig::default());
    let cr = Conn::new(b, ConnConfig::default());
    let mut st = store.clone();
    let tx = tokio::spawn(async move { let r = run_sender(cs, &lanproof(), &mut src, &opts()).await; (r, src) });
    let r1 = run_receiver(cr, &lanproof(), &mut sink, &mut st, &opts()).await;
    let (t1, mut src) = tx.await.unwrap();
    assert!(r1.is_err() && t1.is_err(), "both sides see the drop: {r1:?} {t1:?}");
    let held = sink.committed.len();
    assert!(held > 0 && held < 8, "some records survived: {held}");
    assert_eq!(store.0.lock().unwrap().as_ref().unwrap().received.len(), held, "progress persisted");

    // connection 2: new authenticated connection; sender must only be asked for the rest
    let (cs, cr) = pair();
    let mut st = store.clone();
    let tx = tokio::spawn(async move { let r = run_sender(cs, &lanproof(), &mut src, &opts()).await; r });
    let rx = run_receiver(cr, &lanproof(), &mut sink, &mut st, &opts()).await.unwrap();
    let tx_r = tx.await.unwrap().unwrap();
    assert!(rx.complete);
    assert_eq!(rx.records_received as usize, 8 - held);
    assert_eq!(tx_r.records_sent as usize, 8 - held);
    assert_eq!(sink.committed.len(), 8);
}

#[tokio::test]
async fn resume_with_a_changed_manifest_is_refused() {
    let mut src1 = SyntheticSource::new(3, 1000, 1);
    let mut sink = MemSink::new(false);
    let store = SharedStore::default();
    // first run completes, leaving progress behind
    let (cs, cr) = pair();
    let mut st = store.clone();
    let t = tokio::spawn(async move { run_sender(cs, &lanproof(), &mut src1, &opts()).await });
    run_receiver(cr, &lanproof(), &mut sink, &mut st, &opts()).await.unwrap();
    t.await.unwrap().unwrap();
    // a different history (other seed => other hashes) under the same persisted state
    let mut src2 = SyntheticSource::new(3, 1000, 2);
    let (cs, cr) = pair();
    let mut st = store.clone();
    let t = tokio::spawn(async move { run_sender(cs, &lanproof(), &mut src2, &opts()).await });
    let r = run_receiver(cr, &lanproof(), &mut sink, &mut st, &opts()).await;
    assert!(matches!(r, Err(NearError::ManifestChanged)), "{r:?}");
    let s = t.await.unwrap();
    assert!(matches!(s, Err(NearError::PeerAbort(ref why)) if why == "manifest_changed"), "sender is told why: {s:?}");
    assert_eq!(sink.committed.len(), 3, "nothing of the old transfer was overwritten");
    // changing only the sender device id or an option also counts as a different manifest
    let mut src3 = SyntheticSource::new(3, 1000, 1);
    src3.manifest_mut().sender_device_id = "other".into();
    let (cs, cr) = pair();
    let mut st = store.clone();
    let t = tokio::spawn(async move { run_sender(cs, &lanproof(), &mut src3, &opts()).await });
    assert!(matches!(run_receiver(cr, &lanproof(), &mut sink, &mut st, &opts()).await, Err(NearError::ManifestChanged)));
    let _ = t.await;
}

/// A malicious or buggy sender, driven frame by frame.
async fn hostile(script: impl FnOnce(Conn) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + 'static, src: &SyntheticSource) -> (crate::error::Result<RecvSummary>, MemSink) {
    let _ = src;
    let (cs, cr) = pair();
    let t = tokio::spawn(script(cs));
    let mut sink = MemSink::new(false);
    let mut store = SharedStore::default();
    let r = run_receiver(cr, &lanproof(), &mut sink, &mut store, &opts()).await;
    t.abort();
    (r, sink)
}

#[tokio::test]
async fn hash_mismatch_on_a_record_is_refused_and_not_committed() {
    let src = SyntheticSource::new(2, 100, 5);
    let m = src.manifest().clone();
    let (r, sink) = hostile(move |c| Box::pin(async move {
        let mut c = c;
        c.send(T_MANIFEST, m.to_bytes().unwrap()).await.unwrap();
        let _want = c.recv().await.unwrap();
        // record 0 with wrong content but the sender claims the right hash in record_end
        let mut p = 0u32.to_be_bytes().to_vec();
        p.extend_from_slice(&0u32.to_be_bytes());
        p.extend_from_slice(&[0xAA; 100]);
        c.send(T_RECORD, p).await.unwrap();
        let mut end = 0u32.to_be_bytes().to_vec();
        let right: Vec<u8> = (0..32).map(|i| u8::from_str_radix(&m.records[0].sha256[2 * i..2 * i + 2], 16).unwrap()).collect();
        end.extend_from_slice(&right);
        c.send(T_RECORD_END, end).await.unwrap();
        let _ = c.recv().await;
    }), &src).await;
    assert!(matches!(r, Err(NearError::HashMismatch(0))), "{r:?}");
    assert!(sink.committed.is_empty());
    assert_eq!(sink.discarded, vec![0]);
}

#[tokio::test]
async fn sender_lying_in_record_end_is_refused_even_if_data_matches_manifest() {
    let mut src = SyntheticSource::new(1, 64, 5);
    let m = src.manifest().clone();
    let mut data = vec![];
    use crate::transfer::RecordSource;
    src.read_chunk(0, 0, CHUNK, &mut data).unwrap();
    let (r, sink) = hostile(move |c| Box::pin(async move {
        let mut c = c;
        c.send(T_MANIFEST, m.to_bytes().unwrap()).await.unwrap();
        let _ = c.recv().await.unwrap();
        let mut p = 0u32.to_be_bytes().to_vec();
        p.extend_from_slice(&0u32.to_be_bytes());
        p.extend_from_slice(&data);
        c.send(T_RECORD, p).await.unwrap();
        let mut end = 0u32.to_be_bytes().to_vec();
        end.extend_from_slice(&[0u8; 32]);
        c.send(T_RECORD_END, end).await.unwrap();
        let _ = c.recv().await;
    }), &src).await;
    assert!(matches!(r, Err(NearError::HashMismatch(0))), "{r:?}");
    assert!(sink.committed.is_empty());
}

#[tokio::test]
async fn protocol_violations_are_refused() {
    let src = SyntheticSource::new(2, 100, 5);
    let m = src.manifest().clone();
    type Script = Box<dyn FnOnce(Conn) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send>;
    let cases: Vec<(&str, Script)> = vec![
        ("record before manifest", Box::new(|c| Box::pin(async move { c.send(T_RECORD, vec![0; 20]).await.unwrap(); tokio::time::sleep(Duration::from_secs(1)).await; }))),
        ("garbage manifest", Box::new(|c| Box::pin(async move { c.send(T_MANIFEST, b"{nope".to_vec()).await.unwrap(); tokio::time::sleep(Duration::from_secs(1)).await; }))),
        ("record out of order", { let m = m.clone(); Box::new(move |c| Box::pin(async move {
            c.send(T_MANIFEST, m.to_bytes().unwrap()).await.unwrap();
            let mut p = 1u32.to_be_bytes().to_vec(); p.extend_from_slice(&0u32.to_be_bytes()); p.extend_from_slice(&[0; 100]);
            let mut c = c; let _ = c.recv().await; c.send(T_RECORD, p).await.unwrap(); tokio::time::sleep(Duration::from_secs(1)).await; })) }),
        ("chunk overrun", { let m = m.clone(); Box::new(move |c| Box::pin(async move {
            c.send(T_MANIFEST, m.to_bytes().unwrap()).await.unwrap();
            let mut p = 0u32.to_be_bytes().to_vec(); p.extend_from_slice(&0u32.to_be_bytes()); p.extend_from_slice(&[0; 101]);
            let mut c = c; let _ = c.recv().await; c.send(T_RECORD, p).await.unwrap(); tokio::time::sleep(Duration::from_secs(1)).await; })) }),
        ("short record then end", { let m = m.clone(); Box::new(move |c| Box::pin(async move {
            c.send(T_MANIFEST, m.to_bytes().unwrap()).await.unwrap();
            let mut c = c; let _ = c.recv().await;
            let mut end = 0u32.to_be_bytes().to_vec(); end.extend_from_slice(&[0; 32]);
            c.send(T_RECORD_END, end).await.unwrap(); tokio::time::sleep(Duration::from_secs(1)).await; })) }),
        ("done too early", { let m = m.clone(); Box::new(move |c| Box::pin(async move {
            let mb = m.to_bytes().unwrap(); let d = Manifest::digest(&mb);
            c.send(T_MANIFEST, mb).await.unwrap();
            let mut c = c; let _ = c.recv().await; c.send(T_DONE, d.to_vec()).await.unwrap(); tokio::time::sleep(Duration::from_secs(1)).await; })) }),
        ("manifest with a lying total", { let m = m.clone(); Box::new(move |c| Box::pin(async move {
            let mut bad = m.clone(); bad.total_bytes += 1;
            c.send(T_MANIFEST, serde_json::to_vec(&bad).unwrap()).await.unwrap(); tokio::time::sleep(Duration::from_secs(1)).await; })) }),
        ("manifest with duplicate ids", { let m = m.clone(); Box::new(move |c| Box::pin(async move {
            let mut bad = m.clone(); bad.records[1].id = bad.records[0].id.clone();
            c.send(T_MANIFEST, serde_json::to_vec(&bad).unwrap()).await.unwrap(); tokio::time::sleep(Duration::from_secs(1)).await; })) }),
        ("manifest with an unknown field", { let m = m.clone(); Box::new(move |c| Box::pin(async move {
            let mut v = serde_json::to_value(&m).unwrap(); v["extra"] = 1.into();
            c.send(T_MANIFEST, serde_json::to_vec(&v).unwrap()).await.unwrap(); tokio::time::sleep(Duration::from_secs(1)).await; })) }),
    ];
    for (name, script) in cases {
        let (r, sink) = hostile(script, &src).await;
        assert!(r.is_err(), "{name}: must be refused, got {r:?}");
        assert!(sink.committed.is_empty(), "{name}");
    }
}

#[tokio::test]
async fn sender_refuses_a_hostile_want_and_a_corrupt_source() {
    // want naming an unknown record
    let mut src = SyntheticSource::new(2, 100, 5);
    let (cs, mut cr) = pair();
    let t = tokio::spawn(async move { run_sender(cs, &lanproof(), &mut src, &opts()).await });
    let _m = cr.recv().await.unwrap();
    cr.send(T_WANT, br#"{"ids":["nope"]}"#.to_vec()).await.unwrap();
    assert!(matches!(t.await.unwrap(), Err(NearError::Protocol(_))));
    let f = cr.recv().await.unwrap();
    assert_eq!(f.ty, T_ABORT);
    // a source whose bytes do not match its own manifest
    let mut src = SyntheticSource::new(1, 100, 5);
    src.manifest_mut().records[0].sha256 = "00".repeat(32);
    let (cs, mut cr) = pair();
    let t = tokio::spawn(async move { run_sender(cs, &lanproof(), &mut src, &opts()).await });
    let _m = cr.recv().await.unwrap();
    cr.send(T_WANT, br#"{"ids":["rec:000000"]}"#.to_vec()).await.unwrap();
    assert!(matches!(t.await.unwrap(), Err(NearError::HashMismatch(0))));
}

#[tokio::test]
async fn cancel_from_either_side() {
    // receiver cancels mid-way
    let mut src = SyntheticSource::new(4, 4 * CHUNK as u64, 3);
    let (cs, cr) = pair();
    let cancel = CancelToken::new();
    let c2 = cancel.clone();
    let seen = Arc::new(AtomicU64::new(0));
    let s2 = seen.clone();
    let ro = TransferOpts { progress: Some(Arc::new(move |p| { s2.store(p.bytes_done, Ordering::SeqCst); if p.bytes_done > 2 * CHUNK as u64 { c2.cancel() } })), cancel, ..opts() };
    let t = tokio::spawn(async move { run_sender(cs, &lanproof(), &mut src, &opts()).await });
    let mut sink = MemSink::new(false);
    let r = run_receiver(cr, &lanproof(), &mut sink, &mut SharedStore::default(), &ro).await;
    assert!(matches!(r, Err(NearError::Cancelled)), "{r:?}");
    assert!(matches!(t.await.unwrap(), Err(NearError::PeerAbort(ref w)) if w == "cancelled"));
    // sender cancels mid-way
    let mut src = SyntheticSource::new(4, 4 * CHUNK as u64, 3);
    let (cs, cr) = pair();
    let cancel = CancelToken::new();
    let c2 = cancel.clone();
    let so = TransferOpts { progress: Some(Arc::new(move |p| if p.bytes_done > CHUNK as u64 { c2.cancel() })), cancel, ..opts() };
    let t = tokio::spawn(async move { run_sender(cs, &lanproof(), &mut src, &so).await });
    let r = run_receiver(cr, &lanproof(), &mut MemSink::new(false), &mut SharedStore::default(), &opts()).await;
    assert!(matches!(r, Err(NearError::PeerAbort(ref w)) if w == "cancelled"), "{r:?}");
    assert!(matches!(t.await.unwrap(), Err(NearError::Cancelled)));
}

#[tokio::test]
async fn silent_peer_times_out() {
    let (cs, _cr_keep_alive_but_silent) = pair();
    let mut src = SyntheticSource::new(1, 10, 1);
    let o = TransferOpts { step_timeout: Duration::from_millis(300), ..Default::default() };
    // the other end never answers the manifest (it only pings, which does not count)
    let r = run_sender(cs, &lanproof(), &mut src, &o).await;
    assert!(matches!(r, Err(NearError::Timeout(_))), "{r:?}");
}

#[tokio::test]
async fn file_backed_store_and_sink_round_trip_and_resume() {
    let dir = tempfile::tempdir().unwrap();
    let sizes = vec![CHUNK as u64 + 10; 4];
    let mut src = SyntheticSource::with_sizes(&sizes, 11);
    let total: u64 = sizes.iter().sum();
    let mut sink = FileRecordSink::new(dir.path().join("records")).unwrap();
    let mut store = FileStore::new(dir.path().join("progress.json"));
    let (a, b) = tokio::io::duplex(256 * 1024);
    let cs = Conn::new(FaultyStream::new(a, total / 2), ConnConfig::default());
    let cr = Conn::new(b, ConnConfig::default());
    let t = tokio::spawn(async move { let r = run_sender(cs, &lanproof(), &mut src, &opts()).await; (r, src) });
    assert!(run_receiver(cr, &lanproof(), &mut sink, &mut store, &opts()).await.is_err());
    let (_, mut src) = t.await.unwrap();
    // "process restart": fresh store and sink objects over the same files
    let mut sink = FileRecordSink::new(dir.path().join("records")).unwrap();
    let mut store = FileStore::new(dir.path().join("progress.json"));
    let held = store.load().unwrap().unwrap().received.len();
    assert!(held >= 1 && held < 4, "{held}");
    let (cs, cr) = pair();
    let t = tokio::spawn(async move { run_sender(cs, &lanproof(), &mut src, &opts()).await });
    let rx = run_receiver(cr, &lanproof(), &mut sink, &mut store, &opts()).await.unwrap();
    assert!(rx.complete);
    assert_eq!(rx.records_received as usize, 4 - held);
    t.await.unwrap().unwrap();
    for i in 0..4u32 {
        assert_eq!(std::fs::metadata(sink.record_path(i)).unwrap().len(), CHUNK as u64 + 10);
    }
    // a record deleted behind our back is not trusted on the next resume
    std::fs::remove_file(sink.record_path(1)).unwrap();
    let mut src = SyntheticSource::with_sizes(&sizes, 11);
    let (cs, cr) = pair();
    let t = tokio::spawn(async move { run_sender(cs, &lanproof(), &mut src, &opts()).await });
    let rx = run_receiver(cr, &lanproof(), &mut sink, &mut store, &opts()).await.unwrap();
    assert_eq!(rx.records_received, 1);
    t.await.unwrap().unwrap();
    // a corrupt progress file means start over, not trust
    std::fs::write(dir.path().join("progress.json"), b"{broken").unwrap();
    assert!(FileStore::new(dir.path().join("progress.json")).load().unwrap().is_none());
    store.clear().unwrap();
    assert!(store.load().unwrap().is_none());
}

#[tokio::test]
async fn manifest_digest_is_sha256_of_the_sent_bytes() {
    let src = SyntheticSource::new(1, 3, 9);
    let b = src.manifest().to_bytes().unwrap();
    assert_eq!(Manifest::digest(&b), <[u8; 32]>::from(Sha256::digest(&b)));
    assert_eq!(Manifest::parse(&b).unwrap(), *src.manifest());
}

#[tokio::test]
async fn memory_stays_small_for_a_large_transfer() {
    // 192 MiB through the state machines; the receiver keeps nothing.
    let mut src = SyntheticSource::new(6, 32 * CHUNK as u64, 99);
    let (cs, cr) = pair();
    let before = peak_rss_kb();
    let t = tokio::spawn(async move { run_sender(cs, &lanproof(), &mut src, &opts()).await });
    let rx = run_receiver(cr, &lanproof(), &mut MemSink::new(false), &mut SharedStore::default(), &opts()).await.unwrap();
    t.await.unwrap().unwrap();
    assert!(rx.complete && rx.bytes_received == 192 * (1 << 20));
    let grew = peak_rss_kb().saturating_sub(before);
    assert!(grew < 64 * 1024, "peak RSS grew by {grew} KiB for 192 MiB");
}

#[tokio::test]
async fn a_bluetooth_proof_cannot_open_a_transfer() {
    let ble = crate::proof::ProximityProof::for_tests(crate::approval::Proximity::Ble, "L");
    let (cs, cr) = pair();
    let mut src = SyntheticSource::new(1, 10, 1);
    assert!(matches!(run_sender(cs, &ble, &mut src, &opts()).await, Err(NearError::NoProof(_))));
    assert!(matches!(run_receiver(cr, &ble, &mut MemSink::new(false), &mut SharedStore::default(), &opts()).await, Err(NearError::NoProof(_))));
}

// ---- pause (contract 11.9) ----------------------------------------------------------------------

async fn pause_run(pauser_is_sender: bool) {
    let sizes = vec![2 * CHUNK as u64 + 100; 6];
    let mut src = SyntheticSource::with_sizes(&sizes, 11);
    let mut sink = MemSink::new(false);
    let store = SharedStore::default();
    let token = CancelToken::new();
    let t2 = token.clone();
    let seen = Arc::new(AtomicU64::new(0));
    let s2 = seen.clone();
    // pause once the first record is done on the pausing side
    let progress: ProgressFn = Arc::new(move |p| { if p.records_done >= 1 && s2.fetch_add(1, Ordering::SeqCst) == 0 { t2.pause(); } });
    let (cs, cr) = pair();
    let (so, ro) = if pauser_is_sender { (TransferOpts { progress: Some(progress.clone()), cancel: token.clone(), ..opts() }, opts()) } else { (opts(), TransferOpts { progress: Some(progress), cancel: token.clone(), ..opts() }) };
    let mut st = store.clone();
    let tx = tokio::spawn(async move { let r = run_sender(cs, &lanproof(), &mut src, &so).await; (r, src) });
    let r1 = run_receiver(cr, &lanproof(), &mut sink, &mut st, &ro).await;
    let (t1, mut src) = tx.await.unwrap();
    if pauser_is_sender {
        assert!(matches!(t1, Err(NearError::Paused)), "{t1:?}");
        assert!(matches!(r1, Err(NearError::PeerPaused)), "the receiver is told it was a pause, not a failure: {r1:?}");
    } else {
        assert!(matches!(r1, Err(NearError::Paused)), "{r1:?}");
        assert!(matches!(t1, Err(NearError::PeerPaused)), "{t1:?}");
    }
    let held = sink.committed.len();
    assert!(held >= 1 && held < 6, "paused part-way: {held}");
    // resume: a new connection, the normal want path, a fresh token
    let (cs, cr) = pair();
    let mut st = store.clone();
    let tx = tokio::spawn(async move { run_sender(cs, &lanproof(), &mut src, &opts()).await });
    let rx = run_receiver(cr, &lanproof(), &mut sink, &mut st, &opts()).await.unwrap();
    let tx_r = tx.await.unwrap().unwrap();
    assert!(rx.complete);
    assert_eq!(rx.records_received as usize, 6 - held);
    assert_eq!(tx_r.records_sent as usize, 6 - held, "only what is missing is resent");
    assert_eq!(sink.committed.len(), 6);
}

#[tokio::test]
async fn the_sender_can_pause_and_the_receiver_is_told() { pause_run(true).await }

#[tokio::test]
async fn the_receiver_can_pause_and_the_sender_is_told() { pause_run(false).await }

#[tokio::test]
async fn a_cancel_that_happened_first_is_not_turned_into_a_pause() {
    let t = CancelToken::new();
    t.cancel();
    t.pause();
    assert!(t.is_cancelled() && !t.is_paused());
}

#[tokio::test]
async fn an_abort_paused_frame_from_a_raw_peer_is_a_peer_pause() {
    let src = SyntheticSource::new(2, 1000, 5);
    let (r, _sink) = hostile(|c| Box::pin(async move { let _ = c.send(T_ABORT, br#"{"reason":"paused"}"#.to_vec()).await; tokio::time::sleep(Duration::from_secs(2)).await; }), &src).await;
    assert!(matches!(r, Err(NearError::PeerPaused)), "{r:?}");
}

// ---- L5: what the receiver accepts ---------------------------------------------------------------------------------------------

/// The announced total is checked against the receiver's cap BEFORE any record is accepted: nothing is written, the sender is told.
#[tokio::test]
async fn receiver_refuses_a_transfer_larger_than_its_cap() {
    let mut src = SyntheticSource::new(3, 100_000, 8);
    let total = src.manifest().total_bytes;
    let (cs, cr) = pair();
    let t = tokio::spawn(async move { run_sender(cs, &lanproof(), &mut src, &opts()).await });
    let mut sink = MemSink::new(false);
    let mut store = SharedStore::default();
    let o = TransferOpts { max_total_bytes: total - 1, ..opts() };
    let r = run_receiver(cr, &lanproof(), &mut sink, &mut store, &o).await;
    assert!(matches!(r, Err(NearError::Storage(ref m)) if m.contains("larger than")), "{r:?}");
    assert!(sink.committed.is_empty() && sink.records.is_empty(), "nothing was accepted");
    assert!(store.0.lock().unwrap().is_none(), "no progress state was written for a refused transfer");
    assert!(t.await.unwrap().is_err(), "the sender is told (abort)");
    // exactly at the cap is fine
    let mut src = SyntheticSource::new(3, 100_000, 8);
    let (cs, cr) = pair();
    let t = tokio::spawn(async move { run_sender(cs, &lanproof(), &mut src, &opts()).await });
    let o = TransferOpts { max_total_bytes: total, ..opts() };
    assert!(run_receiver(cr, &lanproof(), &mut MemSink::new(false), &mut SharedStore::default(), &o).await.unwrap().complete);
    t.await.unwrap().unwrap();
    assert_eq!(TransferOpts::default().max_total_bytes, DEFAULT_MAX_TRANSFER_BYTES);
}

/// Free space (plus a margin) is checked before accepting; what is already held counts as already paid for.
#[tokio::test]
async fn receiver_refuses_a_transfer_that_does_not_fit_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let total = 3 * 100_000u64;
    let run = |free: Option<u64>, dir: std::path::PathBuf| async move {
        let mut src = SyntheticSource::new(3, 100_000, 8);
        let (cs, cr) = pair();
        let t = tokio::spawn(async move { run_sender(cs, &lanproof(), &mut src, &opts()).await });
        let mut sink = FileRecordSink::new(dir.join("rec")).unwrap().with_free_space_probe(Arc::new(move || free));
        let r = run_receiver(cr, &lanproof(), &mut sink, &mut FileStore::new(dir.join("p.json")), &opts()).await;
        let _ = t.await;
        r
    };
    // one byte short of "total + margin"
    let r = run(Some(total + FREE_SPACE_MARGIN - 1), dir.path().to_path_buf()).await;
    assert!(matches!(r, Err(NearError::Storage(ref m)) if m.contains("free space")), "{r:?}");
    assert!(std::fs::read_dir(dir.path().join("rec")).unwrap().next().is_none(), "nothing was written");
    // exactly enough, and "cannot tell" (None), both go ahead
    assert!(run(Some(total + FREE_SPACE_MARGIN), dir.path().join("a")).await.unwrap().complete);
    assert!(run(None, dir.path().join("b")).await.unwrap().complete);
    // the real statvfs query answers something sane on this platform
    #[cfg(unix)]
    assert!(FileRecordSink::new(dir.path().join("c")).unwrap().free_bytes().is_some_and(|f| f > 0));
}

/// A resumed record is trusted only if its BYTES still hash to the manifest value: a file that kept its length but changed content is refetched.
#[tokio::test]
async fn resume_rehashes_what_it_holds_not_just_the_length() {
    let dir = tempfile::tempdir().unwrap();
    let sizes = vec![CHUNK as u64 + 10; 4];
    let mut src = SyntheticSource::with_sizes(&sizes, 11);
    let manifest = src.manifest().clone();
    let total: u64 = sizes.iter().sum();
    let mut sink = FileRecordSink::new(dir.path().join("records")).unwrap();
    let mut store = FileStore::new(dir.path().join("progress.json"));
    // a transfer that completes; then the progress file is kept and one record is corrupted in place (same length)
    let (cs, cr) = pair();
    let t = tokio::spawn(async move { let r = run_sender(cs, &lanproof(), &mut src, &opts()).await; (r, src) });
    assert!(run_receiver(cr, &lanproof(), &mut sink, &mut store, &opts()).await.unwrap().complete);
    let (_, mut src) = t.await.unwrap();
    for (i, m) in manifest.records.iter().enumerate() { assert!(sink.has_record(i as u32, m), "record {i} intact"); }
    let victim = sink.record_path(2);
    let mut bytes = std::fs::read(&victim).unwrap();
    assert_eq!(bytes.len() as u64, manifest.records[2].bytes);
    bytes[5] ^= 0xff;
    std::fs::write(&victim, &bytes).unwrap();
    assert!(!sink.has_record(2, &manifest.records[2]), "same length, other content: not held");
    assert!(sink.has_record(1, &manifest.records[1]));
    // a truncated and an over-long file are not held either
    std::fs::write(sink.record_path(3), vec![0u8; 5]).unwrap();
    assert!(!sink.has_record(3, &manifest.records[3]));
    let mut long = vec![0u8; manifest.records[1].bytes as usize + 1];
    std::fs::write(sink.record_path(1), &mut long).unwrap();
    assert!(!sink.has_record(1, &manifest.records[1]));
    assert!(!sink.has_record(9, &manifest.records[0]), "a missing file");
    // resuming over the damaged directory refetches exactly the damaged records (1, 2, 3) and keeps record 0
    let (cs, cr) = pair();
    let t = tokio::spawn(async move { run_sender(cs, &lanproof(), &mut src, &opts()).await });
    let rx = run_receiver(cr, &lanproof(), &mut sink, &mut store, &opts()).await.unwrap();
    t.await.unwrap().unwrap();
    assert!(rx.complete);
    assert_eq!(rx.records_received, 3, "records 1, 2 and 3 were refetched");
    assert_eq!(rx.bytes_received, total - sizes[0]);
    for (i, m) in manifest.records.iter().enumerate() { assert!(sink.has_record(i as u32, m), "record {i} intact after resume"); }
}
