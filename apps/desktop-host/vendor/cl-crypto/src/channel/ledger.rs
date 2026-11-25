//! The channel replay ledger — desktop `channel-replay.ts`, keys byte for byte.
//!
//! Every accepted message's (channel, canonical nonce) is recorded against a tag of its
//! server id. A genuine sender never repeats a nonce under a key (that would already break
//! GCM) and the server cannot change one without breaking the tag, so "same channel, same
//! nonce, different server id" is a re-post of an existing ciphertext — for v1 and v2 alike.
//! Re-reading the SAME row stays accepted (history refresh re-decrypts the newest page).
//!
//! The durable ledger lives in the store; [`ReplayLedger`] is the in-memory rule it persists.
use std::collections::HashMap;

use sha2::{Digest, Sha256};

use super::ChannelError;
use crate::encoding::b64_nopad;

/// 128 bits of a domain-separated SHA-256 over (channel, canonical nonce), base64 unpadded.
pub fn channel_replay_key(channel_id: &str, nonce_canon: &str) -> String {
    let h = Sha256::digest(format!("cl-chan-replay-v1\0{channel_id}\0{nonce_canon}").as_bytes());
    b64_nopad(&h[..16])
}

/// 96-bit tag of a server message id, base64 unpadded.
pub fn channel_message_id_tag(message_id: &str) -> String {
    let h = Sha256::digest(format!("cl-chan-msgid-v1\0{message_id}").as_bytes());
    b64_nopad(&h[..12])
}

#[derive(Clone, Debug, Default)]
pub struct ReplayLedger {
    entries: HashMap<String, String>,
}

impl ReplayLedger {
    pub fn new() -> Self {
        Self::default()
    }

    /// Claim (channel, nonce) for `message_id`. Call only AFTER every other check passed: a
    /// rejected message must claim nothing, or a forged copy could lock out the genuine row.
    pub fn claim(&mut self, channel_id: &str, nonce_canon: &str, message_id: &str) -> Result<(), ChannelError> {
        let key = channel_replay_key(channel_id, nonce_canon);
        let tag = channel_message_id_tag(message_id);
        match self.entries.get(&key) {
            Some(existing) if *existing != tag => Err(ChannelError::Replay { channel_id: channel_id.to_owned() }),
            Some(_) => Ok(()),
            None => {
                self.entries.insert(key, tag);
                Ok(())
            }
        }
    }

    /// Persisted form: replay key → id tag.
    pub fn entries(&self) -> &HashMap<String, String> {
        &self.entries
    }

    pub fn from_entries(entries: HashMap<String, String>) -> Self {
        Self { entries }
    }
}

/// Order a page of rows oldest first by `created_at`, so a replay can never claim the ledger
/// slot ahead of the original it copies. Unparseable timestamps sort last; ties keep their
/// input order. Desktop `oldestFirst`.
pub fn oldest_first<T>(rows: Vec<T>, created_at: impl Fn(&T) -> &str) -> Vec<T> {
    let mut keyed: Vec<(i64, usize, T)> = rows
        .into_iter()
        .enumerate()
        .map(|(i, r)| (crate::time::parse_iso_ms(created_at(&r)).unwrap_or(i64::MAX), i, r))
        .collect();
    keyed.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    keyed.into_iter().map(|(_, _, r)| r).collect()
}
