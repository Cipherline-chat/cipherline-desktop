//! Proximity sign-in ("near") and local history transfer: the engine library (`cl-near-engine`).
//!
//! Shared by the Tauri host (`apps/desktop-host`, which re-exports it as `cl_host::near::*`) and the Electron
//! `near-helper` process (`apps/desktop-host/near-helper`). Everything platform-facing is a trait (radio, gate,
//! identity, interfaces) so the same engine runs against fakes on Linux.
//!
//! History: built as `apps/desktop-host/src/near/` first; see docs/worklog/entries/2026-11-19-next-near.md.
//!
//! BUILT SO FAR (this commit): the pure and platform-facing pieces the session engine will sit on:
//! [`fence`] (release lock on cl-near's loopback test feature), [`radio`] (BLE scan trait, fake, 3 s / 12 s
//! caps), [`gate`] (Hello / native confirm), [`state`] (the observable state machine + transition table),
//! [`parts`] (container file -> 16 MiB parts, resume, assemble). NOT YET: the HTTP relay transport, the
//! session engine that drives them, the Windows radio/Hello implementations and the `cl_host` actions; see
//! docs/worklog/entries/2026-11-19-next-near.md.
//!
//! TLS. cl-near's channel REQUIRES a TLS 1.3 exporter and a pinned self-signed peer, which SChannel
//! (native-tls) cannot give, so it uses rustls with the `ring` provider, for THIS channel only; the API
//! client keeps SChannel. The real constraint that kept `ring` out of the host was cross-compiling it from
//! Linux to MSVC (no MSVC C compiler here); on the GitHub-hosted `windows-latest` runner (MSVC installed,
//! ring ships pre-generated NASM objects) it builds normally. So: `ring` stays, compiled on Windows CI only.
pub mod api;
pub mod dispatch;
pub mod engine;
pub mod fence;
#[cfg(any(test, feature = "near-testkit"))]
pub mod fake_server;
pub mod gate;
pub mod own;
pub mod parts;
pub mod pause;
pub mod radio;
pub mod state;
pub mod util;
pub mod winble;
pub mod winnet;
#[cfg(windows)]
pub mod winhello;
#[cfg(test)]
mod engine_tests;
#[cfg(any(test, feature = "near-testkit"))]
pub mod testpeer;

#[cfg(test)]
mod vector_tests {
    //! Known-answer check of the vendored cl-near against its own `near-v1.json` (committed; unconditional: a missing
    //! file FAILS the test).
    use cl_near::keys;
    use serde_json::Value;

    fn hexv(s: &str) -> Vec<u8> {
        (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn key_schedule_matches_the_reference_vectors() {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../vendor/cl-near/test-vectors/near-v1.json");
        let raw = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{} missing: {e} (run tools/sync-core.sh)", p.display()));
        let v: Value = serde_json::from_str(&raw).unwrap();
        let en: [u8; 32] = hexv(v["inputs"]["eN_priv_hex"].as_str().unwrap()).try_into().unwrap();
        let ea_pub = keys::public_of(&hexv(v["inputs"]["eA_priv_hex"].as_str().unwrap()).try_into().unwrap());
        let secret: [u8; 16] = hexv(v["inputs"]["secret_hex"].as_str().unwrap()).try_into().unwrap();
        let link = v["inputs"]["link_id"].as_str().unwrap();
        let k = keys::session_keys(&en, &ea_pub, &secret, link).unwrap();
        assert_eq!(k.ble.to_vec(), hexv(v["keys"]["K_ble_hex"].as_str().unwrap()));
        assert_eq!(k.lan.to_vec(), hexv(v["keys"]["K_lan_hex"].as_str().unwrap()));
        assert_eq!(k.conf.to_vec(), hexv(v["keys"]["K_conf_hex"].as_str().unwrap()));
        // control: a different secret must not reproduce them
        let k2 = keys::session_keys(&en, &ea_pub, &[0u8; 16], link).unwrap();
        assert_ne!(k2.ble.to_vec(), hexv(v["keys"]["K_ble_hex"].as_str().unwrap()));
    }
}

/// The interface list the local-network proof uses on THIS platform: Windows asks the adapter type and hardware flag
/// ([`winnet::WindowsInterfaces`]); everywhere else cl-near's own enumeration (sysfs on Linux, names on macOS).
pub fn platform_interfaces() -> std::sync::Arc<dyn cl_near::onlink::InterfaceProvider> {
    #[cfg(windows)]
    {
        std::sync::Arc::new(winnet::WindowsInterfaces)
    }
    #[cfg(not(windows))]
    {
        std::sync::Arc::new(cl_near::onlink::SystemInterfaces)
    }
}
