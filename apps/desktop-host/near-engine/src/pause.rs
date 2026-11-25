//! Pausing a transfer (contract 11.9) behind one small seam, so the engine does not care which shared crate it was
//! built against.
//!
//! [`FramePause`] uses cl-near's `CancelToken::pause()` / `NearError::Paused` / `NearError::PeerPaused` (the transfer
//! channel's `abort { reason: "paused" }` frame, in the vendored crate, native 30ea21d5).
//! [`NoPause`] is the switch-off: pause reports itself unsupported and the engine never offers it. If the vendored
//! crate is ever replaced by one without the pause frame, only this file changes (FramePause's body becomes
//! NoPause's, and the bridge members `nearTransferPause`/`nearTransferResume` then answer "not supported").
use cl_near::error::NearError;
use cl_near::transfer::CancelToken;

pub trait TransferStop: Send + Sync {
    /// Does the shared crate carry a pause frame?
    fn supported(&self) -> bool;
    /// Stop the running attempt in a way the peer reads as "paused" (not "cancelled").
    fn pause(&self, token: &CancelToken);
    /// This side paused.
    fn is_pause(&self, e: &NearError) -> bool;
    /// The peer paused.
    fn is_peer_pause(&self, e: &NearError) -> bool;
}

pub struct FramePause;
impl TransferStop for FramePause {
    fn supported(&self) -> bool {
        true
    }
    fn pause(&self, token: &CancelToken) {
        token.pause();
    }
    fn is_pause(&self, e: &NearError) -> bool {
        matches!(e, NearError::Paused)
    }
    fn is_peer_pause(&self, e: &NearError) -> bool {
        matches!(e, NearError::PeerPaused)
    }
}

pub struct NoPause;
impl TransferStop for NoPause {
    fn supported(&self) -> bool {
        false
    }
    fn pause(&self, token: &CancelToken) {
        token.cancel();
    }
    fn is_pause(&self, _: &NearError) -> bool {
        false
    }
    fn is_peer_pause(&self, _: &NearError) -> bool {
        false
    }
}
