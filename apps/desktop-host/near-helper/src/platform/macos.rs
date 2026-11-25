//! macOS: CoreBluetooth scanning and the Touch ID gate (LocalAuthentication), through the `objc2` bindings.
//!
//! STATUS: written on Linux and TYPE-CHECKED for `aarch64-apple-darwin` / `x86_64-apple-darwin` only (see the work-log
//! entry for exactly how). NOTHING here has been executed. Behaviour that needs a Mac, a signed app bundle and a human:
//! the Bluetooth permission prompt, hearing a real advertisement, Touch ID, and the TCC attribution of this helper to the app.
//!
//! LIBRARY CHOICE (licences read from crates.io, 2026-11-20): `objc2` + `objc2-foundation` + `objc2-core-bluetooth` +
//! `objc2-local-authentication` + `block2` + `dispatch2` are MIT (objc2-* also Apache-2.0 / Zlib alternatives), maintained
//! by one project (madsmtm/objc2), pure Rust (no C compiled into our binary, no Objective-C source). The alternative,
//! `btleplug`'s CoreBluetooth backend, pulls a whole cross-platform GATT client and `objc2`/`cocoa` anyway and offers no
//! passive scan or advert-only API: its `PeripheralProperties` would give us `services` + `service_data` just as the raw
//! delegate does, at the price of tokio, async-trait and a Peripheral model we do not use. The raw delegate is ~60 lines.
//!
//! BLUETOOTH: a `CBCentralManager` with a private serial dispatch queue (no run loop is needed in a helper that has none).
//! `scanForPeripheralsWithServices:nil options:{AllowDuplicates}`; the delegate's `didDiscoverPeripheral` reads the 128-bit UUIDs
//! out of `CBAdvertisementDataServiceUUIDsKey`, `...OverflowServiceUUIDsKey` and the keys of `...ServiceDataKey` and hands them
//! over unfiltered (CoreBluetooth hides the advertiser's address; the engine does not need it). Receive-only: no connect, no pair,
//! no advertise. Authorization is read BEFORE a manager is created (creating one is what triggers the OS prompt):
//! Denied/Restricted -> `Denied` at once. `NotDetermined` creates the manager, which shows the prompt; the engine's 3 s cap means
//! this attempt usually falls through to the local network while the prompt waits, and the next attempt succeeds.
//!
//! TOUCH ID: `LAContext.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics)`. Biometrics only: a Mac without Touch ID (a Mac
//! mini, a closed-lid clamshell with no Magic Keyboard) reports `available() == false` and the gate becomes the account password
//! the parent verifies (the same Linux path). The policy `deviceOwnerAuthentication` (which also accepts the macOS login
//! password) was NOT chosen: it would make every Mac "have a biometric" while the secret asked for is the Mac's, not the
//! Cipherline account's, which is not what the plan's gate means. User cancel / system cancel -> Cancelled; everything else Failed.
use crate::remote::Biometric;
use block2::RcBlock;
use cl_near_engine::gate::Verification;
use cl_near_engine::radio::{AdapterState, BleRadio};
use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_core_bluetooth::{
    CBAdvertisementDataOverflowServiceUUIDsKey, CBAdvertisementDataServiceDataKey, CBAdvertisementDataServiceUUIDsKey, CBCentralManager, CBCentralManagerDelegate,
    CBCentralManagerScanOptionAllowDuplicatesKey, CBManager, CBManagerAuthorization, CBManagerState, CBPeripheral, CBUUID,
};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSNumber, NSObject, NSObjectProtocol, NSString};
use objc2_local_authentication::{LAContext, LAError, LAPolicy};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::Duration;

enum Event {
    State(CBManagerState),
    Uuid([u8; 16]),
}

struct DelegateIvars {
    tx: Mutex<Sender<Event>>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements; the ivars are Send (Mutex<Sender>); no Drop is implemented.
    #[unsafe(super(NSObject))]
    #[name = "ClNearCentralDelegate"]
    #[ivars = DelegateIvars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl CBCentralManagerDelegate for Delegate {
        #[unsafe(method(centralManagerDidUpdateState:))]
        unsafe fn central_manager_did_update_state(&self, central: &CBCentralManager) {
            let st = unsafe { central.state() };
            if let Ok(tx) = self.ivars().tx.lock() {
                let _ = tx.send(Event::State(st));
            }
        }

        #[unsafe(method(centralManager:didDiscoverPeripheral:advertisementData:RSSI:))]
        unsafe fn central_manager_did_discover(&self, _central: &CBCentralManager, _peripheral: &CBPeripheral, adv: &NSDictionary<NSString, AnyObject>, _rssi: &NSNumber) {
            let Ok(tx) = self.ivars().tx.lock() else { return };
            for key in unsafe { [CBAdvertisementDataServiceUUIDsKey, CBAdvertisementDataOverflowServiceUUIDsKey] } {
                if let Some(v) = adv.objectForKey(key) {
                    if let Some(list) = v.downcast_ref::<NSArray<AnyObject>>() {
                        for item in list.iter() {
                            if let Some(u) = item.downcast_ref::<CBUUID>().and_then(uuid_bytes) {
                                let _ = tx.send(Event::Uuid(u));
                            }
                        }
                    }
                }
            }
            if let Some(v) = adv.objectForKey(unsafe { CBAdvertisementDataServiceDataKey }) {
                if let Some(d) = v.downcast_ref::<NSDictionary<AnyObject, AnyObject>>() {
                    for k in d.allKeys().iter() {
                        if let Some(u) = k.downcast_ref::<CBUUID>().and_then(uuid_bytes) {
                            let _ = tx.send(Event::Uuid(u));
                        }
                    }
                }
            }
        }
    }
);

impl Delegate {
    fn new(tx: Sender<Event>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(DelegateIvars { tx: Mutex::new(tx) });
        unsafe { msg_send![super(this), init] }
    }
}

/// A `CBUUID` is 16-bit, 32-bit or 128-bit; only a full 128-bit one can be ours.
fn uuid_bytes(u: &CBUUID) -> Option<[u8; 16]> {
    let data = unsafe { u.data() };
    <[u8; 16]>::try_from(data.to_vec().as_slice()).ok()
}

pub struct CoreBluetoothRadio;

impl CoreBluetoothRadio {
    pub fn new() -> Self {
        Self
    }

    /// A central manager on its own serial queue, and the channel its delegate reports on. The delegate must outlive the
    /// manager (CoreBluetooth holds it weakly), so both are returned and dropped together.
    fn manager() -> (Retained<CBCentralManager>, Retained<Delegate>, DispatchRetained<DispatchQueue>, Receiver<Event>) {
        let (tx, rx) = channel();
        let delegate = Delegate::new(tx);
        let queue = DispatchQueue::new("chat.cipherline.near.ble", None);
        let mgr = unsafe { CBCentralManager::initWithDelegate_queue_options(CBCentralManager::alloc(), Some(ProtocolObject::from_ref(&*delegate)), Some(&queue), None) };
        (mgr, delegate, queue, rx)
    }

    fn authorization() -> Option<AdapterState> {
        match unsafe { CBManager::authorization_class() } {
            CBManagerAuthorization::Denied | CBManagerAuthorization::Restricted => Some(AdapterState::Denied),
            _ => None,
        }
    }
}

impl Default for CoreBluetoothRadio {
    fn default() -> Self {
        Self::new()
    }
}

fn map_state(s: CBManagerState) -> Option<AdapterState> {
    Some(match s {
        CBManagerState::PoweredOn => AdapterState::Ready,
        CBManagerState::PoweredOff => AdapterState::RadioOff,
        CBManagerState::Unauthorized => AdapterState::Denied,
        CBManagerState::Unsupported => AdapterState::NoAdapter,
        _ => return None, // Unknown / Resetting: wait for the next update
    })
}

impl BleRadio for CoreBluetoothRadio {
    fn adapter_state(&self) -> AdapterState {
        if let Some(d) = Self::authorization() {
            return d;
        }
        let (_mgr, _delegate, _queue, rx) = Self::manager();
        // The engine enforces its own 3 s cap from another thread; wait a little longer than that here so this thread ends too.
        let end = std::time::Instant::now() + Duration::from_secs(4);
        loop {
            let left = end.saturating_duration_since(std::time::Instant::now());
            match rx.recv_timeout(left) {
                Ok(Event::State(s)) => {
                    if let Some(st) = map_state(s) {
                        return st;
                    }
                }
                Ok(Event::Uuid(_)) => {}
                Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => return AdapterState::Error("timeout".into()),
            }
        }
    }

    fn scan(&self, stop: &AtomicBool, on_uuid: &mut dyn FnMut([u8; 16])) -> Result<(), String> {
        if let Some(d) = Self::authorization() {
            return Err(d.bridge_name().to_string());
        }
        let (mgr, _delegate, _queue, rx) = Self::manager();
        // wait for PoweredOn
        let ready_by = std::time::Instant::now() + Duration::from_secs(4);
        loop {
            if stop.load(Ordering::SeqCst) {
                return Ok(());
            }
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Event::State(s)) => match map_state(s) {
                    Some(AdapterState::Ready) => break,
                    Some(other) => return Err(other.bridge_name().to_string()),
                    None => {}
                },
                Ok(Event::Uuid(_)) => {}
                Err(RecvTimeoutError::Timeout) => {
                    if std::time::Instant::now() > ready_by {
                        return Err("timeout".into());
                    }
                }
                Err(RecvTimeoutError::Disconnected) => return Err("closed".into()),
            }
        }
        // AllowDuplicates: a rotating UUID must be seen the moment it changes
        let yes = NSNumber::new_bool(true);
        let yes_any: &AnyObject = &yes;
        let opts: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::from_slices(&[unsafe { CBCentralManagerScanOptionAllowDuplicatesKey }], &[yes_any]);
        unsafe { mgr.scanForPeripheralsWithServices_options(None, Some(&opts)) };
        struct StopScan<'a>(&'a CBCentralManager);
        impl Drop for StopScan<'_> {
            fn drop(&mut self) {
                unsafe { self.0.stopScan() };
            }
        }
        let _guard = StopScan(&mgr);
        while !stop.load(Ordering::SeqCst) {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Event::Uuid(u)) => on_uuid(u),
                Ok(Event::State(s)) => {
                    if let Some(st) = map_state(s) {
                        if st != AdapterState::Ready {
                            return Err(st.bridge_name().to_string()); // Bluetooth was switched off mid-scan
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Err("closed".into()),
            }
        }
        Ok(())
    }
}

/// Touch ID through LocalAuthentication.
pub struct TouchId;

impl Biometric for TouchId {
    fn available(&self) -> bool {
        let ctx = unsafe { LAContext::new() };
        unsafe { ctx.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics) }.is_ok()
    }

    fn verify(&self, reason: &str) -> Verification {
        let ctx = unsafe { LAContext::new() };
        let (tx, rx) = channel::<Verification>();
        let tx = Mutex::new(tx);
        let reply = RcBlock::new(move |ok: Bool, err: *mut NSError| {
            let v = if ok.as_bool() {
                Verification::Verified
            } else {
                // SAFETY: when `ok` is NO LocalAuthentication passes a valid NSError (or null, handled as Failed)
                match unsafe { err.as_ref() }.map(|e| e.code()) {
                    Some(c) if c == LAError::UserCancel.0 || c == LAError::SystemCancel.0 || c == LAError::AppCancel.0 => Verification::Cancelled,
                    _ => Verification::Failed,
                }
            };
            if let Ok(tx) = tx.lock() {
                let _ = tx.send(v);
            }
        });
        // the reason is shown in the system dialog: "Cipherline is trying to <reason>". The engine hands the approval sentence.
        let why = NSString::from_str(&reason.chars().take(200).collect::<String>());
        unsafe { ctx.evaluatePolicy_localizedReason_reply(LAPolicy::DeviceOwnerAuthenticationWithBiometrics, &why, &reply) };
        rx.recv_timeout(Duration::from_secs(120)).unwrap_or(Verification::Failed)
    }
}
