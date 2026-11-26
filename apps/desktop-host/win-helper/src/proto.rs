//! The line protocol of `serve` mode: one JSON object per line in, one per line out, matched by `id`.
//! Only its parent (the Electron app) talks to it, over stdin/stdout. Pure, so it is tested on any host.
use serde_json::{json, Value};

pub const MAX_REQUEST_LINE: usize = 4096;

#[derive(Debug, PartialEq, Eq)]
pub enum Req {
    /// Names of all running programs.
    Processes,
    /// Is every thread of every process called `name` suspended?
    Suspended { name: String },
    /// Does a process called `name` own a visible top-level window?
    Window { name: String },
    /// Is a Minecraft Java window open (a java(w).exe whose window title starts with "Minecraft")?
    Minecraft,
    /// Full path of the first process called `name` whose path can be read.
    ExePath { name: String },
    /// Name of the process with this pid.
    PidName { pid: u32 },
    /// Is a value for this executable already in the per-app GPU preferences?
    GpuPrefHas { exe: String },
    /// Prefer the high-performance GPU for this executable (writes `GpuPreference=2;` under the fixed per-app key).
    GpuPrefSetHigh { exe: String },
}

/// A program name as it appears in a process list: no path separators or control characters.
pub fn valid_proc_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 100 && !n.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) && !n.chars().any(char::is_control)
}

/// An absolute drive-letter path to an .exe, no control characters, bounded.
pub fn valid_exe_path(p: &str) -> bool {
    let b = p.as_bytes();
    p.len() >= 5 && p.len() <= 520 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\'
        && p.to_ascii_lowercase().ends_with(".exe")
        && !p.chars().any(|c| c.is_control() || "<>\"|?*".contains(c))
}

/// Minecraft Java's window title: "Minecraft 1.21.4", "Minecraft* 1.20.1", "Minecraft Forge ..." - always starts with "Minecraft".
pub fn is_minecraft_title(t: &str) -> bool {
    t.starts_with("Minecraft")
}

/// The process behind a playing browser's media session, from its AppUserModelId (an empty answer = not a browser we read).
pub fn browser_proc_name(app: &str) -> Option<&'static str> {
    let a = app.to_lowercase();
    if a.contains("_crx_") {
        return None;
    }
    if a.contains("msedge") { return Some("msedge"); }
    if a.contains("chromium") { return Some("chromium"); }
    if a.contains("chrome") { return Some("chrome"); }
    if a.contains("firefox") || a == "308046b0af4a39cb" { return Some("firefox"); }
    if a.contains("brave") { return Some("brave"); }
    if a.contains("opera") { return Some("opera"); }
    if a.contains("vivaldi") { return Some("vivaldi"); }
    None
}

/// The `id` of a request line, when the line is JSON that has one (so a refusal can echo it).
pub fn peek_id(line: &str) -> Option<u64> {
    if line.len() > MAX_REQUEST_LINE {
        return None;
    }
    serde_json::from_str::<Value>(line).ok()?.get("id").and_then(Value::as_u64)
}

pub fn parse_request(line: &str) -> Result<(u64, Req), &'static str> {
    if line.len() > MAX_REQUEST_LINE {
        return Err("too_long");
    }
    let v: Value = serde_json::from_str(line).map_err(|_| "bad_json")?;
    let id = v.get("id").and_then(Value::as_u64).ok_or("no_id")?;
    let op = v.get("op").and_then(Value::as_str).ok_or("no_op")?;
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let name = || s("name").filter(|n| valid_proc_name(n)).ok_or("bad_name");
    let exe = || s("exe").filter(|p| valid_exe_path(p)).ok_or("bad_exe");
    let req = match op {
        "processes" => Req::Processes,
        "suspended" => Req::Suspended { name: name()? },
        "window" => Req::Window { name: name()? },
        "minecraft" => Req::Minecraft,
        "exe_path" => Req::ExePath { name: name()? },
        "pid_name" => Req::PidName { pid: v.get("pid").and_then(Value::as_u64).filter(|p| *p > 0 && *p <= u32::MAX as u64).ok_or("bad_pid")? as u32 },
        "gpu_pref_has" => Req::GpuPrefHas { exe: exe()? },
        "gpu_pref_set_high" => Req::GpuPrefSetHigh { exe: exe()? },
        _ => return Err("unknown_op"),
    };
    Ok((id, req))
}

pub fn ok_reply(id: u64, mut body: Value) -> String {
    if let Some(o) = body.as_object_mut() {
        o.insert("id".into(), json!(id));
        o.insert("ok".into(), json!(true));
    }
    body.to_string()
}

pub fn err_reply(id: u64, why: &str) -> String {
    json!({ "id": id, "ok": false, "err": why }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_each_op() {
        assert_eq!(parse_request(r#"{"id":1,"op":"processes"}"#), Ok((1, Req::Processes)));
        assert_eq!(parse_request(r#"{"id":2,"op":"suspended","name":"forza"}"#), Ok((2, Req::Suspended { name: "forza".into() })));
        assert_eq!(parse_request(r#"{"id":3,"op":"pid_name","pid":42}"#), Ok((3, Req::PidName { pid: 42 })));
        assert_eq!(parse_request(r#"{"id":4,"op":"minecraft"}"#), Ok((4, Req::Minecraft)));
    }

    #[test]
    fn refuses_odd_input() {
        assert!(parse_request("not json").is_err());
        assert!(parse_request(r#"{"op":"processes"}"#).is_err());
        assert!(parse_request(r#"{"id":1,"op":"rm_rf"}"#).is_err());
        assert!(parse_request(r#"{"id":1,"op":"suspended","name":"..\\evil"}"#).is_err());
        assert!(parse_request(r#"{"id":1,"op":"pid_name","pid":0}"#).is_err());
        assert!(parse_request(r#"{"id":1,"op":"pid_name","pid":99999999999}"#).is_err());
        assert!(parse_request(&format!(r#"{{"id":1,"op":"suspended","name":"{}"}}"#, "a".repeat(5000))).is_err());
    }

    #[test]
    fn gpu_paths_must_be_absolute_exes() {
        assert!(valid_exe_path(r"C:\Program Files\Cipherline\Cipherline.exe"));
        assert!(!valid_exe_path(r"Cipherline.exe"));
        assert!(!valid_exe_path(r"C:\x\a.dll"));
        assert!(!valid_exe_path("C:\\x\\a\n.exe"));
        assert!(!valid_exe_path(r"\\server\share\a.exe"));
    }

    #[test]
    fn minecraft_titles() {
        assert!(is_minecraft_title("Minecraft 1.21.4"));
        assert!(is_minecraft_title("Minecraft* 1.20.1"));
        assert!(!is_minecraft_title("Prism Launcher"));
        assert!(!is_minecraft_title("My Minecraft notes"));
    }

    #[test]
    fn browser_names() {
        assert_eq!(browser_proc_name("Chrome"), Some("chrome"));
        assert_eq!(browser_proc_name("MSEdge"), Some("msedge"));
        assert_eq!(browser_proc_name("chrome_crx_abc"), None);
        assert_eq!(browser_proc_name("Spotify.exe"), None);
        assert_eq!(browser_proc_name("308046B0AF4A39CB"), Some("firefox"));
    }

    #[test]
    fn replies_carry_the_id() {
        assert_eq!(ok_reply(7, json!({"a":1})), r#"{"a":1,"id":7,"ok":true}"#);
        assert!(err_reply(7, "x").contains("\"ok\":false"));
    }
}
