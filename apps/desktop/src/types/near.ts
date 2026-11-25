/**
 * Proximity sign-in ("near") and local history transfer: the renderer's view of the host bridge.
 *
 * Implemented by the Rust host (Cipherline Next, `apps/desktop-host/src/near/`) and, for the own-device history
 * TRANSFER subset only, by the Electron build through the near-helper child process (`electron/near-bridge.ts`,
 * macOS / Linux / Windows). A build without the helper exposes `nearProbe()` -> `{ available: false }`, so a screen must
 * treat that as "this build cannot do local transfer / proximity" and keep today's behaviour. The proximity sign-in
 * members of this file are not served by the Electron helper. Wire contract: `docs/plans/proximity-signin-protocol.md` (sections 3-6 and 10).
 *
 * Mirrors `apps/desktop-host/src/near/state.rs` (`NearSnapshot`); kept in sync by hand, like `types/link.ts`.
 * Nothing here ever carries a key, a proof or a typed secret except the code the NEW device is meant to
 * display, and the sealed grant envelope (opaque; open it with `linkOpen`).
 */

/** Adapter state, as the host learned it within the contract's 3 s cap. */
export type NearBluetoothState =
    | 'ready'        // a usable LE radio: scanning will run
    | 'no_adapter'   // no radio / no driver
    | 'radio_off'    // the user switched Bluetooth off
    | 'denied'       // the OS denied radio access (privacy setting / consent)
    | 'error'        // the platform answered with an error
    | 'timeout'      // no answer within 3 s
    | 'unsupported'; // this host never scans (Electron, or a non-Windows dev host)

export interface NearCapabilities {
    /** False on the Electron build: every other member rejects or returns an empty state. */
    available: boolean;
    bluetooth: NearBluetoothState;
    bluetoothDetail?: string;
    /** On-link interfaces exist (the local-network proof is possible at all). */
    lan: boolean;
    /** The host can pause a transfer (`nearTransferPause` / `nearTransferResume` work). */
    pause?: boolean;
    /** Windows Hello usable for the approval gate. */
    biometric: 'available' | 'unavailable';
    /** What `nearApprove` will ask for: the platform biometric (Windows Hello / Touch ID) when available, else a native confirm the
     *  page cannot click (Windows host), else `password`: the Electron build asks the page for the account's step-up secret
     *  (`onNearGatePrompt` / `nearGateSubmit`), which MAIN verifies with the server. */
    gate: 'hello' | 'native_confirm' | 'password';
}

/** One observable state machine. Same names as the phone core's session (see near-sync handoff). */
export type NearState =
    | 'idle'
    | 'creating_session'
    | 'showing_code'      // new device / invite owner: the code is on screen and rotating
    | 'peer_connected'    // hello / hello_ack verified: the other device really scanned or typed the code
    | 'negotiating'       // capabilities exchanged, planning who advertises / listens
    | 'proving_ble'       // Bluetooth attempt running (<= 12 s scan)
    | 'proving_lan'       // local-network attempt running
    | 'proof_verified'    // approver only: a proximity proof was verified (`proximity` says which)
    | 'awaiting_approval' // approver: show the approval screen; new device: "waiting for the other device"
    | 'approving'         // approver: gate + sign + approve + grant in flight
    | 'approved'          // new device: `envelopeB64` is set, continue with linkOpen + claim
    | 'transferring'
    | 'transfer_paused'   // connection dropped; resuming on a new authenticated connection
    | 'done'
    | 'refused'           // no proximity, or the other side declined / the server burned the session
    | 'expired'
    | 'cancelled'
    | 'failed';

/** `own_receiver` / `own_sender`: the two roles of a transfer between this account's own devices (contract section 7). */
export type NearRole = 'new_device' | 'approver' | 'own_receiver' | 'own_sender';
export type NearProximity = 'ble' | 'lan';

export interface NearCode {
    /** The compact `CLN1:...` payload (contract 11.14) the symbol is drawn from; the `cipherline://near...` URI forms still parse. Render it locally. */
    uri: string;
    /** `XXXX-XXXX` (typed mode only; constant for the session). */
    typed?: string;
    /** When this `uri` stops being accepted for NEW scans (the secret rotates every 30 s). */
    rotatesAtMs: number;
    /** When the link session ends (~120 s); the host opens a replacement before that. */
    sessionEndsAtMs: number;
}

export interface NearTransferStatus {
    direction: 'send' | 'receive';
    bytesDone: number;
    bytesTotal: number;
    recordsDone: number;
    recordsTotal: number;
    /** Connection attempts so far (1 = no drop yet). */
    attempt: number;
    /** Somebody paused (contract 11.9); `pausedBy` says who. Distinct from `interrupted` (the connection dropped). */
    paused: boolean;
    pausedBy?: 'me' | 'peer';
    /** The connection dropped and the host is reconnecting (state `transfer_paused`); distinct from `paused`. */
    interrupted: boolean;
}

/** Which proof is being tried and what to tell the user while it runs. */
export interface NearAttempt {
    proof: 'ble' | 'lan';
    hint: 'scanning' | 'listening' | 'dialing' | 'probing_for_transfer';
}

/** What the approving device last said it is doing (informational only: it never unlocks anything on this device). */
export interface NearPeerStatus {
    stage: 'checking_ble' | 'checking_lan' | 'proof_ok' | 'awaiting_user';
    /** With `proof_ok`: which proof held. */
    proximity?: NearProximity;
}

/** Why each proof did not hold (contract 11.3 vocabulary) for the refusal screen. */
export interface NearRefusal {
    ble: 'ok' | 'off' | 'denied' | 'no_adapter' | 'not_found' | 'skipped';
    lan: 'ok' | 'not_found' | 'denied' | 'firewall' | 'skipped';
}

/** What a stopped transfer left (contract 11.10, "Keep what arrived"). */
export interface NearPartial {
    recordsHeld: number;
    recordsTotal: number;
    bytesHeld: number;
}

export interface NearSnapshot {
    /** Increases on every change; drop an event whose `seq` is lower than one you already applied. */
    seq: number;
    role: NearRole | null;
    state: NearState;
    linkId?: string;
    code?: NearCode;
    /** The other device as it described itself INSIDE the sealed channel (contract 11.2), never the server-relayed label.
     *  Untrusted display text. `labelSealed: false` = the peer sent no label (`label` is a neutral placeholder). */
    peer?: { label: string; platform: string | null; labelSealed: boolean;
        /** Approver only, once a proof exists: the new device's identity public key (standard base64) the approval is signed for. Main records
         *  it from the awaiting-approval snapshot (review L3) and signs nothing else. */
        identityKey?: string };
    /** New device only: the approver's latest informational `status` (contract 11.17): which proof it is trying, which held. */
    peerStatus?: NearPeerStatus;
    attempt?: NearAttempt;
    refusal?: NearRefusal;
    /** Approver: false/true once the local-network probe after a Bluetooth proof is done; absent until known. */
    transferOfferable?: boolean;
    /** Approver (security review F3): the history may be offered at approval time ONLY after a Bluetooth proof. `false` after a local-network-only
     *  proof: the sheet says "same network", offers Approve only, and points to the own-device transfer in Settings once signed in. */
    historyAllowed?: boolean;
    partial?: NearPartial;
    proximity?: NearProximity;
    ble?: { status: 'idle' | 'scanning' | 'heard' | 'fell_through'; reason?: string };
    /** New device only, with `state: 'approved'`: pass to `linkOpen(envelopeB64, linkId)`. */
    envelopeB64?: string;
    transfer?: NearTransferStatus;
    /** Set with `refused` / `failed` / `expired`. `code` is stable; `message` is for logs. */
    error?: { code: string; message: string };
}

export interface NearAuth {
    accessToken: string;
    userId: string;
    deviceId: string;
}

export type NearScanInput = { kind: 'qr'; text: string } | { kind: 'typed'; code: string };

export type NearGateKind = 'hello' | 'native_confirm' | 'password';
export type NearApproveResult =
    | { result: 'approved'; gate: NearGateKind }
    | { result: 'cancelled' | 'failed'; gate: NearGateKind; error?: string };

/** Electron only: main asks for the account secret while `nearApprove` is in flight (gate `password`). `closed` ends the prompt. */
export interface NearGatePrompt { ticket: string; method: 'password' | 'totp'; closed?: boolean }
export type NearGateSubmitResult = 'ok' | 'rejected' | 'rate_limited' | 'unavailable' | 'locked' | 'expired';

export type NearBiometricResult = 'verified' | 'cancelled' | 'failed';

/** What the receiving device holds after a completed transfer: one container file under the backup
 *  staging dir (`backupStagingDir()`), readable with `backupStat` / `backupReadRange`. */
export interface NearReceivedHistory {
    path: string;
    size: number;
}

/** "Keep what arrived": a container file of the full size holding only the verified parts (the rest is zero), and the byte
 *  ranges `[offset, length]` that are real. A record is applicable only if all of its bytes lie inside one range. */
export interface NearPartialFile {
    path: string;
    size: number;
    ranges: [number, number][];
    partsHeld: number;
    partsTotal: number;
}
