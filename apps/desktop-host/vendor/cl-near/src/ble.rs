//! Section 4.1: Bluetooth proximity, MATH ONLY. The platforms drive the radio; this module makes and
//! recognises the advertised UUID, makes and checks the `ble_heard` MAC, plans who advertises, and
//! tracks the timings of the fall-through to the local network.
use std::time::{Duration, Instant};

use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit};
use aes::Aes128;
use hmac::{Hmac, Mac};
use rand_core::{OsRng, RngCore};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::approval::Proximity;
use crate::keys::SessionKeys;
use crate::proof::ProximityProof;
use crate::relay::{Caps, Side};

/// Suffix of the single AES block: "CLN1".
pub const MAGIC: [u8; 4] = *b"CLN1";
pub const ADVERTISE_CAP: Duration = Duration::from_secs(20);
pub const ADAPTER_STATE_CAP: Duration = Duration::from_secs(3);
pub const SCAN_CAP: Duration = Duration::from_secs(12);

/// `U = AES-128-Encrypt(K_ble, r || "CLN1")`: the 128-bit service UUID to advertise (big-endian byte order
/// is the canonical UUID text order).
pub fn advert_uuid(k_ble: &[u8; 16], r: &[u8; 12]) -> [u8; 16] {
    let mut block = [0u8; 16];
    block[..12].copy_from_slice(r);
    block[12..].copy_from_slice(&MAGIC);
    let mut b = GenericArray::from(block);
    Aes128::new(GenericArray::from_slice(k_ble)).encrypt_block(&mut b);
    b.into()
}

/// Decrypt a service UUID seen while scanning. `Some(r)` only if the block ends in "CLN1", i.e. it was
/// made under our `K_ble`. A foreign UUID passes by chance with probability 2^-32.
pub fn open_uuid(k_ble: &[u8; 16], uuid: &[u8; 16]) -> Option<[u8; 12]> {
    let mut b = GenericArray::from(*uuid);
    Aes128::new(GenericArray::from_slice(k_ble)).decrypt_block(&mut b);
    let b: [u8; 16] = b.into();
    if bool::from(b[12..].ct_eq(&MAGIC)) {
        let mut r = [0u8; 12];
        r.copy_from_slice(&b[..12]);
        Some(r)
    } else {
        None
    }
}

/// Canonical 8-4-4-4-12 lower-case text of a UUID, as the platform BLE APIs take it.
pub fn uuid_string(u: &[u8; 16]) -> String {
    let h: String = u.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

pub fn parse_uuid(s: &str) -> Option<[u8; 16]> {
    let h: String = s.chars().filter(|c| *c != '-').collect();
    if h.len() != 32 || s.len() != 36 || ![8, 13, 18, 23].iter().all(|i| s.as_bytes()[*i] == b'-') { return None; }
    let mut out = [0u8; 16];
    for i in 0..16 {
        out[i] = u8::from_str_radix(h.get(2 * i..2 * i + 2)?, 16).ok()?;
    }
    Some(out)
}

/// `ble_heard` MAC: `HMAC(K_conf, "ble" || r)`.
pub fn heard_mac(keys: &SessionKeys, r: &[u8; 12]) -> [u8; 32] {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(keys.conf.as_ref()).expect("any key length");
    m.update(b"ble");
    m.update(r);
    m.finalize().into_bytes().into()
}

/// `ble_ack` MAC: `HMAC(K_conf, "ble-ack" || r)` (L1). Sent by the advertiser once it has verified a `ble_heard` for the nonce `r`; a scanning A
/// takes the Bluetooth proof only from this, because only a peer that holds `K` AND really advertised `r` can produce it.
pub fn ack_mac(keys: &SessionKeys, r: &[u8; 12]) -> [u8; 32] {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(keys.conf.as_ref()).expect("any key length");
    m.update(b"ble-ack");
    m.update(r);
    m.finalize().into_bytes().into()
}

/// The advertiser's side: a nonce per advertisement, remembered so a `ble_heard` can be checked.
pub struct Advertiser {
    nonces: Vec<[u8; 12]>,
}

impl Advertiser {
    pub fn new() -> Self { Self { nonces: vec![] } }
    /// A fresh nonce and the UUID to advertise. (Callers may rotate it; every nonce stays acceptable.)
    pub fn next_advert(&mut self, keys: &SessionKeys) -> (/* r */ [u8; 12], /* U */ [u8; 16]) {
        let mut r = [0u8; 12];
        OsRng.fill_bytes(&mut r);
        self.nonces.push(r);
        if self.nonces.len() > 8 { self.nonces.remove(0); }
        (r, advert_uuid(&keys.ble, &r))
    }
    /// Does `mac` prove the sender heard one of OUR advertisements? Constant-time per candidate.
    pub fn verify_heard(&self, keys: &SessionKeys, mac: &[u8; 32]) -> bool {
        let mut ok = false;
        for r in &self.nonces {
            ok |= bool::from(heard_mac(keys, r).ct_eq(mac));
        }
        ok
    }
}

impl Advertiser {
    /// The `ble_ack` to send for a `ble_heard` that verifies against one of OUR advertisements; `None` for anything else.
    pub fn ack_for_heard(&self, keys: &SessionKeys, mac: &[u8; 32]) -> Option<[u8; 32]> {
        self.nonces.iter().find(|r| bool::from(heard_mac(keys, r).ct_eq(mac))).map(|r| ack_mac(keys, r))
    }

    /// A valid `ble_heard` for one of our advertisements is the Bluetooth proof (when we are A).
    pub fn prove_heard(&self, keys: &SessionKeys, link_id: &str, mac: &[u8; 32]) -> Option<ProximityProof> {
        self.verify_heard(keys, mac).then(|| ProximityProof::new(Proximity::Ble, link_id))
    }
}

impl Default for Advertiser {
    fn default() -> Self { Self::new() }
}

/// The scanner's side: feed every 128-bit service UUID seen; the first ours yields `r` and the MAC to send.
pub struct Scanner<'k> {
    keys: &'k SessionKeys,
}

impl<'k> Scanner<'k> {
    pub fn new(keys: &'k SessionKeys) -> Self { Self { keys } }
    /// `Some((r, mac))` when `uuid` is a valid advertisement for this session.
    pub fn on_uuid(&self, uuid: &[u8; 16]) -> Option<([u8; 12], [u8; 32])> {
        let r = open_uuid(&self.keys.ble, uuid)?;
        Some((r, heard_mac(self.keys, &r)))
    }
}

impl Scanner<'_> {
    /// The Bluetooth proof, from the advertiser's `ble_ack` for the nonce `r` we heard (L1). Hearing a valid UUID ([`Scanner::on_uuid`]) is NOT
    /// the proof: its tag is 32 bits, so a stranger's random advertisement passes it once in 2^32. Constant-time compare.
    pub fn prove_ack(&self, link_id: &str, r: &[u8; 12], ack: &[u8; 32]) -> Option<ProximityProof> {
        bool::from(ack_mac(self.keys, r).ct_eq(ack)).then(|| ProximityProof::new(Proximity::Ble, link_id))
    }
}

// ---- planning -------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BlePlan {
    pub advertiser: Side,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LanPlan {
    pub listener: Side,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProximityPlan {
    pub ble: Option<BlePlan>,
    pub lan: Option<LanPlan>,
    /// Linux desktops run 4.1 and 4.2 together; everyone else tries Bluetooth first and falls through.
    pub concurrent: bool,
}

/// Who advertises and who listens, from both sides' capabilities.
///
/// Bluetooth: "phones advertise; desktops only scan; phone to phone, N advertises, A scans". So N advertises
/// when N can and A can scan; else A advertises when A can and N can scan; else no Bluetooth.
/// LAN: "the phone when exactly one side is a phone (by `caps.kind`); otherwise A". If that side cannot listen (or the
/// other cannot dial) the roles are swapped, and if neither works there is no LAN path.
pub fn plan(a: &Caps, n: &Caps, concurrent: bool) -> ProximityPlan {
    let ble = if n.ble_adv && a.ble_scan {
        Some(BlePlan { advertiser: Side::N })
    } else if a.ble_adv && n.ble_scan {
        Some(BlePlan { advertiser: Side::A })
    } else {
        None
    };
    // Contract 4.2 + 11.6: the phone when exactly one side is a phone; desktop to desktop, the side that is NOT Windows (a listening
    // socket on Windows raises a firewall prompt); otherwise A.
    let preferred = match (a.is_phone(), n.is_phone()) {
        (true, false) => Side::A,
        (false, true) => Side::N,
        (false, false) if a.os == crate::relay::Os::Windows && n.os != crate::relay::Os::Windows => Side::N,
        _ => Side::A,
    };
    let works = |l: Side| {
        let (lc, dc) = if l == Side::A { (a, n) } else { (n, a) };
        lc.lan_listen && dc.lan_dial
    };
    let lan = if works(preferred) {
        Some(LanPlan { listener: preferred })
    } else if works(preferred.other()) {
        Some(LanPlan { listener: preferred.other() })
    } else {
        None
    };
    ProximityPlan { ble, lan, concurrent }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FallReason {
    /// The platform said Bluetooth is off, unavailable or permission was denied.
    NoAdapter,
    /// No adapter state within 3 s.
    AdapterTimeout,
    /// Scanner: nothing valid heard within 12 s.
    NothingHeard,
    /// Advertiser: no valid `ble_heard` within 20 s.
    NoHeardMac,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BleStatus {
    WaitingForAdapter,
    Running,
    /// Proof obtained; the Bluetooth path is done.
    Proven,
    /// Give up on Bluetooth and use 4.2.
    FellThrough(FallReason),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BleRole {
    Advertise,
    Scan,
}

/// Timing state machine for one side's Bluetooth attempt. Pure: the caller passes `Instant`s.
#[derive(Debug)]
pub struct BleProbe {
    role: BleRole,
    started: Instant,
    running_since: Option<Instant>,
    status: BleStatus,
}

impl BleProbe {
    pub fn new(role: BleRole, now: Instant) -> Self {
        Self { role, started: now, running_since: None, status: BleStatus::WaitingForAdapter }
    }
    pub fn status(&self) -> BleStatus { self.status }
    pub fn role(&self) -> BleRole { self.role }

    fn terminal(&self) -> bool { matches!(self.status, BleStatus::Proven | BleStatus::FellThrough(_)) }

    /// The platform reported the adapter state. `usable == false` (off, absent, denied) falls through at once.
    pub fn adapter_state(&mut self, usable: bool, now: Instant) -> BleStatus {
        if self.terminal() { return self.status; }
        if usable {
            if self.status == BleStatus::WaitingForAdapter {
                self.running_since = Some(now);
                self.status = BleStatus::Running;
            }
        } else {
            self.status = BleStatus::FellThrough(FallReason::NoAdapter);
        }
        self.status
    }

    /// The proof arrived (scanner heard a valid UUID, or advertiser got a valid `ble_heard`).
    pub fn proof(&mut self) -> BleStatus {
        if !matches!(self.status, BleStatus::FellThrough(_)) { self.status = BleStatus::Proven; }
        self.status
    }

    /// Advance the clock.
    pub fn tick(&mut self, now: Instant) -> BleStatus {
        if self.terminal() { return self.status; }
        match (self.status, self.running_since) {
            (BleStatus::WaitingForAdapter, _) if now.saturating_duration_since(self.started) >= ADAPTER_STATE_CAP => {
                self.status = BleStatus::FellThrough(FallReason::AdapterTimeout);
            }
            (BleStatus::Running, Some(t0)) => {
                let (cap, why) = match self.role {
                    BleRole::Scan => (SCAN_CAP, FallReason::NothingHeard),
                    BleRole::Advertise => (ADVERTISE_CAP, FallReason::NoHeardMac),
                };
                if now.saturating_duration_since(t0) >= cap { self.status = BleStatus::FellThrough(why); }
            }
            _ => {}
        }
        self.status
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys;

    fn keys_pair() -> (SessionKeys, SessionKeys) {
        let (en, en_pub) = keys::generate_keypair();
        let (ea, ea_pub) = keys::generate_keypair();
        (keys::session_keys(&ea, &en_pub, &[1; 16], "l").unwrap(), keys::session_keys(&en, &ea_pub, &[1; 16], "l").unwrap())
    }

    fn phone() -> Caps { Caps { os: crate::relay::Os::Android, kind: crate::relay::DeviceKind::Phone, ble_adv: true, ble_scan: true, lan_listen: true, lan_dial: true } }
    fn desktop() -> Caps { Caps { os: crate::relay::Os::Linux, kind: crate::relay::DeviceKind::Desktop, ble_adv: false, ble_scan: true, lan_listen: true, lan_dial: true } }

    #[test]
    fn desktop_to_desktop_the_non_windows_side_listens() {
        let (mut win, mut mac) = (desktop(), desktop());
        win.os = crate::relay::Os::Windows;
        mac.os = crate::relay::Os::Mac;
        assert_eq!(plan(&win, &mac, false).lan, Some(LanPlan { listener: Side::N }), "A is Windows: N listens");
        assert_eq!(plan(&mac, &win, false).lan, Some(LanPlan { listener: Side::A }));
        assert_eq!(plan(&win, &win, false).lan, Some(LanPlan { listener: Side::A }), "both Windows: A listens");
        assert_eq!(plan(&mac, &mac, false).lan, Some(LanPlan { listener: Side::A }), "neither Windows: A listens");
    }

    #[test]
    fn uuid_round_trip_and_wrong_key() {
        let (ka, kn) = keys_pair();
        let r = [7u8; 12];
        let u = advert_uuid(&ka.ble, &r);
        assert_eq!(open_uuid(&kn.ble, &u), Some(r));
        let (other, _) = keys_pair();
        assert_eq!(open_uuid(&other.ble, &u), None);
        // random foreign UUIDs are not ours
        let mut hits = 0;
        for i in 0..5000u32 {
            let mut f = [0u8; 16];
            f[..4].copy_from_slice(&i.to_be_bytes());
            f[4..8].copy_from_slice(&i.wrapping_mul(2654435761).to_be_bytes());
            if open_uuid(&ka.ble, &f).is_some() { hits += 1; }
        }
        assert_eq!(hits, 0);
        assert_ne!(advert_uuid(&ka.ble, &[8u8; 12]), u);
        let s = uuid_string(&u);
        assert_eq!(s.len(), 36);
        assert_eq!(parse_uuid(&s), Some(u));
        assert_eq!(parse_uuid(&s.to_uppercase()), Some(u));
        assert_eq!(parse_uuid(&s.replace('-', "")), None);
    }

    #[test]
    fn heard_mac_flow_both_directions() {
        let (ka, kn) = keys_pair();
        // N advertises, A scans (A is the decider: hearing is the proof)
        let mut adv = Advertiser::new();
        let (_r, u) = adv.next_advert(&kn);
        let (r2, mac) = Scanner::new(&ka).on_uuid(&u).unwrap();
        assert!(adv.verify_heard(&kn, &mac));
        assert_eq!(heard_mac(&kn, &r2), mac);
        // A advertises, N scans, A verifies N's ble_heard
        let mut adv_a = Advertiser::new();
        let (_r, u) = adv_a.next_advert(&ka);
        let (_, mac_n) = Scanner::new(&kn).on_uuid(&u).unwrap();
        assert!(adv_a.verify_heard(&ka, &mac_n));
        // a MAC for a nonce A never advertised, or a MAC under another key, fails
        assert!(!adv_a.verify_heard(&ka, &heard_mac(&ka, &[9u8; 12])));
        let (other, _) = keys_pair();
        assert!(!adv_a.verify_heard(&ka, &heard_mac(&other, &[0u8; 12])));
        // N cannot produce the MAC without hearing r: guessing a nonce does not verify
        assert!(!adv_a.verify_heard(&ka, &heard_mac(&kn, &[0u8; 12])));
        // an empty advertiser verifies nothing
        assert!(!Advertiser::new().verify_heard(&ka, &mac_n));
    }

    /// L1: hearing a UUID is not the proof; the advertiser's `ble_ack` for the same nonce is.
    #[test]
    fn a_scanning_approver_needs_the_ack_round_trip() {
        let (ka, kn) = keys_pair();
        let mut adv = Advertiser::new();
        let (r, u) = adv.next_advert(&kn);
        let scanner = Scanner::new(&ka);
        // step 1: A hears the UUID and answers ble_heard; there is no proof yet and no API that makes one from a UUID alone
        let (r_heard, heard) = scanner.on_uuid(&u).unwrap();
        assert_eq!(r_heard, r);
        // step 2: the advertiser verifies the heard MAC and answers with the ack for THAT nonce
        let ack = adv.ack_for_heard(&kn, &heard).expect("a genuine ble_heard is acked");
        assert_eq!(ack, ack_mac(&kn, &r));
        assert_ne!(ack, heard, "the ack is a different MAC than the heard MAC (distinct label)");
        // step 3: only the ack yields the proof
        let proof = scanner.prove_ack("L", &r_heard, &ack).expect("proof from a verified ack");
        assert_eq!((proof.method(), proof.link_id()), (Proximity::Ble, "L"));
        // a stranger whose random advertisement happens to carry the CLN1 tag (2^-32) never gets an ack: it does not hold K
        let (stranger, _) = keys_pair();
        let forged = ack_mac(&stranger, &r_heard);
        assert!(scanner.prove_ack("L", &r_heard, &forged).is_none(), "ack under another key");
        // an ack for another nonce, the heard MAC replayed as an ack, and an all-zero ack all fail
        assert!(scanner.prove_ack("L", &[1u8; 12], &ack).is_none(), "ack for another nonce");
        assert!(scanner.prove_ack("L", &r_heard, &heard).is_none(), "heard MAC is not an ack");
        assert!(scanner.prove_ack("L", &r_heard, &[0u8; 32]).is_none());
        // the advertiser acks nothing it did not advertise
        assert!(adv.ack_for_heard(&kn, &heard_mac(&kn, &[9u8; 12])).is_none());
        assert!(adv.ack_for_heard(&kn, &heard_mac(&stranger, &r)).is_none());
        assert!(Advertiser::new().ack_for_heard(&kn, &heard).is_none());
    }

    #[test]
    fn plan_table() {
        // phone/phone: N advertises, A scans; LAN: A (neither or both phones -> A)
        let p = plan(&phone(), &phone(), false);
        assert_eq!(p.ble, Some(BlePlan { advertiser: Side::N }));
        assert_eq!(p.lan, Some(LanPlan { listener: Side::A }));
        // A phone, N desktop: A advertises, N scans; phone listens
        let p = plan(&phone(), &desktop(), false);
        assert_eq!(p.ble, Some(BlePlan { advertiser: Side::A }));
        assert_eq!(p.lan, Some(LanPlan { listener: Side::A }));
        // A desktop, N phone: N advertises, A scans; phone (N) listens
        let p = plan(&desktop(), &phone(), false);
        assert_eq!(p.ble, Some(BlePlan { advertiser: Side::N }));
        assert_eq!(p.lan, Some(LanPlan { listener: Side::N }));
        // desktop/desktop: no Bluetooth (nobody advertises), A listens
        let p = plan(&desktop(), &desktop(), true);
        assert_eq!(p.ble, None);
        assert_eq!(p.lan, Some(LanPlan { listener: Side::A }));
        assert!(p.concurrent);
        // phone cannot scan (permission): A phone N desktop still has A advertising; N phone A phone w/o scan -> none
        let mut blind = phone();
        blind.ble_scan = false;
        let mut deaf = phone();
        deaf.ble_scan = false;
        deaf.ble_adv = false;
        assert_eq!(plan(&blind, &deaf, false).ble, None, "A can only advertise, N can do neither");
        assert_eq!(plan(&deaf, &blind, false).ble, None, "N can only advertise, A can do neither");
        // listener swap when the preferred listener cannot listen
        let mut nolisten = phone();
        nolisten.lan_listen = false;
        assert_eq!(plan(&nolisten, &desktop(), false).lan, Some(LanPlan { listener: Side::N }));
        // nobody can: no LAN
        let mut none = desktop();
        none.lan_listen = false;
        none.lan_dial = false;
        assert_eq!(plan(&none, &none, false).lan, None);
    }

    #[test]
    fn plan_blind_a_and_phone_n_can_still_advertise_back() {
        // A phone without scan permission, N phone: N cannot be heard by A, but A advertises and N scans
        let mut a = phone();
        a.ble_scan = false;
        assert_eq!(plan(&a, &phone(), false).ble, Some(BlePlan { advertiser: Side::A }));
    }

    #[test]
    fn probe_timings() {
        let t0 = Instant::now();
        let s = |x| t0 + Duration::from_millis(x);
        // adapter never reports: 3 s
        let mut p = BleProbe::new(BleRole::Scan, t0);
        assert_eq!(p.tick(s(2999)), BleStatus::WaitingForAdapter);
        assert_eq!(p.tick(s(3000)), BleStatus::FellThrough(FallReason::AdapterTimeout));
        assert_eq!(p.proof(), BleStatus::FellThrough(FallReason::AdapterTimeout), "a late proof does not resurrect it");
        // denied
        let mut p = BleProbe::new(BleRole::Advertise, t0);
        assert_eq!(p.adapter_state(false, s(10)), BleStatus::FellThrough(FallReason::NoAdapter));
        // scanner: 12 s from when scanning started
        let mut p = BleProbe::new(BleRole::Scan, t0);
        assert_eq!(p.adapter_state(true, s(1000)), BleStatus::Running);
        assert_eq!(p.tick(s(12999)), BleStatus::Running);
        assert_eq!(p.tick(s(13000)), BleStatus::FellThrough(FallReason::NothingHeard));
        // advertiser: 20 s
        let mut p = BleProbe::new(BleRole::Advertise, t0);
        p.adapter_state(true, s(0));
        assert_eq!(p.tick(s(19999)), BleStatus::Running);
        assert_eq!(p.tick(s(20000)), BleStatus::FellThrough(FallReason::NoHeardMac));
        // proof while running is final
        let mut p = BleProbe::new(BleRole::Scan, t0);
        p.adapter_state(true, s(0));
        assert_eq!(p.proof(), BleStatus::Proven);
        assert_eq!(p.tick(s(60_000)), BleStatus::Proven);
        assert_eq!(p.adapter_state(false, s(60_001)), BleStatus::Proven);
    }
}
