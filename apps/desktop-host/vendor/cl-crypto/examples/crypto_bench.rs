//! Crypto micro-benchmark (speed-pass 2): the primitives the app actually calls, best of several runs.
//! `cargo run --release -p cl-crypto --example crypto_bench`
use std::time::Instant;
use cl_crypto::{blob, kdf, keys};

fn best<F: FnMut()>(n: usize, mut f: F) -> f64 {
    let mut b = f64::MAX;
    for _ in 0..n { let t = Instant::now(); f(); b = b.min(t.elapsed().as_secs_f64() * 1000.0); }
    b
}

fn main() {
    let key = [7u8; 32];
    let iv = [3u8; blob::IV_LEN];
    let data = vec![0xABu8; 4 * 1024 * 1024];
    let mut sealed = Vec::new();
    println!("aes-gcm seal 4 MiB:   {:8.2} ms", best(7, || { sealed = blob::seal(&key, &iv, &data).unwrap(); }));
    println!("aes-gcm open 4 MiB:   {:8.2} ms", best(7, || { let _ = blob::open(&key, &iv, &sealed).unwrap(); }));
    let (sa, _) = keys::generate_x25519();
    let (_, pb) = keys::generate_x25519();
    let secret = keys::x25519_secret(&sa[..]).unwrap();
    let public = keys::x25519_pub_from_b64(&pb).unwrap();
    println!("x25519 ecdh x200:     {:8.2} ms", best(5, || { for _ in 0..200 { let _ = keys::ecdh(&secret, &public); } }));
    let sk = keys::generate_ed25519();
    let msg = [9u8; 256];
    println!("ed25519 sign x200:    {:8.2} ms", best(5, || { for _ in 0..200 { let _ = keys::sign(&sk, &msg); } }));
    println!("pbkdf2 sha256 600k:   {:8.2} ms", best(3, || { let _ = kdf::backup_key_sha256("correct horse", &[1u8; 16], 600_000); }));
    println!("hkdf user_subkey x2k: {:8.2} ms", best(5, || { for _ in 0..2000 { let _ = kdf::user_subkey(&key, "user-1"); } }));
}
