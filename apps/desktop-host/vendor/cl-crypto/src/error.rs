use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CryptoError {
    /// Input had the wrong length or shape (a key that is not 32 bytes, a blob shorter than its header).
    #[error("invalid input: {0}")]
    InvalidInput(String),
    /// Authentication failed: wrong key, wrong password, or tampered data. Deliberately carries no detail.
    #[error("decryption failed")]
    DecryptFailed,
    /// A format marker we do not recognise.
    #[error("unsupported format: {0}")]
    UnsupportedFormat(String),
}
