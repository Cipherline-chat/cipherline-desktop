//! `cl-near-helper` entry point. Spawned by Electron main as
//! `spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })`: stdin/stdout carry the line protocol (`proto.rs`), stderr
//! is fixed-word diagnostics, and fd 3 carries ONE line, the 64-hex handshake nonce, written by the parent before anything
//! else. The nonce is the proof "I am the process that created these pipes": it must come in on fd 3 (never argv, never the
//! environment, where other local processes can read it) and be repeated in the first stdin line.
//!
//! Refuses to run (and says why on stderr, exit code in `lib.rs`) when: stdin is a terminal (someone typing at it, not a
//! parent); fd 3 is not a pipe/socket or carries no well-formed nonce within 5 s; the first stdin line does not repeat it.
//! WINDOWS has no fd 3 for a Node child: the parent writes the nonce as the FIRST stdin line instead, then `hello` repeats it
//! (`lib.rs::read_nonce_line`).
use cl_near_helper::{serve, EXIT_BAD_HANDSHAKE, EXIT_NOT_A_PIPE, EXIT_UNSUPPORTED};
use std::io::IsTerminal;

fn main() {
    if std::io::stdin().is_terminal() {
        eprintln!("cl-near-helper: stdin is a terminal; this program is only started by the Cipherline app");
        std::process::exit(EXIT_NOT_A_PIPE);
    }
    let stdin = std::io::stdin();
    let mut input = std::io::BufReader::new(stdin.lock());
    let nonce = match handshake_nonce(&mut input) {
        Ok(n) => n,
        Err(e) => {
            eprintln!("cl-near-helper: {e}");
            std::process::exit(if e == "unsupported platform" { EXIT_UNSUPPORTED } else { EXIT_BAD_HANDSHAKE });
        }
    };
    std::process::exit(serve(input, std::io::stdout(), &nonce, platform_for_this_build()));
}

/// Unix: fd 3 (never argv or the environment). Windows: the first stdin line (see `read_nonce_line`).
#[cfg(unix)]
fn handshake_nonce<R: std::io::BufRead>(_input: &mut R) -> Result<String, &'static str> {
    read_nonce_fd3()
}
#[cfg(windows)]
fn handshake_nonce<R: std::io::BufRead>(input: &mut R) -> Result<String, &'static str> {
    cl_near_helper::read_nonce_line(input)
}
#[cfg(not(any(unix, windows)))]
fn handshake_nonce<R: std::io::BufRead>(_input: &mut R) -> Result<String, &'static str> {
    Err("unsupported platform")
}

#[cfg(unix)]
fn read_nonce_fd3() -> Result<String, &'static str> {
    use std::io::{BufRead, Read};
    use std::os::fd::FromRawFd;
    use std::os::unix::fs::FileTypeExt;
    // An absent fd must be detected BEFORE wrapping it: dropping an OwnedFd whose close() fails with EBADF aborts the process.
    // SAFETY: fcntl(F_GETFD) only queries descriptor flags.
    if unsafe { libc::fcntl(3, libc::F_GETFD) } == -1 {
        return Err("no handshake descriptor (fd 3)");
    }
    // SAFETY: fd 3 is open (checked above); it is the handshake pipe the parent created, or something else whose type is
    // checked next; the File owns and closes it.
    let f = unsafe { std::fs::File::from_raw_fd(3) };
    let ft = f.metadata().map_err(|_| "no handshake descriptor (fd 3)")?.file_type();
    if !(ft.is_fifo() || ft.is_socket()) {
        return Err("fd 3 is not a pipe");
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let r = std::io::BufReader::new(f.take(80)).read_line(&mut line);
        let _ = tx.send(r.map(|_| line));
    });
    let line = rx.recv_timeout(std::time::Duration::from_secs(5)).map_err(|_| "no handshake nonce within 5 s")?.map_err(|_| "unreadable handshake")?;
    let nonce = line.trim_end_matches('\n');
    if nonce.len() != 64 || !nonce.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err("malformed handshake nonce");
    }
    Ok(nonce.to_owned())
}

#[cfg(not(feature = "testkit"))]
fn platform_for_this_build() -> cl_near_helper::Platform {
    cl_near_helper::platform::detect()
}

/// testkit builds only: `cl-near-helper [ready|off|none]` picks what the fake adapter reports.
#[cfg(feature = "testkit")]
fn platform_for_this_build() -> cl_near_helper::Platform {
    cl_near_helper::testkit::platform(std::env::args().nth(1).as_deref().unwrap_or("ready"))
}
