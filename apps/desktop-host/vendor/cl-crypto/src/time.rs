//! The two date operations the wire formats need: `Date.parse` of an ISO-8601 timestamp and
//! `Date.prototype.toISOString`. Milliseconds since the Unix epoch, UTC.
//!
//! Accepted: `YYYY-MM-DD`, optionally `THH:MM`, `:SS`, `.fraction`, then `Z` or `±HH:MM`.
//! One deliberate difference from V8: a date-time with NO zone is read as UTC, where V8 reads
//! it as device-local time. Every Cipherline timestamp is written by `toISOString` (always `Z`),
//! so this only affects input no client produces, and a phone's timezone must never change
//! which message sorts first.

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// `Date.parse(s)` for ISO-8601, or `None` where V8 returns `NaN`.
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let mut i = 0usize;
    let num = |i: &mut usize, n: usize| -> Option<i64> {
        let part = b.get(*i..*i + n)?;
        if !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        *i += n;
        std::str::from_utf8(part).ok()?.parse().ok()
    };
    let eat = |i: &mut usize, c: u8| -> bool {
        if b.get(*i) == Some(&c) {
            *i += 1;
            true
        } else {
            false
        }
    };
    let year = num(&mut i, 4)?;
    if !eat(&mut i, b'-') {
        return None;
    }
    let month = num(&mut i, 2)?;
    if !eat(&mut i, b'-') {
        return None;
    }
    let day = num(&mut i, 2)?;
    // V8 accepts any day 1–31 for any month and rolls over (Feb 30 → Mar 2).
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (mut h, mut mi, mut sec, mut ms) = (0i64, 0i64, 0i64, 0i64);
    let mut offset_min = 0i64;
    if i < b.len() {
        if !eat(&mut i, b'T') {
            return None;
        }
        h = num(&mut i, 2)?;
        if !eat(&mut i, b':') {
            return None;
        }
        mi = num(&mut i, 2)?;
        if eat(&mut i, b':') {
            sec = num(&mut i, 2)?;
            if eat(&mut i, b'.') {
                let start = i;
                while b.get(i).is_some_and(u8::is_ascii_digit) {
                    i += 1;
                }
                if i == start {
                    return None;
                }
                // Milliseconds: the first three fraction digits, the rest truncated (V8).
                let frac = &s[start..i];
                let padded = format!("{:0<3}", &frac[..frac.len().min(3)]);
                ms = padded.parse().ok()?;
            }
        }
        if h > 24 || mi > 59 || sec > 59 || (h == 24 && (mi | sec | ms) != 0) {
            return None;
        }
        if eat(&mut i, b'Z') {
        } else if let Some(&sign @ (b'+' | b'-')) = b.get(i) {
            i += 1;
            let oh = num(&mut i, 2)?;
            if !eat(&mut i, b':') {
                return None;
            }
            let om = num(&mut i, 2)?;
            if oh > 23 || om > 59 {
                return None;
            }
            offset_min = (oh * 60 + om) * if sign == b'+' { 1 } else { -1 };
        }
        if i != b.len() {
            return None;
        }
    }
    let days = days_from_civil(year, month, day);
    Some((((days * 24 + h) * 60 + mi - offset_min) * 60 + sec) * 1000 + ms)
}

/// `new Date(ms).toISOString()` for years 0000–9999.
pub fn to_iso(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_v8() {
        // Expected values from `Date.parse` in Node 22.
        assert_eq!(parse_iso_ms("2026-09-14T16:39:58.692Z"), Some(1_789_403_998_692));
        assert_eq!(parse_iso_ms("2026-09-01T12:00:00Z"), parse_iso_ms("2026-09-01T12:00:00.000Z"));
        assert_eq!(parse_iso_ms("2026-09-01"), Some(1_788_220_800_000));
        assert_eq!(parse_iso_ms("2026-09-01T02:00:00+02:00"), Some(1_788_220_800_000));
        assert_eq!(parse_iso_ms("2026-09-01T00:00:00.1239Z"), Some(1_788_220_800_123));
        assert_eq!(parse_iso_ms("nope"), None);
        assert_eq!(parse_iso_ms("2026-02-30T00:00:00Z"), Some(1_772_409_600_000));
        assert_eq!(parse_iso_ms("2026-02-32T00:00:00Z"), None);
        assert_eq!(parse_iso_ms("2026-09-01T00:00:00Zjunk"), None);
        assert_eq!(to_iso(1_789_403_998_692), "2026-09-14T16:39:58.692Z");
        assert_eq!(to_iso(0), "1970-01-01T00:00:00.000Z");
    }
}
