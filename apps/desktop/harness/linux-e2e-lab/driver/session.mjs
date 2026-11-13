// Brings two real clients up on the lab and gets them into one DM call.
import * as L from './lab.mjs';
import * as A from './app.mjs';

/** Starts both containers (sharer on `desktop`, viewer on x11), signs both in through the real UI, opens the DM. */
export async function attach() {
  const accts = await L.ensureAccounts();
  const [s, v] = await Promise.all([L.connectApp('sharer', 20), L.connectApp('viewer', 20)]);
  await Promise.all([A.dismissOnboarding(s.page), A.dismissOnboarding(v.page)]);
  return { accts, s, v };
}

export async function bringUp({ desktop = 'x11', sharerOpts = {}, viewerOpts = {} } = {}) {
  const accts = await L.ensureAccounts();
  let dm = await L.ensureDm(accts).catch(() => null); // needs a registered device: exists after the first run of this lab boot
  L.stopClients();
  L.startClient('sharer', desktop, sharerOpts);
  L.startClient('viewer', 'x11', { cpus: '3', ...viewerOpts });
  await Promise.all([L.waitReady('sharer', 150000), L.waitReady('viewer', 150000)]);
  const [s, v] = await Promise.all([L.connectApp('sharer', 90), L.connectApp('viewer', 90)]);
  await Promise.all([A.signIn(s.page, accts.labsharer), A.signIn(v.page, accts.labviewer)]);
  await Promise.all([A.dismissOnboarding(s.page), A.dismissOnboarding(v.page)]);
  await A.rawMicSettings(v.page); // pure-tone "call audio": switch off noise suppression / voice gate / AGC on the viewer's mic
  await A.enableStreamStats(s.page);
  if (!dm) { await L.ensureDm(accts); await Promise.all([s.page.reload(), v.page.reload()]); await L.sleep(4000); await Promise.all([A.dismissOnboarding(s.page), A.dismissOnboarding(v.page)]); }
  await Promise.all([A.openDm(s.page), A.openDm(v.page)]);
  return { accts, s, v };
}

/** After a failed scenario: close the picker / menus and stop any share, so the next scenario starts from "in a call, not sharing". */
export async function recover({ s, v }) {
  for (const pg of [s.page, v.page]) {
    try {
      for (let i = 0; i < 3; i++) {
        const cancel = pg.locator('button:has-text("Cancel")').first();
        if (await cancel.isVisible().catch(() => false)) await cancel.click().catch(() => {}); else await pg.keyboard.press('Escape');
        await L.sleep(500);
      }
      const stop = pg.locator('.cl-share-stop').first();
      if (await stop.count()) { await stop.click({ force: true }).catch(() => {}); await L.sleep(2500); }
    } catch { /* best effort */ }
  }
}

/** Sharer rings the viewer from the DM header's phone button; the viewer joins from its DM. Returns once both show in-call UI. */
export async function startCall({ s, v }) {
  // a call left running by a previous attempt (reload does not end it server-side) shows as "Join Call": rejoin instead of ringing
  for (const pg of [s.page, v.page]) { const r = pg.locator('button:has-text("Rejoin")').first(); if (await r.isVisible().catch(() => false)) { await r.click(); await L.sleep(3500); } }
  if (await s.page.locator('button:has-text("Leave Call")').first().isVisible().catch(() => false)) { /* already in (rejoined) */ }
  else if (await s.page.locator('button:has-text("Join Call")').first().isVisible().catch(() => false)) await s.page.locator('button:has-text("Join Call")').first().click();
  else await A.clickCallButton(s.page, 'voice');
  await L.sleep(2500);
  if (!(await v.page.locator('button:has-text("Leave Call")').first().isVisible().catch(() => false))) await A.answerCall(v.page);
}
