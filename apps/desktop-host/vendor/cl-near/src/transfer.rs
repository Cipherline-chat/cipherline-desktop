//! Section 6: the transfer protocol, as sender and receiver state machines over a [`Conn`].
//!
//! ```text
//! sender                                receiver
//!   manifest  ----------------------->    compare with persisted state (refuse a changed manifest)
//!             <-----------------------  want { ids still needed }
//!   record* record_end ------------->     verify size + SHA-256, commit, persist progress
//!   done { sha256(manifest) } ------->    verify, every record present
//!             <-----------------------  done { same }          (completion acknowledgement)
//! ```
//! Memory is constant: at most a handful of 1 MiB frames are alive at once, whatever the history size.
//! Resume is a NEW authenticated connection running the same two functions again: the receiver's `want`
//! lists only the records it does not yet hold. Records are always resent whole.
use std::collections::BTreeSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Notify;
use tokio::time::timeout;

use crate::approval::Proximity;
use crate::conn::Conn;
use crate::proof::ProximityProof;
use crate::error::{NearError, Result};
use crate::frame::{Frame, CHUNK, MAX_FRAME_LEN, T_ABORT, T_DONE, T_MANIFEST, T_RECORD, T_RECORD_END, T_WANT};

pub const MAX_RECORDS: u32 = 1_000_000;
const MAX_ID_LEN: usize = 256;

// ---- manifest -------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordMeta {
    pub id: String,
    pub bytes: u64,
    /// Lower-case hex SHA-256 over exactly the bytes sent for this record.
    pub sha256: String,
    /// Optional records (attachments) may be missing from a partial apply without making the history incomplete (contract 11.10).
    #[serde(default, skip_serializing_if = "is_false")]
    pub optional: bool,
}

fn is_false(b: &bool) -> bool { !*b }

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransferOptions {
    #[serde(default)]
    pub include_attachments: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range_to: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub container_version: u32,
    pub total_bytes: u64,
    pub record_count: u32,
    pub records: Vec<RecordMeta>,
    #[serde(default)]
    pub options: TransferOptions,
    pub sender_device_id: String,
}

impl Manifest {
    pub fn new(container_version: u32, records: Vec<RecordMeta>, options: TransferOptions, sender_device_id: &str) -> Result<Self> {
        let total = records.iter().try_fold(0u64, |a, r| a.checked_add(r.bytes)).ok_or(NearError::Malformed("manifest total"))?;
        let m = Manifest { container_version, total_bytes: total, record_count: records.len() as u32, records, options, sender_device_id: sender_device_id.to_owned() };
        m.validate()?;
        Ok(m)
    }

    pub fn validate(&self) -> Result<()> {
        if self.record_count as usize != self.records.len() || self.record_count > MAX_RECORDS { return Err(NearError::Malformed("manifest record count")); }
        let mut total = 0u64;
        let mut seen = BTreeSet::new();
        for r in &self.records {
            if r.id.is_empty() || r.id.len() > MAX_ID_LEN || r.id.chars().any(|c| c.is_control()) { return Err(NearError::Malformed("manifest record id")); }
            if r.sha256.len() != 64 || !r.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Err(NearError::Malformed("manifest record hash")); }
            if !seen.insert(r.id.as_str()) { return Err(NearError::Malformed("manifest duplicate record id")); }
            total = total.checked_add(r.bytes).ok_or(NearError::Malformed("manifest total"))?;
        }
        if total != self.total_bytes { return Err(NearError::Malformed("manifest total bytes")); }
        if self.sender_device_id.is_empty() || self.sender_device_id.len() > 128 { return Err(NearError::Malformed("manifest sender")); }
        Ok(())
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        let b = serde_json::to_vec(self).map_err(|_| NearError::Malformed("manifest"))?;
        if b.len() + 1 > MAX_FRAME_LEN as usize { return Err(NearError::Protocol("manifest exceeds the frame cap".into())); }
        Ok(b)
    }

    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let m: Manifest = serde_json::from_slice(bytes).map_err(|_| NearError::Malformed("manifest"))?;
        m.validate()?;
        Ok(m)
    }

    pub fn digest(manifest_bytes: &[u8]) -> [u8; 32] { Sha256::digest(manifest_bytes).into() }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WantMsg {
    ids: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct AbortMsg {
    reason: String,
}

// ---- storage traits -------------------------------------------------------------------------

/// Where the sender's records come from (later: the backup container v4 reader). Sync, chunked, random access.
pub trait RecordSource: Send {
    fn manifest(&self) -> &Manifest;
    /// Append up to `max` bytes of record `index` starting at `offset` to `out` (which is empty on entry).
    /// Appending nothing means the record ends at `offset`.
    fn read_chunk(&mut self, index: u32, offset: u64, max: usize, out: &mut Vec<u8>) -> io::Result<()>;
}

/// Where the receiver's records go (later: the backup container v4 writer).
pub trait RecordSink: Send {
    /// Start (or restart, discarding a partial one) record `index`.
    fn begin_record(&mut self, index: u32, meta: &RecordMeta) -> io::Result<()>;
    fn write_chunk(&mut self, index: u32, data: &[u8]) -> io::Result<()>;
    /// Make the record durable. After this returns the record counts as held.
    fn commit_record(&mut self, index: u32) -> io::Result<()>;
    fn discard_record(&mut self, index: u32);
    /// Is a previously committed record still there AND intact (resume re-validation)? Default: trust the progress file. A real sink must
    /// re-hash the stored bytes against `meta.sha256`: a length match proves nothing about content (L5).
    fn has_record(&self, _index: u32, _meta: &RecordMeta) -> bool { true }
    /// Bytes still free where the records are stored, when the sink can tell. The receiver refuses a transfer that does not fit (L5).
    fn free_bytes(&self) -> Option<u64> { None }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PersistedState {
    pub manifest: Manifest,
    /// Indices of committed records.
    pub received: Vec<u32>,
}

/// Receiver progress persistence, so a restart or a new connection resumes instead of starting over.
pub trait ReceiverStore: Send {
    fn load(&mut self) -> io::Result<Option<PersistedState>>;
    fn save(&mut self, state: &PersistedState) -> io::Result<()>;
    fn clear(&mut self) -> io::Result<()>;
}

/// JSON progress file, replaced atomically (write temp, fsync, rename).
pub struct FileStore {
    path: PathBuf,
}

impl FileStore {
    pub fn new(path: impl Into<PathBuf>) -> Self { Self { path: path.into() } }
}

impl ReceiverStore for FileStore {
    fn load(&mut self) -> io::Result<Option<PersistedState>> {
        match std::fs::read(&self.path) {
            Ok(b) => match serde_json::from_slice::<PersistedState>(&b) {
                Ok(s) if s.manifest.validate().is_ok() => Ok(Some(s)),
                _ => Ok(None), // a corrupt progress file means "start over", never "trust it"
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }
    fn save(&mut self, state: &PersistedState) -> io::Result<()> {
        use std::io::Write;
        let tmp = self.path.with_extension("tmp");
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&serde_json::to_vec(state).map_err(io::Error::other)?)?;
        f.sync_all()?;
        std::fs::rename(&tmp, &self.path)
    }
    fn clear(&mut self) -> io::Result<()> {
        match std::fs::remove_file(&self.path) { Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e), _ => Ok(()) }
    }
}

/// One file per record under a directory: `<index>.part` while arriving, `<index>.rec` once committed.
pub struct FileRecordSink {
    dir: PathBuf,
    current: Option<(u32, std::fs::File)>,
    free_probe: Option<Arc<dyn Fn() -> Option<u64> + Send + Sync>>,
}

impl FileRecordSink {
    pub fn new(dir: impl AsRef<Path>) -> io::Result<Self> {
        std::fs::create_dir_all(dir.as_ref())?;
        Ok(Self { dir: dir.as_ref().to_owned(), current: None, free_probe: None })
    }
    /// Report free space through `probe` instead of the OS query (Windows hosts, which this crate has no portable query for, and tests).
    pub fn with_free_space_probe(mut self, probe: Arc<dyn Fn() -> Option<u64> + Send + Sync>) -> Self { self.free_probe = Some(probe); self }
    pub fn record_path(&self, index: u32) -> PathBuf { self.dir.join(format!("{index}.rec")) }
    fn part_path(&self, index: u32) -> PathBuf { self.dir.join(format!("{index}.part")) }
}

impl RecordSink for FileRecordSink {
    fn begin_record(&mut self, index: u32, _meta: &RecordMeta) -> io::Result<()> {
        self.current = Some((index, std::fs::File::create(self.part_path(index))?));
        Ok(())
    }
    fn write_chunk(&mut self, index: u32, data: &[u8]) -> io::Result<()> {
        use std::io::Write;
        match &mut self.current { Some((i, f)) if *i == index => f.write_all(data), _ => Err(io::Error::other("no open record")) }
    }
    fn commit_record(&mut self, index: u32) -> io::Result<()> {
        match self.current.take() {
            Some((i, f)) if i == index => { f.sync_all()?; drop(f); std::fs::rename(self.part_path(index), self.record_path(index)) }
            _ => Err(io::Error::other("no open record")),
        }
    }
    fn discard_record(&mut self, index: u32) {
        self.current = None;
        let _ = std::fs::remove_file(self.part_path(index));
    }
    /// Re-hash the stored record: length AND SHA-256 must match the manifest (L5). A truncated, padded or tampered file is not "held".
    fn has_record(&self, index: u32, meta: &RecordMeta) -> bool {
        use std::io::Read;
        let Ok(mut f) = std::fs::File::open(self.record_path(index)) else { return false };
        let (mut h, mut buf, mut n_total) = (Sha256::new(), vec![0u8; 64 * 1024], 0u64);
        loop {
            match f.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => { h.update(&buf[..n]); n_total += n as u64; if n_total > meta.bytes { return false } }
                Err(_) => return false,
            }
        }
        n_total == meta.bytes && hex(&h.finalize()) == meta.sha256
    }
    fn free_bytes(&self) -> Option<u64> {
        if let Some(p) = &self.free_probe { return p(); }
        #[cfg(unix)]
        { rustix::fs::statvfs(&self.dir).ok().map(|s| s.f_bavail.saturating_mul(s.f_frsize)) }
        #[cfg(not(unix))]
        { None }
    }
}

// ---- options, progress, cancel --------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Progress {
    /// Includes what the receiver already held before this connection (resume).
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub records_done: u32,
    pub records_total: u32,
}

pub type ProgressFn = Arc<dyn Fn(Progress) + Send + Sync>;

/// Cancel (or pause) from any task or thread; both state machines notice within one frame and send `abort`.
/// A token is single-use: after a pause, resume with a fresh token on a new connection.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<TokenInner>);

#[derive(Default)]
struct TokenInner {
    stopped: AtomicBool,
    paused: AtomicBool,
    notify: Notify,
}

impl CancelToken {
    pub fn new() -> Self { Self::default() }
    pub fn cancel(&self) {
        self.0.stopped.store(true, Ordering::SeqCst);
        self.0.notify.notify_waiters();
    }
    /// Stop like [`Self::cancel`], but say `abort { reason: "paused" }` (contract 11.9) and surface [`NearError::Paused`].
    /// A cancel that already happened wins.
    pub fn pause(&self) {
        if !self.0.stopped.load(Ordering::SeqCst) { self.0.paused.store(true, Ordering::SeqCst); }
        self.cancel();
    }
    pub fn is_cancelled(&self) -> bool { self.0.stopped.load(Ordering::SeqCst) }
    pub fn is_paused(&self) -> bool { self.0.paused.load(Ordering::SeqCst) }
    /// The error a stopped state machine returns: `Paused` or `Cancelled`.
    fn stop_error(&self) -> NearError { if self.is_paused() { NearError::Paused } else { NearError::Cancelled } }
    pub async fn cancelled(&self) {
        loop {
            let n = self.0.notify.notified();
            tokio::pin!(n);
            n.as_mut().enable();
            if self.is_cancelled() { return }
            n.await;
        }
    }
}

#[derive(Clone)]
pub struct TransferOpts {
    pub progress: Option<ProgressFn>,
    pub cancel: CancelToken,
    /// The longest either side waits for the peer's next protocol frame (pings do not count). Default 60 s.
    pub step_timeout: Duration,
    /// The receiver refuses a manifest announcing more than this many bytes before it accepts anything (L5). Default [`DEFAULT_MAX_TRANSFER_BYTES`].
    pub max_total_bytes: u64,
}

/// The default receive cap: 64 GiB. A hostile sender cannot make a phone allocate more than the person could plausibly own.
pub const DEFAULT_MAX_TRANSFER_BYTES: u64 = 64 << 30;
/// What must stay free on the receiver after the transfer (L5): 64 MiB.
pub const FREE_SPACE_MARGIN: u64 = 64 << 20;

impl Default for TransferOpts {
    fn default() -> Self { Self { progress: None, cancel: CancelToken::new(), step_timeout: Duration::from_secs(60), max_total_bytes: DEFAULT_MAX_TRANSFER_BYTES } }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SendSummary {
    pub records_sent: u32,
    pub bytes_sent: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecvSummary {
    pub records_received: u32,
    pub bytes_received: u64,
    /// Every record in the manifest is now held.
    pub complete: bool,
}

// ---- shared helpers -------------------------------------------------------------------------

fn abort_code(e: &NearError) -> &'static str {
    match e {
        NearError::Cancelled => "cancelled",
        NearError::Paused => "paused",
        NearError::HashMismatch(_) => "hash_mismatch",
        NearError::ManifestChanged => "manifest_changed",
        NearError::Timeout(_) => "timeout",
        NearError::Storage(_) => "storage",
        NearError::Protocol(_) | NearError::FrameTooLarge { .. } | NearError::Malformed(_) => "protocol",
        _ => "error",
    }
}

/// A dead connection often hides the peer's last word: if an `abort` is still queued, report that instead.
async fn upgrade_io_error(conn: &mut Conn, e: io::Error) -> NearError {
    let found = timeout(Duration::from_millis(300), async {
        while let Ok(f) = conn.recv().await {
            if let Err(a @ (NearError::PeerAbort(_) | NearError::PeerPaused)) = check_abort(f) { return Some(a) }
        }
        None
    }).await;
    match found { Ok(Some(a)) => a, _ => NearError::Io(e) }
}

async fn finish<T>(conn: Conn, r: Result<T>) -> Result<T> {
    let mut conn = conn;
    let r = match r { Err(NearError::Io(e)) => Err(upgrade_io_error(&mut conn, e).await), other => other };
    if let Err(e) = &r {
        // A dead connection or a peer that already aborted needs no abort frame from us.
        if !matches!(e, NearError::PeerAbort(_) | NearError::PeerPaused | NearError::Io(_)) {
            let body = serde_json::to_vec(&AbortMsg { reason: abort_code(e).into() }).unwrap_or_default();
            let _ = timeout(Duration::from_secs(2), conn.send(T_ABORT, body)).await;
        }
    }
    conn.close().await;
    r
}

async fn next_frame(conn: &mut Conn, opts: &TransferOpts) -> Result<Frame> {
    let f = tokio::select! {
        biased;
        _ = opts.cancel.cancelled() => return Err(opts.cancel.stop_error()),
        r = timeout(opts.step_timeout, conn.recv()) => r.map_err(|_| NearError::Timeout("peer silent"))??,
    };
    check_abort(f)
}

fn check_abort(f: Frame) -> Result<Frame> {
    if f.ty == T_ABORT {
        let reason = serde_json::from_slice::<AbortMsg>(&f.payload).map(|a| a.reason).unwrap_or_else(|_| "unspecified".into());
        if reason == "paused" { return Err(NearError::PeerPaused); }
        return Err(NearError::PeerAbort(reason.chars().filter(|c| c.is_ascii_graphic()).take(64).collect()));
    }
    Ok(f)
}

async fn send_frame(conn: &Conn, opts: &TransferOpts, ty: u8, payload: Vec<u8>) -> Result<()> {
    tokio::select! {
        biased;
        _ = opts.cancel.cancelled() => Err(opts.cancel.stop_error()),
        r = timeout(opts.step_timeout, conn.send(ty, payload)) => r.map_err(|_| NearError::Timeout("peer not reading"))?,
    }
}

fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }

fn report(opts: &TransferOpts, p: Progress) {
    if let Some(f) = &opts.progress { f(p) }
}

/// History moves over the local network only (decision D5), and only after A verified a proof.
fn require_lan(proof: &ProximityProof) -> Result<()> {
    if proof.method() == Proximity::Lan { Ok(()) } else { Err(NearError::NoProof("a transfer needs the local-network proof")) }
}

// ---- sender ---------------------------------------------------------------------------------

/// Run the sender over an authenticated connection. The connection is closed (flushed) before returning.
pub async fn run_sender<S: RecordSource>(conn: Conn, proof: &ProximityProof, src: &mut S, opts: &TransferOpts) -> Result<SendSummary> {
    let mut conn = conn;
    if let Err(e) = require_lan(proof) { conn.kill_now(); return Err(e); }
    let r = sender_inner(&mut conn, src, opts).await;
    finish(conn, r).await
}

async fn sender_inner<S: RecordSource>(conn: &mut Conn, src: &mut S, opts: &TransferOpts) -> Result<SendSummary> {
    let manifest = src.manifest().clone();
    manifest.validate()?;
    let mbytes = manifest.to_bytes()?;
    let mdigest = Manifest::digest(&mbytes);
    send_frame(conn, opts, T_MANIFEST, mbytes).await?;

    let f = next_frame(conn, opts).await?;
    if f.ty != T_WANT { return Err(NearError::Protocol(format!("expected want, got 0x{:02x}", f.ty))); }
    let want: WantMsg = serde_json::from_slice(&f.payload).map_err(|_| NearError::Malformed("want"))?;
    let mut wanted: Vec<u32> = Vec::with_capacity(want.ids.len());
    for id in &want.ids {
        let idx = manifest.records.iter().position(|r| &r.id == id).ok_or_else(|| NearError::Protocol("want names an unknown record".into()))?;
        wanted.push(idx as u32);
    }
    wanted.sort_unstable();
    if wanted.windows(2).any(|w| w[0] == w[1]) { return Err(NearError::Protocol("want repeats a record".into())); }

    let wanted_bytes: u64 = wanted.iter().map(|i| manifest.records[*i as usize].bytes).sum();
    let mut done_bytes = manifest.total_bytes - wanted_bytes;
    let mut done_records = manifest.record_count - wanted.len() as u32;
    let progress = |db: u64, dr: u32| Progress { bytes_done: db, bytes_total: manifest.total_bytes, records_done: dr, records_total: manifest.record_count };
    report(opts, progress(done_bytes, done_records));

    let mut buf: Vec<u8> = Vec::with_capacity(CHUNK);
    let mut summary = SendSummary { records_sent: 0, bytes_sent: 0 };
    for idx in wanted {
        let meta = &manifest.records[idx as usize];
        let mut hasher = Sha256::new();
        let (mut offset, mut chunk_idx) = (0u64, 0u32);
        loop {
            if opts.cancel.is_cancelled() { return Err(opts.cancel.stop_error()); }
            if let Some(r) = conn.try_recv() { check_abort(r?)?; return Err(NearError::Protocol("unexpected frame from receiver".into())); }
            buf.clear();
            src.read_chunk(idx, offset, CHUNK, &mut buf).map_err(|e| NearError::Storage(format!("source: {e}")))?;
            if buf.is_empty() { break }
            if offset + buf.len() as u64 > meta.bytes || buf.len() > CHUNK { return Err(NearError::Storage("source overran the manifest".into())); }
            hasher.update(&buf);
            let mut payload = Vec::with_capacity(8 + buf.len());
            payload.extend_from_slice(&idx.to_be_bytes());
            payload.extend_from_slice(&chunk_idx.to_be_bytes());
            payload.extend_from_slice(&buf);
            send_frame(conn, opts, T_RECORD, payload).await?;
            offset += buf.len() as u64;
            chunk_idx += 1;
            summary.bytes_sent += buf.len() as u64;
            report(opts, progress(done_bytes + offset, done_records));
        }
        if offset != meta.bytes { return Err(NearError::Storage("source ended short of the manifest".into())); }
        let digest: [u8; 32] = hasher.finalize().into();
        if hex(&digest) != meta.sha256 { return Err(NearError::HashMismatch(idx)); }
        let mut end = Vec::with_capacity(36);
        end.extend_from_slice(&idx.to_be_bytes());
        end.extend_from_slice(&digest);
        send_frame(conn, opts, T_RECORD_END, end).await?;
        tokio::task::yield_now().await;
        done_bytes += meta.bytes;
        done_records += 1;
        summary.records_sent += 1;
        report(opts, progress(done_bytes, done_records));
    }

    send_frame(conn, opts, T_DONE, mdigest.to_vec()).await?;
    let f = next_frame(conn, opts).await?;
    if f.ty != T_DONE || f.payload != mdigest { return Err(NearError::Protocol("bad completion acknowledgement".into())); }
    Ok(summary)
}

// ---- receiver -------------------------------------------------------------------------------

/// Run the receiver over an authenticated connection. The connection is closed (flushed) before returning.
pub async fn run_receiver<K: RecordSink, S: ReceiverStore>(conn: Conn, proof: &ProximityProof, sink: &mut K, store: &mut S, opts: &TransferOpts) -> Result<RecvSummary> {
    let mut conn = conn;
    if let Err(e) = require_lan(proof) { conn.kill_now(); return Err(e); }
    let r = receiver_inner(&mut conn, sink, store, opts).await;
    finish(conn, r).await
}

async fn receiver_inner<K: RecordSink, S: ReceiverStore>(conn: &mut Conn, sink: &mut K, store: &mut S, opts: &TransferOpts) -> Result<RecvSummary> {
    let f = next_frame(conn, opts).await?;
    if f.ty != T_MANIFEST { return Err(NearError::Protocol(format!("expected manifest, got 0x{:02x}", f.ty))); }
    let manifest = Manifest::parse(&f.payload)?;
    let mdigest = Manifest::digest(&f.payload);
    drop(f);

    let storage = |e: io::Error| NearError::Storage(e.to_string());
    let mut have: BTreeSet<u32> = match store.load().map_err(storage)? {
        Some(p) => {
            if p.manifest != manifest { return Err(NearError::ManifestChanged); }
            // Only trust a record the sink still has.
            p.received.into_iter().filter(|i| (*i as usize) < manifest.records.len() && sink.has_record(*i, &manifest.records[*i as usize])).collect()
        }
        None => BTreeSet::new(),
    };
    // L5: decide whether this transfer may start AT ALL before accepting a single record: the announced total against the cap, and what is still
    // to arrive against the free space (plus a margin). Refusing here ends the connection with an abort; nothing was written.
    if manifest.total_bytes > opts.max_total_bytes {
        return Err(NearError::Storage(format!("the transfer ({} bytes) is larger than this device accepts ({} bytes)", manifest.total_bytes, opts.max_total_bytes)));
    }
    let held: u64 = have.iter().map(|i| manifest.records[*i as usize].bytes).sum();
    if let Some(free) = sink.free_bytes() {
        if free < (manifest.total_bytes - held).saturating_add(FREE_SPACE_MARGIN) {
            return Err(NearError::Storage("not enough free space for the transfer".into()));
        }
    }
    let persist = |store: &mut S, have: &BTreeSet<u32>| store.save(&PersistedState { manifest: manifest.clone(), received: have.iter().copied().collect() }).map_err(storage);
    persist(store, &have)?;

    let wanted: Vec<u32> = (0..manifest.record_count).filter(|i| !have.contains(i)).collect();
    let want = WantMsg { ids: wanted.iter().map(|i| manifest.records[*i as usize].id.clone()).collect() };
    let wbytes = serde_json::to_vec(&want).map_err(|_| NearError::Malformed("want"))?;
    if wbytes.len() + 1 > MAX_FRAME_LEN as usize { return Err(NearError::Protocol("want exceeds the frame cap".into())); }
    send_frame(conn, opts, T_WANT, wbytes).await?;

    let held_bytes: u64 = have.iter().map(|i| manifest.records[*i as usize].bytes).sum();
    let mut done_bytes = held_bytes;
    let progress = |db: u64, have: &BTreeSet<u32>| Progress { bytes_done: db, bytes_total: manifest.total_bytes, records_done: have.len() as u32, records_total: manifest.record_count };
    report(opts, progress(done_bytes, &have));

    let mut summary = RecvSummary { records_received: 0, bytes_received: 0, complete: false };
    for idx in wanted {
        let meta = &manifest.records[idx as usize];
        let mut hasher = Sha256::new();
        let (mut got, mut next_chunk, mut begun) = (0u64, 0u32, false);
        let digest: [u8; 32] = loop {
            let f = next_frame(conn, opts).await?;
            match f.ty {
                T_RECORD => {
                    if f.payload.len() < 8 { return Err(NearError::Protocol("short record frame".into())); }
                    let (i, c) = (u32::from_be_bytes(f.payload[..4].try_into().unwrap()), u32::from_be_bytes(f.payload[4..8].try_into().unwrap()));
                    let data = &f.payload[8..];
                    if i != idx || c != next_chunk { return Err(NearError::Protocol("record out of order".into())); }
                    if got + data.len() as u64 > meta.bytes { sink.discard_record(idx); return Err(NearError::Protocol("record exceeds its manifest size".into())); }
                    if !begun { sink.begin_record(idx, meta).map_err(storage)?; begun = true; }
                    hasher.update(data);
                    sink.write_chunk(idx, data).map_err(storage)?;
                    got += data.len() as u64;
                    next_chunk += 1;
                    summary.bytes_received += data.len() as u64;
                    report(opts, progress(done_bytes + got, &have));
                }
                T_RECORD_END => {
                    if f.payload.len() != 36 || u32::from_be_bytes(f.payload[..4].try_into().unwrap()) != idx { return Err(NearError::Protocol("bad record_end".into())); }
                    if !begun { sink.begin_record(idx, meta).map_err(storage)?; begun = true; }
                    let _ = begun;
                    if got != meta.bytes { sink.discard_record(idx); return Err(NearError::Protocol("record shorter than its manifest size".into())); }
                    let calc: [u8; 32] = std::mem::take(&mut hasher).finalize().into();
                    // both the sender's claim and the manifest must match what actually arrived
                    if calc[..] != f.payload[4..] || hex(&calc) != meta.sha256 { sink.discard_record(idx); return Err(NearError::HashMismatch(idx)); }
                    break calc;
                }
                other => return Err(NearError::Protocol(format!("unexpected frame 0x{other:02x} inside a record"))),
            }
        };
        let _ = digest;
        sink.commit_record(idx).map_err(storage)?;
        have.insert(idx);
        persist(store, &have)?;
        // A cooperative point per record: with frames already buffered nothing else here yields, and an aborted session task would only
        // notice at the very end (it kept writing the spool after the session was cancelled).
        tokio::task::yield_now().await;
        done_bytes += meta.bytes;
        summary.records_received += 1;
        report(opts, progress(done_bytes, &have));
    }

    let f = next_frame(conn, opts).await?;
    if f.ty != T_DONE || f.payload != mdigest { return Err(NearError::Protocol("done does not match the manifest".into())); }
    if have.len() != manifest.record_count as usize { return Err(NearError::Protocol("done but records are missing".into())); }
    send_frame(conn, opts, T_DONE, mdigest.to_vec()).await?;
    summary.complete = true;
    Ok(summary)
}
