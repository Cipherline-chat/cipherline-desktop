//! `cl-win-helper`: the Cipherline desktop app's Windows system helper.
//!
//! WHY IT EXISTS. The Electron main process used to answer "which games are running", "is this process suspended", "what is
//! playing", "is this installer signed by us" by starting hidden `powershell.exe` children (some with `-EncodedCommand`),
//! `tasklist`, and `reg.exe`. Behavioural security engines read exactly that pattern as malware. This helper answers the same
//! questions by calling Windows APIs directly, so the app starts no script host or system utility at run time.
//!
//! WHAT IT NEVER DOES. It never reads another process's command line or memory, never injects, never opens a socket, never
//! writes a file, and writes exactly one registry value family (the per-app GPU preference, see `win::sys::gpu_pref_set_high`).
//! Only its parent talks to it, over stdin/stdout.
//!
//! MODES (argv[1]):
//!   `serve`        long-lived; one JSON request per line (see `proto`), one reply per line.
//!   `media`        long-lived Now Playing reader: a line `a`/`r` in -> one JSON line out (the shape media-session.ts parses).
//!   `music-state`  one-shot: which sessions are playing (app id + type only, no titles).
//!   `verify <exe>` one-shot: WinVerifyTrust on a file; prints Get-AuthenticodeSignature-shaped JSON.
pub mod ntproc;
pub mod proto;
#[cfg(windows)]
pub mod win;

use proto::{err_reply, ok_reply, parse_request, Req, MAX_REQUEST_LINE};
use serde_json::Value;
use std::io::{BufRead, Read, Write};

/// The request loop, generic over the handler so it is tested without Windows. Ends on EOF.
pub fn serve<R: BufRead, W: Write>(mut input: R, mut out: W, mut handle: impl FnMut(Req) -> Result<Value, &'static str>) {
    let mut line = String::new();
    loop {
        line.clear();
        // Bounded read: a runaway line is dropped, never buffered whole.
        let mut raw = Vec::new();
        match (&mut input).take(MAX_REQUEST_LINE as u64 + 1).read_until(b'\n', &mut raw) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if raw.len() > MAX_REQUEST_LINE && raw.last() != Some(&b'\n') {
            // Discard the rest of the over-long line.
            let mut sink = Vec::new();
            let _ = input.read_until(b'\n', &mut sink);
            if writeln!(out, "{}", err_reply(0, "too_long")).and_then(|_| out.flush()).is_err() {
                return;
            }
            continue;
        }
        line.push_str(&String::from_utf8_lossy(&raw));
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let reply = match parse_request(t) {
            Ok((id, req)) => match handle(req) {
                Ok(body) => ok_reply(id, body),
                Err(why) => err_reply(id, why),
            },
            // A request that parsed far enough to carry an id is refused WITH that id: the app matches replies by id, so an id-0
            // refusal (a program name with a character we refuse, say) would leave its request waiting out the 5 s timeout, after
            // which it kills this helper and counts a dead start.
            Err(why) => err_reply(proto::peek_id(t).unwrap_or(0), why),
        };
        if writeln!(out, "{reply}").and_then(|_| out.flush()).is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn answers_each_line_in_order_and_survives_garbage() {
        let input = b"{\"id\":1,\"op\":\"processes\"}\nnope\n\n{\"id\":2,\"op\":\"minecraft\"}\n".as_slice();
        let mut out = Vec::new();
        serve(input, &mut out, |r| match r {
            Req::Processes => Ok(json!({"names":["a.exe"]})),
            Req::Minecraft => Err("nope"),
            _ => Err("x"),
        });
        let lines: Vec<&str> = std::str::from_utf8(&out).unwrap().lines().collect();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains("\"names\"") && lines[0].contains("\"id\":1"));
        assert!(lines[1].contains("bad_json"));
        assert!(lines[2].contains("\"ok\":false") && lines[2].contains("\"id\":2"));
    }

    #[test]
    fn a_refused_request_still_carries_its_id() {
        let input = b"{\"id\":5,\"op\":\"suspended\",\"name\":\"..\\\\evil\"}\n{\"id\":6,\"op\":\"rm_rf\"}\n{\"op\":\"processes\"}\n".as_slice();
        let mut out = Vec::new();
        serve(input, &mut out, |_| Ok(json!({})));
        let lines: Vec<&str> = std::str::from_utf8(&out).unwrap().lines().collect();
        assert!(lines[0].contains("\"id\":5") && lines[0].contains("bad_name"), "{}", lines[0]);
        assert!(lines[1].contains("\"id\":6") && lines[1].contains("unknown_op"), "{}", lines[1]);
        assert!(lines[2].contains("\"id\":0") && lines[2].contains("no_id"), "{}", lines[2]);
    }

    #[test]
    fn an_overlong_line_is_dropped_and_the_next_one_still_answers() {
        let mut input = vec![b'x'; MAX_REQUEST_LINE * 3];
        input.push(b'\n');
        input.extend_from_slice(b"{\"id\":9,\"op\":\"processes\"}\n");
        let mut out = Vec::new();
        serve(input.as_slice(), &mut out, |_| Ok(json!({})));
        let s = String::from_utf8(out).unwrap();
        assert!(s.contains("too_long"));
        assert!(s.contains("\"id\":9"));
    }
}
