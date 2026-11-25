//! DEV-ONLY test rig for the Node integration test (`apps/desktop/electron/near-helper.integration.test.ts`): the fake link
//! server and the scripted phone (the same `testpeer` the Rust two-process end-to-end uses) in one process, driven over stdio.
//!
//! stdout: `BASE <url>` first; then `CODE <uri>` (a code the phone shows), `ADVERT <32 hex>` (the UUID it advertises),
//!         `REPORT <json>` (the phone's end-of-run report), `OK <what>` for each control command.
//! stdin:  `APPROVER <deviceId> <identityPubB64>`   register the approver's key so the fake really verifies its signature
//!         `PHONE <n|a> <PhoneCfg json without base>` start a phone role (n = new device, a = approver)
//!         `CODE <uri>`                              the helper's code, for the approver phone
//!         `SKEW <ms>`                               advance the phone's rotation clock
//!         `FAKE_THROTTLE <bucket>`                  shrink the relay GET bucket
use cl_near_engine::fake_server::Fake;
use cl_near_engine::testpeer::{phone_approver, phone_new_device, PeerIo, PhoneCfg};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

fn say(l: &str) {
    println!("{l}");
    let _ = std::io::stdout().flush();
}

struct Io {
    code: Mutex<Option<String>>,
    cv: Condvar,
}
impl PeerIo for Io {
    fn publish_code(&self, uri: &str) {
        say(&format!("CODE {uri}"));
    }
    fn wait_for_code(&self) -> String {
        let mut g = self.code.lock().unwrap();
        while g.is_none() {
            g = self.cv.wait(g).unwrap();
        }
        g.clone().unwrap()
    }
    fn advertise(&self, u: [u8; 16]) {
        say(&format!("ADVERT {}", u.iter().map(|b| format!("{b:02x}")).collect::<String>()));
    }
}

fn main() {
    let fake = Fake::start();
    say(&format!("BASE {}", fake.base()));
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let io = Arc::new(Io { code: Mutex::new(None), cv: Condvar::new() });
    let skew = Arc::new(AtomicU64::new(0));
    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        if let Some(r) = line.strip_prefix("APPROVER ") {
            if let Some((dev, key)) = r.split_once(' ') {
                fake.st.lock().unwrap().approver_keys.insert(dev.to_owned(), key.trim().to_owned());
                say("OK approver");
            }
        } else if let Some(r) = line.strip_prefix("PHONE ") {
            let (role, json) = r.split_once(' ').unwrap_or(("", ""));
            let mut v: serde_json::Value = serde_json::from_str(json).expect("cfg json");
            v["base"] = serde_json::Value::String(fake.base());
            let cfg: PhoneCfg = serde_json::from_value(v).expect("PhoneCfg");
            let role = role.to_owned();
            *io.code.lock().unwrap() = None;
            let (io2, skew2) = (io.clone(), skew.clone());
            rt.spawn(async move {
                let rep = if role == "n" { phone_new_device(cfg, io2, skew2).await } else { phone_approver(cfg, io2).await };
                say(&format!("REPORT {}", serde_json::to_string(&rep).unwrap()));
            });
            say("OK phone");
        } else if let Some(u) = line.strip_prefix("CODE ") {
            *io.code.lock().unwrap() = Some(u.to_owned());
            io.cv.notify_all();
        } else if let Some(ms) = line.strip_prefix("SKEW ") {
            skew.fetch_add(ms.trim().parse().unwrap_or(0), Ordering::SeqCst);
        } else if let Some(n) = line.strip_prefix("FAKE_THROTTLE ") {
            fake.st.lock().unwrap().bucket = n.trim().parse().unwrap_or(100);
            say("OK throttle");
        }
    }
}
