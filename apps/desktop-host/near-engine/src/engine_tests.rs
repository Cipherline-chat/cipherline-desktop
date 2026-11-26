//! Engine tests: the real engine(s) against the in-process fake link server, a scripted phone built from
//! cl-near (`testpeer`), the REAL local-network code (TLS 1.3 + exporter + role MAC over loopback, with
//! cl-near's test-only loopback policy) and a fake radio / gate. What none of this proves: a real radio, a
//! real LAN or Windows Firewall, Windows Hello, the real server's throttling or Redis.
use super::engine::*;
use super::fake_server::Fake;
use super::gate::{ApprovalGate, Availability, Verification};
use super::radio::{AdapterState, BleRadio, FakeRadio, ScanCaps};
use super::state::{NearSnapshot, NearState};
use super::testpeer::*;
use super::testpeer::{TestGate, TestIdent};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use cl_near::relay::DeviceKind;
use cl_near::onlink::{InterfaceProvider, LocalInterface, StaticInterfaces};
use ed25519_dalek::Signer;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const SEED_A: &str = "0101010101010101010101010101010101010101010101010101010101010101";
const SEED_N: &str = "0202020202020202020202020202020202020202020202020202020202020202";

struct Host {
    eng: NearEngine,
    hist: Arc<Mutex<Vec<NearSnapshot>>>,
    ident: Arc<TestIdent>,
    gate: Arc<TestGate>,
    skew: Arc<AtomicU64>,
    dir: PathBuf,
}

fn host(fake: &Fake, tmp: &Path, name: &str, seed: &'static str, radio: Arc<dyn BleRadio>, os: Os) -> Host {
    let dir = tmp.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    let hist: Arc<Mutex<Vec<NearSnapshot>>> = Default::default();
    let h2 = hist.clone();
    let _ = fake;
    let (env, ident, gate, skew) = test_env(&dir, name, seed, radio, os, Arc::new(move |s| h2.lock().unwrap().push(s.clone())));
    Host { eng: NearEngine::new(env), hist, ident, gate, skew, dir }
}

fn no_radio() -> Arc<dyn BleRadio> {
    Arc::new(FakeRadio::new(AdapterState::NoAdapter, vec![]))
}

fn wait_for(h: &Host, what: &str, f: impl Fn(&NearSnapshot) -> bool) -> NearSnapshot {
    let end = Instant::now() + Duration::from_secs(40);
    loop {
        let s = h.eng.snapshot();
        if f(&s) {
            return s;
        }
        assert!(Instant::now() < end, "timed out waiting for {what}; last state {:?} err {:?}; history {:?}", s.state, s.error, h.hist.lock().unwrap().iter().map(|x| x.state).collect::<Vec<_>>());
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn states(h: &Host) -> Vec<NearState> {
    let mut v: Vec<NearState> = vec![];
    for s in h.hist.lock().unwrap().iter() {
        if v.last() != Some(&s.state) {
            v.push(s.state);
        }
    }
    v
}
fn auth(dev: &str) -> NearAuth {
    NearAuth { access_token: "tok".into(), user_id: "u1".into(), device_id: dev.into() }
}
fn register_approver(fake: &Fake, dev: &str, seed: &str) {
    fake.st.lock().unwrap().approver_keys.insert(dev.into(), identity_pub_b64(seed));
}
fn base(f: &Fake) -> String {
    f.base()
}
fn approve_calls(f: &Fake) -> usize {
    f.st.lock().unwrap().seen_headers.iter().filter(|(p, _)| p.ends_with("/approve") || p.ends_with("/grant")).count()
}
fn data(n: usize) -> Vec<u8> {
    (0..n).map(|i| (i.wrapping_mul(2654435761) >> 9) as u8).collect()
}

#[derive(Default)]
struct ChanIo {
    code: Mutex<Option<String>>,
    cv: std::sync::Condvar,
    codes: Mutex<Vec<String>>,
    cell: Arc<Mutex<Option<[u8; 16]>>>,
}
impl PeerIo for ChanIo {
    fn publish_code(&self, u: &str) {
        self.codes.lock().unwrap().push(u.into());
        *self.code.lock().unwrap() = Some(u.into());
        self.cv.notify_all();
    }
    fn wait_for_code(&self) -> String {
        let mut g = self.code.lock().unwrap();
        while g.is_none() {
            g = self.cv.wait(g).unwrap();
        }
        g.clone().unwrap()
    }
    fn advertise(&self, u: [u8; 16]) {
        *self.cell.lock().unwrap() = Some(u);
    }
}

fn phone_cfg(f: &Fake, tmp: &Path, ble: bool, lan: bool) -> PhoneCfg {
    PhoneCfg { base: base(f), device_id: "dev-P".into(), seed_hex: SEED_N.into(), ble, lan, approve: true, send_file: None, recv_out: None, drop_after: None, work_dir: tmp.join("phone"), timeout_s: 30, ..Default::default() }
}

fn phone_rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap()
}

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

// ---- pure rules -------------------------------------------------------------------------------------

#[test]
fn listener_rules_phone_listens_desktops_prefer_non_windows_else_a() {
    use cl_near::relay::{Caps, Side};
    let desk = Caps { os: Os::Other, kind: DeviceKind::Desktop, ble_adv: false, ble_scan: true, lan_listen: true, lan_dial: true };
    let phone = Caps { os: Os::Android, kind: DeviceKind::Phone, ble_adv: true, ble_scan: true, lan_listen: true, lan_dial: true };
    assert!(peer_is_phone(&phone) && !peer_is_phone(&desk));
    assert_eq!(lan_listener(&desk, &phone), Some(Side::N), "a phone N listens: the desktop dials out");
    assert_eq!(lan_listener(&phone, &desk), Some(Side::A));
    let win = Caps { os: Os::Windows, ..desk };
    assert_eq!(lan_listener(&desk, &desk), Some(Side::A));
    assert_eq!(lan_listener(&win, &win), Some(Side::A));
    assert_eq!(lan_listener(&desk, &win), Some(Side::A));
    assert_eq!(lan_listener(&win, &desk), Some(Side::N), "11.6: the non-Windows side listens");
    let mut cant = desk;
    cant.lan_listen = false;
    assert_eq!(lan_listener(&cant, &desk), Some(Side::N), "a side that cannot listen hands over");
    cant.lan_dial = false;
    assert_eq!(lan_listener(&cant, &desk), None);
    // and it agrees with cl-near's own plan wherever the OS rule does not apply
    for (a, n) in [(desk, phone), (phone, desk), (desk, desk)] {
        assert_eq!(lan_listener(&a, &n), cl_near::ble::plan(&a, &n, false).lan.map(|l| l.listener));
    }
}

// ---- desktop to desktop over the real local-network code ----------------------------------------------

#[test]
fn desktop_to_desktop_qr_lan_approve_and_transfer() {
    let (fake, t) = (Fake::start(), tmp());
    register_approver(&fake, "dev-A", SEED_A);
    let n = host(&fake, t.path(), "new", SEED_N, no_radio(), Os::Windows);
    let a = host(&fake, t.path(), "appr", SEED_A, no_radio(), Os::Windows);
    n.eng.show_start(base(&fake), false, None).unwrap();
    let shown = wait_for(&n, "code", |s| s.code.is_some());
    assert!(shown.code.as_ref().unwrap().typed.is_none());
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(shown.code.unwrap().uri)).unwrap();
    let sheet = wait_for(&a, "approval sheet", |s| s.state == NearState::AwaitingApproval);
    assert_eq!(sheet.proximity, Some("lan"));
    assert_eq!(sheet.peer.as_ref().unwrap().label, "new PC");
    wait_for(&n, "N awaiting", |s| s.state == NearState::AwaitingApproval);
    assert_eq!(a.eng.approve(), ApproveOutcome::Approved("hello"));
    let done = wait_for(&n, "grant", |s| s.state == NearState::Approved);
    // the grant opens with the key the new device registered, through the bridge's own session
    let (lid, kpriv, kpub) = n.ident.installed.lock().unwrap().last().unwrap().clone();
    let g = cl_crypto::link::open_link_grant(done.envelope_b64.as_ref().unwrap(), &kpriv, &kpub, &lid).unwrap();
    assert_eq!(g.user_id, "u1");
    // the fake verified the REAL Ed25519 signature over the v2 string, `lan` included
    assert_eq!(fake.st.lock().unwrap().sessions[&lid].approved_proximity.as_deref(), Some("lan"));
    // transfer (6 MiB: one part, several frames)
    let src = t.path().join("history.container");
    let bytes = data(6 * 1024 * 1024 + 77);
    std::fs::write(&src, &bytes).unwrap();
    n.eng.transfer_receive().unwrap();
    a.eng.transfer_send(src.display().to_string()).unwrap();
    wait_for(&a, "send done", |s| s.state == NearState::Done);
    wait_for(&n, "receive done", |s| s.state == NearState::Done);
    let r = n.eng.transfer_result().unwrap();
    assert_eq!(std::fs::read(&r.path).unwrap(), bytes);
    assert_eq!(r.size, bytes.len() as u64);
    assert!(states(&a).windows(2).all(|w| w[0].may_go_for_test(w[1])));
}

trait MayGo {
    fn may_go_for_test(self, to: NearState) -> bool;
}
impl MayGo for NearState {
    fn may_go_for_test(self, to: NearState) -> bool {
        self == to || self.may_go(to)
    }
}

#[test]
fn typed_code_sloppy_input_resolves_and_a_wrong_one_is_refused() {
    let (fake, t) = (Fake::start(), tmp());
    register_approver(&fake, "dev-A", SEED_A);
    let n = host(&fake, t.path(), "new", SEED_N, no_radio(), Os::Windows);
    let a = host(&fake, t.path(), "appr", SEED_A, no_radio(), Os::Windows);
    n.eng.show_start(base(&fake), true, Some("  Laptop\u{202e} ".into())).unwrap();
    let shown = wait_for(&n, "typed code", |s| s.code.as_ref().is_some_and(|c| c.typed.is_some()));
    let typed = shown.code.unwrap().typed.unwrap();
    assert_eq!(typed.len(), 9);
    // wrong code first (a different valid-looking code)
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Typed("0000-0000".into())).unwrap();
    let f = wait_for(&a, "wrong code", |s| s.state == NearState::Failed);
    assert_eq!(f.error.unwrap().code, "link_near_code_unknown");
    // sloppy input of the right one: lower case, a dot and a space instead of the hyphen
    let sloppy = typed.to_lowercase().replace('-', " · ");
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Typed(sloppy)).unwrap();
    let s = wait_for(&a, "sheet", |s| s.state == NearState::AwaitingApproval);
    assert_eq!(s.peer.unwrap().label, "Laptop", "control and bidi characters are stripped from the label");
    assert_eq!(a.eng.approve(), ApproveOutcome::Approved("hello"));
    wait_for(&n, "granted", |s| s.state == NearState::Approved);
}

#[test]
fn bad_code_kinds_are_refused_before_any_network_call() {
    let (fake, t) = (Fake::start(), tmp());
    let a = host(&fake, t.path(), "appr", SEED_A, no_radio(), Os::Windows);
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr("https://evil.example".into())).unwrap();
    assert_eq!(wait_for(&a, "bad", |s| s.state == NearState::Failed).error.unwrap().code, "bad_code");
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(format!("cipherline://near-invite/1?i={}&s=AAAAAAAAAAAAAAAAAAAAAA", cl_near::code::new_link_id()))).unwrap();
    assert_eq!(wait_for(&a, "invite", |s| s.state == NearState::Failed).error.unwrap().code, "wrong_code_kind");
    assert!(fake.st.lock().unwrap().seen_headers.is_empty());
}

// ---- Bluetooth, probe, refusal ---------------------------------------------------------------------------

#[test]
fn bluetooth_proof_then_lan_probe_offers_transfer_and_survives_a_dropped_connection() {
    let (fake, t) = (Fake::start(), tmp());
    register_approver(&fake, "dev-A", SEED_A);
    let io = Arc::new(ChanIo::default());
    let radio: Arc<dyn BleRadio> = Arc::new(CellRadio { state: AdapterState::Ready, cell: io.cell.clone() });
    let a = host(&fake, t.path(), "appr", SEED_A, radio, Os::Windows);
    let out = t.path().join("phone-received.container");
    let mut cfg = phone_cfg(&fake, t.path(), true, true);
    cfg.recv_out = Some(out.clone());
    cfg.drop_after = Some(3_000_000);
    let rt = phone_rt();
    let (io2, skew) = (io.clone(), Arc::new(AtomicU64::new(0)));
    let phone = rt.spawn(phone_new_device(cfg, io2, skew));
    let uri = io.wait_for_code();
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(uri)).unwrap();
    let sheet = wait_for(&a, "sheet", |s| s.state == NearState::AwaitingApproval);
    assert_eq!(sheet.proximity, Some("ble"), "Bluetooth is tried first and counts");
    assert_eq!(sheet.history_allowed, Some(true), "a Bluetooth proof may offer the history at approval");
    // F9 (d): the sheet is up BEFORE the approver starts its local-network leg; the probe then flips `transfer_offerable`
    assert_eq!(sheet.transfer_offerable, Some(false), "the probe has not finished when the sheet first shows");
    wait_for(&a, "the probe found a path", |s| s.transfer_offerable == Some(true));
    assert_eq!(a.eng.approve(), ApproveOutcome::Approved("hello"));
    let src = t.path().join("h.container");
    let bytes = data(40 * 1024 * 1024 + 5);
    std::fs::write(&src, &bytes).unwrap();
    a.eng.transfer_send(src.display().to_string()).unwrap();
    wait_for(&a, "sent", |s| s.state == NearState::Done);
    let rep = rt.block_on(phone).unwrap();
    assert!(rep.error.is_none(), "{rep:?}");
    assert!(rep.granted);
    assert!(rep.attempts >= 2, "the forced drop was resumed on a NEW connection: {rep:?}");
    assert_eq!(rep.transfer_bytes, bytes.len() as u64);
    assert_eq!(rep.transfer_sha256.unwrap(), sha_file(&src));
    let seen = states(&a);
    assert!(seen.contains(&NearState::ProvingBle) && seen.contains(&NearState::TransferPaused), "{seen:?}");
    assert!(!seen.contains(&NearState::ProvingLan), "after a Bluetooth proof the approver does not enter the LAN stage before its sheet: {seen:?}");
    assert_eq!(fake.st.lock().unwrap().sessions.values().next().unwrap().approved_proximity.as_deref(), Some("ble"));
}

#[test]
fn refusal_when_neither_proof_exists_and_the_server_never_sees_an_approve() {
    let (fake, t) = (Fake::start(), tmp());
    register_approver(&fake, "dev-A", SEED_A);
    let io = Arc::new(ChanIo::default());
    let a = host(&fake, t.path(), "appr", SEED_A, Arc::new(FakeRadio::new(AdapterState::RadioOff, vec![])), Os::Windows);
    let rt = phone_rt();
    let phone = rt.spawn(phone_new_device(phone_cfg(&fake, t.path(), true, false), io.clone(), Arc::new(AtomicU64::new(0))));
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(io.wait_for_code())).unwrap();
    let r = wait_for(&a, "refused", |s| s.state == NearState::Refused);
    assert_eq!(r.error.unwrap().code, "no_proximity");
    assert_eq!(r.refusal.unwrap(), super::state::NearRefusal { ble: "off", lan: "skipped" }, "per-proof causes for the refusal screen");
    // a hello without a proof is all that ever happened: approve/transfer are unreachable
    assert!(matches!(a.eng.approve(), ApproveOutcome::Failed(..)));
    assert!(a.eng.transfer_send(t.path().display().to_string()).is_err());
    assert_eq!(approve_calls(&fake), 0, "no approve or grant ever reached the server");
    assert_eq!(rt.block_on(phone).unwrap().refused.as_deref(), Some("no_proximity"));
}

#[test]
fn a_foreign_advertisement_and_a_silent_lan_do_not_become_a_proof() {
    let (fake, t) = (Fake::start(), tmp());
    let cell = Arc::new(Mutex::new(Some([9u8; 16]))); // someone else's UUID, always on air
    let a = host(&fake, t.path(), "appr", SEED_A, Arc::new(CellRadio { state: AdapterState::Ready, cell }), Os::Windows);
    let io = Arc::new(ChanIo::default());
    let rt = phone_rt();
    let mut cfg = phone_cfg(&fake, t.path(), false, false);
    cfg.ble = false;
    let _phone = rt.spawn(phone_new_device(cfg, io.clone(), Arc::new(AtomicU64::new(0))));
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(io.wait_for_code())).unwrap();
    let r = wait_for(&a, "refused", |s| s.state == NearState::Refused);
    assert_eq!(r.refusal.unwrap().lan, "skipped");
    assert_eq!(approve_calls(&fake), 0);
}

// ---- codes: wrong, rotated, re-opened ---------------------------------------------------------------------

#[test]
fn wrong_secret_times_out_and_the_previous_rotation_is_still_accepted_but_not_the_one_before() {
    let (fake, t) = (Fake::start(), tmp());
    register_approver(&fake, "dev-A", SEED_A);
    let rt = phone_rt();
    for (rotations, expect_ok, tamper) in [(0u64, true, false), (1, true, false), (2, false, false), (0, false, true)] {
        let io = Arc::new(ChanIo::default());
        let skew = Arc::new(AtomicU64::new(0));
        let a = host(&fake, t.path(), &format!("appr{rotations}{tamper}"), SEED_A, no_radio(), Os::Windows);
        let mut cfg = phone_cfg(&fake, t.path(), false, true);
        cfg.work_dir = t.path().join(format!("ph{rotations}{tamper}"));
        let ph = rt.spawn(phone_new_device(cfg, io.clone(), skew.clone()));
        let mut uri = io.wait_for_code();
        if tamper {
            // change one character inside the secret part of the compact code: a different secret, same shape
            let mut c: Vec<char> = uri.chars().collect();
            let i = c.len() - 12;
            c[i] = if c[i] == 'A' { 'B' } else { 'A' };
            uri = c.into_iter().collect();
        }
        if rotations > 0 {
            // the phone rotates its on-screen secret every 30 s of ITS clock
            for _ in 0..rotations {
                skew.fetch_add(31_000, std::sync::atomic::Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(400));
            }
            assert_eq!(io.codes.lock().unwrap().len() as u64, 1 + rotations, "the shown code changed on every rotation");
        }
        a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(uri)).unwrap();
        if expect_ok {
            wait_for(&a, "sheet", |s| s.state == NearState::AwaitingApproval || s.state == NearState::Refused);
            let _ = a.eng.approve();
        } else {
            let f = wait_for(&a, "failed", |s| s.state == NearState::Failed);
            assert!(["hello_timeout", "bad_code"].contains(&f.error.unwrap().code.as_str()));
        }
        a.eng.cancel();
        ph.abort();
    }
}

#[test]
fn new_device_rotates_the_secret_and_reopens_the_session_keeping_the_old_one_alive() {
    let (fake, t) = (Fake::start(), tmp());
    let n = host(&fake, t.path(), "new", SEED_N, no_radio(), Os::Windows);
    n.eng.show_start(base(&fake), true, None).unwrap();
    let s0 = wait_for(&n, "first code", |s| s.code.is_some());
    let (uri0, typed0, link0) = (s0.code.as_ref().unwrap().uri.clone(), s0.code.as_ref().unwrap().typed.clone().unwrap(), s0.link_id.clone().unwrap());
    n.skew.fetch_add(31_000, std::sync::atomic::Ordering::SeqCst);
    let s1 = wait_for(&n, "rotated", |s| s.code.as_ref().is_some_and(|c| c.uri != uri0));
    assert_eq!(s1.link_id.as_deref(), Some(link0.as_str()), "30 s rotation keeps the SAME session");
    assert_eq!(s1.code.as_ref().unwrap().typed.as_deref(), Some(typed0.as_str()), "the typed code does not rotate with the symbol (11.1)");
    n.skew.fetch_add(80_000, std::sync::atomic::Ordering::SeqCst); // 111 s: inside the re-open margin
    let s2 = wait_for(&n, "reopened", |s| s.link_id.as_deref() != Some(link0.as_str()));
    assert_ne!(s2.code.as_ref().unwrap().typed.as_deref(), Some(typed0.as_str()), "a new session has a new typed code");
    assert_eq!(fake.st.lock().unwrap().sessions.len(), 2, "the previous session stays alive so a code read a moment ago still resolves");
    // cancelling tears every session down
    n.eng.cancel();
    wait_for(&n, "cancelled", |s| s.state == NearState::Cancelled);
    let end = Instant::now() + Duration::from_secs(5);
    while !fake.st.lock().unwrap().sessions.is_empty() {
        assert!(Instant::now() < end, "sessions were not destroyed");
        std::thread::sleep(Duration::from_millis(50));
    }
}

// ---- approval paths -----------------------------------------------------------------------------------------

#[test]
fn gate_cancel_returns_to_the_screen_then_approval_works_and_deny_reaches_the_new_device() {
    let (fake, t) = (Fake::start(), tmp());
    register_approver(&fake, "dev-A", SEED_A);
    let n = host(&fake, t.path(), "new", SEED_N, no_radio(), Os::Windows);
    let a = host(&fake, t.path(), "appr", SEED_A, no_radio(), Os::Windows);
    n.eng.show_start(base(&fake), false, None).unwrap();
    let uri = wait_for(&n, "code", |s| s.code.is_some()).code.unwrap().uri;
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(uri)).unwrap();
    wait_for(&a, "sheet", |s| s.state == NearState::AwaitingApproval);
    *a.gate.next.lock().unwrap() = Verification::Cancelled;
    assert_eq!(a.eng.approve(), ApproveOutcome::Cancelled("hello"));
    assert_eq!(a.eng.snapshot().state, NearState::AwaitingApproval);
    assert_eq!(approve_calls(&fake), 0, "a cancelled biometric never reaches the server");
    // the user then declines
    a.eng.refuse();
    wait_for(&a, "A cancelled", |s| s.state == NearState::Cancelled);
    let r = wait_for(&n, "N refused", |s| s.state == NearState::Refused);
    assert_eq!(r.error.unwrap().code, "denied");
}

#[test]
fn a_second_approved_device_gets_link_already_scanning() {
    let (fake, t) = (Fake::start(), tmp());
    register_approver(&fake, "dev-A", SEED_A);
    let n = host(&fake, t.path(), "new", SEED_N, no_radio(), Os::Windows);
    let a = host(&fake, t.path(), "appr", SEED_A, no_radio(), Os::Windows);
    let b = host(&fake, t.path(), "second", SEED_A, no_radio(), Os::Windows);
    n.eng.show_start(base(&fake), false, None).unwrap();
    let uri = wait_for(&n, "code", |s| s.code.is_some()).code.unwrap().uri;
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(uri.clone())).unwrap();
    wait_for(&a, "sheet", |s| s.state == NearState::AwaitingApproval);
    b.eng.approver_start(base(&fake), auth("dev-B"), ScanInput::Qr(uri)).unwrap();
    assert_eq!(wait_for(&b, "409", |s| s.state == NearState::Failed).error.unwrap().code, "link_already_scanning");
}

#[test]
fn the_approval_sheet_notices_the_session_ending() {
    let (fake, t) = (Fake::start(), tmp());
    let n = host(&fake, t.path(), "new", SEED_N, no_radio(), Os::Windows);
    let a = host(&fake, t.path(), "appr", SEED_A, no_radio(), Os::Windows);
    n.eng.show_start(base(&fake), false, None).unwrap();
    let uri = wait_for(&n, "code", |s| s.code.is_some()).code.unwrap().uri;
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(uri)).unwrap();
    wait_for(&a, "sheet", |s| s.state == NearState::AwaitingApproval);
    fake.advance(400); // beyond the 300 s cap the server enforces
    wait_for(&a, "expired", |s| s.state == NearState::Expired);
}

#[test]
fn invite_flow_a_phone_scans_the_desktops_invite() {
    // the scripted phone joins the invite as the new device: same relay, A is the invite owner
    let (fake, t) = (Fake::start(), tmp());
    register_approver(&fake, "dev-A", SEED_A);
    let a = host(&fake, t.path(), "appr", SEED_A, no_radio(), Os::Windows);
    a.eng.invite_start(base(&fake), auth("dev-A")).unwrap();
    let shown = wait_for(&a, "invite code", |s| s.code.is_some());
    let uri = shown.code.unwrap().uri;
    assert!(uri.starts_with("CLN1:"), "screens draw the compact form (contract 11.14)");
    let cl_near::code::NearPayload::Invite(inv) = cl_near::code::parse(&uri).unwrap() else { panic!("an invite") };
    // phone-as-N: join with its ek, then accept hello with the scanned secret
    let token = Arc::new(super::api::RelayToken::generate());
    let api = super::api::LinkApi::new(&base(&fake), None, None, "9.9.9").unwrap().with_relay_token(token.clone());
    let (ek_priv, en_pub) = cl_near::keys::generate_keypair();
    let ik: [u8; 32] = B64.decode(identity_pub_b64(SEED_N)).unwrap().try_into().unwrap();
    let body = serde_json::json!({ "ek_pub_b64": B64.encode(en_pub), "device_label": "Phone", "platform": "ios", "identity_key_pub_b64": identity_pub_b64(SEED_N), "near": true, "relay_auth_b64": token.auth_hash_b64() });
    api.join_invite_for_tests(&inv.invite_id, body).unwrap();
    let rt = phone_rt();
    let (api2, id, secret) = (api.clone(), inv.invite_id.clone(), inv.secret.clone());
    let peer = rt.block_on(async move {
        let t = super::api::HttpRelay::new(&api2, cl_near::relay::Side::N, &id);
        cl_near::relay::RelayPeer::new_device_accept(t, &id, &ek_priv, &ik, move || vec![secret.clone()], Duration::from_secs(10)).await
    });
    let mut peer = peer.expect("the desktop's hello verified under the scanned secret");
    // it asks for our caps next: answer, then the desktop (no BLE, no LAN peer) refuses with no_proximity
    let m = rt.block_on(peer.recv(Duration::from_secs(5))).unwrap();
    assert!(matches!(m, cl_near::relay::Message::Caps { .. }));
    rt.block_on(peer.send(&cl_near::relay::Message::caps(&cl_near::relay::Caps::default()))).unwrap();
    let r = wait_for(&a, "refused", |s| s.state == NearState::Refused);
    assert_eq!(r.error.unwrap().code, "no_proximity");
    assert_eq!(approve_calls(&fake), 0);
}

#[test]
fn cancel_while_waiting_for_hello_ends_cleanly() {
    let (fake, t) = (Fake::start(), tmp());
    let n = host(&fake, t.path(), "new", SEED_N, no_radio(), Os::Windows);
    n.eng.show_start(base(&fake), false, None).unwrap();
    wait_for(&n, "code", |s| s.code.is_some());
    n.eng.cancel();
    wait_for(&n, "cancelled", |s| s.state == NearState::Cancelled);
    assert!(n.eng.show_start(base(&fake), false, None).is_ok(), "a terminal session can be replaced");
    let _ = &n.dir;
}

#[test]
fn typed_input_normalisation_follows_contract_11_1() {
    assert_eq!(normalize_typed("abcd efgh").as_deref(), Some("ABCD-EFGH"));
    assert_eq!(normalize_typed("ABCD·EFGH").as_deref(), Some("ABCD-EFGH"));
    assert_eq!(normalize_typed(" abcd-efgh ").as_deref(), Some("ABCD-EFGH"));
    assert_eq!(normalize_typed("abcdefg"), None);
    assert_eq!(normalize_typed("abcdefghi"), None);
}

// ---- the bridge members ---------------------------------------------------------------------------------------

#[test]
fn dispatch_validates_arguments_and_rejects_wrong_types_without_starting_anything() {
    use super::dispatch::call;
    use serde_json::json;
    let (fake, t) = (Fake::start(), tmp());
    let h = host(&fake, t.path(), "x", SEED_A, no_radio(), Os::Windows);
    let bad = |a: &str, v: serde_json::Value| assert!(call(&h.eng, a, &[v]).unwrap().is_err(), "{a}");
    bad("nearShowStart", json!({ "apiBase": "http://127.0.0.1:1", "mode": "both" }));
    bad("nearShowStart", json!({ "apiBase": 5, "mode": "qr" }));
    bad("nearApproverStart", json!({ "apiBase": "x", "scan": { "kind": "qr", "text": "t" } })); // no auth
    bad("nearApproverStart", json!({ "apiBase": "x", "auth": { "accessToken": "t", "userId": "u", "deviceId": "d" }, "scan": { "kind": "camera" } }));
    bad("nearTransferSend", json!({ "path": 5 }));
    bad("nearBiometricVerify", json!(""));
    assert!(call(&h.eng, "notNear", &[]).is_none());
    assert_eq!(h.eng.snapshot().state, NearState::Idle, "nothing started");
    let p = call(&h.eng, "nearProbe", &[]).unwrap().unwrap();
    assert_eq!((p["available"].clone(), p["bluetooth"].clone(), p["gate"].clone()), (json!(true), json!("no_adapter"), json!("hello")));
    assert_eq!(call(&h.eng, "nearTransferResult", &[]).unwrap().unwrap(), serde_json::Value::Null);
    // the snapshot serialises as the TS types declare
    let s = call(&h.eng, "nearGetState", &[]).unwrap().unwrap();
    assert_eq!((s["state"].clone(), s["role"].clone()), (json!("idle"), serde_json::Value::Null));
}

#[test]
fn a_proof_is_a_type_the_engine_cannot_forge() {
    use cl_near::approval::{link_approve_message_v2, Proximity};
    use cl_near::proof::ProximityProof;
    // the only things that mint a ProximityProof are a verified Bluetooth exchange or an authenticated TLS
    // connection (outside `cfg(test)` there is no other constructor), and both gated operations demand one:
    let ble = ProximityProof::for_tests(Proximity::Ble, "linkA");
    assert!(link_approve_message_v2("u", "d", "linkB", "k", &ble, 1).is_err(), "a proof for another session signs nothing");
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        use cl_near::conn::{Conn, ConnConfig};
        use cl_near::testutil::SyntheticSource;
        use cl_near::transfer::{run_sender, TransferOpts};
        let (a, _b) = tokio::io::duplex(1024);
        let mut src = SyntheticSource::new(1, 10, 1);
        let r = run_sender(Conn::new(a, ConnConfig::default()), &ble, &mut src, &TransferOpts::default()).await;
        assert!(matches!(r, Err(cl_near::error::NearError::NoProof(_))), "a Bluetooth proof never opens a transfer");
    });
}

// ---- contract v1.1: sealed label, status, ble_result, probe, abort in every state, throttling ----------------------

fn epoch_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Host = NEW device, scripted phone = approver that LISTENS (a phone listens) and proves over the local network.
fn host_new_device_with_phone_approver(fake: &Fake, t: &Path, mut cfg: PhoneCfg) -> (Host, tokio::task::JoinHandle<PhoneReport>, tokio::runtime::Runtime) {
    cfg.base = base(fake);
    let n = host(fake, t, "new", SEED_N, no_radio(), Os::Windows);
    n.eng.show_start(base(fake), false, Some("My laptop".into())).unwrap();
    let uri = wait_for(&n, "code", |s| s.code.is_some()).code.unwrap().uri;
    assert!(uri.starts_with("CLN1:"), "the symbol carries the compact form");
    let io = Arc::new(ChanIo::default());
    *io.code.lock().unwrap() = Some(uri);
    let rt = phone_rt();
    let ph = rt.spawn(phone_approver(cfg, io));
    (n, ph, rt)
}

#[test]
fn a_relay_only_deny_reaches_the_waiting_new_device_within_one_poll_and_the_relay_load_stays_far_under_the_bucket() {
    // Contract 11.16: the phone refuses ONLY on the relay (no server `deny`), after the new device has been waiting on the
    // approval sheet for 11 s. The new device has to hear it at its next relay poll (idle: 1 s), and over those seconds its
    // relay GETs must stay far below the real server's 100 per 10 s (the 20 req/s regression).
    let (fake, t) = (Fake::start(), tmp());
    let mut cfg = phone_cfg(&fake, t.path(), false, true);
    cfg.approve = false;
    cfg.decision = "deny_relay".into();
    cfg.hold_ms = 11_000;
    let (n, ph, rt) = host_new_device_with_phone_approver(&fake, t.path(), cfg);
    let waiting = wait_for(&n, "awaiting with the phone's status", |s| s.state == NearState::AwaitingApproval && s.peer_status.as_ref().is_some_and(|p| p.stage == "awaiting_user"));
    assert_eq!(waiting.peer.as_ref().unwrap().label, "Test Phone", "the phone's SEALED label, not a server-relayed one");
    assert!(waiting.peer.as_ref().unwrap().label_sealed);
    assert_eq!(waiting.proximity, Some("lan"), "the proof line: which proof held, from the approver's `status`");
    let t0 = Instant::now();
    let refused = wait_for(&n, "refused", |s| s.state == NearState::Refused);
    let rep = rt.block_on(ph).unwrap();
    let seen = epoch_ms();
    let sent = rep.refuse_sent_ms.expect("the phone refused");
    assert_eq!(refused.error.unwrap().code, "denied");
    assert!(seen.saturating_sub(sent) <= 1700, "the denial took {} ms to show (one idle relay poll is 1 s)", seen.saturating_sub(sent));
    assert!(t0.elapsed() > Duration::from_secs(8), "it really waited on the sheet first");
    // relay load: per caller, in ANY 10 s window of that wait
    let st = fake.st.lock().unwrap();
    for side in ['a', 'n'] {
        let ts: Vec<Instant> = st.relay_gets.iter().filter(|(_, s)| *s == side).map(|(t, _)| *t).collect();
        let worst = ts.iter().map(|a| ts.iter().filter(|b| **b >= *a && b.duration_since(*a) < Duration::from_secs(10)).count()).max().unwrap_or(0);
        eprintln!("relay GETs, side {side}: worst 10 s window {worst} of the real bucket's 100");
        if worst > 50 { let t0 = ts[0]; eprintln!("side {side} offsets ms: {:?}", ts.iter().map(|t| t.duration_since(t0).as_millis()).collect::<Vec<_>>()); }
        assert!(worst <= 50, "side {side}: {worst} relay GETs in a 10 s window (real bucket: 100, headroom asked for: half)");
        if side == 'n' {
            assert!(ts.len() >= 5, "the waiting new device still polls");
        }
    }
    assert_eq!(st.throttled, 0);
}

#[test]
fn a_cancel_on_the_relay_reaches_the_waiting_new_device_as_the_other_device_cancelling() {
    let (fake, t) = (Fake::start(), tmp());
    let mut cfg = phone_cfg(&fake, t.path(), false, true);
    cfg.approve = false;
    cfg.decision = "cancel_relay".into();
    cfg.hold_ms = 1500;
    let (n, ph, rt) = host_new_device_with_phone_approver(&fake, t.path(), cfg);
    let c = wait_for(&n, "cancelled by the other device", |s| s.state == NearState::Cancelled);
    assert_eq!(c.error.unwrap().code, "peer_cancelled");
    let _ = rt.block_on(ph);
}

#[test]
fn the_new_device_shows_which_proof_is_tried_and_which_held_and_the_phone_sees_ble_result_and_the_probe() {
    // phone = approver that advertises (Bluetooth proof, verified by the phone), host = new device that scans.
    let (fake, t) = (Fake::start(), tmp());
    let io = Arc::new(ChanIo::default());
    let radio: Arc<dyn BleRadio> = Arc::new(CellRadio { state: AdapterState::Ready, cell: io.cell.clone() });
    let n = host(&fake, t.path(), "new", SEED_N, radio, Os::Windows);
    n.eng.show_start(base(&fake), false, None).unwrap();
    *io.code.lock().unwrap() = Some(wait_for(&n, "code", |s| s.code.is_some()).code.unwrap().uri);
    let mut cfg = phone_cfg(&fake, t.path(), true, true);
    cfg.hold_ms = 1500;
    cfg.label = "Dawson's phone".into();
    let rt = phone_rt();
    let ph = rt.spawn(phone_approver(cfg, io.clone()));
    let waiting = wait_for(&n, "awaiting_user", |s| s.state == NearState::AwaitingApproval && s.peer_status.as_ref().is_some_and(|p| p.stage == "awaiting_user"));
    assert_eq!(waiting.proximity, Some("ble"), "proof_ok{{ble}} from the approver");
    assert_eq!(waiting.peer.as_ref().unwrap().label, "Dawson's phone");
    wait_for(&n, "granted", |s| s.state == NearState::Approved);
    let rep = rt.block_on(ph).unwrap();
    assert!(rep.error.is_none(), "{rep:?}");
    assert_eq!(rep.peer_label.as_deref(), Some("new PC"), "the phone names the host by its sealed label too");
    assert_eq!(rep.proximity.as_deref(), Some("ble"));
    // the history of what the new device was told, in order
    let told: Vec<(String, Option<&'static str>)> = n.hist.lock().unwrap().iter().filter_map(|s| s.peer_status.as_ref().map(|p| (p.stage.to_owned(), p.proximity))).fold(vec![], |mut v, x| { if v.last() != Some(&x) { v.push(x); } v });
    let stages: Vec<&str> = told.iter().map(|(s, _)| s.as_str()).collect();
    assert_eq!(stages, ["checking_ble", "proof_ok", "checking_lan", "awaiting_user"], "{told:?}");
    assert_eq!(told[1].1, Some("ble"));
}

#[test]
fn the_phone_sees_the_hosts_status_ble_result_and_a_transfer_probe_marked_as_such() {
    // host = approver (scans the phone's advertisement), phone = new device
    let (fake, t) = (Fake::start(), tmp());
    register_approver(&fake, "dev-A", SEED_A);
    let io = Arc::new(ChanIo::default());
    let radio: Arc<dyn BleRadio> = Arc::new(CellRadio { state: AdapterState::Ready, cell: io.cell.clone() });
    let a = host(&fake, t.path(), "appr", SEED_A, radio, Os::Windows);
    let rt = phone_rt();
    let ph = rt.spawn(phone_new_device(phone_cfg(&fake, t.path(), true, true), io.clone(), Arc::new(AtomicU64::new(0))));
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(io.wait_for_code())).unwrap();
    wait_for(&a, "sheet", |s| s.state == NearState::AwaitingApproval);
    wait_for(&a, "the probe after the sheet", |s| s.transfer_offerable == Some(true));
    assert_eq!(a.eng.approve(), ApproveOutcome::Approved("hello"));
    let rep = rt.block_on(ph).unwrap();
    assert!(rep.error.is_none(), "{rep:?}");
    assert_eq!(rep.ble_result.as_deref(), Some("ok"));
    assert_eq!(rep.probe_result, Some(true), "lan_result {{ purpose: transfer_probe }}");
    assert_eq!(rep.peer_label.as_deref(), Some("appr PC"));
    assert_eq!(rep.statuses, ["checking_ble", "proof_ok:ble", "awaiting_user", "checking_lan"], "F9 (d): the sheet (awaiting_user) comes before the local-network leg");
}

#[test]
fn a_failed_transfer_probe_is_not_a_refusal() {
    // Bluetooth proves; the phone then does not answer on the local network: still approvable, transfer not offered.
    let (fake, t) = (Fake::start(), tmp());
    register_approver(&fake, "dev-A", SEED_A);
    let io = Arc::new(ChanIo::default());
    let radio: Arc<dyn BleRadio> = Arc::new(CellRadio { state: AdapterState::Ready, cell: io.cell.clone() });
    let mut a = host(&fake, t.path(), "appr", SEED_A, radio, Os::Windows);
    let _ = &mut a;
    let rt = phone_rt();
    let _ph = rt.spawn(phone_new_device(phone_cfg(&fake, t.path(), true, false), io.clone(), Arc::new(AtomicU64::new(0))));
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(io.wait_for_code())).unwrap();
    let sheet = wait_for(&a, "sheet", |s| s.state == NearState::AwaitingApproval);
    assert_eq!(sheet.proximity, Some("ble"));
    assert_eq!(sheet.transfer_offerable, Some(false));
    assert_eq!(a.eng.approve(), ApproveOutcome::Approved("hello"));
}

#[test]
fn no_proximity_carries_the_same_causes_to_both_screens() {
    // phone (approver) finds nothing: it sends abort { no_proximity, ble, lan }; the host (new device) shows exactly those.
    let (fake, t) = (Fake::start(), tmp());
    let cfg = phone_cfg(&fake, t.path(), false, false); // a phone with neither proof available
    let (n, ph, rt) = host_new_device_with_phone_approver(&fake, t.path(), cfg);
    let r = wait_for(&n, "refused", |s| s.state == NearState::Refused);
    assert_eq!(r.error.unwrap().code, "no_proximity");
    assert_eq!(r.refusal.unwrap(), super::state::NearRefusal { ble: "skipped", lan: "skipped" });
    let _ = rt.block_on(ph);
}

#[test]
fn caps_without_a_device_kind_end_the_session_with_an_error_abort() {
    let (fake, t) = (Fake::start(), tmp());
    register_approver(&fake, "dev-A", SEED_A);
    let io = Arc::new(ChanIo::default());
    let a = host(&fake, t.path(), "appr", SEED_A, no_radio(), Os::Windows);
    let rt = phone_rt();
    let mut cfg = phone_cfg(&fake, t.path(), false, true);
    cfg.omit_kind = true;
    let ph = rt.spawn(phone_new_device(cfg, io.clone(), Arc::new(AtomicU64::new(0))));
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(io.wait_for_code())).unwrap();
    let f = wait_for(&a, "failed", |s| s.state == NearState::Failed);
    assert_eq!(f.error.unwrap().code, "bad_caps");
    assert_eq!(approve_calls(&fake), 0);
    assert_eq!(rt.block_on(ph).unwrap().refused.as_deref(), Some("error"), "the peer is told `error`");
}

#[test]
fn the_new_device_cancelling_reaches_the_approvers_sheet_at_once() {
    let (fake, t) = (Fake::start(), tmp());
    register_approver(&fake, "dev-A", SEED_A);
    let n = host(&fake, t.path(), "new", SEED_N, no_radio(), Os::Windows);
    let a = host(&fake, t.path(), "appr", SEED_A, no_radio(), Os::Windows);
    n.eng.show_start(base(&fake), false, None).unwrap();
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(wait_for(&n, "code", |s| s.code.is_some()).code.unwrap().uri)).unwrap();
    wait_for(&a, "sheet", |s| s.state == NearState::AwaitingApproval);
    wait_for(&n, "N awaiting", |s| s.state == NearState::AwaitingApproval);
    n.eng.cancel();
    let c = wait_for(&a, "A sees it", |s| s.state == NearState::Cancelled);
    assert_eq!(c.error.unwrap().code, "peer_cancelled");
}

#[test]
fn a_throttled_relay_is_back_off_not_failure() {
    // The fake answers 429 + Retry-After once a caller exceeds 3 relay GETs per 2 s; the exchange still completes.
    let (fake, t) = (Fake::start(), tmp());
    {
        let mut st = fake.st.lock().unwrap();
        st.bucket = 3;
        st.window_s = 2;
    }
    register_approver(&fake, "dev-A", SEED_A);
    let n = host(&fake, t.path(), "new", SEED_N, no_radio(), Os::Windows);
    let a = host(&fake, t.path(), "appr", SEED_A, no_radio(), Os::Windows);
    n.eng.show_start(base(&fake), false, None).unwrap();
    // let the new device poll long enough to hit the bucket before the approver arrives
    std::thread::sleep(Duration::from_millis(3500));
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(wait_for(&n, "code", |s| s.code.is_some()).code.unwrap().uri)).unwrap();
    wait_for(&a, "sheet", |s| s.state == NearState::AwaitingApproval);
    assert_eq!(a.eng.approve(), ApproveOutcome::Approved("hello"));
    wait_for(&n, "granted", |s| s.state == NearState::Approved);
    assert!(fake.st.lock().unwrap().throttled > 0, "the bucket really was hit");
}

// ---- pause / resume and "keep what arrived" (contract 11.9, 11.10) -----------------------------------------------------

/// Two desktops, approved, the receiver (new device) ready to receive and the sender about to send `bytes`.
fn approved_pair(fake: &Fake, t: &Path) -> (Host, Host) {
    register_approver(fake, "dev-A", SEED_A);
    let n = host(fake, t, "new", SEED_N, no_radio(), Os::Windows);
    let a = host(fake, t, "appr", SEED_A, no_radio(), Os::Windows);
    n.eng.show_start(base(fake), false, None).unwrap();
    let uri = wait_for(&n, "code", |s| s.code.is_some()).code.unwrap().uri;
    a.eng.approver_start(base(fake), auth("dev-A"), ScanInput::Qr(uri)).unwrap();
    wait_for(&a, "sheet", |s| s.state == NearState::AwaitingApproval);
    assert_eq!(a.eng.approve(), ApproveOutcome::Approved("hello"));
    wait_for(&n, "granted", |s| s.state == NearState::Approved);
    (a, n)
}

#[test]
fn pause_then_resume_finishes_on_a_new_connection_and_the_peer_sees_who_paused() {
    let (fake, t) = (Fake::start(), tmp());
    let (a, n) = approved_pair(&fake, t.path());
    assert!(a.eng.pause_supported());
    let src = t.path().join("h.container");
    let bytes = data(150 * 1024 * 1024 + 9);
    std::fs::write(&src, &bytes).unwrap();
    n.eng.transfer_receive().unwrap();
    a.eng.transfer_send(src.display().to_string()).unwrap();
    wait_for(&a, "sending", |s| s.transfer.as_ref().is_some_and(|t| t.bytes_done > 0));
    a.eng.transfer_pause().unwrap();
    let ps = wait_for(&a, "sender paused", |s| s.state == NearState::TransferPaused && s.transfer.as_ref().is_some_and(|t| t.paused));
    assert_eq!(ps.transfer.as_ref().unwrap().paused_by, Some("me"));
    assert!(!ps.transfer.as_ref().unwrap().interrupted, "a pause is not an interruption");
    let pr = wait_for(&n, "receiver sees the peer's pause", |s| s.state == NearState::TransferPaused && s.transfer.as_ref().is_some_and(|t| t.paused));
    assert_eq!(pr.transfer.as_ref().unwrap().paused_by, Some("peer"));
    std::thread::sleep(Duration::from_millis(800));
    assert_eq!(a.eng.snapshot().state, NearState::TransferPaused, "it stays paused until resumed");
    assert!(a.eng.transfer_resume().is_ok());
    assert!(a.eng.transfer_resume().is_err(), "resume when not paused is refused");
    wait_for(&a, "sent", |s| s.state == NearState::Done);
    wait_for(&n, "received", |s| s.state == NearState::Done);
    let r = n.eng.transfer_result().unwrap();
    assert_eq!(std::fs::read(&r.path).unwrap(), bytes, "byte-identical after pause + resume");
    assert!(n.eng.transfer_pause().is_err(), "nothing to pause once done");
}

#[test]
fn the_receiver_can_pause_too_and_the_sender_waits_without_giving_up() {
    let (fake, t) = (Fake::start(), tmp());
    let (a, n) = approved_pair(&fake, t.path());
    let src = t.path().join("h.container");
    let bytes = data(150 * 1024 * 1024 + 9);
    std::fs::write(&src, &bytes).unwrap();
    n.eng.transfer_receive().unwrap();
    a.eng.transfer_send(src.display().to_string()).unwrap();
    wait_for(&n, "receiving", |s| s.transfer.as_ref().is_some_and(|t| t.bytes_done > 0));
    n.eng.transfer_pause().unwrap();
    let ps = wait_for(&a, "sender sees the peer's pause", |s| s.state == NearState::TransferPaused && s.transfer.as_ref().is_some_and(|t| t.paused));
    assert_eq!(ps.transfer.as_ref().unwrap().paused_by, Some("peer"));
    std::thread::sleep(Duration::from_millis(1500));
    n.eng.transfer_resume().unwrap();
    wait_for(&a, "sent", |s| s.state == NearState::Done);
    wait_for(&n, "received", |s| s.state == NearState::Done);
    assert_eq!(std::fs::read(&n.eng.transfer_result().unwrap().path).unwrap(), bytes);
}

#[test]
fn a_stopped_transfer_can_be_kept_as_the_verified_parts_that_arrived() {
    let (fake, t) = (Fake::start(), tmp());
    let (a, n) = approved_pair(&fake, t.path());
    let src = t.path().join("h.container");
    let bytes = data(150 * 1024 * 1024 + 9);
    std::fs::write(&src, &bytes).unwrap();
    n.eng.transfer_receive().unwrap();
    a.eng.transfer_send(src.display().to_string()).unwrap();
    // wait until a couple of parts are in, then pause, then the user cancels while paused
    wait_for(&n, "two parts", |s| s.transfer.as_ref().is_some_and(|t| t.records_done >= 2));
    n.eng.transfer_pause().unwrap();
    wait_for(&n, "paused", |s| s.state == NearState::TransferPaused && s.transfer.as_ref().is_some_and(|t| t.paused));
    n.eng.cancel();
    let c = wait_for(&n, "stopped", |s| s.state == NearState::Cancelled);
    let p = c.partial.expect("the stopped receive reports what it holds");
    assert!(p.records_held >= 2 && p.records_held < p.records_total, "{p:?}");
    let (path, pf) = n.eng.transfer_keep_partial().unwrap();
    assert_eq!(pf.size, bytes.len() as u64);
    assert_eq!(pf.parts_held, p.records_held);
    let got = std::fs::read(&path).unwrap();
    assert_eq!(got.len(), bytes.len());
    let mut covered = 0u64;
    for (o, l) in &pf.ranges {
        let (o, l) = (*o as usize, *l as usize);
        assert_eq!(&got[o..o + l], &bytes[o..o + l], "every kept byte is the sender's byte");
        covered += l as u64;
    }
    assert_eq!(covered, p.bytes_held);
    assert!(pf.ranges.iter().any(|(o, l)| o + l == bytes.len() as u64), "the LAST part (the container's index) is among the first to arrive");
    assert!(pf.ranges.iter().any(|(o, _)| *o == 0), "and so is the first (its header)");
    // keeping consumed it; a second keep has nothing
    assert!(n.eng.transfer_keep_partial().is_err());
}

#[test]
fn discarding_a_stopped_transfer_removes_what_arrived() {
    let (fake, t) = (Fake::start(), tmp());
    let (a, n) = approved_pair(&fake, t.path());
    let src = t.path().join("h.container");
    std::fs::write(&src, data(100 * 1024 * 1024)).unwrap();
    n.eng.transfer_receive().unwrap();
    a.eng.transfer_send(src.display().to_string()).unwrap();
    wait_for(&n, "a part", |s| s.transfer.as_ref().is_some_and(|t| t.records_done >= 1));
    n.eng.transfer_pause().unwrap();
    wait_for(&n, "paused", |s| s.transfer.as_ref().is_some_and(|t| t.paused));
    n.eng.cancel();
    wait_for(&n, "stopped", |s| s.state == NearState::Cancelled);
    let dir = super::parts::recv_dir(&n.dir);
    assert!(dir.exists());
    n.eng.transfer_discard();
    assert!(std::fs::read_dir(&dir).map(|mut d| d.next().is_none()).unwrap_or(true), "the parts are gone");
    assert!(n.eng.transfer_keep_partial().is_err());
}

#[test]
fn without_the_pause_frame_pause_is_refused_and_never_offered() {
    let (fake, t) = (Fake::start(), tmp());
    register_approver(&fake, "dev-A", SEED_A);
    let dir = t.path().join("np");
    std::fs::create_dir_all(&dir).unwrap();
    let (mut env, ..) = test_env(&dir, "np", SEED_A, no_radio(), Os::Windows, Arc::new(|_| {}));
    env.stop = Arc::new(super::pause::NoPause);
    let eng = NearEngine::new(env);
    assert!(!eng.pause_supported());
    assert!(eng.transfer_pause().is_err());
    let v = super::dispatch::call(&eng, "nearProbe", &[]).unwrap().unwrap();
    assert_eq!(v["pause"], false);
}

// ---- K_xfer (contract 11.15) ---------------------------------------------------------------------------------------

#[test]
fn the_transfer_key_is_released_only_after_approval_matches_on_both_sides_and_is_wiped() {
    let (fake, t) = (Fake::start(), tmp());
    register_approver(&fake, "dev-A", SEED_A);
    let n = host(&fake, t.path(), "new", SEED_N, no_radio(), Os::Windows);
    let a = host(&fake, t.path(), "appr", SEED_A, no_radio(), Os::Windows);
    assert!(a.eng.transfer_key().is_err(), "no session, no key");
    n.eng.show_start(base(&fake), false, None).unwrap();
    let uri = wait_for(&n, "code", |s| s.code.is_some()).code.unwrap().uri;
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(uri)).unwrap();
    wait_for(&a, "sheet", |s| s.state == NearState::AwaitingApproval);
    wait_for(&n, "N awaiting", |s| s.state == NearState::AwaitingApproval);
    assert!(a.eng.transfer_key().is_err() && n.eng.transfer_key().is_err(), "the key is not released before approval");
    assert_eq!(a.eng.approve(), ApproveOutcome::Approved("hello"));
    wait_for(&n, "granted", |s| s.state == NearState::Approved);
    let (ka, kn) = (a.eng.transfer_key().unwrap(), n.eng.transfer_key().unwrap());
    assert_eq!(*ka, *kn, "both devices derive the same K_xfer from the section 2 schedule");
    assert_ne!(*ka, [0u8; 32]);
    // the page reads it through the bridge as base64, and only when allowed
    let v = super::dispatch::call(&a.eng, "nearTransferKey", &[]).unwrap().unwrap();
    assert_eq!(v.as_str().unwrap().len(), 44);
    // discarding wipes the host's copy
    n.eng.transfer_discard();
    assert!(n.eng.transfer_key().is_err());
    // and the sender's copy goes when its send completes
    let src = t.path().join("h.container");
    std::fs::write(&src, data(1024)).unwrap();
    n.eng.transfer_receive().unwrap();
    a.eng.transfer_send(src.display().to_string()).unwrap();
    wait_for(&a, "sent", |s| s.state == NearState::Done);
    assert!(a.eng.transfer_key().is_err(), "the sender's copy is wiped when its send completes");
}

// ---- own-device transfer (contract 7): two engines of one account, `near_*` through a fake E2EE self-fan-out ---------------

struct Router {
    engines: Mutex<std::collections::HashMap<String, Arc<NearEngine>>>,
    log: Mutex<Vec<(String, String, serde_json::Value)>>,
    /// Drop every message of this type (a lossy / hostile channel).
    drop_type: Mutex<Option<String>>,
}
struct RouterSend {
    from: String,
    router: Arc<Router>,
}
impl super::own::OwnSend for RouterSend {
    fn send(&self, to: &str, mut content: serde_json::Value) {
        content["to"] = to.into();
        self.router.log.lock().unwrap().push((self.from.clone(), to.to_owned(), content.clone()));
        if self.router.drop_type.lock().unwrap().as_deref() == content["type"].as_str() {
            return;
        }
        // the page's pipeline verifies author + addressing and hands it over; deliver asynchronously like the network would
        let (router, from, to) = (self.router.clone(), self.from.clone(), to.to_owned());
        std::thread::spawn(move || {
            let eng = router.engines.lock().unwrap().get(&to).cloned();
            if let Some(e) = eng {
                e.own_deliver(content, &from, &to, "Dawson's other PC");
            }
        });
    }
}

struct OwnHost {
    eng: Arc<NearEngine>,
    gate: Arc<TestGate>,
    hist: Arc<Mutex<Vec<NearSnapshot>>>,
}
fn own_host(router: &Arc<Router>, tmp: &Path, name: &str, dev: &str) -> OwnHost {
    let dir = tmp.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    let hist: Arc<Mutex<Vec<NearSnapshot>>> = Default::default();
    let h2 = hist.clone();
    let (mut env, _ident, gate, _skew) = test_env(&dir, name, SEED_A, no_radio(), Os::Windows, Arc::new(move |s| h2.lock().unwrap().push(s.clone())));
    env.own_send = Arc::new(RouterSend { from: dev.to_owned(), router: router.clone() });
    env.own_answer = Duration::from_secs(8);
    let eng = Arc::new(NearEngine::new(env));
    router.engines.lock().unwrap().insert(dev.to_owned(), eng.clone());
    OwnHost { eng, gate, hist }
}
fn router() -> Arc<Router> {
    Arc::new(Router { engines: Default::default(), log: Default::default(), drop_type: Default::default() })
}
fn wait_own(h: &OwnHost, what: &str, f: impl Fn(&NearSnapshot) -> bool) -> NearSnapshot {
    let end = Instant::now() + Duration::from_secs(40);
    loop {
        let s = h.eng.snapshot();
        if f(&s) {
            return s;
        }
        assert!(Instant::now() < end, "timed out waiting for {what}; state {:?} err {:?}", s.state, s.error);
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn own_device_transfer_end_to_end_request_approve_prove_on_the_lan_and_move_the_bytes() {
    let t = tmp();
    let r = router();
    let holder = own_host(&r, t.path(), "holder", "dev-H");
    let asker = own_host(&r, t.path(), "asker", "dev-N");
    asker.eng.own_request("dev-H".into(), "dev-N".into()).unwrap();
    // the holder's person sees the sheet naming the asking device, and nothing moved yet
    let sheet = wait_own(&holder, "the holder's approval sheet", |s| s.role == Some("own_sender") && s.state == NearState::AwaitingApproval);
    assert_eq!(sheet.peer.as_ref().unwrap().label, "Dawson's other PC");
    assert!(holder.eng.transfer_key().is_err() && asker.eng.transfer_key().is_err(), "no key before approval");
    wait_own(&asker, "the asker waits", |s| s.role == Some("own_receiver") && s.state == NearState::AwaitingApproval);
    // approve with the biometric gate
    assert_eq!(holder.eng.approve(), ApproveOutcome::Approved("hello"));
    let got = wait_own(&asker, "the asker is approved", |s| s.state == NearState::Approved);
    assert_eq!(got.role, Some("own_receiver"));
    let sent = wait_own(&holder, "the holder is ready to send", |s| s.state == NearState::Approved && s.proximity == Some("lan"));
    assert_eq!(sent.proximity, Some("lan"), "the proof is the local network only: no Bluetooth in an own-device transfer");
    let (kh, kn) = (holder.eng.transfer_key().unwrap(), asker.eng.transfer_key().unwrap());
    assert_eq!(*kh, *kn, "K_xfer matches: it comes from the section 7 key schedule (salt = nonce, link id own:<requester>)");
    // the page seals the container and hands over the file; the asker receives
    let src = t.path().join("h.container");
    let bytes = data(20 * 1024 * 1024 + 11);
    std::fs::write(&src, &bytes).unwrap();
    asker.eng.transfer_receive().unwrap();
    holder.eng.transfer_send(src.display().to_string()).unwrap();
    wait_own(&holder, "sent", |s| s.state == NearState::Done);
    wait_own(&asker, "received", |s| s.state == NearState::Done);
    assert_eq!(std::fs::read(&asker.eng.transfer_result().unwrap().path).unwrap(), bytes);
    // what travelled as control messages: an offer, an answer, then sealed near_msg only (no hello, nothing in the clear)
    let log = r.log.lock().unwrap();
    let types: Vec<&str> = log.iter().map(|(_, _, c)| c["type"].as_str().unwrap()).collect();
    assert_eq!(types[0], "near_offer");
    assert_eq!(types[1], "near_answer");
    assert!(types[2..].iter().all(|t| *t == "near_msg"), "{types:?}");
    assert!(log.iter().all(|(_, to, c)| c["to"].as_str() == Some(to) && c["v"] == 1));
    let wire = serde_json::to_string(&log.iter().map(|(_, _, c)| c.clone()).collect::<Vec<_>>()).unwrap();
    assert!(!wire.contains("Dawson") && !wire.contains("caps") && !wire.contains("lan_offer"), "the sealed bodies carry caps / lan_offer / labels, never the control JSON");
}

#[test]
fn own_device_decline_busy_stale_and_a_dead_holder_end_calmly() {
    let t = tmp();
    // the holder's person declines
    {
        let r = router();
        let holder = own_host(&r, t.path(), "h1", "dev-H");
        let asker = own_host(&r, t.path(), "a1", "dev-N");
        asker.eng.own_request("dev-H".into(), "dev-N".into()).unwrap();
        wait_own(&holder, "sheet", |s| s.state == NearState::AwaitingApproval);
        holder.eng.refuse();
        let s = wait_own(&asker, "the asker is told no", |s| s.state == NearState::Refused);
        assert_eq!(s.error.unwrap().code, "denied");
        assert!(asker.eng.transfer_key().is_err());
    }
    // the biometric gate fails: back to the sheet, nothing answered
    {
        let r = router();
        let holder = own_host(&r, t.path(), "h2", "dev-H");
        let asker = own_host(&r, t.path(), "a2", "dev-N");
        *holder.gate.next.lock().unwrap() = Verification::Failed;
        asker.eng.own_request("dev-H".into(), "dev-N".into()).unwrap();
        wait_own(&holder, "sheet", |s| s.state == NearState::AwaitingApproval);
        assert!(matches!(holder.eng.approve(), ApproveOutcome::Failed(..)));
        assert_eq!(holder.eng.snapshot().state, NearState::AwaitingApproval);
        assert!(!r.log.lock().unwrap().iter().any(|(_, _, c)| c["type"] == "near_answer"), "no answer (and so no key exchange) without the person's yes");
        holder.eng.cancel();
    }
    // a holder that is already in a session says "busy" with a decline
    {
        let r = router();
        let holder = own_host(&r, t.path(), "h3", "dev-H");
        let asker = own_host(&r, t.path(), "a3", "dev-N");
        // a live fake server keeps the holder's session open (a dead port fails at once and the holder is then no longer busy: a race)
        let fake = Fake::start();
        holder.eng.show_start(base(&fake), false, None).unwrap();
        wait_own(&holder, "the holder is showing a code", |s| s.code.is_some());
        asker.eng.own_request("dev-H".into(), "dev-N".into()).unwrap();
        let s = wait_own(&asker, "declined while busy", |s| s.state == NearState::Refused);
        assert_eq!(s.error.unwrap().code, "busy");
        holder.eng.cancel();
    }
    // nobody ever answers (the message was lost): the asker gives up, it does not hang
    {
        let r = router();
        *r.drop_type.lock().unwrap() = Some("near_offer".into());
        let asker = own_host(&r, t.path(), "a4", "dev-N");
        asker.eng.own_request("dev-H".into(), "dev-N".into()).unwrap();
        asker.eng.cancel();
        wait_own(&asker, "cancelled", |s| s.state == NearState::Cancelled);
    }
}

// ---- "the PC said no" (2026-11-25): re-asks, duplicates and busy declines ---------------------------------------------------
//
// Owner report: phones asking a desktop for their history always ended on "<PC> said not now". The desktop answered EVERY offer that
// arrived while its sheet for an earlier offer was still up with a decline (`own_deliver`'s busy rule), and that sheet lives for the
// whole `own_answer` window (310 s in the helper). A phone that gave up on its first request (Back, Cancel, "Try again") had moved on to a
// new nonce, so the earlier sheet could never complete, yet every new request inside those five minutes got "no" at once.

fn answers_to(r: &Router, to: &str) -> Vec<serde_json::Value> {
    r.log.lock().unwrap().iter().filter(|(_, t, c)| t == to && c["type"] == "near_answer").map(|(_, _, c)| c.clone()).collect()
}

#[test]
fn a_re_ask_from_the_same_device_replaces_its_undecided_sheet_instead_of_being_told_no() {
    let t = tmp();
    let r = router();
    let holder = own_host(&r, t.path(), "h", "dev-H");
    let asker = own_host(&r, t.path(), "a", "dev-N");
    asker.eng.own_request("dev-H".into(), "dev-N".into()).unwrap();
    wait_own(&holder, "the first sheet", |s| s.role == Some("own_sender") && s.state == NearState::AwaitingApproval);
    // the phone gives up on its first request (Back / Cancel / "Try again") and asks again: a NEW nonce
    asker.eng.cancel();
    wait_own(&asker, "the first request ended", |s| s.state == NearState::Cancelled);
    asker.eng.own_request("dev-H".into(), "dev-N".into()).unwrap();
    wait_own(&asker, "the second request waits", |s| s.role == Some("own_receiver") && s.state == NearState::AwaitingApproval);
    std::thread::sleep(Duration::from_millis(400));
    assert!(answers_to(&r, "dev-N").is_empty(), "the re-ask must not be answered with a decline: {:?}", answers_to(&r, "dev-N"));
    assert_eq!(asker.eng.snapshot().state, NearState::AwaitingApproval, "still waiting for the person, not \"said not now\"");
    let sheet = wait_own(&holder, "the sheet now answers the second request", |s| s.role == Some("own_sender") && s.state == NearState::AwaitingApproval);
    assert_eq!(sheet.peer.as_ref().unwrap().label, "Dawson's other PC");
    // the person approves the sheet on screen: it answers the request the phone is actually waiting on, and the transfer starts
    assert_eq!(holder.eng.approve(), ApproveOutcome::Approved("hello"));
    wait_own(&asker, "the asker is approved", |s| s.state == NearState::Approved);
    wait_own(&holder, "the holder proved the LAN", |s| s.state == NearState::Approved && s.proximity == Some("lan"));
    assert_eq!(*holder.eng.transfer_key().unwrap(), *asker.eng.transfer_key().unwrap());
    holder.eng.cancel();
    asker.eng.cancel();
}

// "busy right now" that never cleared (2026-11-26): a phone whose transfer died after the person said Send (its foreground service
// crashed, the OS killed the app, the Wi-Fi dropped) never tells the holder, and the holder's approved session waits for a peer that is
// gone. Every retry of that SAME device (a new nonce: its core runs one request at a time) was answered "busy" until the stale session
// gave up. A re-ask from the device the running holder session belongs to replaces it, whatever it was doing.
#[test]
fn a_re_ask_from_the_device_of_an_approved_stalled_holder_session_replaces_it_instead_of_being_told_busy() {
    let t = tmp();
    let r = router();
    let holder = own_host(&r, t.path(), "h", "dev-H");
    let asker = own_host(&r, t.path(), "a", "dev-N");
    asker.eng.own_request("dev-H".into(), "dev-N".into()).unwrap();
    wait_own(&holder, "the first sheet", |s| s.role == Some("own_sender") && s.state == NearState::AwaitingApproval);
    assert_eq!(holder.eng.approve(), ApproveOutcome::Approved("hello"));
    wait_own(&holder, "the holder proved the LAN and waits to send", |s| s.state == NearState::Approved && s.proximity == Some("lan"));
    // the phone's process dies mid-way: nothing is said to the holder. Its next start asks again (same device id, a new engine).
    let phone2 = own_host(&r, t.path(), "a2", "dev-N");
    phone2.eng.own_request("dev-H".into(), "dev-N".into()).unwrap();
    std::thread::sleep(Duration::from_millis(600));
    let busy: Vec<_> = answers_to(&r, "dev-N").into_iter().filter(|a| a["busy"] == true).collect();
    assert!(busy.is_empty(), "the stale session of the same device must give way, not answer busy: {busy:?}");
    assert_eq!(phone2.eng.snapshot().state, NearState::AwaitingApproval, "the re-ask waits for the person");
    let sheet = wait_own(&holder, "the holder shows a fresh sheet for the new request", |s| s.role == Some("own_sender") && s.state == NearState::AwaitingApproval);
    assert_eq!(sheet.peer.as_ref().unwrap().label, "Dawson's other PC");
    assert_eq!(holder.eng.approve(), ApproveOutcome::Approved("hello"));
    wait_own(&phone2, "the new request is approved", |s| s.state == NearState::Approved);
    holder.eng.cancel();
    phone2.eng.cancel();
    asker.eng.cancel();
}

// but another device never takes over a session that is past its sheet
#[test]
fn another_device_is_still_told_busy_while_a_holder_session_is_approved() {
    let t = tmp();
    let r = router();
    let holder = own_host(&r, t.path(), "h", "dev-H");
    let first = own_host(&r, t.path(), "a1", "dev-N");
    let other = own_host(&r, t.path(), "a2", "dev-M");
    first.eng.own_request("dev-H".into(), "dev-N".into()).unwrap();
    wait_own(&holder, "the sheet", |s| s.role == Some("own_sender") && s.state == NearState::AwaitingApproval);
    assert_eq!(holder.eng.approve(), ApproveOutcome::Approved("hello"));
    wait_own(&holder, "approved", |s| s.state == NearState::Approved && s.proximity == Some("lan"));
    other.eng.own_request("dev-H".into(), "dev-M".into()).unwrap();
    let s = wait_own(&other, "told busy", |s| s.state == NearState::Refused);
    assert_eq!(s.error.unwrap().code, "busy");
    assert_eq!(holder.eng.snapshot().state, NearState::Approved, "the first device's session is untouched");
    holder.eng.cancel();
    first.eng.cancel();
}

#[test]
fn the_same_offer_delivered_twice_opens_one_sheet_and_is_never_declined() {
    let t = tmp();
    let r = router();
    let holder = own_host(&r, t.path(), "h", "dev-H");
    let (_, e_pub) = cl_near::keys::generate_keypair();
    let nonce = super::own::random16();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    let mut offer = super::own::offer_content(&e_pub, &nonce, now);
    offer["to"] = "dev-H".into();
    assert_eq!(holder.eng.own_deliver(offer.clone(), "dev-N", "dev-H", "x"), "offer");
    wait_own(&holder, "sheet", |s| s.state == NearState::AwaitingApproval);
    // the page handed the same envelope over again (a re-pull before the ACK landed)
    assert_eq!(holder.eng.own_deliver(offer.clone(), "dev-N", "dev-H", "x"), "ignored");
    std::thread::sleep(Duration::from_millis(200));
    assert!(answers_to(&r, "dev-N").is_empty(), "a decline here would end the asker's live request");
    assert_eq!(holder.eng.snapshot().state, NearState::AwaitingApproval);
    // and after the person said no, a late copy of that offer does not open a second sheet
    holder.eng.refuse();
    wait_own(&holder, "declined", |s| s.state.is_terminal());
    assert_eq!(holder.eng.own_deliver(offer, "dev-N", "dev-H", "x"), "ignored");
    assert!(holder.eng.snapshot().state.is_terminal());
    assert_eq!(answers_to(&r, "dev-N").len(), 1, "exactly one answer: the person's");
}

#[test]
fn a_holder_busy_with_another_device_says_busy_and_the_asker_tells_it_apart_from_a_no() {
    let t = tmp();
    let r = router();
    let holder = own_host(&r, t.path(), "h", "dev-H");
    let first = own_host(&r, t.path(), "a1", "dev-N");
    let second = own_host(&r, t.path(), "a2", "dev-M");
    first.eng.own_request("dev-H".into(), "dev-N".into()).unwrap();
    wait_own(&holder, "the first device's sheet", |s| s.state == NearState::AwaitingApproval);
    // ANOTHER device asks while that sheet is up: not a replacement (a different device), so it is told busy
    second.eng.own_request("dev-H".into(), "dev-M".into()).unwrap();
    let s = wait_own(&second, "the second asker is told busy", |s| s.state == NearState::Refused);
    assert_eq!(s.error.unwrap().code, "busy", "busy, not the person's \"not now\"");
    let a = answers_to(&r, "dev-M");
    assert_eq!((a[0]["declined"].clone(), a[0]["busy"].clone(), a[0]["rev"].clone()), (serde_json::json!(true), serde_json::json!(true), serde_json::json!(2)));
    // the first device's sheet is untouched
    assert_eq!(holder.eng.snapshot().state, NearState::AwaitingApproval);
    // the person's own "not now" stays `denied`, and carries rev 2 so an asker knows it was a person
    holder.eng.refuse();
    let s = wait_own(&first, "the first asker is told no", |s| s.state == NearState::Refused);
    assert_eq!(s.error.unwrap().code, "denied");
    assert_eq!(answers_to(&r, "dev-N")[0]["rev"], 2);
    assert!(answers_to(&r, "dev-N")[0].get("busy").is_none());
}

#[test]
fn an_offer_arriving_while_this_device_waits_on_its_own_request_takes_over() {
    // the phone core's B4 rule, mirrored: a request this device made that nobody answered yet gives way to the request it receives
    let t = tmp();
    let r = router();
    *r.drop_type.lock().unwrap() = Some("near_offer".into());
    let desk = own_host(&r, t.path(), "d", "dev-D");
    desk.eng.own_request("dev-X".into(), "dev-D".into()).unwrap();
    wait_own(&desk, "the desktop's own request waits", |s| s.role == Some("own_receiver") && s.state == NearState::AwaitingApproval);
    *r.drop_type.lock().unwrap() = None;
    let phone = own_host(&r, t.path(), "p", "dev-P");
    phone.eng.own_request("dev-D".into(), "dev-P".into()).unwrap();
    let s = wait_own(&desk, "the phone's request opens the sheet", |s| s.role == Some("own_sender") && s.state == NearState::AwaitingApproval);
    assert_eq!(s.role, Some("own_sender"));
    assert!(answers_to(&r, "dev-P").is_empty());
    desk.eng.cancel();
    phone.eng.cancel();
}

#[test]
fn own_device_offers_that_are_stale_misaddressed_or_from_this_device_never_start_a_sheet() {
    let t = tmp();
    let r = router();
    let holder = own_host(&r, t.path(), "h", "dev-H");
    let (_, e_pub) = cl_near::keys::generate_keypair();
    let nonce = super::own::random16();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    let mk = |to: &str, ts: i64| { let mut c = super::own::offer_content(&e_pub, &nonce, ts); c["to"] = to.into(); c };
    assert_eq!(holder.eng.own_deliver(mk("dev-H", now - 200_000), "dev-N", "dev-H", "x"), "ignored", "an old offer is ignored");
    assert_eq!(holder.eng.own_deliver(mk("dev-OTHER", now), "dev-N", "dev-H", "x"), "ignored", "addressed to a different device");
    assert_eq!(holder.eng.own_deliver(mk("dev-H", now), "dev-H", "dev-H", "x"), "ignored", "never from this device");
    assert_eq!(holder.eng.snapshot().state, NearState::Idle, "nothing started");
    assert_eq!(holder.eng.own_deliver(mk("dev-H", now), "dev-N", "dev-H", "x"), "offer");
    wait_own(&holder, "sheet", |s| s.state == NearState::AwaitingApproval);
    // an answer for a session that is not waiting, and a near_msg with the wrong nonce, are ignored
    let mut a = super::own::answer_content(&nonce, Some(&e_pub));
    a["to"] = "dev-H".into();
    assert_eq!(holder.eng.own_deliver(a, "dev-N", "dev-H", "x"), "ignored");
    holder.eng.cancel();
}

// ---- round 5: pause cap, persisted pause flag, stale spools, local-network causes (phone core 30ea21d5) -------------------

fn host_tuned(tmp: &Path, name: &str, seed: &'static str, tweak: impl FnOnce(&mut NearEnv)) -> Host {
    let dir = tmp.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    let hist: Arc<Mutex<Vec<NearSnapshot>>> = Default::default();
    let h2 = hist.clone();
    let (mut env, ident, gate, skew) = test_env(&dir, name, seed, no_radio(), Os::Windows, Arc::new(move |s| h2.lock().unwrap().push(s.clone())));
    tweak(&mut env);
    Host { eng: NearEngine::new(env), hist, ident, gate, skew, dir }
}

fn approved_pair_tuned(fake: &Fake, t: &Path, tune_a: impl FnOnce(&mut NearEnv), tune_n: impl FnOnce(&mut NearEnv)) -> (Host, Host) {
    register_approver(fake, "dev-A", SEED_A);
    let n = host_tuned(t, "new", SEED_N, tune_n);
    let a = host_tuned(t, "appr", SEED_A, tune_a);
    n.eng.show_start(base(fake), false, None).unwrap();
    let uri = wait_for(&n, "code", |s| s.code.is_some()).code.unwrap().uri;
    a.eng.approver_start(base(fake), auth("dev-A"), ScanInput::Qr(uri)).unwrap();
    wait_for(&a, "sheet", |s| s.state == NearState::AwaitingApproval);
    assert_eq!(a.eng.approve(), ApproveOutcome::Approved("hello"));
    wait_for(&n, "granted", |s| s.state == NearState::Approved);
    (a, n)
}

fn start_big_send(a: &Host, n: &Host, t: &Path) {
    let src = t.join("h.container");
    std::fs::write(&src, data(150 * 1024 * 1024 + 9)).unwrap();
    n.eng.transfer_receive().unwrap();
    a.eng.transfer_send(src.display().to_string()).unwrap();
}

#[test]
fn a_pause_is_persisted_on_both_sides_and_cleared_on_resume() {
    let (fake, t) = (Fake::start(), tmp());
    let (a, n) = approved_pair(&fake, t.path());
    start_big_send(&a, &n, t.path());
    wait_for(&a, "sending", |s| s.transfer.as_ref().is_some_and(|t| t.bytes_done > 0));
    assert_eq!(super::parts::read_paused_flag(&a.dir), None);
    a.eng.transfer_pause().unwrap();
    wait_for(&n, "peer paused", |s| s.transfer.as_ref().is_some_and(|t| t.paused && t.paused_by == Some("peer")));
    wait_for(&a, "me paused", |s| s.transfer.as_ref().is_some_and(|t| t.paused && t.paused_by == Some("me")));
    assert_eq!(super::parts::read_paused_flag(&a.dir).as_deref(), Some("me"), "the pauser's flag");
    assert_eq!(super::parts::read_paused_flag(&n.dir).as_deref(), Some("peer"), "the paused-by-peer side persists it too");
    a.eng.transfer_resume().unwrap();
    wait_for(&a, "sent", |s| s.state == NearState::Done);
    wait_for(&n, "received", |s| s.state == NearState::Done);
    assert_eq!(super::parts::read_paused_flag(&a.dir), None);
    assert_eq!(super::parts::read_paused_flag(&n.dir), None);
}

#[test]
fn the_side_paused_by_its_peer_gives_up_at_the_pause_cap_and_so_does_a_pauser_nobody_resumes() {
    // peer-paused side: the receiver pauses, the sender keeps reconnecting until its cap, then ends with `timeout`
    let (fake, t) = (Fake::start(), tmp());
    let (a, n) = approved_pair_tuned(&fake, t.path(), |e| e.timing.pause_cap = Duration::from_secs(2), |_| {});
    start_big_send(&a, &n, t.path());
    wait_for(&n, "receiving", |s| s.transfer.as_ref().is_some_and(|t| t.bytes_done > 0));
    n.eng.transfer_pause().unwrap();
    wait_for(&a, "sender sees the peer's pause", |s| s.transfer.as_ref().is_some_and(|t| t.paused && t.paused_by == Some("peer")));
    let f = wait_for(&a, "gave up", |s| s.state == NearState::Failed);
    assert_eq!(f.error.unwrap().code, "timeout");
    assert_eq!(super::parts::read_paused_flag(&a.dir), None, "a finished session leaves no paused flag");
    n.eng.cancel();

    // pauser side: this device paused and nobody resumes
    let (fake, t) = (Fake::start(), tmp());
    let (a, n) = approved_pair_tuned(&fake, t.path(), |e| e.timing.pause_cap = Duration::from_secs(2), |_| {});
    start_big_send(&a, &n, t.path());
    wait_for(&a, "sending", |s| s.transfer.as_ref().is_some_and(|t| t.bytes_done > 0));
    a.eng.transfer_pause().unwrap();
    let f = wait_for(&a, "gave up", |s| s.state == NearState::Failed);
    assert_eq!(f.error.unwrap().code, "timeout");
    n.eng.cancel();
}

#[test]
fn a_resume_inside_the_cap_still_finishes() {
    let (fake, t) = (Fake::start(), tmp());
    let (a, n) = approved_pair_tuned(&fake, t.path(), |e| e.timing.pause_cap = Duration::from_secs(8), |e| e.timing.pause_cap = Duration::from_secs(8));
    start_big_send(&a, &n, t.path());
    wait_for(&n, "receiving", |s| s.transfer.as_ref().is_some_and(|t| t.bytes_done > 0));
    n.eng.transfer_pause().unwrap();
    wait_for(&a, "peer pause", |s| s.transfer.as_ref().is_some_and(|t| t.paused));
    std::thread::sleep(Duration::from_millis(1200));
    n.eng.transfer_resume().unwrap();
    wait_for(&a, "sent", |s| s.state == NearState::Done);
    wait_for(&n, "received", |s| s.state == NearState::Done);
}

#[test]
fn a_new_session_discards_the_old_spool_cleanly_and_a_restart_does_too() {
    let (fake, t) = (Fake::start(), tmp());
    let stage = t.path().join("old").join("staging");
    // a previous run left a spool, an unimported container and a paused flag behind
    let old = t.path().join("old");
    std::fs::create_dir_all(super::parts::recv_dir(&old).join("old-link").join("parts")).unwrap();
    std::fs::write(super::parts::recv_dir(&old).join("old-link").join("parts").join("0.rec"), b"sealed under a key that no longer exists").unwrap();
    std::fs::write(super::parts::recv_dir(&old).join("old-link").join("progress.json"), b"{}").unwrap();
    std::fs::create_dir_all(&stage).unwrap();
    std::fs::write(stage.join("near-received-old-link.container"), b"x").unwrap();
    std::fs::write(stage.join("near-partial-old-link.container"), b"x").unwrap();
    std::fs::write(stage.join("unrelated.bin"), b"x").unwrap();
    super::parts::persist_pause(&old, Some("peer"));
    let h = host(&fake, t.path(), "old", SEED_N, no_radio(), Os::Windows);
    assert!(std::fs::read_dir(super::parts::recv_dir(&old)).unwrap().next().is_none(), "restart: the stale spool is gone");
    assert!(!stage.join("near-received-old-link.container").exists() && !stage.join("near-partial-old-link.container").exists());
    assert!(stage.join("unrelated.bin").exists(), "only the near files are touched");
    assert_eq!(super::parts::read_paused_flag(&old), None);

    // a NEW session: whatever the previous one spooled goes before the next one starts (K_xfer is per session)
    std::fs::create_dir_all(super::parts::recv_dir(&old).join("prev-session").join("parts")).unwrap();
    std::fs::write(super::parts::recv_dir(&old).join("prev-session").join("parts").join("0.rec"), b"x").unwrap();
    h.eng.show_start(base(&fake), false, None).unwrap();
    assert!(!super::parts::recv_dir(&old).join("prev-session").exists(), "a new sign-in session starts clean");
    assert!(h.eng.transfer_keep_partial().is_err(), "and there is nothing left to keep from the old one");
}

#[test]
fn keep_what_arrived_still_works_before_the_next_session_starts() {
    // the same flow as a_stopped_transfer_can_be_kept..., asserted again after the purge logic exists
    let (fake, t) = (Fake::start(), tmp());
    let (a, n) = approved_pair(&fake, t.path());
    start_big_send(&a, &n, t.path());
    wait_for(&n, "two parts", |s| s.transfer.as_ref().is_some_and(|t| t.records_done >= 2));
    n.eng.transfer_pause().unwrap();
    wait_for(&n, "paused", |s| s.transfer.as_ref().is_some_and(|t| t.paused));
    n.eng.cancel();
    wait_for(&n, "stopped", |s| s.state == NearState::Cancelled);
    assert!(n.eng.transfer_keep_partial().is_ok());
}

#[test]
fn local_network_state_maps_to_the_phone_cores_causes() {
    use super::engine::LocalNetwork as L;
    assert_eq!(L::parse("granted").lan_cause(), "not_found");
    assert_eq!(L::parse("unknown").lan_cause(), "not_found");
    assert_eq!(L::parse("nonsense").lan_cause(), "not_found");
    assert_eq!(L::parse("denied").lan_cause(), "denied");
    assert_eq!(L::parse("firewall").lan_cause(), "firewall");
}

/// A desktop approver under the strict policy with its only interface on another subnet than the phone's: the local-network leg cannot connect.
fn refused_by_a_dead_lan(fake: &Fake, t: &Path, said: Option<&str>) -> super::state::NearRefusal {
    register_approver(fake, "dev-A", SEED_A);
    let a = host_tuned(t, "appr", SEED_A, |e| {
        e.ifaces = Arc::new(StaticInterfaces(vec![LocalInterface::new(1, "test0", "10.9.9.1".parse().unwrap(), 24)]));
        e.lan_policy = cl_near::lan::LanPolicy::Strict; // the phone's loopback address is then not on-link: the dial cannot happen
    });
    if let Some(s) = said {
        a.eng.set_local_network(s);
    }
    let io = Arc::new(ChanIo::default());
    let rt = phone_rt();
    let _phone = rt.spawn(phone_new_device(phone_cfg(fake, t, false, true), io.clone(), Arc::new(AtomicU64::new(0))));
    a.eng.approver_start(base(fake), auth("dev-A"), ScanInput::Qr(io.wait_for_code())).unwrap();
    let r = wait_for(&a, "refused", |s| s.state == NearState::Refused);
    assert_eq!(r.error.as_ref().unwrap().code, "no_proximity");
    r.refusal.unwrap()
}

#[test]
fn a_failed_local_network_leg_reports_the_cause_the_os_gave_not_a_guess() {
    let (fake, t) = (Fake::start(), tmp());
    assert_eq!(refused_by_a_dead_lan(&fake, t.path(), None).lan, "not_found", "no OS statement: a plain failure is not_found");
    let (fake, t) = (Fake::start(), tmp());
    assert_eq!(refused_by_a_dead_lan(&fake, t.path(), Some("firewall")).lan, "firewall");
    let (fake, t) = (Fake::start(), tmp());
    assert_eq!(refused_by_a_dead_lan(&fake, t.path(), Some("denied")).lan, "denied");
}


// ---- security review 2026-11-20 (desktop side): F3 policy, F4, L1, F5, v14 scan retry -----------------------------------------------

fn policy_host(fake: &Fake, t: &Path, name: &str, seed: &'static str, radio: Arc<dyn BleRadio>) -> Host {
    let dir = t.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    let hist: Arc<Mutex<Vec<NearSnapshot>>> = Default::default();
    let h2 = hist.clone();
    let _ = fake;
    let (mut env, ident, gate, skew) = test_env(&dir, name, seed, radio, Os::Windows, Arc::new(move |s| h2.lock().unwrap().push(s.clone())));
    env.test_history_over_lan = false; // the REAL policy
    Host { eng: NearEngine::new(env), hist, ident, gate, skew, dir }
}

#[test]
fn a_local_network_proof_is_approve_only_the_sheet_says_so_and_no_history_moves() {
    let (fake, t) = (Fake::start(), tmp());
    register_approver(&fake, "dev-A", SEED_A);
    let n = policy_host(&fake, t.path(), "new", SEED_N, no_radio());
    let a = policy_host(&fake, t.path(), "appr", SEED_A, no_radio());
    n.eng.show_start(base(&fake), false, None).unwrap();
    let uri = wait_for(&n, "code", |s| s.code.is_some()).code.unwrap().uri;
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(uri)).unwrap();
    let sheet = wait_for(&a, "sheet", |s| s.state == NearState::AwaitingApproval);
    assert_eq!(sheet.proximity, Some("lan"), "the sheet says `same network`");
    assert_eq!(sheet.peer.as_ref().and_then(|p| p.identity_key.clone()), Some(identity_pub_b64(SEED_N)), "L3: the sheet carries the key the approval will be signed for");
    assert_eq!(sheet.history_allowed, Some(false));
    assert_eq!(sheet.transfer_offerable, Some(false));
    assert_eq!(a.eng.approve(), ApproveOutcome::Approved("hello"), "approving still works");
    wait_for(&n, "granted", |s| s.state == NearState::Approved);
    // the approver sends nothing and the new device starts no receiver
    let src = t.path().join("h.container");
    std::fs::write(&src, data(2048)).unwrap();
    let e = a.eng.transfer_send(src.display().to_string()).unwrap_err();
    assert!(e.contains("approve-only"), "{e}");
    let e = n.eng.transfer_receive().unwrap_err();
    assert!(e.contains("approve-only"), "{e}");
    assert_ne!(a.eng.snapshot().state, NearState::Transferring);
    assert_ne!(n.eng.snapshot().state, NearState::Transferring);
}

#[test]
fn a_bluetooth_proof_allows_the_history_and_the_phone_peer_gets_it() {
    // the existing end-to-end (`bluetooth_proof_then_lan_probe_...`) runs the real policy through `test_env` with the override ON for the
    // two-desktop tests only; here the override is OFF and a Bluetooth proof still lets the history move
    let (fake, t) = (Fake::start(), tmp());
    register_approver(&fake, "dev-A", SEED_A);
    let io = Arc::new(ChanIo::default());
    let radio: Arc<dyn BleRadio> = Arc::new(CellRadio { state: AdapterState::Ready, cell: io.cell.clone() });
    let a = policy_host(&fake, t.path(), "appr", SEED_A, radio);
    let out = t.path().join("phone-received.container");
    let mut cfg = phone_cfg(&fake, t.path(), true, true);
    cfg.recv_out = Some(out);
    let rt = phone_rt();
    let phone = rt.spawn(phone_new_device(cfg, io.clone(), Arc::new(AtomicU64::new(0))));
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(io.wait_for_code())).unwrap();
    let sheet = wait_for(&a, "sheet", |s| s.state == NearState::AwaitingApproval);
    assert_eq!((sheet.proximity, sheet.history_allowed), (Some("ble"), Some(true)));
    wait_for(&a, "probe", |s| s.transfer_offerable == Some(true));
    assert_eq!(a.eng.approve(), ApproveOutcome::Approved("hello"));
    let src = t.path().join("h.container");
    std::fs::write(&src, data(300_000)).unwrap();
    a.eng.transfer_send(src.display().to_string()).unwrap();
    wait_for(&a, "sent", |s| s.state == NearState::Done);
    let rep = rt.block_on(phone).unwrap();
    assert!(rep.error.is_none() && rep.transfer_bytes == 300_000, "{rep:?}");
}

#[test]
fn approving_before_the_probe_ends_is_approve_only_and_the_probe_does_not_block_the_button() {
    let (fake, t) = (Fake::start(), tmp());
    register_approver(&fake, "dev-A", SEED_A);
    let io = Arc::new(ChanIo::default());
    let radio: Arc<dyn BleRadio> = Arc::new(CellRadio { state: AdapterState::Ready, cell: io.cell.clone() });
    let a = policy_host(&fake, t.path(), "appr", SEED_A, radio);
    let mut cfg = phone_cfg(&fake, t.path(), true, false); // a phone that never offers a local-network path: the probe would run to its cap
    cfg.timeout_s = 20;
    let rt = phone_rt();
    let _phone = rt.spawn(phone_new_device(cfg, io.clone(), Arc::new(AtomicU64::new(0))));
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(io.wait_for_code())).unwrap();
    let sheet = wait_for(&a, "sheet", |s| s.state == NearState::AwaitingApproval);
    assert_eq!((sheet.proximity, sheet.history_allowed, sheet.transfer_offerable), (Some("ble"), Some(true), Some(false)));
    let t0 = Instant::now();
    assert_eq!(a.eng.approve(), ApproveOutcome::Approved("hello"));
    assert!(t0.elapsed() < Duration::from_secs(3), "Approve only is answered at once, not after the 4 s probe cap");
}

#[test]
fn a_heard_advertisement_without_the_advertisers_ack_is_not_a_bluetooth_proof() {
    // a rogue advertiser (or a stranger's random UUID that passes the 32-bit tag): the host hears a valid UUID, sends `ble_heard`, and
    // never gets the ack. Without a local-network path either, nothing is approved and the sheet never shows.
    let (fake, t) = (Fake::start(), tmp());
    register_approver(&fake, "dev-A", SEED_A);
    let io = Arc::new(ChanIo::default());
    let radio: Arc<dyn BleRadio> = Arc::new(CellRadio { state: AdapterState::Ready, cell: io.cell.clone() });
    let a = policy_host(&fake, t.path(), "appr", SEED_A, radio);
    let mut cfg = phone_cfg(&fake, t.path(), true, false);
    cfg.no_ack = true;
    let rt = phone_rt();
    let _phone = rt.spawn(phone_new_device(cfg, io.clone(), Arc::new(AtomicU64::new(0))));
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(io.wait_for_code())).unwrap();
    let r = wait_for(&a, "refused", |s| s.state == NearState::Refused);
    assert_eq!(r.error.unwrap().code, "no_proximity");
    assert!(!states(&a).contains(&NearState::AwaitingApproval), "no sheet without a proof");
    assert_eq!(approve_calls(&fake), 0);
}

#[test]
fn a_server_that_names_another_identity_key_at_scan_ends_the_approval_before_anything_is_signed() {
    let (fake, t) = (Fake::start(), tmp());
    register_approver(&fake, "dev-A", SEED_A);
    let n = policy_host(&fake, t.path(), "new", SEED_N, no_radio());
    let a = policy_host(&fake, t.path(), "appr", SEED_A, no_radio());
    n.eng.show_start(base(&fake), false, None).unwrap();
    let shown = wait_for(&n, "code", |s| s.code.is_some());
    let lid = shown.link_id.clone().unwrap();
    // the server swaps the key the approver is told to sign for
    fake.st.lock().unwrap().sessions.get_mut(&lid).unwrap().scan_lie = Some(identity_pub_b64(SEED_A));
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(shown.code.unwrap().uri)).unwrap();
    let f = wait_for(&a, "failed", |s| s.state == NearState::Failed);
    assert_eq!(f.error.unwrap().code, "identity_mismatch");
    assert!(!states(&a).contains(&NearState::AwaitingApproval) && !states(&a).contains(&NearState::Approving), "nothing is shown or signed");
    assert_eq!(approve_calls(&fake), 0);
}

#[test]
fn the_new_device_registers_only_the_hash_of_its_relay_token_and_every_post_carries_the_token() {
    let (fake, t) = (Fake::start(), tmp());
    register_approver(&fake, "dev-A", SEED_A);
    let n = policy_host(&fake, t.path(), "new", SEED_N, no_radio());
    let a = policy_host(&fake, t.path(), "appr", SEED_A, no_radio());
    n.eng.show_start(base(&fake), false, None).unwrap();
    let shown = wait_for(&n, "code", |s| s.code.is_some());
    let uri = shown.code.unwrap().uri;
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(uri.clone())).unwrap();
    wait_for(&a, "sheet", |s| s.state == NearState::AwaitingApproval);
    let g = fake.st.lock().unwrap();
    let hash = g.sessions.values().next().unwrap().relay_auth.clone().expect("the server holds a hash");
    assert_eq!(hash.len(), 44, "base64 of a SHA-256");
    assert!(!uri.contains(&hash), "the QR never carries the relay secret");
    // the new device's hello_ack went through the server's token check (a post without it would have been a 404 and no sheet)
    assert!(g.sessions.values().next().unwrap().n.len() >= 2, "hello_ack and caps were accepted as side n");
}

#[test]
fn a_scan_that_loses_the_provisional_pin_is_retried_once_after_the_wait() {
    let (fake, t) = (Fake::start(), tmp());
    register_approver(&fake, "dev-A", SEED_A);
    let n = policy_host(&fake, t.path(), "new", SEED_N, no_radio());
    let a = policy_host(&fake, t.path(), "appr", SEED_A, no_radio());
    n.eng.show_start(base(&fake), false, None).unwrap();
    let shown = wait_for(&n, "code", |s| s.code.is_some());
    // another device holds the provisional pin (it scanned and has not posted yet)
    let other = fake.api(Some("dev-B"), None);
    other.scan(&shown.link_id.clone().unwrap()).unwrap();
    a.eng.approver_start(base(&fake), auth("dev-A"), ScanInput::Qr(shown.code.unwrap().uri)).unwrap();
    // 10 s of the server's (virtual) clock pass while the approver waits its retry
    std::thread::sleep(Duration::from_millis(100));
    fake.advance(11);
    wait_for(&a, "sheet after the retry", |s| s.state == NearState::AwaitingApproval);
    assert_eq!(a.eng.approve(), ApproveOutcome::Approved("hello"));
}

#[test]
fn losing_the_pin_after_a_successful_scan_reads_as_another_device_took_over() {
    for e in ["link_wrong_account (403): fake", "http_404 (404): fake"] {
        match super::engine::takeover_or_for_test(cl_near::error::NearError::Transport(e.into())) {
            (code, _) => assert_eq!(code, "taken_over", "{e}"),
        }
    }
    assert_ne!(super::engine::takeover_or_for_test(cl_near::error::NearError::Transport("network (0): x".into())).0, "taken_over");
}
