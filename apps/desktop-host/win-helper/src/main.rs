//! `cl-win-helper` entry point. Started by the Cipherline app only; see lib.rs for the modes.


fn main() {
    let args: Vec<String> = std::env::args().collect();
    std::process::exit(run(&args));
}

#[cfg(not(windows))]
fn run(_args: &[String]) -> i32 {
    eprintln!("cl-win-helper: Windows only");
    69
}

#[cfg(windows)]
fn run(args: &[String]) -> i32 {
    use cl_win_helper::proto::Req;
    use std::io::IsTerminal;
    use cl_win_helper::win::{media, sig, sys};
    use serde_json::json;
    let mode = args.get(1).map(String::as_str).unwrap_or("");
    match mode {
        "serve" | "media" => {
            if std::io::stdin().is_terminal() {
                eprintln!("cl-win-helper: this program is only started by the Cipherline app");
                return 64;
            }
            let input = std::io::BufReader::new(std::io::stdin().lock());
            let out = std::io::stdout();
            if mode == "media" {
                media::run_media(input, out.lock());
                return 0;
            }
            cl_win_helper::serve(input, out.lock(), |req| match req {
                Req::Processes => Ok(json!({ "names": sys::process_names() })),
                Req::Suspended { name } => sys::suspended(&name).map(|s| {
                    json!({ "state": match s {
                        cl_win_helper::ntproc::SuspendState::Gone => "gone",
                        cl_win_helper::ntproc::SuspendState::Active => "active",
                        cl_win_helper::ntproc::SuspendState::Suspended => "suspended",
                    } })
                }),
                Req::Window { name } => {
                    let (found, window) = sys::has_window(&name);
                    Ok(json!({ "found": found, "window": window }))
                }
                Req::Minecraft => Ok(json!({ "running": sys::minecraft_window() })),
                Req::ExePath { name } => Ok(json!({ "path": sys::exe_path(&name) })),
                Req::PidName { pid } => Ok(json!({ "name": sys::pid_name(pid) })),
                Req::GpuPrefHas { exe } => Ok(json!({ "present": sys::gpu_pref_has(&exe) })),
                Req::GpuPrefSetHigh { exe } => {
                    if sys::gpu_pref_set_high(&exe) { Ok(json!({})) } else { Err("registry_write_failed") }
                }
            });
            0
        }
        "music-state" => {
            println!("{}", media::music_state());
            0
        }
        "verify" => match args.get(2) {
            Some(p) if !p.is_empty() && p.len() <= 1024 => {
                println!("{}", sig::verify(p));
                0
            }
            _ => 64,
        },
        _ => {
            eprintln!("cl-win-helper: unknown mode");
            64
        }
    }
}
