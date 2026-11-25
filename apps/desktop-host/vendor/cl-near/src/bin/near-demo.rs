//! near-demo: a complete proximity session between two OS processes on one machine.
//!
//! TEST / DEMO ONLY. This binary exists only with `--features dangerous-loopback` (`required-features`),
//! which lets the LAN layer accept 127.0.0.1 so two processes on one box can pair. Never enable that
//! feature in a shipped build (the crate refuses it for android and ios at compile time).
//!
//!   cargo run --release -p cl-near --features dangerous-loopback --bin near-demo -- all [--mib 1024] [--drop-pct 40]
//!
//! `all` starts a loopback relay in this process and spawns two children (`n`: the new device, `a`: the
//! approver) that talk to it over TCP: hello / hello_ack, caps, LAN offer, TLS 1.3 + role MACs, the approval
//! string, then a transfer of `--mib` MiB with one injected connection drop and a resume on a NEW
//! authenticated connection.
use std::net::SocketAddr;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cl_near::approval::link_approve_message_v2;
use cl_near::code::{build_near, new_link_id, parse_near, ProximitySecret};
use cl_near::conn::{Conn, ConnConfig};
use cl_near::error::NearError;
use cl_near::keys::generate_keypair;
use cl_near::lan::{dial, LanConn, LanListener, LanPolicy, LanTimeouts};
use cl_near::onlink::StaticInterfaces;
use cl_near::relay::{RelayBatch, Caps, MemoryRelay, Message, RelayItem, RelayPeer, RelayTransport, Side};
use cl_near::testutil::{peak_rss_kb, FaultyStream, MemSink, SharedStore, SyntheticSource};
use cl_near::transfer::{run_receiver, run_sender, Progress, TransferOpts};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

// ---- a tiny line-based relay over TCP (stands in for the HTTP relay) ----------------------------

fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }
fn unhex(s: &str) -> Vec<u8> { (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect() }
fn side(s: &str) -> Side { if s == "a" { Side::A } else { Side::N } }

async fn serve_relay(l: TcpListener, state: MemoryRelay) {
    loop {
        let Ok((sock, _)) = l.accept().await else { continue };
        let st = state.clone();
        tokio::spawn(async move {
            let (rd, mut wr) = sock.into_split();
            let mut line = String::new();
            if BufReader::new(rd.take(8192)).read_line(&mut line).await.is_err() { return }
            let p: Vec<&str> = line.split_whitespace().collect();
            let out = match p.as_slice() {
                ["POST", s, seq, body] => match st.post(side(s), seq.parse().unwrap_or(0), unhex(body)).await { Ok(()) => "OK\n".to_string(), Err(e) => format!("ERR {e}\n") },
                ["FETCH", s, after] => {
                    let items = st.fetch(side(s), after.parse().unwrap_or(0)).await.map(|b| b.messages).unwrap_or_default();
                    let mut o: String = format!("EXPIRES 120\n");
                    o.extend(items.iter().map(|i: &RelayItem| format!("ITEM {} {}\n", i.seq, hex(&i.body))));
                    o.push_str("END\n");
                    o
                }
                _ => "ERR bad request\n".into(),
            };
            let _ = wr.write_all(out.as_bytes()).await;
        });
    }
}

#[derive(Clone)]
struct TcpRelay(SocketAddr);

impl TcpRelay {
    async fn call(&self, req: String) -> Result<Vec<String>, NearError> {
        let mut s = TcpStream::connect(self.0).await?;
        s.write_all(req.as_bytes()).await?;
        let mut lines = vec![];
        let mut rd = BufReader::new(s).lines();
        while let Some(l) = rd.next_line().await? { lines.push(l) }
        Ok(lines)
    }
}

impl RelayTransport for TcpRelay {
    async fn post(&self, from: Side, seq: u64, body: Vec<u8>) -> Result<(), NearError> {
        let r = self.call(format!("POST {} {seq} {}\n", from.relay_char(), hex(&body))).await?;
        if r.first().map(String::as_str) == Some("OK") { Ok(()) } else { Err(NearError::Transport(r.join(" "))) }
    }
    async fn fetch(&self, as_side: Side, after: u64) -> Result<RelayBatch, NearError> {
        let r = self.call(format!("FETCH {} {after}\n", as_side.relay_char())).await?;
        let expires_in_s = r.iter().find_map(|l| l.strip_prefix("EXPIRES ")?.parse().ok()).unwrap_or(0);
        Ok(RelayBatch { expires_in_s, messages: r.iter().filter_map(|l| { let p: Vec<&str> = l.split(' ').collect(); (p.len() == 3 && p[0] == "ITEM").then(|| RelayItem { seq: p[1].parse().unwrap(), body: unhex(p[2]) }) }).collect() })
    }
}

// ---- the session -----------------------------------------------------------------------------

struct Args { mode: String, relay: Option<SocketAddr>, code: Option<String>, mib: u64, drop_pct: u64, listener: Side, sender: Side }

fn parse_args() -> Args {
    let v: Vec<String> = std::env::args().skip(1).collect();
    let mut a = Args { mode: v.first().cloned().unwrap_or_else(|| "all".into()), relay: None, code: None, mib: 1024, drop_pct: 40, listener: Side::A, sender: Side::A };
    let mut i = 1;
    while i + 1 < v.len() + 1 && i < v.len() {
        let val = v.get(i + 1).cloned().unwrap_or_default();
        match v[i].as_str() {
            "--relay" => a.relay = val.parse().ok(),
            "--code" => a.code = Some(val),
            "--mib" => a.mib = val.parse().unwrap_or(1024),
            "--drop-pct" => a.drop_pct = val.parse().unwrap_or(40),
            "--listener" => a.listener = side(&val),
            "--sender" => a.sender = side(&val),
            _ => {}
        }
        i += 2;
    }
    a
}

const RECORD_MIB: u64 = 16;
const SEED: u64 = 0xC1_0B_E4;

fn caps_for(me: Side, listener: Side) -> Caps {
    // both sides behave like desktops here (scan only, no advertising): Bluetooth is not part of this demo
    if me == listener { Caps { ble_scan: true, lan_listen: true, ..Default::default() } } else { Caps { ble_scan: true, lan_dial: true, ..Default::default() } }
}

/// The demo's stand-in for the new device's identity key (the real flow takes it from the server's scan answer).
const DEMO_IK: [u8; 32] = [0x5a; 32];

async fn session(me: Side, mut peer: RelayPeer<TcpRelay>, args: &Args) -> Result<(), String> {
    let e = |x: NearError| x.to_string();
    let t = Duration::from_secs(20);
    let ifaces: Arc<StaticInterfaces> = Arc::new(StaticInterfaces(vec![]));
    let policy = LanPolicy::DangerousAllowLoopback;
    let link_id = peer.session().link_id().to_owned();
    let keys = peer.session().keys().clone();

    // caps both ways, then the plan
    peer.send(&Message::caps(&caps_for(me, args.listener))).await.map_err(e)?;
    let theirs = peer.recv(t).await.map_err(e)?.caps_checked().map_err(e)?;
    let mine = caps_for(me, args.listener);
    let (ca, cn) = if me == Side::A { (mine, theirs) } else { (theirs, mine) };
    let plan = cl_near::ble::plan(&ca, &cn, false);
    println!("[{me:?}] plan: ble={:?} lan={:?}", plan.ble, plan.lan);
    let listener_side = plan.lan.ok_or("no LAN path")?.listener;

    // 4.2: listener offers, dialer dials
    let mut listener = None;
    let mut dial_offer = None;
    let proof_conn: LanConn = if me == listener_side {
        let l = LanListener::bind(&keys, &link_id, ifaces.clone(), policy, LanTimeouts::default()).await.map_err(e)?;
        peer.send(&Message::lan_offer(&l.offer())).await.map_err(e)?;
        let c = l.accept(t).await.map_err(e)?;
        listener = Some(l);
        c
    } else {
        let offer = peer.recv(t).await.map_err(e)?.lan_offer_typed().map_err(e)?;
        let c = dial(&offer, &keys, &link_id, &*ifaces, policy, LanTimeouts::default()).await.map_err(e)?;
        peer.send(&Message::lan_result(true, None)).await.map_err(e)?;
        dial_offer = Some(offer);
        c
    };
    println!("[{me:?}] LAN proof ok: peer {} binding {}", proof_conn.peer, hex(&proof_conn.binding_id));
    if me == Side::A {
        let m = link_approve_message_v2("user-demo", "device-A", &link_id, "bmV3LWRldmljZS1pZGVudGl0eS1rZXk=", &proof_conn.proof(), 1_763_500_000).map_err(e)?;
        println!("[A] approval string to sign: {m}");
    }

    // transfer: sender and receiver may be either side; the connection that proved proximity is reused
    let total_bytes = args.mib * 1024 * 1024;
    let started = Instant::now();
    let mut first = Some(proof_conn);
    let mut attempts = 0;
    let mut last_progress = Instant::now();
    if me == args.sender {
        let mut src = SyntheticSource::new((args.mib / RECORD_MIB).max(1) as u32, RECORD_MIB * 1024 * 1024, SEED);
        println!("[{me:?}] manifest ready: {} records, {} MiB (hashed in {:.1}s)", cl_near::transfer::RecordSource::manifest(&src).record_count, args.mib, started.elapsed().as_secs_f64());
        let opts = TransferOpts::default();
        loop {
            attempts += 1;
            let lc = match first.take() { Some(c) => c, None => if let Some(l) = &listener { l.accept(t).await.map_err(e)? } else { redial(dial_offer.as_ref().ok_or("no offer")?, &keys, &link_id, &ifaces, policy).await? } };
            let pf = lc.proof();
            match run_sender(Conn::new(lc.stream, ConnConfig::default()), &pf, &mut src, &opts).await {
                Ok(s) => { println!("RESULT role={me:?} sender attempts={attempts} last_leg_records={} last_leg_MiB={} secs={:.2} peak_rss_kb={}", s.records_sent, s.bytes_sent >> 20, started.elapsed().as_secs_f64(), peak_rss_kb()); break }
                Err(err) => { println!("[{me:?}] sender attempt {attempts} ended: {err}"); if attempts >= 5 { return Err("too many attempts".into()) } tokio::time::sleep(Duration::from_millis(300)).await }
            }
        }
    } else {
        let mut sink = MemSink::new(false);
        let mut store = SharedStore::default();
        let (ref_me, total) = (me, total_bytes);
        let opts = TransferOpts { progress: Some(Arc::new(move |p: Progress| {
            if p.bytes_done % (128 << 20) < (1 << 20) { eprintln!("[{ref_me:?}] progress {} / {} MiB", p.bytes_done >> 20, total >> 20) }
        })), ..Default::default() };
        let _ = &mut last_progress;
        loop {
            attempts += 1;
            let lc = match first.take() { Some(c) => c, None => if let Some(l) = &listener { l.accept(t).await.map_err(e)? } else { redial(dial_offer.as_ref().ok_or("no offer")?, &keys, &link_id, &ifaces, policy).await? } };
            let pf = lc.proof();
            let r = if attempts == 1 && args.drop_pct > 0 {
                let limit = total_bytes * args.drop_pct / 100;
                println!("[{me:?}] injecting a hard connection drop after {} MiB", limit >> 20);
                run_receiver(Conn::new(FaultyStream::new(lc.stream, limit), ConnConfig::default()), &pf, &mut sink, &mut store, &opts).await
            } else {
                run_receiver(Conn::new(lc.stream, ConnConfig::default()), &pf, &mut sink, &mut store, &opts).await
            };
            match r {
                Ok(s) => {
                    println!("RESULT role={me:?} receiver attempts={attempts} last_leg_records={} last_leg_MiB={} total_committed_MiB={} complete={} secs={:.2} peak_rss_kb={}", s.records_received, s.bytes_received >> 20, sink.committed_bytes >> 20, s.complete, started.elapsed().as_secs_f64(), peak_rss_kb());
                    break;
                }
                Err(err) => { println!("[{me:?}] receiver attempt {attempts} ended: {err} (committed {} MiB so far)", sink.committed_bytes >> 20); if attempts >= 5 { return Err("too many attempts".into()) } tokio::time::sleep(Duration::from_millis(300)).await }
            }
        }
    }
    Ok(())
}

async fn redial(offer: &cl_near::relay::LanOffer, keys: &cl_near::keys::SessionKeys, link_id: &str, ifaces: &Arc<StaticInterfaces>, policy: LanPolicy) -> Result<LanConn, String> {
    dial(offer, keys, link_id, &**ifaces, policy, LanTimeouts::default()).await.map_err(|e| e.to_string())
}

#[tokio::main]
async fn main() {
    eprintln!("near-demo: TEST/DEMO ONLY (dangerous-loopback: loopback addresses are treated as on-link)");
    let args = parse_args();
    match args.mode.as_str() {
        "all" => run_all(args).await,
        "n" => {
            let relay = TcpRelay(args.relay.expect("--relay"));
            let (en_priv, en_pub) = generate_keypair();
            let secret = ProximitySecret::generate();
            let link_id = new_link_id();
            println!("CODE {}", build_near(&link_id, &en_pub, &secret));
            use std::io::Write;
            std::io::stdout().flush().ok();
            let sc = secret.clone();
            let peer = RelayPeer::new_device_accept(relay, &link_id, &en_priv, &DEMO_IK, move || vec![sc.clone()], Duration::from_secs(30)).await.expect("hello");
            println!("[N] hello verified (the approver scanned the real code)");
            if let Err(e) = session(Side::N, peer, &args).await { println!("FAIL N: {e}"); std::process::exit(1) }
        }
        "a" => {
            let relay = TcpRelay(args.relay.expect("--relay"));
            let code = parse_near(args.code.as_deref().expect("--code")).expect("valid near code");
            let peer = RelayPeer::approver_connect(relay, &code.link_id, &code.en_pub, &code.secret, &DEMO_IK, Duration::from_secs(30)).await.expect("hello_ack");
            println!("[A] hello_ack verified (N holds the shown code)");
            if let Err(e) = session(Side::A, peer, &args).await { println!("FAIL A: {e}"); std::process::exit(1) }
        }
        _ => eprintln!("usage: near-demo all [--mib 1024] [--drop-pct 40] [--listener a|n] [--sender a|n]"),
    }
}

async fn run_all(args: Args) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(serve_relay(l, MemoryRelay::new()));
    let exe = std::env::current_exe().unwrap();
    let common = |c: &mut Command| { c.args(["--relay", &addr.to_string(), "--mib", &args.mib.to_string(), "--drop-pct", &args.drop_pct.to_string(), "--listener", &format!("{:?}", args.listener).to_lowercase(), "--sender", &format!("{:?}", args.sender).to_lowercase()]); };
    let mut n = Command::new(&exe);
    n.arg("n"); common(&mut n);
    let mut n = n.stdout(Stdio::piped()).spawn().unwrap();
    let mut n_out = std::io::BufReader::new(n.stdout.take().unwrap());
    let mut line = String::new();
    std::io::BufRead::read_line(&mut n_out, &mut line).unwrap();
    let code = line.trim().strip_prefix("CODE ").expect("N prints its code first").to_owned();
    println!("[parent] N shows: {code}");
    let mut a = Command::new(&exe);
    a.arg("a").args(["--code", &code]); common(&mut a);
    let mut a = a.stdout(Stdio::piped()).spawn().unwrap();
    let a_out = std::io::BufReader::new(a.stdout.take().unwrap());
    let t0 = Instant::now();
    let h = std::thread::spawn(move || { for l in std::io::BufRead::lines(a_out).map_while(Result::ok) { println!("A| {l}") } });
    for l in std::io::BufRead::lines(n_out).map_while(Result::ok) { println!("N| {l}") }
    let _ = h.join();
    let (sa, sn) = (a.wait().unwrap(), n.wait().unwrap());
    println!("[parent] exit codes: A={sa} N={sn}; wall {:.1}s", t0.elapsed().as_secs_f64());
    if !sa.success() || !sn.success() { std::process::exit(1) }
}
