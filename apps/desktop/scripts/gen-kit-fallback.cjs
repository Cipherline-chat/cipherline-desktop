/**
 * Generates src/styles/cl-kit-fallback.css from src/styles/cl-kit.css.
 *
 * Why: every kit primitive wraps itself in a `.cl-kit` scope root with
 * `display:contents`, and Chromium has been observed (first on 132 — see the
 * hand-written .clt/.clb fallbacks in cl-kit-ext.css) to drop @scope(.cl-kit)
 * matches for such roots inside overflow-clipped ancestors. The cure is a
 * global, unscoped duplicate of each primitive's ruleset: byte-identical
 * values, so when @scope works it wins the cascade silently (scope proximity
 * beats unscoped at equal specificity) and when it doesn't the fallback
 * carries the styling.
 *
 * Only rules whose every selector is anchored to one of the primitive class
 * tokens below are emitted — the guide's generic selectors (button, h1, .row,
 * *…) stay scoped so they can't leak into the app.
 *
 * Re-run after regenerating cl-kit.css (extract-kit.cjs):
 *   node scripts/gen-kit-fallback.cjs
 */
const fs = require('fs');
const path = require('path');

// Primitive families whose scope root is a display:contents wrapper.
// .clt (toggle) and .clb (button) are maintained BY HAND in cl-kit-ext.css
// (they carry app-specific variants) — excluded here to keep one source each.
const TOKENS = [
    'sel', 'selt', 'selm', 'chev', 'mchk',                                  // ClSelect
    'cls', 'sbody', 'strk', 'sfill', 'sthw', 'ssh', 'sth', 'sbub',          // ClSlider
    'inp', 'fld', 'fmsg', 'srch',                                           // ClInput / ClTextarea / ClField / ClSearch
    'clc', 'cwrap', 'csh', 'cbox', 'chk',                                   // ClCheckbox
    'clr', 'rwrap', 'rsh', 'rbox', 'rdot',                                  // ClRadio
    'seg', 'sind',                                                          // ClSegment
    'pill', 'rolet', 'prog', 'sk', 'avx',                                   // ClMisc
];
const tokenRe = new RegExp('\\.(' + TOKENS.join('|') + ')(?![a-zA-Z0-9_-])');

const src = fs.readFileSync(path.join(__dirname, '../src/styles/cl-kit.css'), 'utf8');

// Isolate the @scope block's content (brace-depth aware).
const scopeStart = src.indexOf('@scope (.cl-kit) {');
if (scopeStart === -1) throw new Error('no @scope block found in cl-kit.css');
let depth = 0, i = scopeStart, bodyStart = -1, bodyEnd = -1;
for (; i < src.length; i++) {
    if (src[i] === '{') { if (depth === 0) bodyStart = i + 1; depth++; }
    else if (src[i] === '}') { depth--; if (depth === 0) { bodyEnd = i; break; } }
}
// Strip comments first — a brace inside a comment would derail the
// depth-aware statement splitter below.
const body = src.slice(bodyStart, bodyEnd).replace(/\/\*[\s\S]*?\*\//g, '');

// Split into top-level statements inside the scope block.
const stmts = [];
let buf = '';
depth = 0;
for (const ch of body) {
    buf += ch;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { stmts.push(buf.trim()); buf = ''; } }
}

// Keep a rule if at least one selector in its list is anchored to a token;
// drop the non-matching selectors from comma lists so nothing generic leaks.
const kept = [];
for (const s of stmts) {
    if (s.startsWith('@media')) {
        // Recurse one level into media blocks.
        const inner = s.slice(s.indexOf('{') + 1, s.lastIndexOf('}'));
        const cond = s.slice(0, s.indexOf('{')).trim();
        const innerStmts = [];
        let b = '', d = 0;
        for (const ch of inner) {
            b += ch;
            if (ch === '{') d++;
            else if (ch === '}') { d--; if (d === 0) { innerStmts.push(b.trim()); b = ''; } }
        }
        const innerKept = innerStmts.map(filterRule).filter(Boolean);
        if (innerKept.length) kept.push(cond + '{\n' + innerKept.join('\n') + '\n}');
        continue;
    }
    if (s.startsWith('@')) continue; // other at-rules stay scoped
    const r = filterRule(s);
    if (r) kept.push(r);
}

function filterRule(rule) {
    const brace = rule.indexOf('{');
    if (brace === -1) return null;
    const selectors = rule.slice(0, brace).split(',').map(x => x.trim());
    const matching = selectors.filter(x => tokenRe.test(x));
    if (!matching.length) return null;
    return matching.join(',') + rule.slice(brace);
}

const out = `/* ============================================================================
   GENERATED — do not hand-edit. node scripts/gen-kit-fallback.cjs
   Global (unscoped) duplicates of the kit's primitive rulesets, byte-identical
   to the @scope(.cl-kit) rules in cl-kit.css. Chromium has been observed to
   drop @scope matches when the scope root is display:contents inside an
   overflow-clipped ancestor (see cl-kit-ext.css, which hand-maintains the same
   fallback for .clt/.clb); this file covers the remaining primitives
   (select, slider, input, checkbox, radio, segment, misc). When @scope works,
   the scoped rules win the cascade silently; when it fails, these carry it.
   Import order: after cl-kit.css, before cl-kit-ext.css (ext overrides win).
   ============================================================================ */

${kept.join('\n')}
`;

fs.writeFileSync(path.join(__dirname, '../src/styles/cl-kit-fallback.css'), out);
console.log('kept ' + kept.length + ' rules → src/styles/cl-kit-fallback.css (' + out.length + ' bytes)');
