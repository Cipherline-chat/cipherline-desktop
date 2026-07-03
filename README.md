<div align="center">
  <img src=".github/assets/banner.svg" alt="Cipherline — end-to-end encrypted messaging & calling" width="100%" />
</div>

<br/>

<div align="center">

**The privacy-first alternative to Discord, Slack, and Teams — fully end-to-end encrypted.**

[Website](https://cipherline.chat) · [Security](https://cipherline.chat/security) · [Report a vulnerability](SECURITY.md)

</div>

---

## This repo is warming up

The Cipherline desktop client — Electron + React, Apache-2.0 licensed — lands here once
it's ready to publish. Until then, this page is a placeholder: no source code yet, just
the plan.

**The idea, in one line:** your own servers, roles, channels, HD video, and studio voice
— everything Discord does — except the server is mathematically incapable of reading
any of it. All content is encrypted on-device before it ever leaves your machine.

## Why publish the client at all

Because "trust us, it's encrypted" isn't good enough. Once this repo is live, you'll be
able to read the actual cryptography — X25519 key exchange, AES-256-GCM, HKDF-SHA256,
Ed25519 signatures, forward secrecy via one-time prekeys — and verify for yourself that
the client does exactly what we say it does. No custom crypto, no hand-rolled primitives,
standard well-reviewed constructions throughout.

## What's coming here

- Full Electron + React desktop client source
- Build instructions — clone, install, run, no account required to inspect the code
- `SECURITY.md` with our vulnerability disclosure process and safe-harbor policy
- Apache-2.0 license, third-party dependency attributions included

## In the meantime

- **[cipherline.chat](https://cipherline.chat)** — the full site, including a deep-dive
  on the security model and how the encryption actually works.
- Star this repo if you'd like to know when the code lands.

---

<div align="center">
<sub>Cipherline — built so we can't betray you.</sub>
</div>
