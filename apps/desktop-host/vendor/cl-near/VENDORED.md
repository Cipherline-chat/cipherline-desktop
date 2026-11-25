Vendored snapshot of `core/cl-near` (proximity sign-in core) from the private `Cipherline-chat/cipherline-native`
repo at commit **3ffa1d44**, so the Windows host builds without access to that repo. It depends on
`../cl-crypto`, which is the sibling vendored crate. Edits: Cargo.toml's `*.workspace = true` fields, one
appended constant (`LOOPBACK_ENABLED`, see `tools/sync-core.sh`). No other local edits: the portable address-family helper (`is_v6` in src/lan.rs, replacing socket2's unix-only `Socket::domain()`) is upstream since 3ffa1d44, so the old Windows patch is gone. Do not edit here; change it upstream and re-run
`tools/sync-core.sh`. `test-vectors/near-v1.json` and `test-vectors/ts-transfer-container.json` are committed (the gitleaks generic-api-key rule was measured over every string of both: 0 hits); `verify.py` stays ignored (a local cross-check).
