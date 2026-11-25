//! The `nearX` members of `window.electronAPI`, engine side (shared by the Tauri host and the Electron `near-helper`): argument validation (the renderer is not
//! trusted: wrong types are rejected, never coerced) and the mapping onto [`NearEngine`]. Lives in the
//! library so the Linux harness drives exactly the code the Tauri shell does.
use super::engine::{ApproveOutcome, NearAuth, NearEngine, ScanInput};
use super::gate::{Availability, Verification};
use super::radio::AdapterState;
use serde_json::{json, Value};

/// Every near member name (the shim's allow-list and the parity inventory read this).
pub const MEMBERS: [&str; 20] = [
    "nearProbe", "nearGetState", "nearShowStart", "nearInviteStart", "nearApproverStart", "nearApprove", "nearRefuse", "nearCancel", "nearBiometricAvailability", "nearBiometricVerify",
    "nearTransferSend", "nearTransferReceive", "nearTransferResult", "nearTransferDiscard", "nearTransferPause", "nearTransferResume", "nearTransferKeepPartial", "nearTransferKey", "nearTransferRequest", "nearOwnDeliver",
];

fn s<'a>(v: &'a Value, k: &str) -> Result<&'a str, String> {
    v.get(k).and_then(Value::as_str).ok_or_else(|| format!("{k} must be a string"))
}
fn bounded<'a>(v: &'a Value, k: &str, max: usize) -> Result<&'a str, String> {
    let x = s(v, k)?;
    if x.is_empty() || x.len() > max {
        return Err(format!("{k} has an invalid length"));
    }
    Ok(x)
}
fn parse_auth(v: &Value) -> Result<NearAuth, String> {
    let a = v.get("auth").ok_or("auth is required")?;
    Ok(NearAuth { access_token: bounded(a, "accessToken", 4096)?.into(), user_id: bounded(a, "userId", 128)?.into(), device_id: bounded(a, "deviceId", 128)?.into() })
}

fn adapter_json(st: &AdapterState) -> (&'static str, Option<String>) {
    match st {
        AdapterState::Error(e) if e == "timeout" => ("timeout", None),
        AdapterState::Error(e) => ("error", Some(e.chars().take(120).collect())),
        other => (other.bridge_name(), None),
    }
}

/// `Some` when `action` is a near member.
pub fn call(eng: &NearEngine, action: &str, args: &[Value]) -> Option<Result<Value, String>> {
    if !action.starts_with("near") {
        return None;
    }
    let a0 = args.first().cloned().unwrap_or(Value::Null);
    let snap = |r: Result<super::state::NearSnapshot, String>| r.and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string()));
    Some(match action {
        "nearProbe" => {
            let (st, lan, bio, gate) = eng.probe();
            let (name, detail) = adapter_json(&st);
            let mut v = json!({ "available": true, "bluetooth": name, "lan": lan, "biometric": bio, "gate": gate, "pause": eng.pause_supported() });
            if let Some(d) = detail {
                v["bluetoothDetail"] = json!(d);
            }
            Ok(v)
        }
        "nearGetState" => serde_json::to_value(eng.snapshot()).map_err(|e| e.to_string()),
        "nearShowStart" => (|| {
            let typed = match s(&a0, "mode")? {
                "qr" => false,
                "typed" => true,
                _ => return Err("mode must be qr or typed".into()),
            };
            let label = a0.get("deviceLabel").and_then(Value::as_str).map(str::to_owned);
            snap(eng.show_start(bounded(&a0, "apiBase", 200)?.into(), typed, label))
        })(),
        "nearInviteStart" => (|| snap(eng.invite_start(bounded(&a0, "apiBase", 200)?.into(), parse_auth(&a0)?)))(),
        "nearApproverStart" => (|| {
            let sc = a0.get("scan").ok_or("scan is required")?;
            let scan = match s(sc, "kind")? {
                "qr" => ScanInput::Qr(bounded(sc, "text", 2048)?.into()),
                "typed" => ScanInput::Typed(bounded(sc, "code", 64)?.into()),
                _ => return Err("scan.kind must be qr or typed".into()),
            };
            snap(eng.approver_start(bounded(&a0, "apiBase", 200)?.into(), parse_auth(&a0)?, scan))
        })(),
        "nearApprove" => Ok(match eng.approve() {
            ApproveOutcome::Approved(g) => json!({ "result": "approved", "gate": g }),
            ApproveOutcome::Cancelled(g) => json!({ "result": "cancelled", "gate": g }),
            ApproveOutcome::Failed(g, e) => json!({ "result": "failed", "gate": g, "error": e.chars().take(200).collect::<String>() }),
        }),
        "nearRefuse" => {
            eng.refuse();
            Ok(Value::Null)
        }
        "nearCancel" => {
            eng.cancel();
            Ok(Value::Null)
        }
        "nearBiometricAvailability" => Ok(json!(if eng.biometric_availability() == Availability::Available { "available" } else { "unavailable" })),
        "nearBiometricVerify" => match a0.as_str() {
            Some(r) if !r.is_empty() && r.len() <= 200 => Ok(json!(match eng.biometric_verify(r) {
                Verification::Verified => "verified",
                Verification::Cancelled => "cancelled",
                Verification::Failed => "failed",
            })),
            _ => Err("reason must be a short string".into()),
        },
        "nearTransferSend" => bounded(&a0, "path", 4096).and_then(|p| eng.transfer_send(p.into())).map(|_| Value::Null),
        "nearTransferReceive" => eng.transfer_receive().map(|_| Value::Null),
        "nearTransferResult" => Ok(eng.transfer_result().map(|r| json!({ "path": r.path.display().to_string(), "size": r.size })).unwrap_or(Value::Null)),
        "nearTransferDiscard" => {
            eng.transfer_discard();
            Ok(Value::Null)
        }
        // K_xfer as standard base64, to the page that seals / opens the transfer container (contract 11.15). Only after approval.
        "nearTransferKey" => eng.transfer_key().map(|k| {
            use base64::Engine as _;
            Value::String(base64::engine::general_purpose::STANDARD.encode(*k))
        }),
        // Own-device transfer (contract 7). `ownDeviceId` = this device (the page knows it; the host does not guess).
        "nearTransferRequest" => (|| {
            let target = bounded(&a0, "deviceId", 128)?.to_owned();
            let me = bounded(&a0, "ownDeviceId", 128)?.to_owned();
            snap(eng.own_request(target, me))
        })(),
        // A `near_*` control message the page verified came from ANOTHER device of this account and was addressed to this one.
        "nearOwnDeliver" => (|| {
            let content = a0.get("content").cloned().ok_or("content is required")?;
            if !content.is_object() || content.to_string().len() > 4096 {
                return Err("content must be a small object".to_string());
            }
            let from = bounded(&a0, "fromDeviceId", 128)?.to_owned();
            let me = bounded(&a0, "ownDeviceId", 128)?.to_owned();
            let label = a0.get("deviceLabel").and_then(Value::as_str).unwrap_or("Your other device").chars().take(64).collect::<String>();
            Ok(json!(eng.own_deliver(content, &from, &me, &label)))
        })(),
        "nearTransferPause" => eng.transfer_pause().map(|_| Value::Null),
        "nearTransferResume" => eng.transfer_resume().map(|_| Value::Null),
        // "Keep what arrived": a full-size container file holding only the verified parts, and which byte ranges are real
        "nearTransferKeepPartial" => eng.transfer_keep_partial().map(|(path, pf)| {
            json!({ "path": path.display().to_string(), "size": pf.size, "ranges": pf.ranges.iter().map(|(o, l)| json!([o, l])).collect::<Vec<_>>(), "partsHeld": pf.parts_held, "partsTotal": pf.parts_total })
        }),
        other => Err(format!("{other} is not a near member")),
    })
}
