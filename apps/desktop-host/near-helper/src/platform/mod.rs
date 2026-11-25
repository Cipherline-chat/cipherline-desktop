//! Per-OS pieces: the Bluetooth scanner, the biometric, and (shared) the on-link interfaces.
//!
//! * Linux: `linux::BluezRadio` (BlueZ over D-Bus, receive-only). No biometric: the gate asks the parent for the
//!   account password (`RemoteGate::confirm`).
//! * macOS: `macos::CoreBluetoothRadio` + `macos::TouchId` (LocalAuthentication).
//! * Windows: NO radio (own-device transfer does not use Bluetooth) and no biometric: the gate is the account step-up
//!   (password / authenticator code) verified by Electron main. Windows Hello is a later item. What IS Windows-specific lives
//!   in the engine: the physical-interface allow-list (`near_engine::winnet`, Wi-Fi / Ethernet hardware adapters only, never
//!   VPN / Hyper-V / WSL / virtual; security review F3) and the receiver's free-space probe (`util::free_space_probe`, L5).
//! * Anything else compiles to "no radio, no biometric".
//!
//! Interfaces come from cl-near's `SystemInterfaces` (getifaddrs, tunnels/loopback filtered) on every OS.
use crate::Platform;
use cl_near_engine::engine::{Os, Timing};
use cl_near_engine::radio::{AdapterState, BleRadio, ScanCaps};
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;

/// "No radio": the engine treats it exactly like a missing adapter and goes straight to the local-network proof.
pub struct NoRadio;
impl BleRadio for NoRadio {
    fn adapter_state(&self) -> AdapterState {
        AdapterState::NoAdapter
    }
    fn scan(&self, _stop: &std::sync::atomic::AtomicBool, _on_uuid: &mut dyn FnMut([u8; 16])) -> Result<(), String> {
        Err("no radio".into())
    }
}

pub fn detect() -> Platform {
    #[cfg(target_os = "linux")]
    let (radio, os, biometric): (Arc<dyn BleRadio>, Os, Option<Arc<dyn crate::remote::Biometric>>) = (Arc::new(linux::BluezRadio::new()), Os::Linux, None);
    #[cfg(target_os = "macos")]
    let (radio, os, biometric): (Arc<dyn BleRadio>, Os, Option<Arc<dyn crate::remote::Biometric>>) = (Arc::new(macos::CoreBluetoothRadio::new()), Os::Mac, Some(Arc::new(macos::TouchId)));
    #[cfg(windows)]
    let (radio, os, biometric): (Arc<dyn BleRadio>, Os, Option<Arc<dyn crate::remote::Biometric>>) = (Arc::new(NoRadio), Os::Windows, None);
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    let (radio, os, biometric): (Arc<dyn BleRadio>, Os, Option<Arc<dyn crate::remote::Biometric>>) = (Arc::new(NoRadio), Os::Other, None);
    Platform {
        radio,
        biometric,
        ifaces: cl_near_engine::platform_interfaces(),
        os,
        lan_policy: cl_near::lan::LanPolicy::Strict,
        timing: Timing::default(),
        scan_caps: ScanCaps::default(),
        skew: Arc::new(AtomicU64::new(0)),
        #[cfg(feature = "testkit")]
        hooks: None,
    }
}
