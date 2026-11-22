// Debug: list visible buttons' accessible names (or a CSS selector's matches with args[0]).
export async function run(page, [sel]) {
  return await page.evaluate((s) => [...document.querySelectorAll(s || 'button, [role="button"], a')]
    .filter((e) => e.getBoundingClientRect().width > 0)
    .map((e) => `${e.tagName.toLowerCase()} [${e.getAttribute('aria-label') || ''}] ${(e.textContent || '').trim().slice(0, 40)}${e.disabled ? ' (disabled)' : ''}`)
    .join('\n'), sel);
}
