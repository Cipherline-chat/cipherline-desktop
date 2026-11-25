//! The Windows Hello approval gate (plan D6/D7): `UserConsentVerifier`. Availability is checked first and the
//! gate falls back to the native confirm (the existing `confirm()` of the shell, which the page cannot
//! click) when Hello is not configured. The verification is parented to the app window through
//! `IUserConsentVerifierInterop::RequestVerificationForWindowAsync` when a window handle is available (so the
//! prompt appears over, and modal to, Cipherline instead of behind it); otherwise the unparented
//! `RequestVerificationAsync`.
//!
//! NOT verifiable on the Linux dev box (type-checked for `x86_64-pc-windows-msvc` only): that the prompt
//! really appears over the window, and each `UserConsentVerificationResult` mapping, need a Windows PC with
//! Hello set up and one without.
#![cfg(windows)]
use super::gate::{ApprovalGate, Availability, Verification};
use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
use windows_core::HSTRING;
use windows_future::IAsyncOperation;

pub struct WinHello {
    /// The main window's HWND as an integer, 0 when there is none (resolved at prompt time).
    hwnd: Box<dyn Fn() -> isize + Send + Sync>,
    confirm: Box<dyn Fn(&str, &str) -> bool + Send + Sync>,
}

impl WinHello {
    pub fn new(hwnd: Box<dyn Fn() -> isize + Send + Sync>, confirm: Box<dyn Fn(&str, &str) -> bool + Send + Sync>) -> Self {
        Self { hwnd, confirm }
    }
}

/// `UserConsentVerificationResult` -> ours. Only `Verified` approves; "cancelled" is the user's own no.
pub fn map_result(r: UserConsentVerificationResult) -> Verification {
    match r {
        UserConsentVerificationResult::Verified => Verification::Verified,
        UserConsentVerificationResult::Canceled => Verification::Cancelled,
        _ => Verification::Failed, // RetriesExhausted, DeviceNotPresent, NotConfiguredForUser, DisabledByPolicy, DeviceBusy
    }
}

impl ApprovalGate for WinHello {
    fn availability(&self) -> Availability {
        super::winble::mta_for_hello();
        match UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.join()) {
            Ok(UserConsentVerifierAvailability::Available) => Availability::Available,
            _ => Availability::Unavailable,
        }
    }

    fn verify(&self, reason: &str) -> Verification {
        super::winble::mta_for_hello();
        let msg = HSTRING::from(reason.chars().take(200).collect::<String>());
        let hwnd = (self.hwnd)();
        let op: windows_core::Result<IAsyncOperation<UserConsentVerificationResult>> = if hwnd != 0 {
            windows_core::factory::<UserConsentVerifier, IUserConsentVerifierInterop>().and_then(|i| unsafe { i.RequestVerificationForWindowAsync(HWND(hwnd as *mut core::ffi::c_void), &msg) })
        } else {
            UserConsentVerifier::RequestVerificationAsync(&msg)
        };
        match op.and_then(|o| o.join()) {
            Ok(r) => map_result(r),
            Err(_) => Verification::Failed,
        }
    }

    fn confirm(&self, title: &str, detail: &str) -> bool {
        (self.confirm)(title, detail)
    }
}
