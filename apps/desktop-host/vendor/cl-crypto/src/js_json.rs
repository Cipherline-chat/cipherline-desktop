//! `JSON.parse` / `JSON.stringify` with JavaScript's output rules.
//!
//! Desktop builds several signed or encrypted payloads by `JSON.stringify`-ing an object, so
//! byte parity with desktop means producing what V8 produces:
//! - object keys that are array indices (`"0"`, `"17"`, …) come first, ascending, then every
//!   other key in insertion order (ECMAScript `OrdinaryOwnPropertyKeys`);
//! - integral numbers print without a fraction (`1.0` → `1`, `-0` → `0`);
//! - strings escape `"`, `\`, `\b \f \n \r \t` and other C0 controls as `\u00xx`; everything
//!   else, including non-ASCII and U+2028, is written raw.
//!
//! Known gaps (none occur in Cipherline payloads): non-integral numbers use Rust's shortest
//! round-trip form, which differs from V8 only in exponent notation (`1e-7` vs `0.0000001`);
//! integers beyond 2^53 keep full precision where V8 rounds; and `serde_json` refuses a lone
//! UTF-16 surrogate escape that `JSON.parse` would accept, so such input reads as "not JSON".
use serde_json::{Map, Value};

pub fn parse(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
}

pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

fn write_value(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => write_number(out, n),
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => write_object(out, map),
    }
}

fn write_number(out: &mut String, n: &serde_json::Number) {
    if let Some(i) = n.as_i64() {
        out.push_str(&i.to_string());
    } else if let Some(u) = n.as_u64() {
        out.push_str(&u.to_string());
    } else {
        let f = n.as_f64().unwrap_or(0.0);
        if !f.is_finite() {
            out.push_str("null");
        } else if f == f.trunc() && f.abs() < 1e21 {
            // Integral: V8 prints no fraction, and -0 as 0.
            if f == 0.0 {
                out.push('0');
            } else {
                out.push_str(&format!("{f:.0}"));
            }
        } else {
            out.push_str(&format!("{f}"));
        }
    }
}

fn write_string(out: &mut String, s: &str) {
    // serde_json's escaping is V8's for well-formed strings (lowercase \u00xx for controls).
    out.push_str(&serde_json::to_string(s).expect("string serialisation cannot fail"));
}

/// An ECMAScript array index: canonical decimal, value below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let v: u64 = key.parse().ok()?;
    (v < u64::from(u32::MAX)).then_some(v as u32)
}

fn write_object(out: &mut String, map: &Map<String, Value>) {
    let mut indexed: Vec<(u32, &String, &Value)> =
        map.iter().filter_map(|(k, v)| array_index(k).map(|i| (i, k, v))).collect();
    indexed.sort_by_key(|(i, _, _)| *i);
    out.push('{');
    let mut first = true;
    let mut emit = |out: &mut String, k: &String, v: &Value| {
        if !first {
            out.push(',');
        }
        first = false;
        write_string(out, k);
        out.push(':');
        write_value(out, v);
    };
    for (_, k, v) in &indexed {
        emit(out, k, v);
    }
    for (k, v) in map.iter().filter(|(k, _)| array_index(k).is_none()) {
        emit(out, k, v);
    }
    out.push('}');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rt(s: &str) -> String {
        stringify(&parse(s).unwrap())
    }

    #[test]
    fn matches_v8() {
        // Each expected value is `JSON.stringify(JSON.parse(input))` in Node 22.
        assert_eq!(rt(r#"{"b":1,"2":2,"a":3,"1":4,"01":5}"#), r#"{"1":4,"2":2,"b":1,"a":3,"01":5}"#);
        assert_eq!(rt("[1.0,-0,2.5,1e3,-3.0]"), "[1,0,2.5,1000,-3]");
        assert_eq!(rt(r#""h\u00e9llo 👋 \u2028 \"q\" \\ \u0001 \n""#), "\"héllo 👋 \u{2028} \\\"q\\\" \\\\ \\u0001 \\n\"");
        assert_eq!(rt(r#"{"a":1,"a":2}"#), r#"{"a":2}"#);
    }
}
