//! Channel (server) messages: Sender Keys, the v2 context binding and the replay ledger.
//!
//! A channel has ONE shared AES-256-GCM key per epoch, so a message is encrypted once
//! whatever the member count (desktop `e2ee-engine.ts` `encryptChannelMessage`):
//!
//! ```text
//! nonce_b64      = base64(random 12 bytes)
//! ciphertext_b64 = base64( AES-256-GCM(channelKey, nonce).encrypt(plaintextJson) ‖ tag )
//! signature_b64  = base64( Ed25519(senderDeviceIdentity).sign(raw ciphertext bytes) )
//! ```
//!
//! Two differences from the DM envelope that are easy to get backwards: the signature covers
//! the raw ciphertext (no transcript hash), and the order is VERIFY then decrypt, because the
//! sender's identity key arrives with the message instead of inside it.
//!
//! The epoch key itself travels as `ClientContent{type:'channel_key'}` inside ordinary DM
//! envelopes ([`crate::envelope::encrypt_for_devices`]) — not a separate wire format.
pub mod binding;
pub mod keyring;
pub mod ledger;

use ed25519_dalek::SigningKey;
use zeroize::Zeroizing;

pub use binding::{bind_channel_content, verify_and_strip, BindingArrival, ChannelSender};
pub use keyring::{ChannelKeyring, MintedKey, SetKeyResult};
pub use ledger::{channel_message_id_tag, channel_replay_key, oldest_first, ReplayLedger};

use crate::blob;
use crate::encoding::{b64, from_b64_node};
use crate::keys;

pub const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

/// Why a channel message was refused. [`ChannelError::is_serve_rejection`] separates "the
/// server served this row wrongly — drop it" from "we cannot read it yet".
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ChannelError {
    #[error("[E2EE:CHANNEL_MALFORMED] {reason} (channel={channel_id})")]
    Malformed { reason: &'static str, channel_id: String },
    #[error("[E2EE] Channel message signature verification failed (channel={channel_id} epoch={epoch})")]
    SignatureInvalid { channel_id: String, epoch: u32 },
    #[error("Channel key for channel {channel_id} epoch {epoch} is not in the local store")]
    KeyMissing { channel_id: String, epoch: u32 },
    #[error("Unsupported state or unable to authenticate data")]
    AuthFailed,
    #[error("[E2EE:CHANNEL_BINDING] {what} mismatch (arrived channel={channel_id} epoch={epoch})")]
    Binding { what: &'static str, channel_id: String, epoch: u32 },
    #[error("[E2EE:CHANNEL_REPLAY] ciphertext already accepted under another message id (channel={channel_id})")]
    Replay { channel_id: String },
    #[error("invalid channel key install: {0}")]
    InvalidInstall(&'static str),
}

impl ChannelError {
    /// Desktop `isChannelServeRejection`: replay, binding and malformed rows must be DROPPED,
    /// never shown as a "waiting for key" placeholder.
    pub fn is_serve_rejection(&self) -> bool {
        matches!(self, Self::Replay { .. } | Self::Binding { .. } | Self::Malformed { .. })
    }

    /// The desktop tag (`CHANNEL_BINDING`, …) or `None` for the untagged errors.
    pub fn tag(&self) -> Option<&'static str> {
        match self {
            Self::Malformed { .. } => Some("CHANNEL_MALFORMED"),
            Self::Binding { .. } => Some("CHANNEL_BINDING"),
            Self::Replay { .. } => Some("CHANNEL_REPLAY"),
            _ => None,
        }
    }
}

/// The wire columns of one channel message (`POST /v1/channels/:id/messages` minus
/// `sender_device_id`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChannelWire {
    pub epoch: u32,
    pub nonce_b64: String,
    pub ciphertext_b64: String,
    pub signature_b64: String,
}

/// Encrypt `content_json` for a channel under `(epoch, key)`, binding it (v2) to the channel,
/// epoch, nonce, message id and — when given — this device's own ids.
pub fn encrypt_channel_message(
    key: &[u8; 32],
    channel_id: &str,
    epoch: u32,
    content_json: &str,
    sender: ChannelSender<'_>,
    identity: &SigningKey,
) -> Result<ChannelWire, ChannelError> {
    encrypt_channel_message_with(key, channel_id, epoch, content_json, sender, identity, blob::generate_iv(), random_uuid)
}

/// [`encrypt_channel_message`] with the randomness supplied — for reproducing vectors.
#[allow(clippy::too_many_arguments)]
pub fn encrypt_channel_message_with(
    key: &[u8; 32],
    channel_id: &str,
    epoch: u32,
    content_json: &str,
    sender: ChannelSender<'_>,
    identity: &SigningKey,
    nonce: [u8; NONCE_LEN],
    fallback_msg_id: impl FnOnce() -> String,
) -> Result<ChannelWire, ChannelError> {
    let nonce_b64 = b64(&nonce);
    let plaintext = bind_channel_content(content_json, channel_id, epoch, &nonce_b64, sender, fallback_msg_id);
    let ciphertext = blob::seal(key, &nonce, plaintext.as_bytes()).map_err(|_| ChannelError::AuthFailed)?;
    Ok(ChannelWire {
        epoch,
        nonce_b64,
        signature_b64: b64(&keys::sign(identity, &ciphertext)),
        ciphertext_b64: b64(&ciphertext),
    })
}

/// A channel message as it arrived from the server.
#[derive(Clone, Copy, Debug)]
pub struct ChannelArrival<'a> {
    /// The channel whose thread it will be shown in.
    pub channel_id: &'a str,
    pub epoch: u32,
    pub nonce_b64: &'a str,
    pub ciphertext_b64: &'a str,
    pub signature_b64: &'a str,
    pub sender_identity_pub_b64: &'a str,
    pub sender_user_id: Option<&'a str>,
    pub sender_device_id: Option<&'a str>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenedChannelMessage {
    /// The content JSON with `_cb` verified and stripped.
    pub content_json: String,
    /// The canonical nonce, for [`ReplayLedger::claim`].
    pub nonce_canon: String,
}

/// Verify, decrypt and check the binding of a channel message — desktop's order: structure
/// (`CHANNEL_MALFORMED`) → signature → key → GCM → binding. The replay ledger is NOT consulted;
/// the caller claims `(channel, nonce_canon)` right after this succeeds, before storing.
pub fn open_channel_message(
    arrival: &ChannelArrival<'_>,
    key_for_epoch: impl FnOnce(u32) -> Option<Zeroizing<[u8; 32]>>,
) -> Result<OpenedChannelMessage, ChannelError> {
    let channel_id = arrival.channel_id;
    let nonce = from_b64_node(arrival.nonce_b64);
    if nonce.len() != NONCE_LEN {
        return Err(ChannelError::Malformed { reason: "nonce must be 12 bytes", channel_id: channel_id.to_owned() });
    }
    let nonce_canon = b64(&nonce);
    let ciphertext = from_b64_node(arrival.ciphertext_b64);
    if ciphertext.len() < TAG_LEN {
        return Err(ChannelError::Malformed {
            reason: "ciphertext shorter than the GCM tag",
            channel_id: channel_id.to_owned(),
        });
    }
    let signature = from_b64_node(arrival.signature_b64);
    if !keys::verify(arrival.sender_identity_pub_b64, &ciphertext, &signature) {
        return Err(ChannelError::SignatureInvalid { channel_id: channel_id.to_owned(), epoch: arrival.epoch });
    }
    let key = key_for_epoch(arrival.epoch)
        .ok_or_else(|| ChannelError::KeyMissing { channel_id: channel_id.to_owned(), epoch: arrival.epoch })?;
    let plaintext = blob::open(key.as_ref(), &nonce, &ciphertext).map_err(|_| ChannelError::AuthFailed)?;
    // Node's `toString('utf8')`: invalid sequences become U+FFFD rather than failing.
    let text = String::from_utf8_lossy(&plaintext);
    let content_json = verify_and_strip(
        &text,
        &BindingArrival {
            channel_id,
            epoch: arrival.epoch,
            nonce_canon: &nonce_canon,
            sender_user_id: arrival.sender_user_id,
            sender_device_id: arrival.sender_device_id,
        },
    )?;
    Ok(OpenedChannelMessage { content_json, nonce_canon })
}

/// A random RFC 4122 v4 UUID, lowercase — the shape of `crypto.randomUUID()`.
pub fn random_uuid() -> String {
    let mut b = [0u8; 16];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = crate::encoding::hex(&b);
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}
