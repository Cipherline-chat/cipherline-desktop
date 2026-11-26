//! Section 6 framing: `u32 length (big-endian)`, `u8 type`, payload.
//!
//! `length` counts the type byte plus the payload (the convention the spike proved); it may not exceed
//! [`MAX_FRAME_LEN`] (1 MiB + 64). The cap is checked BEFORE any buffer is allocated, so a hostile
//! header costs nothing. Before the auth frame verifies the cap is [`MAX_PREAUTH_LEN`].
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::time::timeout;

use crate::error::{NearError, Result};

pub const T_AUTH: u8 = 0x01;
pub const T_MANIFEST: u8 = 0x10;
pub const T_WANT: u8 = 0x11;
pub const T_RECORD: u8 = 0x12;
pub const T_RECORD_END: u8 = 0x13;
pub const T_DONE: u8 = 0x14;
pub const T_PING: u8 = 0x20;
pub const T_PONG: u8 = 0x21;
/// The payload of a PROGRESS ping: the receiver is still verifying and storing records the sender has already sent (see
/// `transfer`). A plain keep-alive ping is empty. Every connection answers any ping with a pong and never hands it to the
/// application, so an older peer simply ignores the payload: the beacon needs no new frame type and stays wire-compatible.
pub const PROGRESS_BEACON: &[u8] = b"progress";
pub const T_ABORT: u8 = 0x7F;

/// Largest data chunk inside a `record` frame.
pub const CHUNK: usize = 1 << 20;
/// Maximum `length` field: 1 MiB + 64.
pub const MAX_FRAME_LEN: u32 = (1 << 20) + 64;
/// Maximum `length` field before authentication: one type byte and a 32-byte MAC, with slack.
pub const MAX_PREAUTH_LEN: u32 = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub ty: u8,
    pub payload: Vec<u8>,
}

/// Write one frame (header and payload parts) and flush.
pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, ty: u8, parts: &[&[u8]]) -> Result<()> {
    let len = 1 + parts.iter().map(|p| p.len() as u64).sum::<u64>();
    if len > u64::from(MAX_FRAME_LEN) {
        return Err(NearError::FrameTooLarge { len, max: u64::from(MAX_FRAME_LEN) });
    }
    let mut h = [0u8; 5];
    h[..4].copy_from_slice(&(len as u32).to_be_bytes());
    h[4] = ty;
    w.write_all(&h).await?;
    for p in parts {
        w.write_all(p).await?;
    }
    w.flush().await?;
    Ok(())
}

/// Read one frame. `max_len` bounds the length field; `idle` bounds each wait for bytes.
pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R, max_len: u32, idle: Duration) -> Result<Frame> {
    let mut h = [0u8; 4];
    read_exact(r, &mut h, idle).await?;
    let len = u32::from_be_bytes(h);
    if len < 1 || len > max_len {
        return Err(NearError::FrameTooLarge { len: u64::from(len), max: u64::from(max_len) });
    }
    let mut ty = [0u8; 1];
    read_exact(r, &mut ty, idle).await?;
    let mut payload = vec![0u8; len as usize - 1];
    read_exact(r, &mut payload, idle).await?;
    Ok(Frame { ty: ty[0], payload })
}

async fn read_exact<R: AsyncRead + Unpin>(r: &mut R, buf: &mut [u8], idle: Duration) -> Result<()> {
    match timeout(idle, r.read_exact(buf)).await {
        Err(_) => Err(NearError::Timeout("idle")),
        Ok(Err(e)) => Err(NearError::Io(e)),
        Ok(Ok(_)) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn round_trip_and_limits() {
        let (mut a, mut b) = tokio::io::duplex(1 << 16);
        write_frame(&mut a, T_MANIFEST, &[b"he", b"llo"]).await.unwrap();
        let f = read_frame(&mut b, MAX_FRAME_LEN, Duration::from_secs(1)).await.unwrap();
        assert_eq!(f, Frame { ty: T_MANIFEST, payload: b"hello".to_vec() });
        write_frame(&mut a, T_PING, &[]).await.unwrap();
        assert_eq!(read_frame(&mut b, MAX_FRAME_LEN, Duration::from_secs(1)).await.unwrap().payload.len(), 0);
        // writer refuses an oversized frame
        let big = vec![0u8; MAX_FRAME_LEN as usize];
        assert!(matches!(write_frame(&mut a, T_RECORD, &[&big]).await, Err(NearError::FrameTooLarge { .. })));
        // exactly at the cap is fine
        let ok = vec![1u8; MAX_FRAME_LEN as usize - 1];
        let w = tokio::spawn(async move { write_frame(&mut a, T_RECORD, &[&ok]).await.map(|_| a) });
        let f = read_frame(&mut b, MAX_FRAME_LEN, Duration::from_secs(5)).await.unwrap();
        assert_eq!(f.payload.len(), MAX_FRAME_LEN as usize - 1);
        w.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn oversized_header_rejected_before_allocation() {
        for len in [MAX_FRAME_LEN + 1, 0x7fff_ffff, u32::MAX, 0] {
            let (mut a, mut b) = tokio::io::duplex(64);
            a.write_all(&len.to_be_bytes()).await.unwrap();
            // no body follows: if the reader tried to allocate/read it would hang, not error
            let e = read_frame(&mut b, MAX_FRAME_LEN, Duration::from_millis(200)).await.unwrap_err();
            assert!(matches!(e, NearError::FrameTooLarge { .. }), "len {len}: {e:?}");
        }
        // pre-auth cap
        let (mut a, mut b) = tokio::io::duplex(64);
        a.write_all(&(MAX_PREAUTH_LEN + 1).to_be_bytes()).await.unwrap();
        assert!(matches!(read_frame(&mut b, MAX_PREAUTH_LEN, Duration::from_millis(200)).await, Err(NearError::FrameTooLarge { .. })));
    }

    #[tokio::test]
    async fn truncated_and_idle() {
        let (mut a, mut b) = tokio::io::duplex(64);
        a.write_all(&[0, 0, 0, 10, T_RECORD, 1, 2]).await.unwrap();
        drop(a);
        assert!(matches!(read_frame(&mut b, MAX_FRAME_LEN, Duration::from_secs(1)).await, Err(NearError::Io(_))));
        let (_a, mut b) = tokio::io::duplex(64);
        assert!(matches!(read_frame(&mut b, MAX_FRAME_LEN, Duration::from_millis(50)).await, Err(NearError::Timeout(_))));
    }
}
