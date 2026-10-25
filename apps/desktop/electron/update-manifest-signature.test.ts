import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    decideManifest,
    manifestChannelOf,
    manifestSignedMessage,
    parseManifestSignature,
    publicKeyFromBase64,
    isManifestSignatureRequired,
    ManifestVerificationError,
    MANIFEST_SIGNATURE_DOMAIN,
    type ManifestCheckInput,
} from './update-manifest-signature';
import { UPDATE_MANIFEST_PUBLIC_KEYS, REQUIRE_MANIFEST_SIG, type ManifestChannel } from './update-manifest-keys';

/**
 * The decision table in decideManifest's doc, one test per row, plus the
 * attacks the signature exists for: a tampered manifest, a staging manifest
 * replayed as stable, a macOS manifest served to Linux, a wrong key — and key
 * rotation, which must keep working. Keys are generated per run; no key
 * material is stored in the repo.
 */

function keypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'jwk' }).x as string;
    return { privateKey, pub: Buffer.from(raw, 'base64url').toString('base64') };
}

const MANIFEST = Buffer.from(
    'version: 2.0.0\nfiles:\n  - url: Cipherline-2.0.0.AppImage\n    sha512: AAAA\n    size: 3\npath: Cipherline-2.0.0.AppImage\nsha512: AAAA\nreleaseDate: \'2026-10-12T00:00:00.000Z\'\n',
    'utf8',
);

function signFor(channel: ManifestChannel, fileName: string, bytes: Uint8Array, key: crypto.KeyObject): string {
    return crypto.sign(null, manifestSignedMessage(channel, fileName, bytes), key).toString('base64') + '\n';
}

const STABLE = keypair();
const STAGING = keypair();
const OTHER = keypair();

const input = (over: Partial<ManifestCheckInput> = {}): ManifestCheckInput => ({
    fileName: 'latest-linux.yml',
    manifestBytes: MANIFEST,
    signatureText: signFor('latest', 'latest-linux.yml', MANIFEST, STABLE.privateKey),
    publicKeys: [STABLE.pub],
    required: true,
    ...over,
});

describe('manifest names and the signed message', () => {
    it('knows every manifest name electron-updater asks for, and nothing else', () => {
        for (const [f, ch] of [
            ['latest.yml', 'latest'], ['latest-mac.yml', 'latest'], ['latest-linux.yml', 'latest'], ['latest-linux-arm64.yml', 'latest'],
            ['staging.yml', 'staging'], ['staging-mac.yml', 'staging'], ['staging-linux.yml', 'staging'],
        ] as const) expect(manifestChannelOf(f)).toBe(ch);
        for (const f of ['beta.yml', 'latest.yaml', '../latest.yml', 'latest-win.yml', 'latest.yml.sig', 'LATEST.yml', '']) {
            expect(manifestChannelOf(f)).toBeNull();
        }
    });

    it('is domain-separated and names channel, file and the sha256 of the exact bytes', () => {
        const msg = manifestSignedMessage('latest', 'latest-linux.yml', MANIFEST).toString('utf8');
        const digest = crypto.createHash('sha256').update(MANIFEST).digest('hex');
        expect(msg).toBe(`${MANIFEST_SIGNATURE_DOMAIN}:latest:latest-linux.yml:${digest}`);
        expect(MANIFEST_SIGNATURE_DOMAIN).toBe('cipherline-update-manifest:v1');
    });

    it('refuses to build a message for a file of another channel', () => {
        expect(() => manifestSignedMessage('latest', 'staging-linux.yml', MANIFEST)).toThrow();
    });
});

describe('decideManifest', () => {
    it('valid signature -> verified', () => {
        expect(decideManifest(input())).toEqual({ accept: true, outcome: 'verified', keyIndex: 0 });
    });

    it('a tampered manifest (one byte changed) is rejected, required or not', () => {
        const tampered = Buffer.from(MANIFEST.toString('utf8').replace('version: 2.0.0', 'version: 2.0.1'), 'utf8');
        for (const required of [true, false]) {
            expect(decideManifest(input({ manifestBytes: tampered, required }))).toEqual({ accept: false, outcome: 'invalid' });
        }
        // even an appended newline — YAML-equivalent, byte-different
        expect(decideManifest(input({ manifestBytes: Buffer.concat([MANIFEST, Buffer.from('\n')]) })).accept).toBe(false);
    });

    it('a staging manifest + its valid staging signature served as the STABLE manifest is rejected', () => {
        const sig = signFor('staging', 'staging-linux.yml', MANIFEST, STAGING.privateKey);
        expect(decideManifest(input({ signatureText: sig, publicKeys: [STABLE.pub] })).accept).toBe(false);
        // …even if the stable list wrongly contained the staging key: the message names the channel
        expect(decideManifest(input({ signatureText: sig, publicKeys: [STAGING.pub] }))).toEqual({ accept: false, outcome: 'invalid' });
    });

    it('a macOS manifest + signature served as the Linux manifest is rejected (file is bound)', () => {
        const sig = signFor('latest', 'latest-mac.yml', MANIFEST, STABLE.privateKey);
        expect(decideManifest(input({ signatureText: sig }))).toEqual({ accept: false, outcome: 'invalid' });
    });

    it('a signature by a key that is not on the list is rejected', () => {
        const sig = signFor('latest', 'latest-linux.yml', MANIFEST, OTHER.privateKey);
        expect(decideManifest(input({ signatureText: sig }))).toEqual({ accept: false, outcome: 'invalid' });
        expect(decideManifest(input({ signatureText: sig, required: false }))).toEqual({ accept: false, outcome: 'invalid' });
    });

    it('key rotation: any listed key verifies, and reports which one', () => {
        const NEW = keypair();
        const oldSig = signFor('latest', 'latest-linux.yml', MANIFEST, STABLE.privateKey);
        const newSig = signFor('latest', 'latest-linux.yml', MANIFEST, NEW.privateKey);
        const both = [STABLE.pub, NEW.pub];
        expect(decideManifest(input({ signatureText: oldSig, publicKeys: both }))).toEqual({ accept: true, outcome: 'verified', keyIndex: 0 });
        expect(decideManifest(input({ signatureText: newSig, publicKeys: both }))).toEqual({ accept: true, outcome: 'verified', keyIndex: 1 });
        // the old key removed later: its signatures stop verifying
        expect(decideManifest(input({ signatureText: oldSig, publicKeys: [NEW.pub] })).accept).toBe(false);
        // a malformed entry in the list is skipped, not fatal
        expect(decideManifest(input({ signatureText: newSig, publicKeys: ['not-a-key', NEW.pub] }))).toEqual({ accept: true, outcome: 'verified', keyIndex: 1 });
    });

    it('missing .sig: rejected when required, accepted (and labelled) in grace', () => {
        expect(decideManifest(input({ signatureText: null, required: true }))).toEqual({ accept: false, outcome: 'missing' });
        expect(decideManifest(input({ signatureText: null, required: false }))).toEqual({ accept: true, outcome: 'unsigned-grace' });
    });

    it('malformed .sig is rejected in every mode (empty, truncated, non-canonical, junk)', () => {
        const good = signFor('latest', 'latest-linux.yml', MANIFEST, STABLE.privateKey).trim();
        // Non-canonical base64: a 64-byte signature encodes as 86 chars + '==', so
        // the last data char carries 4 zero padding bits (it is always one of
        // A/Q/g/w). Bumping it by one alphabet slot sets a padding bit: lenient
        // decoders still yield the SAME bytes, so this must be rejected on form.
        // (The old `${good.slice(0, -3)}A==` was the original string whenever the
        // signature happened to end in 'A', i.e. ~1 run in 4 the test passed a
        // valid signature and failed.)
        const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        const lastData = good.slice(-3, -2);
        const nonCanonical = `${good.slice(0, -3)}${B64[B64.indexOf(lastData) + 1]}==`;
        expect(nonCanonical).not.toBe(good);
        expect(Buffer.from(nonCanonical, 'base64').equals(Buffer.from(good, 'base64'))).toBe(true);
        for (const bad of ['', '\n', good.slice(0, 40), good + good, nonCanonical, 'x'.repeat(5000), '<Error>AccessDenied</Error>']) {
            for (const required of [true, false]) {
                const d = decideManifest(input({ signatureText: bad, required }));
                expect(d.accept, JSON.stringify(bad.slice(0, 20))).toBe(false);
            }
        }
        // a trailing CRLF / LF is fine
        expect(decideManifest(input({ signatureText: `${good}\r\n` })).accept).toBe(true);
        expect(decideManifest(input({ signatureText: good })).accept).toBe(true);
    });

    it('a .sig with no keys in the build: rejected when required, accepted in grace (cannot be checked)', () => {
        expect(decideManifest(input({ publicKeys: [], required: true }))).toEqual({ accept: false, outcome: 'no-keys' });
        expect(decideManifest(input({ publicKeys: [], required: false }))).toEqual({ accept: true, outcome: 'unverifiable-grace' });
    });

    it('an unknown file name is rejected even in grace', () => {
        expect(decideManifest(input({ fileName: 'beta.yml', required: false, signatureText: null }))).toEqual({ accept: false, outcome: 'unexpected-file' });
    });
});

describe('parsing', () => {
    it('public keys: exactly 32 raw bytes in canonical base64', () => {
        expect(publicKeyFromBase64(STABLE.pub)).not.toBeNull();
        expect(publicKeyFromBase64(STABLE.pub.slice(0, -2) + '==')).toBeNull();
        expect(publicKeyFromBase64(Buffer.alloc(33, 1).toString('base64'))).toBeNull();
        expect(publicKeyFromBase64('')).toBeNull();
    });

    it('signatures: exactly 64 bytes', () => {
        expect(parseManifestSignature(Buffer.alloc(64, 7).toString('base64'))).toHaveLength(64);
        expect(parseManifestSignature(Buffer.alloc(63, 7).toString('base64'))).toBeNull();
    });
});

describe('enforcement and the embedded configuration', () => {
    it('grace / linux / all', () => {
        for (const p of ['linux', 'win32', 'darwin'] as const) {
            expect(isManifestSignatureRequired('grace', p)).toBe(false);
            expect(isManifestSignatureRequired('all', p)).toBe(true);
            expect(isManifestSignatureRequired('linux', p)).toBe(p === 'linux');
        }
    });

    it('every embedded key is a valid Ed25519 key, and stable and staging share none', () => {
        for (const ch of ['latest', 'staging'] as const) {
            for (const k of UPDATE_MANIFEST_PUBLIC_KEYS[ch]) expect(publicKeyFromBase64(k), `${ch}: ${k}`).not.toBeNull();
        }
        const shared = UPDATE_MANIFEST_PUBLIC_KEYS.latest.filter((k) => UPDATE_MANIFEST_PUBLIC_KEYS.staging.includes(k));
        expect(shared).toEqual([]);
    });

    it('a channel that requires signatures carries at least one key (else every update is refused)', () => {
        for (const ch of ['latest', 'staging'] as const) {
            if (REQUIRE_MANIFEST_SIG[ch] !== 'grace') expect(UPDATE_MANIFEST_PUBLIC_KEYS[ch].length, ch).toBeGreaterThan(0);
        }
    });

    it('both channels require a signature on every platform (owner decision 2026-10-15)', () => {
        // Flipping back to 'grace' re-opens unsigned updates; only ever do it to recover from a lost key.
        expect(REQUIRE_MANIFEST_SIG).toEqual({ latest: 'all', staging: 'all' });
        for (const p of ['linux', 'win32', 'darwin'] as NodeJS.Platform[]) {
            expect(isManifestSignatureRequired(REQUIRE_MANIFEST_SIG.latest, p), p).toBe(true);
            expect(isManifestSignatureRequired(REQUIRE_MANIFEST_SIG.staging, p), p).toBe(true);
        }
    });

    it('the CI signer parses the same key lists out of update-manifest-keys.ts', async () => {
        // @ts-expect-error — plain .mjs script, no type declarations
        const script = await import('../scripts/sign-update-manifest.mjs');
        const src = fs.readFileSync(path.resolve(__dirname, 'update-manifest-keys.ts'), 'utf8');
        for (const ch of ['latest', 'staging'] as const) {
            expect(script.allowlistedKeys(ch, src)).toEqual([...UPDATE_MANIFEST_PUBLIC_KEYS[ch]]);
        }
        // and copes with the populated shape (one key per line, comments)
        const populated = src.replace(/latest: \[[^\]]*\]/, `latest: [\n        '${STABLE.pub}', // 2026-10 stable\n        // '${OTHER.pub}', retired\n    ]`);
        expect(script.allowlistedKeys('latest', populated)).toEqual([STABLE.pub]);
        // base64 may contain adjacent slashes; they are not a comment (random keys hit this ~1% of the time)
        const slashy = 'ab//cdefghijklmnopqrstuvwxyz0123456789ABCDEFG=';
        const withSlashes = src.replace(/latest: \[[^\]]*\]/, `latest: [\n        '${slashy}', // a comment\n    ]`);
        expect(script.allowlistedKeys('latest', withSlashes)).toEqual([slashy]);
    });
});

describe('ManifestVerificationError', () => {
    it('carries the code the updater classifies, and a message of static words', () => {
        const e = new ManifestVerificationError('invalid', 'latest-linux.yml');
        expect(e.code).toBe('ERR_UPDATER_MANIFEST_SIGNATURE');
        expect(e.message).toBe('update manifest latest-linux.yml failed signature verification (invalid)');
        expect(new ManifestVerificationError('unexpected-file', '../x/<script>').fileName).toMatch(/^[A-Za-z0-9._-]+$/);
    });
});
