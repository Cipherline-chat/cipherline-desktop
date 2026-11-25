// "You're leaving Cipherline" in the REAL dev Electron: this worktree's main +
// preload + CSP + encrypted secureLocalStore, renderer from this worktree's own
// Vite, API pinned to a loopback stub. shell.openExternal is replaced IN MAIN
// by a recorder, so "what reached the OS" is observed at the real sink and no
// browser is launched. Pages: harness/leaving-dialog-main.tsx.
//
//   npx tsc -p tsconfig.electron.json
//   STUB_PORT=13293 STUB_LOG=<file> node harness/loopback-api-stub.mjs &
//   VITE_API_HOST=127.0.0.1:13293 npx vite --port 5293 --strictPort --host 127.0.0.1 &
//   OUT=<dir> LD_PORT=5293 STUB_PORT=13293 xvfb-run -a -s "-screen 0 2200x1400x24" node harness/leaving-dialog-electron.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { _electron } = require('/home/antigravity/Cipherline/node_modules/playwright-core');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const OUT = process.env.OUT;
const PORT = process.env.LD_PORT ?? '5293';
const STUB = process.env.STUB_PORT ?? '13293';
const SIZES = (process.env.SIZES ?? '1000x720,1366x768').split(',').map((s) => s.split('x').map(Number));
const THEMES = (process.env.THEMES ?? 'dark,light').split(',');
const SHOTS = ['normal', 'masked', 'idn', 'mailto', 'idn-ok'];
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = (qs) => `http://127.0.0.1:${PORT}/harness/leaving-dialog.html?${qs}`;
const results = { checks: {} };
const check = (name, ok, detail) => { results.checks[name] = { ok: !!ok, ...(detail !== undefined ? { detail } : {}) }; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ''}`); };

const profile = fs.mkdtempSync(path.join(process.env.PROFILE_ROOT ?? os.tmpdir(), 'ld-profile-'));
const app = await _electron.launch({
    executablePath: path.join(APP, 'node_modules/electron/dist/electron'),
    args: [APP, '--no-sandbox', `--user-data-dir=${profile}`, '--password-store=basic', '--force-device-scale-factor=1'],
    cwd: APP,
    env: { ...process.env, VITE_DEV_SERVER_URL: `http://127.0.0.1:${PORT}`, VITE_API_HOST: `127.0.0.1:${STUB}`, ELECTRON_ENABLE_LOGGING: '1' },
    timeout: 120000,
});
const answerKeyringDialog = () => {
    try {
        const id = execFileSync('xdotool', ['search', '--name', 'Encryption at rest disabled'], { encoding: 'utf8' }).trim().split('\n')[0];
        if (id) { execFileSync('xdotool', ['windowfocus', '--sync', id]); execFileSync('xdotool', ['key', '--window', id, 'Return']); }
    } catch { /* not up yet */ }
};
let win = null;
for (let i = 0; i < 240 && !win; i++) {
    win = app.windows().find((w) => w.url().startsWith(`http://127.0.0.1:${PORT}`)) ?? null;
    if (!win) { answerKeyringDialog(); await sleep(500); }
}
if (!win) throw new Error('no main window');
const consoleLog = [];
win.on('console', (m) => consoleLog.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
win.on('pageerror', (e) => consoleLog.push(`[pageerror] ${String(e).slice(0, 300)}`));
const bail = async (e) => {
    console.log('HARNESS ERROR', e?.message ?? e);
    console.log(consoleLog.slice(-25).join('\n'));
    try { await win.screenshot({ path: path.join(OUT, '_error.png') }); } catch { /* window gone */ }
    try { await app.close(); } catch { /* already */ }
    process.exit(2);
};
process.on('unhandledRejection', bail);
process.on('uncaughtException', bail);

// The real sink, observed: record what main would hand to the OS.
const patched = await app.evaluate(({ shell }) => {
    globalThis.__opened = [];
    shell.openExternal = async (u) => { globalThis.__opened.push(u); };
    return typeof shell.openExternal;
});
const opened = () => app.evaluate(() => globalThis.__opened.slice());
const clearOpened = () => app.evaluate(() => { globalThis.__opened.length = 0; });
results.shellPatched = patched;

const setSize = (w, h) => app.evaluate(({ BrowserWindow }, [w, h]) => {
    const bw = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('127.0.0.1')) ?? BrowserWindow.getAllWindows()[0];
    if (bw.isMaximized()) bw.unmaximize();
    bw.setContentSize(w, h);
    return bw.getContentSize();
}, [w, h]);
const load = async (qs) => {
    await win.goto(PAGE(qs));
    await win.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
    await sleep(600);
};
const linkIn = (shot) => win.locator(`[data-row="${shot}"] [data-link], [data-row="${shot}"] .cl-fmt-link`).first();
const dialogOpen = () => win.locator('.lcd-card').first().isVisible().catch(() => false);
const waitDialog = () => win.locator('.lcd-card').first().waitFor({ state: 'visible', timeout: 8000 });
const waitClosed = () => win.waitForFunction(() => !document.querySelector('.mod.open .lcd-card'), null, { timeout: 8000 });
const focused = () => win.evaluate(() => (document.activeElement?.textContent ?? '').trim().slice(0, 60));

// ── screenshots: the dialog per kind × theme × size ─────────────────────────
for (const theme of THEMES) {
    for (const [w, h] of SIZES) {
        await setSize(w, h);
        await load(`role=chat&theme=${theme}`);
        for (const shot of SHOTS) {
            await linkIn(shot).click();
            await waitDialog();
            await sleep(450); // ClModal's entrance
            const file = `${shot}-${theme}-${w}x${h}.png`;
            await win.screenshot({ path: path.join(OUT, file) });
            if (theme === THEMES[0] && w === SIZES[0][0]) results[`focus_${shot}`] = await focused();
            await win.keyboard.press('Escape');
            await waitClosed();
            await sleep(300);
        }
        // Settings → Privacy: the two toggles, then Trusted websites with ~60 sites.
        await load(`role=settings&theme=${theme}`);
        const toTop = (sel) => win.evaluate((s) => { const el = document.querySelector(s); const sc = document.getElementById('settings-scroll'); sc.scrollTop += el.getBoundingClientRect().top - 16; }, sel);
        await toTop('[data-setting="link-warnings"]');
        await sleep(300);
        await win.screenshot({ path: path.join(OUT, `settings-toggles-${theme}-${w}x${h}.png`) });
        await win.locator('button[aria-label="Warn before opening links"]').click();
        await sleep(200);
        await win.locator('button[aria-label="Still warn about suspicious links"]').click();
        await sleep(400);
        await win.screenshot({ path: path.join(OUT, `settings-toggles-both-off-${theme}-${w}x${h}.png`) });
        if (theme === THEMES[0] && w === SIZES[0][0]) results.prefsAfterBothOff = await win.evaluate(() => window.__prefs());
        await win.evaluate(() => window.__setPrefs({ warn: true, warnSuspicious: true }));
        await sleep(200);
        await toTop('[data-setting="trusted-websites"]');
        await sleep(300);
        await win.screenshot({ path: path.join(OUT, `settings-trusted-${theme}-${w}x${h}.png`) });
        if (theme === THEMES[0] && w === SIZES[0][0]) {
            results.scroll = await win.evaluate(() => {
                const sc = document.querySelector('[data-tws-scroll]');
                const card = document.querySelector('[data-setting="trusted-websites"]');
                return { items: sc.querySelectorAll('.tws-item').length, scrollHeight: sc.scrollHeight, clientHeight: sc.clientHeight, cardHeight: Math.round(card.getBoundingClientRect().height), count: document.querySelector('[data-tws-count]').textContent };
            });
        }
        // Scrolled to the bottom of the list (proves the inner scroll).
        await win.evaluate(() => { const sc = document.querySelector('[data-tws-scroll]'); sc.scrollTop = sc.scrollHeight; });
        await sleep(250);
        await win.screenshot({ path: path.join(OUT, `settings-trusted-scrolled-${theme}-${w}x${h}.png`) });
        await win.locator('input[aria-label="Search trusted websites"]').click();
        await win.keyboard.type('git', { delay: 40 });
        await sleep(300);
        await win.screenshot({ path: path.join(OUT, `settings-search-${theme}-${w}x${h}.png`) });
        if (theme === THEMES[0] && w === SIZES[0][0]) {
            await win.keyboard.press('Enter');
            results.searchGit = await win.evaluate(() => ({ rows: [...document.querySelectorAll('.tws-domain')].map((e) => e.firstChild.textContent), count: document.querySelector('[data-tws-count]').textContent, trusted: window.__trusted().length }));
            await win.keyboard.press('Control+A'); await win.keyboard.type('BÜCHER');
            await sleep(200);
            results.searchIdn = await win.evaluate(() => [...document.querySelectorAll('.tws-domain')].map((e) => e.firstChild.textContent));
            await win.keyboard.press('Control+A'); await win.keyboard.type('xn--fiqs');
            await sleep(200);
            results.searchPuny = await win.evaluate(() => [...document.querySelectorAll('.tws-domain')].map((e) => e.firstChild.textContent));
        }
        await win.keyboard.press('Control+A');
        await win.keyboard.type('nothing-matches-this', { delay: 10 });
        await sleep(300);
        await win.screenshot({ path: path.join(OUT, `settings-search-empty-${theme}-${w}x${h}.png`) });
    }
}
check('screens: nothing reached shell.openExternal while shooting (every dialog cancelled with Esc)', (await opened()).length === 0, await opened());
check('settings: both toggles can be turned off by real clicks', results.prefsAfterBothOff?.warn === false && results.prefsAfterBothOff?.warnSuspicious === false, results.prefsAfterBothOff);
check('settings: 60 sites scroll INSIDE a bounded list (scrollHeight > clientHeight, height <= 320)', results.scroll?.items === 60 && results.scroll.scrollHeight > results.scroll.clientHeight && results.scroll.clientHeight <= 320 && results.scroll.count === '60 trusted websites', results.scroll);
check('settings: search filters as you type; Enter removes nothing', results.searchGit?.rows.includes('github.com') && results.searchGit.rows.includes('gitlab.com') && results.searchGit.rows.every((r) => r.includes('git')) && results.searchGit.trusted === 60, results.searchGit);
check('settings: search is IDN-aware (Unicode and punycode)', JSON.stringify(results.searchIdn) === JSON.stringify(['bücher.example']) && JSON.stringify(results.searchPuny) === JSON.stringify(['中国.cn']), { idn: results.searchIdn, puny: results.searchPuny });
check('screens: focus starts on Cancel in every dialog kind', SHOTS.every((s) => results[`focus_${s}`] === 'Cancel'), SHOTS.map((s) => results[`focus_${s}`]));

// ── behaviour, on the real renderer + real main sink ────────────────────────
await setSize(1366, 768);
await load('role=chat&theme=dark');
await clearOpened();

// 1. Crafted calls with no click of their own: refused. (Playwright's evaluate
//    runs WITH a CDP user gesture, so userActivation is even active here: the
//    gate's trusted-event check is what refuses it.)
const crafted = await win.evaluate(() => [
    window.__openExternalLink('https://example.com/phish'),
    window.__openExternalLink('https://cipherline.chat/'),
    window.__openExternalLink('https://x.example/', { label: 'paypal.com' }),
]);
await sleep(300);
check('crafted direct call is refused (untrusted, trusted, masked)', crafted.every((r) => r.ok === false && r.reason === 'no-user-gesture') && !(await dialogOpen()) && (await opened()).length === 0, crafted);
// 1a. A script-dispatched click on the real link element (isTrusted false).
await win.evaluate(() => { document.querySelector('[data-row="normal"] [data-link]').click(); document.querySelector('[data-row="trusted"] [data-link]').click(); });
await sleep(300);
check('script-dispatched clicks on real links are refused (no dialog, nothing opened)', !(await dialogOpen()) && (await opened()).length === 0);
// 1b. A timer firing right after a REAL click elsewhere (userActivation still active): refused.
await win.mouse.click(700, 600);
const timerResult = await win.evaluate(() => new Promise((res) => setTimeout(() => res([navigator.userActivation.isActive, window.__openExternalLink('https://cipherline.chat/'), window.__openExternalLink('https://example.com/')]), 150)));
await sleep(200);
check('a timer right after a real click (activation still live) is refused', timerResult[0] === true && timerResult[1].ok === false && timerResult[2].ok === false && !(await dialogOpen()) && (await opened()).length === 0, timerResult);

// 1b. Positive control: the SAME untrusted URL from a real click raises the dialog.
await linkIn('normal').click();
await waitDialog();
check('control: a real click on the same kind of link raises the dialog', await dialogOpen(), await win.evaluate(() => window.__pending()));
// A pending dialog cannot be confirmed by script either.
const scriptedConfirm = await win.evaluate(() => {
    const btn = document.querySelector('.lcd-card .lcd-visit button, .lcd-card .lcd-visit');
    return !!btn;
});
results.visitButtonFound = scriptedConfirm;
await win.keyboard.press('Escape');
await waitClosed();
check('Esc cancels: nothing opened', (await opened()).length === 0);

// 2. Keyboard: Enter on the focused link opens the dialog, focus on Cancel; Enter there cancels.
await linkIn('normal').focus();
await win.keyboard.press('Enter');
await waitDialog();
await sleep(250);
const f1 = await focused();
await win.keyboard.press('Tab');
const f2 = await focused();
await win.keyboard.press('Tab');
const f3 = await focused();
await win.keyboard.press('Tab');
const f4 = await focused();
check('keyboard: focus Cancel → Tab Visit site → Tab trust box → Tab wraps to Cancel', f1 === 'Cancel' && f2 === 'Visit site' && /^Always trust links to/.test(f3) && f4 === 'Cancel', [f1, f2, f3, f4]);
await win.keyboard.press('Enter'); // on Cancel
await waitClosed();
check('keyboard: Enter on the initial focus (Cancel) opens nothing', (await opened()).length === 0);

// 3. Visit opens exactly the shown, validated href.
await linkIn('normal').click();
await waitDialog();
await win.locator('.lcd-card .lcd-visit').first().click();
await waitClosed();
const afterVisit = await opened();
check('Visit site hands exactly the validated href to the real main sink', afterVisit.length === 1 && afterVisit[0] === 'https://blog.example.com/2026/11/how-we-rebuilt-the-whole-thing-from-scratch?ref=chat&utm_source=cipherline&utm_medium=message', afterVisit);
await clearOpened();

// 4. Built-in trusted: opens directly from a click, no dialog.
await linkIn('trusted').click();
await sleep(500);
check('cipherline.chat opens directly, no dialog', !(await dialogOpen()) && (await opened()).join() === 'https://cipherline.chat/changelog', await opened());
await clearOpened();

// 5. Masked mismatch: no trust box offered, Visit is "Visit anyway".
await linkIn('masked').click();
await waitDialog();
const masked = await win.evaluate(() => ({
    mismatch: document.querySelector('[data-lcd-mismatch]')?.textContent?.trim(),
    trustBox: !!document.querySelector('.lcd-trust'),
    visit: document.querySelector('.lcd-card .lcd-visit')?.textContent?.trim(),
    site: document.querySelector('[data-lcd-site]')?.textContent,
}));
check('masked mismatch: warning line, bold real site, no trust box, "Visit anyway"', masked.mismatch === 'The link text says paypal.com but it goes to paypa1-secure.example.' && !masked.trustBox && masked.visit === 'Visit anyway' && masked.site === 'paypa1-secure.example', masked);
await win.keyboard.press('Escape');
await waitClosed();

// 6. IDN: punycode shown for the mixed-script host.
await linkIn('idn').click();
await waitDialog();
const idn = await win.evaluate(() => ({ site: document.querySelector('[data-lcd-site]')?.textContent, url: document.querySelector('[data-lcd-url]')?.textContent }));
check('IDN аpple.com is shown as punycode xn--pple-43d.com', idn.site === 'xn--pple-43d.com' && !/аpple/.test(idn.url ?? ''), idn);
await win.keyboard.press('Escape');
await waitClosed();

// 7. "Always trust" persists per account and then skips the dialog.
await linkIn('normal').click();
await waitDialog();
await win.locator('.lcd-trust [role="checkbox"]').first().click();
await win.locator('.lcd-card .lcd-visit').first().click();
await waitClosed();
const trustedNow = await win.evaluate(() => window.__trusted());
await clearOpened();
await linkIn('normal').click();
await sleep(500);
check('ticking "Always trust" stores example.com and the next click opens with no dialog', trustedNow.includes('example.com') && !(await dialogOpen()) && (await opened()).length === 1, { trustedNow, opened: await opened() });
await clearOpened();

// 8. It survives a reload (encrypted store) and Settings can remove it.
await load('role=settings&theme=dark&seed=0');
const listed = await win.evaluate(() => [...document.querySelectorAll('.tws-domain')].map((e) => e.firstChild?.textContent));
await win.locator('button[aria-label="Remove blog.example.com from trusted websites"], button[aria-label="Remove example.com from trusted websites"]').first().click().catch(() => {});
await sleep(300);
const afterRemove = await win.evaluate(() => window.__trusted());
check('Settings lists the trusted site after a reload and Remove drops it', listed.includes('example.com') && !afterRemove.includes('example.com'), { listed, afterRemove });

// 9. And with it removed, the link asks again.
await load('role=chat&theme=dark');
await linkIn('normal').click();
await waitDialog();
check('after removal the link asks again', await dialogOpen());
await win.keyboard.press('Escape');
await waitClosed();

// 10. "Warn before opening links" OFF, "Still warn about suspicious links" ON.
const outcome = async (shot) => {
    await clearOpened();
    await linkIn(shot).click();
    await sleep(500);
    const dlg = await dialogOpen();
    if (dlg) { await win.keyboard.press('Escape'); await waitClosed(); }
    return dlg ? 'dialog' : ((await opened()).length === 1 ? 'opened' : 'nothing');
};
await win.evaluate(() => window.__setPrefs({ warn: false, warnSuspicious: true }));
const offOn = { normal: await outcome('normal'), mailto: await outcome('mailto'), masked: await outcome('masked'), idn: await outcome('idn'), idnOk: await outcome('idn-ok') };
check('warn OFF + suspicious ON: ordinary links open on click; mismatch and look-alike still ask', offOn.normal === 'opened' && offOn.mailto === 'opened' && offOn.idnOk === 'opened' && offOn.masked === 'dialog' && offOn.idn === 'dialog', offOn);

// 11. Both OFF = never warn.
await win.evaluate(() => window.__setPrefs({ warn: false, warnSuspicious: false }));
const offOff = { normal: await outcome('normal'), masked: await outcome('masked'), idn: await outcome('idn'), mailto: await outcome('mailto') };
check('both OFF: no dialog at all, every link opens on click', Object.values(offOff).every((v) => v === 'opened'), offOff);

// 12. ...and the real-click requirement still holds with warnings off.
await clearOpened();
const craftedOff = await win.evaluate(() => [window.__openExternalLink('https://example.com/phish'), window.__openExternalLink('https://x.example/', { label: 'paypal.com' })]);
await win.evaluate(() => document.querySelector('[data-row="normal"] [data-link]').click());
await win.mouse.click(700, 600);
const timerOff = await win.evaluate(() => new Promise((res) => setTimeout(() => res(window.__openExternalLink('https://example.com/')), 150)));
await sleep(300);
check('warnings off: crafted call, script click and post-click timer are all refused, nothing opened', craftedOff.every((r) => r.reason === 'no-user-gesture') && timerOff.reason === 'no-user-gesture' && (await opened()).length === 0 && !(await dialogOpen()), { craftedOff, timerOff, opened: await opened() });
await win.evaluate(() => window.__setPrefs({ warn: true, warnSuspicious: true }));

results.consoleErrors = consoleLog.filter((l) => l.startsWith('[error]')).slice(0, 20);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
await app.close();
fs.rmSync(profile, { recursive: true, force: true });
const failed = Object.entries(results.checks).filter(([, v]) => !v.ok);
console.log(failed.length ? `FAILED: ${failed.map(([k]) => k).join('; ')}` : 'ALL CHECKS PASSED');
process.exit(failed.length ? 1 : 0);
