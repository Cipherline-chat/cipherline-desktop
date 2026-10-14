import { beforeAll, afterAll, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { decideManifest } from './update-manifest-signature';

/**
 * The CI signer (scripts/sign-update-manifest.mjs) run exactly as the release
 * workflows run it — a separate `node` process, key in the environment — and
 * its output checked with the APP's verifier, so the two cannot drift apart.
 * Also pins the workflow wiring (both workflows sign every manifest they
 * publish, upload the .sig before the manifest, and never put the key in a
 * job-wide env). Keys are generated per run.
 */

const DESKTOP = path.resolve(__dirname, '..');
const SCRIPT = path.join(DESKTOP, 'scripts', 'sign-update-manifest.mjs');

function keypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        pkcs8b64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
        privateKey,
        pub: Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64'),
    };
}

/** The real update-manifest-keys.ts with BOTH key lists emptied. The production
 *  file now embeds real keys, and the script (correctly) refuses any key the app
 *  doesn't embed, so the form/verify tests run a copy of the script against an
 *  emptied list: the "app embeds no key yet" mode, where any key may sign. */
const REAL_KEYS_SRC = fs.readFileSync(path.join(DESKTOP, 'electron', 'update-manifest-keys.ts'), 'utf8');
const withKeys = (latest: string[], staging: string[] = []) => REAL_KEYS_SRC
    .replace(/latest: \[[^\]]*\]/, `latest: [\n${latest.map(k => `        '${k}',\n`).join('')}    ]`)
    .replace(/staging: \[[^\]]*\]/, `staging: [\n${staging.map(k => `        '${k}',\n`).join('')}    ]`);
function scriptTree(keysSrc: string): string {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-signtree-'));
    fs.mkdirSync(path.join(tree, 'scripts'));
    fs.mkdirSync(path.join(tree, 'electron'));
    fs.copyFileSync(SCRIPT, path.join(tree, 'scripts', 'sign-update-manifest.mjs'));
    fs.writeFileSync(path.join(tree, 'electron', 'update-manifest-keys.ts'), keysSrc);
    return tree;
}
let emptyTree: string;
beforeAll(() => { emptyTree = scriptTree(withKeys([], [])); });
afterAll(() => fs.rmSync(emptyTree, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string | undefined> = {}) {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('UPDATE_MANIFEST') && k !== 'MANIFEST_SIG_REQUIRED') clean[k] = v;
    for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
    const r = spawnSync(process.execPath, [path.join(emptyTree, 'scripts', 'sign-update-manifest.mjs'), ...args], { env: clean, encoding: 'utf8', cwd: DESKTOP });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

let tmp: string;
let manifest: string;
const BYTES = Buffer.from("version: 2.0.0\nfiles:\n  - url: Cipherline-2.0.0.AppImage\n    sha512: AAAA\n    size: 3\npath: Cipherline-2.0.0.AppImage\nsha512: AAAA\nreleaseDate: '2026-10-12T00:00:00.000Z'\n");
beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-sign-'));
    manifest = path.join(tmp, 'latest-linux.yml');
    fs.writeFileSync(manifest, BYTES);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('scripts/sign-update-manifest.mjs', () => {
    it('produces a .sig the APP verifies with the matching public key, for every key form the secret may hold', () => {
        const k = keypair();
        const seed = k.privateKey.export({ format: 'jwk' }).d as string;
        const forms = [
            k.pkcs8b64,
            Buffer.from(seed, 'base64url').toString('base64'),
            Buffer.from(seed, 'base64url').toString('hex'),
            k.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        ];
        for (const form of forms) {
            const r = run(['sign', '--channel', 'latest', '--manifest', manifest, '--required'], { UPDATE_MANIFEST_SIGNING_KEY: form });
            expect(r.code, r.out).toBe(0);
            const sig = fs.readFileSync(`${manifest}.sig`, 'utf8');
            expect(sig).toMatch(/^[A-Za-z0-9+/]{86}==\n$/);
            expect(decideManifest({ fileName: 'latest-linux.yml', manifestBytes: BYTES, signatureText: sig, publicKeys: [k.pub], required: true }))
                .toEqual({ accept: true, outcome: 'verified', keyIndex: 0 });
            // and NOT with another key, nor after a byte changes, nor as the staging manifest
            expect(decideManifest({ fileName: 'latest-linux.yml', manifestBytes: BYTES, signatureText: sig, publicKeys: [keypair().pub], required: true }).accept).toBe(false);
            expect(decideManifest({ fileName: 'latest-linux.yml', manifestBytes: Buffer.concat([BYTES, Buffer.from(' ')]), signatureText: sig, publicKeys: [k.pub], required: true }).accept).toBe(false);
            expect(decideManifest({ fileName: 'staging-linux.yml', manifestBytes: BYTES, signatureText: sig, publicKeys: [k.pub], required: true }).accept).toBe(false);
        }
    });

    it('`verify` accepts its own signature and rejects a tampered manifest (exit codes)', () => {
        const k = keypair();
        expect(run(['sign', '--channel', 'latest', '--manifest', manifest], { UPDATE_MANIFEST_SIGNING_KEY: k.pkcs8b64 }).code).toBe(0);
        expect(run(['verify', '--channel', 'latest', '--manifest', manifest, '--public-key', k.pub]).code).toBe(0);
        fs.appendFileSync(manifest, '#');
        const bad = run(['verify', '--channel', 'latest', '--manifest', manifest, '--public-key', k.pub]);
        expect(bad.code).toBe(1);
        expect(bad.out).toContain('signature invalid');
    });

    it('`pubkey` prints the public half (and never the private key)', () => {
        const k = keypair();
        const r = run(['pubkey'], { UPDATE_MANIFEST_SIGNING_KEY: k.pkcs8b64 });
        expect(r.code).toBe(0);
        expect(r.out.trim()).toBe(k.pub);
        expect(r.out).not.toContain(k.pkcs8b64);
    });

    it('missing key: fails when required (stable), warns and writes nothing in grace (staging)', () => {
        const req = run(['sign', '--channel', 'latest', '--manifest', manifest, '--required']);
        expect(req.code).toBe(1);
        expect(req.out).toContain('::error::');
        const reqEnv = run(['sign', '--channel', 'latest', '--manifest', manifest], { MANIFEST_SIG_REQUIRED: 'true' });
        expect(reqEnv.code).toBe(1);
        const grace = run(['sign', '--channel', 'staging', '--manifest', path.join(tmp, 'staging-linux.yml')]);
        expect(grace.code).toBe(1); // that file does not exist: it never silently "signs" nothing
        fs.writeFileSync(path.join(tmp, 'staging-linux.yml'), BYTES);
        const ok = run(['sign', '--channel', 'staging', '--manifest', path.join(tmp, 'staging-linux.yml')]);
        expect(ok.code).toBe(0);
        expect(ok.out).toContain('::warning::');
        expect(fs.existsSync(path.join(tmp, 'staging-linux.yml.sig'))).toBe(false);
    });

    it('refuses a manifest of the other channel and a non-Ed25519 key', () => {
        const k = keypair();
        expect(run(['sign', '--channel', 'staging', '--manifest', manifest], { UPDATE_MANIFEST_SIGNING_KEY: k.pkcs8b64 }).code).toBe(1);
        const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
        expect(run(['sign', '--channel', 'latest', '--manifest', manifest], { UPDATE_MANIFEST_SIGNING_KEY: rsa }).code).toBe(1);
    });

    it('refuses to sign with a key the app does not embed, once the app embeds any', async () => {
        // @ts-expect-error — plain .mjs, no type declarations
        const script = await import('../scripts/sign-update-manifest.mjs');
        const embedded = keypair();
        const populated = withKeys([embedded.pub]);
        expect(script.allowlistedKeys('latest', populated)).toEqual([embedded.pub]);
        // the CLI path reads the real file; exercise the decision with a temp copy of the script tree
        const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-signtree-'));
        try {
            fs.mkdirSync(path.join(tree, 'scripts'));
            fs.mkdirSync(path.join(tree, 'electron'));
            fs.copyFileSync(SCRIPT, path.join(tree, 'scripts', 'sign-update-manifest.mjs'));
            fs.writeFileSync(path.join(tree, 'electron', 'update-manifest-keys.ts'), populated);
            const runIn = (key: string) => spawnSync(process.execPath, [path.join(tree, 'scripts', 'sign-update-manifest.mjs'), 'sign', '--channel', 'latest', '--manifest', manifest], {
                env: { PATH: process.env.PATH ?? '', UPDATE_MANIFEST_SIGNING_KEY: key }, encoding: 'utf8',
            });
            const wrong = runIn(keypair().pkcs8b64);
            expect(wrong.status).toBe(1);
            expect(wrong.stderr).toContain('is not in electron/update-manifest-keys.ts');
            expect(runIn(embedded.pkcs8b64).status).toBe(0);
            const v = spawnSync(process.execPath, [path.join(tree, 'scripts', 'sign-update-manifest.mjs'), 'verify', '--channel', 'latest', '--manifest', manifest], { encoding: 'utf8' });
            expect(v.status, v.stderr).toBe(0);
        } finally {
            fs.rmSync(tree, { recursive: true, force: true });
        }
    });
});

// ── Workflow wiring ──────────────────────────────────────────────────────────
// Private repo: .github/workflows/release-desktop.yml (staging) and the public
// workflow's template scripts/release/public/release-stable.yml. In the PUBLIC
// repo the latter lives at .github/workflows/release-stable.yml and the former
// does not exist — each check runs where its file exists.
const REPO = path.resolve(DESKTOP, '..', '..');
const PRIVATE_WF = path.join(REPO, '.github', 'workflows', 'release-desktop.yml');
const STABLE_WF = [path.join(REPO, 'scripts', 'release', 'public', 'release-stable.yml'), path.join(REPO, '.github', 'workflows', 'release-stable.yml')]
    .find((p) => fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes('name: Release Stable Desktop'));

describe('release workflows sign every manifest they publish', () => {
    it.skipIf(!STABLE_WF)('stable: all three manifests signed, key REQUIRED, step-scoped, .sig uploaded before the manifest', () => {
        const wf = fs.readFileSync(STABLE_WF!, 'utf8');
        for (const m of ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']) {
            expect(wf).toContain(`sign-update-manifest.mjs sign --required --channel latest --manifest apps/desktop/release/${m}`);
            expect(wf).toMatch(new RegExp(`apps/desktop/release/${m.replace('.', '\\.')}\\.sig apps/desktop/release/${m.replace('.', '\\.')}; do`));
        }
        expect(wf).not.toMatch(/^ {6}UPDATE_MANIFEST_SIGNING_KEY_STABLE:/m); // never in a job-level env block
        expect(wf.match(/UPDATE_MANIFEST_SIGNING_KEY: \$\{\{ secrets\.UPDATE_MANIFEST_SIGNING_KEY_STABLE \}\}/g)).toHaveLength(3);
        expect(wf).not.toContain('SIGNING_KEY_STAGING');
    });

    it.skipIf(!fs.existsSync(PRIVATE_WF))('staging: all three jobs sign, the stable path requires a key, stale .sig removed when unsigned', () => {
        const wf = fs.readFileSync(PRIVATE_WF, 'utf8');
        for (const suffix of ['', '-mac', '-linux']) {
            expect(wf).toContain(`sign-update-manifest.mjs sign --channel "$CHANNEL" --manifest "apps/desktop/release/\${CHANNEL}${suffix}.yml"`);
        }
        expect(wf.match(/apps\/desktop\/release\/\$MANIFEST\.sig \\\n\s+apps\/desktop\/release\/\$MANIFEST; do/g)).toHaveLength(3);
        expect(wf.match(/rm --force "cipherline\/cipherline-updates\/\$MANIFEST\.sig"/g)).toHaveLength(3);
        expect(wf).toMatch(/^env:\n {2}UPDATE_MANIFEST_SIG_STAGING_GRACE: '(true|false)'/m);
        expect(wf).toMatch(/export UPDATE_MANIFEST_SIGNING_KEY="\$KEY_STABLE"\n\s+export MANIFEST_SIG_REQUIRED=true/);
    });
});
