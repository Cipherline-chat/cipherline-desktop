//! A framed connection with its own keep-alive: one reader task and one writer task over any async
//! stream. Pings every 10 s when otherwise quiet, pongs answered automatically, 30 s without any
//! incoming byte is an idle timeout. Application code sees only non-ping frames, through channels of
//! capacity 2-4, so memory stays at a few frames regardless of what is transferred.
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::{timeout, Instant};

use crate::error::{NearError, Result};
use crate::frame::{read_frame, write_frame, Frame, MAX_FRAME_LEN, T_PING, T_PONG};

#[derive(Clone, Copy, Debug)]
pub struct ConnConfig {
    /// No incoming bytes for this long ends the connection. Default 30 s.
    pub idle: Duration,
    /// Send a ping when nothing was written for this long. Default 10 s.
    pub ping_every: Duration,
}

impl Default for ConnConfig {
    fn default() -> Self { Self { idle: Duration::from_secs(30), ping_every: Duration::from_secs(10) } }
}

pub struct Conn {
    rx: mpsc::Receiver<Result<Frame>>,
    tx: Option<mpsc::Sender<Frame>>,
    reader: JoinHandle<()>,
    writer: Option<JoinHandle<()>>,
}

impl Conn {
    /// Take over an AUTHENTICATED stream (the MAC exchange of 4.2 has already run).
    pub fn new<S>(stream: S, cfg: ConnConfig) -> Conn
    where
        S: AsyncRead + AsyncWrite + Send + 'static,
    {
        let (mut rd, mut wr) = tokio::io::split(stream);
        let (app_tx, app_rx) = mpsc::channel::<Result<Frame>>(4);
        let (wtx, mut wrx) = mpsc::channel::<Frame>(2);
        let pong_tx = wtx.clone();

        let reader = tokio::spawn(async move {
            loop {
                match read_frame(&mut rd, MAX_FRAME_LEN, cfg.idle).await {
                    Ok(f) if f.ty == T_PING => {
                        let _ = pong_tx.send(Frame { ty: T_PONG, payload: vec![] }).await;
                    }
                    Ok(f) if f.ty == T_PONG => {}
                    Ok(f) => {
                        if app_tx.send(Ok(f)).await.is_err() { return; }
                    }
                    Err(e) => {
                        let _ = app_tx.send(Err(e)).await;
                        return;
                    }
                }
            }
        });

        let writer = tokio::spawn(async move {
            let mut last_write = Instant::now();
            let mut tick = tokio::time::interval(cfg.ping_every.max(Duration::from_millis(10)));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    biased;
                    f = wrx.recv() => {
                        let Some(f) = f else { break };
                        match timeout(cfg.idle, write_frame(&mut wr, f.ty, &[&f.payload])).await {
                            Ok(Ok(())) => last_write = Instant::now(),
                            _ => return,
                        }
                    }
                    _ = tick.tick() => {
                        if last_write.elapsed() >= cfg.ping_every {
                            match timeout(cfg.idle, write_frame(&mut wr, T_PING, &[])).await {
                                Ok(Ok(())) => last_write = Instant::now(),
                                _ => return,
                            }
                        }
                    }
                }
            }
            let _ = timeout(Duration::from_secs(5), wr.shutdown()).await;
        });

        Conn { rx: app_rx, tx: Some(wtx), reader, writer: Some(writer) }
    }

    /// Queue a frame. Applies backpressure (the queue holds two frames). Errors once the writer is gone.
    pub async fn send(&self, ty: u8, payload: Vec<u8>) -> Result<()> {
        let tx = self.tx.as_ref().ok_or(NearError::Protocol("connection closed".into()))?;
        tx.send(Frame { ty, payload }).await.map_err(|_| NearError::Io(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "connection closed")))
    }

    /// The next application frame (never a ping or pong). An error is terminal.
    pub async fn recv(&mut self) -> Result<Frame> {
        match self.rx.recv().await {
            Some(r) => r,
            None => Err(NearError::Io(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "connection closed"))),
        }
    }

    pub fn try_recv(&mut self) -> Option<Result<Frame>> { self.rx.try_recv().ok() }

    /// Flush everything queued, send TLS close_notify (if the stream has one), stop both tasks.
    pub async fn close(mut self) {
        self.reader.abort();
        self.tx = None;
        if let Some(w) = self.writer.take() {
            let _ = timeout(Duration::from_secs(6), w).await;
        }
    }

    pub(crate) fn kill_now(&mut self) { self.reader.abort(); if let Some(w) = &self.writer { w.abort(); } }

    /// Drop the connection NOW without flushing or a clean shutdown (a simulated or real hard drop).
    pub fn kill(self) {}
}

impl Drop for Conn {
    fn drop(&mut self) {
        self.reader.abort();
        if let Some(w) = &self.writer { w.abort(); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::T_MANIFEST;

    #[tokio::test]
    async fn frames_flow_and_pings_are_invisible() {
        let (a, b) = tokio::io::duplex(1 << 16);
        let cfg = ConnConfig { idle: Duration::from_secs(5), ping_every: Duration::from_millis(30) };
        let ca = Conn::new(a, cfg);
        let mut cb = Conn::new(b, cfg);
        ca.send(T_MANIFEST, b"x".to_vec()).await.unwrap();
        assert_eq!(cb.recv().await.unwrap().payload, b"x");
        tokio::time::sleep(Duration::from_millis(200)).await; // several pings each way
        ca.send(T_MANIFEST, b"y".to_vec()).await.unwrap();
        let f = cb.recv().await.unwrap();
        assert_eq!((f.ty, f.payload.as_slice()), (T_MANIFEST, &b"y"[..]));
        ca.close().await;
        assert!(cb.recv().await.is_err());
    }

    #[tokio::test]
    async fn keepalive_holds_a_quiet_link_and_silence_times_out() {
        let (a, b) = tokio::io::duplex(1 << 16);
        let ca = Conn::new(a, ConnConfig { idle: Duration::from_millis(400), ping_every: Duration::from_millis(100) });
        let mut cb = Conn::new(b, ConnConfig { idle: Duration::from_millis(400), ping_every: Duration::from_millis(100) });
        // 1.2 s quiet but pinging: still alive
        assert!(tokio::time::timeout(Duration::from_millis(1200), cb.recv()).await.is_err());
        ca.send(T_MANIFEST, vec![1]).await.unwrap();
        assert!(cb.recv().await.is_ok());
        // a silent peer (never pings: ping_every huge) trips the idle timeout
        let (a, b) = tokio::io::duplex(1 << 16);
        let _silent = Conn::new(a, ConnConfig { idle: Duration::from_secs(60), ping_every: Duration::from_secs(60) });
        let mut cb = Conn::new(b, ConnConfig { idle: Duration::from_millis(300), ping_every: Duration::from_secs(60) });
        assert!(matches!(cb.recv().await, Err(NearError::Timeout("idle"))));
    }
}
