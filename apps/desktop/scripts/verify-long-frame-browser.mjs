/**
 * Real-browser verification of the freeze log's script attribution
 * (src/utils/freezeLog.ts + longFrameAttribution.ts).
 *
 * The vitest suite proves the reduction rules on hand-written LoAF entries.
 * It cannot prove that CHROMIUM actually reports what those rules expect —
 * that a blocked keydown arrives as a 'long-animation-frame' entry naming the
 * function, its file on our origin, and `TEXTAREA.onkeydown`; that a script
 * from another origin is reduced to 'ext'; that a short handler produces
 * nothing. That needs a browser, so this drives chrome-headless-shell over
 * raw CDP with synthesized key input against the REAL modules (bundled with
 * esbuild) served from a local http origin.
 *
 *   node scripts/verify-long-frame-browser.mjs
 *
 * Reuses a browser already listening on :9510 and kills only one it started
 * (see CLAUDE.md on headless renderer pile-up). Binary lookup and the
 * undeclared-esbuild rationale: see verify-drag-gesture-browser.mjs.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CDP_PORT = 9510;

function fail(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

function findChrome() {
  const envPath = process.env.CIPHERLINE_CHROME || process.env.CHROME_PATH;
  if (envPath) {
    if (fs.existsSync(envPath)) return envPath;
    fail(`CIPHERLINE_CHROME/CHROME_PATH is set to '${envPath}' but nothing exists there.`);
  }
  const pattern = path.join(os.homedir(), '.cache', 'ms-playwright', 'chromium_headless_shell-*', 'chrome-headless-shell-*', 'chrome-headless-shell');
  const matches = fs.globSync(pattern).filter((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
  if (matches.length > 0) return matches.sort().reverse()[0];
  fail('Could not find a chrome-headless-shell binary. Set CIPHERLINE_CHROME, or run `npx playwright install chromium`.');
}

// Busy-wait helpers live in their own FILE so the attribution has a basename
// to report. Named functions, so sourceFunctionName has something to say.
const WORK_JS = `
function spin(ms) { const end = performance.now() + ms; while (performance.now() < end) { /* block */ } }
function heavyKeyHandler() { spin(window.KEY_COST_MS); }
function timerJob() { spin(320); }
function layoutThrash() {
  const box = document.getElementById('box');
  const end = performance.now() + 260;
  let i = 0;
  while (performance.now() < end) { box.style.width = (100 + (i++ % 50)) + 'px'; void box.offsetHeight; }
}
document.getElementById('composer').addEventListener('keydown', heavyKeyHandler);
window.runTimerJob = () => setTimeout(timerJob, 0);
window.runLayoutThrash = () => document.getElementById('box').dispatchEvent(new Event('thrash'));
document.getElementById('box').addEventListener('thrash', layoutThrash);
`;
const FOREIGN_JS = `function foreignBusy() { const end = performance.now() + 300; while (performance.now() < end) {} }
window.runForeign = () => setTimeout(foreignBusy, 0);`;

const PAGE = (foreignOrigin) => `<!doctype html><meta charset="utf-8">
<body><textarea id="composer"></textarea><div id="box" style="width:100px;height:40px;background:#48f"></div>
<script src="/freeze-bundle.js"></script>
<script>window.KEY_COST_MS = 0; FreezeHarness.startFreezeLog();</script>
<script src="/assets/work-Ab12Cd.js"></script>
<script src="${foreignOrigin}/lib/foreign.js"></script>
</body>`;

function serve(routes) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const body = routes[url.pathname];
      if (body === undefined) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html', 'cache-control': 'no-store' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

let nextId = 1;
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { ws, ready, send };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url) { return (await fetch(url)).json(); }

async function main() {
  const out = await build({
    stdin: {
      contents: "export { startFreezeLog, fetchFreezeLog } from './freezeLog'; export { getCallEvents } from './callEventLog';",
      resolveDir: path.join(__dirname, '..', 'src', 'utils'), loader: 'ts',
    },
    bundle: true, format: 'iife', globalName: 'FreezeHarness', write: false,
  });
  const bundle = out.outputFiles[0].text;

  const foreign = await serve({ '/lib/foreign.js': FOREIGN_JS });
  const own = await serve({ '/': '', '/index.html': '', '/freeze-bundle.js': bundle, '/assets/work-Ab12Cd.js': WORK_JS });
  // Fill in the page now that the foreign origin's port is known.
  own.server.removeAllListeners('request');
  const routes = { '/index.html': PAGE(foreign.origin), '/freeze-bundle.js': bundle, '/assets/work-Ab12Cd.js': WORK_JS };
  own.server.on('request', (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const body = routes[p];
    if (body === undefined) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : 'text/html', 'cache-control': 'no-store' });
    res.end(body);
  });

  let child = null;
  try { await getJSON(`http://127.0.0.1:${CDP_PORT}/json/version`); console.log(`· reusing browser on :${CDP_PORT}`); }
  catch {
    const chrome = findChrome();
    console.log(`· launching chrome-headless-shell on :${CDP_PORT}`);
    child = spawn(chrome, [
      `--remote-debugging-port=${CDP_PORT}`, '--headless', '--disable-gpu', '--no-sandbox', '--window-size=800,600',
      `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'))}`,
    ], { stdio: 'ignore', detached: false });
    for (let i = 0; i < 100; i++) { try { await getJSON(`http://127.0.0.1:${CDP_PORT}/json/version`); break; } catch { await sleep(100); } }
  }
  const version = await getJSON(`http://127.0.0.1:${CDP_PORT}/json/version`);
  console.log(`· ${version.Browser}`);

  const target = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${own.origin}/index.html`, { method: 'PUT' })).json();
  const { ws, ready, send } = connect(target.webSocketDebuggerUrl);
  await ready;
  await send('Page.enable');
  await sleep(800);

  const evalJS = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const key = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', windowsVirtualKeyCode: 65 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  };
  const rows = () => evalJS('FreezeHarness.fetchFreezeLog()');
  const events = () => evalJS('FreezeHarness.getCallEvents().filter(e => e.kind === "long_frame")');
  const settle = () => sleep(700);

  const results = [];
  const check = (name, pass, detail) => { results.push({ name, pass }); console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? `\n          ${detail}` : ''}`); };

  await evalJS('document.getElementById("composer").focus()');
  check('Chromium supports long-animation-frame', await evalJS('PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")'));
  const baseline = (await rows()).length;

  /* negative control: 20 keystrokes at 40 ms each never reach the threshold */
  await evalJS('window.KEY_COST_MS = 40');
  for (let i = 0; i < 20; i++) await key();
  await settle();
  check('20 short (40 ms) keystrokes record nothing', (await rows()).length === baseline, `rows=${(await rows()).length - baseline}`);

  /* 1. a blocked keystroke names the handler, its file and the invoker */
  await evalJS('window.KEY_COST_MS = 450');
  await key();
  await settle();
  let r = await rows();
  const keyRow = r.find(x => x.activity.includes('heavyKeyHandler'));
  check('a 450 ms keydown is attributed to js:work-Ab12Cd.js:heavyKeyHandler via TEXTAREA.onkeydown',
    !!keyRow && keyRow.ms >= 440 && /js:work-Ab12Cd\.js:heavyKeyHandler:c\d+:\d+ms/.test(keyRow.activity) && keyRow.activity.includes('via:TEXTAREA.onkeydown'),
    keyRow ? `${keyRow.ms} ms  ${keyRow.activity}` : JSON.stringify(r));
  await evalJS('window.KEY_COST_MS = 0');

  /* 2. a timer callback */
  await evalJS('window.runTimerJob()');
  await settle();
  r = await rows();
  const timerRow = r.find(x => x.activity.includes('timerJob'));
  check('a 320 ms setTimeout callback is attributed to timerJob', !!timerRow && /via:\w+\.setTimeout/.test(timerRow.activity), timerRow ? `${timerRow.ms} ms  ${timerRow.activity}` : JSON.stringify(r));

  /* 3. forced synchronous layout is called out */
  await evalJS('window.runLayoutThrash()');
  await settle();
  r = await rows();
  const layoutRow = r.find(x => x.activity.includes('layoutThrash'));
  check('layout thrash reports forced-layout time', !!layoutRow && /forced-layout:\d+ms/.test(layoutRow.activity), layoutRow ? `${layoutRow.ms} ms  ${layoutRow.activity}` : JSON.stringify(r));

  /* 4. another origin's script is 'ext' — no URL, host or path. (Chromium
   *    itself withholds the function name and offset of an opaque
   *    cross-origin script, so it reads js:ext:anon.) */
  const before = (await rows()).length;
  await evalJS('window.runForeign()');
  await settle();
  r = await rows();
  const extRow = r.length > before ? r[0] : null;
  check('a script from another origin is reduced to js:ext', !!extRow && extRow.ms >= 290 && extRow.activity.includes('js:ext:') && !/127\.0\.0\.1|http|lib\/|foreign/.test(extRow.activity), extRow ? `${extRow.ms} ms  ${extRow.activity}` : JSON.stringify(r));

  /* 5. the structured long_frame events */
  const ev = await events();
  const keyEv = ev.find(e => e.detail?.fn === 'heavyKeyHandler');
  check('long_frame call event carries file/fn/char/invoker as code identifiers',
    !!keyEv && keyEv.detail.file === 'work-Ab12Cd.js' && keyEv.detail.invoker === 'TEXTAREA.onkeydown' && keyEv.detail.invoker_type === 'event-listener' && keyEv.detail.char > 0,
    keyEv ? JSON.stringify(keyEv.detail) : JSON.stringify(ev));
  check('no event or row contains a URL', !/https?:|127\.0\.0\.1/.test(JSON.stringify([await rows(), ev])));

  console.log('\nrows recorded:');
  for (const x of (await rows()).slice().reverse()) console.log(`  ${String(x.ms).padStart(5)} ms  ${x.activity}`);

  ws.close();
  await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${target.id}`);
  own.server.close(); foreign.server.close();
  if (child) { try { process.kill(child.pid); } catch {} }
  const failed = results.filter((x) => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
