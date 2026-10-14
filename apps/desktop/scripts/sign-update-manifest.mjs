#!/usr/bin/env node
/**
 * sign-update-manifest.mjs — detached Ed25519 signatures for update manifests.
 * Wire format and WHY: electron/update-manifest-signature.ts (the verifier in
 * the app) and electron/update-manifest-keys.ts (keys + rollout order).
 * Node's built-in crypto only; no dependencies, so it runs before or after
 * `npm ci` on any runner.
 *
 *   sign   --channel <latest|staging> --manifest <path/to/latest-linux.yml> [--required]
 *          Private key from env UPDATE_MANIFEST_SIGNING_KEY. Writes <manifest>.sig.
 *          Missing key: exit 1 when --required (or MANIFEST_SIG_REQUIRED=true),
 *          otherwise a ::warning:: and exit 0 (grace).
 *          Refuses a key whose public half is not in the app's allowlist for the
 *          channel (unless that list is still empty) — clients would reject it.
 *   verify --channel <ch> --manifest <file> [--sig <file>] [--file-name <name>] [--public-key <b64>]
 *          Exit 0 only if the signature verifies with the allowlist (or --public-key).
 *   pubkey Print the base64 raw public key of UPDATE_MANIFEST_SIGNING_KEY (to paste
 *          into electron/update-manifest-keys.ts). Never prints the private key.
 *   keys   --channel <ch>  Print the allowlisted public keys, one per line.
 *
 * Accepted private-key forms (env UPDATE_MANIFEST_SIGNING_KEY): base64 PKCS#8 DER
 * (what the owner's setup one-liner prints), a PEM PKCS#8 block, or a raw 32-byte
 * seed as base64 or 64 hex characters.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOMAIN = 'cipherline-update-manifest:v1';
const FILE_RE = /^(latest|staging)(?:-mac|-linux(?:-[a-z0-9]{1,16})?)?\.yml$/;
const HERE = dirname(fileURLToPath(import.meta.url));
const KEYS_FILE = join(HERE, '..', 'electron', 'update-manifest-keys.ts');

export function channelOf(fileName) {
    const m = FILE_RE.exec(fileName);
    return m ? m[1] : null;
}

export function signedMessage(channel, fileName, bytes) {
    if (channelOf(fileName) !== channel) throw new Error(`"${fileName}" is not a ${channel} update manifest`);
    const digest = createHash('sha256').update(bytes).digest('hex');
    return Buffer.from(`${DOMAIN}:${channel}:${fileName}:${digest}`, 'utf8');
}

/** Allowlisted keys per channel, read from the app's own source. */
export function allowlistedKeys(channel, source = readFileSync(KEYS_FILE, 'utf8')) {
    const start = source.indexOf('UPDATE_MANIFEST_PUBLIC_KEYS');
    if (start < 0) throw new Error('UPDATE_MANIFEST_PUBLIC_KEYS not found in update-manifest-keys.ts');
    const body = source.slice(start).replace(/\/\/[^\n]*/g, '');
    const m = new RegExp(`\\b${channel}:\\s*\\[([^\\]]*)\\]`).exec(body);
    if (!m) throw new Error(`no ${channel} key list in update-manifest-keys.ts`);
    return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function publicKeyFromRaw(b64) {
    const raw = Buffer.from(b64, 'base64');
    if (raw.length !== 32 || raw.toString('base64') !== b64) throw new Error('public key must be 32 raw bytes, standard base64');
    return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function rawPublicKeyB64(keyObject) {
    const pub = keyObject.type === 'private' ? createPublicKey(keyObject) : keyObject;
    return pub.export({ format: 'der', type: 'spki' }).subarray(SPKI_ED25519_PREFIX.length).toString('base64');
}

export function parsePrivateKey(text) {
    const t = String(text ?? '').trim();
    if (!t) return null;
    let key;
    if (t.startsWith('-----BEGIN')) key = createPrivateKey({ key: t, format: 'pem' });
    else if (/^[0-9a-fA-F]{64}$/.test(t)) key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(t, 'hex')]), format: 'der', type: 'pkcs8' });
    else {
        const der = Buffer.from(t, 'base64');
        key = der.length === 32
            ? createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, der]), format: 'der', type: 'pkcs8' })
            : createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    }
    if (key.asymmetricKeyType !== 'ed25519') throw new Error(`signing key is ${key.asymmetricKeyType}, expected ed25519`);
    return key;
}

export function verifySignature({ channel, fileName, bytes, sigText, publicKeys }) {
    const t = String(sigText).replace(/\r?\n$/, '');
    if (!/^[A-Za-z0-9+/]{86}==$/.test(t)) return { ok: false, reason: 'malformed' };
    const sig = Buffer.from(t, 'base64');
    const msg = signedMessage(channel, fileName, bytes);
    for (let i = 0; i < publicKeys.length; i++) {
        if (verify(null, msg, publicKeyFromRaw(publicKeys[i]), sig)) return { ok: true, keyIndex: i };
    }
    return { ok: false, reason: publicKeys.length ? 'invalid' : 'no-keys' };
}

function args(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--required') out.required = true;
        else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
        else out._.push(a);
    }
    return out;
}

function fail(msg) {
    console.error(`::error::${msg}`);
    process.exit(1);
}

function main() {
    const a = args(process.argv.slice(2));
    const cmd = a._[0];
    if (cmd === 'pubkey') {
        const key = parsePrivateKey(process.env.UPDATE_MANIFEST_SIGNING_KEY);
        if (!key) fail('UPDATE_MANIFEST_SIGNING_KEY is empty');
        console.log(rawPublicKeyB64(key));
        return;
    }
    const channel = a.channel;
    if (channel !== 'latest' && channel !== 'staging') fail('--channel must be latest or staging');
    if (cmd === 'keys') {
        for (const k of allowlistedKeys(channel)) console.log(k);
        return;
    }
    if (!a.manifest || !existsSync(a.manifest)) fail(`manifest not found: ${a.manifest}`);
    const fileName = a['file-name'] ?? basename(a.manifest);
    if (channelOf(fileName) !== channel) fail(`${fileName} is not a ${channel} manifest`);
    const bytes = readFileSync(a.manifest);
    if (bytes.length === 0) fail(`${fileName} is empty`);

    if (cmd === 'verify') {
        const sigPath = a.sig ?? `${a.manifest}.sig`;
        if (!existsSync(sigPath)) fail(`signature not found: ${sigPath}`);
        const keys = a['public-key'] ? [a['public-key']] : allowlistedKeys(channel);
        const r = verifySignature({ channel, fileName, bytes, sigText: readFileSync(sigPath, 'utf8'), publicKeys: keys });
        if (!r.ok) fail(`${fileName}: signature ${r.reason}`);
        console.log(`${fileName}: signature OK (key ${r.keyIndex}: ${keys[r.keyIndex]})`);
        return;
    }
    if (cmd !== 'sign') fail(`unknown command "${cmd ?? ''}" (sign | verify | pubkey | keys)`);

    const required = a.required === true || process.env.MANIFEST_SIG_REQUIRED === 'true';
    const keyText = process.env.UPDATE_MANIFEST_SIGNING_KEY;
    if (!keyText || !keyText.trim()) {
        if (required) fail(`UPDATE_MANIFEST_SIGNING_KEY is not set: refusing to publish an unsigned ${channel} manifest`);
        console.log(`::warning::UPDATE_MANIFEST_SIGNING_KEY is not set: ${fileName} is published WITHOUT a signature (staging grace)`);
        return;
    }
    let key;
    try { key = parsePrivateKey(keyText); } catch (e) { fail(`UPDATE_MANIFEST_SIGNING_KEY is not a usable Ed25519 private key (${e.message})`); }
    const pub = rawPublicKeyB64(key);
    const allow = allowlistedKeys(channel);
    if (allow.length > 0 && !allow.includes(pub)) {
        fail(`the ${channel} signing key (public ${pub}) is not in electron/update-manifest-keys.ts; clients would reject this release`);
    }
    if (allow.length === 0) console.log(`::warning::no ${channel} public key is embedded in the app yet; clients cannot check this signature until one is (public ${pub})`);
    const msg = signedMessage(channel, fileName, bytes);
    const sig = sign(null, msg, key);
    if (!verify(null, msg, publicKeyFromRaw(pub), sig)) fail('self-check of the fresh signature failed');
    writeFileSync(`${a.manifest}.sig`, `${sig.toString('base64')}\n`);
    console.log(`Signed ${fileName} (${channel}) with public key ${pub} -> ${basename(a.manifest)}.sig`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
