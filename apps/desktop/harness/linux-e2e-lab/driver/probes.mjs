// Host-side wrappers around driver/probes.js (injected into the real renderers).
import fs from 'node:fs';
import path from 'node:path';
import { HERE, sleep } from './lab.mjs';

const SRC = fs.readFileSync(path.join(HERE, 'probes.js'), 'utf8');

/** Install on a page BEFORE the call joins (it wraps RTCPeerConnection). Idempotent. */
export const install = (page) => page.evaluate(SRC);
const within = (p, ms, what) => Promise.race([p, new Promise((_, rj) => setTimeout(() => rj(new Error(`${what} timed out after ${ms} ms`)), ms))]);
export const stats = (page) => within(page.evaluate(() => window.__lab.stats()), 30000, 'stats');
export const rates = (page, ms = 5000) => within(page.evaluate((m) => window.__lab.rates(m), ms), ms + 30000, 'rates');
/** Runs with a user gesture (CDP userGesture) so the AudioContext is allowed to start under the page's autoplay policy. */
export async function fft(page, ms = 3000) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const r = await cdp.send('Runtime.evaluate', { expression: `window.__lab.fft(${ms})`, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
    return r.result.value;
  } finally { await cdp.detach().catch(() => {}); }
}

/**
 * The app's own call-event record as main kept it: renderer call events are mirrored into main's perf log
 * (crashBreadcrumbs.ts -> perfBreadcrumb -> FreezeMonitor), the same log Settings -> Advanced -> Performance log shows and the
 * issue report carries as `perf_log`. Rows: { at, kind, detail:{k:v} } oldest first. (The encoder NAME is not mirrored by design:
 * that comes from the RTP stats `encoderImplementation`, the same field the app's share_fps `enc` reads.)
 */
export async function perfCalls(page, { since = 0, kinds } = {}) {
  const rows = await page.evaluate(() => window.electronAPI.perfGetLog());
  return rows.filter((r) => typeof r.activity === 'string' && r.activity.startsWith('call:') && r.at >= since)
    .map((r) => { const [k, ...rest] = r.activity.split(' '); const detail = {}; for (const kv of rest) { const i = kv.indexOf('='); if (i > 0) { const v = kv.slice(i + 1); detail[kv.slice(0, i)] = Number.isFinite(+v) && v !== '' ? +v : v; } } return { at: r.at, kind: k.slice(5), detail }; })
    .filter((r) => !kinds || kinds.includes(r.kind)).sort((a, b) => a.at - b.at);
}

/** The app's own call event log (utils/callEventLog.ts) via its "Copy call log" button on the stream-stats HUD, parsed to rows. */
export function parseCallLog(text) {
  return String(text).split('\n').filter(Boolean).map((l) => {
    const m = l.match(/^(\d\d:\d\d:\d\d\.\d+) (\S+)(?: (.*))?$/);
    if (!m) return null;
    const detail = {}; for (const kv of (m[3] || '').split(' ')) { const i = kv.indexOf('='); if (i > 0) detail[kv.slice(0, i)] = kv.slice(i + 1); }
    return { time: m[1], kind: m[2], detail };
  }).filter(Boolean);
}
export async function readCallLog(page) {
  const before = await page.evaluate(() => window.__lab.clipboard.length);
  const btn = page.locator('button:has-text("Copy call log")').first();
  if (!(await btn.count())) return null;
  await btn.click({ force: true });
  await sleep(500);
  const text = await page.evaluate((n) => window.__lab.clipboard.slice(n).pop() ?? null, before);
  return text ? parseCallLog(text) : null;
}
