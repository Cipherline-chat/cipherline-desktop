//! Test and demo helpers: deterministic synthetic records, in-memory sinks and stores, and a stream that
//! fails after N bytes. Compiled only under `cfg(test)` or the `dangerous-loopback` feature, never in a
//! shipped build.
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::transfer::{Manifest, PersistedState, RecordMeta, RecordSink, RecordSource, ReceiverStore, TransferOptions};

/// xorshift64*: fast, deterministic, NOT cryptographic. Fills `out` for (seed, record, chunk).
pub fn fill(seed: u64, record: u32, chunk: u32, out: &mut [u8]) {
    let mut s = seed ^ u64::from(record).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ u64::from(chunk).wrapping_mul(0xD1B5_4A32_D192_ED03) ^ 0x2545_F491_4F6C_DD1D;
    if s == 0 { s = 1 }
    let mut it = out.chunks_exact_mut(8);
    for c in &mut it {
        s ^= s >> 12; s ^= s << 25; s ^= s >> 27;
        c.copy_from_slice(&s.wrapping_mul(0x2545_F491_4F6C_DD1D).to_le_bytes());
    }
    let rem = it.into_remainder();
    if !rem.is_empty() {
        s ^= s >> 12; s ^= s << 25; s ^= s >> 27;
        let b = s.wrapping_mul(0x2545_F491_4F6C_DD1D).to_le_bytes();
        rem.copy_from_slice(&b[..rem.len()]);
    }
}

/// `records` records of `bytes_each` bytes generated on the fly; nothing is stored.
pub struct SyntheticSource {
    manifest: Manifest,
    seed: u64,
    chunk: usize,
}

impl SyntheticSource {
    pub fn new(records: u32, bytes_each: u64, seed: u64) -> Self { Self::with_sizes(&vec![bytes_each; records as usize], seed) }

    pub fn with_sizes(sizes: &[u64], seed: u64) -> Self {
        let chunk = crate::frame::CHUNK;
        let mut metas = vec![];
        let mut buf = vec![0u8; chunk];
        for (i, size) in sizes.iter().enumerate() {
            let mut h = Sha256::new();
            let (mut off, mut c) = (0u64, 0u32);
            while off < *size {
                let n = (*size - off).min(chunk as u64) as usize;
                fill(seed, i as u32, c, &mut buf[..n]);
                h.update(&buf[..n]);
                off += n as u64;
                c += 1;
            }
            let digest: [u8; 32] = h.finalize().into();
            metas.push(RecordMeta { id: format!("rec:{i:06}"), bytes: *size, sha256: digest.iter().map(|b| format!("{b:02x}")).collect(), optional: false });
        }
        let manifest = Manifest::new(4, metas, TransferOptions::default(), "device-test").expect("valid manifest");
        Self { manifest, seed, chunk }
    }

    pub fn manifest_mut(&mut self) -> &mut Manifest { &mut self.manifest }
}

impl RecordSource for SyntheticSource {
    fn manifest(&self) -> &Manifest { &self.manifest }
    fn read_chunk(&mut self, index: u32, offset: u64, max: usize, out: &mut Vec<u8>) -> io::Result<()> {
        let size = self.manifest.records[index as usize].bytes;
        if offset >= size { return Ok(()) }
        let n = (size - offset).min(max as u64).min(self.chunk as u64) as usize;
        out.resize(n, 0);
        fill(self.seed, index, (offset / self.chunk as u64) as u32, out);
        Ok(())
    }
}

/// Receiver sink. `keep_data` false for the big runs: only sizes and a running count are kept.
#[derive(Default)]
pub struct MemSink {
    pub keep_data: bool,
    pub records: BTreeMap<u32, Vec<u8>>,
    pub committed: BTreeSet<u32>,
    pub committed_bytes: u64,
    cur: Option<(u32, Vec<u8>, u64)>,
    pub discarded: Vec<u32>,
}

impl MemSink {
    pub fn new(keep_data: bool) -> Self { Self { keep_data, ..Default::default() } }
}

impl RecordSink for MemSink {
    fn begin_record(&mut self, index: u32, _m: &RecordMeta) -> io::Result<()> { self.cur = Some((index, vec![], 0)); Ok(()) }
    fn write_chunk(&mut self, index: u32, data: &[u8]) -> io::Result<()> {
        match &mut self.cur {
            Some((i, buf, n)) if *i == index => { if self.keep_data { buf.extend_from_slice(data) } *n += data.len() as u64; Ok(()) }
            _ => Err(io::Error::other("no open record")),
        }
    }
    fn commit_record(&mut self, index: u32) -> io::Result<()> {
        match self.cur.take() {
            Some((i, buf, n)) if i == index => { self.committed.insert(i); self.committed_bytes += n; if self.keep_data { self.records.insert(i, buf); } Ok(()) }
            _ => Err(io::Error::other("no open record")),
        }
    }
    fn discard_record(&mut self, index: u32) { self.cur = None; self.discarded.push(index); }
    fn has_record(&self, index: u32, _m: &RecordMeta) -> bool { self.committed.contains(&index) }
}

/// Progress store that survives "reconnects" (clone it, hand the clone to the next run).
#[derive(Clone, Default)]
pub struct SharedStore(pub Arc<Mutex<Option<PersistedState>>>);

impl ReceiverStore for SharedStore {
    fn load(&mut self) -> io::Result<Option<PersistedState>> { Ok(self.0.lock().unwrap().clone()) }
    fn save(&mut self, s: &PersistedState) -> io::Result<()> { *self.0.lock().unwrap() = Some(s.clone()); Ok(()) }
    fn clear(&mut self) -> io::Result<()> { *self.0.lock().unwrap() = None; Ok(()) }
}

/// Wraps a stream and fails every read and write with `ConnectionReset` once `limit` bytes have passed
/// in total: a hard connection drop at a chosen point.
pub struct FaultyStream<S> {
    inner: S,
    remaining: u64,
}

impl<S> FaultyStream<S> {
    pub fn new(inner: S, limit: u64) -> Self { Self { inner, remaining: limit } }
}

fn reset() -> io::Error { io::Error::new(io::ErrorKind::ConnectionReset, "injected connection drop") }

impl<S: AsyncRead + Unpin> AsyncRead for FaultyStream<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        if self.remaining == 0 { return Poll::Ready(Err(reset())) }
        let before = buf.filled().len();
        let r = Pin::new(&mut self.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &r {
            let n = (buf.filled().len() - before) as u64;
            self.remaining = self.remaining.saturating_sub(n);
        }
        r
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for FaultyStream<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        if self.remaining == 0 { return Poll::Ready(Err(reset())) }
        let cap = buf.len().min(self.remaining as usize);
        let r = Pin::new(&mut self.inner).poll_write(cx, &buf[..cap]);
        if let Poll::Ready(Ok(n)) = &r { self.remaining -= *n as u64; }
        r
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> { Pin::new(&mut self.inner).poll_flush(cx) }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> { Pin::new(&mut self.inner).poll_shutdown(cx) }
}

/// Peak resident set of this process in KiB (Linux `VmHWM`); 0 elsewhere.
pub fn peak_rss_kb() -> u64 {
    std::fs::read_to_string("/proc/self/status").ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("VmHWM:")).and_then(|l| l.split_whitespace().nth(1)?.parse().ok()))
        .unwrap_or(0)
}
