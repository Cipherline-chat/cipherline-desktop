//! Parser for the buffer `NtQuerySystemInformation(SystemProcessInformation)` fills (x64 layout). This is the same kernel
//! query .NET's `Process.Threads` / Task Manager's "Suspended" column read; it returns only counters and thread states, never
//! another process's memory or command line. The parser is pure so it is unit-tested on any host.
//!
//! SYSTEM_PROCESS_INFORMATION (x64): NextEntryOffset u32 @0, NumberOfThreads u32 @4, ImageName UNICODE_STRING @56
//! (Length u16 @56, Buffer ptr @64), UniqueProcessId @80, threads array @256.
//! SYSTEM_THREAD_INFORMATION (x64, 80 bytes): ThreadState u32 @68, WaitReason u32 @72.

pub const PROC_HEADER: usize = 256;
pub const THREAD_SIZE: usize = 80;
/// KTHREAD_STATE::Waiting
pub const STATE_WAIT: u32 = 5;
/// KWAIT_REASON::Suspended
pub const WAIT_SUSPENDED: u32 = 5;

#[derive(Debug, PartialEq, Eq, Clone)]
pub struct NtProc {
    pub pid: u64,
    /// Image name as the kernel has it ("Cipherline.exe"); empty for the idle process.
    pub name: String,
    /// (ThreadState, WaitReason) per thread.
    pub threads: Vec<(u32, u32)>,
}

fn u32_at(b: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(o..o + 4)?.try_into().ok()?))
}
fn u64_at(b: &[u8], o: usize) -> Option<u64> {
    Some(u64::from_le_bytes(b.get(o..o + 8)?.try_into().ok()?))
}

/// Walks the entries. The ImageName buffer points back INTO `buf` (the kernel packs the names after the thread arrays);
/// `base` is the address `buf` starts at in the process that wrote it, so a pointer can be turned into an offset.
/// Anything out of range ends the walk instead of panicking: a malformed buffer yields what was readable so far.
pub fn parse_processes(buf: &[u8], base: u64) -> Vec<NtProc> {
    let mut out = Vec::new();
    let mut off = 0usize;
    loop {
        let (Some(next), Some(nthreads), Some(len), Some(ptr), Some(pid)) =
            (u32_at(buf, off), u32_at(buf, off + 4), buf.get(off + 56..off + 58), u64_at(buf, off + 64), u64_at(buf, off + 80))
        else {
            break;
        };
        let len = u16::from_le_bytes([len[0], len[1]]) as usize;
        let mut name = String::new();
        if len > 0 && len % 2 == 0 && ptr >= base {
            let start = (ptr - base) as usize;
            if let Some(raw) = start.checked_add(len).and_then(|end| buf.get(start..end)) {
                let units: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
                name = String::from_utf16_lossy(&units);
            }
        }
        let mut threads = Vec::new();
        for i in 0..(nthreads as usize).min(65_536) {
            let t = off + PROC_HEADER + i * THREAD_SIZE;
            match (u32_at(buf, t + 68), u32_at(buf, t + 72)) {
                (Some(s), Some(w)) => threads.push((s, w)),
                _ => break,
            }
        }
        out.push(NtProc { pid, name, threads });
        if next == 0 {
            break;
        }
        off = match off.checked_add(next as usize) {
            Some(o) => o,
            None => break,
        };
    }
    out
}

/// "x" and "X.EXE" are the same program name.
pub fn norm_name(n: &str) -> String {
    let l = n.trim().to_lowercase();
    l.strip_suffix(".exe").map(str::to_string).unwrap_or(l)
}

#[derive(Debug, PartialEq, Eq)]
pub enum SuspendState {
    Gone,
    Active,
    Suspended,
}

/// Every thread of every process with this name is Wait/Suspended => Suspended (the UWP "frozen ghost").
/// No such process => Gone. Any process with no threads listed is treated as active (never hide a running game).
pub fn suspend_state(procs: &[NtProc], name: &str) -> SuspendState {
    let want = norm_name(name);
    let mut any = false;
    for p in procs.iter().filter(|p| norm_name(&p.name) == want) {
        any = true;
        if p.threads.is_empty() || p.threads.iter().any(|&(s, w)| !(s == STATE_WAIT && w == WAIT_SUSPENDED)) {
            return SuspendState::Active;
        }
    }
    if any { SuspendState::Suspended } else { SuspendState::Gone }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a buffer shaped like the kernel's: entries back to back, then the names packed at the end.
    fn build(entries: &[(&str, u64, &[(u32, u32)])], base: u64) -> Vec<u8> {
        let mut buf: Vec<u8> = Vec::new();
        let mut name_at: Vec<usize> = Vec::new();
        let sizes: Vec<usize> = entries.iter().map(|e| PROC_HEADER + e.2.len() * THREAD_SIZE).collect();
        let mut names_start = sizes.iter().sum::<usize>();
        for e in entries {
            name_at.push(names_start);
            names_start += e.0.encode_utf16().count() * 2;
        }
        let mut off = 0;
        for (i, e) in entries.iter().enumerate() {
            let mut rec = vec![0u8; sizes[i]];
            let next = if i + 1 == entries.len() { 0 } else { sizes[i] as u32 };
            rec[0..4].copy_from_slice(&next.to_le_bytes());
            rec[4..8].copy_from_slice(&(e.2.len() as u32).to_le_bytes());
            let len = (e.0.encode_utf16().count() * 2) as u16;
            rec[56..58].copy_from_slice(&len.to_le_bytes());
            rec[64..72].copy_from_slice(&(base + name_at[i] as u64).to_le_bytes());
            rec[80..88].copy_from_slice(&e.1.to_le_bytes());
            for (t, (s, w)) in e.2.iter().enumerate() {
                let o = PROC_HEADER + t * THREAD_SIZE;
                rec[o + 68..o + 72].copy_from_slice(&s.to_le_bytes());
                rec[o + 72..o + 76].copy_from_slice(&w.to_le_bytes());
            }
            buf.extend_from_slice(&rec);
            off += sizes[i];
        }
        assert_eq!(off, buf.len());
        for e in entries {
            for u in e.0.encode_utf16() {
                buf.extend_from_slice(&u.to_le_bytes());
            }
        }
        buf
    }

    const SUSP: (u32, u32) = (5, 5);
    const RUN: (u32, u32) = (2, 0);

    #[test]
    fn parses_names_pids_and_threads() {
        let buf = build(&[("System", 4, &[RUN]), ("Forza.exe", 77, &[SUSP, SUSP])], 0x7000_0000);
        let p = parse_processes(&buf, 0x7000_0000);
        assert_eq!(p.len(), 2);
        assert_eq!(p[1].name, "Forza.exe");
        assert_eq!(p[1].pid, 77);
        assert_eq!(p[1].threads, vec![SUSP, SUSP]);
    }

    #[test]
    fn all_threads_suspended_is_suspended() {
        let buf = build(&[("Forza.exe", 1, &[SUSP, SUSP])], 0x1000);
        assert_eq!(suspend_state(&parse_processes(&buf, 0x1000), "forza"), SuspendState::Suspended);
    }

    #[test]
    fn one_running_thread_is_active() {
        let buf = build(&[("Forza.exe", 1, &[SUSP, RUN])], 0x1000);
        assert_eq!(suspend_state(&parse_processes(&buf, 0x1000), "FORZA.EXE"), SuspendState::Active);
    }

    #[test]
    fn missing_process_is_gone_and_other_names_are_ignored() {
        let buf = build(&[("other.exe", 1, &[SUSP])], 0x1000);
        assert_eq!(suspend_state(&parse_processes(&buf, 0x1000), "forza"), SuspendState::Gone);
    }

    #[test]
    fn a_second_instance_that_is_running_wins() {
        let buf = build(&[("g.exe", 1, &[SUSP]), ("g.exe", 2, &[RUN])], 0x1000);
        assert_eq!(suspend_state(&parse_processes(&buf, 0x1000), "g"), SuspendState::Active);
    }

    #[test]
    fn a_process_with_no_threads_is_active_not_suspended() {
        let buf = build(&[("g.exe", 1, &[])], 0x1000);
        assert_eq!(suspend_state(&parse_processes(&buf, 0x1000), "g"), SuspendState::Active);
    }

    #[test]
    fn truncated_or_hostile_buffers_do_not_panic() {
        let buf = build(&[("a.exe", 1, &[SUSP]), ("b.exe", 2, &[SUSP])], 0x1000);
        for cut in 0..buf.len().min(700) {
            let _ = parse_processes(&buf[..cut], 0x1000);
        }
        let mut evil = buf.clone();
        evil[0..4].copy_from_slice(&u32::MAX.to_le_bytes());
        let _ = parse_processes(&evil, 0x1000);
        evil[64..72].copy_from_slice(&u64::MAX.to_le_bytes());
        let _ = parse_processes(&evil, 0x1000);
        let _ = parse_processes(&[], 0);
    }
}
