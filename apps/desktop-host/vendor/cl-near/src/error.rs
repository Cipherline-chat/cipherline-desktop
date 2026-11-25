use std::io;

/// One error type for the whole crate. Variants are coarse on purpose: callers show a plain refusal and,
/// at most, a short reason code; they never branch on message text.
#[derive(Debug, thiserror::Error)]
pub enum NearError {
    /// A payload, code or message did not parse under the strict rules.
    #[error("malformed {0}")]
    Malformed(&'static str),
    /// A confirmation, MAC, AEAD tag or pin did not verify.
    #[error("authentication failed: {0}")]
    Auth(&'static str),
    /// A relay message arrived with a non-increasing or repeated seq.
    #[error("replayed or reordered relay message")]
    Replay,
    /// The address is not on-link for any local interface.
    #[error("address is not on-link: {0}")]
    OffLink(String),
    /// A frame header announced more than the cap. Raised before any allocation.
    #[error("frame too large: {len} > {max}")]
    FrameTooLarge { len: u64, max: u64 },
    /// A record's bytes did not hash to the manifest value.
    #[error("record hash mismatch (record {0})")]
    HashMismatch(u32),
    /// F4: the new device's sealed `hello_ack` named an identity key other than the one the server gave the approver at scan. The
    /// server (or whoever sits between) substituted a key; nothing may be signed.
    #[error("the new device's identity key does not match the one the server announced")]
    IdentityMismatch,
    /// A resume was attempted against a different manifest than the one persisted.
    #[error("manifest changed since the interrupted transfer")]
    ManifestChanged,
    /// The peer broke the transfer protocol.
    #[error("protocol violation: {0}")]
    Protocol(String),
    /// The peer sent `abort`.
    #[error("peer aborted: {0}")]
    PeerAbort(String),
    /// This side cancelled.
    #[error("cancelled")]
    Cancelled,
    /// This side paused the transfer (contract 11.9): the connection closed after `abort { reason: "paused" }`; resume is a new
    /// connection and the normal `want` path.
    #[error("paused")]
    Paused,
    /// The peer paused the transfer (it sent `abort { reason: "paused" }`). Not a failure: wait for it to resume.
    #[error("peer paused")]
    PeerPaused,
    /// A deadline passed (reason says which).
    #[error("timed out: {0}")]
    Timeout(&'static str),
    /// A relay limit (32 messages, 2048 base64 chars each) or an expired session.
    #[error("relay limit: {0}")]
    RelayLimit(&'static str),
    /// An operation that needs a verified proximity proof was attempted without one.
    #[error("no valid proximity proof: {0}")]
    NoProof(&'static str),
    /// The relay answered 429: back off `retry_after_ms` (never a failure of the session).
    #[error("throttled, retry after {retry_after_ms} ms")]
    Throttled { retry_after_ms: u64 },
    #[error("transport: {0}")]
    Transport(String),
    #[error("tls: {0}")]
    Tls(String),
    #[error("io: {0}")]
    Io(#[from] io::Error),
    #[error("storage: {0}")]
    Storage(String),
}

pub type Result<T> = std::result::Result<T, NearError>;
