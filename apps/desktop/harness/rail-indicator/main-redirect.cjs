/* eslint-disable -- harness only, never shipped (loaded with NODE_OPTIONS=--require into the DEV Electron main). */
// Rail indicator, real-app check: the REAL Electron main process with EVERY non-loopback
// request from main refused and logged (so the run provably contacts no Cipherline host from main), plus two
// headless-box shims, nothing else:
//   - the "Encryption at rest disabled" native modal is auto-acknowledged (Xvfb, no keychain, no window manager);
//   - the native folder / file pickers (dialog.showOpenDialog) answer with the path written in $HARNESS_PICK
//     (the backup folder, then the backup file to restore) - the rest of the backup / restore runs unchanged.
const LOG = process.env.MAIN_NET_LOG || '';
const PICK = process.env.HARNESS_PICK || '';
const fs = require('fs');
const note = (s) => { if (LOG) try { fs.appendFileSync(LOG, s + '\n'); } catch { /* ignore */ } };
const loopback = (h) => h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';

const realFetch = globalThis.fetch;
if (realFetch) {
    globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const host = new URL(url).hostname;
        if (!loopback(host)) { note(`BLOCKED fetch ${host}`); throw new TypeError(`harness: blocked non-loopback fetch to ${host}`); }
        return realFetch(input, init);
    };
}
for (const modName of ['http', 'https']) {
    const m = require(modName);
    for (const fn of ['request', 'get']) {
        const orig = m[fn];
        m[fn] = function (...args) {
            const a = args[0];
            const host = typeof a === 'string' ? new URL(a).hostname : a instanceof URL ? a.hostname : (a && (a.hostname || a.host)) || 'localhost';
            if (!loopback(String(host).replace(/:\d+$/, ''))) {
                note(`BLOCKED ${modName}.${fn} ${host}`);
                throw new Error(`harness: blocked non-loopback ${modName} request to ${host}`);
            }
            return orig.apply(this, args);
        };
    }
}
const M = require('module');
const origLoad = M._load;
M._load = function (request, ...rest) {
    const mod = origLoad.call(this, request, ...rest);
    if (request === 'electron' && mod && mod.dialog && !mod.dialog.__harnessPatched) {
        const orig = mod.dialog.showMessageBox.bind(mod.dialog);
        mod.dialog.showMessageBox = async (...args) => {
            const opts = args.find(a => a && typeof a === 'object' && 'title' in a);
            if (opts && opts.title === 'Encryption at rest disabled') { note('auto-acknowledged: Encryption at rest disabled'); return { response: 0, checkboxChecked: false }; }
            return orig(...args);
        };
        mod.dialog.showOpenDialog = async (...args) => {
            const opts = args.find(a => a && typeof a === 'object' && ('properties' in a || 'title' in a)) || {};
            let p = '';
            try { p = fs.readFileSync(PICK, 'utf8').trim(); } catch { /* none */ }
            note(`picker "${opts.title || ''}" -> ${p || '(cancelled)'}`);
            return p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] };
        };
        mod.dialog.__harnessPatched = true;
    }
    return mod;
};
note(`main-redirect loaded pid=${process.pid}`);
