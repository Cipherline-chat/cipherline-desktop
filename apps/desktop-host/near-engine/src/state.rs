//! The observable state machine, serialised exactly as `apps/desktop/src/types/near.ts` declares it.
//! State names are DEFINED HERE (the phone lane's near-sync handoff did not exist yet): see the work-log
//! entry for the list to reconcile.
use super::netdiag::AdapterCensus;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NearState {
    Idle,
    CreatingSession,
    ShowingCode,
    PeerConnected,
    Negotiating,
    ProvingBle,
    ProvingLan,
    ProofVerified,
    AwaitingApproval,
    Approving,
    Approved,
    Transferring,
    TransferPaused,
    Done,
    Refused,
    Expired,
    Cancelled,
    Failed,
}

impl NearState {
    pub fn is_terminal(self) -> bool {
        matches!(self, NearState::Done | NearState::Refused | NearState::Expired | NearState::Cancelled | NearState::Failed)
    }
    /// The forward edges the engine may take. A transition outside this table is a bug and is refused,
    /// so the renderer can rely on the order (e.g. nothing reaches `Approving` without `ProofVerified`).
    pub fn may_go(self, to: NearState) -> bool {
        use NearState::*;
        if self.is_terminal() {
            return to == Idle;
        }
        if matches!(to, Cancelled | Failed | Expired | Refused) {
            return true;
        }
        matches!(
            (self, to),
            (Idle, CreatingSession)
                | (CreatingSession, ShowingCode)
                | (Idle, PeerConnected) // approver: scanning a code is the hello
                | (CreatingSession, PeerConnected)
                | (CreatingSession, AwaitingApproval) // own-device transfer: the request / the sheet needs no code and no hello
                | (AwaitingApproval, PeerConnected) // own-device transfer: the other person said yes, the channel opens
                | (Approving, PeerConnected) // own-device transfer, sender: approved first, proximity after
                | (Approved, PeerConnected)
                | (ProofVerified, Approved)
                | (ShowingCode, ShowingCode)
                | (ShowingCode, PeerConnected)
                | (PeerConnected, Negotiating)
                | (Negotiating, ProvingBle)
                | (Negotiating, ProvingLan)
                | (ProvingBle, ProvingLan)
                | (ProvingBle, ProofVerified)
                | (ProvingLan, ProofVerified)
                | (ProvingBle, AwaitingApproval) // new device: it only helps, it never verifies
                | (ProvingLan, AwaitingApproval)
                | (Negotiating, AwaitingApproval)
                | (ProofVerified, AwaitingApproval)
                | (AwaitingApproval, Approving)
                | (Approving, AwaitingApproval) // gate cancelled: back to the screen
                | (Approving, Approved)
                | (AwaitingApproval, Approved) // new device: the grant arrived
                | (Approved, Transferring)
                | (Approving, Transferring)
                | (Transferring, TransferPaused)
                | (TransferPaused, Transferring)
                | (Transferring, Done)
                | (Approved, Done)
        )
    }
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NearCode {
    pub uri: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub typed: Option<String>,
    pub rotates_at_ms: i64,
    pub session_ends_at_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearTransfer {
    pub direction: &'static str,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub records_done: u32,
    pub records_total: u32,
    pub attempt: u32,
    /// A pause (contract 11.9): `paused_by` says who. Distinct from `interrupted` (the connection dropped).
    pub paused: bool,
    /// `me` | `peer`, with `paused`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused_by: Option<&'static str>,
    /// The connection dropped and the host is reconnecting (state `transfer_paused`), as opposed to `paused`.
    pub interrupted: bool,
}

/// The other device as it described itself INSIDE the sealed channel (contract 11.2): the label is what the peer sent in
/// its `caps`, sanitised, never the server-relayed session label. `label_sealed` is false only when the peer sent no
/// label at all (the label is then a neutral placeholder). Either way it is a claim the other device makes about itself.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearPeer {
    pub label: String,
    pub platform: Option<String>,
    pub label_sealed: bool,
    /// Approver only, once a proof exists: the new device's identity public key (standard base64) the approval will be signed for. What the
    /// sheet shows is what gets signed: Electron main records it from the awaiting-approval snapshot (L3) and signs nothing else.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_key: Option<String>,
}

/// What the approving device last told this (new) device it is doing (contract 11.17 `status`). Informational: it never
/// unlocks anything, it only lets the new device's screen say which proof is being tried and which one held.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct NearPeerStatus {
    /// `checking_ble` | `checking_lan` | `proof_ok` | `awaiting_user`
    pub stage: &'static str,
    /// `ble` | `lan`, with `proof_ok`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proximity: Option<&'static str>,
}

/// Which proof is being tried and what the screen should tell the user (hints are stable names).
#[derive(Clone, Debug, Serialize)]
pub struct NearAttempt {
    /// `ble` | `lan`
    pub proof: &'static str,
    /// `scanning` | `listening` | `dialing` | `probing_for_transfer`
    pub hint: &'static str,
}

/// Why each proof did not hold, for the refusal screen (contract 11.3 vocabulary).
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct NearRefusal {
    /// `ok` | `off` | `denied` | `no_adapter` | `not_found` | `skipped`
    pub ble: &'static str,
    /// `ok` | `not_found` | `denied` | `firewall` | `skipped`
    pub lan: &'static str,
}

/// What a stopped transfer left (contract 11.10: "Keep what arrived").
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearPartial {
    pub records_held: u32,
    pub records_total: u32,
    pub bytes_held: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct NearBle {
    /// `idle` | `scanning` | `heard` | `fell_through`
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearSnapshot {
    pub seq: u64,
    pub role: Option<&'static str>,
    pub state: NearState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<NearCode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer: Option<NearPeer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proximity: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt: Option<NearAttempt>,
    /// New device only: the approver's latest `status` message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_status: Option<NearPeerStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ble: Option<NearBle>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refusal: Option<NearRefusal>,
    /// Approver only: the local-network probe that runs after a Bluetooth proof found a path, so
    /// "Approve and transfer history" may be offered. Absent until known; false is not a refusal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer_offerable: Option<bool>,
    /// Approver only (F3 policy): the history may be offered at approval time ONLY after a Bluetooth proof. `false` after a
    /// local-network-only proof: the sheet says "same network", offers Approve only, and points to Settings once signed in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_allowed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial: Option<NearPartial>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub envelope_b64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfer: Option<NearTransfer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<NearError>,
    /// Counts / words for the diagnostic report (see [`NearDiag`]).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diag: Option<NearDiag>,
}

/// What a failed (or finished) own-device transfer can tell a diagnostic report, as counts, booleans and closed words ONLY: never an
/// address, a MAC, an SSID, an adapter or device name, a user id or content (see `netdiag.rs`). Absent until the session learns something.
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NearDiag {
    /// This device's adapters: how many were eligible, which types, and why the others were filtered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapters: Option<AdapterCensus>,
    /// This device could listen / dial on the local network at all (its `caps`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lan_usable: Option<bool>,
    /// The other device said it could listen / dial.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peer_lan: Option<bool>,
    /// `listen` | `dial` | `none`: this device's part in the local-network leg.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lan_plan: Option<&'static str>,
    /// The other device's offered address was on-link for one of this device's interfaces (dialer), or no off-link source knocked (listener).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub same_subnet: Option<bool>,
    /// How many addresses were dialled.
    pub dial_attempts: u32,
    /// `ok` | `off_link` | `bad_offer` | `timeout` | `refused` | `blocked` | `auth` | `tls` | `io` | `listen_timeout` | `listen_blocked` | `no_offer`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lan_result: Option<&'static str>,
    /// Why the local-network leg did not hold: `different_network` | `no_usable_network` | `peer_no_usable_network` | `no_answer` | `not_found`
    /// | `denied` | `firewall`. The wire keeps cl-near's older closed set (`netdiag::wire_lan_cause`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lan_fail: Option<&'static str>,
    /// How the session ended, set with the terminal state: `ok` | `declined` | `busy` | `cancelled` | `peer_cancelled` | `different_network` |
    /// `no_usable_network` | `peer_no_usable_network` | `no_answer` | `not_found` | `denied` | `firewall` | `expired` | `refused` | `failed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
pub struct NearError {
    pub code: String,
    pub message: String,
}

impl NearSnapshot {
    pub fn idle() -> Self {
        Self { seq: 0, role: None, state: NearState::Idle, link_id: None, code: None, peer: None, proximity: None, attempt: None, peer_status: None, ble: None, refusal: None, transfer_offerable: None, history_allowed: None, partial: None, envelope_b64: None, transfer: None, error: None, diag: None }
    }
}

/// Holds the snapshot and enforces the transition table.
pub struct Machine {
    snap: NearSnapshot,
}

impl Machine {
    pub fn new() -> Self {
        Self { snap: NearSnapshot::idle() }
    }
    pub fn snapshot(&self) -> &NearSnapshot {
        &self.snap
    }
    /// Move to `to`; the caller then edits fields through `edit`. Returns the new snapshot, or Err on an illegal edge.
    pub fn go(&mut self, to: NearState, edit: impl FnOnce(&mut NearSnapshot)) -> Result<NearSnapshot, String> {
        if self.snap.state != to && !self.snap.state.may_go(to) {
            return Err(format!("illegal transition {:?} -> {:?}", self.snap.state, to));
        }
        if self.snap.state.is_terminal() && to == NearState::Idle {
            let seq = self.snap.seq;
            self.snap = NearSnapshot::idle();
            self.snap.seq = seq;
        }
        self.snap.state = to;
        edit(&mut self.snap);
        self.snap.seq += 1;
        Ok(self.snap.clone())
    }
}

impl Default for Machine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use NearState::*;

    #[test]
    fn serialises_as_the_typescript_types_declare() {
        let mut m = Machine::new();
        m.go(CreatingSession, |s| s.role = Some("new_device")).unwrap();
        let s = m.go(ShowingCode, |s| s.code = Some(NearCode { uri: "cipherline://near/1?x".into(), typed: Some("ABCD-EFGH".into()), rotates_at_ms: 5, session_ends_at_ms: 9 })).unwrap();
        let j = serde_json::to_value(&s).unwrap();
        assert_eq!(j["state"], "showing_code");
        assert_eq!(j["role"], "new_device");
        assert_eq!(j["code"]["rotatesAtMs"], 5);
        assert_eq!(j["code"]["sessionEndsAtMs"], 9);
        assert!(j.get("envelopeB64").is_none());
    }

    #[test]
    fn nothing_reaches_approving_without_a_verified_proof() {
        for from in [Idle, ShowingCode, PeerConnected, Negotiating, ProvingBle, ProvingLan, Approved, Transferring] {
            assert!(!from.may_go(Approving), "{from:?} must not reach Approving");
        }
        assert!(AwaitingApproval.may_go(Approving));
        // and AwaitingApproval is only reachable from a verified proof on the approver path
        assert!(ProofVerified.may_go(AwaitingApproval));
    }

    #[test]
    fn full_approver_path_and_illegal_edges() {
        let mut m = Machine::new();
        for s in [PeerConnected, Negotiating, ProvingBle, ProvingLan, ProofVerified, AwaitingApproval, Approving, Approved, Transferring, TransferPaused, Transferring, Done] {
            m.go(s, |_| {}).unwrap_or_else(|e| panic!("{e}"));
        }
        assert!(m.go(Approving, |_| {}).is_err(), "terminal states only go to idle");
        m.go(Idle, |_| {}).unwrap();
        assert!(m.go(Approving, |_| {}).is_err());
        assert!(m.go(Transferring, |_| {}).is_err());
    }

    #[test]
    fn seq_only_increases() {
        let mut m = Machine::new();
        let a = m.go(CreatingSession, |_| {}).unwrap().seq;
        let b = m.go(Cancelled, |_| {}).unwrap().seq;
        let c = m.go(Idle, |_| {}).unwrap().seq;
        assert!(a < b && b < c);
    }
}
