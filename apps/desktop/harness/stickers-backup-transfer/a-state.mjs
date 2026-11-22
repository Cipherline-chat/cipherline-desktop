// Read-only probe through the app's OWN module instances (same Vite URLs the app imported): My stickers in
// order, which of their images (and of the DM's sticker messages) are readable on this device, and Recent.
export async function run(page) {
  return await page.evaluate(async () => {
    const svc = await import('/src/utils/personalEmoji/service.ts');
    const recent = await import('/src/utils/stickers/recent.ts');
    const lib = svc.personalStickers();
    const entries = lib.load().entries.slice().sort((a, b) => a.order - b.order);
    const out = { myStickers: [], imagesInStore: svc.personalEmojis().store.ids().length, recent: recent.loadRecentStickers().map((r) => r.name) };
    for (const e of entries) {
      const b = await lib.store.read(e.id);
      out.myStickers.push(`${e.name}:${b ? b.length + 'B' : 'MISSING'}`);
    }
    const imgs = [...document.querySelectorAll('.cl-sticker-msg')].map((el) => {
      const img = el.querySelector('img');
      return `${el.getAttribute('aria-label')}:${img && img.complete && img.naturalWidth > 0 ? 'drawn ' + img.naturalWidth + 'px' : 'NOT DRAWN'}`;
    });
    out.stickerMessagesOnScreen = imgs;
    return out;
  });
}
