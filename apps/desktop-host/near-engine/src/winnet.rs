//! Windows interface facts for the local-network proof (security review F3, item 3).
//!
//! cl-near's `SystemInterfaces` can only judge a Windows adapter by its friendly name (a deny-list), which a VPN, a virtual switch or a
//! renamed adapter walks around. Windows knows better: every adapter has an `IfType` (IANA ifType), and `GetIfEntry2` says whether it is a
//! HARDWARE interface at all (`InterfaceAndOperStatusFlags.HardwareInterface`: false for Hyper-V / WSL switches, TAP / Wintun / WireGuard
//! and VPN adapters, the hosted-network / Wi-Fi Direct virtual adapter) and its NDIS physical medium. Only a hardware adapter of type
//! IEEE 802.11 (Wi-Fi) or Ethernet (802.3) is allowed; everything else is `Virtual` and never matches, never listens, never is offered.
//!
//! Pure classification lives in [`classify`] so it is unit-tested on every OS; the Win32 calls are cfg(windows) and were checked here only
//! by `cargo check --target x86_64-pc-windows-msvc` (they execute on a Windows PC only).
use cl_near::onlink::IfaceKind;

/// IANA ifType values used by Windows (`IF_TYPE_*`).
pub const IF_TYPE_ETHERNET_CSMACD: u32 = 6;
pub const IF_TYPE_IEEE80211: u32 = 71;
/// NDIS physical medium values (`NdisPhysicalMedium*`).
pub const MEDIUM_NATIVE_802_11: i32 = 9;
pub const MEDIUM_802_3: i32 = 14;

/// What an adapter is, from what Windows says about it. `hardware` = `HardwareInterface`, `medium` = NDIS physical medium.
pub fn classify(if_type: u32, hardware: bool, medium: i32) -> IfaceKind {
    if !hardware {
        return IfaceKind::Virtual;
    }
    match (if_type, medium) {
        (IF_TYPE_IEEE80211, _) | (_, MEDIUM_NATIVE_802_11) => IfaceKind::Wifi,
        (IF_TYPE_ETHERNET_CSMACD, MEDIUM_802_3) => IfaceKind::Ethernet,
        // a hardware Ethernet adapter whose driver reports no medium: the type is all there is
        (IF_TYPE_ETHERNET_CSMACD, 0) => IfaceKind::Ethernet,
        // tunnels (131), PPP (23), loopback (24), mobile broadband (243 / 244), Bluetooth PAN, FireWire, ...
        _ => IfaceKind::Virtual,
    }
}

/// The kind Windows gave interface `index`, or `None` when it cannot be known: the enumeration failed (`kinds` is `None`), the
/// interface has no index (0), or Windows does not list it. FAILS CLOSED: a `None` means the interface is dropped, never judged by
/// its name (the deny-list this module replaces is exactly what a renamed adapter walks around; security round M3).
pub fn resolve_kind(kinds: Option<&std::collections::HashMap<u32, IfaceKind>>, index: u32) -> Option<IfaceKind> {
    if index == 0 {
        return None;
    }
    kinds?.get(&index).copied()
}

#[cfg(windows)]
mod imp {
    use super::{classify, resolve_kind};
    use crate::netdiag::{census_from, is_vpn_name, AdapterCensus, RawAdapter, Verdict};
    use cl_near::onlink::{kind_from_name, IfaceKind, InterfaceProvider, LocalInterface, SystemInterfaces};
    use std::collections::HashMap;
    use windows::Win32::NetworkManagement::IpHelper::{GetAdaptersAddresses, GetIfEntry2, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH, MIB_IF_ROW2};
    use windows::Win32::Networking::WinSock::AF_UNSPEC;

    /// IfIndex (IPv4 and IPv6) -> kind, for every adapter Windows lists. `None` when the enumeration itself fails.
    fn adapter_kinds() -> Option<HashMap<u32, IfaceKind>> {
        let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
        let mut size: u32 = 16 * 1024;
        let mut buf: Vec<u64> = Vec::new();
        for _ in 0..4 {
            buf = vec![0u64; (size as usize).div_ceil(8)];
            let p = buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH;
            // SAFETY: `buf` is 8-byte aligned and at least `size` bytes; Windows fills it with a linked list inside that buffer.
            let rc = unsafe { GetAdaptersAddresses(u32::from(AF_UNSPEC.0), flags, None, Some(p), &mut size) };
            match rc {
                0 => break,
                111 => continue, // ERROR_BUFFER_OVERFLOW: `size` now holds what is needed
                _ => return None,
            }
        }
        let mut out = HashMap::new();
        let mut cur = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
        // SAFETY: walking the list Windows just wrote into `buf` (which outlives the loop); every `Next` is null or inside it.
        while !cur.is_null() {
            let a = unsafe { &*cur };
            let v4 = unsafe { a.Anonymous1.Anonymous.IfIndex };
            let v6 = a.Ipv6IfIndex;
            let idx = if v4 != 0 { v4 } else { v6 };
            let mut row = MIB_IF_ROW2 { InterfaceIndex: idx, ..Default::default() };
            // SAFETY: `row` is a valid MIB_IF_ROW2 with InterfaceIndex set, as GetIfEntry2 requires.
            let ok = unsafe { GetIfEntry2(&mut row) }.0 == 0;
            let kind = if ok {
                let hardware = row.InterfaceAndOperStatusFlags._bitfield & 1 != 0;
                classify(a.IfType, hardware, row.PhysicalMediumType.0)
            } else {
                // cannot ask: the ifType alone cannot exclude a virtual switch, so refuse rather than guess
                IfaceKind::Virtual
            };
            for i in [v4, v6] {
                if i != 0 {
                    out.insert(i, kind);
                }
            }
            cur = a.Next;
        }
        Some(out)
    }

    /// `SystemInterfaces` refined with what Windows says about each adapter. FAILS CLOSED: a failed enumeration, an interface with no
    /// index, or one Windows does not list is dropped (no address is offered or accepted on it); the name deny-list is never a fallback.
    pub struct WindowsInterfaces;

    impl WindowsInterfaces {
        /// The same judgement as [`InterfaceProvider::interfaces`], but counting the adapters it leaves out and why (virtual / VPN-looking /
        /// could not be classified) for the diagnostic report. Counts only: names and indexes are read to classify and dropped.
        pub fn census() -> AdapterCensus {
            let list = match if_addrs::get_if_addrs() {
                Ok(l) => l,
                // the enumeration itself failed: say so rather than report a clean "no adapters"
                Err(_) => return AdapterCensus { filtered: 1, filtered_unresolved: 1, ..Default::default() },
            };
            let kinds = adapter_kinds();
            census_from(list.into_iter().filter(|i| !i.is_loopback()).map(|i| {
                let index = i.index.unwrap_or(0);
                let verdict = if kind_from_name(&i.name) == IfaceKind::Virtual {
                    Verdict::Virtual
                } else {
                    match resolve_kind(kinds.as_ref(), index) {
                        None => Verdict::Unresolved,
                        Some(k) if k.allowed() => Verdict::Eligible(k),
                        Some(_) => Verdict::Virtual,
                    }
                };
                RawAdapter { key: (index, if index == 0 { i.name.clone() } else { String::new() }), name_is_vpn: is_vpn_name(&i.name), verdict }
            }))
        }
    }

    impl InterfaceProvider for WindowsInterfaces {
        fn interfaces(&self) -> Vec<LocalInterface> {
            let kinds = adapter_kinds();
            SystemInterfaces
                .interfaces()
                .into_iter()
                .filter_map(|mut i| {
                    i.kind = resolve_kind(kinds.as_ref(), i.index)?;
                    i.kind.allowed().then_some(i)
                })
                .collect()
        }
    }
}

#[cfg(windows)]
pub use imp::WindowsInterfaces;

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn resolve_kind_fails_closed() {
        let m: HashMap<u32, IfaceKind> = [(7, IfaceKind::Wifi), (9, IfaceKind::Virtual)].into_iter().collect();
        assert_eq!(resolve_kind(Some(&m), 7), Some(IfaceKind::Wifi));
        assert_eq!(resolve_kind(Some(&m), 9), Some(IfaceKind::Virtual));
        // a missing index, an unlisted interface and a failed enumeration all yield no kind at all
        assert_eq!(resolve_kind(Some(&m), 0), None);
        assert_eq!(resolve_kind(Some(&m), 8), None);
        assert_eq!(resolve_kind(None, 7), None);
    }

    #[test]
    fn only_hardware_wifi_and_ethernet_count() {
        assert_eq!(classify(IF_TYPE_IEEE80211, true, MEDIUM_NATIVE_802_11), IfaceKind::Wifi);
        assert_eq!(classify(IF_TYPE_ETHERNET_CSMACD, true, MEDIUM_802_3), IfaceKind::Ethernet);
        assert_eq!(classify(IF_TYPE_ETHERNET_CSMACD, true, 0), IfaceKind::Ethernet);
    }

    #[test]
    fn a_virtual_adapter_is_excluded_whatever_its_type_says() {
        // Hyper-V / WSL switch, TAP, WireGuard, VMware NAT: ifType 6 (Ethernet) but not a hardware interface
        assert_eq!(classify(IF_TYPE_ETHERNET_CSMACD, false, MEDIUM_802_3), IfaceKind::Virtual);
        assert_eq!(classify(IF_TYPE_ETHERNET_CSMACD, false, 0), IfaceKind::Virtual);
        // the Wi-Fi Direct / hosted-network virtual adapter reports type 71 and is not hardware
        assert_eq!(classify(IF_TYPE_IEEE80211, false, MEDIUM_NATIVE_802_11), IfaceKind::Virtual);
    }

    #[test]
    fn tunnels_ppp_loopback_and_mobile_broadband_are_excluded() {
        for t in [131u32 /* tunnel */, 23 /* ppp */, 24 /* loopback */, 243 /* wwanpp */, 244 /* wwanpp2 */, 1 /* other */] {
            assert_eq!(classify(t, true, 0), IfaceKind::Virtual, "ifType {t}");
        }
        // hardware Ethernet type over a medium that is not 802.3 (e.g. a mobile modem pretending): not a shared LAN
        assert_eq!(classify(IF_TYPE_ETHERNET_CSMACD, true, 16), IfaceKind::Virtual);
    }
}
