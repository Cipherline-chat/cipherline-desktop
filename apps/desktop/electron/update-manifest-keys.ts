/**
 * update-manifest-keys.ts — the Ed25519 PUBLIC keys that sign Cipherline's
 * update manifests (`latest*.yml`, `staging*.yml`), and how strictly each
 * channel enforces them. Verification itself: update-manifest-signature.ts;
 * the updater hook: signed-update-provider.ts; signing in CI:
 * scripts/sign-update-manifest.mjs.
 *
 * WHY: electron-updater trusts the manifest it downloads for the version and
 * the sha512 of every installer. On Windows the installer is ALSO checked for
 * an Authenticode signature by Cipherline LLC, and on macOS Squirrel.Mac checks
 * the code signature, but on Linux (AppImage AND .deb — the .deb updates
 * itself through DebUpdater with `pkexec dpkg -i`, i.e. as root) the manifest
 * is the whole chain of trust: whoever can write `updates.cipherline.chat`
 * could ship code to every Linux user. A detached Ed25519 signature over the
 * exact manifest bytes moves that trust to a key that never touches the
 * update host.
 *
 * ── Keys ────────────────────────────────────────────────────────────────────
 * Each entry is a RAW 32-byte Ed25519 public key in standard base64 (44
 * characters, ending in "="). A manifest is accepted when ANY key of its
 * channel verifies, so rotation is: add the new key here and ship it, move the
 * CI secret to the new private key, and remove the old key once no supported
 * client needs it. Stable (`latest`) and `staging` use DIFFERENT keys (a leaked
 * staging key must not be able to sign a stable update); the signed message
 * also names the channel and the manifest file, so a staging manifest cannot
 * be replayed as a stable one even if the keys were ever shared by mistake.
 *
 * Keep the one-key-per-line `'…',` format: scripts/sign-update-manifest.mjs
 * reads this block to refuse to sign with a key clients would reject, and
 * update-manifest-signature.test.ts pins that the two parses agree.
 *
 * ── Enforcement and the rollout ORDER ──────────────────────────────────────
 *   'grace' — a manifest with NO .sig (404) is accepted (and recorded as
 *             `updater:manifest-unsigned`); a .sig that is present but does
 *             not verify is ALWAYS rejected, in every mode.
 *   'linux' — the signature is REQUIRED on Linux (AppImage + .deb: no other
 *             signature exists there) and grace elsewhere.
 *   'all'   — required everywhere (defence in depth on top of Authenticode /
 *             Squirrel.Mac).
 *
 *   1. (this commit) Key lists empty, both channels 'grace': no behaviour
 *      change at all — a .sig cannot be checked without keys, so it is ignored.
 *   2. Owner creates the two keypairs and the CI secrets (docs/stable-release-
 *      pipeline.md → "Update-manifest signing keys"), and commits the two
 *      PUBLIC keys below. From then on every staging and stable release
 *      publishes `<manifest>.sig` (stable: mandatory; staging: mandatory once
 *      release-desktop.yml's UPDATE_MANIFEST_SIG_STAGING_GRACE is 'false').
 *   3. Release a build carrying the keys on each channel. Its clients verify
 *      every signature that is present; check a report's Performance log for
 *      `updater:manifest-verified`.
 *   4. Only once every FUTURE manifest on a channel is guaranteed to be signed
 *      (step 2 done for that channel, signing mandatory in its workflow) flip
 *      that channel to 'linux', release, then to 'all'. A flip only affects
 *      clients running the build that carries it, and they then refuse any
 *      unsigned manifest — so never flip before step 2, never back to 'grace'
 *      except to recover from a lost key.
 *
 * A channel set above 'grace' must have at least one key (pinned by a test).
 */

export type ManifestChannel = 'latest' | 'staging';

export const UPDATE_MANIFEST_PUBLIC_KEYS: Readonly<Record<ManifestChannel, readonly string[]>> = {
    latest: [
        'DLZ322UBLPSX6QMNv2kfuyAvcoazz1fqNtB3Hoa6sYw=', // stable key #1, created 2026-10-13
    ],
    staging: [
        'nvUzPHbJcJ7rT/s8i1IMddeg0oGafVPhyMS0WvMt8+c=', // staging key #1, created 2026-10-13
    ],
};

export type ManifestSignatureEnforcement = 'grace' | 'linux' | 'all';

// 2026-10-15: both channels go straight to 'all'. Steps 2 and 3 are done on both:
// every manifest of stable 1.0.22 (latest, latest-mac, latest-linux) and staging
// 1.0.22-staging.161+ is signed and verified against the keys above, signing is
// mandatory in both release workflows, and each publish job re-verifies its .sig
// after upload. Owner-approved; the 'linux' intermediate step was skipped because
// all three platforms were already signed in the same releases.
export const REQUIRE_MANIFEST_SIG: Readonly<Record<ManifestChannel, ManifestSignatureEnforcement>> = {
    latest: 'all',
    staging: 'all',
};
