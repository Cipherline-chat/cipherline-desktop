#!/usr/bin/env node
/**
 * Generates src/styles/theme-light-kit.css: the Light-theme counterpart of the
 * kit stylesheets (cl-kit.css, cl-kit-ext.css), WITHOUT editing them.
 *
 * Why generated: apps/website imports cl-kit.css / cl-kit-ext.css and repaints
 * them for its own light portal (portal-light.css). Turning their literals
 * into the desktop's new tokens would change the website (which does not
 * define --cl-bright-rgb & co.), so the desktop's Light values live in a
 * separate, desktop-only file. Every rule here applies only under
 * :root[data-scheme="light"], which the website never sets.
 *
 * For each kit declaration that the theme codemod (scripts/theme-codemod.mjs)
 * would rewrite — a white/black alpha lift, a token-colour rgba/hex, an
 * accent colour used as `color` — one rule with the rewritten value is
 * emitted, at the SAME specificity as the original (`:where(...)` adds none)
 * and inside the same @scope / @media, so the kit's own :hover / .on rules
 * keep winning exactly as they do in Dark. Declarations that would still
 * carry a literal after the rewrite are skipped (they need judgement:
 * src/styles/theme-light.css).
 *
 *   node scripts/gen-theme-light-kit.cjs           (writes the file)
 *   node scripts/gen-theme-light-kit.cjs --check   (exit 1 if it is stale)
 */
const fs = require('fs');
const path = require('path');
const postcss = require('postcss');

const DESKTOP = path.resolve(__dirname, '..');
const SOURCES = ['src/styles/cl-kit.css', 'src/styles/cl-kit-ext.css'];
const OUT = path.join(DESKTOP, 'src/styles/theme-light-kit.css');
const LIGHT = ':root[data-scheme="light"]';

const TOKENS = {
    abyss: '0B0F1E', deep: '131A30', surface: '1C2542', raise: '243056', border: '2A3558', sink: '0A1120',
    lume: '25E0C8', 'lume-hi': '3BEAD6', 'lume-press': '12B79F', 'lume-deep': '0E8F7C', 'on-lume': '06251F',
    flash: 'FF6B5E', 'flash-press': 'D14A3F', 'flash-deep': 'B23A30', 'on-flash': '3A0E0A',
    glow: 'FFC94D', 'on-glow': '4A3406', ok: '4ADE80', danger: 'FF5C7A',
    text: 'F4F7FF', muted: 'A7B3D4', faint: '5E6B8F',
};
const TEXT = { lume: 'lume-text', flash: 'flash-text', glow: 'glow-text', ok: 'ok-text', danger: 'danger-text' };
const byHex = new Map(Object.entries(TOKENS).map(([t, h]) => [h, t]));
const byRgb = new Map(Object.entries(TOKENS).map(([t, h]) => { const n = parseInt(h, 16); return [`${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`, t]; }));
byRgb.set('255,255,255', 'bright');
byRgb.set('0,0,0', 'shade');
const LITERAL = /(?<![\w&$-])#[0-9a-fA-F]{3,8}(?![\w-])|\b(?:rgba?|hsla?)\(\s*(?!var\()/;

// White highlights ON a coloured fill (button gloss, knobs) stay white: they are not lifts.
const FILL_SELECTOR = /\.cap\b|bloom|\.knob|\.sth\b/;
function rewrite(prop, value, selector = '') {
    const keepWhite = FILL_SELECTOR.test(selector);
    let v = value.replace(/\brgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+%?)\s*)?\)/g, (m, r, g, b, a) => {
        const tok = byRgb.get(`${+r},${+g},${+b}`);
        if (!tok || (keepWhite && tok === 'bright')) return m;
        if (a === undefined || a === '1') return tok === 'bright' || tok === 'shade' ? `rgb(var(--cl-${tok}-rgb))` : `var(--cl-${tok})`;
        return `rgb(var(--cl-${tok}-rgb) / ${a})`;
    });
    v = v.replace(/(?<![\w&$-])#([0-9a-fA-F]{6})(?![\w-])/g, (m, h) => (byHex.has(h.toUpperCase()) ? `var(--cl-${byHex.get(h.toUpperCase())})` : m));
    if (prop === 'color') {
        // Kit tokens (--lume) and app tokens (--cl-lume) used as TEXT.
        v = v.replace(/var\(--(?:cl-)?(lume|flash|glow|ok|danger)\)/g, (m, t) => `var(--cl-${TEXT[t]})`);
        v = v.replace(/var\(--cl-(lume|flash|glow|ok|danger)-rgb\)/g, (m, t) => `var(--cl-${TEXT[t]}-rgb)`);
    }
    return v;
}

function inKeyframes(node) {
    for (let p = node.parent; p; p = p.parent) if (p.type === 'atrule' && /keyframes$/i.test(p.name)) return true;
    return false;
}

const out = postcss.root();
let rules = 0;
for (const rel of SOURCES) {
    const css = fs.readFileSync(path.join(DESKTOP, rel), 'utf8');
    const root = postcss.parse(css, { from: rel });
    out.append(postcss.comment({ text: ` from ${rel} ` }));
    root.walkRules((rule) => {
        if (inKeyframes(rule)) return;
        const decls = [];
        rule.each((n) => {
            if (n.type !== 'decl' || n.prop.startsWith('--')) return;
            const next = rewrite(n.prop, n.value, rule.selector);
            if (next !== n.value && !LITERAL.test(next)) decls.push(postcss.decl({ prop: n.prop, value: next, important: n.important }));
        });
        if (!decls.length) return;
        // Same specificity as the original: the Light condition sits in :where().
        let scoped = false;
        const wrappers = [];
        for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
            if (p.type === 'atrule' && p.name === 'scope') scoped = true;
            if (p.type === 'atrule') wrappers.unshift(p);
        }
        const sel = rule.selectors.map((s) => {
            if (scoped) return s.includes(':scope') ? s.replace(/:scope/g, `:where(${LIGHT} :scope)`) : `:where(${LIGHT} :scope) ${s}`;
            return `:where(${LIGHT}) ${s}`;
        }).join(',\n');
        let node = postcss.rule({ selector: sel });
        decls.forEach((d) => node.append(d));
        for (const w of wrappers.reverse()) {
            const wrap = postcss.atRule({ name: w.name, params: w.params });
            wrap.append(node);
            node = wrap;
        }
        out.append(node);
        rules++;
    });
}

const header = `/* GENERATED — do not hand-edit. node scripts/gen-theme-light-kit.cjs
   The Light theme's version of every kit declaration that is a token colour,
   a white/black lift or an accent used as text (cl-kit.css, cl-kit-ext.css are
   shared with apps/website and stay untouched). Light only; same specificity
   as the kit's own rules. Imported right after cl-kit-ext.css. */\n`;
const text = header + out.toString().replace(/\n{3,}/g, '\n\n') + '\n';
if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (cur !== text) { console.error('theme-light-kit.css is stale: run node scripts/gen-theme-light-kit.cjs'); process.exit(1); }
    console.log('theme-light-kit.css up to date');
} else {
    fs.writeFileSync(OUT, text);
    console.log(`wrote ${path.relative(DESKTOP, OUT)} (${rules} rules)`);
}
