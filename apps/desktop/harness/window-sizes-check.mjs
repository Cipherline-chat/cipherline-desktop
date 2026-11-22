// Window-size layout check (CLAUDE.md: "Every UI change is checked at several
// window sizes before it is called done"). Every screen of the 2026-11-17 round
// x every window size, with an automated overflow / off-screen / overlap check
// and a screenshot per case.
//
//   WS_PORT=5391 npx vite --config harness/window-sizes.vite.config.ts           (another shell)
//   SR_PORT=5311 npx vite --config harness/settings-redesign.vite.config.ts      (another shell; settings cases)
//   node harness/window-sizes-check.mjs --out=<dir> [--only=<screen,...>] [--sizes=min,laptop,large,hidpi,floor]
//        [--scales=100,125,150,200] [--text=12,15,24]   (Interface size / Message text size, see SCALES below)
//
// Sizes: min = 1000x720 (electron/main.ts minWidth/minHeight), laptop = 1366x768,
// large = 1920x1080, hidpi = 1280x800 @ deviceScaleFactor 1.5.
// `--only=broken` runs the positive control alone: a deliberately broken page the
// check MUST fail on (proves the check is wired).
//
// The check (in-page, `measure` below):
//   page-hscroll   the document scrolls sideways
//   overflow       an element's content is wider than its box (scrollWidth > clientWidth)
//                  and it is not an ellipsis-truncated line or a deliberate sideways scroller
//   offscreen      a floating surface (dialog / menu / popover / tooltip / fixed box) or a
//                  control inside one leaves the window, with no scroll container to reach it
//   clipped        a control (button / link / input / radio / menu item) is cut off sideways
//                  by an overflow-hidden ancestor
//   overlap        two controls overlap each other
// Exit code 1 if any case fails.
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';

const WS = `http://127.0.0.1:${process.env.WS_PORT ?? 5391}/harness/window-sizes.html`;
const SR = `http://127.0.0.1:${process.env.SR_PORT ?? 5311}/harness/settings-redesign.html`;
const out = arg('out', '/tmp/window-sizes');
const only = arg('only', '').split(',').filter(Boolean);
const SIZES = [
    { id: 'min', width: 1000, height: 720, dsf: 1 },
    { id: 'laptop', width: 1366, height: 768, dsf: 1 },
    { id: 'large', width: 1920, height: 1080, dsf: 1 },
    { id: 'hidpi', width: 1280, height: 800, dsf: 1.5 },
    // The smallest CSS viewport Interface size can produce (electron/ui-scale.ts LAYOUT_MIN_CSS): any scale
    // above 100 % at its minimum window (1250x750 @ 125 %, 1500x900 @ 150 %, ...). Opt-in: --sizes=floor.
    { id: 'floor', width: 1000, height: 600, dsf: 1, cssOnly: true },
    // A 1440p display, the smallest common one that holds 200 % (opt-in: --sizes=qhd).
    { id: 'qhd', width: 2560, height: 1440, dsf: 1, optIn: true },
].filter(s => (!arg('sizes', '') && !s.cssOnly && !s.optIn) || arg('sizes', '').split(',').includes(s.id));
fs.mkdirSync(out, { recursive: true });

// Settings → Accessibility (2026-11-20). --scales=100,125,150,200 emulates Interface size exactly as
// webContents.setZoomFactor does: the CSS viewport is the window divided by the factor and the device
// pixel ratio is multiplied by it. The window/display can only hold what electron/ui-scale.ts allows
// (maxScaleForWorkArea, mirrored below), so an impossible combination runs at the clamped scale and is
// labelled so. --text=12,15,24 sets Message text size (the two CSS vars A11yRuntime puts on <html>).
const SCALES = arg('scales', '100').split(',').map(Number).filter(Boolean);
const TEXTS = arg('text', '').split(',').map(Number).filter(Boolean);
const UI_STEPS = [80, 90, 100, 110, 125, 150, 175, 200];
const maxScaleFor = (w, h) => UI_STEPS.filter(z => z <= 100 || (Math.ceil(1000 * z / 100) <= w && Math.ceil(600 * z / 100) <= h)).pop();
const variants = (s) => {
    if (s.cssOnly) return [{ z: 'floor', eff: 100, width: s.width, height: s.height, dsf: s.dsf }];
    // a maximised window on a display of this size (DIP); the taskbar takes ~40 px
    const max = maxScaleFor(s.width, s.height - 40);
    return [...new Set(SCALES.map(z => Math.min(z, max)))].map(eff => ({
        z: eff, eff, width: Math.round(s.width * 100 / eff), height: Math.round(s.height * 100 / eff), dsf: s.dsf * eff / 100,
    }));
};
const textVariants = TEXTS.length ? TEXTS : [null];

const settle = (page, ms = 500) => page.waitForTimeout(ms);
const clickText = async (page, sel, text) => { await page.locator(sel).filter({ hasText: text }).first().click(); await settle(page, 400); };

/** screen -> cases. `url` is relative to the window-sizes page unless `base` says otherwise. */
const CASES = {
    sysrows: [
        { id: 'rest', url: 'scene=sysrows' },
        { id: 'hover', url: 'scene=sysrows&hover=1' },
        { id: 'hover-long', url: 'scene=sysrows&hover=1&long=1' },
        { id: 'hover-real', url: 'scene=sysrows&long=1', prep: async (p) => { await p.locator('[data-sys-kind="leave"]').first().hover(); await settle(p, 300); } },
    ],
    member: [
        { id: 'open', url: 'scene=member&state=open' },
        { id: 'long-names', url: 'scene=member&state=open&long=1' },
        { id: 'collapsed', url: 'scene=member&state=collapsed' },
        { id: 'stale-hidden-flag', url: 'scene=member&state=stalehidden&long=1' },
    ],
    channels: [
        { id: 'list', url: 'scene=channels' },
        { id: 'list-scrolled', url: 'scene=channels', prep: async (p) => {
            await p.evaluate(() => { for (const el of document.querySelectorAll('#pane-left *')) if (el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) el.scrollTop = el.scrollHeight; });
            await settle(p, 300);
            const t = await p.evaluate(() => document.querySelector('[data-hidden-from-members="true"]')?.getAttribute('title') ?? null);
            if (!t) throw new Error('hidden divider has no tooltip');
            await p.locator('[data-hidden-from-members="true"]').first().hover();
            await settle(p, 300);
        } },
        { id: 'create', url: 'scene=catform' },
        { id: 'create-divider-look', url: 'scene=catform', prep: async (p) => { await pickDividerLook(p); } },
        { id: 'edit-divider', url: 'scene=catform&edit=1&look=divider' },
        { id: 'edit-divider-colour', url: 'scene=catform&edit=1&look=divider', prep: async (p) => { await openColourPicker(p); } },
        { id: 'delete-only', url: 'scene=catdelete&choice=only' },
        { id: 'delete-everything', url: 'scene=catdelete&choice=everything' },
        { id: 'delete-long', url: 'scene=catdelete&choice=everything&long=1' },
    ],
    gifts: [
        { id: 'settings-section', base: SR, url: 'tab=billing', prep: async (p) => { await scrollToGift(p); } },
        { id: 'picker', url: 'scene=giftpick' },
        { id: 'picker-search', url: 'scene=giftpick', prep: async (p) => { await p.locator('input[placeholder="Search friends"]').fill('niko'); await settle(p); } },
        { id: 'payment', url: 'scene=giftpick&pre=1', prep: async (p) => {
            await p.locator('[data-testid="gift-lengths"] [role="radio"]').last().click();
            await settle(p, 200);
            await p.locator('.gft-m-foot button').first().click();
            await p.waitForSelector('[data-testid="fake-payment-element"]', { timeout: 20000 });
            await settle(p, 600);
        } },
        { id: 'success', url: 'scene=giftsuccess&card=sent' },
        { id: 'success-long', url: 'scene=giftsuccess&card=sent&long=1' },
        { id: 'success-failed-long', url: 'scene=giftsuccess&card=failed&long=1' },
        { id: 'dm-cards', url: 'scene=giftcards', prep: async (p) => { await settle(p, 1200); } },
        { id: 'dm-cards-end', url: 'scene=giftcards', prep: async (p) => { await p.evaluate(() => { const f = document.querySelector('#feed'); f.scrollTop = f.scrollHeight; }); await settle(p, 1200); } },
        { id: 'unwrap-mid', url: 'scene=unwrap', prep: async (p) => { await settle(p, 800); await clickAccept(p); await settle(p, 450); } },
        { id: 'unwrap-end', url: 'scene=unwrap', prep: async (p) => { await settle(p, 800); await clickAccept(p); await settle(p, 2600); } },
    ],
    composer: [
        { id: 'bar', url: 'scene=composer&bar=1' },
        { id: 'font-menu', url: 'scene=composer&bar=1', prep: async (p) => { await p.locator('.fmt-btn-font').first().click(); await settle(p); } },
        { id: 'size-menu', url: 'scene=composer&bar=1', prep: async (p) => { await p.locator('.fmt-btn-size').first().click(); await settle(p); } },
        { id: 'everyone', url: 'scene=everyone' },
        { id: 'invite', url: 'scene=invite', prep: async (p) => { await settle(p, 800); } },
    ],
    // The docked call console at the right panel's 240 px floor (the console-specific geometry check is
    // harness/call-controls-narrow-check.mjs; this runs the generic overflow/clip/overlap check over it).
    incall: [
        { id: 'console-240', url: 'scene=incall&selflong=1&rw=240&scroll=bottom' },
        { id: 'console-240-share', url: 'scene=incall&selflong=1&rw=240&share=1&scroll=bottom' },
    ],
    call: [
        { id: 'gate-cut-pill', url: 'scene=call' },
        { id: 'voice-settings', base: SR, url: 'tab=voice&audio=1', prep: async (p) => { await scrollToGate(p); } },
        { id: 'voice-settings-light', base: SR, url: 'tab=voice&audio=1', prep: async (p) => { await scrollToText(p, 'Steady hum'); } },
    ],
    // The composer's live card preview (2026-11-18): the box drawn inside the next message's card while you type.
    // Each case also runs `composerCardCheck` (below): the box inside the card, toolbar / chip / send outside it, the
    // card inside the composer pill, the box's own max-height and scrolling intact, the last line reachable.
    composercard: [
        { id: 'rules-fmt', url: 'scene=composer&card=rules&text=fmt', check: true, prep: async (p) => { await focusEnd(p); } },
        { id: 'rules-fmt-bar', url: 'scene=composer&card=rules&text=fmt&bar=1', check: true, prep: async (p) => { await focusEnd(p); } },
        { id: 'announcement-fmt', url: 'scene=composer&card=announcement&text=fmt', check: true, prep: async (p) => { await focusEnd(p); } },
        { id: 'warning-fmt', url: 'scene=composer&card=notice&text=fmt', check: true, prep: async (p) => { await focusEnd(p); } },
        { id: 'success-fmt', url: 'scene=composer&card=success&text=fmt', check: true, prep: async (p) => { await focusEnd(p); } },
        { id: 'success-typed', url: 'scene=composer&card=success', check: true, prep: async (p) => { await typeFormatted(p); } },
        { id: 'nudge-placeholder', url: 'scene=composer&card=nudge', check: true },
        { id: 'nudge-fmt-selected', url: 'scene=composer&card=nudge&text=fmt', check: true, prep: async (p) => { await p.locator('[data-rich-composer]').focus(); await p.keyboard.press('Control+A'); await settle(p, 200); } },
        { id: 'shadow-fmt', url: 'scene=composer&card=shadow&text=fmt', check: true, prep: async (p) => { await focusEnd(p); } },
        { id: 'rules-long-bottom', url: 'scene=composer&card=rules&text=long', check: true, prep: async (p) => { await focusEnd(p); } },
        { id: 'rules-long-top', url: 'scene=composer&card=rules&text=long', check: true, prep: async (p) => { await focusEnd(p); await p.evaluate(() => { document.querySelector('[data-rich-composer]').scrollTop = 0; }); await settle(p, 200); } },
        { id: 'autocomplete', url: 'scene=composer&card=rules&text=fmt', check: true, prep: async (p) => {
            await focusEnd(p);
            await p.keyboard.press('Shift+Enter');
            await p.keyboard.type('See #ge');
            await settle(p, 300);
            const open = await p.evaluate(() => document.body.innerText.includes('gear-talk') && document.body.innerText.includes('general'));
            if (!open) throw new Error('channel autocomplete did not open inside the styled box');
        } },
        { id: 'autocomplete-picked', url: 'scene=composer&card=rules&text=fmt', check: true, prep: async (p) => {
            await focusEnd(p);
            await p.keyboard.press('Shift+Enter');
            await p.keyboard.type('See #gen');
            await settle(p, 300);
            await p.keyboard.press('Enter');
            await settle(p, 300);
            const txt = await p.evaluate(() => document.querySelector('[data-rich-composer]').textContent);
            if (!txt.includes('See #general ')) throw new Error(`autocomplete pick did not land: ${JSON.stringify(txt.slice(-40))}`);
        } },
        // The style chip's placement (2026-11-18 follow-up): inline when there is room, its own line in the pill when not.
        { id: 'chip-long-label-empty', url: 'scene=composer&card=notice', check: true },
        { id: 'chip-steady-while-typing', url: 'scene=composer&card=notice', check: true, prep: async (p) => {
            // The placement never flips while typing (it follows the composer's WIDTH, not its text), the chip never
            // moves sideways, and on its own line it stays put vertically too.
            const at = () => p.evaluate(() => {
                const f = document.querySelector('form.cl-composer'), c = document.querySelector('[data-card-chip]').getBoundingClientRect();
                const row = f.hasAttribute('data-chip-row');
                return `${row ? 'row' : 'inline'} x=${Math.round(c.left)}${row ? ` y=${Math.round(c.top - f.getBoundingClientRect().top)}` : ''}`;
            });
            await p.locator('[data-rich-composer]').click();
            const before = await at();
            for (const chunk of ['Heads up: ', 'the build ', 'server is ', 'down tonight']) { await p.keyboard.type(chunk); if (await at() !== before) throw new Error(`chip moved while typing: ${before} -> ${await at()}`); }
            await p.keyboard.press('Shift+Enter');
            await p.keyboard.type('back by 9');
            if (await at() !== before) throw new Error(`chip moved after a new line: ${before} -> ${await at()}`);
        } },
        { id: 'chip-x-by-keyboard', url: 'scene=composer&card=rules', check: false, prep: async (p) => {
            await p.locator('[data-rich-composer]').click();
            await p.keyboard.type('Hello');
            // With a style on, the controls sit on the line UNDER the card and come after it in the tab order
            // (DOM order = visual order): box -> attach -> Aa -> chip -> chip x. Each stop must be below the card.
            const want = ['Attach File', 'Text formatting', 'Card style: Rules. Edit', 'Remove the card style from this message'];
            for (const w of want) {
                await p.keyboard.press('Tab');
                const st = await p.evaluate(() => { const a = document.activeElement; const c = document.querySelector('.cl-msg-card--composer'); return { label: a?.getAttribute('aria-label') || a?.getAttribute('title'), below: !!c && a.getBoundingClientRect().top >= c.getBoundingClientRect().bottom - 1 }; });
                if (st.label !== w) throw new Error(`Tab from the box reached ${st.label}, expected ${w}`);
                if (!st.below) throw new Error(`${w} is not on the line under the card`);
            }
            await p.keyboard.press('Enter');
            await settle(p, 300);
            if (await p.evaluate(() => !!document.querySelector('.cl-msg-card--composer'))) throw new Error('Enter on the chip x did not remove the style');
        } },
        { id: 'removed', url: 'scene=composer&card=rules&text=fmt', check: false, prep: async (p) => {
            await focusEnd(p);
            await p.locator('[aria-label="Remove the card style from this message"]').first().click();
            await settle(p, 300);
            const still = await p.evaluate(() => !!document.querySelector('.cl-msg-card--composer'));
            if (still) throw new Error('the card preview is still there after the chip x');
        } },
    ],
    // WYSIWYG (2026-11-18, owner: "It doesn't match how it would look if I sent it"): the SENT message (row markup +
    // MessageCard + the row body) and the composer preview of the same style and text, side by side; `wysiwygCheck`
    // compares the two cards' computed box and text metrics and (plain text) their width / height / text offset.
    // Settings → Accessibility (2026-11-20): the Size card at rest, with a preference the display limits, and
    // keyboard-focused (the focus ring + valuetext path).
    a11y: [
        { id: 'pane', base: SR, url: 'tab=accessibility' },
        { id: 'pane-limited', base: SR, url: 'tab=accessibility&uiscale=200&uimax=125' },
        { id: 'pane-focus', base: SR, url: 'tab=accessibility', prep: async (p) => { await p.locator('[role="slider"][aria-label="Interface size"]').focus(); await settle(p, 300); } },
    ],
    wysiwyg: [
        { id: 'event-yo', url: 'scene=wysiwyg&card=event&text=yo', check: true, wys: 'plain', prep: async (p) => { await focusEnd(p); } },
        { id: 'event-empty', url: 'scene=wysiwyg&card=event', check: true, wys: 'empty' },
        { id: 'rules-sentence', url: 'scene=wysiwyg&card=rules&text=sentence', check: true, wys: 'plain', prep: async (p) => { await focusEnd(p); } },
        { id: 'announcement-wrap', url: 'scene=wysiwyg&card=announcement&text=wrap', check: true, wys: 'plain', prep: async (p) => { await focusEnd(p); } },
        { id: 'warning-sentence', url: 'scene=wysiwyg&card=notice&text=sentence', check: true, wys: 'plain', prep: async (p) => { await focusEnd(p); } },
        { id: 'success-yo', url: 'scene=wysiwyg&card=success&text=yo', check: true, wys: 'plain', prep: async (p) => { await focusEnd(p); } },
        { id: 'shadow-sentence', url: 'scene=wysiwyg&card=shadow&text=sentence', check: true, wys: 'plain', prep: async (p) => { await focusEnd(p); } },
        { id: 'rules-fmt', url: 'scene=wysiwyg&card=rules&text=fmt', check: true, wys: 'style', prep: async (p) => { await focusEnd(p); } },
        { id: 'event-typed', url: 'scene=wysiwyg&card=event&text=yo', check: true, wys: 'typed', prep: async (p) => {
            // Same text as the sent row, but TYPED into an emptied box (the box shrink-wraps as you type).
            await focusEnd(p); await p.keyboard.press('Control+A'); await p.keyboard.press('Backspace');
            await p.keyboard.type('Yo All!'); await settle(p, 300);
        } },
    ],
    broken: [
        { id: 'positive-control', url: 'scene=broken' },
        // The composer card check's own positive control: the card forced 1600px wide must FAIL.
        { id: 'composer-card-control', url: 'scene=composer&card=rules&text=fmt&brokencard=1', check: true },
        // The WYSIWYG check's own positive control: a full-width, re-padded composer card (the old look) must FAIL.
        { id: 'wysiwyg-control', url: 'scene=wysiwyg&card=event&text=yo&brokenwys=1', check: false, wys: 'plain' },
    ],
};

async function focusEnd(p) {
    await p.locator('[data-rich-composer]').click();
    await p.keyboard.press('Control+End');
    await settle(p, 250);
}
/** Types a formatted message the way a person would: text, the H button, Shift+Enter, a `- ` list, Ctrl+B. */
async function typeFormatted(p) {
    await p.locator('[data-rich-composer]').click();
    await p.keyboard.type('Build passed');
    await p.locator('button[aria-label="Text formatting"]').first().click().catch(() => {});
    await settle(p, 200);
    const h = p.locator('[data-action="heading"]').first();
    if (await h.count()) { await h.click(); await settle(p, 150); }
    await p.locator('[data-rich-composer]').click();
    await p.keyboard.press('Control+End');
    await p.keyboard.press('Shift+Enter');
    await p.keyboard.type('All ');
    await p.keyboard.press('Control+B');
    await p.keyboard.type('142 tests');
    await p.keyboard.press('Control+B');
    await p.keyboard.type(' green.');
    await p.keyboard.press('Shift+Enter');
    await p.keyboard.type('- desktop');
    await p.keyboard.press('Shift+Enter');
    await p.keyboard.type('api');
    await settle(p, 300);
}

/** In-page: the composer card preview's own invariants. Returns a list of problems. */
/** In-page: the composer preview card vs the SENT card of the same style (scene=wysiwyg). */
const wysiwygCheck = (mode) => {
    const problems = [];
    const sent = document.querySelector('[data-row="sent"] .cl-msg-card');
    const comp = document.querySelector('.cl-msg-card--composer');
    const sentBody = document.querySelector('[data-sent-body]');
    const box = document.querySelector('[data-rich-composer]');
    if (!sent || !comp || !sentBody || !box) return [{ kind: 'wysiwyg', what: 'missing sent card / composer card' }];
    const a = getComputedStyle(sent), b = getComputedStyle(comp);
    const props = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
        'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
        'borderTopColor', 'borderLeftColor', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius',
        'boxShadow', 'backgroundImage', 'backgroundColor', 'outlineStyle', 'textAlign', 'letterSpacing', 'textShadow', 'color'];
    for (const k of props) if (a[k] !== b[k]) problems.push({ kind: 'wysiwyg', what: `card ${k}: sent ${a[k]} vs composer ${b[k]}` });
    const ta = getComputedStyle(sentBody), tb = getComputedStyle(box);
    for (const k of ['fontSize', 'lineHeight', 'fontWeight', 'fontFamily', 'letterSpacing', 'color']) if (ta[k] !== tb[k]) problems.push({ kind: 'wysiwyg', what: `text ${k}: sent ${ta[k]} vs composer ${tb[k]}` });
    if (mode === 'style') return problems;
    const ra = sent.getBoundingClientRect(), rb = comp.getBoundingClientRect();
    if (mode === 'empty') {
        // Empty: the card keeps room for the caret and the placeholder.
        if (rb.width < 120) problems.push({ kind: 'wysiwyg', what: `empty composer card only ${rb.width.toFixed(0)}px wide` });
        return problems;
    }
    if (Math.abs(ra.width - rb.width) > 3) problems.push({ kind: 'wysiwyg', what: `width: sent ${ra.width.toFixed(1)} vs composer ${rb.width.toFixed(1)}` });
    if (Math.abs(ra.height - rb.height) > 2) problems.push({ kind: 'wysiwyg', what: `height: sent ${ra.height.toFixed(1)} vs composer ${rb.height.toFixed(1)}` });
    // Text position inside the card: the first glyph's offset from the card's top-left corner.
    const firstText = (root) => { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (n.textContent.trim()) return n; return null; };
    const off = (card, root) => {
        const t = firstText(root); if (!t) return null;
        const r = document.createRange(); r.setStart(t, 0); r.setEnd(t, 1);
        const g = r.getBoundingClientRect(), c = card.getBoundingClientRect();
        return [g.left - c.left, g.top - c.top];
    };
    const oa = off(sent, sentBody), ob = off(comp, box);
    if (!oa || !ob) problems.push({ kind: 'wysiwyg', what: 'no text to compare' });
    else if (Math.abs(oa[0] - ob[0]) > 1 || Math.abs(oa[1] - ob[1]) > 1) problems.push({ kind: 'wysiwyg', what: `text offset: sent ${oa.map(x => x.toFixed(1))} vs composer ${ob.map(x => x.toFixed(1))}` });
    return problems;
};

const composerCardCheck = () => {
    const problems = [];
    const form = document.querySelector('form.cl-composer');
    const box = document.querySelector('[data-rich-composer]');
    const card = document.querySelector('.cl-msg-card--composer'); // not the chip's swatch (also a card)
    if (!form || !box) return [{ kind: 'composer-card', what: 'no composer' }];
    if (!card) return [{ kind: 'composer-card', what: 'no card preview' }];
    const r = (el) => el.getBoundingClientRect();
    const fr = r(form), cr = r(card), br = r(box);
    if (!card.contains(box)) problems.push({ kind: 'composer-card', what: 'the box is not inside the card' });
    for (const el of form.querySelectorAll('button')) {
        if (card.contains(el)) problems.push({ kind: 'composer-card', what: `control inside the styled area: ${el.getAttribute('aria-label') || el.textContent}` });
    }
    if (cr.left < fr.left - 0.5 || cr.right > fr.right + 0.5 || cr.top < fr.top - 0.5 || cr.bottom > fr.bottom + 0.5) {
        problems.push({ kind: 'composer-card', what: `card [${cr.left.toFixed(0)},${cr.top.toFixed(0)} ${cr.width.toFixed(0)}x${cr.height.toFixed(0)}] outside the composer [${fr.left.toFixed(0)},${fr.top.toFixed(0)} ${fr.width.toFixed(0)}x${fr.height.toFixed(0)}]` });
    }
    const send = form.querySelector('.cmp-ico--send');
    // No control of the composer overlaps the card (send, attach, Aa, the chip: they sit beside or under it).
    for (const el of form.querySelectorAll('button')) {
        if (card.contains(el)) continue;
        const b = r(el);
        if (b.width < 1 || b.height < 1) continue;
        const ox = Math.min(b.right, cr.right) - Math.max(b.left, cr.left), oy = Math.min(b.bottom, cr.bottom) - Math.max(b.top, cr.top);
        if (ox > 0.5 && oy > 0.5) problems.push({ kind: 'composer-card', what: `card runs under ${el.getAttribute('aria-label') || el.title || el.className}` });
    }
    // The box keeps its own limits: never taller than its max-height, its text inside the card's padding box.
    const maxH = parseFloat(getComputedStyle(box).maxHeight);
    if (br.height > maxH + 0.5) problems.push({ kind: 'composer-card', what: `box ${br.height.toFixed(0)}px taller than its max-height ${maxH}px` });
    if (br.left < cr.left || br.right > cr.right + 0.5 || br.top < cr.top || br.bottom > cr.bottom + 0.5) problems.push({ kind: 'composer-card', what: 'box pokes out of the card' });
    if (box.scrollWidth > box.clientWidth + 1) problems.push({ kind: 'composer-card', what: `box scrolls sideways (${box.scrollWidth} > ${box.clientWidth})` });
    // Scrolling still works when the draft is longer than max-height: scrolled to the end, the last line is visible inside the box.
    if (box.scrollHeight > box.clientHeight + 1) {
        if (!/(auto|scroll)/.test(getComputedStyle(box).overflowY)) problems.push({ kind: 'composer-card', what: 'long draft but the box does not scroll' });
    }
    // Caret colour readable: the computed caret colour equals the text colour.
    const cs = getComputedStyle(box);
    if (cs.caretColor !== cs.color) problems.push({ kind: 'composer-card', what: `caret ${cs.caretColor} != text ${cs.color}` });
    // Usable at the minimum window: the styled text area gets at least 60% of the composer's inner width
    // (the style chip moves to its own line rather than squeezing the box).
    const frameEl = card.closest('.cl-composer-card-frame') ?? card;
    const fs = getComputedStyle(form);
    const inner = form.clientWidth - parseFloat(fs.paddingLeft) - parseFloat(fs.paddingRight);
    const share = r(frameEl).width / inner;
    if (share < 0.6) problems.push({ kind: 'composer-card', what: `text area ${r(frameEl).width.toFixed(0)}px is ${(share * 100).toFixed(0)}% of the composer (${inner.toFixed(0)}px); needs >= 60%` });
    // The chip, when shown, is fully inside the composer and its x is reachable (not covered at its centre).
    const x = form.querySelector('[aria-label="Remove the card style from this message"]');
    if (x) {
        const xr = r(x);
        if (xr.left < fr.left || xr.right > fr.right || xr.top < fr.top || xr.bottom > fr.bottom) problems.push({ kind: 'composer-card', what: 'style chip x outside the composer' });
        const hit = document.elementFromPoint(xr.left + xr.width / 2, xr.top + xr.height / 2);
        if (!hit || !x.contains(hit)) problems.push({ kind: 'composer-card', what: 'style chip x covered at its centre' });
    }
    return problems;
};

async function pickDividerLook(p) {
    await p.locator('[data-testid="category-look"]').getByText('Divider category', { exact: true }).click();
    await settle(p, 500);
}
async function openColourPicker(p) {
    await p.locator('[data-testid="category-look"]').scrollIntoViewIfNeeded();
    await p.locator('[aria-label="Pick a custom divider colour"]').click();
    await settle(p, 500);
}
async function clickAccept(p) {
    await p.locator('.gft-card button').filter({ hasText: /accept|open|unwrap/i }).first().click();
}
async function scrollToText(p, text) {
    await p.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout: 30000 });
    await p.evaluate((t) => {
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n; while ((n = w.nextNode())) if (n.textContent.includes(t)) { n.parentElement.scrollIntoView({ block: 'center' }); return; }
    }, text);
    await settle(p, 600);
}
async function scrollToGift(p) { await scrollToText(p, 'Gift Pro'); }
async function scrollToGate(p) { await scrollToText(p, 'Voice gate'); }

/** In-page measurement. Returns a list of problems. */
const measure = () => {
    const W = window.innerWidth, H = window.innerHeight;
    const problems = [];
    const desc = (el) => {
        const id = el.id ? `#${el.id}` : '';
        const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
        const t = (el.getAttribute?.('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50);
        return `${el.tagName.toLowerCase()}${id}${cls}${t ? ` "${t}"` : ''}`;
    };
    const visible = (el) => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
    };
    const srOnly = (el) => { const cs = getComputedStyle(el); return cs.position === 'absolute' && (cs.clip !== 'auto' || cs.clipPath !== 'none') && el.getBoundingClientRect().width <= 2; };
    const scroller = (el, axis) => /(auto|scroll)/.test(getComputedStyle(el)[axis === 'x' ? 'overflowX' : 'overflowY']);
    /** `f` floats (absolute / fixed / sticky layer) over content `c` that scrolls beneath it in a scroller not holding `f`. */
    const overScrolledContent = (f, c) => {
        let layer = null;
        for (let a = f; a && a !== document.body; a = a.parentElement) if (/(absolute|fixed|sticky)/.test(getComputedStyle(a).position)) { layer = a; break; }
        if (!layer || layer.contains(c)) return false;
        for (let a = c.parentElement; a && a !== document.body; a = a.parentElement) if (scroller(a, 'y') && !a.contains(f)) return true;
        return false;
    };
    const floating = (el) => { for (let a = el; a && a !== document.body; a = a.parentElement) { const p = getComputedStyle(a).position; if (p === 'fixed' || p === 'sticky') return a; if (p === 'absolute' && a.offsetParent && scroller(a.offsetParent, 'y')) return a; if (scroller(a, 'y')) return null; } return null; };
    const clips = (el) => { const cs = getComputedStyle(el); return cs.overflowX !== 'visible' || cs.overflowY !== 'visible'; };

    // 1. sideways page scroll
    const se = document.scrollingElement;
    if (se.scrollWidth > W + 1) problems.push({ kind: 'page-hscroll', what: `document ${se.scrollWidth} > ${W}` });

    // 2. content wider than its box
    for (const el of document.body.querySelectorAll('*')) {
        if (el instanceof SVGElement || !visible(el) || srOnly(el)) continue;
        if (el.closest('[aria-hidden="true"]')) continue; // decoration: judged in the screenshots
        // The kit button's capsule squashes / stretches on press (clPhysics transform): a few px, transient.
        if (el.classList.contains('clb') && el.scrollWidth - el.clientWidth <= 10) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'inline' || el.clientWidth === 0) continue;
        if (el.scrollWidth <= el.clientWidth + 1) continue;
        if (cs.textOverflow === 'ellipsis') continue; // a deliberately truncated line
        // A child that is itself the overflow (reported there) - report only the innermost.
        const kids = [...el.children].filter(c => !(c instanceof SVGElement) && visible(c));
        if (kids.some(c => c.scrollWidth > c.clientWidth + 1 && getComputedStyle(c).display !== 'inline' && getComputedStyle(c).textOverflow !== 'ellipsis')) continue;
        // Content that overflows only because a descendant is translated / absolutely placed
        // inside the box (e.g. a slider thumb) is not text overflow; require a real child or text past the edge.
        const er = el.getBoundingClientRect();
        let past = 0;
        for (const d of el.querySelectorAll('*')) {
            if (d instanceof SVGElement && d.tagName !== 'svg') continue;
            if (!visible(d) || srOnly(d)) continue;
            // Decoration (confetti, glows) is aria-hidden and may spill on purpose; the
            // screenshots are where its bounds get judged.
            if (d.closest('[aria-hidden="true"]') && !el.closest('[aria-hidden="true"]')) continue;
            // A popover anchored inside `el` floats out of it by design (its own bounds are checked under offscreen).
            const dp = d.closest('[role="menu"], [role="dialog"], [role="listbox"], [role="tooltip"]');
            if (dp && !dp.contains(el)) continue;
            // A deliberate bleed: a negative side margin (e.g. a full-width hover wash into the card's padding).
            let bleed = false;
            for (let x = d; x && x !== el; x = x.parentElement) { const xs = getComputedStyle(x); if (parseFloat(xs.marginLeft) < 0 || parseFloat(xs.marginRight) < 0) { bleed = true; break; } }
            if (bleed && !clips(el)) continue;
            const dr = d.getBoundingClientRect();
            if (getComputedStyle(d).position === 'fixed') continue;
            past = Math.max(past, dr.right - er.right, er.left - dr.left);
        }
        // text nodes
        const range = document.createRange();
        for (const tn of el.childNodes) if (tn.nodeType === 3 && tn.textContent.trim()) { range.selectNodeContents(tn); const rr = range.getBoundingClientRect(); past = Math.max(past, rr.right - er.right, er.left - rr.left); }
        // overflow:visible spills a few px on purpose (status dots, focus rings); a clipping box cuts.
        if (past <= (clips(el) ? 1.5 : 3)) continue;
        problems.push({ kind: 'overflow', what: `${desc(el)} scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth} (content ${past.toFixed(0)}px past the edge)${scroller(el, 'x') ? ' [sideways scroller]' : ''}` });
    }

    // 3. floating surfaces and their controls inside the window
    const floats = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [role="tooltip"], .fmt-menu, .fmt-bar')]
        .filter(visible);
    for (const el of document.body.querySelectorAll('*')) {
        if (getComputedStyle(el).position === 'fixed' && visible(el) && !floats.includes(el)) {
            const r = el.getBoundingClientRect();
            if (!(r.width >= W - 1 && r.height >= H - 1)) floats.push(el); // full-window overlays are only backdrops
        }
    }
    const reachable = (el) => {
        // inside the window, or inside a scroll container (itself in the window) that can bring it in
        const r = el.getBoundingClientRect();
        if (r.left >= -1 && r.top >= -1 && r.right <= W + 1 && r.bottom <= H + 1) return true;
        for (let a = el.parentElement; a; a = a.parentElement) {
            if ((scroller(a, 'y') && a.scrollHeight > a.clientHeight + 1) || (scroller(a, 'x') && a.scrollWidth > a.clientWidth + 1)) {
                const ar = a.getBoundingClientRect();
                const inX = r.left >= Math.max(-1, ar.left - 1) && r.right <= Math.min(W + 1, ar.right + 1);
                if (ar.left >= -1 && ar.top >= -1 && ar.right <= W + 1 && ar.bottom <= H + 1 && (inX || scroller(a, 'x'))) return true;
            }
        }
        return false;
    };
    for (const f of floats) {
        const r = f.getBoundingClientRect();
        const big = r.height > H + 1 || r.width > W + 1;
        if (!reachable(f) && !big) problems.push({ kind: 'offscreen', what: `${desc(f)} at [${r.left.toFixed(0)},${r.top.toFixed(0)} ${r.width.toFixed(0)}x${r.height.toFixed(0)}] in ${W}x${H}` });
        for (const c of f.querySelectorAll('button, a[href], input, select, textarea, [role="radio"], [role="menuitemradio"], [role="menuitem"]')) {
            if (!visible(c) || srOnly(c)) continue;
            if (!reachable(c)) { const cr = c.getBoundingClientRect(); problems.push({ kind: 'offscreen', what: `${desc(c)} inside ${desc(f).slice(0, 40)} at [${cr.left.toFixed(0)},${cr.top.toFixed(0)}] in ${W}x${H}, no way to scroll to it` }); }
        }
    }

    // 4. controls cut off sideways by an overflow-hidden ancestor
    const controls = [...document.querySelectorAll('button, a[href], input:not([type="range"]), select, textarea, [role="button"], [role="radio"], [role="menuitemradio"]')]
        .filter(c => visible(c) && !srOnly(c));
    for (const c of controls) {
        const r = c.getBoundingClientRect();
        for (let a = c.parentElement; a && a !== document.body; a = a.parentElement) {
            if (!clips(a) || scroller(a, 'x')) continue;
            const ar = a.getBoundingClientRect();
            if (r.left < ar.left - 1 || r.right > ar.right + 1) { problems.push({ kind: 'clipped', what: `${desc(c)} [${r.left.toFixed(0)}..${r.right.toFixed(0)}] cut by ${desc(a).slice(0, 50)} [${ar.left.toFixed(0)}..${ar.right.toFixed(0)}]` }); break; }
        }
        if (r.right > W + 1 || r.left < -1) problems.push({ kind: 'clipped', what: `${desc(c)} leaves the window sideways [${r.left.toFixed(0)}..${r.right.toFixed(0)}]` });
    }

    // 5. controls overlapping each other (the parts actually shown: a row scrolled out of
    //    its list's box is clipped there, not overlapping what sits below the list)
    const visRect = (el) => {
        const r = el.getBoundingClientRect();
        let l = r.left, t = r.top, rr = r.right, b = r.bottom;
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
            if (!clips(a)) continue;
            const ar = a.getBoundingClientRect();
            l = Math.max(l, ar.left); t = Math.max(t, ar.top); rr = Math.min(rr, ar.right); b = Math.min(b, ar.bottom);
        }
        return rr - l > 0 && b - t > 0 ? { left: l, top: t, right: rr, bottom: b } : null;
    };
    for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i], b = controls[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ra = visRect(a), rb = visRect(b);
        if (!ra || !rb) continue;
        const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        // A control in a floating layer (absolute / sticky / fixed, e.g. the channel list's
        // "jump to unread" pill) deliberately sits over the content scrolling beneath it.
        if (overScrolledContent(a, b) || overScrolledContent(b, a)) continue;
        // A popover (menu / dialog / listbox / tooltip) covers what is under it by design.
        const pop = (el) => el.closest('[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"], [role="tooltip"]');
        if (pop(a) !== pop(b)) continue;
        // A control covered by a modal / backdrop at its own centre is not in play.
        const covered = (el, other) => { const r = el.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!h && !el.contains(h) && !other.contains(h) && !h.contains(el); };
        if (covered(a, b) || covered(b, a)) continue;
        if (ox > 2 && oy > 2) {
            // the one on top must be the one hit-tested at the overlap's centre; a covered control under a modal is fine
            const cx = (Math.max(ra.left, rb.left) + Math.min(ra.right, rb.right)) / 2, cy = (Math.max(ra.top, rb.top) + Math.min(ra.bottom, rb.bottom)) / 2;
            const hit = document.elementFromPoint(cx, cy);
            if (!hit || !(a.contains(hit) || b.contains(hit))) continue;
            problems.push({ kind: 'overlap', what: `${desc(a)} overlaps ${desc(b)} by ${ox.toFixed(0)}x${oy.toFixed(0)}` });
        }
    }
    return problems;
};

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const results = [];
let failed = 0;
try {
    for (const [screen, cases] of Object.entries(CASES)) {
        if (only.length ? !only.includes(screen) : screen === 'broken') continue;
        fs.mkdirSync(path.join(out, screen), { recursive: true });
        for (const c of cases) for (const s0 of SIZES) for (const v of variants(s0)) for (const tx of textVariants) {
            const tag = (SCALES.length > 1 || SCALES[0] !== 100 || s0.cssOnly ? `-z${v.z}` : '') + (tx ? `-t${tx}` : '');
            const s = { ...s0, id: `${s0.id}${tag}`, sizeId: s0.id };
            const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, deviceScaleFactor: v.dsf, });
            const page = await ctx.newPage();
            const errors = [];
            page.on('pageerror', e => errors.push(e.message));
            let problems = [];
            try {
                const base = c.base ?? WS;
                await page.goto(`${base}?${c.url}`, { waitUntil: 'commit', timeout: 240000 });
                if (base === WS) await page.waitForFunction('window.__ready === true', null, { timeout: 240000 });
                else await page.waitForFunction('window.__booted === true', null, { timeout: 240000 });
                await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 4000))]));
                if (tx) await page.evaluate((px) => {
                    document.documentElement.style.setProperty('--cl-msg-text-px', `${px}px`);
                    document.documentElement.style.setProperty('--cl-msg-text-scale', String(+(px / 15).toFixed(4)));
                }, tx);
                await settle(page, 900);
                if (c.prep) await c.prep(page);
                problems = await page.evaluate(measure);
                if (c.check) problems.push(...await page.evaluate(composerCardCheck));
                if (c.wys) problems.push(...await page.evaluate(wysiwygCheck, c.wys));
            } catch (e) {
                problems = [{ kind: 'error', what: String(e.message).split('\n')[0] }];
            }
            for (const e of errors) problems.push({ kind: 'pageerror', what: e.slice(0, 160) });
            const file = path.join(out, screen, `${c.id}--${s.id}.png`);
            try { await page.screenshot({ path: file }); } catch { /* */ }
            const pass = problems.length === 0;
            if (!pass) failed++;
            results.push({ screen, case: c.id, size: s.id, sizeId: s.sizeId, pass, problems, file });
            console.log(`${pass ? 'PASS' : 'FAIL'}  ${screen}/${c.id} @ ${s.id}`);
            for (const pr of problems) console.log(`        ${pr.kind}: ${pr.what}`);
            await ctx.close();
        }
    }
    // One min / laptop / large grid per screen (a row per case), for the report.
    const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    for (const screen of [...new Set(results.map(r => r.screen))]) {
        const cases = [...new Set(results.filter(r => r.screen === screen).map(r => r.case))];
        const cell = (c, size) => {
            const r = results.find(x => x.screen === screen && x.case === c && (x.size === size || x.sizeId === size));
            if (!r || !fs.existsSync(r.file)) return '<td></td>';
            const b64 = fs.readFileSync(r.file).toString('base64');
            return `<td><img src="data:image/png;base64,${b64}" style="width:460px;display:block;border:2px solid ${r.pass ? '#25E0C8' : '#FF6B5E'}"></td>`;
        };
        const rows = cases.map(c => `<tr><th>${c}</th>${['min', 'laptop', 'large'].map(sz => cell(c, sz)).join('')}</tr>`).join('');
        await page.setContent(`<body style="margin:0;background:#111;color:#ddd;font:14px sans-serif"><table cellspacing="8"><tr><th></th><th>min 1000x720</th><th>laptop 1366x768</th><th>large 1920x1080</th></tr>${rows}</table></body>`);
        await page.screenshot({ path: path.join(out, `grid-${screen}.png`), fullPage: true });
    }
    await page.close();
} finally {
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
    await browser.close();
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
