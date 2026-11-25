// Real-Chromium repro for secureLocalStore's UNREADABLE RECORDS handling
// (2026-11-23, the "Couldn't read your data on this device" on every launch).
//
// Writes records shaped like kv_enc's ({ o, b: Uint8Array }), one of them large
// enough that Chromium keeps it as its own file under <origin>.indexeddb.blob/,
// closes the browser, damages that file (or the LevelDB), reopens, and prints
// which read shapes still work: cursor, getAll, getAllKeys, key cursor, per-key
// get (one transaction / a transaction each), a ranged getAll, a write.
//
// usage: node apps/desktop/scripts/verify-idb-unreadable-record.cjs <chrome> <mode>
//   <chrome>: e.g. ~/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome
//   <mode>:   delete | truncate | shorten | garbage | chmod |
//             leveldb-ldb | leveldb-manifest | leveldb-current
// Results 2026-11-23 (Chromium 159; `delete` also in Electron 43.2.0) are in
// docs/worklog/entries/2026-11-23-store-unreadable-records.md.
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const os = require('os');

const exe = process.argv[2];
const mode = process.argv[3] || 'delete';
const ORIGIN = 'http://cl.test';

const PAGE = `<!doctype html><title>idb</title><script>
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('cipherline', 4);
    r.onupgradeneeded = () => { const db = r.result;
      for (const s of ['attachments_enc','avatars_dec','kv_enc']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const err = e => e ? (e.name + ': ' + e.message) : String(e);
function bytes(n, seed) { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255; b[0] = 1; return b; }
window.writeAll = async () => {
  const db = await openDb();
  await new Promise((res, rej) => {
    const tx = db.transaction('kv_enc', 'readwrite'); const s = tx.objectStore('kv_enc');
    s.put({ o: null, b: bytes(60, 1) }, 'cipherline_user_id');
    s.put({ o: null, b: bytes(200, 2) }, 'cipherline_token');
    s.put({ o: 'u1', b: bytes(500, 3) }, 'cipherline_settings_u1');
    s.put({ o: 'u1', b: bytes(3 * 1024 * 1024, 4) }, 'cipherline_msgs_u1_convA_2026-11');   // LARGE -> blob file
    s.put({ o: 'u1', b: bytes(40 * 1024, 5) }, 'cipherline_msgs_u1_convB_2026-11');         // below threshold
    s.put({ o: 'u1', b: bytes(1000, 6) }, 'cipherline_zz_last_u1');
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  db.close();
  return 'ok';
};
window.probe = async () => {
  const out = {};
  let db;
  try { db = await openDb(); out.open = 'ok'; } catch (e) { out.open = 'FAIL ' + err(e); return out; }
  // 1. cursor with values (today's readAllRecords)
  out.cursor = await new Promise(res => {
    const seen = []; let tx;
    try { tx = db.transaction('kv_enc', 'readonly'); } catch (e) { res('FAIL tx ' + err(e)); return; }
    const req = tx.objectStore('kv_enc').openCursor();
    req.onsuccess = () => { const c = req.result; if (!c) { res('ok ' + JSON.stringify(seen)); return; } seen.push(c.key); c.continue(); };
    req.onerror = () => res('FAIL req ' + err(req.error) + ' after ' + JSON.stringify(seen));
    tx.onabort = () => res('FAIL abort ' + err(tx.error) + ' after ' + JSON.stringify(seen));
  });
  // 2. getAll
  out.getAll = await new Promise(res => {
    const tx = db.transaction('kv_enc', 'readonly'); const req = tx.objectStore('kv_enc').getAll();
    req.onsuccess = () => res('ok n=' + req.result.length);
    req.onerror = () => res('FAIL ' + err(req.error));
  });
  // 3. getAllKeys
  let keys = [];
  out.getAllKeys = await new Promise(res => {
    const tx = db.transaction('kv_enc', 'readonly'); const req = tx.objectStore('kv_enc').getAllKeys();
    req.onsuccess = () => { keys = req.result; res('ok ' + JSON.stringify(keys)); };
    req.onerror = () => res('FAIL ' + err(req.error));
  });
  // 4. openKeyCursor
  out.keyCursor = await new Promise(res => {
    const seen = []; const tx = db.transaction('kv_enc', 'readonly');
    const req = tx.objectStore('kv_enc').openKeyCursor();
    req.onsuccess = () => { const c = req.result; if (!c) { res('ok n=' + seen.length); return; } seen.push(c.key); c.continue(); };
    req.onerror = () => res('FAIL ' + err(req.error));
  });
  // 5. per-key get, ONE transaction, preventDefault on error
  out.perKeyOneTx = await new Promise(res => {
    const r = {}; const tx = db.transaction('kv_enc', 'readonly'); const s = tx.objectStore('kv_enc');
    for (const k of keys) {
      const req = s.get(k);
      req.onsuccess = () => { r[k] = 'ok ' + (req.result && req.result.b ? req.result.b.length : '?'); };
      req.onerror = (ev) => { r[k] = 'FAIL ' + err(req.error); ev.preventDefault(); ev.stopPropagation(); };
    }
    tx.oncomplete = () => res({ tx: 'complete', r });
    tx.onabort = () => res({ tx: 'ABORT ' + err(tx.error), r });
  });
  // 6. per-key get, a transaction per key
  out.perKeyOwnTx = {};
  for (const k of keys) {
    out.perKeyOwnTx[k] = await new Promise(res => {
      const tx = db.transaction('kv_enc', 'readonly'); const req = tx.objectStore('kv_enc').get(k);
      req.onsuccess = () => res('ok ' + (req.result && req.result.b ? req.result.b.length : ('? ' + Object.prototype.toString.call(req.result) + ' ' + JSON.stringify(req.result === undefined ? 'undefined' : req.result).slice(0, 80))));
      req.onerror = (ev) => { ev.preventDefault(); res('FAIL ' + err(req.error)); };
    });
  }
  // 7. getAll over a bounded key range containing the bad key
  if (keys.length > 2) {
    out.getAllRange = await new Promise(res => {
      const tx = db.transaction('kv_enc', 'readonly');
      const req = tx.objectStore('kv_enc').getAll(IDBKeyRange.bound(keys[0], keys[keys.length - 1]));
      req.onsuccess = () => res('ok n=' + req.result.length);
      req.onerror = (ev) => { ev.preventDefault(); res('FAIL ' + err(req.error)); };
    });
  }
  // 8. Can a write to an OTHER key still succeed, and a write OVER the bad key?
  out.writeOther = await new Promise(res => {
    const tx = db.transaction('kv_enc', 'readwrite'); tx.objectStore('kv_enc').put({ o: null, b: bytes(10, 9) }, 'probe_other');
    tx.oncomplete = () => res('ok'); tx.onabort = () => res('FAIL ' + err(tx.error));
  });
  db.close();
  return out;
};
</script>`;

function findBlobFiles(dir) {
  const out = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : out.push(p); } };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(process.env.SCRATCH || os.tmpdir(), 'prof-'));
  const launch = () => chromium.launchPersistentContext(profile, { executablePath: exe, headless: true, args: ['--no-sandbox'] });
  let ctx = await launch();
  let page = await ctx.newPage();
  await page.route(ORIGIN + '/**', r => r.fulfill({ contentType: 'text/html', body: PAGE }));
  await page.goto(ORIGIN + '/');
  console.log('write:', await page.evaluate(() => window.writeAll()));
  console.log('baseline probe:', JSON.stringify(await page.evaluate(() => window.probe()), null, 1));
  await ctx.close();

  const idbDir = path.join(profile, 'Default', 'IndexedDB');
  const entries = fs.readdirSync(idbDir);
  console.log('IndexedDB dir:', entries);
  const blobDir = path.join(idbDir, entries.find(e => e.endsWith('.indexeddb.blob')) || 'none');
  const ldbDir = path.join(idbDir, entries.find(e => e.endsWith('.indexeddb.leveldb')) || 'none');
  const blobs = findBlobFiles(blobDir);
  console.log('blob files:', blobs.map(b => path.relative(idbDir, b) + ' ' + fs.statSync(b).size));
  if (fs.existsSync(ldbDir)) console.log('leveldb files:', fs.readdirSync(ldbDir));

  if (mode === 'delete') blobs.forEach(b => fs.unlinkSync(b));
  else if (mode === 'truncate') blobs.forEach(b => fs.truncateSync(b, 0));
  else if (mode === 'shorten') blobs.forEach(b => fs.truncateSync(b, 1000));
  else if (mode === 'garbage') blobs.forEach(b => { const n = fs.statSync(b).size; fs.writeFileSync(b, Buffer.alloc(n, 0x5a)); });
  else if (mode === 'chmod') blobs.forEach(b => fs.chmodSync(b, 0o000));
  else if (mode === 'leveldb-ldb') {
    const ldbs = fs.readdirSync(ldbDir).filter(f => f.endsWith('.ldb') || f.endsWith('.log'));
    for (const f of ldbs) { const p = path.join(ldbDir, f); const b = fs.readFileSync(p); for (let i = 0; i < b.length; i += 7) b[i] ^= 0xff; fs.writeFileSync(p, b); }
    console.log('corrupted', ldbs);
  } else if (mode === 'leveldb-manifest') {
    for (const f of fs.readdirSync(ldbDir).filter(f => f.startsWith('MANIFEST'))) fs.writeFileSync(path.join(ldbDir, f), Buffer.alloc(64, 0x41));
  } else if (mode === 'leveldb-current') {
    fs.writeFileSync(path.join(ldbDir, 'CURRENT'), 'MANIFEST-999999\n');
  }
  console.log('mutation applied:', mode);

  ctx = await launch();
  page = await ctx.newPage();
  page.on('console', m => console.log('  [console]', m.text()));
  await page.route(ORIGIN + '/**', r => r.fulfill({ contentType: 'text/html', body: PAGE }));
  await page.goto(ORIGIN + '/');
  console.log('after probe:', JSON.stringify(await page.evaluate(() => window.probe()), null, 1));
  // and again, a second "launch", to see whether the failure persists or Chromium self-repairs/deletes
  await ctx.close();
  if (fs.existsSync(ldbDir)) console.log('leveldb files after:', fs.readdirSync(ldbDir));
  console.log('blob files after:', findBlobFiles(blobDir).map(b => path.relative(idbDir, b)));
  ctx = await launch();
  page = await ctx.newPage();
  await page.route(ORIGIN + '/**', r => r.fulfill({ contentType: 'text/html', body: PAGE }));
  await page.goto(ORIGIN + '/');
  console.log('second relaunch probe:', JSON.stringify(await page.evaluate(() => window.probe())));
  await ctx.close();
  if (mode === 'chmod') blobs.forEach(b => { try { fs.chmodSync(b, 0o600); } catch {} });
  fs.rmSync(profile, { recursive: true, force: true });
})().catch(e => { console.error('SCRIPT ERROR', e); process.exit(1); });
