/* eslint-disable -- harness only, never shipped (loaded with NODE_OPTIONS=--require into the DEV Electron main). */
// Discord import background pass (from the final pass), real-app check: the REAL Electron main process, with its two Discord origins
// rewritten to the loopback mock (discord-mock.mjs) and EVERY other non-loopback request from main refused and
// logged, so the run provably contacts no Cipherline (or any other) host from main. The renderer is pinned by
// VITE_API_HOST + the CSP + Playwright routing (app-run.mjs).
const MOCK = process.env.DISCORD_MOCK || 'http://127.0.0.1:7992';
const LOG = process.env.MAIN_NET_LOG || '';
const fs = require('fs');
const note = (s) => { if (LOG) try { fs.appendFileSync(LOG, s + '\n'); } catch { /* ignore */ } };
const loopback = (h) => h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';

const realFetch = globalThis.fetch;
if (realFetch) {
    globalThis.fetch = async (input, init) => {
        let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith('https://discord.com/api/v10/')) url = MOCK + '/api/v10/' + url.slice('https://discord.com/api/v10/'.length);
        else if (url.startsWith('https://cdn.discordapp.com/')) url = MOCK + '/cdn/' + url.slice('https://cdn.discordapp.com/'.length);
        else if (url.startsWith('https://media.discordapp.net/')) url = MOCK + '/cdn/' + url.slice('https://media.discordapp.net/'.length);
        const host = new URL(url).hostname;
        if (!loopback(host)) { note(`BLOCKED fetch ${host}`); throw new TypeError(`harness: blocked non-loopback fetch to ${host}`); }
        note(`fetch ${url.replace(/\d{15,25}/g, ':id').split('?')[0]}`);
        return realFetch(url, init);
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
// This headless box has no system keychain: the real main process would block forever on its
// "Encryption at rest disabled" native modal (Xvfb, no window manager). Auto-acknowledge ONLY that dialog.
const M = require('module');
const origLoad = M._load;
M._load = function (request, ...rest) {
    const mod = origLoad.call(this, request, ...rest);
    if (request === 'electron' && mod && mod.dialog && !mod.dialog.__harnessPatched) {
        const orig = mod.dialog.showMessageBox.bind(mod.dialog);
        mod.dialog.showMessageBox = async (...args) => {
            const opts = args.find(a => a && typeof a === 'object' && 'title' in a);
            if (opts && opts.title === 'Encryption at rest disabled') { note('auto-acknowledged: Encryption at rest disabled'); return { response: 0, checkboxChecked: false }; }
            // The background-import quit prompt (discord-import/quit-guard.ts): this box has no window manager to
            // click it, so log what it says and answer from $QUIT_ANSWER_FILE ("quit" -> Quit anyway, else Keep importing).
            if (opts && opts.title === 'Import running') {
                let ans = 'keep';
                try { ans = fs.readFileSync(process.env.QUIT_ANSWER_FILE || '', 'utf8').trim() || 'keep'; } catch { /* keep */ }
                note(`QUIT PROMPT shown: "${opts.message}" / "${opts.detail}" buttons=${JSON.stringify(opts.buttons)} -> answered ${ans}`);
                return { response: ans === 'quit' ? 1 : 0, checkboxChecked: false };
            }
            return orig(...args);
        };
        mod.dialog.__harnessPatched = true;
    }
    return mod;
};
note(`main-redirect loaded pid=${process.pid}`);
