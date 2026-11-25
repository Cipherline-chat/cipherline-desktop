//! The Windows Bluetooth scanner for the proximity proof (contract 4.1): `BluetoothLEAdvertisementWatcher`,
//! PASSIVE, receive-only. No pairing, no GATT connections, no advertising (a desktop never advertises); the
//! watcher is stopped and its handler removed on EVERY exit path (a drop guard, so a panic or an early
//! return cannot leave a scan running). Every advertisement's 128-bit service UUIDs go to the engine
//! unfiltered; cl-near's `Scanner` decides which (if any) is ours.
//!
//! Adapter state (within the engine's 3 s cap) comes from `Radio::RequestAccessAsync` (privacy setting) and the
//! default `BluetoothAdapter` + its radio state; every failure maps to a state the engine treats as "fall
//! through to the local network".
//!
//! NOT verifiable on the Linux dev box: this is type-checked for `x86_64-pc-windows-msvc` only. Real-radio
//! behaviour (does a passive watcher see a phone's non-connectable advertisement with only a service UUID;
//! radio-off while scanning; the Bluetooth privacy consent) needs a Windows PC.
use super::radio::{AdapterState, BleRadio};

/// A WinRT/Win32 `GUID` (`data1` etc. as the OS stores them) -> the 16 bytes in canonical (textual,
/// big-endian) order that `cl_near::ble::uuid_string` / `open_uuid` use.
pub fn guid_bytes(d1: u32, d2: u16, d3: u16, d4: [u8; 8]) -> [u8; 16] {
    let mut b = [0u8; 16];
    b[..4].copy_from_slice(&d1.to_be_bytes());
    b[4..6].copy_from_slice(&d2.to_be_bytes());
    b[6..8].copy_from_slice(&d3.to_be_bytes());
    b[8..].copy_from_slice(&d4);
    b
}

#[cfg(windows)]
pub use imp::WinRadio;

/// Join the WinRT multithreaded apartment on the calling thread (shared with `winhello`).
#[cfg(windows)]
pub(crate) fn mta_for_hello() {
    imp::mta();
}

/// Non-Windows builds have no radio; this keeps `use` sites identical.
#[cfg(not(windows))]
pub struct WinRadio;
#[cfg(not(windows))]
impl BleRadio for WinRadio {
    fn adapter_state(&self) -> AdapterState {
        AdapterState::NoAdapter
    }
    fn scan(&self, _stop: &std::sync::atomic::AtomicBool, _on_uuid: &mut dyn FnMut([u8; 16])) -> Result<(), String> {
        Err("no radio".into())
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::time::Duration;
    use windows::Devices::Bluetooth::Advertisement::{BluetoothLEAdvertisementReceivedEventArgs, BluetoothLEAdvertisementWatcher, BluetoothLEAdvertisementWatcherStatus, BluetoothLEScanningMode};
    use windows::Devices::Bluetooth::BluetoothAdapter;
    use windows::Devices::Radios::{Radio, RadioAccessStatus, RadioState};
    use windows::Foundation::TypedEventHandler;
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

    pub struct WinRadio;

    /// WinRT on a thread of ours: join the MTA once per thread (S_FALSE / a different mode already set is fine).
    pub(crate) fn mta() {
        unsafe {
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
        }
    }

    impl BleRadio for WinRadio {
        fn adapter_state(&self) -> AdapterState {
            mta();
            match Radio::RequestAccessAsync().and_then(|op| op.join()) {
                Ok(RadioAccessStatus::DeniedByUser) | Ok(RadioAccessStatus::DeniedBySystem) => return AdapterState::Denied,
                _ => {} // Allowed / Unspecified, or the call itself failed: the adapter query below decides
            }
            let adapter = match BluetoothAdapter::GetDefaultAsync().and_then(|op| op.join()) {
                Ok(a) => a,
                Err(_) => return AdapterState::NoAdapter, // no adapter: GetDefaultAsync yields null
            };
            if !adapter.IsLowEnergySupported().unwrap_or(false) {
                return AdapterState::NoAdapter;
            }
            match adapter.GetRadioAsync().and_then(|op| op.join()).and_then(|r| r.State()) {
                Ok(RadioState::On) => AdapterState::Ready,
                Ok(RadioState::Off) => AdapterState::RadioOff,
                Ok(RadioState::Disabled) => AdapterState::NoAdapter,
                Ok(_) => AdapterState::Error("unknown radio state".into()),
                Err(e) => AdapterState::Error(e.message()),
            }
        }

        fn scan(&self, stop: &AtomicBool, on_uuid: &mut dyn FnMut([u8; 16])) -> Result<(), String> {
            mta();
            let watcher = BluetoothLEAdvertisementWatcher::new().map_err(|e| e.message())?;
            watcher.SetScanningMode(BluetoothLEScanningMode::Passive).map_err(|e| e.message())?;
            let (tx, rx) = mpsc::channel::<[u8; 16]>();
            let aborted = Arc::new(AtomicBool::new(false));
            let received = watcher
                .Received(&TypedEventHandler::new(move |_w: windows_core::Ref<BluetoothLEAdvertisementWatcher>, args: windows_core::Ref<BluetoothLEAdvertisementReceivedEventArgs>| {
                    if let Some(a) = args.as_ref() {
                        let uuids = a.Advertisement()?.ServiceUuids()?;
                        for i in 0..uuids.Size()? {
                            let g = uuids.GetAt(i)?;
                            let _ = tx.send(guid_bytes(g.data1, g.data2, g.data3, g.data4));
                        }
                    }
                    Ok(())
                }))
                .map_err(|e| e.message())?;
            // From here the guard stops and unhooks the watcher on every exit path.
            struct Guard {
                w: BluetoothLEAdvertisementWatcher,
                token: i64,
            }
            impl Drop for Guard {
                fn drop(&mut self) {
                    let _ = self.w.Stop();
                    let _ = self.w.RemoveReceived(self.token);
                }
            }
            let guard = Guard { w: watcher, token: received };
            let flag = aborted.clone();
            let stopped = guard.w.Stopped(&TypedEventHandler::new(move |w: windows_core::Ref<BluetoothLEAdvertisementWatcher>, _a| {
                if let Some(w) = w.as_ref() {
                    if w.Status().map(|s| s == BluetoothLEAdvertisementWatcherStatus::Aborted).unwrap_or(false) {
                        flag.store(true, Ordering::SeqCst);
                    }
                }
                Ok(())
            }));
            guard.w.Start().map_err(|e| e.message())?;
            let result = loop {
                if stop.load(Ordering::SeqCst) {
                    break Ok(());
                }
                if aborted.load(Ordering::SeqCst) {
                    break Err("the Bluetooth scan was aborted by the system".to_string());
                }
                match rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(u) => on_uuid(u),
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break Err("the scan handler went away".to_string()),
                }
            };
            if let Ok(t) = stopped {
                let _ = guard.w.RemoveStopped(t);
            }
            drop(guard);
            result
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guid_bytes_match_the_canonical_textual_order_cl_near_uses() {
        // {00112233-4455-6677-8899-aabbccddeeff}: data1/2/3 are stored as integers, data4 as bytes
        let b = guid_bytes(0x0011_2233, 0x4455, 0x6677, [0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
        assert_eq!(cl_near::ble::uuid_string(&b), "00112233-4455-6677-8899-aabbccddeeff");
        assert_eq!(cl_near::ble::parse_uuid("00112233-4455-6677-8899-aabbccddeeff"), Some(b));
    }
}
