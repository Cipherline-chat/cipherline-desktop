// Click the first element whose visible text matches args[0] (a regex), wait, screenshot to $S/click.png.
const S = process.env.S;
export default async (page, { args }) => {
    await page.getByText(new RegExp(args[0])).first().click({ timeout: 30000 });
    await page.waitForTimeout(Number(args[1] ?? 4000));
    await page.screenshot({ path: `${S}/click.png` });
    return await page.evaluate(() => document.body.innerText.slice(0, 300));
};
