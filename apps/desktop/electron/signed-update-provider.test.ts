import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { withManifestSignatureCheck, signatureUrlFor, describeManifestReport, type ManifestCheckReport, type GenericProviderCtor } from './signed-update-provider';
import { manifestSignedMessage } from './update-manifest-signature';
import { DETAIL_RE, LABEL_RE } from './freeze-monitor';
import type { ManifestChannel } from './update-manifest-keys';

/**
 * End to end through the REAL electron-updater (its AppImageUpdater and
 * DebUpdater, GenericProvider, HTTP executor, sha512 download check) against a
 * local HTTP feed — only the transport is swapped (electron.net → node http)
 * and the app adapter is a stub. What it proves:
 *
 *   • a signed manifest is accepted and its AppImage downloads and verifies;
 *   • a TAMPERED manifest is rejected at CHECK time: no update-available, the
 *     artifact is never even requested — and the NEGATIVE CONTROL: the very
 *     same tampered feed sails through electron-updater's stock provider (the
 *     pre-change code path), attacker artifact downloaded and "verified";
 *   • the sha512 in the signed manifest is what protects the AppImage / .deb
 *     bytes: a swapped artifact behind a genuine manifest fails the download;
 *   • missing .sig under required vs grace; a staging manifest replayed as
 *     stable; a mid-publish mismatched pair recovers on the one re-fetch;
 *   • electron-updater's `channel` setter really does turn allowDowngrade back
 *     on (why main.ts re-pins it after every channel switch), and with it
 *     pinned off a validly signed OLDER manifest is not installed.
 */

const require_ = createRequire(path.join(__dirname, '..', 'package.json'));
type Any = any;
const EU = require_('electron-updater') as Any;
const { GenericProvider } = require_('electron-updater/out/providers/GenericProvider') as { GenericProvider: GenericProviderCtor };
const { ElectronHttpExecutor } = require_('electron-updater/out/electronHttpExecutor') as Any;

/** electron-updater's executor with electron.net swapped for node http (redirects are not used here). */
class NodeHttpExecutor extends ElectronHttpExecutor {
    createRequest(options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) {
        return http.request(options, callback);
    }
}

const STABLE = crypto.generateKeyPairSync('ed25519');
const STAGING = crypto.generateKeyPairSync('ed25519');
const rawPub = (k: crypto.KeyObject) => Buffer.from(k.export({ format: 'jwk' }).x as string, 'base64url').toString('base64');
const KEYS: Record<ManifestChannel, string[]> = { latest: [rawPub(STABLE.publicKey)], staging: [rawPub(STAGING.publicKey)] };

let dir: string;
let server: http.Server;
let base: string;
const requests: string[] = [];
/** path -> a response served INSTEAD of the file; `once` = only for the next request of that path. */
const overrides = new Map<string, { status: number; body?: Buffer; once?: boolean }>();

/** The manifest name electron-updater asks for on THIS machine (latest-linux.yml on x64 Linux). */
function manifestName(channel: ManifestChannel): string {
    const p = new GenericProvider({ provider: 'generic', url: 'http://x/' }, { channel }, { platform: process.platform, executor: null });
    return `${p.channel}.yml`;
}

function sha512(b: Buffer) { return crypto.createHash('sha512').update(b).digest('base64'); }

function manifestFor(version: string, files: { name: string; bytes: Buffer }[]): Buffer {
    const lines = [`version: ${version}`, 'files:'];
    for (const f of files) lines.push(`  - url: ${f.name}`, `    sha512: ${sha512(f.bytes)}`, `    size: ${f.bytes.length}`);
    lines.push(`path: ${files[0].name}`, `sha512: ${sha512(files[0].bytes)}`, "releaseDate: '2026-10-12T00:00:00.000Z'");
    return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

function sigFor(channel: ManifestChannel, fileName: string, bytes: Buffer, key: crypto.KeyObject): Buffer {
    return Buffer.from(crypto.sign(null, manifestSignedMessage(channel, fileName, bytes), key).toString('base64') + '\n');
}

function publish(name: string, body: Buffer) { fs.writeFileSync(path.join(dir, name), body); }
function unpublish(name: string) { fs.rmSync(path.join(dir, name), { force: true }); }

const GENUINE_APPIMAGE = Buffer.from('genuine Cipherline 2.0.0 AppImage bytes');
const EVIL_APPIMAGE = Buffer.from('attacker payload pretending to be an AppImage');
const GENUINE_DEB = Buffer.from('genuine cipherline_2.0.0_amd64.deb bytes');

/** Publish a genuine, signed 2.0.0 release on `channel`. */
function publishSignedRelease(channel: ManifestChannel = 'latest', key = STABLE.privateKey) {
    publish('Cipherline-2.0.0.AppImage', GENUINE_APPIMAGE);
    publish('cipherline_2.0.0_amd64.deb', GENUINE_DEB);
    const name = manifestName(channel);
    const m = manifestFor('2.0.0', [{ name: 'Cipherline-2.0.0.AppImage', bytes: GENUINE_APPIMAGE }, { name: 'cipherline_2.0.0_amd64.deb', bytes: GENUINE_DEB }]);
    publish(name, m);
    publish(`${name}.sig`, sigFor(channel, name, m, key));
    return { name, manifest: m };
}

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-signed-feed-'));
    server = http.createServer((req, res) => {
        const p = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).replace(/^\/+/, '');
        requests.push(p);
        const o = overrides.get(p);
        if (o) {
            if (o.once) overrides.delete(p);
            res.writeHead(o.status); res.end(o.body ?? ''); return;
        }
        const f = path.join(dir, path.basename(p));
        if (fs.existsSync(f)) { res.writeHead(200); res.end(fs.readFileSync(f)); } else { res.writeHead(404); res.end('<Error>NoSuchKey</Error>'); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});

afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
});

let work: string;
const savedAppImage = process.env.APPIMAGE;
beforeEach(() => {
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    requests.length = 0;
    overrides.clear();
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-updater-'));
    process.env.APPIMAGE = path.join(work, 'Cipherline-old.AppImage');
    fs.writeFileSync(process.env.APPIMAGE, 'old');
});
afterEach(() => {
    if (savedAppImage === undefined) delete process.env.APPIMAGE; else process.env.APPIMAGE = savedAppImage;
    fs.rmSync(work, { recursive: true, force: true });
});

interface Harness { updater: Any; reports: ManifestCheckReport[]; available: string[] }

function makeUpdater(opts: { kind?: 'AppImageUpdater' | 'DebUpdater'; channel?: ManifestChannel; signed?: boolean; required?: boolean; version?: string } = {}): Harness {
    fs.writeFileSync(path.join(work, 'app-update.yml'), 'provider: generic\nurl: http://unused/\nupdaterCacheDirName: cl-test-updater\n');
    const app = {
        version: opts.version ?? '1.0.0', name: 'cl-test', isPackaged: true,
        appUpdateConfigPath: path.join(work, 'app-update.yml'), userDataPath: work, baseCachePath: path.join(work, 'cache'),
        whenReady: () => Promise.resolve(), relaunch() {}, quit() {}, onQuit() {},
    };
    const updater = new EU[opts.kind ?? 'AppImageUpdater'](null, app);
    updater.httpExecutor = new NodeHttpExecutor();
    updater.logger = null;
    updater.autoDownload = false;
    updater.channel = opts.channel ?? 'latest';
    updater.allowDowngrade = false; // as main.ts pins it
    updater.disableDifferentialDownload = true; // as main.ts sets it
    const reports: ManifestCheckReport[] = [];
    const available: string[] = [];
    updater.on('update-available', (i: { version: string }) => available.push(i.version));
    updater.on('error', () => { /* asserted through the rejected promise */ });
    if (opts.signed === false) {
        updater.setFeedURL({ provider: 'generic', url: base }); // the stock, pre-change provider
    } else {
        const Signed = withManifestSignatureCheck(GenericProvider, {
            keysFor: (ch) => KEYS[ch],
            requiredFor: () => opts.required ?? true,
            report: (r) => reports.push(r),
            mismatchRetryDelayMs: 10,
        });
        updater.setFeedURL({ provider: 'custom', updateProvider: Signed, url: base });
    }
    return { updater, reports, available };
}

async function checkRejects(h: Harness) {
    let err: Any = null;
    await h.updater.checkForUpdates().catch((e: unknown) => { err = e; });
    return err;
}

describe('signed manifests through the real electron-updater', () => {
    it('a signed manifest is accepted; the AppImage downloads and passes the sha512 check', async () => {
        const { name } = publishSignedRelease();
        const h = makeUpdater();
        const r = await h.updater.checkForUpdates();
        expect(r.isUpdateAvailable).toBe(true);
        expect(h.available).toEqual(['2.0.0']);
        expect(h.reports.map((x) => x.decision)).toEqual([{ accept: true, outcome: 'verified', keyIndex: 0 }]);
        expect(requests.slice(0, 2).map((p) => p)).toEqual([name, `${name}.sig`]);
        const files: string[] = await h.updater.downloadUpdate();
        expect(fs.readFileSync(files[0])).toEqual(GENUINE_APPIMAGE);
    });

    it('a TAMPERED manifest is rejected at check time: no update-available, the artifact is never requested', async () => {
        const { name, manifest } = publishSignedRelease();
        publish('evil.AppImage', EVIL_APPIMAGE);
        const tampered = Buffer.from(manifest.toString('utf8')
            .replaceAll('Cipherline-2.0.0.AppImage', 'evil.AppImage')
            .replaceAll(sha512(GENUINE_APPIMAGE), sha512(EVIL_APPIMAGE))
            .replace(`size: ${GENUINE_APPIMAGE.length}`, `size: ${EVIL_APPIMAGE.length}`), 'utf8');
        publish(name, tampered); // the .sig still signs the genuine manifest
        const h = makeUpdater();
        const err = await checkRejects(h);
        expect(err?.code).toBe('ERR_UPDATER_MANIFEST_SIGNATURE');
        expect(h.available).toEqual([]);
        expect(requests).not.toContain('evil.AppImage');
        expect(h.reports.at(-1)).toMatchObject({ decision: { accept: false, outcome: 'invalid' }, attempts: 2 });
        await expect(h.updater.downloadUpdate()).rejects.toThrow(/check update first/i);
    });

    it('NEGATIVE CONTROL: the same tampered feed is ACCEPTED by the stock provider (the code before this change)', async () => {
        const { name, manifest } = publishSignedRelease();
        publish('evil.AppImage', EVIL_APPIMAGE);
        publish(name, Buffer.from(manifest.toString('utf8')
            .replaceAll('Cipherline-2.0.0.AppImage', 'evil.AppImage')
            .replaceAll(sha512(GENUINE_APPIMAGE), sha512(EVIL_APPIMAGE))
            .replace(`size: ${GENUINE_APPIMAGE.length}`, `size: ${EVIL_APPIMAGE.length}`), 'utf8'));
        const h = makeUpdater({ signed: false });
        const r = await h.updater.checkForUpdates();
        expect(r.isUpdateAvailable).toBe(true);
        const files: string[] = await h.updater.downloadUpdate();
        // sha512 "passes": it is checked against the attacker's own manifest
        expect(fs.readFileSync(files[0])).toEqual(EVIL_APPIMAGE);
    });

    it('the signed sha512 protects the AppImage bytes: a swapped artifact behind a genuine manifest fails the download', async () => {
        publishSignedRelease();
        publish('Cipherline-2.0.0.AppImage', EVIL_APPIMAGE);
        const h = makeUpdater();
        expect((await h.updater.checkForUpdates()).isUpdateAvailable).toBe(true);
        await expect(h.updater.downloadUpdate()).rejects.toMatchObject({ code: 'ERR_CHECKSUM_MISMATCH' });
    });

    it('…and the .deb bytes (DebUpdater, which installs with pkexec dpkg -i) the same way', async () => {
        publishSignedRelease();
        const ok = makeUpdater({ kind: 'DebUpdater' });
        expect((await ok.updater.checkForUpdates()).isUpdateAvailable).toBe(true);
        const files: string[] = await ok.updater.downloadUpdate();
        expect(path.basename(files[0])).toBe('cipherline_2.0.0_amd64.deb');
        expect(fs.readFileSync(files[0])).toEqual(GENUINE_DEB);

        fs.rmSync(path.join(work, 'cache'), { recursive: true, force: true });
        publish('cipherline_2.0.0_amd64.deb', Buffer.from('tampered deb'));
        const bad = makeUpdater({ kind: 'DebUpdater' });
        expect((await bad.updater.checkForUpdates()).isUpdateAvailable).toBe(true);
        await expect(bad.updater.downloadUpdate()).rejects.toMatchObject({ code: 'ERR_CHECKSUM_MISMATCH' });
    });

    it('missing .sig: rejected when required, accepted in grace (and reported as unsigned)', async () => {
        const { name } = publishSignedRelease();
        unpublish(`${name}.sig`);
        const req = makeUpdater({ required: true });
        expect((await checkRejects(req))?.code).toBe('ERR_UPDATER_MANIFEST_SIGNATURE');
        expect(req.reports.at(-1)?.decision).toEqual({ accept: false, outcome: 'missing' });

        const grace = makeUpdater({ required: false });
        expect((await grace.updater.checkForUpdates()).isUpdateAvailable).toBe(true);
        expect(grace.reports.at(-1)?.decision).toEqual({ accept: true, outcome: 'unsigned-grace' });
    });

    it('a server error on the .sig is a normal (retried) update error, not a verification verdict', async () => {
        const { name } = publishSignedRelease();
        overrides.set(`${name}.sig`, { status: 500, body: Buffer.from('boom') });
        const h = makeUpdater();
        const err = await checkRejects(h);
        expect(err).toBeTruthy();
        expect(err?.code).not.toBe('ERR_UPDATER_MANIFEST_SIGNATURE');
        expect(h.reports).toEqual([]);
        expect(h.available).toEqual([]);
    });

    it('an EMPTY .sig (200, no body) is malformed, not missing — rejected even in grace', async () => {
        const { name } = publishSignedRelease();
        overrides.set(`${name}.sig`, { status: 200 });
        const h = makeUpdater({ required: false });
        expect((await checkRejects(h))?.code).toBe('ERR_UPDATER_MANIFEST_SIGNATURE');
        expect(h.reports.at(-1)?.decision).toEqual({ accept: false, outcome: 'malformed' });
    });
});

describe('channel binding, races and downgrades', () => {
    it('a genuine STAGING manifest + its valid staging signature served as the stable manifest is rejected', async () => {
        const stagingName = manifestName('staging');
        const { manifest } = publishSignedRelease('staging', STAGING.privateKey);
        const stableName = manifestName('latest');
        publish(stableName, manifest);
        publish(`${stableName}.sig`, fs.readFileSync(path.join(dir, `${stagingName}.sig`)));
        const h = makeUpdater({ channel: 'latest' });
        expect((await checkRejects(h))?.code).toBe('ERR_UPDATER_MANIFEST_SIGNATURE');
        // while a staging client accepts it
        const s = makeUpdater({ channel: 'staging' });
        expect((await s.updater.checkForUpdates()).isUpdateAvailable).toBe(true);
    });

    it('a check that lands between the .sig and manifest uploads recovers on the one re-fetch', async () => {
        const { name } = publishSignedRelease();
        // the first .sig request sees the PREVIOUS release's signature; the upload then completes
        overrides.set(`${name}.sig`, { status: 200, once: true, body: sigFor('latest', name, Buffer.from('previous manifest'), STABLE.privateKey) });
        const h = makeUpdater();
        const r = await h.updater.checkForUpdates();
        expect(r.isUpdateAvailable).toBe(true);
        expect(h.reports.at(-1)).toMatchObject({ decision: { accept: true, outcome: 'verified' }, attempts: 2 });
        expect(requests.filter((x) => x === `${name}.sig`)).toHaveLength(2);
    });

    it("electron-updater's channel setter turns allowDowngrade ON — main.ts must re-pin it", () => {
        const h = makeUpdater();
        expect(h.updater.allowDowngrade).toBe(false);
        h.updater.channel = 'staging';
        expect(h.updater.allowDowngrade).toBe(true);
    });

    it('with allowDowngrade pinned off, a validly signed OLDER release is not offered', async () => {
        publishSignedRelease(); // 2.0.0, signed
        const h = makeUpdater({ version: '3.0.0' });
        const r = await h.updater.checkForUpdates();
        expect(r.isUpdateAvailable).toBe(false);
        expect(h.available).toEqual([]);
        // the control: with the flag on (what the setter leaves behind) the old release IS offered
        const loose = makeUpdater({ version: '3.0.0' });
        loose.updater.allowDowngrade = true;
        expect((await loose.updater.checkForUpdates()).isUpdateAvailable).toBe(true);
    });

    it('a URL that is not the manifest the provider asked for is refused', async () => {
        const Signed = withManifestSignatureCheck(GenericProvider, { keysFor: (ch) => KEYS[ch], requiredFor: () => false, report: () => {} });
        const p = new Signed({ provider: 'generic', url: base }, { channel: 'latest', isAddNoCacheQuery: false }, { platform: process.platform, executor: new NodeHttpExecutor() });
        await expect(p.httpRequest(new URL(`${base}staging-linux.yml`))).rejects.toMatchObject({ code: 'ERR_UPDATER_MANIFEST_SIGNATURE', outcome: 'unexpected-file' });
    });
});

describe('helpers', () => {
    it('the .sig URL keeps origin and the no-cache query', () => {
        expect(signatureUrlFor(new URL('https://updates.cipherline.chat/latest-linux.yml?noCache=1abc')).href)
            .toBe('https://updates.cipherline.chat/latest-linux.yml.sig?noCache=1abc');
    });

    it('report lines pass the freeze-monitor label/detail patterns (always recorded)', () => {
        const rs: ManifestCheckReport[] = [
            { channel: 'latest', fileName: 'latest-linux.yml', required: true, decision: { accept: true, outcome: 'verified', keyIndex: 1 }, attempts: 1 },
            { channel: 'staging', fileName: 'staging.yml', required: false, decision: { accept: true, outcome: 'unsigned-grace' }, attempts: 1 },
            { channel: null, fileName: '../<x>.yml', required: true, decision: { accept: false, outcome: 'unexpected-file' }, attempts: 1 },
        ];
        for (const r of rs) {
            const { event, detail } = describeManifestReport(r);
            expect(event).toMatch(LABEL_RE);
            expect(detail).toMatch(DETAIL_RE);
        }
    });
});
