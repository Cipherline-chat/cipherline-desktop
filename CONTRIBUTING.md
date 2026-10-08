# Contributing to Cipherline Desktop

Thanks for taking a look. Bug reports, reviews of the crypto code and pull requests are all
welcome. This page explains how this repo works, so you know what to expect.

## Security issues: not here

If you've found a vulnerability, **don't open an issue or a pull request.** Report it
privately to [security@cipherline.chat](mailto:security@cipherline.chat). See
[SECURITY.md](SECURITY.md).

## How this repo works

- **It holds the code of the current stable release.** Day-to-day development happens in
  Cipherline's private development repository. Each stable release replaces `apps/desktop`
  and `packages/shared` here with the exact code that was released, in a commit called
  `Release vX.Y.Z` by the Cipherline release bot.
- **Official builds are made from this repo.** The
  [release workflow](.github/workflows/release-stable.yml) builds Windows, macOS and Linux on
  GitHub-hosted runners, signs the Windows build (as Cipherline LLC) and the macOS build
  (signed and notarized by Apple), and records a build provenance attestation for every
  installer. You can check that a download was built from this repo:

  ```bash
  gh attestation verify <installer> --repo Cipherline-chat/cipherline-desktop
  ```

- **Pull requests are reviewed here, then applied upstream.** Because each release replaces
  the tree, a pull request isn't merged into this repo directly. If we accept it, a
  maintainer applies the change in the development repository, it ships in a later stable
  release, and we note in your pull request which release it's in.

## Reporting a bug or asking for a feature

Use the issue templates. For bugs, include the app version (Settings → Advanced), your OS
and what you did; the more exact the steps to reproduce, the faster we can fix it. Please
don't include message content, keys, tokens or other people's usernames.

## Building it yourself

Node 20. The same steps the release workflow runs:

```bash
npm ci --legacy-peer-deps
cd apps/desktop
npm run rebuild-native
npm run build
npm test
```

Before opening a pull request, also run, from `apps/desktop`:

```bash
npm run lint
npm run build -w @cipherline/shared   # typecheck needs the shared package built
npm run typecheck
```

## What we look for in a pull request

- **One focused change**, with a description of what it fixes and how you tested it.
- **Tests** for behaviour you change (Vitest, next to the code).
- **No new or hand-rolled cryptography.** Messages use X25519 + HKDF-SHA256 +
  AES-256-GCM, files use WebCrypto AES-256-GCM, signatures use Ed25519. Changes to
  `apps/desktop/electron/e2ee-engine.ts`, `signal-identity.ts`, `storage.ts`,
  `src/utils/crypto.ts` or `src/utils/secureLocalStore.ts` get extra review.
- **Nothing stored in plaintext.** Persisted renderer data goes through
  `secureLocalStore`, never raw `localStorage`.
- **Electron stays locked down.** `nodeIntegration: false`, `contextIsolation: true` and
  `sandbox: true` are never weakened; privileged work goes through the preload bridge.
- **Dependencies** must be under a permissive license (MIT, Apache-2.0, BSD, ISC, 0BSD,
  Unlicense, CC0) and actively maintained. Add Apache and BSD ones to
  `apps/desktop/LICENSES.md`.

## License of contributions

Cipherline Desktop is licensed under the [Apache License 2.0](LICENSE). Under section 5
of that license, anything you intentionally submit for inclusion is provided under the same
license, unless you say otherwise.

## Code of conduct

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
