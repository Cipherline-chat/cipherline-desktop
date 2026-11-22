#!/usr/bin/env node
/**
 * Theme sweep codemod (plan docs/plans/accessibility-and-themes.md, "Token-
 * migration sweep strategy" step 1). Rewrites colour LITERALS that equal a
 * Dark theme token into the token, so the same pixels come out in Dark and the
 * colour follows the active theme in Light. Every rewrite is value-preserving
 * in Dark (checked by the Dark pixel diff of harness/light-theme-shots.mjs):
 *
 *   #131A30                      -> var(--cl-deep)                  (exact token hex)
 *   rgba(37,224,200,.22)         -> rgb(var(--cl-lume-rgb) / .22)   (token colour + alpha)
 *   rgba(255,255,255,.06)        -> rgb(var(--cl-bright-rgb) / .06) (white lifts / borders / dim text)
 *   rgba(0,0,0,.4)               -> rgb(var(--cl-shade-rgb) / .4)   (shadows, scrims)
 *   color: var(--cl-lume)        -> color: var(--cl-lume-text)      (accent / status colours used as TEXT;
 *   text-cl-lume / text-primary  -> text-cl-lume-text                same for flash, glow, ok, danger)
 *
 * Plain `#fff` / `#000` hex are left alone (often white text on a coloured
 * fill, or a mask) — those are judgement calls. TS/TSX: only className strings
 * and inline-style colour properties (`background: '…'`, `el.style.color = '…'`)
 * are touched, never SVG attributes (presentation attributes ignore var()).
 *
 *   node scripts/theme-codemod.mjs [--write] [paths...]     (default: dry run over src/)
 *
 * Skips: the token definitions, the website-shared kit (components/cl,
 * ClButton/ClSlider, cl-kit*.css: apps/website imports them and does not
 * define the new tokens), and the dark islands / art (DARK_ISLAND_* below).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));

// Dark token values (src/theme/themes.ts DARK_THEME.palette, the original 22 + the
// text tokens that share a value). Duplicated values resolve to the first name.
const TOKENS = {
    abyss: '0B0F1E', deep: '131A30', surface: '1C2542', raise: '243056', border: '2A3558', sink: '0A1120',
    lume: '25E0C8', 'lume-hi': '3BEAD6', 'lume-press': '12B79F', 'lume-deep': '0E8F7C', 'on-lume': '06251F',
    flash: 'FF6B5E', 'flash-press': 'D14A3F', 'flash-deep': 'B23A30', 'on-flash': '3A0E0A',
    glow: 'FFC94D', 'on-glow': '4A3406', ok: '4ADE80', danger: 'FF5C7A',
    text: 'F4F7FF', muted: 'A7B3D4', faint: '5E6B8F', 'border-strong': '6B78A0',
};
const TEXT_TOKEN = { lume: 'lume-text', flash: 'flash-text', glow: 'glow-text', ok: 'ok-text', danger: 'danger-text' };
const byHex = new Map(Object.entries(TOKENS).map(([t, h]) => [h, t]));
const byRgb = new Map(Object.entries(TOKENS).map(([t, h]) => {
    const n = parseInt(h, 16); return [`${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`, t];
}));
byRgb.set('255,255,255', 'bright');
byRgb.set('0,0,0', 'shade');

const SKIP = [
    'src/theme/', 'electron/', // token definitions (index.css's :root block is left alone below)
    'src/components/cl/', 'src/components/ClButton.tsx', 'src/components/ClSlider.tsx', 'src/components/SlottedCodeInput.tsx',
    'src/components/settings/panes/ProTagPopover.tsx', 'src/styles/cl-kit', // shared with apps/website
    // Dark islands and art (D4): they keep their literal colours.
    'src/styles/profile-card.css', 'src/styles/profile-v3.css', 'src/styles/pro-celebration.css', 'src/styles/level-up.css',
    'src/styles/firewall.css', 'src/styles/moments.css', 'src/styles/home-keys', 'src/styles/night-dive.css',
    'src/components/cosmetics/', 'src/components/mascot/', 'src/components/moments/', 'src/components/billing/gifts/GiftBox.tsx',
    'src/components/call/StreamStatsHud.tsx', 'src/components/onboarding/', 'src/components/firewall',
    'src/components/messageCard/', 'src/utils/profileTheme.ts', 'src/utils/profileCosmetics.ts', 'src/utils/avatarColor.ts', 'src/utils/cardStyle/',
    'src/components/integrations/platformLogoData.tsx',
];
const skip = (rel) => SKIP.some(s => rel.startsWith(s)) || /\.test\.tsx?$/.test(rel) || /\.d\.ts$/.test(rel);

const num = (a) => a.trim();
/** rgba(r,g,b,a) / rgb(r,g,b) with a token colour -> variable form. */
function rewriteFuncs(s) {
    return s.replace(/\brgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+%?)\s*)?\)/g, (m, r, g, b, a) => {
        const tok = byRgb.get(`${+r},${+g},${+b}`);
        if (!tok) return m;
        if (a === undefined || a === '1') return tok === 'bright' || tok === 'shade' ? `rgb(var(--cl-${tok}-rgb))` : `var(--cl-${tok})`;
        return `rgb(var(--cl-${tok}-rgb) / ${num(a)})`;
    });
}
function rewriteHex(s) {
    return s.replace(/(?<![\w&$-])#([0-9a-fA-F]{6})(?![\w-])/g, (m, h) => {
        const tok = byHex.get(h.toUpperCase());
        return tok ? `var(--cl-${tok})` : m;
    });
}
/** `color: var(--cl-lume)` (text) -> the text token. */
function textTokens(decl) {
    return decl
        .replace(/var\(--cl-(lume|flash|glow|ok|danger)\)/g, (m, t) => `var(--cl-${TEXT_TOKEN[t]})`)
        .replace(/var\(--cl-(lume|flash|glow|ok|danger)-rgb\)/g, (m, t) => `var(--cl-${TEXT_TOKEN[t]}-rgb)`);
}

function css(src, rel) {
    let out = '';
    const lines = src.split('\n');
    for (let line of lines) {
        if (/mask/.test(line)) { out += line + '\n'; continue; }
        line = rewriteFuncs(rewriteHex(line));
        // `color:` declarations (not background-color / border-color …)
        line = line.replace(/(^|[;{\s])(color\s*:\s*)([^;}]+)/g, (m, pre, c, v) => pre + c + textTokens(v));
        out += line + '\n';
    }
    return out.slice(0, -1);
}

const STYLE_KEYS = 'background|backgroundColor|backgroundImage|color|borderColor|borderTopColor|borderBottomColor|borderLeftColor|borderRightColor|border|borderTop|borderBottom|borderLeft|borderRight|boxShadow|outline|outlineColor|caretColor|textShadow|textDecorationColor|accentColor';
const STYLE_PROP = new RegExp(`(\\b(?:${STYLE_KEYS})\\s*[:=]\\s*)(['"\`])((?:(?!\\2)[^\\\\]|\\\\.)*)\\2`, 'g');

function tsx(src) {
    let s = src;
    // 1. Inline style colour values.
    s = s.replace(STYLE_PROP, (m, pre, q, v) => {
        let nv = rewriteFuncs(rewriteHex(v));
        if (/^\s*color\s*[:=]|\.color\s*=|\bcolor\s*:/.test(pre)) nv = textTokens(nv);
        return `${pre}${q}${nv}${q}`;
    });
    // 2. Tailwind text classes that use an accent / status colour as text.
    s = s.replace(/(?<=["'`\s:])text-(cl-lume|primary|cl-flash|cl-glow|cl-ok|cl-danger|flash|glow|online)(?=[\s"'`/]|$)/g, (m, c) => {
        const t = { 'cl-lume': 'lume', primary: 'lume', 'cl-flash': 'flash', flash: 'flash', 'cl-glow': 'glow', glow: 'glow', 'cl-ok': 'ok', online: 'ok', 'cl-danger': 'danger' }[c];
        return `text-cl-${TEXT_TOKEN[t]}`;
    });
    // 3. Tailwind arbitrary colours: bg-[#131A30] -> bg-[color:var(--cl-deep)].
    s = s.replace(/(?<=["'`\s:])(bg|text|border|ring|from|to|via|fill|stroke|outline|decoration|shadow)-\[(#[0-9a-fA-F]{6}|rgba?\([^\]]*\))\]/g, (m, p, v) => {
        const nv = rewriteFuncs(rewriteHex(v.replace(/_/g, ' ')));
        if (nv === v.replace(/_/g, ' ')) return m;
        return `${p}-[color:${nv.replace(/\s+/g, '_')}]`;
    });
    return s;
}

function walk(dir, out = []) {
    for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) walk(p, out);
        else if (/\.(css|ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
}

const files = (args.length ? args.map(a => path.resolve(a)) : walk(path.join(DESKTOP, 'src')))
    .flatMap(p => fs.statSync(p).isDirectory() ? walk(p) : [p]);
let changed = 0;
for (const f of files) {
    const rel = path.relative(DESKTOP, f).split(path.sep).join('/');
    if (skip(rel)) continue;
    const src = fs.readFileSync(f, 'utf8');
    // .ts files are data / logic (status colours, role colours, canvas): only .tsx markup is rewritten.
    let next = f.endsWith('.css') ? css(src, rel) : f.endsWith('.tsx') ? tsx(src) : src;
    if (rel === 'src/index.css') {
        // The :root token mirror (pinned to the theme data by themeTokens.test.ts) stays literal.
        const end = src.indexOf('}', src.search(/(^|\n):root\s*\{/)) + 1;
        next = src.slice(0, end) + css(src.slice(end), rel);
    }
    if (next !== src) {
        changed++;
        const a = src.split('\n'), b = next.split('\n');
        const n = a.reduce((k, l, i) => k + (l !== b[i] ? 1 : 0), 0);
        console.log(`${WRITE ? 'wrote' : 'would change'} ${rel} (${n} lines)`);
        if (WRITE) fs.writeFileSync(f, next);
    }
}
console.log(`${changed} files ${WRITE ? 'changed' : 'would change'}`);
