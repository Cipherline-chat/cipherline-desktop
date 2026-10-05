/**
 * QR linking payload builders — the strings a DISPLAYING device renders into a
 * QR code, for both of docs/QR-LINKING.md's primitives.
 *
 * These are byte-identical ports of `buildLinkQr`/`buildXferQr` from
 * `/home/antigravity/cm-wt/qrlink/src/core/crypto/link-qr.ts` (the mobile
 * repo's scanner-side counterpart), kept here rather than imported across
 * repos so this package has no cross-repo build dependency. Do not change
 * either output format without changing that file too — a mismatch means a
 * real phone cannot parse a real desktop's QR.
 *
 * docs/QR-LINKING.md §2.2 / §3.2 are the format specs:
 *
 * ```
 * cipherline://link/1?i=<link_id>&k=<ephemeral X25519 public key, base64url>
 * cipherline://xfer/1?t=<transfer_id>
 * ```
 */

const SCHEME = 'cipherline://';

/**
 * `link` (QR sign-in) — carries an EPHEMERAL PUBLIC KEY, so both arguments
 * MUST come from the IPC-returned key (`window.electronAPI.linkBegin()`) and
 * the server-issued session id — never from anywhere else. Rendering a QR
 * from a server-supplied key would let a hostile API pod substitute a key it
 * holds the private half of; see docs/QR-LINKING.md §2.5 for the full
 * reasoning that `QrSignInPanel.tsx` must honour.
 *
 * `linkId` is already base64url (22 chars, as issued by the server).
 * `ekPubB64` is STANDARD base64 (the form every crypto helper and the API
 * expect) and is converted to base64url here, the one place that needs to
 * know the difference.
 *
 * QR-4 (adversarial review): `linkId` is server-supplied, and until this fix
 * it was interpolated RAW. A hostile or compromised API pod could answer
 * `POST /v1/link/sessions` with `link_id = "<22 valid chars>&k=<attacker
 * key>"`, producing `...?i=<22>&k=<attacker>&k=<real>` — the mobile parser's
 * first-wins duplicate-key rule then takes the PREPENDED attacker key, not
 * the real one appended after it. `encodeURIComponent` on both fields closes
 * this at the builder; `qrSignInController.ts`'s `begin()` and
 * `electron/link-grant.ts`'s `bindLinkSession` also reject a malformed
 * `link_id` outright before it ever reaches here, as defence in depth.
 */
export function buildLinkQr(linkId: string, ekPubB64: string): string {
    const k = ekPubB64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${SCHEME}link/1?i=${encodeURIComponent(linkId)}&k=${encodeURIComponent(k)}`;
}

/**
 * `xfer` (QR transfer authorisation) — carries ONLY a random nonce, no key
 * material, so unlike `buildLinkQr` there is no "must come from an IPC-local
 * key" constraint: `transferId` is exactly what `POST /v1/link/transfers`
 * returned. docs/QR-LINKING.md §3.2/§3.5: the id is worthless to anyone not
 * already signed into the same account, which is what makes that safe.
 *
 * `transferId` is still server-supplied, so it is `encodeURIComponent`-ed for
 * the same QR-4 reason `buildLinkQr` above is, even though this string has no
 * second parameter for an injected id to shadow today — not depending on that
 * staying true is cheap.
 */
export function buildXferQr(transferId: string): string {
    return `${SCHEME}xfer/1?t=${encodeURIComponent(transferId)}`;
}

/**
 * `invite` (this SIGNED-IN desktop shows a QR for a new phone to scan) —
 * carries ONLY the invite id. No key: the phone brings its own ephemeral key
 * at `POST /v1/link/invites/:id/join`, and the grant is sealed to that. The
 * id is worthless on its own — whoever joins it must still have the six
 * digits shown on the joined phone typed into THIS desktop before anything
 * is approved (the server's A1 verification code, applied to device rather
 * than account substitution in this direction).
 *
 * Format mirrored by mobile's `parseLinkQr` (`cipherline://invite/1?i=<id>`);
 * change both or neither.
 */
export function buildInviteQr(inviteId: string): string {
    return `${SCHEME}invite/1?i=${encodeURIComponent(inviteId)}`;
}
