// A too-early send the SERVER refuses. Send one message in #general (opens the 30 s window on the server), then
// forget this client's local countdown (what a second device or a restart looks like: the app's own module,
// channelModeration.resetSlowmodeClockForTests, same instance via Vite), and send again inside the window. The real
// ChatPane must show the failed state ("Slowmode: wait ..."), not retry. Screenshot $S/sm-too-early.png.
export default async (page) => {
  const S = process.env.S;
  const box = () => page.locator('[contenteditable="true"], textarea').last();
  await box().click();
  await page.keyboard.type('Opening the window');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  await page.evaluate(async () => { const m = await import('/src/utils/channelModeration.ts'); m.resetSlowmodeClockForTests(); });
  await box().click();
  await page.keyboard.type('Sent too early');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${S}/sm-too-early.png` });
  return await page.evaluate(() => document.querySelector('main, [role=main]')?.textContent?.replace(/\s+/g, ' ').slice(-260));
};
