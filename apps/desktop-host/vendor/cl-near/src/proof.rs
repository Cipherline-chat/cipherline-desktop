//! The "proof verified by A" state, as a type.
//!
//! A [`ProximityProof`] can only be produced by this crate, and only from a verified Bluetooth exchange
//! ([`crate::ble::Advertiser::prove_heard`], [`crate::ble::Scanner::prove_ack`]) or an authenticated
//! on-link TLS connection ([`crate::lan::LanConn::proof`]). `hello` / `hello_ack` alone never yield one,
//! so there is no way to build the v2 approval string ([`crate::approval`]) or to open a transfer
//! ([`crate::transfer::run_sender`] / [`run_receiver`](crate::transfer::run_receiver)) after the relay
//! handshake only.
use crate::approval::Proximity;

#[derive(Debug)]
pub struct ProximityProof {
    method: Proximity,
    link_id: String,
}

impl ProximityProof {
    pub(crate) fn new(method: Proximity, link_id: &str) -> Self { Self { method, link_id: link_id.to_owned() } }
    pub fn method(&self) -> Proximity { self.method }
    pub fn link_id(&self) -> &str { &self.link_id }

    /// Tests and the demo only (same fence as `LanPolicy::DangerousAllowLoopback`).
    #[cfg(any(test, feature = "dangerous-loopback"))]
    pub fn for_tests(method: Proximity, link_id: &str) -> Self { Self::new(method, link_id) }
}
