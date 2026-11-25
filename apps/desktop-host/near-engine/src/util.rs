//! The few host-crate helpers the engine used to reach through `crate::`, now local so the engine is a
//! standalone library (the Tauri host and the Electron `near-helper` both link it).
//!
//! - [`agent_builder`]: same as the host's `net::agent_builder` (SChannel on Windows via native-tls; rustls
//!   elsewhere through ureq's `tls` feature).
//! - [`attest_token`]: same as `attest::token` (deterrence HMAC header); the host has a test that both agree.
//! - [`chrono_iso`]: same as `identity::chrono_iso` (`toISOString` shape); same host test.
//! - [`log`]: a replaceable sink. Fixed words, counts and error strings only; never keys, tokens or ids.
use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::sync::OnceLock;

pub fn agent_builder() -> ureq::AgentBuilder {
    let b = ureq::AgentBuilder::new();
    #[cfg(windows)]
    let b = match native_tls::TlsConnector::new() {
        Ok(c) => b.tls_connector(std::sync::Arc::new(c)),
        Err(_) => b,
    };
    b
}

pub fn attest_token(secret: &str, unix_s: u64) -> String {
    let ts = unix_s.to_string();
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC takes any key length");
    mac.update(ts.as_bytes());
    let sig: String = mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect();
    base64::engine::general_purpose::STANDARD.encode(format!("{ts}:{sig}"))
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

pub fn chrono_iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let milli = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{milli:03}Z", sod / 3600, (sod / 60) % 60, sod % 60)
}

/// L5: a free-space probe for the receiver's directory where the OS has no query cl-near can make portably. Windows: GetDiskFreeSpaceExW
/// (free bytes available to THIS user). Unix: `None`, `FileRecordSink` uses statvfs itself.
#[cfg(windows)]
pub fn free_space_probe(dir: &std::path::Path) -> Option<std::sync::Arc<dyn Fn() -> Option<u64> + Send + Sync>> {
    let dir = dir.to_path_buf();
    Some(std::sync::Arc::new(move || {
        let wide = windows::core::HSTRING::from(dir.as_os_str());
        let mut avail: u64 = 0;
        // SAFETY: `wide` is a valid NUL-terminated string and `avail` a valid out pointer for the call's duration.
        let ok = unsafe { windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(&wide, Some(&mut avail), None, None) }.is_ok();
        fail_closed_free(ok.then_some(avail))
    }))
}

/// A probe that could not answer reads as NO free space (the receiver then refuses the transfer): cl-near skips its check on `None`,
/// which would let a failed query accept any size (security round M3). Pure so it is tested on every OS.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn fail_closed_free(probed: Option<u64>) -> Option<u64> {
    Some(probed.unwrap_or(0))
}
#[cfg(not(windows))]
pub fn free_space_probe(_dir: &std::path::Path) -> Option<std::sync::Arc<dyn Fn() -> Option<u64> + Send + Sync>> {
    None
}

static SINK: OnceLock<Box<dyn Fn(&str) + Send + Sync>> = OnceLock::new();

/// Install the log sink once (the host points it at `hostlog`, the helper at its stderr). Later calls are ignored.
pub fn set_log_sink(f: impl Fn(&str) + Send + Sync + 'static) {
    let _ = SINK.set(Box::new(f));
}

pub fn log(line: &str) {
    match SINK.get() {
        Some(f) => f(line),
        None => eprintln!("[near] {line}"),
    }
}

#[macro_export]
macro_rules! nlog {
    ($($t:tt)*) => { $crate::util::log(&format!($($t)*)) };
}

#[cfg(test)]
mod tests {
    #[test]
    fn attest_matches_node_createhmac() {
        assert_eq!(
            super::attest_token("test-secret", 1_795_100_000),
            "MTc5NTEwMDAwMDpmMjU5ZGQ5YTg1ZDc0MzI0MDRmMzI0MmMwMzc1N2Q5NmE2NWE1Y2QzYTEwOWU5MWYxODhhZTkwZWQyMDI1OWFi"
        );
    }
    #[test]
    fn iso_shape() {
        assert_eq!(super::chrono_iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(super::chrono_iso(86_400_000 + 5), "1970-01-02T00:00:00.005Z");
    }
}

#[cfg(test)]
mod free_space_tests {
    use super::fail_closed_free;
    #[test]
    fn a_failed_probe_means_no_space_never_unknown() {
        assert_eq!(fail_closed_free(None), Some(0));
        assert_eq!(fail_closed_free(Some(123)), Some(123));
    }
}
