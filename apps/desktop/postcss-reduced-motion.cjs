/**
 * PostCSS: make every `@media (prefers-reduced-motion: reduce | no-preference)`
 * block also answer to the in-app "Reduce motion" setting
 * (Settings → Accessibility; utils/a11y/motionPrefs.ts), WITHOUT hand-editing
 * the 200+ existing rules.
 *
 * The setting is an attribute on <html>: data-reduced-motion="true" (force
 * reduced), "false" (force full motion), absent (follow the OS). For a block
 *
 *     @media (prefers-reduced-motion: reduce) { .a { animation: none } }
 *
 * this emits
 *
 *     @media (prefers-reduced-motion: reduce) {
 *       :where(:root:not([data-reduced-motion="false"])) .a { animation: none } }
 *     :where(:root[data-reduced-motion="true"]) .a { animation: none }
 *
 * `:where()` keeps specificity identical to the original rule, and the copy
 * sits right after the block, so cascade order is unchanged. `no-preference`
 * blocks (motion-safe, App.css) mirror it: they apply unless forced reduced,
 * and also when forced full motion under an OS reduce.
 *
 * Runs after Tailwind, so `motion-reduce:` / `motion-safe:` utilities are
 * covered too. Only the two simple query forms are handled; a test
 * (postcssReducedMotion.test.ts) fails if a stylesheet uses any other form.
 */
const REDUCE = /^\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)$/i;
const NOPREF = /^\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)$/i;

const ATTR = 'data-reduced-motion';

function prefixSelector(sel, scope) {
    const s = sel.trim();
    // A selector that starts at the root element must constrain the root itself.
    const m = /^(:root|html)(?![\w-])/i.exec(s);
    if (m) return `:root:where(${scope.attrOnly})${s.slice(m[0].length)}`;
    return `:where(${scope.full}) ${s}`;
}

function rewrite(rule, scope) {
    rule.selectors = rule.selectors.map(sel => prefixSelector(sel, scope));
}

function eachRule(container, fn) {
    container.walkRules(rule => {
        // Rules inside @keyframes are not selectors.
        if (rule.parent && rule.parent.type === 'atrule' && /keyframes$/i.test(rule.parent.name)) return;
        fn(rule);
    });
}

module.exports = () => ({
    postcssPlugin: 'cl-reduced-motion',
    Once(root) {
        const blocks = [];
        root.walkAtRules('media', at => {
            const p = at.params.trim();
            if (REDUCE.test(p)) blocks.push([at, 'reduce']);
            else if (NOPREF.test(p)) blocks.push([at, 'nopref']);
        });
        for (const [at, kind] of blocks) {
            const copy = at.clone();
            // Original (OS) block.
            const osScope = kind === 'reduce'
                ? { full: `:root:not([${ATTR}="false"])`, attrOnly: `:not([${ATTR}="false"])` }
                : { full: `:root:not([${ATTR}="true"])`, attrOnly: `:not([${ATTR}="true"])` };
            eachRule(at, r => rewrite(r, osScope));
            // Forced copy, outside any media query.
            const forced = kind === 'reduce'
                ? { full: `:root[${ATTR}="true"]`, attrOnly: `[${ATTR}="true"]` }
                : { full: `:root[${ATTR}="false"]`, attrOnly: `[${ATTR}="false"]` };
            eachRule(copy, r => rewrite(r, forced));
            // Hoist the copy's children after the media block (keeps source order).
            const hoisted = copy.nodes.map(n => n.clone());
            let anchor = at;
            for (const n of hoisted) { at.parent.insertAfter(anchor, n); anchor = n; }
        }
    },
});
module.exports.postcss = true;
