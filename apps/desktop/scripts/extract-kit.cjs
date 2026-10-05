const fs = require('fs');
const html = fs.readFileSync('Designsystem/cipherline-brand-guide-final.html', 'utf8');

// --- pull the verbatim <style> block ---
const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));

// --- split into top-level statements, brace-depth aware ---
const stmts = [];
let depth = 0, buf = '';
for (const ch of css) {
  buf += ch;
  if (ch === '{') depth++;
  else if (ch === '}') { depth--; if (depth === 0) { stmts.push(buf.trim()); buf = ''; } }
}
if (buf.trim()) stmts.push(buf.trim());

const roots = [], keyframes = [], scoped = [];
for (const s of stmts) {
  if (/^@keyframes/i.test(s)) keyframes.push(s);
  else if (/^:root\b/.test(s)) roots.push(s);
  else scoped.push(s);
}

// indent scoped statements one level inside @scope
const indented = scoped.map(s => '  ' + s.replace(/\n/g, '\n  ')).join('\n');

const out =
`/* ============================================================================
   Cipherline "glow in the deep" — design-system kit.
   VERBATIM CSS from Designsystem/cipherline-brand-guide-final.html, extracted
   programmatically (no hand-transcription). Only mechanical change: component
   rules are wrapped in @scope (.cl-kit) so the guide's generic selectors
   (.row, .field, button, *, h1…) cannot leak into the rest of the app.
   :root tokens + @keyframes are hoisted out (must be global). DO NOT hand-edit;
   re-run scripts/extract-kit.cjs to regenerate.
   ============================================================================ */

${roots.join('\n')}

${keyframes.join('\n')}

@scope (.cl-kit) {
${indented}
}
`;

fs.mkdirSync('apps/desktop/src/styles', { recursive: true });
fs.writeFileSync('apps/desktop/src/styles/cl-kit.css', out);
fs.mkdirSync('apps/desktop/scripts', { recursive: true });
fs.copyFileSync('/tmp/extract_kit.cjs', 'apps/desktop/scripts/extract-kit.cjs');
console.log('roots:', roots.length, 'keyframes:', keyframes.length, 'scoped rules:', scoped.length);
console.log('wrote apps/desktop/src/styles/cl-kit.css (' + out.length + ' bytes)');
