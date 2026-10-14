import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import * as fc from 'fast-check';
import {
    decideManifest,
    manifestChannelOf,
    manifestSignedMessage,
    parseManifestSignature,
    publicKeyFromBase64,
    type ManifestCheckInput,
} from './update-manifest-signature';

/**
 * Property / fuzz tests for the update-manifest signature policy.
 *
 * update-manifest-signature.test.ts pins the decision table row by row. This
 * file asks the question the table cannot: for ANYTHING an attacker (or a
 * misbehaving CDN) can put in the `.sig` body, the manifest bytes, the file
 * name or the key list, can `decideManifest` ever say `accept: true` for a
 * manifest the key holder did not sign?
 *
 *   - `accept: true` + `verified` only for the genuine signature of the genuine
 *     bytes for the genuine file;
 *   - the parsers (`parseManifestSignature`, `publicKeyFromBase64`,
 *     `manifestChannelOf`) and `decideManifest` never throw, whatever they are fed;
 *   - grace mode never turns a present-but-bad signature into an accept;
 *   - a valid signature round-trips, whichever position its key holds in the list.
 *
 * Keys are generated per run (nothing key-shaped in the repo). numRuns stay
 * modest so this runs in the normal `vitest run`.
 */

const RUNS = 200;

function keypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'jwk' }).x as string;
    return { privateKey, pub: Buffer.from(raw, 'base64url').toString('base64') };
}

const MANIFEST = Buffer.from(
    'version: 2.0.0\nfiles:\n  - url: Cipherline-2.0.0.AppImage\n    sha512: AAAA\n    size: 3\npath: Cipherline-2.0.0.AppImage\nsha512: AAAA\n',
    'utf8',
);
const FILE = 'latest-linux.yml';
const KEY = keypair();
const GENUINE = crypto.sign(null, manifestSignedMessage('latest', FILE, MANIFEST), KEY.privateKey).toString('base64');

const input = (over: Partial<ManifestCheckInput> = {}): ManifestCheckInput => ({
    fileName: FILE,
    manifestBytes: MANIFEST,
    signatureText: GENUINE + '\n',
    publicKeys: [KEY.pub],
    required: true,
    ...over,
});

/** The body a fetcher may legitimately hand over: the signature plus at most one trailing newline. */
const isGenuineBody = (s: string) => s === GENUINE || s === GENUINE + '\n' || s === GENUINE + '\r\n';

/** Strings an attacker would try: noise, near-misses of the real signature, and well-formed-but-wrong signatures. */
const sigBodies = fc.oneof(
    fc.string({ maxLength: 300 }),
    fc.string({ unit: 'binary', maxLength: 120 }),
    fc.base64String({ maxLength: 200 }),
    // a single character of the genuine signature replaced by any other
    fc.tuple(fc.nat(GENUINE.length - 1), fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\n\r \0'))
        .map(([i, c]) => GENUINE.slice(0, i) + c + GENUINE.slice(i + 1)),
    // truncations, extensions and whitespace padding of the genuine signature
    fc.nat(GENUINE.length).map(n => GENUINE.slice(0, n)),
    fc.string({ maxLength: 8 }).map(x => GENUINE + x),
    fc.string({ maxLength: 8 }).map(x => x + GENUINE),
    fc.constantFrom('', '\n', ' ', GENUINE + GENUINE, GENUINE.toLowerCase(), GENUINE.replace(/\+/g, '-').replace(/\//g, '_'), GENUINE.replace(/=+$/, '')),
    // a well-formed (canonical base64, 64 bytes) signature that no one signed
    fc.uint8Array({ minLength: 64, maxLength: 64 }).map(b => Buffer.from(b).toString('base64')),
);

describe('update-manifest signature — nothing but the genuine signature is ever accepted', () => {
    it('arbitrary .sig bodies: accept:true only for the genuine signature (required and grace, with the real key)', () => {
        fc.assert(fc.property(sigBodies, fc.boolean(), (body, required) => {
            const d = decideManifest(input({ signatureText: body, required }));
            if (isGenuineBody(body)) {
                expect(d).toEqual({ accept: true, outcome: 'verified', keyIndex: 0 });
            } else {
                // present-but-wrong is rejected in EVERY mode — grace is for a missing .sig only
                expect(d.accept, `accepted ${JSON.stringify(body.slice(0, 40))}`).toBe(false);
                expect(['malformed', 'invalid']).toContain(d.outcome);
            }
        }), { numRuns: RUNS });
    });

    it('with a key list that has no usable key, only a well-formed signature can be accepted (grace), never a malformed one', () => {
        fc.assert(fc.property(sigBodies, fc.array(fc.string({ maxLength: 60 }), { maxLength: 4 }), (body, junkKeys) => {
            // junk entries that happen to be valid public keys would make this a different test
            fc.pre(junkKeys.every(k => publicKeyFromBase64(k) === null));
            const required = decideManifest(input({ signatureText: body, publicKeys: junkKeys, required: true }));
            expect(required.accept).toBe(false); // required + nothing to verify with: never accept
            const grace = decideManifest(input({ signatureText: body, publicKeys: junkKeys, required: false }));
            if (grace.accept) {
                expect(grace.outcome).toBe('unverifiable-grace');
                expect(parseManifestSignature(body)).not.toBeNull();
            }
        }), { numRuns: RUNS });
    });

    it('arbitrary manifest bytes: the genuine signature verifies only the manifest it was made for', () => {
        fc.assert(fc.property(fc.uint8Array({ maxLength: 400 }), (bytes) => {
            const d = decideManifest(input({ manifestBytes: bytes }));
            expect(d.accept).toBe(Buffer.compare(Buffer.from(bytes), MANIFEST) === 0);
        }), { numRuns: RUNS });
    });

    it('single-byte edits of the real manifest are rejected', () => {
        fc.assert(fc.property(fc.nat(MANIFEST.length - 1), fc.nat(255), (at, to) => {
            fc.pre(MANIFEST[at] !== to);
            const edited = Buffer.from(MANIFEST);
            edited[at] = to;
            expect(decideManifest(input({ manifestBytes: edited })).accept).toBe(false);
        }), { numRuns: RUNS });
    });

    it('arbitrary file names: the genuine signature is bound to latest-linux.yml', () => {
        const names = fc.oneof(
            fc.string({ maxLength: 40 }),
            fc.constantFrom('latest.yml', 'latest-mac.yml', 'latest-linux-arm64.yml', 'staging-linux.yml', 'staging.yml', 'latest-linux.yml ', ' latest-linux.yml', 'LATEST-LINUX.YML', '../latest-linux.yml', 'latest-linux.yml/', 'latest-linux.yml\n', 'x/latest-linux.yml'),
            fc.tuple(fc.constantFrom('latest', 'staging'), fc.constantFrom('', '-mac', '-linux', '-linux-arm64'), fc.string({ maxLength: 4 })).map(([a, b, c]) => `${a}${b}${c}.yml`),
        );
        fc.assert(fc.property(names, (fileName) => {
            const d = decideManifest(input({ fileName }));
            // a name that is not a manifest of a known channel is refused outright; any other
            // name than the signed one fails verification
            expect(d.accept).toBe(fileName === FILE);
            if (manifestChannelOf(fileName) === null) expect(d).toEqual({ accept: false, outcome: 'unexpected-file' });
        }), { numRuns: RUNS });
    });

    it('a signature by any other key never verifies, whatever else is on the key list', () => {
        fc.assert(fc.property(fc.array(fc.string({ maxLength: 60 }), { maxLength: 3 }), fc.uint8Array({ maxLength: 120 }), (junk, bytes) => {
            const other = keypair();
            const sig = crypto.sign(null, manifestSignedMessage('latest', FILE, bytes), other.privateKey).toString('base64');
            const d = decideManifest(input({ manifestBytes: bytes, signatureText: sig, publicKeys: [...junk, KEY.pub] }));
            expect(d).toEqual({ accept: false, outcome: 'invalid' });
        }), { numRuns: 60 });
    });
});

describe('update-manifest signature — parsers and the decision never throw', () => {
    it('parseManifestSignature: null, or exactly the canonical 64-byte signature the text encodes', () => {
        fc.assert(fc.property(sigBodies, (body) => {
            const sig = parseManifestSignature(body);
            if (sig !== null) {
                expect(sig.length).toBe(64);
                expect(body.replace(/\r?\n$/, '')).toBe(sig.toString('base64'));
            }
        }), { numRuns: RUNS });
    });

    it('parseManifestSignature and publicKeyFromBase64 survive non-string input', () => {
        fc.assert(fc.property(fc.anything(), (v) => {
            expect(() => parseManifestSignature(v as string)).not.toThrow();
            expect(() => publicKeyFromBase64(v as string)).not.toThrow();
            if (typeof v !== 'string') {
                expect(parseManifestSignature(v as string)).toBeNull();
                expect(publicKeyFromBase64(v as string)).toBeNull();
            }
        }), { numRuns: RUNS });
    });

    it('publicKeyFromBase64: null, or a usable Ed25519 key for exactly the canonical 32-byte encoding', () => {
        fc.assert(fc.property(fc.oneof(fc.string({ maxLength: 60 }), fc.base64String({ maxLength: 60 }), fc.uint8Array({ minLength: 32, maxLength: 32 }).map(b => Buffer.from(b).toString('base64'))), (s) => {
            const k = publicKeyFromBase64(s);
            if (k !== null) {
                expect(k.asymmetricKeyType).toBe('ed25519');
                expect(Buffer.from(k.export({ format: 'jwk' }).x as string, 'base64url').toString('base64')).toBe(s);
            }
        }), { numRuns: RUNS });
    });

    it('decideManifest never throws, and every rejection carries a known outcome', () => {
        const outcomes = new Set(['missing', 'malformed', 'invalid', 'no-keys', 'unexpected-file']);
        fc.assert(fc.property(
            fc.string({ maxLength: 40 }),
            fc.uint8Array({ maxLength: 100 }),
            fc.option(sigBodies, { nil: null }),
            fc.array(fc.oneof(fc.string({ maxLength: 60 }), fc.constant(KEY.pub)), { maxLength: 4 }),
            fc.boolean(),
            (fileName, manifestBytes, signatureText, publicKeys, required) => {
                const d = decideManifest({ fileName, manifestBytes, signatureText, publicKeys, required });
                if (!d.accept) expect(outcomes.has(d.outcome)).toBe(true);
                if (d.accept && d.outcome === 'verified') {
                    // only reachable with the genuine signature of the genuine bytes for the genuine file
                    expect(fileName).toBe(FILE);
                    expect(Buffer.compare(Buffer.from(manifestBytes), MANIFEST)).toBe(0);
                    expect(isGenuineBody(signatureText as string)).toBe(true);
                    expect(publicKeys[d.keyIndex]).toBe(KEY.pub);
                }
                if (d.accept && d.outcome === 'unsigned-grace') {
                    expect(signatureText).toBeNull();
                    expect(required).toBe(false);
                }
            },
        ), { numRuns: RUNS });
    });
});

describe('update-manifest signature — a genuine signature always round-trips', () => {
    it('any manifest bytes, any known manifest name, the key at any list position (with or without trailing newline)', () => {
        const names = fc.constantFrom('latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml', 'staging.yml', 'staging-mac.yml', 'staging-linux.yml');
        fc.assert(fc.property(
            fc.uint8Array({ maxLength: 500 }), names, fc.nat(3), fc.constantFrom('', '\n', '\r\n'), fc.boolean(),
            (bytes, fileName, position, eol, required) => {
                const k = keypair();
                const channel = manifestChannelOf(fileName)!;
                const sig = crypto.sign(null, manifestSignedMessage(channel, fileName, bytes), k.privateKey).toString('base64');
                const keys: string[] = [];
                for (let i = 0; i < position; i++) keys.push(keypair().pub);
                keys.push(k.pub);
                const d = decideManifest({ fileName, manifestBytes: bytes, signatureText: sig + eol, publicKeys: keys, required });
                expect(d).toEqual({ accept: true, outcome: 'verified', keyIndex: position });
            },
        ), { numRuns: 60 });
    });
});
