//! Proof tool for the registration proof-of-work: solve server-issued challenge tokens with the
//! app's solver, so the API's own verifier (`apps/api/src/auth/pow.util.ts`) can check them.
//!   cargo run --release -p cl-crypto --example pow_solve -- <difficulty> <token>...
//! Prints `<token> <nonce> <ms>` per token.
fn main() {
    let mut args = std::env::args().skip(1);
    let difficulty: u32 = args.next().and_then(|d| d.parse().ok()).expect("difficulty");
    for token in args {
        let t0 = std::time::Instant::now();
        let nonce = cl_crypto::pow::solve(&token, difficulty, |_| true).expect("solvable");
        println!("{token} {nonce} {}", t0.elapsed().as_millis());
    }
}
