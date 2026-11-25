//! Section 4.2: the on-link address rule, as a pure function over (candidate, local interface prefixes).
//!
//! "Accept only addresses that are on-link for one of the device's own interfaces (same subnet as an
//! assigned IPv4 prefix; IPv6 link-local or same /64 ULA); never a public, loopback or routed address."
//!
//! Concretely:
//! * IPv4: RFC 1918 private (10/8, 172.16/12, 192.168/16) or IPv4 link-local (169.254/16) AND inside the
//!   subnet of one local interface whose own address is private / link-local. Never: loopback, CGNAT
//!   100.64/10, public, multicast, broadcast, unspecified, the interface's own address, the subnet's
//!   network or broadcast address.
//! * IPv6: link-local `fe80::/64` when a local interface has a link-local address (the match carries that
//!   interface's scope id), or ULA `fc00::/7` sharing the top 64 bits with a local ULA address. Never:
//!   loopback, global unicast, multicast, unspecified, the interface's own address.
//! * IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is normalised to IPv4 first.
//!
//! Security review F3 (2026-11-20): the proof is "somebody holding K is on the approver's subnet", so the subnet must be small and
//! the interface a real LAN:
//! * the EFFECTIVE prefix is capped at /24 (IPv4) and /64 (IPv6): an interface that reports /8, /12 or /16 (a campus or corporate
//!   network, a VPN pool) only ever matches its own /24, never the whole range;
//! * interfaces of kind [`IfaceKind::Virtual`] (container bridges, VPN and tunnel adapters, VM host-only networks, cellular) never
//!   match, whichever provider listed them. See [`IfaceKind`] for what each platform can tell.
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use crate::error::{NearError, Result};

/// One local interface address with its prefix length, as the platform reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalInterface {
    /// OS interface index (the IPv6 scope id for link-local addresses).
    pub index: u32,
    pub name: String,
    pub addr: IpAddr,
    pub prefix_len: u8,
    /// What the interface is. Providers that can tell for certain say so; everybody else goes through [`kind_from_name`].
    pub kind: IfaceKind,
}

impl LocalInterface {
    /// A listing entry whose [`IfaceKind`] comes from its name ([`kind_from_name`]) because the caller cannot tell better.
    pub fn new(index: u32, name: impl Into<String>, addr: IpAddr, prefix_len: u8) -> Self {
        let name = name.into();
        let kind = kind_from_name(&name);
        Self { index, name, addr, prefix_len, kind }
    }
}

/// What kind of network an interface is, as far as this device can tell.
///
/// Only [`Virtual`](IfaceKind::Virtual) is excluded. `Wifi` / `Ethernet` are the interfaces the proof was designed for;
/// `Unknown` means the platform could not say and the name matched nothing on the conservative deny-list ([`kind_from_name`]).
///
/// What each platform can determine (the allow-list is only as strong as the platform's answer):
/// * **Linux desktop**: definitive. `/sys/class/net/<if>` is resolved: a device under `/devices/virtual/` (bridges, veth, tun/tap,
///   wireguard, docker, vmnet) is `Virtual`; `wireless`/`phy80211` present is `Wifi`; ARPHRD_ETHER on a real device is `Ethernet`.
///   The name deny-list is applied on top (cellular `ww*`).
/// * **Android**: the platform supplies the list. By name: `wlan*` Wi-Fi, `eth*` Ethernet, `rmnet*`/`ccmni*`/`v4-*`/`tun*`/`dummy*`
///   virtual. The app should additionally pass only the interface of the `ConnectivityManager` network whose `NetworkCapabilities`
///   say `TRANSPORT_WIFI` or `TRANSPORT_ETHERNET` (the authoritative answer; the core cannot ask).
/// * **iOS / macOS**: names only. `en*` cannot be told Wi-Fi from wired from Thunderbolt (`Unknown`, allowed), `bridge*` (hotspot /
///   Internet Sharing) is `Unknown`; `utun`/`awdl`/`llw`/`ipsec`/`pdp_ip`/`gif`/`stf`/`anpi`/`ap` are `Virtual`. The app should pass
///   `NWPathMonitor`'s `usesInterfaceType(.wifi / .wiredEthernet)` interface only.
/// * **Windows**: friendly names only (`Wi-Fi`, `Ethernet`, `vEthernet (WSL)`, `Cisco AnyConnect ...`): a deny-list of virtual, VPN,
///   VM, Bluetooth-PAN and tunnel adapters, everything else `Unknown`. The adapter type (`IfType`) is not exposed by the
///   enumeration crate.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum IfaceKind {
    Wifi,
    Ethernet,
    /// The platform could not tell and the name is not on the deny-list.
    #[default]
    Unknown,
    /// Container / VM bridge, VPN or tunnel adapter, cellular, or any other interface that is not a shared local link.
    Virtual,
}

impl IfaceKind {
    /// May a connection over this interface count as "the same local network"?
    pub fn allowed(self) -> bool { self != IfaceKind::Virtual }
}

/// Deny-list by name. Order matters: virtual patterns first, then the positive ones, so `vEthernet` is not `Ethernet`.
pub fn kind_from_name(name: &str) -> IfaceKind {
    let n = name.trim().to_ascii_lowercase();
    // Short POSIX names must be followed by nothing, a digit or a separator (`lo`, `lo0`, `ap1`, `wg0`), so `Apple ...` and `logmein` survive.
    const VIRT_SHORT: &[&str] = &["lo", "ap", "wg", "zt", "tun", "tap", "utun", "ppp", "gre", "sit", "ifb", "gif", "stf", "cni", "vnet", "llw", "awdl", "anpi"];
    const VIRT_PREFIX: &[&str] = &[
        "docker", "br-", "virbr", "veth", "flannel", "cali", "kube", "lxc", "lxd", "podman", "tailscale", "ipsec", "vmnet", "vboxnet",
        "dummy", "ip6tnl", "pdp_ip", "rmnet", "ccmni", "v4-", "wwan", "wwp", "wwx", "nordlynx",
    ];
    const VIRT_WORD: &[&str] = &[
        "vethernet", "virtual", "vpn", "wintun", "tap-windows", "wireguard", "openvpn", "anyconnect", "cisco", "vmware", "vmnet", "virtualbox",
        "host-only", "bluetooth", "loopback", "isatap", "teredo", "6to4", "zerotier", "hamachi", "npcap", "pseudo", "local area connection*",
        "docker", "wsl", "hyper-v", "forticlient", "globalprotect", "pulse secure",
    ];
    let short = |p: &&str| n.strip_prefix(*p).is_some_and(|r| r.chars().next().is_none_or(|c| c.is_ascii_digit() || c == '-' || c == '_'));
    if VIRT_SHORT.iter().any(short) || VIRT_PREFIX.iter().any(|p| n.starts_with(p)) || VIRT_WORD.iter().any(|w| n.contains(w)) { return IfaceKind::Virtual; }
    if ["wlan", "wlp", "wlx", "wlo", "wi-fi", "wifi", "wireless"].iter().any(|p| n.starts_with(p)) || n.contains("wi-fi") { return IfaceKind::Wifi; }
    if ["eth", "enp", "eno", "ens", "enx", "ethernet", "local area connection"].iter().any(|p| n.starts_with(p)) { return IfaceKind::Ethernet; }
    IfaceKind::Unknown
}

/// The platforms supply this: Android from `LinkProperties`, iOS from `getifaddrs` (en0, bridge*), the
/// desktop host from [`SystemInterfaces`] or its own enumeration. Loopback and VPN interfaces should be
/// left out by the supplier; the rule rejects loopback candidates regardless.
pub trait InterfaceProvider: Send + Sync {
    fn interfaces(&self) -> Vec<LocalInterface>;
}

/// A fixed list (tests, platforms that push a snapshot).
#[derive(Clone, Debug, Default)]
pub struct StaticInterfaces(pub Vec<LocalInterface>);

impl InterfaceProvider for StaticInterfaces {
    fn interfaces(&self) -> Vec<LocalInterface> { self.0.clone() }
}

/// Default enumeration with `getifaddrs` through the `if-addrs` crate (desktop / CLI). Skips loopback and every interface of kind
/// [`IfaceKind::Virtual`]; on Linux the kind comes from sysfs (see [`IfaceKind`] for what each platform can tell).
#[cfg(feature = "system-interfaces")]
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemInterfaces;

#[cfg(feature = "system-interfaces")]
impl InterfaceProvider for SystemInterfaces {
    fn interfaces(&self) -> Vec<LocalInterface> {
        let Ok(list) = if_addrs::get_if_addrs() else { return vec![] };
        list.into_iter()
            .filter(|i| !i.is_loopback())
            .map(|i| {
                let (addr, prefix_len) = match &i.addr {
                    if_addrs::IfAddr::V4(v4) => (IpAddr::V4(v4.ip), u32::from(v4.netmask).leading_ones() as u8),
                    if_addrs::IfAddr::V6(v6) => (IpAddr::V6(v6.ip), u128::from(v6.netmask).leading_ones() as u8),
                };
                let kind = system_kind(&i.name);
                LocalInterface { index: i.index.unwrap_or(0), name: i.name, addr, prefix_len, kind }
            })
            .filter(|i| i.kind.allowed())
            .collect()
    }
}

/// The name deny-list always applies (cellular, VPN names); on Linux sysfs then decides between real and virtual devices.
#[cfg(feature = "system-interfaces")]
fn system_kind(name: &str) -> IfaceKind {
    let by_name = kind_from_name(name);
    if by_name == IfaceKind::Virtual { return by_name; }
    #[cfg(target_os = "linux")]
    if let Some(k) = sysfs_kind(name) { return k; }
    by_name
}

#[cfg(all(feature = "system-interfaces", target_os = "linux"))]
fn sysfs_kind(name: &str) -> Option<IfaceKind> {
    if name.is_empty() || name.contains('/') || name.contains("..") { return None; }
    let base = std::path::Path::new("/sys/class/net").join(name);
    let real = std::fs::canonicalize(&base).ok()?;
    if real.to_string_lossy().contains("/devices/virtual/") { return Some(IfaceKind::Virtual); }
    if base.join("wireless").exists() || base.join("phy80211").exists() { return Some(IfaceKind::Wifi); }
    match std::fs::read_to_string(base.join("type")).ok()?.trim() {
        "1" => Some(IfaceKind::Ethernet),
        _ => Some(IfaceKind::Virtual),
    }
}

/// One way a candidate is on-link: through which interface, and (IPv6 link-local) with which scope id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OnLinkMatch {
    pub interface_index: u32,
    /// `Some(scope id)` for IPv6 link-local candidates, to be set on the socket address when dialling.
    pub scope: Option<u32>,
}

fn v4_private_or_link_local(a: Ipv4Addr) -> bool { a.is_private() || a.is_link_local() }

fn v4_cgnat(a: Ipv4Addr) -> bool { let o = a.octets(); o[0] == 100 && (o[1] & 0xC0) == 64 }

fn v6_link_local(a: Ipv6Addr) -> bool { let s = a.segments(); s[0] == 0xfe80 && s[1] == 0 && s[2] == 0 && s[3] == 0 }

fn v6_ula(a: Ipv6Addr) -> bool { (a.segments()[0] & 0xfe00) == 0xfc00 }

/// The most inclusive IPv4 neighbourhood that counts as "the same network" (security review F3): /24, whatever the interface reports.
pub const V4_MAX_NEIGHBOURHOOD: u8 = 24;
/// IPv6: the same /64.
pub const V6_MAX_NEIGHBOURHOOD: u8 = 64;

fn same_v6_prefix(a: Ipv6Addr, b: Ipv6Addr, prefix: u8) -> bool {
    let mask = if prefix >= 128 { u128::MAX } else { !(u128::MAX >> u32::from(prefix)) };
    (u128::from(a) & mask) == (u128::from(b) & mask)
}

fn same_v4_subnet(a: Ipv4Addr, b: Ipv4Addr, prefix: u8) -> bool {
    let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - u32::from(prefix)) };
    (u32::from(a) & mask) == (u32::from(b) & mask)
}

/// Every way `candidate` is on-link for one of `ifaces`. Empty means REFUSE.
pub fn classify(candidate: IpAddr, ifaces: &[LocalInterface]) -> Vec<OnLinkMatch> {
    let candidate = match candidate {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    };
    let mut out = vec![];
    match candidate {
        IpAddr::V4(c) => {
            if c.is_unspecified() || c.is_loopback() || c.is_multicast() || c.is_broadcast() || v4_cgnat(c) || !v4_private_or_link_local(c) {
                return out;
            }
            for i in ifaces {
                let IpAddr::V4(me) = i.addr else { continue };
                if !i.kind.allowed() || i.prefix_len == 0 || i.prefix_len > 32 || me.is_loopback() || !v4_private_or_link_local(me) { continue }
                // F3: a /8, /12 or /16 interface only ever matches its own /24. (169.254/16 keeps its real /16: link-local is
                // non-routable by definition, so every such address already IS on the same physical link.)
                let eff = if me.is_link_local() { i.prefix_len } else { i.prefix_len.max(V4_MAX_NEIGHBOURHOOD) };
                if c == me || !same_v4_subnet(c, me, eff) { continue }
                if eff <= 30 {
                    let mask = u32::MAX << (32 - u32::from(eff));
                    let net = u32::from(me) & mask;
                    let bcast = net | !mask;
                    if u32::from(c) == net || u32::from(c) == bcast { continue }
                }
                out.push(OnLinkMatch { interface_index: i.index, scope: None });
            }
        }
        IpAddr::V6(c) => {
            if c.is_unspecified() || c.is_loopback() || c.is_multicast() { return out }
            if v6_link_local(c) {
                for i in ifaces {
                    if let IpAddr::V6(me) = i.addr {
                        if i.kind.allowed() && v6_link_local(me) && me != c && i.index != 0 {
                            out.push(OnLinkMatch { interface_index: i.index, scope: Some(i.index) });
                        }
                    }
                }
            } else if v6_ula(c) {
                for i in ifaces {
                    if let IpAddr::V6(me) = i.addr {
                        if i.kind.allowed() && v6_ula(me) && me != c && same_v6_prefix(me, c, i.prefix_len.max(V6_MAX_NEIGHBOURHOOD)) {
                            out.push(OnLinkMatch { interface_index: i.index, scope: None });
                        }
                    }
                }
            }
        }
    }
    out
}

pub fn is_on_link(candidate: IpAddr, ifaces: &[LocalInterface]) -> bool { !classify(candidate, ifaces).is_empty() }

/// The addresses a dialer should actually try for an offer: refused addresses are dropped, IPv6 link-local
/// ones are expanded to one socket address per local link-local interface (the offerer's own scope id is
/// meaningless here and never accepted). De-duplicated, offer order preserved.
pub fn dial_targets(addrs: &[IpAddr], port: u16, ifaces: &[LocalInterface]) -> Vec<SocketAddr> {
    let mut out: Vec<SocketAddr> = vec![];
    for a in addrs {
        for m in classify(*a, ifaces) {
            let target = match (*a, m.scope) {
                (IpAddr::V6(v6), Some(scope)) => SocketAddr::V6(std::net::SocketAddrV6::new(v6, port, 0, scope)),
                (IpAddr::V6(v6), None) => match v6.to_ipv4_mapped() {
                    Some(v4) => SocketAddr::new(IpAddr::V4(v4), port),
                    None => SocketAddr::new(IpAddr::V6(v6), port),
                },
                (ip, _) => SocketAddr::new(ip, port),
            };
            if !out.contains(&target) { out.push(target) }
        }
    }
    out
}

/// The listener's check on an incoming connection's source address. IPv6 link-local sources must carry a
/// non-zero scope id equal to the interface that matched.
pub fn check_peer_source(peer: SocketAddr, ifaces: &[LocalInterface]) -> Result<()> {
    let ms = classify(peer.ip(), ifaces);
    let ok = match peer {
        SocketAddr::V6(v6) if v6_link_local(*v6.ip()) => v6.scope_id() != 0 && ms.iter().any(|m| m.scope == Some(v6.scope_id())),
        _ => !ms.is_empty(),
    };
    if ok { Ok(()) } else { Err(NearError::OffLink(peer.ip().to_string())) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v4(ip: &str, prefix: u8) -> LocalInterface { LocalInterface::new(2, "wlan0", ip.parse().unwrap(), prefix) }
    fn v6(ip: &str, idx: u32) -> LocalInterface { LocalInterface::new(idx, format!("if{idx}"), ip.parse().unwrap(), 64) }
    fn on(ip: &str, ifs: &[LocalInterface]) -> bool { is_on_link(ip.parse().unwrap(), ifs) }

    #[test]
    fn ipv4_private_same_subnet_yes() {
        let ifs = [v4("192.168.1.20", 24)];
        assert!(on("192.168.1.5", &ifs));
        assert!(on("192.168.1.254", &ifs));
        assert!(!on("192.168.2.5", &ifs), "other subnet");
        assert!(!on("192.168.1.20", &ifs), "ourselves");
        assert!(!on("192.168.1.0", &ifs), "network address");
        assert!(!on("192.168.1.255", &ifs), "broadcast address");
        // F3: wider subnets are capped at their own /24
        let ifs = [v4("10.1.2.3", 16)];
        assert!(on("10.1.2.9", &ifs));
        assert!(!on("10.1.200.9", &ifs), "a /16 interface must not match the rest of the /16");
        assert!(!on("10.2.0.1", &ifs));
        let ifs = [v4("172.16.0.5", 12)];
        assert!(on("172.16.0.77", &ifs));
        assert!(!on("172.31.255.1", &ifs), "a /12 interface must not match the rest of the /12");
        assert!(!on("172.32.0.1", &ifs), "172.32 is public");
        // /31 point to point and /32: no network/broadcast carve-out for /31, nothing for /32 (only ourselves)
        assert!(on("192.168.5.1", &[v4("192.168.5.0", 31)]));
        assert!(!on("192.168.5.7", &[v4("192.168.5.7", 32)]));
    }

    #[test]
    fn effective_prefix_is_capped_at_24_and_64() {
        // F3: /8, /12, /16 interfaces (campus / corporate / VPN-pool sized) match only their own /24
        for p in [8u8, 12, 16, 20, 23] {
            let ifs = [v4("10.4.5.6", p)];
            assert!(on("10.4.5.200", &ifs), "/{p}: own /24");
            assert!(!on("10.4.6.7", &ifs), "/{p}: next /24 refused");
            assert!(!on("10.200.1.1", &ifs), "/{p}: far side of the range refused");
        }
        // narrower than /24 stays narrower
        assert!(!on("192.168.1.200", &[v4("192.168.1.20", 28)]));
        assert!(on("192.168.1.30", &[v4("192.168.1.20", 28)]));
        // the carve-out of network / broadcast follows the EFFECTIVE prefix
        let ifs = [v4("10.4.5.6", 8)];
        assert!(!on("10.4.5.0", &ifs) && !on("10.4.5.255", &ifs));
        // IPv6: a /48 or /32 ULA interface matches its own /64 only
        for p in [32u8, 48, 56] {
            let ifs = [LocalInterface::new(2, "wlan0", "fd12:3456:789a:1::5".parse().unwrap(), p)];
            assert!(on("fd12:3456:789a:1::77", &ifs), "/{p}: own /64");
            assert!(!on("fd12:3456:789a:2::77", &ifs), "/{p}: sibling /64 refused");
        }
        // a longer prefix than /64 narrows it
        let ifs = [LocalInterface::new(2, "wlan0", "fd12:3456:789a:1::5".parse().unwrap(), 120)];
        assert!(on("fd12:3456:789a:1::77", &ifs));
        assert!(!on("fd12:3456:789a:1::1:77", &ifs));
    }

    #[test]
    fn virtual_interfaces_never_match() {
        let on_if = |name: &str, ip: &str, cand: &str| is_on_link(cand.parse().unwrap(), &[LocalInterface::new(2, name, ip.parse().unwrap(), 24)]);
        // the same addresses on a real interface match ...
        assert!(on_if("wlan0", "192.168.1.20", "192.168.1.5"));
        assert!(on_if("eth0", "192.168.1.20", "192.168.1.5"));
        assert!(on_if("en0", "192.168.1.20", "192.168.1.5"), "en0 is Unknown: allowed");
        assert!(on_if("Wi-Fi", "192.168.1.20", "192.168.1.5"));
        assert!(on_if("Ethernet 2", "192.168.1.20", "192.168.1.5"));
        // ... and on a container bridge, VPN, VM host-only, hotspot or cellular interface they do not
        for bad in ["docker0", "br-1a2b3c", "virbr0", "veth12ab", "tun0", "tap0", "wg0", "utun3", "ppp0", "tailscale0", "zt5u4abc", "vmnet8", "vboxnet0",
                    "rmnet_data0", "ccmni0", "v4-rmnet_data1", "pdp_ip0", "awdl0", "llw0", "ipsec0", "wwan0", "wwp0s20f0u6",
                    "vEthernet (WSL)", "vEthernet (Default Switch)", "Cisco AnyConnect Secure Mobility Client Connection", "OpenVPN TAP-Windows6",
                    "VMware Network Adapter VMnet1", "VirtualBox Host-Only Network", "Local Area Connection* 3", "Bluetooth Network Connection", "Tailscale",
                    "Loopback Pseudo-Interface 1"] {
            assert_eq!(kind_from_name(bad), IfaceKind::Virtual, "{bad}");
            assert!(!on_if(bad, "192.168.1.20", "192.168.1.5"), "{bad} must not count as the same network");
        }
        // names that merely START like a short deny-list entry are not swept up
        for ok in ["Apple Mobile Device Ethernet", "logmein", "eth0", "wlp2s0", "enp3s0", "eno1", "ens160", "en0"] {
            assert_ne!(kind_from_name(ok), IfaceKind::Virtual, "{ok}");
        }
        assert_eq!(kind_from_name("wlan0"), IfaceKind::Wifi);
        assert_eq!(kind_from_name("wlp2s0"), IfaceKind::Wifi);
        assert_eq!(kind_from_name("Wi-Fi 2"), IfaceKind::Wifi);
        assert_eq!(kind_from_name("eth0"), IfaceKind::Ethernet);
        assert_eq!(kind_from_name("Ethernet"), IfaceKind::Ethernet);
        assert_eq!(kind_from_name("en0"), IfaceKind::Unknown);
        // an explicit kind from the platform wins over the name; IPv6 and dial targets honour it too
        let mut v = LocalInterface::new(2, "mystery0", "192.168.1.20".parse().unwrap(), 24);
        v.kind = IfaceKind::Virtual;
        assert!(dial_targets(&["192.168.1.5".parse().unwrap()], 1234, &[v.clone()]).is_empty());
        assert!(check_peer_source("192.168.1.5:80".parse().unwrap(), &[v]).is_err());
        let mut v6l = LocalInterface::new(4, "docker0", "fe80::1".parse().unwrap(), 64);
        assert!(!is_on_link("fe80::abcd".parse().unwrap(), &[v6l.clone()]));
        v6l.kind = IfaceKind::Ethernet;
        assert!(is_on_link("fe80::abcd".parse().unwrap(), &[v6l]), "same address, kind overridden");
        assert!(!is_on_link("fd12::7".parse().unwrap(), &[LocalInterface::new(2, "br-abc", "fd12::5".parse().unwrap(), 64)]));
    }

    #[test]
    fn ipv4_never_public_loopback_cgnat_special() {
        let ifs = [v4("192.168.1.20", 24), v4("10.0.0.2", 8), v4("100.64.0.9", 10), v4("8.8.8.8", 24), v4("127.0.0.1", 8)];
        for bad in ["8.8.8.9", "1.1.1.1", "127.0.0.1", "127.5.5.5", "100.64.0.1", "100.127.255.254", "0.0.0.0", "255.255.255.255", "224.0.0.251", "169.253.1.1", "192.0.2.1"] {
            assert!(!on(bad, &ifs), "{bad} must be refused");
        }
        // CGNAT interface with a CGNAT candidate in the same prefix: still refused
        assert!(!on("100.64.0.10", &[v4("100.64.0.9", 10)]));
        // a public interface address does not make a public candidate acceptable
        assert!(!on("8.8.8.9", &[v4("8.8.8.8", 24)]));
        // loopback interface never matches
        assert!(!on("127.0.0.2", &[v4("127.0.0.1", 8)]));
        // prefix 0 (misconfigured) matches nothing
        assert!(!on("10.9.9.9", &[v4("10.0.0.2", 0)]));
        // no interfaces at all
        assert!(!on("192.168.1.5", &[]));
    }

    #[test]
    fn ipv4_link_local_only_on_a_link_local_interface() {
        assert!(on("169.254.7.7", &[v4("169.254.1.1", 16)]));
        assert!(!on("169.254.7.7", &[v4("192.168.1.1", 24)]));
        assert!(!on("192.168.1.9", &[v4("169.254.1.1", 16)]));
    }

    #[test]
    fn multiple_interfaces_any_match() {
        let ifs = [v4("192.168.1.20", 24), LocalInterface { index: 3, ..v4("10.5.5.5", 24) }];
        assert!(on("10.5.5.9", &ifs));
        assert!(on("192.168.1.9", &ifs));
        assert!(!on("10.5.6.9", &ifs));
        assert_eq!(classify("10.5.5.9".parse().unwrap(), &ifs), vec![OnLinkMatch { interface_index: 3, scope: None }]);
    }

    #[test]
    fn ipv6_link_local_with_scope() {
        let ifs = [v6("fe80::1", 4), v6("fd00::5", 4), v6("fe80::9", 7)];
        let ms = classify("fe80::abcd".parse().unwrap(), &ifs);
        assert_eq!(ms, vec![OnLinkMatch { interface_index: 4, scope: Some(4) }, OnLinkMatch { interface_index: 7, scope: Some(7) }]);
        assert!(!on("fe80::1", &[v6("fe80::1", 4)]), "ourselves");
        assert!(!on("fe80:0:0:1::2", &ifs), "not fe80::/64");
        assert!(!on("fe80::abcd", &[v6("fd00::5", 4)]), "no link-local interface");
        assert!(!on("fe80::abcd", &[v6("fe80::1", 0)]), "no usable scope");
        // dial targets carry OUR scope ids
        let t = dial_targets(&["fe80::abcd".parse().unwrap()], 9000, &ifs);
        assert_eq!(t.len(), 2);
        for (sa, idx) in t.iter().zip([4u32, 7]) {
            match sa { SocketAddr::V6(v) => assert_eq!((v.scope_id(), v.port()), (idx, 9000)), _ => panic!() }
        }
        // listener side: source must carry the matching scope id
        let src = |s: u32| SocketAddr::V6(std::net::SocketAddrV6::new("fe80::abcd".parse().unwrap(), 5000, 0, s));
        assert!(check_peer_source(src(4), &ifs).is_ok());
        assert!(check_peer_source(src(7), &ifs).is_ok());
        assert!(check_peer_source(src(5), &ifs).is_err(), "scope of an interface we do not have");
        assert!(check_peer_source(src(0), &ifs).is_err(), "no scope");
    }

    #[test]
    fn ipv6_ula_same_64_only() {
        let ifs = [v6("fd12:3456:789a:1::5", 2)];
        assert!(on("fd12:3456:789a:1::77", &ifs));
        assert!(!on("fd12:3456:789a:2::77", &ifs), "other /64");
        assert!(!on("fd12:3456:789a:1::5", &ifs), "ourselves");
        assert!(on("fc00:1:2:3::1", &[v6("fc00:1:2:3::2", 2)]), "fc00::/7 includes fc");
        assert!(!on("fd12:3456:789a:1::77", &[v6("2001:db8::5", 2)]), "interface is global, not ULA");
        // not routed to us: global addresses are refused even in the interface's own /64
        assert!(!on("2001:db8::77", &[v6("2001:db8::5", 2)]));
        assert!(!on("::1", &[v6("::1", 1)]));
        assert!(!on("::", &ifs));
        assert!(!on("ff02::1", &ifs));
    }

    #[test]
    fn mapped_addresses_are_normalised() {
        let ifs = [v4("192.168.1.20", 24)];
        assert!(on("::ffff:192.168.1.5", &ifs));
        assert!(!on("::ffff:192.168.2.5", &ifs));
        assert!(!on("::ffff:8.8.8.8", &ifs));
        assert!(!on("::ffff:127.0.0.1", &ifs));
        assert!(!on("::ffff:100.64.0.1", &[v4("100.64.0.9", 10)]));
        let t = dial_targets(&["::ffff:192.168.1.5".parse().unwrap()], 1234, &ifs);
        assert_eq!(t, vec!["192.168.1.5:1234".parse::<SocketAddr>().unwrap()]);
        // IPv4-compatible (deprecated) form is not mapped and not ULA/link-local: refused
        assert!(!on("::192.168.1.5", &ifs));
        // check_peer_source also sees through mapping
        assert!(check_peer_source("[::ffff:192.168.1.5]:80".parse().unwrap(), &ifs).is_ok());
    }

    #[test]
    fn dial_targets_filters_and_dedups() {
        let ifs = [v4("192.168.1.20", 24)];
        let offer: Vec<IpAddr> = ["8.8.8.8", "192.168.1.5", "192.168.1.5", "10.0.0.1", "127.0.0.1", "::ffff:192.168.1.5"].iter().map(|s| s.parse().unwrap()).collect();
        assert_eq!(dial_targets(&offer, 77, &ifs), vec!["192.168.1.5:77".parse::<SocketAddr>().unwrap()]);
        assert!(dial_targets(&offer[..1], 77, &ifs).is_empty());
        assert!(check_peer_source("8.8.8.8:1".parse().unwrap(), &ifs).is_err());
        assert!(check_peer_source("127.0.0.1:1".parse().unwrap(), &ifs).is_err());
    }

    #[cfg(feature = "system-interfaces")]
    #[test]
    fn system_provider_runs() {
        let v = SystemInterfaces.interfaces();
        assert!(v.iter().all(|i| !i.addr.is_loopback()));
    }
}
