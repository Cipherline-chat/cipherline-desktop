//! The per-device channel epoch keys — desktop `channel-keys.ts`, via the mobile port.
//!
//! Pure state with the desktop rules; the store persists it with [`ChannelKeyring::to_json`]
//! (the same `{"<epoch>": {"keyHex", "rotatesAt"}}` shape the React Native app stores, so its
//! database can be migrated as is).
//!
//! Rules, each one a fixed bug on desktop or mobile:
//! - **Install validation.** The epoch, key and channel are sender-chosen and the routing is
//!   relay-chosen. Posting goes out under the MAX held epoch, so one absurd epoch would make
//!   this device post under a key nobody else holds, forever. Epoch must be an integer
//!   1..=1,000,000 (the API's `RecordEpochDto @Max`), the key exactly 32 bytes.
//! - **First writer wins.** A DIFFERENT key for an epoch already held is refused (two admins
//!   rotated at once), unless it is the server-arbitrated winner by fingerprint.
//! - **Old epochs are kept** so history stays readable. Pruning drops epochs older than 30 days
//!   but never the highest, never the newest 50, never one a pin depends on.
use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use super::ChannelError;
use crate::encoding::{b64, from_b64, from_hex, hex};
use crate::time::{parse_iso_ms, to_iso};

pub const MAX_CHANNEL_EPOCH: i64 = 1_000_000;
pub const CHANNEL_KEY_BYTES: usize = 32;
pub const PRUNE_AFTER_MS: i64 = 30 * 24 * 60 * 60 * 1000;
pub const RETAIN_NEWEST_COUNT: usize = 50;
pub const ROTATION_INTERVAL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SetKeyResult {
    /// A new epoch, or a verified replacement of a conflicting one.
    Stored,
    /// The identical key was already held.
    Duplicate,
    /// A DIFFERENT key is held for this epoch and was not overwritten.
    Conflict,
}

#[derive(Clone)]
struct Entry {
    key: Zeroizing<[u8; 32]>,
    rotates_at: String,
}

/// A key minted by [`ChannelKeyring::rotate`] — the key actually STORED for that epoch.
#[derive(Clone, Debug)]
pub struct MintedKey {
    pub epoch: u32,
    pub key_b64: String,
    pub rotates_at: String,
}

#[derive(Clone, Default)]
pub struct ChannelKeyring {
    channels: HashMap<String, BTreeMap<u32, Entry>>,
}

pub fn is_valid_epoch(epoch: i64) -> bool {
    (1..=MAX_CHANNEL_EPOCH).contains(&epoch)
}

/// Standard-alphabet base64 of exactly 32 bytes, padding optional (43 chars, or 44 with `=`).
pub fn parse_key_b64(key_b64: &str) -> Option<Zeroizing<[u8; 32]>> {
    let body = key_b64.strip_suffix('=').unwrap_or(key_b64);
    if body.len() != 43 || !body.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/') {
        return None;
    }
    let bytes = Zeroizing::new(from_b64(&format!("{body}=")).ok()?);
    let arr: [u8; 32] = bytes.as_slice().try_into().ok()?;
    Some(Zeroizing::new(arr))
}

/// SHA-256 of the raw key, base64 — opaque metadata, safe to send the server.
pub fn key_fingerprint(key: &[u8; 32]) -> String {
    b64(&Sha256::digest(key))
}

impl ChannelKeyring {
    pub fn new() -> Self {
        Self::default()
    }

    /// Install a key received in a `channel_key` content. `rotates_at` is an ISO timestamp.
    pub fn set(
        &mut self,
        channel_id: &str,
        epoch: i64,
        key_b64: &str,
        rotates_at: &str,
        replace_if_fingerprint_b64: Option<&str>,
    ) -> Result<SetKeyResult, ChannelError> {
        if channel_id.is_empty() {
            return Err(ChannelError::InvalidInstall("invalid channel id"));
        }
        if !is_valid_epoch(epoch) {
            return Err(ChannelError::InvalidInstall("invalid epoch (an integer 1..1,000,000 is required)"));
        }
        let key = parse_key_b64(key_b64).ok_or(ChannelError::InvalidInstall("channel key is not a 32-byte base64 key"))?;
        let rotates_ms = parse_iso_ms(rotates_at).ok_or(ChannelError::InvalidInstall("invalid rotatesAt"))?;
        let epoch = epoch as u32;
        let keys = self.channels.entry(channel_id.to_owned()).or_default();
        let fresh = Entry { key, rotates_at: to_iso(rotates_ms) };
        if let Some(existing) = keys.get(&epoch) {
            if bool::from(existing.key.ct_eq(fresh.key.as_ref())) {
                return Ok(SetKeyResult::Duplicate);
            }
            if replace_if_fingerprint_b64 == Some(key_fingerprint(&fresh.key).as_str()) {
                keys.insert(epoch, fresh);
                return Ok(SetKeyResult::Stored);
            }
            return Ok(SetKeyResult::Conflict);
        }
        keys.insert(epoch, fresh);
        Ok(SetKeyResult::Stored)
    }

    pub fn key(&self, channel_id: &str, epoch: u32) -> Option<Zeroizing<[u8; 32]>> {
        self.channels.get(channel_id)?.get(&epoch).map(|e| e.key.clone())
    }

    pub fn latest_epoch(&self, channel_id: &str) -> Option<u32> {
        self.channels.get(channel_id)?.keys().next_back().copied()
    }

    pub fn latest_rotates_at(&self, channel_id: &str) -> Option<&str> {
        self.channels.get(channel_id)?.values().next_back().map(|e| e.rotates_at.as_str())
    }

    pub fn epochs(&self, channel_id: &str) -> Vec<u32> {
        self.channels.get(channel_id).map(|k| k.keys().copied().collect()).unwrap_or_default()
    }

    pub fn fingerprint(&self, channel_id: &str, epoch: u32) -> Option<String> {
        self.channels.get(channel_id)?.get(&epoch).map(|e| key_fingerprint(&e.key))
    }

    pub fn fingerprints(&self, channel_id: &str) -> BTreeMap<u32, String> {
        self.channels
            .get(channel_id)
            .map(|k| k.iter().map(|(ep, e)| (*ep, key_fingerprint(&e.key))).collect())
            .unwrap_or_default()
    }

    /// Drop an epoch this device lost arbitration for, so it can re-request it.
    pub fn discard(&mut self, channel_id: &str, epoch: u32) -> bool {
        self.channels.get_mut(channel_id).is_some_and(|k| k.remove(&epoch).is_some())
    }

    /// Mint the next epoch key (`at_epoch` overrides "one past the highest held"). When another
    /// key already won that epoch, returns the STORED key, never the freshly generated one —
    /// the contract is "the returned key is the stored key".
    pub fn rotate(&mut self, channel_id: &str, at_epoch: Option<u32>, now_ms: i64) -> Result<MintedKey, ChannelError> {
        let epoch = at_epoch.unwrap_or_else(|| self.latest_epoch(channel_id).unwrap_or(0) + 1);
        let mut key_b64 = b64(crate::blob::generate_file_key().as_ref());
        let rotates_at = to_iso(now_ms + ROTATION_INTERVAL_MS);
        let set = self.set(channel_id, i64::from(epoch), &key_b64, &rotates_at, None);
        zeroize::Zeroize::zeroize(&mut key_b64);
        set?;
        let stored = &self.channels[channel_id][&epoch];
        Ok(MintedKey { epoch, key_b64: b64(stored.key.as_ref()), rotates_at: stored.rotates_at.clone() })
    }

    /// Drop epoch keys created more than 30 days ago, except the highest, the newest
    /// [`RETAIN_NEWEST_COUNT`], and any in `protected` (epochs a pinned message needs).
    pub fn prune(&mut self, now_ms: i64, protected: &HashMap<String, BTreeSet<u32>>) {
        let cutoff = now_ms - PRUNE_AFTER_MS;
        for (channel_id, keys) in &mut self.channels {
            let keep: BTreeSet<u32> = keys.keys().rev().take(RETAIN_NEWEST_COUNT.max(1)).copied().collect();
            let pinned = protected.get(channel_id);
            keys.retain(|epoch, e| {
                keep.contains(epoch)
                    || pinned.is_some_and(|p| p.contains(epoch))
                    || parse_iso_ms(&e.rotates_at).is_none_or(|r| r - ROTATION_INTERVAL_MS >= cutoff)
            });
        }
    }

    /// The stored form for one channel: `{"<epoch>": {"keyHex": …, "rotatesAt": …}}`.
    pub fn to_json(&self, channel_id: &str) -> String {
        let mut obj = Map::new();
        if let Some(keys) = self.channels.get(channel_id) {
            for (epoch, e) in keys {
                let mut entry = Map::new();
                entry.insert("keyHex".into(), hex(e.key.as_ref()).into());
                entry.insert("rotatesAt".into(), e.rotates_at.clone().into());
                obj.insert(epoch.to_string(), Value::Object(entry));
            }
        }
        let v = Value::Object(obj);
        let s = crate::js_json::stringify(&v);
        wipe(v); // the hex of every key lived in this tree
        s
    }

    /// Load one channel's stored form. Entries that could only have been written before
    /// validation existed (out-of-range or fractional epochs, wrong-length keys) are skipped,
    /// so a device that took one heals; they drop from storage on the next save.
    pub fn load_json(&mut self, channel_id: &str, json: &str) {
        let Some(parsed) = crate::js_json::parse(json) else { return };
        let Value::Object(obj) = parsed else { wipe(parsed); return };
        let keys = self.channels.entry(channel_id.to_owned()).or_default();
        for (epoch_str, entry) in &obj {
            let Ok(epoch) = epoch_str.parse::<i64>() else { continue };
            if !is_valid_epoch(epoch) || epoch.to_string() != *epoch_str {
                continue;
            }
            let (Some(key_hex), Some(rotates_at)) =
                (entry.get("keyHex").and_then(Value::as_str), entry.get("rotatesAt").and_then(Value::as_str))
            else {
                continue;
            };
            let Ok(raw) = from_hex(key_hex).map(Zeroizing::new) else { continue };
            let Ok(key) = <[u8; 32]>::try_from(raw.as_slice()) else { continue };
            if rotates_at.is_empty() {
                continue;
            }
            keys.insert(epoch as u32, Entry { key: Zeroizing::new(key), rotates_at: rotates_at.to_owned() });
        }
        wipe(Value::Object(obj));
    }
}

/// Overwrite every string inside a parsed / built JSON tree before it is dropped (the stored form
/// of a keyring carries each key as hex).
fn wipe(v: Value) {
    use zeroize::Zeroize;
    match v {
        Value::String(mut s) => s.zeroize(),
        Value::Array(a) => a.into_iter().for_each(wipe),
        Value::Object(o) => o.into_iter().for_each(|(mut k, v)| { k.zeroize(); wipe(v) }),
        _ => {}
    }
}

impl Drop for MintedKey {
    fn drop(&mut self) { use zeroize::Zeroize; self.key_b64.zeroize(); }
}
