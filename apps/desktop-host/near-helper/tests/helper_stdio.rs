//! The real helper binary over real pipes: handshake, refusals, protocol hygiene. Needs `--features testkit`
//! (`cargo test --features testkit`); the sign-in / transfer flows are driven from Node by
//! `apps/desktop/electron/near-helper.integration.test.ts` against the same binary.
#![cfg(all(feature = "testkit", unix))]
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::Duration;

const NONCE: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

struct H {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: Receiver<String>,
}

/// `fd3`: what to hand the child as fd 3 (a bash process substitution = a pipe; `None` = nothing at all).
fn spawn(fd3: Option<&str>) -> H {
    let exe = env!("CARGO_BIN_EXE_cl-near-helper");
    let mut cmd = match fd3 {
        Some(_) => {
            let mut c = Command::new("bash");
            c.args(["-c", r#"exec "$0" ready 3< <(printf '%s\n' "$FD3")"#, exe]);
            c
        }
        None => {
            let mut c = Command::new(exe);
            c.arg("ready");
            c
        }
    };
    if let Some(v) = fd3 {
        cmd.env("FD3", v);
    }
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().expect("spawn helper");
    let out = child.stdout.take().unwrap();
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        for l in BufReader::new(out).lines().map_while(Result::ok) {
            if tx.send(l).is_err() {
                break;
            }
        }
    });
    let stdin = child.stdin.take();
    H { child, stdin, lines: rx }
}

impl H {
    fn send(&mut self, l: &str) {
        let s = self.stdin.as_mut().unwrap();
        let _ = writeln!(s, "{l}");
        let _ = s.flush();
    }
    /// The next line that is not a state snapshot (those are asynchronous and interleave with results).
    fn recv(&self) -> serde_json::Value {
        loop {
            let l = self.lines.recv_timeout(Duration::from_secs(20)).expect("a line from the helper");
            let v: serde_json::Value = serde_json::from_str(&l).unwrap_or_else(|_| panic!("not json: {l}"));
            if v["t"] != "state" {
                return v;
            }
        }
    }
    fn hello(&mut self, nonce: &str) {
        let dir = std::env::temp_dir().join(format!("clnh-{}", std::process::id()));
        self.send(&format!(r#"{{"t":"hello","v":1,"nonce":"{nonce}","config":{{"profile":"{0}/p","stagingDir":"{0}/s","version":"0.1.2","deviceLabel":"Test PC","platform":"linux"}}}}"#, dir.display()));
    }
    fn exit_code(&mut self) -> i32 {
        drop(self.stdin.take());
        let t0 = std::time::Instant::now();
        loop {
            if let Some(s) = self.child.try_wait().unwrap() {
                return s.code().unwrap_or(-1);
            }
            assert!(t0.elapsed() < Duration::from_secs(10), "helper did not exit");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

#[test]
fn it_refuses_to_start_without_the_handshake_descriptor() {
    let mut h = spawn(None);
    assert_eq!(h.exit_code(), 65);
}

#[test]
fn it_refuses_a_malformed_nonce_on_fd3() {
    let mut h = spawn(Some("not-a-nonce"));
    assert_eq!(h.exit_code(), 65);
}

#[test]
fn it_refuses_a_hello_with_the_wrong_nonce() {
    let mut h = spawn(Some(NONCE));
    h.hello(&NONCE.replace('0', "1"));
    let m = h.recv();
    assert_eq!(m["t"], "fatal");
    assert!(!m.to_string().contains(NONCE));
    assert_eq!(h.exit_code(), 65);
}

#[test]
fn it_refuses_a_first_line_that_is_not_hello() {
    let mut h = spawn(Some(NONCE));
    h.send(r#"{"t":"call","id":1,"action":"nearProbe"}"#);
    assert_eq!(h.recv()["t"], "fatal");
    assert_eq!(h.exit_code(), 65);
}

#[test]
fn a_good_handshake_answers_probe_and_refuses_everything_else() {
    let mut h = spawn(Some(NONCE));
    h.hello(NONCE);
    let ready = h.recv();
    assert_eq!(ready["t"], "ready");
    assert_eq!(ready["v"], 1);

    h.send(r#"{"t":"call","id":1,"action":"nearProbe"}"#);
    let r = h.recv();
    assert_eq!((r["t"].as_str(), r["id"].as_u64(), r["ok"].as_bool()), (Some("result"), Some(1), Some(true)));
    assert_eq!(r["value"]["available"], true);
    assert_eq!(r["value"]["bluetooth"], "ready");
    assert_eq!(r["value"]["gate"], "password", "no biometric on this build: the gate is the parent's password check");

    // not a bridge member
    h.send(r#"{"t":"call","id":2,"action":"fsReadFile","args":["/etc/passwd"]}"#);
    let r = h.recv();
    assert_eq!((r["id"].as_u64(), r["ok"].as_bool()), (Some(2), Some(false)));
    // the sign-in members exist in the engine but this (transfer) helper does not serve them
    for (id, call) in [
        (3, r#"{"t":"call","id":3,"action":"nearShowStart","args":[{"mode":"qr","apiBase":"https://api.cipherline.chat"}]}"#),
        (4, r#"{"t":"call","id":4,"action":"nearApproverStart","args":[{"apiBase":"https://api.cipherline.chat"}]}"#),
        (7, r#"{"t":"call","id":7,"action":"nearInviteStart","args":[{"apiBase":"https://api.cipherline.chat"}]}"#),
        (8, r#"{"t":"call","id":8,"action":"nearBiometricVerify","args":["x"]}"#),
    ] {
        h.send(call);
        let r = h.recv();
        assert_eq!((r["id"].as_u64(), r["ok"].as_bool()), (Some(id), Some(false)), "{r}");
        assert_eq!(r["error"], "not a near member");
    }
    // a served member with bad arguments is rejected by the validator, not coerced
    h.send(r#"{"t":"call","id":9,"action":"nearTransferRequest","args":[{"deviceId":"","ownDeviceId":"b"}]}"#);
    let r = h.recv();
    assert_eq!(r["ok"], false, "{r}");
    h.send(r#"{"t":"call","id":10,"action":"nearTransferSend","args":[{"path":"relative/file"}]}"#);
    let r = h.recv();
    assert_eq!(r["ok"], false, "{r}");
    // nothing above started a session
    h.send(r#"{"t":"call","id":6,"action":"nearCancel"}"#);
    let _ = h.recv();
    // unsolicited replies are ignored
    h.send(r#"{"t":"reply","rid":999,"value":{"verdict":"approved"},"attest":"00"}"#);
    h.send(r#"{"t":"call","id":5,"action":"nearGetState"}"#);
    let r = h.recv();
    assert!(matches!(r["value"]["state"].as_str(), Some("idle" | "failed" | "cancelled")), "{r}");
    // closing stdin ends the helper cleanly
    assert_eq!(h.exit_code(), 0);
}

#[test]
fn a_second_hello_a_junk_line_and_an_oversized_line_end_the_session() {
    for bad in [
        r#"{"t":"hello","v":1,"nonce":"x","config":{}}"#.to_string(),
        "this is not json".to_string(),
        r#"{"t":"call","id":1,"action":"nearProbe","unexpected":1}"#.to_string(),
        format!(r#"{{"t":"call","id":1,"action":"nearProbe","args":["{}"]}}"#, "a".repeat(70_000)),
    ] {
        let mut h = spawn(Some(NONCE));
        h.hello(NONCE);
        assert_eq!(h.recv()["t"], "ready");
        h.send(&bad);
        assert_eq!(h.recv()["t"], "fatal", "{}", &bad[..bad.len().min(60)]);
        assert_eq!(h.exit_code(), 66);
    }
}

#[test]
fn a_bad_config_is_refused() {
    let mut h = spawn(Some(NONCE));
    h.send(&format!(r#"{{"t":"hello","v":1,"nonce":"{NONCE}","config":{{"profile":"relative","stagingDir":"/tmp/x","version":"1","deviceLabel":"d","platform":"linux"}}}}"#));
    assert_eq!(h.recv()["t"], "fatal");
    assert_eq!(h.exit_code(), 66);
}
