//! DEV ONLY (feature `testkit`, refused in release): what lets a Node/Rust test drive the real helper binary against the fake
//! server and a scripted phone on one machine: a radio whose single advertisement is supplied by the test, the loopback LAN
//! policy, short timings, and the `test` stdin command.
use crate::proto::TestOp;
use crate::Platform;
use cl_near::onlink::{LocalInterface, StaticInterfaces};
use cl_near_engine::engine::{Os, Timing};
use cl_near_engine::radio::{AdapterState, ScanCaps};
use cl_near_engine::testpeer::CellRadio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone)]
pub struct Hooks {
    pub cell: Arc<Mutex<Option<[u8; 16]>>>,
    pub skew: Arc<AtomicU64>,
}

impl Hooks {
    pub fn apply(&self, op: &TestOp) {
        match op {
            TestOp::Advert { uuid } => {
                if uuid.len() == 32 {
                    let b: Vec<u8> = (0..16).filter_map(|i| u8::from_str_radix(&uuid[2 * i..2 * i + 2], 16).ok()).collect();
                    if let Ok(a) = <[u8; 16]>::try_from(b) {
                        *self.cell.lock().unwrap() = Some(a);
                    }
                }
            }
            TestOp::Skew { ms } => {
                self.skew.fetch_add(*ms, Ordering::SeqCst);
            }
        }
    }
}

/// `radio_state`: what the fake adapter reports (`ready`, `off`, `none`).
pub fn platform(radio_state: &str) -> Platform {
    let state = match radio_state {
        "off" => AdapterState::RadioOff,
        "none" => AdapterState::NoAdapter,
        _ => AdapterState::Ready,
    };
    let cell: Arc<Mutex<Option<[u8; 16]>>> = Default::default();
    let skew = Arc::new(AtomicU64::new(0));
    Platform {
        radio: Arc::new(CellRadio { state, cell: cell.clone() }),
        biometric: None,
        ifaces: Arc::new(StaticInterfaces(vec![LocalInterface { index: 1, name: "test0".into(), addr: "10.255.0.1".parse().unwrap(), prefix_len: 24, kind: cl_near::onlink::IfaceKind::Virtual }])),
        os: Os::Linux,
        lan_policy: cl_near::lan::LanPolicy::DangerousAllowLoopback,
        timing: Timing { hello: Duration::from_secs(3), peer_step: Duration::from_secs(5), lan: Duration::from_secs(6), lan_probe: Duration::from_secs(4), scan_retry: Duration::from_millis(300), poll: Duration::from_millis(100), transfer_giveup: Duration::from_secs(20), reopen_margin: Duration::from_secs(10), show_limit: Duration::from_secs(600), pause_cap: Duration::from_secs(900) },
        scan_caps: ScanCaps { adapter: Duration::from_millis(300), scan: Duration::from_millis(1500) },
        skew: skew.clone(),
        hooks: Some(Hooks { cell, skew }),
    }
}
