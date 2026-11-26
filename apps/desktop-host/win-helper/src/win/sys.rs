//! Process list, window state, process path and the per-app GPU preference, by direct API calls.
use crate::ntproc::{norm_name, parse_processes, suspend_state, SuspendState};
use crate::proto::is_minecraft_title;
use windows::core::PCWSTR;
use windows::Wdk::System::SystemInformation::{NtQuerySystemInformation, SystemProcessInformation};
use windows::Win32::Foundation::{CloseHandle, ERROR_SUCCESS, HWND, LPARAM};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE,
    KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ,
};
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, GW_OWNER,
};

const MAX_NAMES: usize = 8192;
/// The per-app GPU preference list Settings > System > Display > Graphics writes. Fixed: this helper writes nowhere else.
const GPU_PREF_KEY: &str = r"Software\Microsoft\DirectX\UserGpuPreferences";
const GPU_PREF_HIGH: &str = "GpuPreference=2;";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// (pid, image name) of every process, from a Toolhelp snapshot.
pub fn process_list() -> Vec<(u32, String)> {
    let mut out = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut ok = Process32FirstW(snap, &mut e).is_ok();
        while ok && out.len() < MAX_NAMES {
            let n = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
            out.push((e.th32ProcessID, String::from_utf16_lossy(&e.szExeFile[..n])));
            ok = Process32NextW(snap, &mut e).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    out
}

pub fn process_names() -> Vec<String> {
    process_list().into_iter().map(|(_, n)| n).collect()
}

pub fn pid_name(pid: u32) -> Option<String> {
    process_list().into_iter().find(|(p, _)| *p == pid).map(|(_, n)| n)
}

fn pids_named(name: &str) -> Vec<u32> {
    let want = norm_name(name);
    process_list().into_iter().filter(|(_, n)| norm_name(n) == want).map(|(p, _)| p).collect()
}

/// Thread states of every process, from the kernel's process table (no process memory is read).
pub fn suspended(name: &str) -> Result<SuspendState, &'static str> {
    let mut buf: Vec<u8> = vec![0; 1 << 20];
    for _ in 0..6 {
        let mut ret = 0u32;
        let st = unsafe { NtQuerySystemInformation(SystemProcessInformation, buf.as_mut_ptr().cast(), buf.len() as u32, &mut ret) };
        if st.0 >= 0 {
            let procs = parse_processes(&buf, buf.as_ptr() as u64);
            return Ok(suspend_state(&procs, name));
        }
        // STATUS_INFO_LENGTH_MISMATCH: grow (the table can grow between the two calls).
        if st.0 as u32 == 0xC000_0004 {
            buf = vec![0; (ret as usize + (1 << 16)).max(buf.len() * 2).min(64 << 20)];
            continue;
        }
        return Err("nt_query_failed");
    }
    Err("nt_query_failed")
}

struct Win {
    top_level: bool,
    title: String,
}

/// Every visible top-level window owned by one of `pids`: (owner is none, title).
fn windows_of(pids: &[u32]) -> Vec<Win> {
    struct State<'a> {
        pids: &'a [u32],
        out: Vec<Win>,
    }
    unsafe extern "system" fn cb(h: HWND, l: LPARAM) -> windows::core::BOOL {
        let st = &mut *(l.0 as *mut State);
        if st.out.len() >= 64 || !IsWindowVisible(h).as_bool() {
            return true.into();
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, Some(&mut pid));
        if !st.pids.contains(&pid) {
            return true.into();
        }
        let top_level = GetWindow(h, GW_OWNER).map(|o| o.0.is_null()).unwrap_or(true);
        let len = GetWindowTextLengthW(h);
        let mut title = String::new();
        if len > 0 && len <= 1000 {
            let mut b = vec![0u16; len as usize + 1];
            let n = GetWindowTextW(h, &mut b);
            if n > 0 {
                title = String::from_utf16_lossy(&b[..n as usize]);
            }
        }
        st.out.push(Win { top_level, title });
        true.into()
    }
    let mut st = State { pids, out: Vec::new() };
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut st as *mut State as isize));
    }
    st.out
}

/// (any process with this name exists, one of them owns a visible un-owned top-level window) - what .NET calls MainWindowHandle.
pub fn has_window(name: &str) -> (bool, bool) {
    let pids = pids_named(name);
    if pids.is_empty() {
        return (false, false);
    }
    (true, windows_of(&pids).iter().any(|w| w.top_level))
}

/// Visible window titles of the processes called `proc` (up to 24, non-empty).
pub fn window_titles(proc_name: &str) -> Vec<String> {
    let pids = pids_named(proc_name);
    if pids.is_empty() {
        return Vec::new();
    }
    windows_of(&pids).into_iter().filter(|w| !w.title.is_empty()).map(|w| w.title).take(24).collect()
}

/// A java(w).exe that owns a visible window titled "Minecraft...". The command line is never read.
pub fn minecraft_window() -> bool {
    let pids: Vec<u32> = process_list()
        .into_iter()
        .filter(|(_, n)| matches!(norm_name(n).as_str(), "java" | "javaw"))
        .map(|(p, _)| p)
        .collect();
    !pids.is_empty() && windows_of(&pids).iter().any(|w| is_minecraft_title(&w.title))
}

pub fn exe_path(name: &str) -> Option<String> {
    for pid in pids_named(name) {
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { continue };
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let r = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len);
            let _ = CloseHandle(h);
            if r.is_ok() && len > 0 {
                return Some(String::from_utf16_lossy(&buf[..len as usize]));
            }
        }
    }
    None
}

pub fn gpu_pref_has(exe: &str) -> bool {
    unsafe {
        let key = wide(GPU_PREF_KEY);
        let mut h = HKEY::default();
        if RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(key.as_ptr()), None, KEY_QUERY_VALUE, &mut h) != ERROR_SUCCESS {
            return false;
        }
        let name = wide(exe);
        let r = RegQueryValueExW(h, PCWSTR(name.as_ptr()), None, None, None, None);
        let _ = RegCloseKey(h);
        r == ERROR_SUCCESS
    }
}

pub fn gpu_pref_set_high(exe: &str) -> bool {
    unsafe {
        let key = wide(GPU_PREF_KEY);
        let mut h = HKEY::default();
        if RegCreateKeyExW(HKEY_CURRENT_USER, PCWSTR(key.as_ptr()), None, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, None, &mut h, None)
            != ERROR_SUCCESS
        {
            return false;
        }
        let name = wide(exe);
        let val = wide(GPU_PREF_HIGH);
        let bytes: Vec<u8> = val.iter().flat_map(|u| u.to_le_bytes()).collect();
        let r = RegSetValueExW(h, PCWSTR(name.as_ptr()), None, REG_SZ, Some(&bytes));
        let _ = RegCloseKey(h);
        r == ERROR_SUCCESS
    }
}
