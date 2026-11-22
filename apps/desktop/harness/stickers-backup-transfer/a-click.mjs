// Click things in order. Each arg: "text:Foo" (exact visible text), "role:Name" (button by accessible name),
// "css:selector", "nth:selector:index", "key:Escape", or "wait:ms".
export async function run(page, steps) {
  for (const s of steps) {
    const [kind, ...restParts] = s.split(':');
    const rest = restParts.join(':');
    if (kind === 'text') await page.getByText(rest, { exact: true }).first().click({ timeout: 30000 });
    else if (kind === 'role') await page.getByRole('button', { name: rest, exact: true }).first().click({ timeout: 30000 });
    else if (kind === 'css') await page.locator(rest).first().click({ timeout: 30000 });
    else if (kind === 'nth') { const i = rest.lastIndexOf(':'); await page.locator(rest.slice(0, i)).nth(Number(rest.slice(i + 1))).click({ timeout: 30000 }); }
    else if (kind === 'key') await page.keyboard.press(rest);
    else if (kind === 'wait') await page.waitForTimeout(Number(rest));
    await page.waitForTimeout(800);
  }
}
