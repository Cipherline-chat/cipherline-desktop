// Windows VersionInfo resource: CompanyName / FileDescription / OriginalFilename / versions. A bare Rust exe has none of these,
// and reputation scoring (SmartScreen, endpoint security) reads them. The version comes from CL_HELPER_VERSION (CI passes the
// desktop package version) and falls back to Cargo's.
use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=CL_HELPER_VERSION");
    println!("cargo:rerun-if-changed=build.rs");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let ver = env::var("CL_HELPER_VERSION").unwrap_or_else(|_| env::var("CARGO_PKG_VERSION").unwrap());
    let nums: Vec<u16> = ver.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty()).take(4).map(|s| s.parse().unwrap_or(0)).collect();
    let n = |i: usize| nums.get(i).copied().unwrap_or(0);
    let rc = format!(
        r#"1 VERSIONINFO
FILEVERSION {a},{b},{c},{d}
PRODUCTVERSION {a},{b},{c},{d}
FILEOS 0x40004
FILETYPE 0x1
{{
  BLOCK "StringFileInfo" {{
    BLOCK "040904B0" {{
      VALUE "CompanyName", "Cipherline LLC"
      VALUE "FileDescription", "Cipherline local transfer helper (moves your history between your own devices over the local network)"
      VALUE "FileVersion", "{ver}"
      VALUE "InternalName", "near-helper"
      VALUE "LegalCopyright", "Copyright (c) Cipherline LLC"
      VALUE "OriginalFilename", "near-helper.exe"
      VALUE "ProductName", "Cipherline"
      VALUE "ProductVersion", "{ver}"
    }}
  }}
  BLOCK "VarFileInfo" {{ VALUE "Translation", 0x409, 1200 }}
}}
"#,
        a = n(0), b = n(1), c = n(2), d = n(3), ver = ver
    );
    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("near-helper.rc");
    fs::write(&out, rc).unwrap();
    let r = embed_resource::compile(&out, embed_resource::NONE);
    // On a Windows host (the CI runner) a failed resource compile fails the build; from Linux (`cargo check`) there is no rc.exe.
    if cfg!(windows) {
        r.manifest_required().unwrap();
    } else {
        let _ = r.manifest_optional();
    }
}
