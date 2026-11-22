// Reload the renderer (picks up source changes from the harness Vite without HMR state) and wait for the rail.
const S = process.env.S;
export default async (page) => {
    await page.reload();
    await page.waitForSelector('[data-testid="rail-scroll"]', { timeout: 180000 });
    await page.waitForTimeout(8000);
    await page.screenshot({ path: `${S}/reload.png` });
    return 'reloaded';
};
