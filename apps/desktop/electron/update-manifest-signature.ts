/**
 * update-manifest-signature.ts — verify the detached Ed25519 signature
 * (`<manifest>.sig`) over an update manifest, and decide whether the updater
 * may use that manifest. Pure (Node `crypto` only, no electron, no network) so
 * every case is unit-tested; the electron-updater hook is
 * signed-update-provider.ts and the keys/enforcement live in
 * update-manifest-keys.ts (read its header for WHY and the rollout order).
 *
 * ── Wire format ────────────────────────────────────────────────────────────
 *   `<manifest>.sig` = standard base64 of the 64-byte Ed25519 signature, an
 *   optional trailing newline, nothing else.
 *
 *   The signed message (UTF-8, no trailing newline):
 *     cipherline-update-manifest:v1:<channel>:<file>:<sha256-hex of the manifest bytes>
 *   e.g. cipherline-update-manifest:v1:latest:latest-linux.yml:9f86d0…
 *
 *   • domain-separated (`cipherline-update-manifest:v1`) so the key can never
 *     be tricked into signing something that verifies as anything else;
 *   • names the CHANNEL, so a staging manifest + its signature served as the
 *     stable manifest is rejected even if both channels shared a key;
 *   • names the FILE, so a macOS manifest cannot be served as the Linux one
 *     (whose updater would otherwise pick the "first non-deb file" of it);
 *   • covers the EXACT bytes electron-updater parses (it hashes them, it does
 *     not re-serialize YAML), and the manifest carries the sha512 that
 *     electron-updater checks every downloaded installer against — so the
 *     signature transitively covers the AppImage/.deb/.exe/.zip bytes.
 *
 * scripts/sign-update-manifest.mjs builds the same message; the two are pinned
 * together by sign-update-manifest-script.test.ts.
 */

import * as crypto from 'crypto';
import type { ManifestChannel, ManifestSignatureEnforcement } from './update-manifest-keys';

export const MANIFEST_SIGNATURE_DOMAIN = 'cipherline-update-manifest:v1';

/** Every manifest name electron-updater's GenericProvider can ask for, for our two channels. */
const MANIFEST_FILE_RE = /^(latest|staging)(?:-mac|-linux(?:-[a-z0-9]{1,16})?)?\.yml$/;

/** The channel a manifest file belongs to (`latest-linux.yml` → `latest`), or null for any other name. */
export function manifestChannelOf(fileName: string): ManifestChannel | null {
    const m = MANIFEST_FILE_RE.exec(fileName);
    return m ? (m[1] as ManifestChannel) : null;
}

/** The exact bytes that are signed. Throws if `fileName` is not a manifest of `channel`. */
export function manifestSignedMessage(channel: ManifestChannel, fileName: string, manifestBytes: Uint8Array): Buffer {
    if (manifestChannelOf(fileName) !== channel) {
        throw new Error(`"${fileName}" is not a ${channel} update manifest`);
    }
    const digest = crypto.createHash('sha256').update(manifestBytes).digest('hex');
    return Buffer.from(`${MANIFEST_SIGNATURE_DOMAIN}:${channel}:${fileName}:${digest}`, 'utf8');
}

/** Decode a `.sig` file body. Null for anything but one canonical base64 64-byte signature. */
export function parseManifestSignature(text: string): Buffer | null {
    if (typeof text !== 'string' || text.length > 200) return null;
    const t = text.replace(/\r?\n$/, '');
    if (!/^[A-Za-z0-9+/]{86}==$/.test(t)) return null;
    const sig = Buffer.from(t, 'base64');
    return sig.length === 64 && sig.toString('base64') === t ? sig : null;
}

/** A raw 32-byte Ed25519 public key (standard base64, 44 chars) as a KeyObject, or null. */
export function publicKeyFromBase64(b64: string): crypto.KeyObject | null {
    if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(b64)) return null;
    const raw = Buffer.from(b64, 'base64');
    if (raw.length !== 32 || raw.toString('base64') !== b64) return null;
    try {
        return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
    } catch {
        return null;
    }
}

export type ManifestRejection =
    /** No `.sig` (404) and the signature is required. */
    | 'missing'
    /** A `.sig` that is not one base64 64-byte signature. */
    | 'malformed'
    /** A well-formed `.sig` that no key of the channel verifies. */
    | 'invalid'
    /** The signature is required but this build carries no (valid) key for the channel. */
    | 'no-keys'
    /** The fetched file is not a manifest of a known channel, or not the one the updater asked for. */
    | 'unexpected-file';

export type ManifestDecision =
    | { accept: true; outcome: 'verified'; keyIndex: number }
    /** Grace mode: no `.sig` was published. */
    | { accept: true; outcome: 'unsigned-grace' }
    /** Grace mode: a `.sig` exists but this build has no key to check it with. */
    | { accept: true; outcome: 'unverifiable-grace' }
    | { accept: false; outcome: ManifestRejection };

export interface ManifestCheckInput {
    /** The manifest's file name as fetched (`latest-linux.yml`). */
    fileName: string;
    /** The exact manifest bytes the updater is about to parse. */
    manifestBytes: Uint8Array;
    /** The `.sig` body, or null when the server has none (404). */
    signatureText: string | null;
    /** The channel's public keys (update-manifest-keys.ts). */
    publicKeys: readonly string[];
    /** isManifestSignatureRequired(...) for this channel and platform. */
    required: boolean;
}

/**
 * The whole policy, as a decision table:
 *
 *   file not a known manifest ................................ reject unexpected-file
 *   no .sig      + required .................................. reject missing
 *   no .sig      + grace ..................................... accept unsigned-grace
 *   .sig present + malformed ................................. reject malformed   (any mode)
 *   .sig present + no valid key + required ................... reject no-keys
 *   .sig present + no valid key + grace ...................... accept unverifiable-grace
 *   .sig present + a key verifies ............................ accept verified
 *   .sig present + keys exist, none verifies ................. reject invalid     (any mode)
 *
 * A present-but-bad signature is rejected even in grace mode: grace exists so
 * that releases published before signing began keep working, not so that a
 * manifest someone tampered with after signing is accepted.
 */
export function decideManifest(input: ManifestCheckInput): ManifestDecision {
    const channel = manifestChannelOf(input.fileName);
    if (!channel) return { accept: false, outcome: 'unexpected-file' };

    if (input.signatureText === null) {
        return input.required ? { accept: false, outcome: 'missing' } : { accept: true, outcome: 'unsigned-grace' };
    }
    const sig = parseManifestSignature(input.signatureText);
    if (!sig) return { accept: false, outcome: 'malformed' };

    const keys = input.publicKeys.map((k, i) => ({ i, key: publicKeyFromBase64(k) }));
    const usable = keys.filter((k): k is { i: number; key: crypto.KeyObject } => k.key !== null);
    if (usable.length === 0) {
        return input.required ? { accept: false, outcome: 'no-keys' } : { accept: true, outcome: 'unverifiable-grace' };
    }
    const message = manifestSignedMessage(channel, input.fileName, input.manifestBytes);
    for (const { i, key } of usable) {
        let ok = false;
        try { ok = crypto.verify(null, message, key, sig); } catch { ok = false; }
        if (ok) return { accept: true, outcome: 'verified', keyIndex: i };
    }
    return { accept: false, outcome: 'invalid' };
}

/** Whether `enforcement` makes the signature mandatory on `platform`. */
export function isManifestSignatureRequired(enforcement: ManifestSignatureEnforcement, platform: NodeJS.Platform): boolean {
    if (enforcement === 'all') return true;
    if (enforcement === 'linux') return platform === 'linux';
    return false;
}

/** Error code the updater's `error` listener classifies as a manifest rejection. */
export const MANIFEST_SIGNATURE_ERROR_CODE = 'ERR_UPDATER_MANIFEST_SIGNATURE';

/** Thrown (through electron-updater's check) when a manifest is rejected. The message is static words only. */
export class ManifestVerificationError extends Error {
    readonly code = MANIFEST_SIGNATURE_ERROR_CODE;
    readonly outcome: ManifestRejection | 'verifier-unavailable';
    readonly fileName: string;
    constructor(outcome: ManifestRejection | 'verifier-unavailable', fileName: string) {
        const safe = String(fileName).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
        super(`update manifest ${safe} failed signature verification (${outcome})`);
        this.outcome = outcome;
        this.fileName = safe;
        this.name = 'ManifestVerificationError';
    }
}
