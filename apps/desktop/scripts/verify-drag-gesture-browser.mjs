/**
 * Real-browser verification of the zoom/pan click-vs-drag decision.
 *
 * The vitest suite in src/utils/dragGesture.test.ts proves the state machine.
 * It cannot prove the part that actually broke: how the BROWSER routes the
 * click that a drag leaves behind. Chrome dispatches that click at the nearest
 * common ancestor of the press and the release, so a pan that ends outside the
 * tile is dispatched ABOVE the tile — a suppressor bound on the tile never
 * runs and the click activates the grid behind it. That is browser semantics,
 * not logic, so it needs a browser.
 *
 * This drives chrome-headless-shell over raw CDP with synthesized mouse input
 * and asserts on both wirings — `window`-capture (the fix) and `root`-bound
 * (the regression) — so the suite fails if someone moves the listener back.
 *
 *   node scripts/verify-drag-gesture-browser.mjs
 *
 * Reuses an existing browser on port 9510 if one is listening, and kills only
 * a browser it started itself (see CLAUDE.md on renderer pile-up).
 *
 * Needs a chrome-headless-shell binary (only when it has to launch one — a
 * reused browser on :9510 needs nothing here). Set CIPHERLINE_CHROME or
 * CHROME_PATH to its path; otherwise it globs Playwright's local cache under
 * ~/.cache/ms-playwright (see findChrome() below for the exact pattern),
 * which is where `npx playwright install chromium` puts it.
 *
 * Requires `esbuild`, which resolves via the monorepo-hoisted copy that vite
 * brings in — it is deliberately NOT declared in apps/desktop/package.json.
 * Declaring it was tried and reverted: a direct devDependency resolves to a
 * different esbuild instance than vite's own, which changes how vitest
 * evaluates `?raw` imports and broke src/utils/rnnoiseInWorkletSource.smoke
 * .test.ts. This is a manual dev tool with no CI coverage, so the undeclared
 * (status-quo) resolution is the lesser risk. If a future dependency bump
 * removes the hoisted copy, this script fails loudly at import — fix it then,
 * and re-run that rnnoise test before declaring the dep again.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9510;

function fail(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

/**
 * Locate the chrome-headless-shell binary to drive.
 *
 * Priority: CIPHERLINE_CHROME / CHROME_PATH env var (portable — works on any
 * box, any Playwright version, any CI runner) > a glob over Playwright's
 * local cache (keeps this working on a dev box with zero configuration).
 * Never hardcode a path here: this script's source lives in the tree that
 * ships as the public Apache-2.0 desktop client repo, and a hardcoded
 * absolute path bakes a local username and an exact build number into it.
 */
function findChrome() {
  const envPath = process.env.CIPHERLINE_CHROME || process.env.CHROME_PATH;
  if (envPath) {
    if (fs.existsSync(envPath)) return envPath;
    fail(`CIPHERLINE_CHROME/CHROME_PATH is set to '${envPath}' but nothing exists there.`);
  }

  const pattern = path.join(
    os.homedir(), '.cache', 'ms-playwright',
    'chromium_headless_shell-*', 'chrome-headless-shell-*', 'chrome-headless-shell',
  );
  const matches = fs.globSync(pattern).filter((p) => {
    try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
  });
  if (matches.length > 0) {
    // Sorting descending picks the highest cached build number when more
    // than one Playwright version is installed.
    matches.sort().reverse();
    return matches[0];
  }

  fail(
    'Could not find a chrome-headless-shell binary.\n' +
    '  Set CIPHERLINE_CHROME (or CHROME_PATH) to its full path, e.g.:\n' +
    '    CIPHERLINE_CHROME=/path/to/chrome-headless-shell node scripts/verify-drag-gesture-browser.mjs\n' +
    '  Or install Playwright\'s copy so the fallback lookup finds it:\n' +
    '    npx playwright install chromium --with-deps\n' +
    '  (expected at ~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell)',
  );
}

/* ── page ────────────────────────────────────────────────────────────── */
// #bg fills the viewport; #tile is a 400x300 box centred in it. A drag that
// leaves the tile releases over #bg, which is exactly the geometry that made
// the click land above the tile.
const PAGE = (bundle) => `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:100%;height:100%}
#bg{position:fixed;inset:0;background:#222}
#tile{position:absolute;left:200px;top:150px;width:400px;height:300px;background:#48f}
</style><body><div id="bg"><div id="tile"></div></div><script>${bundle}</script><script>
const DG = window.DragGesture;
const tile = document.getElementById('tile'), bg = document.getElementById('bg');
window.R = { tileClicks: 0, bgClicks: 0, panX: 0, panY: 0 };
tile.addEventListener('click', () => { window.R.tileClicks++; });
bg.addEventListener('click', () => { window.R.bgClicks++; });

// Mirrors useVideoZoomPan.ts. \`mode\` picks where the click suppressor lives:
// 'window' is the fix, 'root' reproduces the regression.
let live = null;
window.wire = (mode, { zoomed = true, allowLeftDrag = true, pointerCapture = true } = {}) => {
  // Tear the previous wiring down. Without this every re-wire leaves its
  // window listeners attached and the next scenario counts N times over.
  if (live) live.abort();
  live = new AbortController();
  const sig = live.signal;
  window.R = { tileClicks: 0, bgClicks: 0, panX: 0, panY: 0 };
  let drag = DG.IDLE_DRAG, suppressClick = false;
  const wantsPan = (e) => {
    if (!zoomed) return false;
    if (e.button === 1) return true;
    if (e.button !== 0) return false;
    return allowLeftDrag;
  };
  tile.addEventListener('pointerdown', (e) => {
    suppressClick = false;
    if (!wantsPan(e)) return;
    drag = DG.beginDrag(e.pointerId, e.clientX, e.clientY);
    if (pointerCapture) { try { tile.setPointerCapture(e.pointerId); } catch {} }
    e.preventDefault();
  }, { signal: sig });
  window.addEventListener('pointermove', (e) => {
    const r = DG.moveDrag(drag, e.pointerId, e.clientX, e.clientY);
    drag = r.state;
    if (!r.pan) return;
    window.R.panX += r.pan.dx; window.R.panY += r.pan.dy;
  }, { signal: sig });
  const end = (e) => {
    const r = DG.endDrag(drag, e.pointerId);
    drag = r.state;
    if (r.suppressClick) suppressClick = true;
    if (pointerCapture) { try { tile.releasePointerCapture(e.pointerId); } catch {} }
  };
  window.addEventListener('pointerup', end, { signal: sig });
  window.addEventListener('pointercancel', end, { signal: sig });
  tile.addEventListener('lostpointercapture', end, { signal: sig });
  const onClickCapture = (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  };
  (mode === 'window' ? window : tile).addEventListener('click', onClickCapture, { capture: true, signal: sig });
};
</script>`;

/* ── CDP ─────────────────────────────────────────────────────────────── */
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
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
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
  // Build the REAL module, so this exercises shipped code.
  const out = await build({
    entryPoints: [path.join(__dirname, '..', 'src', 'utils', 'dragGesture.ts')],
    bundle: true, format: 'iife', globalName: 'DragGesture', write: false,
  });
  const bundle = out.outputFiles[0].text;

  const pagePath = path.join(os.tmpdir(), `drag-gesture-verify-${process.pid}.html`);
  fs.writeFileSync(pagePath, PAGE(bundle));

  // Reuse a listening browser; only kill one we started.
  let child = null;
  try { await getJSON(`http://127.0.0.1:${PORT}/json/version`); console.log(`· reusing browser on :${PORT}`); }
  catch {
    const chrome = findChrome();
    console.log(`· launching chrome-headless-shell on :${PORT} (${chrome})`);
    child = spawn(chrome, [
      `--remote-debugging-port=${PORT}`, '--headless', '--disable-gpu',
      '--no-sandbox', '--window-size=800,600',
      `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'))}`,
    ], { stdio: 'ignore', detached: false });
    for (let i = 0; i < 100; i++) {
      try { await getJSON(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(100); }
    }
  }

  const target = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?file://${pagePath}`, { method: 'PUT' },
  )).json();
  const { ws, ready, send } = connect(target.webSocketDebuggerUrl);
  await ready;
  await send('Page.enable');
  await sleep(400);

  const evalJS = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  // Synthesized input. Chrome turns these into real PointerEvents and
  // synthesizes the trailing click itself — which is the whole point.
  const down = (x, y) => send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  const move = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
  const up = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  const glide = async (x0, y0, x1, y1, steps) => {
    for (let i = 1; i <= steps; i++) {
      await move(Math.round(x0 + ((x1 - x0) * i) / steps), Math.round(y0 + ((y1 - y0) * i) / steps));
    }
  };

  const results = [];
  const check = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };
  const R = () => evalJS('window.R');

  const TILE = { cx: 400, cy: 300 };

  /* 1. jitter press — a mouse click with hand tremor must stay a click. */
  console.log('\n[window-capture wiring — the fix]');
  await evalJS(`window.wire('window')`);
  await down(TILE.cx, TILE.cy); await move(TILE.cx + 1, TILE.cy);
  await move(TILE.cx + 1, TILE.cy + 1); await up(TILE.cx + 1, TILE.cy + 1);
  await sleep(60);
  let r = await R();
  check('jitter-press (<=2px) still clicks the tile', r.tileClicks === 1 && r.panX === 0 && r.panY === 0, `clicks=${r.tileClicks} pan=(${r.panX},${r.panY})`);

  /* 2. deliberate drag inside the tile — pans, click swallowed. */
  await evalJS(`window.wire('window')`);
  await down(TILE.cx - 100, TILE.cy); await glide(TILE.cx - 100, TILE.cy, TILE.cx + 100, TILE.cy, 20);
  await up(TILE.cx + 100, TILE.cy);
  await sleep(60);
  r = await R();
  check('deliberate 200px drag pans and swallows the click', r.tileClicks === 0 && r.panX === 200, `clicks=${r.tileClicks} panX=${r.panX}`);

  /* 3. THE REGRESSION: drag that ends outside the tile. */
  await evalJS(`window.wire('window')`);
  await down(TILE.cx, TILE.cy); await glide(TILE.cx, TILE.cy, 750, 560, 25); await up(750, 560);
  await sleep(60);
  r = await R();
  check('drag ending OFF the tile activates nothing', r.tileClicks === 0 && r.bgClicks === 0, `tile=${r.tileClicks} bg=${r.bgClicks}`);

  /* 4. ...and does not leave the suppressor armed to eat the next click. */
  await down(TILE.cx, TILE.cy); await up(TILE.cx, TILE.cy);
  await sleep(60);
  r = await R();
  check('the NEXT innocent click still lands', r.tileClicks === 1, `tile=${r.tileClicks}`);

  /* 5. at 1x the left-drag is not a pan: click-to-focus must survive. */
  await evalJS(`window.wire('window', { zoomed: false })`);
  await down(TILE.cx, TILE.cy); await glide(TILE.cx, TILE.cy, TILE.cx + 60, TILE.cy, 10); await up(TILE.cx + 60, TILE.cy);
  await sleep(60);
  r = await R();
  check('at 1x a drag still clicks (no pan hijack)', r.tileClicks === 1 && r.panX === 0, `clicks=${r.tileClicks} panX=${r.panX}`);

  /* 6. tool armed with draw permission: left is surrendered, click survives. */
  await evalJS(`window.wire('window', { allowLeftDrag: false })`);
  await down(TILE.cx, TILE.cy); await glide(TILE.cx, TILE.cy, TILE.cx + 60, TILE.cy, 10); await up(TILE.cx + 60, TILE.cy);
  await sleep(60);
  r = await R();
  check('allowLeftDrag=false leaves the left button alone', r.panX === 0, `panX=${r.panX}`);

  /* 7. The ORIGINAL wiring — root-bound suppressor AND no pointer capture —
   *    must leak, or these tests have no teeth. Pointer capture matters here:
   *    it retargets the trailing click back to the tile, which on its own
   *    masks the leak. Both belts are modelled separately below. */
  console.log('\n[controls — the original wiring must misbehave]');
  await evalJS(`window.wire('root', { pointerCapture: false })`);
  await down(TILE.cx, TILE.cy); await glide(TILE.cx, TILE.cy, 750, 560, 25); await up(750, 560);
  await sleep(60);
  r = await R();
  check('control: root-bound + no capture LEAKS the click to the background', r.bgClicks > 0, `bg=${r.bgClicks}`);
  // The stale flag does not carry into the next gesture: pointerdown disarms
  // it. Pinned so nobody "fixes" a leak that does not exist — and so that if
  // the disarm is ever removed, this flips and says so.
  await down(TILE.cx, TILE.cy); await up(TILE.cx, TILE.cy);
  await sleep(60);
  r = await R();
  check('control: the stale flag does NOT eat the next click (pointerdown disarms)', r.tileClicks === 1, `tile=${r.tileClicks}`);

  /* 8. Each belt alone is sufficient — so we know which change did the work
   *    and a future refactor that drops either one still fails loudly. */
  await evalJS(`window.wire('window', { pointerCapture: false })`);
  await down(TILE.cx, TILE.cy); await glide(TILE.cx, TILE.cy, 750, 560, 25); await up(750, 560);
  await sleep(60);
  r = await R();
  check('window-capture alone (no pointer capture) suppresses the off-tile click', r.tileClicks === 0 && r.bgClicks === 0, `tile=${r.tileClicks} bg=${r.bgClicks}`);
  await down(TILE.cx, TILE.cy); await up(TILE.cx, TILE.cy);
  await sleep(60);
  r = await R();
  check('window-capture alone leaves the next click intact', r.tileClicks === 1, `tile=${r.tileClicks}`);

  /* cleanup */
  ws.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
  fs.unlinkSync(pagePath);
  if (child) { try { process.kill(child.pid); } catch {} }

  const failed = results.filter((x) => !x.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
