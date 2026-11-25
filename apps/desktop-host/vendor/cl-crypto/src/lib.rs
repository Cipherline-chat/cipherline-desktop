//! Cipherline wire formats, byte-compatible with the desktop client.
//!
//! Every function here is proven against the desktop-generated vectors in
//! `test-vectors/` (see `tests/vectors.rs`). Never change a byte layout without
//! regenerating those vectors from the desktop source first.

pub mod attestation;
pub mod backup_container;
pub mod backup_v4;
pub mod blob;
pub mod channel;
pub mod encoding;
pub mod envelope;
pub mod franking;
pub mod error;
pub mod history;
pub mod identity;
pub mod js_json;
pub mod kdf;
pub mod keys;
pub mod link;
pub mod pow;
pub mod time;
pub mod verification;

pub use error::CryptoError;
