// Driving the REAL Cipherline renderer (over CDP) through its real UI: sign-in, 2FA, onboarding prompts, DM call.
import * as L from './lab.mjs';
import fs from 'node:fs';
import path from 'node:path';

export const shot = async (page, name, dir = L.RESULTS + '/shots') => { fs.mkdirSync(dir, { recursive: true }); const p = path.join(dir, name + '.png'); await page.screenshot({ path: p }).catch(() => {}); return p; };
export const bodyText = (page) => page.innerText('body').catch(() => '');

async function visible(page, sel, ms = 400) { try { return await page.locator(sel).first().isVisible({ timeout: ms }); } catch { return false; } }

/** Real sign-in: email + password, the emailed 2FA code (read from the lab API's own log), "No history on this device" -> Start fresh, storage defaults. */
export async function signIn(page, acct) {
  const t0 = Math.floor(Date.now() / 1000) - 1;
  await page.waitForSelector('input[type=email], input[placeholder="Email"]', { timeout: 60000 });
  await page.fill('input[type=email], input[placeholder="Email"]', acct.email);
  await page.fill('input[type=password], input[placeholder="Password"]', acct.password);
  await page.locator('button:has-text("Sign in")').last().click();
  await page.waitForSelector('text=Two-step verification', { timeout: 30000 });
  const code = await L.emailedCode(acct.email, { since: t0 });
  await page.locator('input').first().click();
  await page.keyboard.type(code, { delay: 60 });
  await page.locator('button:has-text("Verify and sign in")').click().catch(() => {});
  await dismissOnboarding(page);
}

/** From the Home deck's friend row into the DM (the row is disabled until the DM exists; ensureDm + reload first). */
export async function openDm(page) {
  await page.locator('button.hd-row:not([disabled])').first().click({ timeout: 30000 });
  await page.waitForSelector('text=Message…', { timeout: 15000 }).catch(() => {});
}

/** The DM header's voice / video call button (icon buttons without labels: located by position in the chat header). */
export async function clickCallButton(page, kind = 'voice') {
  // find the header's icon buttons by geometry (they carry no label): small buttons in the top band of the chat column, left to right
  const hit = await page.evaluate((k) => {
    const bs = [...document.querySelectorAll('button')].map((b) => ({ b, r: b.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 20 && r.width < 48 && r.height < 48 && r.x > 700 && r.x < 960 && r.y > 40 && r.y < 160);
    if (!bs.length) return false;
    const y = Math.min(...bs.map(({ r }) => r.y)); const row = bs.filter(({ r }) => Math.abs(r.y - y) < 6).sort((a, c) => a.r.x - c.r.x);
    const tgt = row[k === 'voice' ? 0 : 1]; if (!tgt) return false; tgt.b.click(); return true;
  }, kind);
  if (!hit) throw new Error('no call button found in the DM header');
}

/** The callee side: an incoming-call prompt (Accept) or the DM's "Join Call" card. */
export async function answerCall(page, ms = 30000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    for (const sel of ['button:has-text("Accept")', 'button:has-text("Join Call")', 'button:has-text("Answer")']) {
      if (await visible(page, sel)) { await page.locator(sel).first().click(); return sel; }
    }
    await L.sleep(500);
  }
  throw new Error('no incoming call / Join Call on the viewer: ' + (await bodyText(page)).slice(0, 200));
}

/** Everything a fresh device throws up before the Dashboard is usable (first-device and added-device variants). */
export async function dismissOnboarding(page, ms = 90000, quietCycles = 14) {
  const t = Date.now(); let quiet = 0; const clicks = {};
  const dismissers = ['button:has-text("Start fresh")', 'button:has-text("Use recommended")', 'button:has-text("Looks right")'];
  while (Date.now() - t < ms) {
    let acted = false;
    for (const sel of dismissers) if ((clicks[sel] ?? 0) < 3 && await visible(page, sel, 300)) { clicks[sel] = (clicks[sel] ?? 0) + 1; await page.locator(sel).first().click().catch(() => {}); acted = true; await L.sleep(900); }
    const home = await visible(page, '[title="Direct messages"], [aria-label="Direct messages"]', 300);
    if (!acted && home) { if (++quiet >= quietCycles) return true; } else quiet = 0;
    await L.sleep(500);
  }
  throw new Error('dashboard never became usable: ' + (await bodyText(page)).slice(0, 200));
}

async function openSettings(page, section) {
  await page.locator('button[title="Settings"]').click();
  await page.waitForSelector(`text=${section}`, { timeout: 15000 });
  await page.locator(`nav >> text=${section}`).first().click().catch(() => page.locator(`text=${section}`).first().click());
  await L.sleep(1200);
}
const closeSettings = async (page) => { await page.keyboard.press('Escape'); await L.sleep(800); };

/**
 * The viewer's microphone carries a pure 440 Hz tone (the "call's own audio" the sharer's app plays back). The app's voice processing
 * (RNNoise noise suppression, the voice gate, AGC) treats a pure tone as noise and removes it, so turn those off, by UI, on the viewer.
 */
export async function rawMicSettings(page) {
  await openSettings(page, 'Voice & Video');
  await page.locator('text=Voice processing').first().scrollIntoViewIfNeeded();
  await page.locator('[role=radiogroup] [role=radio]:has-text("Off")').first().click();
  for (const label of ['Voice gate', 'Auto gain control', 'Normalize voice volume']) {
    const sw = page.locator(`[role=switch][aria-label="${label}"]`).first();
    if (await sw.count() && (await sw.getAttribute('aria-checked')) === 'true') await sw.click();
  }
  await L.sleep(500);
  await closeSettings(page);
}

/** Settings -> Advanced -> "Screen share & stream stats" -> Show stream stats (the app's own stats overlay + Copy call log). */
export async function enableStreamStats(page) {
  await openSettings(page, 'Advanced');
  await page.locator('text=Screen share & stream stats').first().scrollIntoViewIfNeeded();
  await page.locator('text=Screen share & stream stats').first().click();
  await L.sleep(700);
  const tog = page.locator('.sd-row:has-text("Show stream stats") [role=switch]').first();
  if ((await tog.getAttribute('aria-checked')) !== 'true') await tog.click({ force: true });
  await L.sleep(500);
  await closeSettings(page);
}
