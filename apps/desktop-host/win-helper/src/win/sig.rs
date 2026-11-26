//! Authenticode check with WinVerifyTrust (what Get-AuthenticodeSignature calls underneath), plus the signer's subject.
//! Output mimics `Get-AuthenticodeSignature | ConvertTo-Json` so electron/authenticode-verify.ts's evaluateSignatureJson reads
//! it unchanged: `Status` 0 = Valid, anything else = not acceptable (2 NotSigned, 3 HashMismatch, 4 NotTrusted, 1 other).
use serde_json::{json, Value};
use windows::core::{GUID, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HWND, INVALID_HANDLE_VALUE};
use windows::Win32::Security::Cryptography::Catalog::{
    CryptCATAdminAcquireContext2, CryptCATAdminCalcHashFromFileHandle2, CryptCATAdminEnumCatalogFromHash, CryptCATAdminReleaseCatalogContext,
    CryptCATAdminReleaseContext, CryptCATCatalogInfoFromContext, CATALOG_INFO,
};
use windows::Win32::Security::Cryptography::{
    CertGetCertificateContextProperty, CertNameToStrW, CERT_CONTEXT, CERT_HASH_PROP_ID, CERT_NAME_STR_REVERSE_FLAG, CERT_X500_NAME_STR,
};
use windows::Win32::Security::WinTrust::{
    WTHelperGetProvCertFromChain, WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData, WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2,
    WINTRUST_CATALOG_INFO, WINTRUST_DATA, WINTRUST_DATA_0, WINTRUST_FILE_INFO, WTD_CHOICE_CATALOG, WTD_CHOICE_FILE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY,
    WTD_UI_NONE,
};

const TRUST_E_NOSIGNATURE: u32 = 0x800B_0100;
const TRUST_E_PROVIDER_UNKNOWN: u32 = 0x800B_0001;
const TRUST_E_SUBJECT_FORM_UNKNOWN: u32 = 0x800B_0003;
const TRUST_E_BAD_DIGEST: u32 = 0x8009_6010;
const TRUST_E_SUBJECT_NOT_TRUSTED: u32 = 0x800B_0004;
const CERT_E_UNTRUSTEDROOT: u32 = 0x800B_0109;
const CERT_E_CHAINING: u32 = 0x800B_010A;
const CERT_E_EXPIRED: u32 = 0x800B_0101;
const CERT_E_UNTRUSTEDTESTROOT: u32 = 0x800B_010D;
const TRUST_E_EXPLICIT_DISTRUST: u32 = 0x800B_0111;
const CRYPT_E_SECURITY_SETTINGS: u32 = 0x8009_2026;

pub fn status_from_hresult(rc: u32) -> (u32, &'static str) {
    match rc {
        0 => (0, "Signature verified."),
        TRUST_E_NOSIGNATURE => (2, "The file is not signed."),
        TRUST_E_BAD_DIGEST => (3, "The contents of the file do not match the signature."),
        TRUST_E_SUBJECT_NOT_TRUSTED | CERT_E_UNTRUSTEDROOT | CERT_E_CHAINING | CERT_E_EXPIRED | CERT_E_UNTRUSTEDTESTROOT
        | TRUST_E_EXPLICIT_DISTRUST | CRYPT_E_SECURITY_SETTINGS => (4, "The signature is not trusted."),
        _ => (1, "The signature could not be verified."),
    }
}

unsafe fn name_string(c: *const CERT_CONTEXT, issuer: bool) -> String {
    let info = &*(*c).pCertInfo;
    let blob = if issuer { &info.Issuer } else { &info.Subject };
    // Same rendering .NET's X509Certificate2.Subject gives (what PowerShell printed): "CN=..., O=..., L=..., S=..., C=..".
    let flags = windows::Win32::Security::Cryptography::CERT_STRING_TYPE(CERT_X500_NAME_STR.0 | CERT_NAME_STR_REVERSE_FLAG);
    let n = CertNameToStrW((*c).dwCertEncodingType, blob, flags, None);
    if n <= 1 {
        return String::new();
    }
    let mut b = vec![0u16; n as usize];
    let n2 = CertNameToStrW((*c).dwCertEncodingType, blob, flags, Some(&mut b));
    String::from_utf16_lossy(&b[..(n2 as usize).saturating_sub(1)])
}

unsafe fn thumbprint(c: *const CERT_CONTEXT) -> String {
    let mut buf = [0u8; 32];
    let mut len = buf.len() as u32;
    if CertGetCertificateContextProperty(c, CERT_HASH_PROP_ID, Some(buf.as_mut_ptr().cast()), &mut len).is_ok() {
        buf[..len as usize].iter().map(|b| format!("{b:02X}")).collect()
    } else {
        String::new()
    }
}

/// One WinVerifyTrust round (verify, read the signer, close). `data` carries either a file or a catalog choice.
unsafe fn run_trust(data: &mut WINTRUST_DATA) -> (u32, Value) {
    let mut action: GUID = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    let hwnd = HWND(INVALID_HANDLE_VALUE.0 as *mut _); // no UI
    data.dwStateAction = WTD_STATEACTION_VERIFY;
    let rc = WinVerifyTrust(hwnd, &mut action, (data as *mut WINTRUST_DATA).cast()) as u32;
    let mut signer = Value::Null;
    let prov = WTHelperProvDataFromStateData(HANDLE(data.hWVTStateData.0));
    if !prov.is_null() {
        let sg = WTHelperGetProvSignerFromChain(prov, 0, false, 0);
        if !sg.is_null() {
            let pc = WTHelperGetProvCertFromChain(sg, 0);
            if !pc.is_null() && !(*pc).pCert.is_null() {
                let c = (*pc).pCert as *const CERT_CONTEXT;
                signer = json!({ "Subject": name_string(c, false), "Issuer": name_string(c, true), "Thumbprint": thumbprint(c) });
            }
        }
    }
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    let _ = WinVerifyTrust(hwnd, &mut action, (data as *mut WINTRUST_DATA).cast());
    (rc, signer)
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Files with no embedded signature may be listed in a signed security catalog (most files Windows itself ships, e.g. notepad.exe).
/// Get-AuthenticodeSignature checks catalogs too, so this does as well. Returns None when no catalog lists the file's hash, so the
/// caller keeps the embedded-signature verdict (fail closed). The catalog's own signature is what WinVerifyTrust then judges.
unsafe fn catalog_verify(path: &str) -> Option<(u32, Value)> {
    use std::os::windows::io::AsRawHandle;
    let f = std::fs::File::open(path).ok()?;
    let fh = HANDLE(f.as_raw_handle());
    let wpath = wide(path);
    for alg in [Some("SHA256"), None] {
        let algw = alg.map(wide);
        let alg_ptr = algw.as_ref().map(|v| PCWSTR(v.as_ptr())).unwrap_or(PCWSTR::null());
        let mut admin: isize = 0;
        if CryptCATAdminAcquireContext2(&mut admin, None, alg_ptr, None, None).is_err() {
            continue;
        }
        let mut hlen = 0u32;
        let _ = CryptCATAdminCalcHashFromFileHandle2(admin, fh, &mut hlen, None, None);
        if hlen == 0 || hlen > 128 {
            let _ = CryptCATAdminReleaseContext(admin, 0);
            continue;
        }
        let mut hash = vec![0u8; hlen as usize];
        if CryptCATAdminCalcHashFromFileHandle2(admin, fh, &mut hlen, Some(hash.as_mut_ptr()), None).is_err() {
            let _ = CryptCATAdminReleaseContext(admin, 0);
            continue;
        }
        hash.truncate(hlen as usize);
        let cat = CryptCATAdminEnumCatalogFromHash(admin, &hash, None, None);
        if cat == 0 {
            let _ = CryptCATAdminReleaseContext(admin, 0);
            continue;
        }
        let mut info = CATALOG_INFO { cbStruct: std::mem::size_of::<CATALOG_INFO>() as u32, ..Default::default() };
        let out = if CryptCATCatalogInfoFromContext(cat, &mut info, 0).is_ok() {
            let tag = wide(&hash.iter().map(|b| format!("{b:02X}")).collect::<String>());
            let mut wci = WINTRUST_CATALOG_INFO {
                cbStruct: std::mem::size_of::<WINTRUST_CATALOG_INFO>() as u32,
                pcwszCatalogFilePath: PCWSTR(info.wszCatalogFile.as_ptr()),
                pcwszMemberTag: PCWSTR(tag.as_ptr()),
                pcwszMemberFilePath: PCWSTR(wpath.as_ptr()),
                hMemberFile: fh,
                pbCalculatedFileHash: hash.as_mut_ptr(),
                cbCalculatedFileHash: hash.len() as u32,
                hCatAdmin: admin,
                ..Default::default()
            };
            let mut data = WINTRUST_DATA {
                cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
                dwUIChoice: WTD_UI_NONE,
                fdwRevocationChecks: WTD_REVOKE_NONE,
                dwUnionChoice: WTD_CHOICE_CATALOG,
                Anonymous: WINTRUST_DATA_0 { pCatalog: &mut wci },
                ..Default::default()
            };
            Some(run_trust(&mut data))
        } else {
            None
        };
        let _ = CryptCATAdminReleaseCatalogContext(admin, cat, 0);
        let _ = CryptCATAdminReleaseContext(admin, 0);
        if out.is_some() {
            return out;
        }
    }
    None
}

pub fn verify(path: &str) -> Value {
    let w: Vec<u16> = wide(path);
    unsafe {
        let mut file = WINTRUST_FILE_INFO { cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32, pcwszFilePath: PCWSTR(w.as_ptr()), ..Default::default() };
        let mut data = WINTRUST_DATA {
            cbStruct: std::mem::size_of::<WINTRUST_DATA>() as u32,
            dwUIChoice: WTD_UI_NONE,
            fdwRevocationChecks: WTD_REVOKE_NONE,
            dwUnionChoice: WTD_CHOICE_FILE,
            Anonymous: WINTRUST_DATA_0 { pFile: &mut file },
            ..Default::default()
        };
        let (mut rc, mut signer) = run_trust(&mut data);
        if rc == TRUST_E_NOSIGNATURE || rc == TRUST_E_PROVIDER_UNKNOWN || rc == TRUST_E_SUBJECT_FORM_UNKNOWN {
            if let Some((crc, csigner)) = catalog_verify(path) {
                rc = crc;
                signer = csigner;
            }
        }
        let (status, msg) = status_from_hresult(rc);
        json!({ "Status": status, "StatusMessage": format!("{msg} (0x{rc:08X})"), "Path": path, "SignerCertificate": signer })
    }
}
