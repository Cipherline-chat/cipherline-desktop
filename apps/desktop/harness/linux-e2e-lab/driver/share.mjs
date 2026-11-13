// Driving the real share UI: the Share Screen button, the app's own picker, the quality dropdowns and the Share button; the in-call
// "Screen share options" menu for Change source.
//   X11:            grid of sources -> Next -> settings -> Share
//   Wayland portal: ONE step ("share-portal-step": quality + audio kind + "Choose what to share…"); the desktop's own dialog is the
//                   choice, and a live share can take new quality/audio with "Apply to current share" (no new dialog).
import * as L from './lab.mjs';
import { shot } from './app.mjs';

const SHARE_BTN = 'button[title="Share Screen"]';
async function vis(page, sel, ms = 300) { try { return await page.locator(sel).first().isVisible({ timeout: ms }); } catch { return false; } }

/** Opens the picker (hover first, like a person does). Returns 'portal' | 'grid' | 'settings'. */
export async function openPicker(page, { timeout = 60000, viaMenu = false } = {}) {
  if (!viaMenu) { await page.locator(SHARE_BTN).hover().catch(() => {}); await L.sleep(400); await page.locator(SHARE_BTN).click(); }
  await page.waitForSelector('text=Share Your Screen', { timeout: 15000 });
  return pickerStep(page, timeout);
}

export async function pickerStep(page, timeout = 60000) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    if (await vis(page, '[data-testid="share-portal-step"]')) return 'portal';
    if (await vis(page, 'text=Resolution')) return 'settings';
    if (await vis(page, 'text=Choose what to share') && (await page.locator('img[alt]').count()) > 0) return 'grid';
    await L.sleep(500);
  }
  throw new Error('picker neither showed sources, settings nor the portal step');
}

export async function dropdown(page, label, optionText) {
  // CustomDropdown: the label span is followed by the dropdown trigger; options render as a list with their label text
  const row = page.locator(`*:has(> span:text-is("${label}"))`).last();
  await row.locator('button, [role=button], [role=combobox]').first().click({ timeout: 8000 });
  await L.sleep(250);
  await page.locator(`text="${optionText}"`).last().click({ timeout: 8000 });
  await L.sleep(250);
}

/** Choose a source in the grid by (part of) its tile name, then Next. */
export async function chooseTile(page, nameRe) {
  const tiles = page.locator('img[alt]');
  const n = await tiles.count();
  for (let i = 0; i < n; i++) {
    const alt = await tiles.nth(i).getAttribute('alt');
    if (nameRe.test(alt || '')) { await tiles.nth(i).click({ force: true }); await page.locator('button:has-text("Next")').click(); await page.waitForSelector('text=Resolution', { timeout: 15000 }); return alt; }
  }
  throw new Error(`no picker tile matching ${nameRe}; have: ${(await Promise.all([...Array(n).keys()].map((i) => tiles.nth(i).getAttribute('alt')))).join(' | ')}`);
}

export let lastShare = {};

/** Portal step, audio kind 'One app': open the app list and pick the app whose name matches. Returns the chosen label. */
export async function pickApp(page, re) {
  const trigger = page.locator('[data-testid="share-audio-app"] button').first();
  await trigger.click({ timeout: 8000 });
  await L.sleep(2000);   // the list is read when it opens
  const hit = page.getByText(re).last();
  if (!(await hit.count())) throw new Error('no app in the list matching ' + re);
  const label = (await hit.innerText()).trim();
  await hit.click({ timeout: 8000 });
  await L.sleep(300);
  return label;
}

/**
 * Settings: resolution label ('Source (Native)' | '1920×1080' ...), frame rate label ('Up to 90 fps' | '60 fps' ...), audio, then go.
 * audio: true | false | null (leave the default) | 'None' | 'Everything except Cipherline' | 'One app' (portal step only).
 * apply: portal step on a live share: press "Apply to current share" instead of "Choose what to share…" (no new dialog).
 */
export async function settingsAndShare(page, { resolution, fps, audio = true, apply = false, appRe = null }) {
  const portal = await vis(page, '[data-testid="share-portal-step"]');
  if (resolution) await dropdown(page, 'Resolution', resolution);
  if (fps) await dropdown(page, 'Frame Rate', fps);
  if (portal) {
    const kind = audio === null || audio === undefined ? null : audio === true ? 'Everything except Cipherline' : audio === false ? 'None' : audio;
    if (kind) await dropdown(page, 'Share audio', kind);
    if (kind === 'One app' && appRe) await pickApp(page, appRe);
    const shown = (await page.locator('[data-testid="share-audio-portal"]').innerText({ timeout: 2000 }).catch(() => '')).replace(/\s+/g, ' ').trim();
    lastShare = { step: 'portal', audio_kind: kind ?? '(default)', audio_control_text: shown, apply };
    await page.locator(apply ? 'button:has-text("Apply to current share")' : 'button:has-text("Choose what to share")').last().click({ timeout: 15000 });
    return;
  }
  const box = page.locator('[data-testid="share-audio-toggle"] [role=checkbox], [data-testid="share-audio-toggle"] input[type=checkbox], [data-testid="share-audio-toggle"] button').first();
  if (audio === null) { lastShare = { step: 'settings', audio_enabled: null, note: 'left at the picker default' }; await page.locator('button:has-text("Share")').last().click(); return; }
  let enabled = false;
  for (let i = 0; i < 8; i++) { if (await box.isEnabled({ timeout: 1000 }).catch(() => false)) { enabled = true; break; } await L.sleep(500); }
  const why = enabled ? null : (await page.locator('[data-testid="share-audio-toggle"]').innerText({ timeout: 1000 }).catch(() => '')).trim();
  const state = await box.getAttribute('aria-checked', { timeout: 1000 }).catch(() => null);
  if (enabled && typeof audio === 'boolean' && state !== null && (state === 'true') !== audio) await box.click();
  const finalState = await box.getAttribute('aria-checked', { timeout: 1000 }).catch(() => null);
  lastShare = { step: 'settings', audio_enabled: enabled, audio_disabled_reason: why, audio_checked_when_sharing: finalState };
  await page.locator('button:has-text("Share")').last().click();
}

/** Waits until the app says it is sharing (the control bar's stop button appears). */
export async function waitSharing(page, ms = 60000) { await page.waitForSelector('.cl-share-stop', { timeout: ms }); }
export const isSharing = (page) => page.locator('.cl-share-stop').count().then((n) => n > 0);
export async function stopSharing(page) { await page.locator('.cl-share-stop').first().click({ force: true }); await L.sleep(1500); }
export { shot };

/** The share options chevron -> "Change Source" (opens the picker mid-share). */
export async function openChangeSource(page) {
  await page.locator('button[title="Screen share options"]').click({ timeout: 10000 });
  await L.sleep(500);
  await page.locator('text=Change Source').first().click({ timeout: 10000 });
  return openPicker(page, { viaMenu: true });
}

/** The viewer opts in to watching (the Watch gate): until then the SFU pauses every layer and the sharer encodes nothing. */
export async function watch(page, ms = 12000) {
  // a viewer that is still watching this sharer from an earlier share in the call has no gate: then there is nothing to press
  const b = page.locator(".ss-gate-enter, button:has-text(\"Watch\")").first();
  try { await b.waitFor({ state: "visible", timeout: ms }); } catch { return false; }
  await b.click({ force: true });
  await L.sleep(1500);
  return true;
}
