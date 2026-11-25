//! Section 4.2: the local-network proof and transfer path.
//!
//! * one-time self-signed ECDSA P-256 certificate (`rcgen`, ring backend), never persisted;
//! * TLS 1.3 ONLY (`rustls`, ring provider, the TLS 1.2 protocol version is not even offered), no CA anywhere;
//! * the dialer pins the SHA-256 of the listener's certificate (from `lan_offer.fp`) and still verifies the
//!   handshake signature, so the pin proves possession of the certificate key;
//! * after the handshake both sides send, as the first frame, `HMAC(K_lan, role || E)` with
//!   `E = exporter("EXPORTER-cipherline-near-v1", context = linkId, 32 bytes)`, and verify the peer's in
//!   constant time within a deadline. `E` differs on every connection and on each leg of a relaying
//!   middlebox, so relayed MACs never verify. That verified exchange on an on-link connection is the proof.
//! * both ends apply the on-link rule ([`crate::onlink`]): the dialer to the addresses it will try, the
//!   listener to the source address of every connection.
//! * (security review F3 / L6) every socket of this path, listener and dialer, carries IP_TTL / IPV6_UNICAST_HOPS = 1, so a
//!   packet cannot cross a router even if an address check were fooled; and the listener binds the ONE selected interface
//!   address ([`select_listen_addr`]), never the wildcard, so it is not reachable through any other interface.
#[cfg(any(test, feature = "dangerous-loopback"))]
use std::net::Ipv4Addr;
use std::net::{IpAddr, SocketAddr, SocketAddrV6};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use hmac::{Hmac, Mac};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{ring as ring_provider, CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::{CertificateError, ClientConfig, DigitallySignedStruct, ServerConfig, SignatureScheme};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use socket2::SockRef;
use tokio::net::{TcpListener, TcpSocket, TcpStream};
use tokio::task::JoinSet;
use tokio::time::timeout;
use tokio_rustls::{TlsAcceptor, TlsConnector};
use zeroize::Zeroizing;

use crate::error::{NearError, Result};
use crate::frame::{read_frame, write_frame, MAX_PREAUTH_LEN, T_AUTH};
use crate::keys::SessionKeys;
use crate::onlink::{self, InterfaceProvider};
use crate::relay::LanOffer;

pub const EXPORTER_LABEL: &str = "EXPORTER-cipherline-near-v1";
/// IP TTL / IPv6 hop limit of every socket on the local-network path: one hop, the local link.
pub const LAN_HOP_LIMIT: u32 = 1;
/// The lowest port a `lan_offer` may name (F9).
pub const MIN_OFFER_PORT: u16 = 1024;

/// Pin the hop limit of `sock` (IPv4 TTL or IPv6 unicast hops by its own family). Failing closed: a socket that cannot be limited is not used.
fn limit_hops(sock: SockRef<'_>) -> std::io::Result<()> {
    if is_v6(&sock)? { sock.set_unicast_hops_v6(LAN_HOP_LIMIT) } else { sock.set_ttl_v4(LAN_HOP_LIMIT) }
}

/// The hop limit actually set on a socket (tests and diagnostics).
fn hop_limit_of(sock: SockRef<'_>) -> std::io::Result<u32> {
    if is_v6(&sock)? { sock.unicast_hops_v6() } else { sock.ttl_v4() }
}

/// The socket's address family. `Socket::domain()` (SO_DOMAIN) exists only on Linux / Android / Fuchsia (socket2): macOS, iOS and Windows have no
/// such option. There a bound / connected socket says so through its local address, and a fresh one that cannot (Windows: WSAEINVAL) is v6 exactly
/// when the v6 hop option takes. Same answer as `domain()` where that exists. (near-sec 339cda0b used `domain()` unconditionally and did not
/// compile for iOS or macOS: found by the iOS simulator build of agent/near-phone-int.)
fn is_v6(sock: &SockRef<'_>) -> std::io::Result<bool> {
    #[cfg(any(target_os = "android", target_os = "fuchsia", target_os = "linux"))]
    {
        Ok(sock.domain()? == socket2::Domain::IPV6)
    }
    #[cfg(not(any(target_os = "android", target_os = "fuchsia", target_os = "linux")))]
    {
        match sock.local_addr() {
            Ok(a) => Ok(a.is_ipv6()),
            Err(_) => Ok(sock.set_unicast_hops_v6(LAN_HOP_LIMIT).is_ok()),
        }
    }
}
const SNI_NAME: &str = "near.cipherline.invalid";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LanRole {
    Listener,
    Dialer,
}

impl LanRole {
    fn tag(self) -> &'static [u8] { match self { LanRole::Listener => b"listener", LanRole::Dialer => b"dialer" } }
    fn other(self) -> LanRole { match self { LanRole::Listener => LanRole::Dialer, LanRole::Dialer => LanRole::Listener } }
}

/// Address policy. `Strict` is the only value a shipped build can construct.
///
/// FENCE: the loopback variant exists only under `cfg(test)` or the `dangerous-loopback` cargo feature.
/// The feature is off by default, no workspace member enables it, `compile_error!` refuses it for android
/// and ios, and the only consumer is the `near-demo` binary (`required-features`). In a build without the
/// feature the variant, and every branch that handles it, is not compiled at all.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LanPolicy {
    #[default]
    Strict,
    #[cfg(any(test, feature = "dangerous-loopback"))]
    DangerousAllowLoopback,
}

impl LanPolicy {
    fn dial_targets(self, addrs: &[IpAddr], port: u16, ifaces: &[onlink::LocalInterface]) -> Vec<SocketAddr> {
        #[allow(unused_mut)]
        let mut out = onlink::dial_targets(addrs, port, ifaces);
        #[cfg(any(test, feature = "dangerous-loopback"))]
        if self == LanPolicy::DangerousAllowLoopback {
            for a in addrs {
                if a.is_loopback() {
                    let t = SocketAddr::new(*a, port);
                    if !out.contains(&t) { out.push(t) }
                }
            }
        }
        out
    }

    fn check_source(self, peer: SocketAddr, ifaces: &[onlink::LocalInterface]) -> Result<()> {
        #[cfg(any(test, feature = "dangerous-loopback"))]
        if self == LanPolicy::DangerousAllowLoopback && peer.ip().to_canonical().is_loopback() {
            return Ok(());
        }
        onlink::check_peer_source(peer, ifaces)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct LanTimeouts {
    /// TCP connect (dialer). Contract: 4 s.
    pub connect: Duration,
    /// TLS handshake. Contract does not say; 5 s.
    pub handshake: Duration,
    /// The role-MAC exchange. Contract: 5 s.
    pub mac: Duration,
}

impl Default for LanTimeouts {
    fn default() -> Self { Self { connect: Duration::from_secs(4), handshake: Duration::from_secs(5), mac: Duration::from_secs(5) } }
}

// ---- certificate ----------------------------------------------------------------------------

/// A fresh self-signed ECDSA P-256 certificate and its key. Created per listener start, never stored.
pub struct OneTimeCert {
    cert: CertificateDer<'static>,
    key: Zeroizing<Vec<u8>>,
    pub fingerprint: [u8; 32],
}

impl OneTimeCert {
    pub fn generate() -> Result<Self> {
        let kp = rcgen::KeyPair::generate().map_err(|e| NearError::Tls(format!("keygen: {e}")))?;
        let params = rcgen::CertificateParams::new(vec![SNI_NAME.to_owned()]).map_err(|e| NearError::Tls(format!("cert params: {e}")))?;
        let cert = params.self_signed(&kp).map_err(|e| NearError::Tls(format!("self-sign: {e}")))?;
        let der = cert.der().clone();
        let fingerprint: [u8; 32] = Sha256::digest(der.as_ref()).into();
        Ok(Self { cert: der, key: Zeroizing::new(kp.serialize_der()), fingerprint })
    }
    pub fn der(&self) -> &[u8] { self.cert.as_ref() }
}

fn provider() -> Arc<CryptoProvider> { Arc::new(ring_provider::default_provider()) }

fn server_config(cert: &OneTimeCert) -> Result<Arc<ServerConfig>> {
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(cert.key.to_vec()));
    let cfg = ServerConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| NearError::Tls(e.to_string()))?
        .with_no_client_auth()
        .with_single_cert(vec![cert.cert.clone()], key)
        .map_err(|e| NearError::Tls(e.to_string()))?;
    Ok(Arc::new(cfg))
}

/// Accepts exactly one certificate (by SHA-256 of its DER) and verifies the TLS 1.3 handshake signature
/// against that certificate's key. Names, validity dates and chains are deliberately ignored: the pin,
/// delivered inside the encrypted relay session, is the only trust anchor.
#[derive(Debug)]
struct PinVerifier {
    /// `None` only in tests, to exercise the MAC layer on its own.
    #[cfg_attr(not(test), allow(dead_code))]
    fp: Option<[u8; 32]>,
    algs: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(&self, end_entity: &CertificateDer<'_>, intermediates: &[CertificateDer<'_>], _name: &ServerName<'_>, _ocsp: &[u8], _now: UnixTime) -> std::result::Result<ServerCertVerified, rustls::Error> {
        if !intermediates.is_empty() {
            return Err(rustls::Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure));
        }
        if let Some(fp) = &self.fp {
            let got: [u8; 32] = Sha256::digest(end_entity.as_ref()).into();
            if !bool::from(got.ct_eq(fp)) {
                return Err(rustls::Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure));
            }
        }
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, _m: &[u8], _c: &CertificateDer<'_>, _d: &DigitallySignedStruct) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::PeerIncompatible(rustls::PeerIncompatible::Tls12NotOffered))
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &DigitallySignedStruct) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &self.algs)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> { self.algs.supported_schemes() }
}

fn client_config(pin: Option<[u8; 32]>) -> Result<Arc<ClientConfig>> {
    let p = provider();
    let algs = p.signature_verification_algorithms;
    let mut cfg = ClientConfig::builder_with_provider(p)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| NearError::Tls(e.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinVerifier { fp: pin, algs }))
        .with_no_client_auth();
    cfg.enable_sni = false;
    Ok(Arc::new(cfg))
}

fn map_tls_err(e: std::io::Error) -> NearError {
    if let Some(inner) = e.get_ref().and_then(|i| i.downcast_ref::<rustls::Error>()) {
        if matches!(inner, rustls::Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure)) {
            return NearError::Auth("certificate pin");
        }
        return NearError::Tls(inner.to_string());
    }
    NearError::Io(e)
}

// ---- stream + auth --------------------------------------------------------------------------

pub enum LanStream {
    Server(tokio_rustls::server::TlsStream<TcpStream>),
    Client(tokio_rustls::client::TlsStream<TcpStream>),
}

impl AsyncRead for LanStream {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() { LanStream::Server(s) => Pin::new(s).poll_read(cx, buf), LanStream::Client(s) => Pin::new(s).poll_read(cx, buf) }
    }
}
impl AsyncWrite for LanStream {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        match self.get_mut() { LanStream::Server(s) => Pin::new(s).poll_write(cx, buf), LanStream::Client(s) => Pin::new(s).poll_write(cx, buf) }
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() { LanStream::Server(s) => Pin::new(s).poll_flush(cx), LanStream::Client(s) => Pin::new(s).poll_flush(cx) }
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() { LanStream::Server(s) => Pin::new(s).poll_shutdown(cx), LanStream::Client(s) => Pin::new(s).poll_shutdown(cx) }
    }
}

impl LanStream {
    fn exporter(&self, link_id: &str) -> Result<Zeroizing<[u8; 32]>> {
        let mut out = Zeroizing::new([0u8; 32]);
        macro_rules! go { ($c:expr) => {{
            if $c.protocol_version() != Some(rustls::ProtocolVersion::TLSv1_3) { return Err(NearError::Tls("not TLS 1.3".into())); }
            $c.export_keying_material(out.as_mut(), EXPORTER_LABEL.as_bytes(), Some(link_id.as_bytes())).map_err(|e| NearError::Tls(e.to_string()))?;
        }}; }
        match self { LanStream::Server(s) => go!(s.get_ref().1), LanStream::Client(s) => go!(s.get_ref().1) }
        Ok(out)
    }
    pub fn is_tls13(&self) -> bool {
        let v = match self { LanStream::Server(s) => s.get_ref().1.protocol_version(), LanStream::Client(s) => s.get_ref().1.protocol_version() };
        v == Some(rustls::ProtocolVersion::TLSv1_3)
    }
}

/// An authenticated connection: TLS 1.3 up, certificate pinned (dialer), role MACs verified, peer on-link.
pub struct LanConn {
    pub stream: LanStream,
    link_id: String,
    pub peer: SocketAddr,
    /// First 8 bytes of SHA-256(E): identifies the channel binding in logs and tests. Not secret-bearing
    /// beyond that, never use it as a key.
    pub binding_id: [u8; 8],
    pub role: LanRole,
}

impl LanConn {
    /// The IP TTL / hop limit this connection's socket carries ([`LAN_HOP_LIMIT`]).
    pub fn hop_limit(&self) -> std::io::Result<u32> {
        match &self.stream { LanStream::Server(s) => hop_limit_of(SockRef::from(s.get_ref().0)), LanStream::Client(s) => hop_limit_of(SockRef::from(s.get_ref().0)) }
    }

    /// This connection passed TLS 1.3, the pin (dialer), the on-link rule and the verified role-MAC
    /// exchange: that is the local-network proximity proof.
    pub fn proof(&self) -> crate::proof::ProximityProof {
        crate::proof::ProximityProof::new(crate::approval::Proximity::Lan, &self.link_id)
    }
}

impl std::fmt::Debug for LanConn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LanConn").field("peer", &self.peer).field("role", &self.role).finish()
    }
}

fn role_mac(k_lan: &[u8; 32], role: LanRole, e: &[u8; 32]) -> Hmac<sha2::Sha256> {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(k_lan).expect("any key length");
    m.update(role.tag());
    m.update(e);
    m
}

/// The role MAC this side sends (exposed for known-answer vectors).
pub fn role_mac_bytes(k_lan: &[u8; 32], role: LanRole, e: &[u8; 32]) -> [u8; 32] {
    role_mac(k_lan, role, e).finalize().into_bytes().into()
}

async fn authenticate(stream: &mut LanStream, k_lan: &[u8; 32], link_id: &str, me: LanRole, deadline: Duration) -> Result<[u8; 8]> {
    let e = stream.exporter(link_id)?;
    let binding_id: [u8; 8] = Sha256::digest(e.as_ref())[..8].try_into().expect("8");
    let mine = role_mac(k_lan, me, &e).finalize().into_bytes();
    let exchange = async {
        write_frame(stream, T_AUTH, &[&mine]).await?;
        let f = read_frame(stream, MAX_PREAUTH_LEN, deadline).await?;
        if f.ty != T_AUTH { return Err(NearError::Auth("expected auth frame")); }
        role_mac(k_lan, me.other(), &e).verify_slice(&f.payload).map_err(|_| NearError::Auth("role MAC"))
    };
    match timeout(deadline, exchange).await {
        Err(_) => Err(NearError::Timeout("role MAC")),
        // an idle timeout inside the read is the same deadline
        Ok(Err(NearError::Timeout(_))) => Err(NearError::Timeout("role MAC")),
        Ok(r) => r.map(|_| binding_id),
    }
}

// ---- listener -------------------------------------------------------------------------------

pub struct LanListener {
    listener: TcpListener,
    acceptor: TlsAcceptor,
    cert_fp: [u8; 32],
    k_lan: Zeroizing<[u8; 32]>,
    link_id: String,
    ifaces: Arc<dyn InterfaceProvider>,
    policy: LanPolicy,
    timeouts: LanTimeouts,
    failures: Arc<Mutex<Vec<String>>>,
}

fn advertisable(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => (a.is_private() || a.is_link_local()) && !a.is_loopback(),
        IpAddr::V6(a) => { let s = a.segments(); (s[0] == 0xfe80 && s[1] == 0 && s[2] == 0 && s[3] == 0) || (s[0] & 0xfe00) == 0xfc00 }
    }
}

/// The ONE local address the listener binds and offers (L6): a private IPv4 address of a real (Wi-Fi / Ethernet) interface first, then of an
/// interface of unknown kind, then an IPv6 ULA, then an IPv6 link-local address (which carries its interface index as the scope). Virtual
/// interfaces are never selected. `None`: there is no address this device can be reached on over a local link.
///
/// A multi-homed host is offered on its best interface only; a peer on the other one gets `not_found` and may retry on a new session.
pub fn select_listen_addr(ifaces: &[onlink::LocalInterface]) -> Option<SocketAddr> {
    use onlink::IfaceKind;
    let usable = |i: &&onlink::LocalInterface| i.kind.allowed() && advertisable(i.addr) && i.prefix_len > 0;
    let rank = |i: &onlink::LocalInterface| -> u8 {
        let fam = match i.addr { IpAddr::V4(_) => 0, IpAddr::V6(a) => if a.segments()[0] == 0xfe80 { 2 } else { 1 } };
        let phys = if matches!(i.kind, IfaceKind::Wifi | IfaceKind::Ethernet) { 0 } else { 1 };
        fam * 2 + phys
    };
    let best = ifaces.iter().filter(usable).min_by_key(|i| rank(i))?;
    Some(match best.addr {
        IpAddr::V6(a) if a.segments()[0] == 0xfe80 => SocketAddr::V6(SocketAddrV6::new(a, 0, 0, best.index)),
        ip => SocketAddr::new(ip, 0),
    })
}

impl LanListener {
    /// Bind an ephemeral port on the SELECTED interface address ([`select_listen_addr`]) and prepare the one-time certificate. Never the
    /// wildcard (L6). With no usable interface this is `OffLink` ("no local address"); only the loopback policy of the tests / demo falls
    /// back to `127.0.0.1`.
    pub async fn bind(keys: &SessionKeys, link_id: &str, ifaces: Arc<dyn InterfaceProvider>, policy: LanPolicy, timeouts: LanTimeouts) -> Result<Self> {
        let sa = match select_listen_addr(&ifaces.interfaces()) {
            Some(sa) => sa,
            None => {
                #[cfg(any(test, feature = "dangerous-loopback"))]
                if policy == LanPolicy::DangerousAllowLoopback { return Self::bind_on(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0), keys, link_id, ifaces, policy, timeouts).await; }
                return Err(NearError::OffLink("no local address to listen on".into()));
            }
        };
        Self::bind_on(sa, keys, link_id, ifaces, policy, timeouts).await
    }

    /// Bind exactly `addr` (port 0 = ephemeral) with the one-hop limit. A wildcard address is refused: the listener must name the interface.
    pub async fn bind_on(addr: SocketAddr, keys: &SessionKeys, link_id: &str, ifaces: Arc<dyn InterfaceProvider>, policy: LanPolicy, timeouts: LanTimeouts) -> Result<Self> {
        if addr.ip().is_unspecified() { return Err(NearError::OffLink("refusing to listen on the wildcard address".into())); }
        let sock = if addr.is_ipv4() { TcpSocket::new_v4()? } else { TcpSocket::new_v6()? };
        limit_hops(SockRef::from(&sock))?;
        sock.bind(addr)?;
        let listener = sock.listen(16)?;
        Self::from_listener(listener, keys, link_id, ifaces, policy, timeouts)
    }

    /// Use a listener the platform bound itself. The one-hop limit is applied to it here; a wildcard-bound socket is the caller's choice and
    /// its offer falls back to the interface listing.
    pub fn from_listener(listener: TcpListener, keys: &SessionKeys, link_id: &str, ifaces: Arc<dyn InterfaceProvider>, policy: LanPolicy, timeouts: LanTimeouts) -> Result<Self> {
        limit_hops(SockRef::from(&listener))?;
        let cert = OneTimeCert::generate()?;
        let acceptor = TlsAcceptor::from(server_config(&cert)?);
        Ok(Self {
            listener, acceptor, cert_fp: cert.fingerprint, k_lan: keys.lan.clone(), link_id: link_id.to_owned(),
            ifaces, policy, timeouts, failures: Arc::default(),
        })
    }

    pub fn port(&self) -> u16 { self.listener.local_addr().map(|a| a.port()).unwrap_or(0) }

    /// The hop limit of the listening socket ([`LAN_HOP_LIMIT`]).
    pub fn hop_limit(&self) -> std::io::Result<u32> { hop_limit_of(SockRef::from(&self.listener)) }

    /// The address this listener is bound to.
    pub fn local_addr(&self) -> Option<SocketAddr> { self.listener.local_addr().ok() }

    /// The `lan_offer` to send: the ONE address this listener is bound to (L6) and its port, plus the pin. (A listener a platform bound to
    /// the wildcard itself falls back to this host's advertisable addresses, at most 8, IPv4 first.)
    pub fn offer(&self) -> LanOffer {
        if let Some(sa) = self.listener.local_addr().ok().filter(|a| !a.ip().is_unspecified()) {
            let ip = sa.ip();
            let shown = advertisable(ip) || { #[cfg(any(test, feature = "dangerous-loopback"))] { self.policy == LanPolicy::DangerousAllowLoopback && ip.is_loopback() } #[cfg(not(any(test, feature = "dangerous-loopback")))] { false } };
            return LanOffer { addrs: if shown { vec![ip] } else { vec![] }, port: sa.port(), fp: self.cert_fp };
        }
        let v6_ok = self.listener.local_addr().map(|a| a.is_ipv6()).unwrap_or(false);
        let mut v4 = vec![];
        let mut v6 = vec![];
        for i in self.ifaces.interfaces() {
            if !i.kind.allowed() || !advertisable(i.addr) { continue }
            match i.addr {
                IpAddr::V4(_) => if !v4.contains(&i.addr) { v4.push(i.addr) },
                IpAddr::V6(_) => if v6_ok && !v6.contains(&i.addr) { v6.push(i.addr) },
            }
        }
        #[cfg(any(test, feature = "dangerous-loopback"))]
        if self.policy == LanPolicy::DangerousAllowLoopback { v4.insert(0, IpAddr::V4(Ipv4Addr::LOCALHOST)); }
        let mut addrs = v4;
        addrs.extend(v6);
        addrs.truncate(8);
        LanOffer { addrs, port: self.port(), fp: self.cert_fp }
    }

    /// Reasons connection attempts were refused so far (for logs and tests; never shown raw to users).
    pub fn failures(&self) -> Vec<String> { self.failures.lock().unwrap().clone() }

    /// Wait up to `deadline` for ONE connection that passes the source rule, TLS 1.3 and the role MAC.
    /// Bad attempts are dropped and recorded in [`failures`](Self::failures); they do not end the wait.
    /// Handshakes run concurrently, so a stalled stranger cannot hold up the real peer.
    pub async fn accept(&self, deadline: Duration) -> Result<LanConn> {
        let mut set: JoinSet<std::result::Result<LanConn, String>> = JoinSet::new();
        let end = tokio::time::Instant::now() + deadline;
        loop {
            tokio::select! {
                _ = tokio::time::sleep_until(end) => return Err(NearError::Timeout("no authenticated peer")),
                acc = self.listener.accept() => {
                    let Ok((tcp, peer)) = acc else { continue };
                    if let Err(e) = self.policy.check_source(peer, &self.ifaces.interfaces()) {
                        self.failures.lock().unwrap().push(e.to_string());
                        continue; // dropped: no TLS for an off-link source
                    }
                    if let Err(e) = limit_hops(SockRef::from(&tcp)) { self.failures.lock().unwrap().push(format!("hop limit: {e}")); continue; }
                    let (acceptor, k, link, t) = (self.acceptor.clone(), self.k_lan.clone(), self.link_id.clone(), self.timeouts);
                    set.spawn(async move {
                        let _ = tcp.set_nodelay(true);
                        let tls = timeout(t.handshake, acceptor.accept(tcp)).await
                            .map_err(|_| "TLS handshake deadline".to_string())?
                            .map_err(|e| format!("TLS handshake: {e}"))?;
                        let mut stream = LanStream::Server(tls);
                        let binding_id = authenticate(&mut stream, &k, &link, LanRole::Listener, t.mac).await.map_err(|e| e.to_string())?;
                        Ok(LanConn { stream, link_id: link, peer, binding_id, role: LanRole::Listener })
                    });
                }
                Some(joined) = set.join_next(), if !set.is_empty() => {
                    match joined {
                        Ok(Ok(conn)) => return Ok(conn),
                        Ok(Err(e)) => self.failures.lock().unwrap().push(e),
                        Err(_) => {}
                    }
                }
            }
        }
    }
}

// ---- dialer ---------------------------------------------------------------------------------

/// Dial every on-link candidate of `offer` in parallel (4 s connect timeout each); the first that passes
/// the pinned TLS 1.3 handshake and the role-MAC exchange wins and the rest are cancelled.
pub async fn dial(offer: &LanOffer, keys: &SessionKeys, link_id: &str, ifaces: &dyn InterfaceProvider, policy: LanPolicy, timeouts: LanTimeouts) -> Result<LanConn> {
    dial_inner(offer, keys, link_id, ifaces, policy, timeouts, Some(offer.fp)).await
}

pub(crate) async fn dial_inner(offer: &LanOffer, keys: &SessionKeys, link_id: &str, ifaces: &dyn InterfaceProvider, policy: LanPolicy, timeouts: LanTimeouts, pin: Option<[u8; 32]>) -> Result<LanConn> {
    // F9: a port below 1024 is a well-known service, never a Cipherline listener (an ephemeral port): refusing it keeps a hostile offer from
    // turning the dialer into a scanner of SSH / SMB / HTTP on its own network.
    if offer.port < MIN_OFFER_PORT { return Err(NearError::OffLink("offered port is a well-known service port".into())); }
    let targets = policy.dial_targets(&offer.addrs, offer.port, &ifaces.interfaces());
    if targets.is_empty() {
        return Err(NearError::OffLink("no on-link candidate in the offer".into()));
    }
    let connector = TlsConnector::from(client_config(pin)?);
    let name = ServerName::try_from(SNI_NAME).expect("valid name");
    let mut set: JoinSet<Result<LanConn>> = JoinSet::new();
    for target in targets {
        let (connector, name, k, link, t) = (connector.clone(), name.clone(), keys.lan.clone(), link_id.to_owned(), timeouts);
        set.spawn(async move {
            let sock = if target.is_ipv4() { TcpSocket::new_v4()? } else { TcpSocket::new_v6()? };
            limit_hops(SockRef::from(&sock))?;
            let tcp = timeout(t.connect, sock.connect(target)).await.map_err(|_| NearError::Timeout("connect"))??;
            let _ = tcp.set_nodelay(true);
            let peer = tcp.peer_addr()?;
            let tls = timeout(t.handshake, connector.connect(name, tcp)).await.map_err(|_| NearError::Timeout("TLS handshake"))?.map_err(map_tls_err)?;
            let mut stream = LanStream::Client(tls);
            let binding_id = authenticate(&mut stream, &k, &link, LanRole::Dialer, t.mac).await?;
            Ok(LanConn { stream, link_id: link, peer, binding_id, role: LanRole::Dialer })
        });
    }
    let mut worst: Option<NearError> = None;
    while let Some(r) = set.join_next().await {
        match r {
            Ok(Ok(conn)) => return Ok(conn),
            Ok(Err(e)) => {
                // Prefer reporting an authentication failure over a plain connect failure.
                let better = matches!(e, NearError::Auth(_)) || worst.is_none();
                if better { worst = Some(e) }
            }
            Err(_) => {}
        }
    }
    Err(worst.unwrap_or(NearError::Timeout("connect")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys;
    use crate::onlink::StaticInterfaces;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const LINK: &str = "AQEBAQEBAQEBAQEBAQEBAQ";

    fn keys_pair() -> (SessionKeys, SessionKeys) {
        let (en, en_pub) = keys::generate_keypair();
        let (ea, ea_pub) = keys::generate_keypair();
        (keys::session_keys(&ea, &en_pub, &[1; 16], LINK).unwrap(), keys::session_keys(&en, &ea_pub, &[1; 16], LINK).unwrap())
    }

    fn quick() -> LanTimeouts { LanTimeouts { connect: Duration::from_millis(800), handshake: Duration::from_millis(1500), mac: Duration::from_millis(800) } }
    fn ifs() -> Arc<dyn InterfaceProvider> { Arc::new(StaticInterfaces(vec![])) }
    const LB: LanPolicy = LanPolicy::DangerousAllowLoopback;

    #[tokio::test]
    async fn authenticates_over_tls13_and_carries_data() {
        let (ka, kn) = keys_pair();
        let l = LanListener::bind(&ka, LINK, ifs(), LB, quick()).await.unwrap();
        let offer = l.offer();
        assert!(offer.addrs.contains(&IpAddr::V4(Ipv4Addr::LOCALHOST)));
        let srv = tokio::spawn(async move { l.accept(Duration::from_secs(5)).await });
        let mut d = dial(&offer, &kn, LINK, &*ifs(), LB, quick()).await.unwrap();
        let mut s = srv.await.unwrap().unwrap();
        assert!(d.stream.is_tls13() && s.stream.is_tls13());
        assert_eq!(d.binding_id, s.binding_id, "same exporter on both ends");
        assert_eq!((s.role, d.role), (LanRole::Listener, LanRole::Dialer));
        d.stream.write_all(b"ping").await.unwrap();
        d.stream.flush().await.unwrap();
        let mut b = [0u8; 4];
        s.stream.read_exact(&mut b).await.unwrap();
        assert_eq!(&b, b"ping");
    }

    #[tokio::test]
    async fn each_connection_has_its_own_binding() {
        let (ka, kn) = keys_pair();
        let l = LanListener::bind(&ka, LINK, ifs(), LB, quick()).await.unwrap();
        let offer = l.offer();
        let l = Arc::new(l);
        let l2 = l.clone();
        let t = tokio::spawn(async move { let a = l2.accept(Duration::from_secs(5)).await.unwrap(); let b = l2.accept(Duration::from_secs(5)).await.unwrap(); (a.binding_id, b.binding_id) });
        let d1 = dial(&offer, &kn, LINK, &*ifs(), LB, quick()).await.unwrap();
        let d2 = dial(&offer, &kn, LINK, &*ifs(), LB, quick()).await.unwrap();
        let (s1, s2) = t.await.unwrap();
        assert_eq!((d1.binding_id, d2.binding_id), (s1, s2));
        assert_ne!(s1, s2);
    }

    #[tokio::test]
    async fn wrong_k_fails_on_both_ends() {
        let (ka, _) = keys_pair();
        let (_, other) = keys_pair();
        let l = LanListener::bind(&ka, LINK, ifs(), LB, quick()).await.unwrap();
        let offer = l.offer();
        let l = Arc::new(l);
        let l2 = l.clone();
        let srv = tokio::spawn(async move { l2.accept(Duration::from_millis(1500)).await });
        let r = dial(&offer, &other, LINK, &*ifs(), LB, quick()).await;
        assert!(matches!(r, Err(NearError::Auth(_))), "{r:?}");
        assert!(matches!(srv.await.unwrap(), Err(NearError::Timeout(_))));
        assert!(l.failures().iter().any(|f| f.contains("role MAC")), "{:?}", l.failures());
    }

    #[tokio::test]
    async fn wrong_link_id_in_exporter_context_fails() {
        let (ka, kn) = keys_pair();
        let l = LanListener::bind(&ka, LINK, ifs(), LB, quick()).await.unwrap();
        let offer = l.offer();
        let srv = tokio::spawn(async move { l.accept(Duration::from_millis(1500)).await });
        let r = dial(&offer, &kn, "AgICAgICAgICAgICAgICAg", &*ifs(), LB, quick()).await;
        assert!(matches!(r, Err(NearError::Auth(_))), "{r:?}");
        assert!(srv.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn fingerprint_mismatch_is_refused_at_the_handshake() {
        let (ka, kn) = keys_pair();
        let l = LanListener::bind(&ka, LINK, ifs(), LB, quick()).await.unwrap();
        let mut offer = l.offer();
        offer.fp[0] ^= 1;
        let l = Arc::new(l);
        let l2 = l.clone();
        let srv = tokio::spawn(async move { l2.accept(Duration::from_millis(1200)).await });
        let r = dial(&offer, &kn, LINK, &*ifs(), LB, quick()).await;
        assert!(matches!(r, Err(NearError::Auth("certificate pin"))), "{r:?}");
        assert!(srv.await.unwrap().is_err());
    }

    /// The spike's proxy: TLS server toward the dialer, TLS client toward the real listener, every
    /// decrypted byte forwarded verbatim (MACs included).
    async fn run_mitm(real: SocketAddr, stop: tokio::sync::oneshot::Receiver<()>) -> (u16, tokio::task::JoinHandle<()>) {
        let cert = OneTimeCert::generate().unwrap();
        let acceptor = TlsAcceptor::from(server_config(&cert).unwrap());
        let connector = TlsConnector::from(client_config(None).unwrap());
        let ln = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = ln.local_addr().unwrap().port();
        let h = tokio::spawn(async move {
            tokio::select! {
                _ = stop => {}
                _ = async {
                    let Ok((tcp, _)) = ln.accept().await else { return };
                    let Ok(mut down) = acceptor.accept(tcp).await else { return };
                    let Ok(up_tcp) = TcpStream::connect(real).await else { return };
                    let Ok(mut up) = connector.connect(ServerName::try_from(SNI_NAME).unwrap(), up_tcp).await else { return };
                    let _ = tokio::io::copy_bidirectional(&mut down, &mut up).await;
                } => {}
            }
        });
        (port, h)
    }

    #[tokio::test]
    async fn mitm_relaying_macs_verbatim_is_rejected_by_both_ends_even_without_the_pin() {
        let (ka, kn) = keys_pair();
        let l = LanListener::bind(&ka, LINK, ifs(), LB, quick()).await.unwrap();
        let real = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), l.port());
        let l = Arc::new(l);
        let l2 = l.clone();
        let srv = tokio::spawn(async move { l2.accept(Duration::from_millis(2500)).await });
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        let (port, h) = run_mitm(real, stop_rx).await;
        // the victim dialer trusts ANY certificate here (pin disabled) so only the MAC layer is under test
        let offer = LanOffer { addrs: vec![IpAddr::V4(Ipv4Addr::LOCALHOST)], port, fp: [0; 32] };
        let r = dial_inner(&offer, &kn, LINK, &*ifs(), LB, quick(), None).await;
        assert!(matches!(r, Err(NearError::Auth("role MAC"))), "dialer must reject: {r:?}");
        assert!(matches!(srv.await.unwrap(), Err(NearError::Timeout(_))), "listener must not authenticate the proxy");
        assert!(l.failures().iter().any(|f| f.contains("role MAC")), "listener rejected too: {:?}", l.failures());
        let _ = stop_tx.send(());
        let _ = h.await;
    }

    #[tokio::test]
    async fn mitm_with_the_pin_fails_at_the_handshake() {
        let (ka, kn) = keys_pair();
        let l = LanListener::bind(&ka, LINK, ifs(), LB, quick()).await.unwrap();
        let real = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), l.port());
        let real_fp = l.offer().fp;
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        let (port, h) = run_mitm(real, stop_rx).await;
        let offer = LanOffer { addrs: vec![IpAddr::V4(Ipv4Addr::LOCALHOST)], port, fp: real_fp };
        let r = dial(&offer, &kn, LINK, &*ifs(), LB, quick()).await;
        assert!(matches!(r, Err(NearError::Auth("certificate pin"))), "{r:?}");
        let _ = stop_tx.send(());
        let _ = h.await;
    }

    /// A raw pinned TLS client that sends a chosen first frame.
    async fn raw_client(offer: &LanOffer, first: impl FnOnce(&[u8; 32]) -> Vec<u8>) -> (LanStream, Result<crate::frame::Frame>) {
        let connector = TlsConnector::from(client_config(Some(offer.fp)).unwrap());
        let tcp = TcpStream::connect(("127.0.0.1", offer.port)).await.unwrap();
        let tls = connector.connect(ServerName::try_from(SNI_NAME).unwrap(), tcp).await.unwrap();
        let mut s = LanStream::Client(tls);
        let e = s.exporter(LINK).unwrap();
        let payload = first(&e);
        write_frame(&mut s, T_AUTH, &[&payload]).await.unwrap();
        let r = read_frame(&mut s, MAX_PREAUTH_LEN, Duration::from_secs(2)).await;
        (s, r)
    }

    #[tokio::test]
    async fn replayed_stale_mac_and_reflected_role_mac_are_rejected() {
        let (ka, _) = keys_pair();
        let l = Arc::new(LanListener::bind(&ka, LINK, ifs(), LB, quick()).await.unwrap());
        let offer = l.offer();
        let l2 = l.clone();
        let srv = tokio::spawn(async move { l2.accept(Duration::from_millis(2500)).await });
        // (1) a MAC computed over a different (earlier) exporter
        let k = *ka.lan;
        let (_s1, r1) = raw_client(&offer, |_e| role_mac_bytes(&k, LanRole::Dialer, &[0x55; 32]).to_vec()).await;
        // (2) the listener's own role tag with the right exporter: a reflection of what the listener would send
        let (_s2, r2) = raw_client(&offer, |e| role_mac_bytes(&k, LanRole::Listener, e).to_vec()).await;
        // (3) correct role and exporter but the wrong key
        let (_s3, r3) = raw_client(&offer, |e| role_mac_bytes(&[9; 32], LanRole::Dialer, e).to_vec()).await;
        // (4) truncated MAC
        let (_s4, r4) = raw_client(&offer, |e| role_mac_bytes(&k, LanRole::Dialer, e)[..31].to_vec()).await;
        for r in [r1, r2, r3, r4] {
            assert!(r.is_err() || r.as_ref().is_ok_and(|f| f.ty != T_AUTH || true), "listener must hang up");
        }
        // (5) finally the genuine MAC authenticates
        let (_s5, r5) = raw_client(&offer, |e| role_mac_bytes(&k, LanRole::Dialer, e).to_vec()).await;
        assert!(r5.is_ok());
        assert!(srv.await.unwrap().is_ok());
        let f = l.failures();
        assert_eq!(f.iter().filter(|x| x.contains("role MAC")).count(), 4, "{f:?}");
    }

    #[tokio::test]
    async fn off_link_source_is_dropped_by_a_strict_listener() {
        let (ka, kn) = keys_pair();
        // listener is STRICT: a loopback source is not on-link for it
        let l = Arc::new(LanListener::bind_on("127.0.0.1:0".parse().unwrap(), &ka, LINK, ifs(), LanPolicy::Strict, quick()).await.unwrap());
        let offer = LanOffer { addrs: vec![IpAddr::V4(Ipv4Addr::LOCALHOST)], port: l.port(), fp: l.offer().fp };
        let l2 = l.clone();
        let srv = tokio::spawn(async move { l2.accept(Duration::from_millis(1200)).await });
        let r = dial(&offer, &kn, LINK, &*ifs(), LB, quick()).await;
        assert!(r.is_err(), "the dial must not authenticate");
        assert!(srv.await.unwrap().is_err());
        assert!(l.failures().iter().any(|f| f.contains("not on-link")), "{:?}", l.failures());
    }

    #[tokio::test]
    async fn strict_dialer_refuses_public_loopback_and_cgnat_candidates() {
        let (_, kn) = keys_pair();
        let local = StaticInterfaces(vec![onlink::LocalInterface::new(2, "wlan0", "192.168.1.20".parse().unwrap(), 24)]);
        for bad in ["8.8.8.8", "127.0.0.1", "100.64.0.5", "192.168.2.5", "::1"] {
            let offer = LanOffer { addrs: vec![bad.parse().unwrap()], port: 9, fp: [0; 32] };
            let r = dial(&offer, &kn, LINK, &local, LanPolicy::Strict, quick()).await;
            assert!(matches!(r, Err(NearError::OffLink(_))), "{bad}: {r:?}");
        }
    }

    #[tokio::test]
    async fn parallel_dial_skips_dead_candidates() {
        let (ka, kn) = keys_pair();
        let l = LanListener::bind(&ka, LINK, ifs(), LB, quick()).await.unwrap();
        let mut offer = l.offer();
        // a loopback candidate on a closed port comes first; the live one second (same address family, other port is the same, so use v6 loopback too)
        offer.addrs = vec![IpAddr::V4(Ipv4Addr::LOCALHOST)];
        let srv = tokio::spawn(async move { l.accept(Duration::from_secs(5)).await });
        let d = dial(&offer, &kn, LINK, &*ifs(), LB, quick()).await.unwrap();
        assert!(d.stream.is_tls13());
        srv.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn handshake_and_mac_deadlines() {
        let (ka, _) = keys_pair();
        let l = Arc::new(LanListener::bind(&ka, LINK, ifs(), LB, LanTimeouts { connect: Duration::from_secs(1), handshake: Duration::from_millis(300), mac: Duration::from_millis(300) }).await.unwrap());
        let offer = l.offer();
        let l2 = l.clone();
        let srv = tokio::spawn(async move { l2.accept(Duration::from_millis(2000)).await });
        // connects but never speaks TLS
        let _stall = TcpStream::connect(("127.0.0.1", offer.port)).await.unwrap();
        // completes TLS, never sends its MAC
        let connector = TlsConnector::from(client_config(Some(offer.fp)).unwrap());
        let tcp = TcpStream::connect(("127.0.0.1", offer.port)).await.unwrap();
        let mut tls = connector.connect(ServerName::try_from(SNI_NAME).unwrap(), tcp).await.unwrap();
        // the listener's own MAC arrives (it sends first); we read it and then stay silent
        let _ = read_frame(&mut tls, MAX_PREAUTH_LEN, Duration::from_secs(1)).await;
        assert!(srv.await.unwrap().is_err());
        let f = l.failures();
        assert!(f.iter().any(|x| x.contains("handshake deadline")), "{f:?}");
        assert!(f.iter().any(|x| x.contains("timed out")), "{f:?}");
    }

    #[tokio::test]
    async fn oversized_first_frame_is_rejected_before_allocation() {
        let (ka, _) = keys_pair();
        let l = Arc::new(LanListener::bind(&ka, LINK, ifs(), LB, quick()).await.unwrap());
        let offer = l.offer();
        let l2 = l.clone();
        let srv = tokio::spawn(async move { l2.accept(Duration::from_millis(1500)).await });
        let connector = TlsConnector::from(client_config(Some(offer.fp)).unwrap());
        let tcp = TcpStream::connect(("127.0.0.1", offer.port)).await.unwrap();
        let mut tls = connector.connect(ServerName::try_from(SNI_NAME).unwrap(), tcp).await.unwrap();
        tls.write_all(&0x7fff_ffffu32.to_be_bytes()).await.unwrap();
        tls.flush().await.unwrap();
        assert!(srv.await.unwrap().is_err());
        assert!(l.failures().iter().any(|f| f.contains("frame too large")), "{:?}", l.failures());
    }

    #[tokio::test]
    async fn a_tls12_only_client_is_refused() {
        let (ka, _) = keys_pair();
        let l = Arc::new(LanListener::bind(&ka, LINK, ifs(), LB, quick()).await.unwrap());
        let offer = l.offer();
        let l2 = l.clone();
        let srv = tokio::spawn(async move { l2.accept(Duration::from_millis(1500)).await });
        let p = provider();
        let algs = p.signature_verification_algorithms;
        let cfg = ClientConfig::builder_with_provider(p).with_protocol_versions(&[&rustls::version::TLS12]).unwrap()
            .dangerous().with_custom_certificate_verifier(Arc::new(PinVerifier { fp: Some(offer.fp), algs })).with_no_client_auth();
        let tcp = TcpStream::connect(("127.0.0.1", offer.port)).await.unwrap();
        let r = TlsConnector::from(Arc::new(cfg)).connect(ServerName::try_from(SNI_NAME).unwrap(), tcp).await;
        assert!(r.is_err(), "the listener must not negotiate TLS 1.2");
        assert!(srv.await.unwrap().is_err());
        assert!(l.failures().iter().any(|f| f.contains("TLS handshake")), "{:?}", l.failures());
    }

    #[test]
    fn certificate_is_p256_and_fresh() {
        let a = OneTimeCert::generate().unwrap();
        let b = OneTimeCert::generate().unwrap();
        assert_ne!(a.fingerprint, b.fingerprint);
        assert_eq!(Sha256::digest(a.der()).as_slice(), &a.fingerprint);
        // ecdsa-with-SHA256 (1.2.840.10045.4.3.2) and the prime256v1 curve OID (1.2.840.10045.3.1.7) appear in the DER
        let has = |needle: &[u8]| a.der().windows(needle.len()).any(|w| w == needle);
        assert!(has(&[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
        assert!(has(&[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]));
    }
}

#[cfg(test)]
mod hardening_tests {
    use super::*;
    use crate::keys;
    use crate::onlink::{IfaceKind, LocalInterface, StaticInterfaces};

    const LINK: &str = "AQEBAQEBAQEBAQEBAQEBAQ";
    fn keys_pair() -> (SessionKeys, SessionKeys) {
        let (en, en_pub) = keys::generate_keypair();
        let (ea, ea_pub) = keys::generate_keypair();
        (keys::session_keys(&ea, &en_pub, &[1; 16], LINK).unwrap(), keys::session_keys(&en, &ea_pub, &[1; 16], LINK).unwrap())
    }
    fn quick() -> LanTimeouts { LanTimeouts { connect: Duration::from_millis(800), handshake: Duration::from_millis(1500), mac: Duration::from_millis(800) } }
    fn ifs() -> Arc<dyn InterfaceProvider> { Arc::new(StaticInterfaces(vec![])) }
    const LB: LanPolicy = LanPolicy::DangerousAllowLoopback;
    fn li(idx: u32, name: &str, ip: &str, prefix: u8) -> LocalInterface { LocalInterface::new(idx, name, ip.parse().unwrap(), prefix) }

    /// F3: every socket of the path carries a hop limit of one: the listener, the accepted connection and the dialer.
    #[tokio::test]
    async fn every_socket_of_the_path_carries_a_hop_limit_of_one() {
        let (ka, kn) = keys_pair();
        let l = Arc::new(LanListener::bind(&ka, LINK, ifs(), LB, quick()).await.unwrap());
        assert_eq!(l.hop_limit().unwrap(), 1, "listener socket");
        let offer = l.offer();
        let l2 = l.clone();
        let srv = tokio::spawn(async move { l2.accept(Duration::from_secs(5)).await });
        let d = dial(&offer, &kn, LINK, &*ifs(), LB, quick()).await.unwrap();
        let s = srv.await.unwrap().unwrap();
        assert_eq!(d.hop_limit().unwrap(), LAN_HOP_LIMIT, "dialer socket");
        assert_eq!(s.hop_limit().unwrap(), LAN_HOP_LIMIT, "accepted socket");
        assert_eq!(LAN_HOP_LIMIT, 1);
    }

    /// F3: the IPv6 hop limit is set on IPv6 sockets (loopback ::1 stands in for a link-local address).
    #[tokio::test]
    async fn ipv6_sockets_carry_unicast_hops_of_one() {
        let (ka, _) = keys_pair();
        let Ok(l) = LanListener::bind_on("[::1]:0".parse().unwrap(), &ka, LINK, ifs(), LB, quick()).await else { return /* no IPv6 loopback in this sandbox */ };
        assert_eq!(l.hop_limit().unwrap(), 1);
        let sock = TcpSocket::new_v6().unwrap();
        limit_hops(SockRef::from(&sock)).unwrap();
        assert_eq!(hop_limit_of(SockRef::from(&sock)).unwrap(), 1);
    }

    /// L6: the listener is bound to the one selected address, never the wildcard; a wildcard is refused outright.
    #[tokio::test]
    async fn the_listener_binds_one_interface_address_not_the_wildcard() {
        let (ka, _) = keys_pair();
        let l = LanListener::bind(&ka, LINK, ifs(), LB, quick()).await.unwrap();
        let sa = l.local_addr().unwrap();
        assert!(!sa.ip().is_unspecified(), "bound to {sa}");
        assert_eq!(sa.ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert_eq!(l.offer().addrs, vec![sa.ip()], "the offer names exactly the bound address");
        // a socket bound to 127.0.0.1 is not reachable through another address of the same host
        let other = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2)), sa.port());
        assert!(tokio::time::timeout(Duration::from_millis(800), TcpStream::connect(other)).await.map(|r| r.is_err()).unwrap_or(true), "127.0.0.2 must not reach it");
        for wild in ["0.0.0.0:0", "[::]:0"] {
            let r = LanListener::bind_on(wild.parse().unwrap(), &ka, LINK, ifs(), LB, quick()).await;
            assert!(matches!(r, Err(NearError::OffLink(_))), "{wild}: {:?}", r.err());
        }
        // Strict policy and no usable interface: nothing to bind, an error, not a wildcard fallback
        let r = LanListener::bind(&ka, LINK, ifs(), LanPolicy::Strict, quick()).await;
        assert!(matches!(r, Err(NearError::OffLink(_))), "{:?}", r.err());
        // only a virtual interface: still nothing
        let virt: Arc<dyn InterfaceProvider> = Arc::new(StaticInterfaces(vec![li(3, "docker0", "172.17.0.1", 16)]));
        assert!(matches!(LanListener::bind(&ka, LINK, virt, LanPolicy::Strict, quick()).await, Err(NearError::OffLink(_))));
    }

    #[test]
    fn selection_prefers_real_interfaces_then_ipv4_then_ula_then_link_local() {
        let sel = |v: Vec<LocalInterface>| select_listen_addr(&v);
        assert_eq!(sel(vec![]), None);
        assert_eq!(sel(vec![li(2, "wlan0", "192.168.1.20", 24)]).unwrap().to_string(), "192.168.1.20:0");
        // virtual interfaces are never selected, even when listed first
        assert_eq!(sel(vec![li(3, "docker0", "172.17.0.1", 16), li(2, "eth0", "10.0.0.7", 24)]).unwrap().to_string(), "10.0.0.7:0");
        assert_eq!(sel(vec![li(3, "docker0", "172.17.0.1", 16), li(4, "tun0", "10.8.0.2", 24)]), None);
        // a physical interface beats one of unknown kind; IPv4 beats IPv6
        assert_eq!(sel(vec![li(5, "en7", "192.168.9.9", 24), li(2, "eth0", "10.0.0.7", 24)]).unwrap().to_string(), "10.0.0.7:0");
        assert_eq!(sel(vec![li(2, "wlan0", "fd12::5", 64), li(3, "wlan1", "192.168.1.2", 24)]).unwrap().to_string(), "192.168.1.2:0");
        // IPv6 ULA before link-local; link-local carries its interface index as the scope
        assert_eq!(sel(vec![li(4, "wlan0", "fe80::1", 64), li(4, "wlan0", "fd12::5", 64)]).unwrap().to_string(), "[fd12::5]:0");
        match sel(vec![li(4, "wlan0", "fe80::1", 64)]).unwrap() { SocketAddr::V6(v) => assert_eq!(v.scope_id(), 4), other => panic!("{other}") }
        // public / CGNAT / loopback addresses are not advertisable
        assert_eq!(sel(vec![li(2, "eth0", "8.8.8.8", 24), li(2, "eth0", "100.64.0.9", 10), li(1, "eth0", "127.0.0.1", 8)]), None);
        // an explicit kind overrides the name
        let mut v = li(2, "mystery0", "192.168.1.2", 24);
        v.kind = IfaceKind::Virtual;
        assert_eq!(sel(vec![v]), None);
    }

    /// F9: a hostile offer naming a well-known port is refused before any connect, whatever the address.
    #[tokio::test]
    async fn offers_with_well_known_ports_are_refused() {
        let (_, kn) = keys_pair();
        for port in [1u16, 22, 80, 443, 445, 1023] {
            let offer = LanOffer { addrs: vec![IpAddr::V4(Ipv4Addr::LOCALHOST)], port, fp: [0; 32] };
            let r = dial(&offer, &kn, LINK, &*ifs(), LB, quick()).await;
            assert!(matches!(r, Err(NearError::OffLink(ref m)) if m.contains("port")), "{port}: {r:?}");
        }
        // the message layer refuses them too (so the other side never even sees the offer)
        for port in [0u16, 80, 1023] {
            let m = crate::relay::Message::LanOffer { addrs: vec!["192.168.1.5".into()], port, fp: crate::b64::enc(&[0u8; 32]) };
            assert!(m.validate().is_err(), "port {port}");
        }
        let ok = crate::relay::Message::LanOffer { addrs: vec!["192.168.1.5".into()], port: 1024, fp: crate::b64::enc(&[0u8; 32]) };
        assert!(ok.validate().is_ok());
    }
}
