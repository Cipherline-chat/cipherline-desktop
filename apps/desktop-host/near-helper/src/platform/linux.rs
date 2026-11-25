//! Bluetooth LE scanning on Linux: BlueZ over the system D-Bus, RECEIVE-ONLY (discovery; no pairing, no connections, no
//! advertising, no GATT), 128-bit service UUIDs handed to the engine unfiltered (cl-near's `Scanner` decides which is ours).
//!
//! WHY `zbus` DIRECTLY, not `bluer` or `btleplug` (evaluated 2026-11-20, crates.io + sources):
//!   * `bluer` 0.17.4 (BSD-2-Clause, the BlueZ project's own bindings, maintained): talks D-Bus through the `dbus` crate, i.e.
//!     the C library libdbus-1. That is a build dependency (`libdbus-1-dev` + pkg-config) on every Linux CI image and a runtime
//!     dependency on the user's machine, in a binary that must run on a glibc-2.31 floor (`rebuild-native-linux-compat`).
//!     It exposes `Device::uuids()` / `service_data()` and `discover_devices()`; fine API, wrong dependency shape. NOT
//!     buildable here (no libdbus-1-dev on this box).
//!   * `btleplug` 0.13.5 (MIT OR Apache-2.0 OR BSD-3-Clause): a cross-platform GATT-client library. Its scan results are
//!     `PeripheralProperties { services, service_data, .. }`, which would give the UUIDs, but its Linux backend is
//!     `bluez-async` over the same C `dbus` crate, it has no passive-scan mode, and its adapter/error model
//!     (`Manager::adapters()` failing as one opaque error) does not tell "no bluetoothd" from "D-Bus policy denied". It also drags
//!     in a large unrelated GATT/peripheral surface for a receive-only need.
//!   * `zbus` 5 (MIT, maintained by the freedesktop zbus project, pure Rust, no C): the same wire calls `bluer` makes
//!     (`org.freedesktop.DBus.ObjectManager.GetManagedObjects`, `org.bluez.Adapter1.StartDiscovery`/`StopDiscovery`,
//!     `Device1.UUIDs` + `ServiceData`), about 150 lines of ours, no libdbus, and every failure is a plain `zbus::Error`
//!     we classify. This is the choice.
//!
//! PASSIVE? `StartDiscovery` makes BlueZ run an ACTIVE LE scan (it may send scan requests, which are link-layer exchanges
//! with advertisers, not connections). BlueZ's truly passive path is `org.bluez.AdvertisementMonitor1` (experimental in older
//! BlueZ, needs the `-E` flag on bluetoothd), so it is not relied on. Cipherline's phones advertise a connectable-or-scannable
//! service UUID, which active discovery reports; a non-connectable advert is reported too. UNVERIFIED on real hardware.
//!
//! FAILURE MODES (every one falls through to the local-network proof inside the engine's 3 s / 12 s caps; none panics):
//!   no system bus socket, or `bluetoothd` not on the bus (`ServiceUnknown` / `NameHasNoOwner`)  -> NoAdapter
//!   bus reachable but no `Adapter1` object                                                        -> NoAdapter
//!   adapter present, `Powered = false` (rfkill / "Bluetooth off")                                -> RadioOff
//!   D-Bus policy refuses us (`AccessDenied`, `org.bluez.Error.NotAuthorized`)                    -> Denied
//!   a bus that never answers: the engine's 3 s adapter cap and 12 s scan cap give up on the radio thread
//!   anything else (including a malformed reply)                                                  -> Error(<short text>)
//! The earlier Node spike found a missing system bus CRASHED its library (unhandled `error` event); here a connect failure is
//! an ordinary `Err`, and the whole body also runs under `catch_unwind`.
use cl_near_engine::radio::{AdapterState, BleRadio};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

type Props = HashMap<String, OwnedValue>;
type Objects = HashMap<OwnedObjectPath, HashMap<String, Props>>;

const BLUEZ: &str = "org.bluez";
const POLL: Duration = Duration::from_millis(250);

pub struct BluezRadio {
    /// `None` = the system bus (`DBUS_SYSTEM_BUS_ADDRESS` or the default socket); tests point it elsewhere.
    address: Option<String>,
}

impl BluezRadio {
    pub fn new() -> Self {
        Self { address: None }
    }
    pub fn with_address(address: impl Into<String>) -> Self {
        Self { address: Some(address.into()) }
    }

    fn connect(&self) -> Result<Connection, zbus::Error> {
        match &self.address {
            None => Connection::system(),
            Some(a) => zbus::blocking::connection::Builder::address(a.as_str())?.build(),
        }
    }
}

impl Default for BluezRadio {
    fn default() -> Self {
        Self::new()
    }
}

/// The three things the scan needs from `GetManagedObjects`.
#[derive(Debug, PartialEq)]
pub struct Snapshot {
    pub adapters: Vec<(String, bool)>, // (object path, Powered)
    pub uuids: Vec<[u8; 16]>,
}

/// Pure: what a `GetManagedObjects` reply says about adapters and the 128-bit UUIDs of every known device.
pub fn snapshot(objects: &Objects) -> Snapshot {
    let mut adapters = vec![];
    let mut uuids = vec![];
    for (path, ifaces) in objects {
        if let Some(a) = ifaces.get("org.bluez.Adapter1") {
            let powered = a.get("Powered").and_then(|v| bool::try_from(v.clone()).ok()).unwrap_or(false);
            adapters.push((path.to_string(), powered));
        }
        if let Some(d) = ifaces.get("org.bluez.Device1") {
            if let Some(list) = d.get("UUIDs").and_then(|v| Vec::<String>::try_from(v.clone()).ok()) {
                uuids.extend(list.iter().filter_map(|s| parse_uuid(s)));
            }
            if let Some(sd) = d.get("ServiceData").and_then(|v| HashMap::<String, OwnedValue>::try_from(v.clone()).ok()) {
                uuids.extend(sd.keys().filter_map(|s| parse_uuid(s)));
            }
        }
    }
    adapters.sort();
    Snapshot { adapters, uuids }
}

/// `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (any case) -> 16 bytes in textual (big-endian) order. 16- and 32-bit forms are not ours.
pub fn parse_uuid(s: &str) -> Option<[u8; 16]> {
    let b = s.as_bytes();
    if b.len() != 36 || [8, 13, 18, 23].iter().any(|i| b[*i] != b'-') {
        return None;
    }
    let hex: Vec<u8> = s.bytes().filter(|c| *c != b'-').collect();
    if hex.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for i in 0..16 {
        out[i] = u8::from_str_radix(std::str::from_utf8(&hex[2 * i..2 * i + 2]).ok()?, 16).ok()?;
    }
    Some(out)
}

/// Map a D-Bus / zbus failure (as text, so this is testable without a bus) to what the engine should believe.
pub fn classify_error(e: &str) -> AdapterState {
    let l = e.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| l.contains(n));
    if has(&["accessdenied", "access denied", "notauthorized", "not authorized", "notpermitted", "not permitted", "authfailed", "rejected"]) {
        AdapterState::Denied
    } else if has(&["serviceunknown", "service unknown", "namehasnoowner", "no owner", "not provided by any .service", "no such file", "notfound", "no such device", "connection refused", "unknownobject", "unknown object"]) {
        AdapterState::NoAdapter
    } else if has(&["notready", "not ready", "blocked", "rfkill", "powered"]) {
        AdapterState::RadioOff
    } else {
        AdapterState::Error(e.chars().take(120).collect())
    }
}

fn managed(conn: &Connection) -> Result<Objects, zbus::Error> {
    let p = Proxy::new(conn, BLUEZ, "/", "org.freedesktop.DBus.ObjectManager")?;
    p.call::<_, _, Objects>("GetManagedObjects", &())
}

fn state_of(conn: &Connection) -> Result<(AdapterState, Option<String>), zbus::Error> {
    let snap = snapshot(&managed(conn)?);
    Ok(match snap.adapters.iter().find(|a| a.1).or_else(|| snap.adapters.first()) {
        None => (AdapterState::NoAdapter, None),
        Some((path, true)) => (AdapterState::Ready, Some(path.clone())),
        Some((_, false)) => (AdapterState::RadioOff, None),
    })
}

/// Stops discovery on EVERY exit path of a scan (return, error, panic unwinding).
struct Discovery<'a> {
    adapter: Proxy<'a>,
}
impl Drop for Discovery<'_> {
    fn drop(&mut self) {
        let _ = self.adapter.call::<_, _, ()>("StopDiscovery", &());
    }
}

impl BleRadio for BluezRadio {
    fn adapter_state(&self) -> AdapterState {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match self.connect().and_then(|c| state_of(&c)) {
            Ok((st, _)) => st,
            Err(e) => classify_error(&format!("{e:?} {e}")),
        }))
        .unwrap_or_else(|_| AdapterState::Error("internal".into()))
    }

    fn scan(&self, stop: &AtomicBool, on_uuid: &mut dyn FnMut([u8; 16])) -> Result<(), String> {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), String> {
            let conn = self.connect().map_err(|e| format!("{e}"))?;
            let (st, path) = state_of(&conn).map_err(|e| format!("{e}"))?;
            let Some(path) = path else { return Err(st.bridge_name().to_string()) };
            let adapter = Proxy::new(&conn, BLUEZ, path, "org.bluez.Adapter1").map_err(|e| format!("{e}"))?;
            // LE only, and every advertisement (duplicates), so a rotating UUID is seen the moment it appears.
            let mut filter: HashMap<&str, zbus::zvariant::Value<'_>> = HashMap::new();
            filter.insert("Transport", "le".into());
            filter.insert("DuplicateData", true.into());
            let _ = adapter.call::<_, _, ()>("SetDiscoveryFilter", &(filter,)); // best effort: older BlueZ ignores keys it lacks
            match adapter.call::<_, _, ()>("StartDiscovery", &()) {
                Ok(()) => {}
                Err(e) => {
                    let t = format!("{e:?} {e}");
                    // another client is already scanning: BlueZ reports InProgress and the results are shared
                    if !t.to_ascii_lowercase().contains("inprogress") && !t.to_ascii_lowercase().contains("in progress") {
                        return Err(t.chars().take(160).collect());
                    }
                }
            }
            let _guard = Discovery { adapter };
            while !stop.load(Ordering::SeqCst) {
                match managed(&conn) {
                    Ok(o) => {
                        for u in snapshot(&o).uuids {
                            on_uuid(u);
                        }
                    }
                    Err(e) => return Err(format!("{e}")),
                }
                std::thread::sleep(POLL);
            }
            Ok(())
        }))
        .unwrap_or_else(|_| Err("internal".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cl_near_engine::radio::{probe_adapter, scan_for_proof, ScanCaps, ScanOutcome};
    use std::io::{Read, Write};
    use std::os::unix::net::UnixListener;
    use std::sync::Arc;
    use std::time::Instant;
    use zbus::zvariant::Value;

    fn val(v: impl Into<Value<'static>>) -> OwnedValue {
        OwnedValue::try_from(v.into()).unwrap()
    }
    fn path(s: &str) -> OwnedObjectPath {
        OwnedObjectPath::try_from(s.to_string()).unwrap()
    }

    #[test]
    fn uuids_parse_only_in_full_128_bit_form() {
        let u = "0000fe00-1234-5678-9abc-def012345678";
        assert_eq!(parse_uuid(u).unwrap()[..4], [0, 0, 0xfe, 0]);
        assert_eq!(parse_uuid(&u.to_uppercase()), parse_uuid(u));
        for bad in ["", "180f", "0000180f-0000-1000-8000-00805f9b34", "0000fe00_1234_5678_9abc_def012345678", "zzzzzzzz-1234-5678-9abc-def012345678"] {
            assert_eq!(parse_uuid(bad), None, "{bad}");
        }
    }

    #[test]
    fn snapshot_reads_adapters_and_every_uuid_source() {
        let mut o: Objects = HashMap::new();
        o.insert(path("/org/bluez/hci0"), HashMap::from([("org.bluez.Adapter1".to_string(), HashMap::from([("Powered".to_string(), val(true))]))]));
        o.insert(path("/org/bluez/hci1"), HashMap::from([("org.bluez.Adapter1".to_string(), HashMap::from([("Powered".to_string(), val(false))]))]));
        let u1 = "0000aaaa-0000-1000-8000-00805f9b34fb";
        let u2 = "0000bbbb-1111-2222-3333-444455556666";
        let sd: HashMap<String, Value<'static>> = HashMap::from([(u2.to_string(), Value::from(vec![1u8, 2]))]);
        o.insert(path("/org/bluez/hci0/dev_AA"), HashMap::from([("org.bluez.Device1".to_string(), HashMap::from([
            ("UUIDs".to_string(), val(vec![u1.to_string(), "180f".to_string()])),
            ("ServiceData".to_string(), val(sd)),
        ]))]));
        let s = snapshot(&o);
        assert_eq!(s.adapters, vec![("/org/bluez/hci0".to_string(), true), ("/org/bluez/hci1".to_string(), false)]);
        assert!(s.uuids.contains(&parse_uuid(u1).unwrap()) && s.uuids.contains(&parse_uuid(u2).unwrap()));
        assert_eq!(s.uuids.len(), 2, "the 16-bit UUID is ignored");
        assert_eq!(snapshot(&HashMap::new()), Snapshot { adapters: vec![], uuids: vec![] });
    }

    #[test]
    fn failures_map_to_what_the_engine_should_believe() {
        use AdapterState::*;
        assert_eq!(classify_error("org.freedesktop.DBus.Error.ServiceUnknown: The name org.bluez was not provided by any .service files"), NoAdapter);
        assert_eq!(classify_error("org.freedesktop.DBus.Error.NameHasNoOwner"), NoAdapter);
        assert_eq!(classify_error("Io(Os { code: 2, kind: NotFound, message: \"No such file or directory\" })"), NoAdapter);
        assert_eq!(classify_error("org.freedesktop.DBus.Error.AccessDenied: Rejected send message"), Denied);
        assert_eq!(classify_error("org.bluez.Error.NotAuthorized"), Denied);
        assert_eq!(classify_error("org.bluez.Error.NotReady: Resource Not Ready"), RadioOff);
        assert!(matches!(classify_error("something unforeseen"), Error(_)));
        assert!(matches!(classify_error(&"x".repeat(500)), Error(m) if m.len() == 120));
    }

    #[test]
    fn no_system_bus_is_no_adapter_at_once_and_never_a_crash() {
        let t0 = Instant::now();
        let r = BluezRadio::with_address("unix:path=/nonexistent/cl-near-test-bus");
        assert_eq!(r.adapter_state(), AdapterState::NoAdapter);
        assert!(r.scan(&AtomicBool::new(false), &mut |_| {}).is_err());
        assert!(t0.elapsed() < Duration::from_secs(2));
        // and through the engine's own probe: the radio is simply "not usable", and a scan falls through straight away
        let radio: Arc<dyn BleRadio> = Arc::new(BluezRadio::with_address("unix:path=/nonexistent/cl-near-test-bus"));
        assert_eq!(probe_adapter(&radio, Duration::from_secs(3)), AdapterState::NoAdapter);
    }

    #[test]
    fn the_real_system_bus_of_this_machine_never_crashes_the_probe() {
        // On a machine with no bluetoothd (this CI/dev box) this is NoAdapter; with one it is Ready/RadioOff/Denied. Never a panic, never a hang.
        let t0 = Instant::now();
        let st = probe_adapter(&(Arc::new(BluezRadio::new()) as Arc<dyn BleRadio>), Duration::from_secs(3));
        assert!(t0.elapsed() < Duration::from_millis(3500), "{st:?}");
    }

    #[test]
    fn a_bus_that_accepts_and_never_speaks_is_given_up_on_at_the_3s_cap() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("hostile.sock");
        let l = UnixListener::bind(&sock).unwrap();
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                std::thread::spawn(move || {
                    let mut s = s;
                    let mut b = [0u8; 64];
                    while s.read(&mut b).map(|n| n > 0).unwrap_or(false) {} // read the client's AUTH, answer nothing
                });
            }
        });
        let radio: Arc<dyn BleRadio> = Arc::new(BluezRadio::with_address(format!("unix:path={}", sock.display())));
        let t0 = Instant::now();
        let st = probe_adapter(&radio, Duration::from_millis(600));
        assert!(t0.elapsed() < Duration::from_secs(2), "the caller's cap must hold even though the radio thread hangs");
        assert!(matches!(st, AdapterState::Error(ref m) if m == "timeout"), "{st:?}");
        // the scan path: the engine gives up on a hung radio and falls through to the LAN proof
        let kn = {
            use cl_near::keys::{public_of, session_keys};
            let n = [3u8; 32];
            let a = [4u8; 32];
            session_keys(&n, &public_of(&a), &[9u8; 16], "linkid").unwrap()
        };
        let t1 = Instant::now();
        let (_ack_tx, ack_rx) = std::sync::mpsc::channel();
        let out = scan_for_proof(&radio, &kn, "linkid", ScanCaps { adapter: Duration::from_millis(500), scan: Duration::from_millis(800) }, &AtomicBool::new(false), true, &mut |_, _| {}, &ack_rx);
        assert!(matches!(out, ScanOutcome::FellThrough(_)));
        assert!(t1.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn a_bus_that_speaks_garbage_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("garbage.sock");
        let l = UnixListener::bind(&sock).unwrap();
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                let mut s = s;
                let _ = s.write_all(b"\x00\xffGARBAGE NOT A DBUS SERVER\r\n");
            }
        });
        let r = BluezRadio::with_address(format!("unix:path={}", sock.display()));
        let t0 = Instant::now();
        let st = r.adapter_state();
        assert!(matches!(st, AdapterState::Error(_) | AdapterState::NoAdapter | AdapterState::Denied), "{st:?}");
        assert!(r.scan(&AtomicBool::new(false), &mut |_| {}).is_err());
        assert!(t0.elapsed() < Duration::from_secs(5));
    }
}
