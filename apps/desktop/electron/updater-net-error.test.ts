import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { withManifestSignatureCheck, type GenericProviderCtor } from './signed-update-provider';
import { manifestSignedMessage } from './update-manifest-signature';
import { createHandledUpdateCheck } from './update-check';
import { captureUnhandledRejections, waitFor } from './test-unhandled-capture';
import { UpdateCheckScheduler } from './update-check-scheduler';
import { networkErrorCode, updaterErrorCode } from './net-error';
import { classifyUpdateError, onUpdateError, RETRY_DELAYS_MS } from './updater-state';
import type { ManifestChannel } from './update-manifest-keys';

/**
 * The 1.0.20 crash, reproduced with the REAL electron-updater (AppImageUpdater,
 * GenericProvider, HTTP executor) against a local feed: only the transport is
 * swapped — requests whose path ends in a configured suffix fail with Chromium's
 * `net::ERR_HTTP2_PROTOCOL_ERROR`, exactly the message Electron's `net` module
 * rejects with (the report's stack ends in SimpleURLLoaderWrapper).
 *
 *   - installer download fails  -> the auto-download promise rejects AFTER the
 *     check resolved. 1.0.20 dropped that promise: unhandledRejection -> crash.
 *   - manifest / manifest.sig fetch fails -> the check itself rejects.
 *
 * Each case is proven twice: through createHandledUpdateCheck (no leak, error
 * logged, retry decided) and through the raw 1.0.20 call shape (the leak).
 */

const require_ = createRequire(path.join(__dirname, '..', 'package.json'));
type Any = any;
const EU = require_('electron-updater') as Any;
const { GenericProvider } = require_('electron-updater/out/providers/GenericProvider') as { GenericProvider: GenericProviderCtor };
const { ElectronHttpExecutor } = require_('electron-updater/out/electronHttpExecutor') as Any;

const NET_MESSAGE = 'net::ERR_HTTP2_PROTOCOL_ERROR';

/** electron-updater's executor, electron.net swapped for node http, with chosen paths failing like a reset HTTP/2 stream. */
class FlakyExecutor extends ElectronHttpExecutor {
    constructor(private failSuffixes: string[]) { super(); }
    createRequest(options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) {
        const req = http.request(options, callback);
        if (this.failSuffixes.some((s) => String(options.path ?? '').split('?')[0].endsWith(s))) {
            // Same observable result as electron.net: the request emits 'error' with this message.
            setImmediate(() => req.destroy(new Error(NET_MESSAGE)));
        }
        return req;
    }
}

const KEY = crypto.generateKeyPairSync('ed25519');
const rawPub = Buffer.from(KEY.publicKey.export({ format: 'jwk' }).x as string, 'base64url').toString('base64');

let dir: string;
let server: http.Server;
let base: string;
let work: string;
const savedAppImage = process.env.APPIMAGE;

const APPIMAGE = Buffer.from('Cipherline 2.0.0 AppImage bytes');
const sha512 = (b: Buffer) => crypto.createHash('sha512').update(b).digest('base64');

function manifestName(channel: ManifestChannel): string {
    const p = new GenericProvider({ provider: 'generic', url: 'http://x/' }, { channel }, { platform: process.platform, executor: null });
    return `${p.channel}.yml`;
}

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-net-feed-'));
    const name = manifestName('latest');
    const manifest = Buffer.from([
        'version: 2.0.0', 'files:', '  - url: Cipherline-2.0.0.AppImage', `    sha512: ${sha512(APPIMAGE)}`, `    size: ${APPIMAGE.length}`,
        'path: Cipherline-2.0.0.AppImage', `sha512: ${sha512(APPIMAGE)}`, "releaseDate: '2026-10-17T00:00:00.000Z'", '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(dir, 'Cipherline-2.0.0.AppImage'), APPIMAGE);
    fs.writeFileSync(path.join(dir, name), manifest);
    fs.writeFileSync(path.join(dir, `${name}.sig`), Buffer.from(crypto.sign(null, manifestSignedMessage('latest', name, manifest), KEY.privateKey).toString('base64') + '\n'));
    server = http.createServer((req, res) => {
        const f = path.join(dir, path.basename(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)));
        if (fs.existsSync(f)) { res.writeHead(200); res.end(fs.readFileSync(f)); } else { res.writeHead(404); res.end('nope'); }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-net-updater-'));
    process.env.APPIMAGE = path.join(work, 'Cipherline-old.AppImage');
    fs.writeFileSync(process.env.APPIMAGE, 'old');
});
afterEach(() => {
    if (savedAppImage === undefined) delete process.env.APPIMAGE; else process.env.APPIMAGE = savedAppImage;
    fs.rmSync(work, { recursive: true, force: true });
});

function makeUpdater(failSuffixes: string[]) {
    fs.writeFileSync(path.join(work, 'app-update.yml'), 'provider: generic\nurl: http://unused/\nupdaterCacheDirName: cl-test-updater\n');
    const app = {
        version: '1.0.0', name: 'cl-test', isPackaged: true,
        appUpdateConfigPath: path.join(work, 'app-update.yml'), userDataPath: work, baseCachePath: path.join(work, 'cache'),
        whenReady: () => Promise.resolve(), relaunch() {}, quit() {}, onQuit() {},
    };
    const updater = new EU.AppImageUpdater(null, app);
    updater.httpExecutor = new FlakyExecutor(failSuffixes);
    updater.logger = null;
    updater.autoDownload = true; // as main.ts sets it — this is what starts the download the check never awaits
    updater.channel = 'latest';
    updater.allowDowngrade = false;
    updater.disableDifferentialDownload = true;
    const Signed = withManifestSignatureCheck(GenericProvider, { keysFor: () => [rawPub], requiredFor: () => true, report: () => {}, mismatchRetryDelayMs: 10 });
    updater.setFeedURL({ provider: 'custom', updateProvider: Signed, url: base });
    const errors: unknown[] = [];
    updater.on('error', (e: unknown) => { errors.push(e); }); // what main.ts's 'error' listener receives
    return { updater, errors };
}

describe('the installer download fails mid-update (the reported crash)', () => {
    it('NEGATIVE CONTROL (1.0.20): checkForUpdates().catch(…) with the downloadPromise dropped leaks net::ERR_HTTP2_PROTOCOL_ERROR as an unhandledRejection', async () => {
        const { updater, errors } = makeUpdater(['.AppImage']);
        const unhandled = await captureUnhandledRejections(async () => {
            await updater.checkForUpdates().catch(() => { /* logged by the 'error' listener */ });
            // The download fails AFTER the check resolved, after real I/O: wait for it, don't guess a delay.
            await waitFor(() => errors.length > 0);
        });
        expect(unhandled).toHaveLength(1);
        expect((unhandled[0] as Error).message).toBe(NET_MESSAGE);
        expect(networkErrorCode(unhandled[0])).toBe('ERR_HTTP2_PROTOCOL_ERROR');
        expect(errors).toHaveLength(1); // the 'error' listener WAS told: this was a pure double-report
    });

    it('through the handled check: nothing leaks, the error is logged once, and the updater decides to retry', async () => {
        const { updater, errors } = makeUpdater(['.AppImage']);
        const rejected: unknown[] = [];
        const check = createHandledUpdateCheck<Any>({
            blocked: () => null, emitError: (e) => updater.emit('error', e),
            check: () => updater.checkForUpdates(),
            onDownloadRejected: (e) => { rejected.push(e); },
        });
        const unhandled = await captureUnhandledRejections(async () => {
            const r = await check();
            expect(r?.isUpdateAvailable).toBe(true);
            await waitFor(() => rejected.length > 0); // the handler ran: the rejection happened AND was owned
        });
        expect(unhandled).toEqual([]);
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as Error).message).toBe(NET_MESSAGE);
        // delivered to the app's 'error' listener -> classify + onUpdateError (main.ts)
        expect(errors).toHaveLength(1);
        const kind = classifyUpdateError(errors[0] as Error, 'linux');
        expect(kind).toBe('transient');
        const decision = onUpdateError({ phase: 'available', version: '2.0.0' }, { kind, failures: 1, platform: 'linux', now: 0, buildDownloadUrl: () => null });
        expect(decision.retryInMs).toBe(RETRY_DELAYS_MS[0]);
        expect(decision.state).toMatchObject({ phase: 'retrying', version: '2.0.0' });
    });
});

describe('the manifest or its .sig cannot be fetched (the signed-manifest path)', () => {
    for (const suffix of ['.yml', '.yml.sig']) {
        it(`${suffix} fails with a net error: the check rejects to its caller as a plain transient error, never as a verification failure`, async () => {
            const { updater, errors } = makeUpdater([suffix]);
            const check = createHandledUpdateCheck<Any>({ blocked: () => null, emitError: () => {}, check: () => updater.checkForUpdates(), onDownloadRejected: () => {} });
            let caught: Any;
            const unhandled = await captureUnhandledRejections(async () => { await check().catch((e) => { caught = e; }); });
            expect(unhandled).toEqual([]);
            expect(caught?.message).toBe(NET_MESSAGE);
            expect(caught?.code).not.toBe('ERR_UPDATER_MANIFEST_SIGNATURE'); // NOT "the manifest was tampered with"
            expect(classifyUpdateError(caught, 'win32')).toBe('transient');
            expect(errors.length).toBeGreaterThanOrEqual(1);
        });
    }

    it('the scheduler turns that into `result=error code=ERR_HTTP2_PROTOCOL_ERROR` for the Performance log and does not reject', async () => {
        const { updater } = makeUpdater(['.yml.sig']);
        const check = createHandledUpdateCheck<Any>({ blocked: () => null, emitError: () => {}, check: () => updater.checkForUpdates(), onDownloadRejected: () => {} });
        const logs: string[] = [];
        const sched = new UpdateCheckScheduler({
            now: () => Date.now(), isOnline: () => true, canCheck: () => null,
            run: async () => { await check(); return 'ok'; },
            describeError: (e) => `error code=${updaterErrorCode(e)}`,
            log: (l) => logs.push(l), record: () => {},
        });
        const unhandled = await captureUnhandledRejections(async () => {
            const out = await sched.check('manual');
            expect(out.result).toBe('error code=ERR_HTTP2_PROTOCOL_ERROR');
        });
        expect(unhandled).toEqual([]);
        expect(logs).toContain('check reason=manual result=error code=ERR_HTTP2_PROTOCOL_ERROR');
    });

    it('POSITIVE CONTROL: with nothing failing the same harness checks, downloads and leaks nothing', async () => {
        const { updater, errors } = makeUpdater([]);
        const check = createHandledUpdateCheck<Any>({ blocked: () => null, emitError: () => {}, check: () => updater.checkForUpdates(), onDownloadRejected: () => { throw new Error('should not reject'); } });
        const unhandled = await captureUnhandledRejections(async () => {
            const r = await check();
            expect(r?.isUpdateAvailable).toBe(true);
            await r?.downloadPromise;
        });
        expect(unhandled).toEqual([]);
        expect(errors).toEqual([]);
    });
});
