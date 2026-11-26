//! Now Playing from Windows' System Media Transport Controls (WinRT GlobalSystemMediaTransportControlsSessionManager).
//! Replaces the hidden PowerShell 5.1 reader. The JSON line it writes has the shape electron/media-session.ts's
//! pickWindowsSession reads: `{ok, cur, sessions:[{app,status,ptype,title,artist,albumArtist,album,dur,pos,upd,wins,art,artErr,err}]}`.
use crate::proto::browser_proc_name;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::time::{Duration, Instant};
use windows::core::RuntimeType;
use windows_future::{AsyncStatus, IAsyncOperation};
use windows::Media::Control::{GlobalSystemMediaTransportControlsSessionManager as Manager};
use windows::Storage::Streams::DataReader;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

const PLAYING: i32 = 4;
const WAIT: Duration = Duration::from_millis(3000);
const COVER_MAX: u64 = 4 * 1024 * 1024;
/// 100 ns ticks from 1601-01-01 to 1970-01-01, in milliseconds.
const EPOCH_DIFF_MS: i64 = 11_644_473_600_000;

fn init() {
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
}

/// Waits for a WinRT async operation with a ceiling; None on timeout or failure (the operation is cancelled).
fn wait<T: RuntimeType + 'static>(op: &IAsyncOperation<T>) -> Option<T> {
    let t0 = Instant::now();
    loop {
        match op.Status().ok()? {
            AsyncStatus::Started => {
                if t0.elapsed() > WAIT {
                    let _ = op.Cancel();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            AsyncStatus::Completed => return op.GetResults().ok(),
            _ => return None,
        }
    }
}

fn manager() -> Option<Manager> {
    wait(&Manager::RequestAsync().ok()?)
}

fn s(r: windows::core::Result<windows::core::HSTRING>) -> String {
    r.map(|h| h.to_string()).unwrap_or_default()
}

/// Only the app id, status and playback type of PLAYING sessions: no titles, covers, positions or windows.
pub fn music_state() -> Value {
    init();
    let mut list = Vec::new();
    if let Some(m) = manager() {
        if let Ok(sessions) = m.GetSessions() {
            for sess in sessions {
                if list.len() >= 16 {
                    break;
                }
                let Ok(pi) = sess.GetPlaybackInfo() else { continue };
                if pi.PlaybackStatus().map(|x| x.0).unwrap_or(0) != PLAYING {
                    continue;
                }
                let mut e = Map::new();
                e.insert("app".into(), json!(s(sess.SourceAppUserModelId())));
                e.insert("status".into(), json!(PLAYING));
                if let Some(t) = pi.PlaybackType().ok().and_then(|r| r.Value().ok()) {
                    e.insert("ptype".into(), json!(t.0));
                }
                list.push(Value::Object(e));
            }
        }
    }
    json!({ "sessions": list })
}

struct Reader {
    mgr: Option<Manager>,
    sent: HashMap<String, String>,
    tries: HashMap<String, u32>,
}

impl Reader {
    fn read_cover(&mut self, e: &mut Map<String, Value>, app: &str, key: &str, props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties) {
        let already = self.sent.get(app).map(String::as_str) == Some(key);
        let thumb = props.Thumbnail().ok();
        if thumb.is_none() {
            if !already {
                e.insert("artErr".into(), json!("none"));
            }
            return;
        }
        if already {
            return;
        }
        let n = *self.tries.get(key).unwrap_or(&0);
        if n >= 6 {
            self.sent.insert(app.into(), key.into());
            return;
        }
        self.tries.insert(key.into(), n + 1);
        let res: Result<(), &'static str> = (|| {
            let thumb = thumb.ok_or("read_failed")?;
            let stream = wait(&thumb.OpenReadAsync().map_err(|_| "read_failed")?).ok_or("open_timeout")?;
            let size = stream.Size().map_err(|_| "read_failed")?;
            if size > COVER_MAX {
                self.sent.insert(app.into(), key.into());
                return Err("too_big");
            }
            if size == 0 {
                return Err("empty");
            }
            let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).map_err(|_| "read_failed")?).map_err(|_| "read_failed")?;
            let loaded = wait(&reader.LoadAsync(size as u32).map_err(|_| "read_failed")?).ok_or("read_failed")?;
            if loaded == 0 {
                return Err("empty");
            }
            let mut bytes = vec![0u8; loaded as usize];
            reader.ReadBytes(&mut bytes).map_err(|_| "read_failed")?;
            e.insert("art".into(), json!(base64::engine::general_purpose::STANDARD.encode(&bytes)));
            self.sent.insert(app.into(), key.into());
            Ok(())
        })();
        if let Err(code) = res {
            e.insert("artErr".into(), json!(code));
        }
    }

    fn answer(&mut self, all: bool) -> Value {
        if all || self.tries.len() > 64 {
            self.sent.clear();
            self.tries.clear();
        }
        if self.mgr.is_none() {
            self.mgr = manager();
        }
        let Some(mgr) = self.mgr.clone() else { return json!({ "ok": false }) };
        let Ok(sessions) = mgr.GetSessions() else {
            self.mgr = None;
            return json!({ "ok": false });
        };
        let cur = mgr.GetCurrentSession().ok().map(|c| s(c.SourceAppUserModelId())).unwrap_or_default();
        let mut list = Vec::new();
        let mut wins_cache: HashMap<&'static str, Vec<String>> = HashMap::new();
        for sess in sessions {
            if list.len() >= 16 {
                break;
            }
            let mut e = Map::new();
            let app = s(sess.SourceAppUserModelId());
            e.insert("app".into(), json!(app));
            let Ok(pi) = sess.GetPlaybackInfo() else {
                e.insert("err".into(), json!(1));
                list.push(Value::Object(e));
                continue;
            };
            let status = pi.PlaybackStatus().map(|x| x.0).unwrap_or(0);
            e.insert("status".into(), json!(status));
            if let Some(t) = pi.PlaybackType().ok().and_then(|r| r.Value().ok()) {
                e.insert("ptype".into(), json!(t.0));
            }
            if status == PLAYING {
                let props = sess.TryGetMediaPropertiesAsync().ok().and_then(|op| wait(&op));
                let (mut title, mut artist) = (String::new(), String::new());
                if let Some(p) = &props {
                    title = s(p.Title());
                    artist = s(p.Artist());
                    e.insert("title".into(), json!(title));
                    e.insert("artist".into(), json!(artist));
                    e.insert("albumArtist".into(), json!(s(p.AlbumArtist())));
                    e.insert("album".into(), json!(s(p.AlbumTitle())));
                }
                if let Ok(tl) = sess.GetTimelineProperties() {
                    let ticks = |r: windows::core::Result<windows::Foundation::TimeSpan>| r.map(|t| t.Duration).unwrap_or(0);
                    let (start, end, pos) = (ticks(tl.StartTime()), ticks(tl.EndTime()), ticks(tl.Position()));
                    e.insert("dur".into(), json!((end - start) / 10_000));
                    e.insert("pos".into(), json!((pos - start) / 10_000));
                    if let Ok(u) = tl.LastUpdatedTime() {
                        e.insert("upd".into(), json!(u.UniversalTime / 10_000 - EPOCH_DIFF_MS));
                    }
                }
                // A playing browser: the titles of that browser's own windows (the page title ends with the site).
                if let Some(bp) = browser_proc_name(&app) {
                    let w = wins_cache.entry(bp).or_insert_with(|| super::sys::window_titles(bp)).clone();
                    e.insert("wins".into(), json!(w));
                }
                if let Some(p) = &props {
                    let key = format!("{app}|{title}|{artist}");
                    self.read_cover(&mut e, &app, &key, p);
                }
            }
            list.push(Value::Object(e));
        }
        json!({ "ok": true, "cur": cur, "sessions": list })
    }
}

/// `media` mode: a line `a` (send every cover again) or anything else (covers only for tracks that changed) -> one JSON line.
/// `q` or EOF ends it.
pub fn run_media<R: BufRead, W: Write>(input: R, mut out: W) {
    init();
    let mut r = Reader { mgr: None, sent: HashMap::new(), tries: HashMap::new() };
    for line in input.lines() {
        let Ok(line) = line else { break };
        let req = line.trim();
        if req == "q" {
            break;
        }
        let v = r.answer(req == "a");
        if writeln!(out, "{v}").and_then(|_| out.flush()).is_err() {
            break;
        }
    }
}
