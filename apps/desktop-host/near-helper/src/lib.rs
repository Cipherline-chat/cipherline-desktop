//! `cl-near-helper`: the near engine as a child process of the Electron app.
//!
//! WHO CAN TALK TO IT. Only its parent, over the stdin/stdout pipes it was spawned with. It never opens a socket for commands
//! and has no argv/env surface that matters (nothing secret is passed either way). It refuses to start when stdin is a
//! terminal or when the parent did not prove itself with the handshake nonce (see `main.rs`). The only sockets it ever
//! opens are the protocol's own: HTTPS to the link API, and cl-near's authenticated TLS 1.3 listener/dialer for the
//! local-network proof and transfer (a peer without the session secret cannot complete it).
//!
//! WHAT IT HOLDS. The access token the approver passes to `nearApproverStart`/`nearInviteStart` and `K_xfer` live in the
//! engine's memory only (`Zeroizing` where the engine owns them); the helper logs fixed words only, and never writes a token
//! or key to argv, the environment, a file or stderr.
#[cfg(all(feature = "testkit", not(debug_assertions)))]
compile_error!("the helper's `testkit` feature (fake radio, loopback LAN) must never be part of a release build");

pub mod platform;
pub mod proto;
pub mod remote;
#[cfg(feature = "testkit")]
pub mod testkit;

use cl_near_engine::dispatch::{self, MEMBERS};
use cl_near_engine::engine::{NearEngine, NearEnv, Os, Timing};
use cl_near_engine::pause::FramePause;
use cl_near_engine::radio::ScanCaps;
use proto::{encode_out, parse_in, read_line_bounded, Config, In, Out, MAX_IN_LINE, PROTOCOL_VERSION};
use remote::{OwnOut, Remote, RemoteGate, RemoteIdentity};
use serde_json::Value;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::channel;
use std::sync::Arc;
use subtle::ConstantTimeEq;

/// Exit codes the parent can tell apart in its log.
pub const EXIT_OK: i32 = 0;
pub const EXIT_NOT_A_PIPE: i32 = 64;
pub const EXIT_BAD_HANDSHAKE: i32 = 65;
pub const EXIT_PROTOCOL: i32 = 66;
pub const EXIT_UNSUPPORTED: i32 = 69;

const MAX_IN_FLIGHT: usize = 8;

/// The platform-specific pieces (radio, biometric, interfaces) and, for tests, the timings.
pub struct Platform {
    pub radio: Arc<dyn cl_near_engine::radio::BleRadio>,
    pub biometric: Option<Arc<dyn remote::Biometric>>,
    pub ifaces: Arc<dyn cl_near::onlink::InterfaceProvider>,
    pub os: Os,
    pub lan_policy: cl_near::lan::LanPolicy,
    pub timing: Timing,
    pub scan_caps: ScanCaps,
    pub skew: Arc<AtomicU64>,
    #[cfg(feature = "testkit")]
    pub hooks: Option<testkit::Hooks>,
}

fn resolve_path(p: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(p);
    if !path.is_absolute() || p.contains('\0') || path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("path must be absolute".into());
    }
    // The parent (Electron main, through the app's fs confinement) already decided this path is the page's to name; the
    // helper still refuses anything that is not a plain file (no symlink, device, directory).
    let md = std::fs::symlink_metadata(&path).map_err(|_| "file not found".to_string())?;
    if !md.file_type().is_file() {
        return Err("not a regular file".into());
    }
    Ok(path)
}

fn private_dir(p: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(p)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Serve one parent. `input` / `output` are the stdin/stdout pipes (a Cursor / Vec in unit tests). Returns the exit code.
pub fn serve<R: BufRead, W: Write + Send + 'static>(mut input: R, output: W, nonce: &str, platform: Platform) -> i32 {
    let (tx, rx) = channel::<Out>();
    let writer = std::thread::spawn(move || {
        let mut w = output;
        for o in rx {
            let mut line = encode_out(&o);
            let ok = w.write_all(&line).and_then(|_| w.flush()).is_ok();
            zeroize::Zeroize::zeroize(&mut line);
            if !ok || matches!(o, Out::Fatal { .. }) {
                break;
            }
        }
    });
    let fatal = |tx: &std::sync::mpsc::Sender<Out>, msg: &str| {
        let _ = tx.send(Out::Fatal { error: msg.into() });
    };

    // 1. the handshake: the first line must be `hello` carrying the nonce the parent gave us out of band
    let mut buf = Vec::with_capacity(1024);
    let cfg = match read_line_bounded(&mut input, MAX_IN_LINE, &mut buf) {
        Ok(true) => match parse_in(&mut buf) {
            Ok(In::Hello { v, nonce: got, config }) => {
                let same = got.len() == nonce.len() && bool::from(got.as_bytes().ct_eq(nonce.as_bytes()));
                if v != PROTOCOL_VERSION || !same {
                    fatal(&tx, "handshake refused");
                    drop(tx);
                    let _ = writer.join();
                    return EXIT_BAD_HANDSHAKE;
                }
                config
            }
            _ => {
                fatal(&tx, "first line must be hello");
                drop(tx);
                let _ = writer.join();
                return EXIT_BAD_HANDSHAKE;
            }
        },
        _ => {
            drop(tx);
            let _ = writer.join();
            return EXIT_BAD_HANDSHAKE;
        }
    };
    if let Err(e) = Config::validate(&cfg).and_then(|_| private_dir(&cfg.profile).and_then(|_| private_dir(&cfg.staging_dir)).map_err(|_| "cannot create the profile directories".to_string())) {
        fatal(&tx, &e);
        drop(tx);
        let _ = writer.join();
        return EXIT_PROTOCOL;
    }

    #[cfg(feature = "testkit")]
    let hooks = platform.hooks.clone();
    // 2. the engine
    let remote = Remote::new(tx.clone(), nonce.to_owned());
    let emit_remote = remote.clone();
    let platform_name: &'static str = match cfg.platform.as_str() {
        "mac" => "mac",
        "windows" => "windows",
        _ => "linux",
    };
    let env = NearEnv {
        radio: platform.radio,
        gate: Arc::new(RemoteGate { remote: remote.clone(), biometric: platform.biometric }),
        ifaces: platform.ifaces,
        identity: Arc::new(RemoteIdentity(remote.clone())),
        profile: PathBuf::from(&cfg.profile),
        staging_dir: PathBuf::from(&cfg.staging_dir),
        version: cfg.version.clone(),
        attest_secret: cfg.attest_secret.clone().filter(|s| !s.is_empty()),
        device_label: cfg.device_label.clone(),
        platform: platform_name,
        os: platform.os,
        lan_policy: platform.lan_policy,
        scan_caps: platform.scan_caps,
        lan_timeouts: Default::default(),
        timing: platform.timing,
        stop: Arc::new(FramePause),
        own_send: Arc::new(OwnOut(remote.clone())),
        // B5: the other device's person has as long as that device's own sheet lasts (the phone core waits 5 min), not 70 s: finding the phone, unlocking and a Face ID check do not fit in 70 s (found live, lan-transfer e2e round 2)
        own_answer: std::time::Duration::from_secs(310),
        emit: Arc::new(move |s| {
            if let Ok(v) = serde_json::to_value(s) {
                emit_remote.send(Out::State { snapshot: v });
            }
        }),
        resolve_path: Arc::new(|p| resolve_path(p)),
        skew_ms: platform.skew.clone(),
        #[cfg(feature = "testkit")]
        test_history_over_lan: false,
    };
    let engine = Arc::new(NearEngine::new(env));
    remote.send(Out::Ready { v: PROTOCOL_VERSION, pid: std::process::id() });

    // 3. the command loop
    let in_flight = Arc::new(AtomicUsize::new(0));
    let code = loop {
        match read_line_bounded(&mut input, MAX_IN_LINE, &mut buf) {
            Ok(true) => {}
            Ok(false) => break EXIT_OK, // the parent closed our stdin: it is gone or done with us
            Err(_) => {
                fatal(&tx, "bad input line");
                break EXIT_PROTOCOL;
            }
        }
        match parse_in(&mut buf) {
            Ok(In::Call { id, action, args }) => {
                if in_flight.fetch_add(1, Ordering::SeqCst) >= MAX_IN_FLIGHT {
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                    remote.send(Out::Result { id, ok: false, value: None, error: Some("busy".into()) });
                    continue;
                }
                let (eng, rem, n) = (engine.clone(), remote.clone(), in_flight.clone());
                std::thread::spawn(move || {
                    // Effective in unwind builds only: the release profile aborts on panic (Cargo.toml, L2), which the client reports as `failed`.
                    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_call(&eng, &action, &args))).unwrap_or_else(|_| Err("internal error".into()));
                    n.fetch_sub(1, Ordering::SeqCst);
                    rem.send(match r {
                        Ok(v) => Out::Result { id, ok: true, value: Some(v), error: None },
                        Err(e) => Out::Result { id, ok: false, value: None, error: Some(e.chars().take(300).collect()) },
                    });
                });
            }
            Ok(In::Reply { rid, value, attest }) => {
                remote.deliver(rid, value, attest);
            }
            Ok(In::Hello { .. }) => {
                fatal(&tx, "hello twice");
                break EXIT_PROTOCOL;
            }
            #[cfg(feature = "testkit")]
            Ok(In::Test(op)) => {
                if let Some(h) = &hooks {
                    h.apply(&op);
                }
            }
            Err(e) => {
                fatal(&tx, &e);
                break EXIT_PROTOCOL;
            }
        }
    };
    engine.cancel();
    remote.abandon_all();
    drop(remote);
    drop(tx);
    // let queued lines (a `fatal`, late results) drain; the writer stops when every sender is gone or the pipe breaks
    std::thread::sleep(std::time::Duration::from_millis(50));
    let _ = writer.join_timeout_or_detach();
    code
}

trait JoinOrDetach {
    fn join_timeout_or_detach(self) -> Result<(), ()>;
}
impl JoinOrDetach for std::thread::JoinHandle<()> {
    /// Call threads hold senders until they finish; a still-running one must not hold the exit hostage.
    fn join_timeout_or_detach(self) -> Result<(), ()> {
        let t0 = std::time::Instant::now();
        while !self.is_finished() && t0.elapsed() < std::time::Duration::from_millis(500) {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if self.is_finished() { self.join().map_err(|_| ()) } else { Ok(()) }
    }
}

/// The engine members THIS helper serves: the own-device transfer subset (contract section 7). The proximity sign-in /
/// invite / approver members (`nearShowStart`, `nearInviteStart`, `nearApproverStart`) and the biometric probes belong to the
/// sign-in build and are refused here even though the engine library has them: a second, independent allow-list behind the
/// one in Electron main (`near-bridge.ts`), so a compromised renderer or a confused parent cannot start a sign-in session.
pub const SERVED_MEMBERS: [&str; 15] = [
    "nearProbe", "nearGetState", "nearApprove", "nearRefuse", "nearCancel", "nearTransferSend", "nearTransferReceive", "nearTransferResult",
    "nearTransferDiscard", "nearTransferPause", "nearTransferResume", "nearTransferKeepPartial", "nearTransferKey", "nearTransferRequest", "nearOwnDeliver",
];

/// The handshake nonce as ONE line on stdin, for platforms with no fd 3 (Windows: Node's extra stdio slot reaches a Rust child only
/// through the CRT's undocumented `lpReserved2` convention, which is not worth depending on). The pipe is private to the parent and
/// child, so the nonce is as secret as on fd 3; unlike fd 3 it cannot prove "I created these pipes", but that was never the
/// property that matters: the nonce's job is to key the gate attestation, which only the parent can compute. Bounded read.
pub fn read_nonce_line<R: BufRead>(input: &mut R) -> Result<String, &'static str> {
    use std::io::Read;
    let mut line = String::new();
    let n = (&mut *input).take(80).read_line(&mut line).map_err(|_| "unreadable handshake")?;
    if n == 0 {
        return Err("no handshake nonce");
    }
    let nonce = line.strip_suffix('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).ok_or("malformed handshake nonce")?;
    if nonce.len() != 64 || !nonce.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("malformed handshake nonce");
    }
    Ok(nonce.to_owned())
}

fn run_call(eng: &NearEngine, action: &str, args: &[Value]) -> Result<Value, String> {
    if !SERVED_MEMBERS.contains(&action) || !MEMBERS.contains(&action) {
        return Err("not a near member".into());
    }
    dispatch::call(eng, action, args).unwrap_or_else(|| Err("not a near member".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn served_members_are_a_subset_of_the_engine_and_exclude_sign_in() {
        for m in SERVED_MEMBERS {
            assert!(MEMBERS.contains(&m), "{m} is not an engine member");
        }
        for m in ["nearShowStart", "nearInviteStart", "nearApproverStart", "nearBiometricVerify", "nearBiometricAvailability"] {
            assert!(!SERVED_MEMBERS.contains(&m), "{m} must not be served by the transfer helper");
        }
        // every own-device / transfer member the page needs
        for m in ["nearTransferRequest", "nearOwnDeliver", "nearApprove", "nearTransferKey", "nearTransferPause", "nearTransferKeepPartial"] {
            assert!(SERVED_MEMBERS.contains(&m));
        }
    }

    #[test]
    fn nonce_line_is_read_once_and_the_rest_stays_for_hello() {
        let nonce = "ab".repeat(32);
        let mut r = std::io::BufReader::new(Cursor::new(format!("{nonce}\r\n{{\"t\":\"hello\"}}\n").into_bytes()));
        assert_eq!(read_nonce_line(&mut r).unwrap(), nonce);
        let mut rest = String::new();
        r.read_line(&mut rest).unwrap();
        assert_eq!(rest, "{\"t\":\"hello\"}\n");
    }

    #[test]
    fn nonce_line_refusals() {
        let bad = |bytes: Vec<u8>| read_nonce_line(&mut std::io::BufReader::new(Cursor::new(bytes))).is_err();
        assert!(bad(Vec::new()));
        assert!(bad(b"short\n".to_vec()));
        assert!(bad(format!("{}\n", "AB".repeat(32)).into_bytes())); // upper case is not the format
        assert!(bad(format!("{}", "ab".repeat(32)).into_bytes())); // no newline
        assert!(bad(format!("{}\n", "g".repeat(64)).into_bytes()));
        assert!(bad(vec![b'a'; 4000])); // bounded, no unbounded read
    }
}
