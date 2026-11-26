//! Privacy-safe facts about WHY a local-network leg did or did not hold, for the desktop's diagnostic report and the
//! "what went wrong" screens. Everything here is a count, a boolean or a word from a closed set: never an address, a MAC, an
//! SSID, an adapter or device name, a user id or any content. (Names and addresses are read to CLASSIFY and dropped on the spot.)
//!
//! Three questions the old single `not_found` could not answer:
//! * no shared subnet: the peer's offered address is on-link for none of our interfaces ([`classify_dial_error`]),
//! * no usable adapter at all on THIS device (a VPN-only PC, a failed Windows adapter query): [`AdapterCensus`] says how many
//!   adapters were eligible and why the others were filtered,
//! * nobody answered: the relay-level timeouts, mapped in `engine.rs` ([`LAN_FAIL_NO_ANSWER`]).
use cl_near::error::NearError;
use cl_near::onlink::{IfaceKind, InterfaceProvider};
use serde::Serialize;
use std::collections::HashSet;

/// Final local-network failure causes (what the desktop shows). The WIRE keeps cl-near's closed `LAN_CAUSES` set: a peer that does not
/// know a new word drops the whole message (`Message::validate` rejects an unknown abort cause), which would leave an older phone
/// waiting instead of showing its generic ending. See [`wire_lan_cause`].
pub const LAN_FAIL_DIFFERENT_NETWORK: &str = "different_network";
pub const LAN_FAIL_NO_USABLE_NETWORK: &str = "no_usable_network";
pub const LAN_FAIL_PEER_NO_USABLE_NETWORK: &str = "peer_no_usable_network";
pub const LAN_FAIL_NO_ANSWER: &str = "no_answer";
pub const LAN_FAIL_NOT_FOUND: &str = "not_found";

/// What the other side is told about a local-network failure. Always one of cl-near's `LAN_CAUSES`: new local words collapse to the
/// legacy word an older phone already understands.
pub fn wire_lan_cause(local: &str) -> &'static str {
    match local {
        "ok" => "ok",
        "denied" => "denied",
        "firewall" => "firewall",
        "skipped" | LAN_FAIL_NO_USABLE_NETWORK | LAN_FAIL_PEER_NO_USABLE_NETWORK => "skipped",
        // different_network, no_answer, not_found and anything unknown: "nothing there" on the wire, as before
        _ => "not_found",
    }
}

/// Counts of this device's network adapters. Counted per interface, never per address.
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCensus {
    /// Adapters a proof may use (Wi-Fi, Ethernet, or a kind the platform could not tell).
    pub eligible: u32,
    pub wifi: u32,
    pub ethernet: u32,
    /// Eligible but of a kind the platform could not tell.
    pub unknown: u32,
    /// Adapters that were left out, all reasons.
    pub filtered: u32,
    /// Left out: a virtual / container / VM / tunnel / non-hardware adapter.
    pub filtered_virtual: u32,
    /// Left out: looked like a VPN.
    pub filtered_vpn: u32,
    /// Left out: the platform could not be asked what the adapter is (the filter fails closed).
    pub filtered_unresolved: u32,
}

/// What a platform concluded about one interface.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Eligible(IfaceKind),
    /// Excluded as virtual (not a shared local link).
    Virtual,
    /// Could not be classified, so excluded.
    Unresolved,
}

/// One interface, for [`census_from`]. `key` only de-duplicates the several addresses of one interface and is never kept.
pub struct RawAdapter {
    pub key: (u32, String),
    pub name_is_vpn: bool,
    pub verdict: Verdict,
}

/// Does an interface name look like a VPN? (Read once to classify; the name is never stored or logged.)
pub fn is_vpn_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    const WORDS: [&str; 13] = ["vpn", "wireguard", "openvpn", "anyconnect", "tailscale", "zerotier", "nordlynx", "wintun", "tap-windows", "forticlient", "globalprotect", "pulse secure", "hamachi"];
    const SHORT: [&str; 2] = ["tun", "wg"];
    WORDS.iter().any(|w| n.contains(w)) || SHORT.iter().any(|p| n.strip_prefix(*p).is_some_and(|r| r.chars().all(|c| c.is_ascii_digit() || c == '-' || c == '_')))
}

pub fn census_from(items: impl IntoIterator<Item = RawAdapter>) -> AdapterCensus {
    let mut seen: HashSet<(u32, String)> = HashSet::new();
    let mut c = AdapterCensus::default();
    for a in items {
        if !seen.insert(a.key) {
            continue;
        }
        match a.verdict {
            Verdict::Eligible(k) => {
                c.eligible += 1;
                match k {
                    IfaceKind::Wifi => c.wifi += 1,
                    IfaceKind::Ethernet => c.ethernet += 1,
                    _ => c.unknown += 1,
                }
            }
            Verdict::Virtual if a.name_is_vpn => {
                c.filtered += 1;
                c.filtered_vpn += 1;
            }
            Verdict::Virtual => {
                c.filtered += 1;
                c.filtered_virtual += 1;
            }
            Verdict::Unresolved => {
                c.filtered += 1;
                c.filtered_unresolved += 1;
            }
        }
    }
    c
}

/// The census of whatever `provider` lists (the list is already the platform's filtered view: only `eligible` and the
/// kind split are known; an interface of kind `Virtual` that a provider still lists counts as filtered).
pub fn census_from_provider(provider: &dyn InterfaceProvider) -> AdapterCensus {
    census_from(provider.interfaces().into_iter().map(|i| RawAdapter {
        key: (i.index, if i.index == 0 { i.name.clone() } else { String::new() }),
        name_is_vpn: is_vpn_name(&i.name),
        verdict: if i.kind.allowed() { Verdict::Eligible(i.kind) } else { Verdict::Virtual },
    }))
}

/// A dial that failed, as a closed word and whether it means "no shared subnet".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DialClass {
    /// `off_link` | `bad_offer` | `timeout` | `refused` | `blocked` | `auth` | `tls` | `io`
    pub code: &'static str,
    /// The peer's offered address is on-link for none of our interfaces.
    pub different_network: bool,
}

pub fn classify_dial_error(e: &NearError) -> DialClass {
    use std::io::ErrorKind::*;
    let (code, dn) = match e {
        NearError::OffLink(m) if m.starts_with("no on-link candidate") => ("off_link", true),
        NearError::OffLink(_) => ("bad_offer", false),
        NearError::Timeout(_) => ("timeout", false),
        NearError::Auth(_) => ("auth", false),
        NearError::Tls(_) => ("tls", false),
        NearError::Io(io) => match io.kind() {
            ConnectionRefused => ("refused", false),
            PermissionDenied => ("blocked", false),
            TimedOut => ("timeout", false),
            _ => ("io", false),
        },
        _ => ("io", false),
    };
    DialClass { code, different_network: dn }
}

/// Did a listener turn away only sources that were off-link? (`LanListener::failures()` text is read, never kept.)
pub fn failures_mean_different_network(failures: &[String]) -> bool {
    failures.iter().any(|f| f.starts_with("address is not on-link"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cl_near::onlink::{LocalInterface, StaticInterfaces};

    fn li(index: u32, name: &str, addr: &str, kind: IfaceKind) -> LocalInterface {
        LocalInterface { index, name: name.into(), addr: addr.parse().unwrap(), prefix_len: 24, kind }
    }

    #[test]
    fn census_counts_per_interface_with_a_reason_for_every_filtered_one() {
        let items = vec![
            RawAdapter { key: (4, String::new()), name_is_vpn: false, verdict: Verdict::Eligible(IfaceKind::Wifi) },
            RawAdapter { key: (4, String::new()), name_is_vpn: false, verdict: Verdict::Eligible(IfaceKind::Wifi) }, // second address, same adapter
            RawAdapter { key: (5, String::new()), name_is_vpn: false, verdict: Verdict::Eligible(IfaceKind::Ethernet) },
            RawAdapter { key: (6, String::new()), name_is_vpn: false, verdict: Verdict::Eligible(IfaceKind::Unknown) },
            RawAdapter { key: (7, String::new()), name_is_vpn: true, verdict: Verdict::Virtual },
            RawAdapter { key: (8, String::new()), name_is_vpn: false, verdict: Verdict::Virtual },
            RawAdapter { key: (9, String::new()), name_is_vpn: false, verdict: Verdict::Unresolved },
        ];
        assert_eq!(census_from(items), AdapterCensus { eligible: 3, wifi: 1, ethernet: 1, unknown: 1, filtered: 3, filtered_virtual: 1, filtered_vpn: 1, filtered_unresolved: 1 });
    }

    #[test]
    fn a_vpn_only_machine_has_zero_eligible_and_says_why() {
        let c = census_from([RawAdapter { key: (3, String::new()), name_is_vpn: is_vpn_name("Cisco AnyConnect Secure Mobility Client"), verdict: Verdict::Virtual }]);
        assert_eq!((c.eligible, c.filtered, c.filtered_vpn), (0, 1, 1));
        assert!(is_vpn_name("WireGuard Tunnel") && is_vpn_name("tun0") && is_vpn_name("wg0"));
        assert!(!is_vpn_name("Wi-Fi") && !is_vpn_name("Ethernet") && !is_vpn_name("vEthernet (WSL)"));
    }

    #[test]
    fn provider_census_only_counts_what_the_provider_lists() {
        let p = StaticInterfaces(vec![li(2, "wlan0", "192.168.1.5", IfaceKind::Wifi), li(2, "wlan0", "fe80::1", IfaceKind::Wifi), li(3, "docker0", "172.17.0.1", IfaceKind::Virtual)]);
        let c = census_from_provider(&p);
        assert_eq!((c.eligible, c.wifi, c.filtered, c.filtered_virtual), (1, 1, 1, 1));
        assert_eq!(census_from_provider(&StaticInterfaces(vec![])), AdapterCensus::default());
    }

    #[test]
    fn dial_errors_are_classified_and_only_the_off_link_one_means_a_different_network() {
        assert_eq!(classify_dial_error(&NearError::OffLink("no on-link candidate in the offer".into())), DialClass { code: "off_link", different_network: true });
        assert_eq!(classify_dial_error(&NearError::OffLink("offered port is a well-known service port".into())), DialClass { code: "bad_offer", different_network: false });
        assert_eq!(classify_dial_error(&NearError::Timeout("connect")).code, "timeout");
        assert_eq!(classify_dial_error(&NearError::Io(std::io::Error::from(std::io::ErrorKind::ConnectionRefused))).code, "refused");
        assert_eq!(classify_dial_error(&NearError::Io(std::io::Error::from(std::io::ErrorKind::PermissionDenied))).code, "blocked");
        assert_eq!(classify_dial_error(&NearError::Auth("role mac")).code, "auth");
        assert!(!classify_dial_error(&NearError::Timeout("connect")).different_network);
    }

    #[test]
    fn a_listener_that_only_saw_off_link_sources_is_a_different_network() {
        assert!(failures_mean_different_network(&["address is not on-link: x".into()]));
        assert!(!failures_mean_different_network(&[]));
        assert!(!failures_mean_different_network(&["TLS handshake: eof".into()]));
    }

    #[test]
    fn every_local_word_maps_to_a_wire_cause_an_older_peer_validates() {
        for local in ["ok", "denied", "firewall", "skipped", LAN_FAIL_DIFFERENT_NETWORK, LAN_FAIL_NO_USABLE_NETWORK, LAN_FAIL_PEER_NO_USABLE_NETWORK, LAN_FAIL_NO_ANSWER, LAN_FAIL_NOT_FOUND, "something_new"] {
            assert!(cl_near::relay::LAN_CAUSES.contains(&wire_lan_cause(local)), "{local}");
        }
        assert_eq!(wire_lan_cause(LAN_FAIL_DIFFERENT_NETWORK), "not_found");
        assert_eq!(wire_lan_cause(LAN_FAIL_NO_USABLE_NETWORK), "skipped");
    }
}
