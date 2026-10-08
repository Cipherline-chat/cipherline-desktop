/**
 * The out-of-process screen-share source lister. Runs when ./entry.ts sees
 * SOURCES_HELPER_FLAG: the same executable as the app, but this file instead
 * of ./main.ts — no window, no renderer, no storage, no network, no
 * single-instance lock. Its whole job is desktopCapturer.getSources() with
 * DXGI Desktop Duplication DISABLED, so that the main process (which keeps
 * DXGI enabled for the share itself) never has to list sources. Why: see
 * pickerEnumeration in ./capture-flags.ts.
 *
 * Lifetime is bound to the parent's socket: when it closes (the parent asked
 * us to stop, went idle, or died) this process exits. It never reads
 * anything but request lines from that socket, and it only ever answers
 * with source lists.
 */
import { app, desktopCapturer } from 'electron';
import * as net from 'net';
import { WINDOWS_NO_DXGI_FEATURE } from './capture-flags';
import { thumbnailJpegDataUrl } from './thumbnailDataUrl';
import {
    SOURCES_HELPER_ENV_ADDRESS, SOURCES_HELPER_ENV_TOKEN, SOURCES_HELPER_ENV_DATA_DIR,
    createLineSplitter, encodeLine, parseHelperRequest, type HelperRequest, type ListedSource,
} from './sources-helper-protocol';

const address = process.env[SOURCES_HELPER_ENV_ADDRESS];
const token = process.env[SOURCES_HELPER_ENV_TOKEN];
const dataDir = process.env[SOURCES_HELPER_ENV_DATA_DIR];
// Not needed again, and nothing this process starts should inherit them.
delete process.env[SOURCES_HELPER_ENV_ADDRESS];
delete process.env[SOURCES_HELPER_ENV_TOKEN];
delete process.env[SOURCES_HELPER_ENV_DATA_DIR];

const log = (msg: string) => { try { process.stderr.write(`[sources-helper] ${msg}\n`); } catch { /* no stderr */ } };

if (!address || !token) {
    // Launched by hand, or by something that is not our main process.
    log('missing address/token; exiting');
    process.exit(2);
}

// The point of this process. Chromium reads features once, at start-up, and
// Electron's getSources() consults DirectXCapturer on every call
// (electron_api_desktop_capturer.cc StartHandling / content
// desktop_capture.cc CreateDesktopCaptureOptions). With it disabled the
// screen list and previews come from GDI; windows from GDI with WGC
// fallback — exactly what the main process did when Automatic was WGC.
app.commandLine.appendSwitch('disable-features', WINDOWS_NO_DXGI_FEATURE);
// No GPU work here (previews are CPU copies + a CPU JPEG encode).
app.disableHardwareAcceleration();
// A private, throw-away profile: never the user's real one (the main
// process has it open), removed by the parent when we exit.
if (dataDir) {
    app.setPath('userData', dataDir);
    app.setPath('sessionData', dataDir);
}
// Never had a window; never quit for that reason.
app.on('window-all-closed', () => { /* stay until the socket closes */ });
process.on('uncaughtException', (e) => { log(`uncaught: ${e?.message}`); app.exit(3); });

let chain: Promise<void> = Promise.resolve();
let sock: net.Socket | null = null;

const send = (v: unknown) => { if (sock && !sock.destroyed) sock.write(encodeLine(v)); };

async function run(req: HelperRequest): Promise<void> {
    const t0 = Date.now();
    try {
        const wantThumbs = req.thumbnailSize.width > 0 && req.thumbnailSize.height > 0;
        const raw = await desktopCapturer.getSources({
            types: req.types,
            thumbnailSize: req.thumbnailSize,
            fetchWindowIcons: false,
        });
        const sources: ListedSource[] = raw.map(s => ({
            id: s.id,
            name: s.name,
            display_id: s.display_id ?? '',
            thumbnailDataUrl: wantThumbs ? thumbnailJpegDataUrl(s.thumbnail) : '',
        }));
        send({ kind: 'result', id: req.id, ok: true, sources, ms: Date.now() - t0 });
    } catch (e) {
        send({ kind: 'result', id: req.id, ok: false, error: (e as Error)?.message ?? String(e) });
    }
}

void app.whenReady().then(() => {
    if (process.platform === 'darwin') app.dock?.hide();
    const s = net.createConnection(address as string);
    sock = s;
    const giveUp = setTimeout(() => { log('could not connect; exiting'); app.exit(4); }, 10_000);
    s.setEncoding('utf8');
    s.on('connect', () => {
        clearTimeout(giveUp);
        send({
            kind: 'hello',
            token,
            pid: process.pid,
            disabledFeatures: app.commandLine.getSwitchValue('disable-features'),
        });
    });
    // Requests are tiny; anything long is not ours.
    const split = createLineSplitter((line) => {
        const req = parseHelperRequest(line);
        if (!req) { log('ignored a malformed request'); return; }
        chain = chain.then(() => run(req));
    }, () => { log('oversized request; exiting'); app.exit(5); }, 64 * 1024);
    s.on('data', (chunk: string) => split(chunk));
    s.on('error', () => { /* 'close' follows */ });
    s.on('close', () => app.exit(0));
});
