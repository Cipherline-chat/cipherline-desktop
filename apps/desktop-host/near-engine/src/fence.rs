//! Release fence for cl-near's test-only `dangerous-loopback` feature.
//!
//! The feature makes the LAN layer treat 127.0.0.1 as on-link, which would let a process on the same
//! machine pass the proximity proof. It is a dev-dependency feature only (Cargo.toml); this assertion is
//! the second lock: a release build (no debug assertions) with the feature compiled in does not build.
//! `tools/check-near-fence.sh` is the third: it inspects the normal-edge feature set.
#[cfg(not(debug_assertions))]
const _: () = assert!(!cl_near::LOOPBACK_ENABLED, "cl-near `dangerous-loopback` must never be enabled in a release build");

/// True when this build can accept loopback peers. Always false in release.
pub const fn loopback_compiled_in() -> bool {
    cl_near::LOOPBACK_ENABLED
}
