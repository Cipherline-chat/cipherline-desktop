//! Proximity sign-in and local-network transfer, as one pure protocol library.
//!
//! Implements `docs/plans/proximity-signin-protocol.md` (the "contract") for BOTH roles of every
//! exchange, so any pairing works: phone/phone, phone/desktop, desktop/desktop.
//!
//! * [`code`]: the `near/1` and `near-invite/1` payloads, the typed `XXXX-XXXX` code, secret rotation (section 1).
//! * [`keys`]: the section 2 key schedule.
//! * [`relay`]: hello / hello_ack, sealed relay messages, the typed message enum, the transport trait (section 3).
//! * [`ble`]: Bluetooth proof MATH and the who-advertises / when-to-fall-through logic (section 4.1). No radio code.
//! * [`onlink`]: the on-link address rule, a pure function (section 4.2).
//! * [`lan`]: one-time certificate, TLS 1.3 listener and dialer, fingerprint pin, exporter + role MAC (section 4.2).
//! * [`frame`], [`conn`], [`transfer`]: the section 6 transfer channel.
//! * [`approval`]: the v2 approval string (section 5).
//!
//! Nothing here touches cl-sync, cl-store, UniFFI or any mobile-only crate, and there is no `unsafe`.
#![forbid(unsafe_code)]

#[cfg(all(feature = "dangerous-loopback", any(target_os = "android", target_os = "ios")))]
compile_error!("the `dangerous-loopback` feature is test/demo only and must never be enabled for android or ios builds");

pub mod approval;
pub mod ble;
pub mod code;
pub mod conn;
pub mod error;
pub mod frame;
pub mod keys;
pub mod lan;
pub mod onlink;
pub mod proof;
pub mod relay;
pub mod transfer;

mod b64;

#[cfg(any(test, feature = "dangerous-loopback"))]
pub mod testutil;

#[cfg(test)]
mod transfer_tests;
#[cfg(test)]
mod vectors;

pub use error::NearError;

/// Added by cipherline-next tools/sync-core.sh: lets the host refuse a release build with the test-only feature.
pub const LOOPBACK_ENABLED: bool = cfg!(feature = "dangerous-loopback");
