//! Bluetooth LE scanning for the proximity proof (contract 4.1). Desktops only SCAN: no pairing, no
//! connections, no advertising. The platform sits behind [`BleRadio`]; the Windows implementation
//! (`winble.rs`, `BluetoothLEAdvertisementWatcher`) is cfg(windows) and the tests/harness use [`FakeRadio`].
//!
//! Caps from the contract: 3 s to learn the adapter state, 12 s of scanning. Every failure mode (no radio,
//! radio off, consent denied, driver error, silence) ends in [`ScanOutcome::FellThrough`] so the engine goes
//! straight to the local-network proof; none of them is an error the user has to act on.
use cl_near::ble::{BleProbe, BleRole, BleStatus, FallReason, Scanner, ADAPTER_STATE_CAP, SCAN_CAP};
use cl_near::keys::SessionKeys;
use cl_near::proof::ProximityProof;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AdapterState {
    Ready,
    NoAdapter,
    RadioOff,
    /// The OS refused radio access (privacy setting / consent).
    Denied,
    Error(String),
}

impl AdapterState {
    pub fn usable(&self) -> bool {
        matches!(self, AdapterState::Ready)
    }
    /// Stable name for the bridge (`NearBluetoothState`).
    pub fn bridge_name(&self) -> &'static str {
        match self {
            AdapterState::Ready => "ready",
            AdapterState::NoAdapter => "no_adapter",
            AdapterState::RadioOff => "radio_off",
            AdapterState::Denied => "denied",
            AdapterState::Error(_) => "error",
        }
    }
}

pub trait BleRadio: Send + Sync + 'static {
    /// May block (WinRT radio query). The caller enforces the 3 s cap from another thread.
    fn adapter_state(&self) -> AdapterState;
    /// Passive scan. Call `on_uuid` for EVERY 128-bit service UUID in EVERY advertisement (duplicates
    /// included: a watcher may coalesce, so dedup must not happen here). Return when `stop` is set.
    fn scan(&self, stop: &AtomicBool, on_uuid: &mut dyn FnMut([u8; 16])) -> Result<(), String>;
}

#[derive(Debug)]
pub enum ScanOutcome {
    /// Verifying scanner (the approver): the advertiser's `ble_ack` for the nonce `r` we heard verified (L1). THE Bluetooth proof.
    Heard { r: [u8; 12], proof: ProximityProof },
    /// Reporting scanner (the new device, which verifies nothing): a valid advertisement was heard and `ble_heard` was handed out; the
    /// verdict comes from the approver's `ble_result`.
    Reported { r: [u8; 12] },
    FellThrough(FallReason),
}

/// How many distinct advertisement nonces get a `ble_heard` (one per distinct `r`; a stranger's flood cannot make us chatty).
pub const MAX_HEARD_REPORTS: usize = 4;

#[derive(Clone, Copy)]
pub struct ScanCaps {
    pub adapter: Duration,
    pub scan: Duration,
}
impl Default for ScanCaps {
    fn default() -> Self {
        Self { adapter: ADAPTER_STATE_CAP, scan: SCAN_CAP }
    }
}

/// Probe the adapter with the 3 s cap. A radio that does not answer in time reports `Error("timeout")`.
pub fn probe_adapter(radio: &Arc<dyn BleRadio>, cap: Duration) -> AdapterState {
    let (tx, rx) = mpsc::channel();
    let r = radio.clone();
    std::thread::spawn(move || {
        let _ = tx.send(r.adapter_state());
    });
    rx.recv_timeout(cap).unwrap_or_else(|_| AdapterState::Error("timeout".into()))
}

/// Run the scanner side of 4.1 to completion (or fall through). `cancel` aborts early (treated as nothing heard).
///
/// L1 (security review 2026-11-20): hearing a valid UUID is NOT a proof (its tag is 32 bits). For every DISTINCT valid `r` (at most
/// [`MAX_HEARD_REPORTS`]) `report(r, mac)` is called so the caller can send `ble_heard`; scanning continues until the advertiser's
/// `ble_ack` arrives on `acks` and verifies against one of the nonces we heard (`verify == true`, the approver), or, for a reporting scanner
/// (`verify == false`, the new device), until the first report went out. The 12 s scan cap covers the whole exchange.
pub fn scan_for_proof(radio: &Arc<dyn BleRadio>, keys: &SessionKeys, link_id: &str, caps: ScanCaps, cancel: &AtomicBool, verify: bool, report: &mut dyn FnMut([u8; 12], [u8; 32]), acks: &mpsc::Receiver<[u8; 32]>) -> ScanOutcome {
    let mut probe = BleProbe::new(BleRole::Scan, Instant::now());
    let state = probe_adapter(radio, caps.adapter);
    if probe.adapter_state(state.usable(), Instant::now()) != BleStatus::Running {
        let why = if matches!(state, AdapterState::Error(ref e) if e == "timeout") { FallReason::AdapterTimeout } else { FallReason::NoAdapter };
        return ScanOutcome::FellThrough(why);
    }
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel::<[u8; 16]>();
    let (r2, stop2) = (radio.clone(), stop.clone());
    let handle = std::thread::spawn(move || {
        let _ = r2.scan(&stop2, &mut |u| {
            let _ = tx.send(u);
        });
    });
    let scanner = Scanner::new(keys);
    let started = Instant::now();
    let mut heard: Vec<[u8; 12]> = Vec::new();
    let outcome = loop {
        if cancel.load(Ordering::SeqCst) {
            break ScanOutcome::FellThrough(FallReason::NothingHeard);
        }
        // an ack for any nonce we reported is the proof
        while let Ok(ack) = acks.try_recv() {
            if let Some((r, proof)) = heard.iter().find_map(|r| scanner.prove_ack(link_id, r, &ack).map(|p| (*r, p))) {
                if verify {
                    probe.proof();
                    stop.store(true, Ordering::SeqCst);
                    let _ = handle.join();
                    return ScanOutcome::Heard { r, proof };
                }
            }
        }
        let left = caps.scan.saturating_sub(started.elapsed());
        if left.is_zero() {
            break ScanOutcome::FellThrough(FallReason::NothingHeard);
        }
        match rx.recv_timeout(left.min(Duration::from_millis(50))) {
            Ok(u) => {
                if let Some((r, mac)) = scanner.on_uuid(&u) {
                    if !heard.contains(&r) && heard.len() < MAX_HEARD_REPORTS {
                        heard.push(r);
                        report(r, mac);
                        if !verify {
                            break ScanOutcome::Reported { r };
                        }
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            // the scan thread ended on its own (driver error): nothing more will arrive
            Err(mpsc::RecvTimeoutError::Disconnected) => break ScanOutcome::FellThrough(FallReason::NoAdapter),
        }
    };
    stop.store(true, Ordering::SeqCst);
    let _ = handle.join();
    outcome
}

/// Scripted radio for tests and the Linux harness: reports `state`, then emits `adverts` (delay, uuid).
pub struct FakeRadio {
    pub state: AdapterState,
    pub adverts: Vec<(Duration, [u8; 16])>,
    /// Make `adapter_state` hang (simulates a driver that never answers).
    pub hang: bool,
}

impl FakeRadio {
    pub fn new(state: AdapterState, adverts: Vec<(Duration, [u8; 16])>) -> Self {
        Self { state, adverts, hang: false }
    }
}

impl BleRadio for FakeRadio {
    fn adapter_state(&self) -> AdapterState {
        if self.hang {
            std::thread::sleep(Duration::from_secs(30));
        }
        self.state.clone()
    }
    fn scan(&self, stop: &AtomicBool, on_uuid: &mut dyn FnMut([u8; 16])) -> Result<(), String> {
        let t0 = Instant::now();
        let mut i = 0;
        while !stop.load(Ordering::SeqCst) {
            while i < self.adverts.len() && t0.elapsed() >= self.adverts[i].0 {
                on_uuid(self.adverts[i].1);
                i += 1;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cl_near::ble::{advert_uuid, Advertiser};
    use cl_near::keys;

    fn pair() -> (SessionKeys, SessionKeys) {
        let (en, en_pub) = keys::generate_keypair();
        let (ea, ea_pub) = keys::generate_keypair();
        (keys::session_keys(&ea, &en_pub, &[1; 16], "link").unwrap(), keys::session_keys(&en, &ea_pub, &[1; 16], "link").unwrap())
    }
    const FAST: ScanCaps = ScanCaps { adapter: Duration::from_millis(200), scan: Duration::from_millis(400) };

    /// A scan with no advertiser behind it: reports go nowhere, acks never come.
    fn scan(radio: &Arc<dyn BleRadio>, k: &SessionKeys, caps: ScanCaps, cancel: &AtomicBool) -> ScanOutcome {
        let (_tx, rx) = mpsc::channel();
        scan_for_proof(radio, k, "link", caps, cancel, true, &mut |_, _| {}, &rx)
    }

    #[test]
    fn a_heard_advertisement_is_a_proof_only_through_the_advertisers_ack() {
        let (ka, kn) = pair();
        let mut adv = Advertiser::new();
        let (_r, u) = adv.next_advert(&ka);
        let noise = [[9u8; 16], [3u8; 16]];
        let radio: Arc<dyn BleRadio> = Arc::new(FakeRadio::new(AdapterState::Ready, vec![(Duration::ZERO, noise[0]), (Duration::from_millis(20), noise[1]), (Duration::from_millis(40), u), (Duration::from_millis(60), u)]));
        // the advertiser: verifies `ble_heard`, answers `ble_ack`
        let (atx, arx) = mpsc::channel();
        let ka2 = clone_keys_for_test(&ka);
        let mut reported = vec![];
        let out = scan_for_proof(&radio, &kn, "link", FAST, &AtomicBool::new(false), true, &mut |r, mac| {
            reported.push(r);
            if let Some(ack) = adv.ack_for_heard(&ka2, &mac) {
                let _ = atx.send(ack);
            }
        }, &arx);
        match out {
            ScanOutcome::Heard { proof, .. } => assert_eq!(proof.method(), cl_near::approval::Proximity::Ble),
            o => panic!("expected Heard, got {o:?}"),
        }
        assert_eq!(reported.len(), 1, "one ble_heard per distinct nonce, however often the advert repeats");
    }

    #[test]
    fn a_heard_uuid_without_an_ack_is_no_proof_and_a_wrong_ack_is_ignored() {
        let (ka, kn) = pair();
        let mut adv = Advertiser::new();
        let (_r, u) = adv.next_advert(&ka);
        let radio: Arc<dyn BleRadio> = Arc::new(FakeRadio::new(AdapterState::Ready, vec![(Duration::from_millis(10), u)]));
        // silence: the radio heard a valid UUID, the "advertiser" never answers
        let (_tx, rx) = mpsc::channel();
        let mut n = 0;
        assert!(matches!(scan_for_proof(&radio, &kn, "link", FAST, &AtomicBool::new(false), true, &mut |_, _| n += 1, &rx), ScanOutcome::FellThrough(FallReason::NothingHeard)));
        assert_eq!(n, 1);
        // an ack made with another session's key does not verify
        let (other_a, _) = pair();
        let (atx, arx) = mpsc::channel();
        let radio: Arc<dyn BleRadio> = Arc::new(FakeRadio::new(AdapterState::Ready, vec![(Duration::from_millis(10), u)]));
        let o2 = clone_keys_for_test(&other_a);
        let out = scan_for_proof(&radio, &kn, "link", FAST, &AtomicBool::new(false), true, &mut |r, _| {
            let _ = atx.send(cl_near::ble::ack_mac(&o2, &r));
        }, &arx);
        assert!(matches!(out, ScanOutcome::FellThrough(FallReason::NothingHeard)));
    }

    #[test]
    fn a_reporting_scanner_stops_after_the_first_report_and_never_claims_a_proof() {
        let (ka, kn) = pair();
        let mut adv = Advertiser::new();
        let (_r, u) = adv.next_advert(&ka);
        let radio: Arc<dyn BleRadio> = Arc::new(FakeRadio::new(AdapterState::Ready, vec![(Duration::from_millis(10), u)]));
        let (_tx, rx) = mpsc::channel();
        let mut got = vec![];
        let out = scan_for_proof(&radio, &kn, "link", FAST, &AtomicBool::new(false), false, &mut |r, mac| got.push((r, mac)), &rx);
        assert!(matches!(out, ScanOutcome::Reported { .. }));
        assert_eq!(got.len(), 1);
        assert!(adv.verify_heard(&ka, &got[0].1));
    }

    #[test]
    fn at_most_four_nonces_are_reported() {
        let (ka, kn) = pair();
        let mut adv = Advertiser::new();
        let adverts: Vec<_> = (0..7).map(|i| (Duration::from_millis(5 * i), adv.next_advert(&ka).1)).collect();
        let radio: Arc<dyn BleRadio> = Arc::new(FakeRadio::new(AdapterState::Ready, adverts));
        let (_tx, rx) = mpsc::channel();
        let mut n = 0;
        scan_for_proof(&radio, &kn, "link", FAST, &AtomicBool::new(false), true, &mut |_, _| n += 1, &rx);
        assert_eq!(n, MAX_HEARD_REPORTS);
    }

    fn clone_keys_for_test(k: &SessionKeys) -> SessionKeys {
        SessionKeys { conf: k.conf.clone(), relay: k.relay.clone(), ble: k.ble.clone(), lan: k.lan.clone(), xfer: k.xfer.clone() }
    }

    #[test]
    fn a_uuid_from_another_session_is_never_a_proof() {
        let (ka, kn) = pair();
        let (other_a, _) = pair();
        let foreign = advert_uuid(&other_a.ble, &[5; 12]);
        let _ = ka;
        let radio: Arc<dyn BleRadio> = Arc::new(FakeRadio::new(AdapterState::Ready, vec![(Duration::ZERO, foreign)]));
        assert!(matches!(scan(&radio, &kn, FAST, &AtomicBool::new(false)), ScanOutcome::FellThrough(FallReason::NothingHeard)));
    }

    #[test]
    fn every_unusable_adapter_falls_through_at_once() {
        let (_ka, kn) = pair();
        for st in [AdapterState::NoAdapter, AdapterState::RadioOff, AdapterState::Denied, AdapterState::Error("driver".into())] {
            let t0 = Instant::now();
            let radio: Arc<dyn BleRadio> = Arc::new(FakeRadio::new(st.clone(), vec![]));
            assert!(matches!(scan(&radio, &kn, FAST, &AtomicBool::new(false)), ScanOutcome::FellThrough(FallReason::NoAdapter)), "{st:?}");
            assert!(t0.elapsed() < Duration::from_millis(150), "no waiting for the scan cap when the radio is known unusable");
        }
    }

    #[test]
    fn a_radio_that_never_answers_is_given_up_on_at_the_adapter_cap() {
        let (_ka, kn) = pair();
        let mut f = FakeRadio::new(AdapterState::Ready, vec![]);
        f.hang = true;
        let radio: Arc<dyn BleRadio> = Arc::new(f);
        let t0 = Instant::now();
        assert!(matches!(scan(&radio, &kn, FAST, &AtomicBool::new(false)), ScanOutcome::FellThrough(FallReason::AdapterTimeout)));
        assert!(t0.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn silence_ends_at_the_scan_cap_and_cancel_ends_it_sooner() {
        let (_ka, kn) = pair();
        let radio: Arc<dyn BleRadio> = Arc::new(FakeRadio::new(AdapterState::Ready, vec![]));
        let t0 = Instant::now();
        assert!(matches!(scan(&radio, &kn, FAST, &AtomicBool::new(false)), ScanOutcome::FellThrough(FallReason::NothingHeard)));
        assert!(t0.elapsed() >= Duration::from_millis(400));
        let cancel = AtomicBool::new(true);
        let t1 = Instant::now();
        scan(&radio, &kn, ScanCaps { adapter: Duration::from_millis(200), scan: Duration::from_secs(5) }, &cancel);
        assert!(t1.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn contract_caps_are_3s_and_12s() {
        assert_eq!(ScanCaps::default().adapter, Duration::from_secs(3));
        assert_eq!(ScanCaps::default().scan, Duration::from_secs(12));
    }
}
