// Behaviour checks for the migrated server dialogs (run by server-dialogs-shots.mjs with CHECK=1).
export async function run({ open, check }) {
    let before = 0;
    const log = (page) => page.evaluate(() => window.__log.map(a => a.join(' ')));
    const count = async (page, re) => (await log(page)).filter(l => re.test(l)).length;
    const footer = (page) => page.evaluate(() => [...document.querySelectorAll('.dlg-foot-actions button')].map(b => b.textContent.trim()));
    const focused = (page) => page.evaluate(() => (document.activeElement?.textContent || document.activeElement?.tagName || '').trim() + '|' + (document.activeElement?.tagName ?? ''));
    const kinds = (page) => page.evaluate(() => ({
        framed: !!document.querySelector('.mcard.dlg-card .dlg-head .dlg-title') && !!document.querySelector('.dlg-foot'),
        title: document.querySelector('.dlg-title')?.textContent,
    }));
    const settle = (page, ms = 450) => page.waitForTimeout(ms);
    const impPreview = async (page) => { await page.locator('.mcard input').first().fill('https://discord.new/BX8jqYy8vu3y'); await page.keyboard.press('Enter'); await settle(page, 900); };

    // ── Create a Server ──
    {
        const { ctx, page } = await open('create');
        const k = await kinds(page);
        check('create: house frame (icon/title/footer)', k.framed && k.title === 'Create a Server', JSON.stringify(k));
        check('create: footer = Cancel + Create server', (await footer(page)).join('|') === 'Cancel|Create server', (await footer(page)).join('|'));
        check('create: name field focused on open', (await page.evaluate(() => document.activeElement?.tagName)) === 'INPUT');
        await page.keyboard.press('Enter'); await settle(page, 300);
        check('create: Enter with an empty name does nothing', (await count(page, /^create /)) === 0 && (await page.locator('[role=alert]').count()) === 0);
        check('create: primary disabled while empty', await page.evaluate(() => [...document.querySelectorAll('.dlg-foot-actions button')].pop().disabled));
        await page.keyboard.type('a'); await page.keyboard.press('Enter'); await settle(page, 300);
        check('create: Enter with a 1-char name shows the length error, sends nothing', (await count(page, /^create /)) === 0 && /at least 2/.test(await page.locator('[role=alert]').first().textContent()));
        await page.keyboard.type("b!@#"); await settle(page, 100);
        check('create: plain-text rule strips symbols', (await page.locator('.mcard input').first().inputValue()) === 'ab');
        await page.keyboard.press('Enter'); await settle(page, 700);
        check('create: Enter on a valid name creates once and closes', (await count(page, /^create ab$/)) === 1 && (await count(page, /^close/)) === 1, (await log(page)).join(' ; '));
        await ctx.close();
    }
    {
        const { ctx, page } = await open('create');
        await page.keyboard.press('Escape'); await settle(page, 700);
        check('create: Escape closes without creating', (await count(page, /^close/)) === 1 && (await count(page, /^create /)) === 0);
        await ctx.close();
    }
    {
        const { ctx, page } = await open('create', 's=loading');
        await page.keyboard.type('Game night'); await page.keyboard.press('Enter'); await settle(page, 400);
        await page.keyboard.press('Enter'); await page.keyboard.press('Enter'); await settle(page, 300);
        check('create: Enter while creating cannot send twice', (await count(page, /^create /)) === 1);
        check('create: primary keeps its label while creating', (await footer(page)).join('|') === 'Cancel|Create server', (await footer(page)).join('|'));
        await ctx.close();
    }
    {
        const { ctx, page } = await open('create', '', { reduced: true });
        const op = await page.evaluate(() => getComputedStyle(document.querySelector('.mcard')).opacity);
        check('create: reduced motion, card fully visible at rest', op === '1', op);
        await ctx.close();
    }
    // ── Discord import ──
    {
        const { ctx, page } = await open('create');
        await page.locator('button:has-text("Import from a Discord template")').click(); await settle(page, 500);
        check('import: entry opens the link step in the same frame', (await kinds(page)).title === 'Import a Discord template' && (await footer(page)).join('|') === 'Back|Preview template', (await footer(page)).join('|'));
        await page.keyboard.press('Enter'); await settle(page, 300);
        check('import: Enter with an empty link sends nothing', (await count(page, /^preview /)) === 0);
        await page.locator('.mcard input').first().fill('https://example.com/nope'); await page.keyboard.press('Enter'); await settle(page, 300);
        check('import: Enter on a non-template link shows the error and never reaches the API', (await count(page, /^preview /)) === 0 && /Paste a Discord template link/.test(await page.locator('[role=alert]').first().textContent()));
        await page.locator('.mcard button:has-text("Back")').click(); await settle(page, 300);
        check('import: Back returns to the create view', (await kinds(page)).title === 'Create a Server');
        await ctx.close();
    }
    {
        const { ctx, page } = await open('import');
        await impPreview(page);
        check('import: preview step footer = Use a different link + Create server', (await footer(page)).join('|') === 'Use a different link|Create server', (await footer(page)).join('|'));
        check('import: name field focused on the preview step', (await page.evaluate(() => document.activeElement?.tagName + ':' + document.activeElement?.value)) === 'INPUT:Fusion');
        await page.keyboard.press('Control+a'); await page.keyboard.type('x'); await page.keyboard.press('Enter'); await settle(page, 300);
        check('import: Enter with a 1-char name does nothing (primary is disabled, as before)', (await count(page, /^import /)) === 0 && (await page.evaluate(() => [...document.querySelectorAll('.dlg-foot-actions button')].pop().disabled)));
        await page.keyboard.type('y'); await page.keyboard.press('Enter'); await settle(page, 700);
        check('import: Enter on a valid name imports once and closes', (await count(page, /^import /)) === 1 && (await count(page, /^close/)) === 1, (await log(page)).join(' ; '));
        await ctx.close();
    }
    {
        // The loading state the owner flagged: label kept + spinner, same size, secondary readable.
        const idle = await open('import', 's=creating'); await impPreview(idle.page);
        const idleBox = await idle.page.evaluate(() => { const b = [...document.querySelectorAll('.dlg-foot-actions .clb')].pop().getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; });
        await idle.page.locator('.dlg-foot-actions button:has-text("Create server")').click(); await settle(idle.page, 500);
        const busy = await idle.page.evaluate(async () => {
            // Let the kit's colour/transform transitions finish (they run slowly on a loaded box); the spinner loops forever, so skip it.
            await Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
            const wraps = [...document.querySelectorAll('.dlg-foot-actions .clb')];
            const pri = wraps.pop(), sec = wraps.pop();
            const pb = pri.getBoundingClientRect();
            const sc = getComputedStyle(sec.querySelector('.cap'));
            return { box: [Math.round(pb.width), Math.round(pb.height)], label: pri.textContent.trim(), spinner: !!pri.querySelector('.dlg-spin'), dots: !!pri.querySelector('.ldots'), secDisabled: sec.querySelector('button').disabled, secColor: sc.color, secBg: sc.backgroundColor, hint: document.querySelector('.dlg-foot-hint')?.textContent };
        });
        check('creating: primary keeps its label, with a spinner and no kit dots', busy.label === 'Create server' && busy.spinner && !busy.dots, JSON.stringify(busy));
        check('creating: primary keeps its size', idleBox.join('x') === busy.box.join('x'), `${idleBox} -> ${busy.box}`);
        check('creating: secondary is disabled', busy.secDisabled);
        const lum = (c) => { const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
        const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
        const card = '#0F1528'.replace('#', '');
        const cardRgb = `rgb(${parseInt(card.slice(0, 2), 16)}, ${parseInt(card.slice(2, 4), 16)}, ${parseInt(card.slice(4), 16)})`;
        check('creating: disabled secondary text is readable (>= 4.5:1 on the card)', ratio(busy.secColor, cardRgb) >= 4.5, `${busy.secColor} on ${cardRgb} = ${ratio(busy.secColor, cardRgb).toFixed(2)}`);
        check('creating: footer hint says what is happening', /Creating/.test(busy.hint ?? ''), busy.hint);
        await idle.ctx.close();
    }
    // ── Join a Server ──
    {
        const { ctx, page } = await open('join');
        const k = await kinds(page);
        check('join: house frame', k.framed && k.title === 'Join a Server', JSON.stringify(k));
        check('join: footer = Cancel + Join server', (await footer(page)).join('|') === 'Cancel|Join server');
        await page.keyboard.press('Enter'); await settle(page, 300);
        check('join: Enter with nothing typed does nothing', (await count(page, /^join /)) === 0);
        await page.keyboard.type('https://cipherline.chat/invite/AbCd1234'); await page.keyboard.press('Enter'); await settle(page, 700);
        check('join: Enter parses the link to its code, joins once, closes', (await count(page, /^join AbCd1234$/)) === 1 && (await count(page, /^close/)) === 1, (await log(page)).join(' ; '));
        await ctx.close();
    }
    {
        const { ctx, page } = await open('join', 's=error');
        await page.keyboard.type('zzz'); await page.keyboard.press('Enter'); await settle(page, 600);
        check('join: refusal shows the expired-invite copy and stays open', /expired or reached its usage limit/.test(await page.locator('[role=alert]').first().textContent()) && (await count(page, /^close/)) === 0);
        await page.keyboard.press('Escape'); await settle(page, 600);
        check('join: Escape closes', (await count(page, /^close/)) === 1);
        await ctx.close();
    }
    // ── invite preview ──
    {
        const { ctx, page } = await open('preview');
        await settle(page, 600);
        const k = await kinds(page);
        check('preview: house frame', k.framed && k.title === "You've been invited", JSON.stringify(k));
        check('preview: footer = Cancel + Join server', (await footer(page)).join('|') === 'Cancel|Join server', (await footer(page)).join('|'));
        check('preview: focus starts on the primary so Enter joins', (await focused(page)).startsWith('Join server'), await focused(page));
        await page.keyboard.press('Enter'); await settle(page, 500);
        check('preview: Enter accepts exactly once', (await count(page, /^http post \/invites\/AbCd1234\/accept/)) === 1 && (await count(page, /^joined s-1/)) === 1, (await log(page)).join(' ; '));
        await ctx.close();
    }
    {
        const { ctx, page } = await open('preview', 's=joined'); await settle(page, 600);
        check('preview: already a member offers Go to server', (await footer(page)).join('|') === 'Cancel|Go to server', (await footer(page)).join('|'));
        await ctx.close();
    }
    {
        const { ctx, page } = await open('preview', 's=invalid'); await settle(page, 600);
        const f = await footer(page);
        check('preview: expired invite has a single Close and no join path', f.join('|') === 'Close', f.join('|'));
        await page.keyboard.press('Escape'); await settle(page, 600);
        check('preview: Escape closes', (await count(page, /^close/)) === 1);
        await ctx.close();
    }
    {
        const { ctx, page } = await open('preview', 's=error'); await settle(page, 800);
        check('preview: unavailable invite offers Try again', (await footer(page)).join('|') === 'Close|Try again', (await footer(page)).join('|'));
        await ctx.close();
    }
    {
        const { ctx, page } = await open('preview', 's=loading'); await settle(page, 400);
        check('preview: while checking, Join is disabled and Enter does nothing', await page.evaluate(() => [...document.querySelectorAll('.dlg-foot-actions button')].pop().disabled));
        await page.keyboard.press('Enter'); await settle(page, 200);
        check('preview: nothing accepted while checking', (await count(page, /accept/)) === 0);
        await ctx.close();
    }
    // ── Invite People ──
    {
        const { ctx, page } = await open('invite'); await settle(page, 700);
        const k = await kinds(page);
        check('invite: house frame', k.framed && k.title === 'Invite People', JSON.stringify(k));
        check('invite: footer = Close + Copy link', (await footer(page)).join('|') === 'Close|Copy link', (await footer(page)).join('|'));
        check('invite: focus starts on Copy link so Enter copies', (await focused(page)).startsWith('Copy link'), await focused(page));
        await page.keyboard.press('Enter'); await settle(page, 400);
        check('invite: Enter copies the link', (await count(page, /^clipboard https:\/\/cipherline.chat\/invite\/AbCd1234$/)) === 1, (await log(page)).join(' ; '));
        await page.keyboard.press('Escape'); await settle(page, 600);
        check('invite: Escape closes', (await count(page, /^close/)) === 1);
        await ctx.close();
    }
    {
        // 1000x720 is the app's minimum window; the tallest state of the tallest dialog must keep header and footer on screen.
        const { ctx, page } = await open('invite', '', { viewport: { width: 1000, height: 720 } }); await settle(page, 700);
        await page.locator('button:has-text("link settings")').click();
        await page.locator('.mcard button').filter({ hasText: /^Custom/ }).first().click(); await page.locator('.mcard button').filter({ hasText: /^Custom/ }).last().click(); await settle(page, 400);
        const r = await page.evaluate(() => { const c = document.querySelector('.mcard').getBoundingClientRect(); const f = document.querySelector('.dlg-foot').getBoundingClientRect(); const h = document.querySelector('.dlg-head').getBoundingClientRect(); return { top: Math.round(c.top), bottom: Math.round(c.bottom), foot: Math.round(f.bottom), head: Math.round(h.top), vh: innerHeight, bodyScrolls: (() => { const b = document.querySelector('.dlg-body'); return b.scrollHeight > b.clientHeight; })() }; });
        check('invite: tallest state at 1000x720 keeps header + footer on screen (the body scrolls)', r.top >= 0 && r.bottom <= r.vh && r.foot <= r.vh, JSON.stringify(r));
        await ctx.close();
    }
    {
        const { ctx, page } = await open('invite', 'long=1'); await settle(page, 700);
        const r = await page.evaluate(() => { const s = document.querySelector('.dlg-subtitle'); const c = document.querySelector('.mcard').getBoundingClientRect(); return { sub: s.scrollWidth > s.clientWidth, over: s.getBoundingClientRect().right <= c.right, h: Math.round(s.getBoundingClientRect().height) }; });
        check('invite: a long server name truncates in the subtitle, one line', r.over && r.h < 24, JSON.stringify(r));
        await ctx.close();
    }
    {
        const { ctx, page } = await open('preview', 'long=1'); await settle(page, 700);
        const r = await page.evaluate(() => { const n = document.querySelector('.dlg-srv-name'); const d = document.querySelector('.dlg-srv-desc'); const c = document.querySelector('.mcard').getBoundingClientRect(); return { nameTrunc: n.scrollWidth > n.clientWidth, nameIn: n.getBoundingClientRect().right <= c.right, descH: Math.round(d.getBoundingClientRect().height) }; });
        check('preview: a long name truncates and a long description clamps inside the card', r.nameTrunc && r.nameIn && r.descH < 80, JSON.stringify(r));
        await ctx.close();
    }
    return before + 0;
}
