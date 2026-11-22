// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    READABILITY_SPECS, READABILITY_STORE_KEYS, READABILITY_DEFAULTS, GROUP_GAP_KEY, GROUP_GAP_DEFAULT_PX,
    parseReadability, parseGroupGap, effectiveGroupGap, readabilityAttrs, applyReadability,
    type ReadabilityId,
} from './readability';
import { toastDurationMs } from './toastDuration';
import { classifyKvKey } from '../../services/backupRegistry';

const root = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('defaults are today\'s behaviour', () => {
    it('every default is the first/neutral value and the state default matches the table', () => {
        expect(READABILITY_DEFAULTS).toEqual({ density: 'cozy', font: 'default', leading: 'normal', tracking: 'normal', focus: 'off', links: 'off', groupGap: null });
        expect(READABILITY_SPECS.time.def).toBe('auto');
        expect(READABILITY_SPECS.toast.def).toBe('normal');
        for (const s of Object.values(READABILITY_SPECS)) expect(s.values[0]).toBe(s.def);
    });
    it('Cozy uses the 12px gap Tailwind mt-3 gave a new sender', () => {
        expect(GROUP_GAP_DEFAULT_PX.cozy).toBe(12);
        expect(effectiveGroupGap('cozy', null)).toBe(12);
        expect(effectiveGroupGap('compact', null)).toBe(GROUP_GAP_DEFAULT_PX.compact);
    });
});

describe('parseReadability (validated on read)', () => {
    it.each(Object.keys(READABILITY_SPECS) as ReadabilityId[])('%s: every allowed value round-trips', (id) => {
        for (const v of READABILITY_SPECS[id].values) expect(parseReadability(id, v)).toBe(v);
    });
    it.each([null, undefined, '', 'COMPACT', 'compact ', 'bold', '1'])('unknown %j falls back to the default', (raw) => {
        for (const id of Object.keys(READABILITY_SPECS) as ReadabilityId[]) expect(parseReadability(id, raw as string)).toBe(READABILITY_SPECS[id].def);
    });
    it('positive control: the parser does accept a non-default', () => {
        expect(parseReadability('density', 'compact')).toBe('compact');
        expect(parseReadability('font', 'opendyslexic')).toBe('opendyslexic');
    });
});

describe('space between message groups', () => {
    it.each([['0', 0], ['4', 4], ['12', 12], ['24', 24]])('%s -> %d', (raw, n) => { expect(parseGroupGap(raw)).toBe(n); });
    it.each([[null], [''], ['25'], ['-1'], ['99'], ['3.5'], ['abc'], ['07x']])('%j -> null (use the density\'s own)', (raw) => {
        expect(parseGroupGap(raw as string | null)).toBeNull();
    });
    it('an explicit 0 is honoured, not treated as unset', () => {
        expect(effectiveGroupGap('cozy', 0)).toBe(0);
    });
});

describe('data attributes', () => {
    beforeEach(() => { document.documentElement.removeAttribute('style'); });
    it('maps a state to attributes and the gap variable', () => {
        const { attrs, gapPx } = readabilityAttrs({ ...READABILITY_DEFAULTS, density: 'compact', font: 'lexend', focus: 'on', groupGap: 7 });
        expect(attrs).toMatchObject({ 'data-a11y-density': 'compact', 'data-a11y-font': 'lexend', 'data-a11y-focus': 'on', 'data-a11y-leading': 'normal' });
        expect(gapPx).toBe(7);
    });
    it('applyReadability sets them on the element', () => {
        const el = document.createElement('div');
        applyReadability({ ...READABILITY_DEFAULTS, density: 'compact', links: 'on' }, el);
        expect(el.getAttribute('data-a11y-density')).toBe('compact');
        expect(el.getAttribute('data-a11y-links')).toBe('on');
        expect(el.style.getPropertyValue('--cl-msg-group-gap')).toBe(`${GROUP_GAP_DEFAULT_PX.compact}px`);
    });
});

describe('toast duration', () => {
    it('Normal is today\'s countdown, Long doubles it, Until I close them has none', () => {
        expect(toastDurationMs(4500, 'normal')).toBe(4500);
        expect(toastDurationMs(4500, 'long')).toBe(9000);
        expect(toastDurationMs(4500, 'sticky')).toBe(0);
    });
    it('a toast that never auto-dismissed is untouched (0 stays 0, never doubled into a timer)', () => {
        for (const p of ['normal', 'long', 'sticky'] as const) expect(toastDurationMs(0, p)).toBe(0);
    });
    it('ToastContext reads the preference at push time', () => {
        const src = read('src/contexts/ToastContext.tsx');
        expect(src).toMatch(/toastDurationMs\(input\.durationMs \?\? 4500, readToastPref\(\)\)/);
    });
});

describe('persistence: backed up, never raw localStorage, no write on mount', () => {
    it('every stored key is a portable preference (classified include)', () => {
        for (const k of READABILITY_STORE_KEYS) expect(classifyKvKey(k, 'u1'), k).toBe('include');
        expect(READABILITY_STORE_KEYS).toContain(GROUP_GAP_KEY);
        expect(READABILITY_STORE_KEYS.length).toBe(Object.keys(READABILITY_SPECS).length + 1);
    });
    it('positive control: an unclassified key is not "include"', () => {
        expect(classifyKvKey('cipherline_a11y_not_a_setting', 'u1')).not.toBe('include');
    });
    it('the hook only writes from the setters (no setItem outside set/setGroupGap) and never touches localStorage', () => {
        const hook = read('src/hooks/useReadability.ts');
        expect(hook).not.toMatch(/localStorage/);
        const writes = hook.match(/secureLocalStore\.(setItem|removeItem)\(/g) ?? [];
        expect(writes.length).toBe(3); // set, setGroupGap (set / remove)
        const before = hook.slice(0, hook.indexOf('const set = useCallback'));
        expect(before).not.toMatch(/secureLocalStore\.(setItem|removeItem)\(/);
    });
    it('the pane is mounted in the Accessibility pane and every control has a search label', () => {
        expect(read('src/components/settings/panes/AccessibilityPane.tsx')).toMatch(/<ReadabilityCards \/>/);
        const idx = read('src/components/settings/settingsSearchIndex.ts');
        for (const label of ['Message spacing', 'Space between message groups', 'Font', 'Line spacing', 'Letter spacing', 'Time format', 'Always show focus outline', 'Underline links', 'Pop-up duration']) {
            expect(idx, label).toContain(`label: '${label}'`);
        }
    });
});

describe('CSS: defaults change nothing; each setting is behind its attribute', () => {
    const css = read('src/styles/readability.css');
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
    it('Compact rules are all under data-a11y-density="compact"', () => {
        const rules = css.split('\n').filter(l => /\.cl-msg-(row|av|gutter|head)/.test(l) && !/^\s*\/\*|^\.cl-msg-row--head|^\.cl-msg-gutter(::before)?\{/.test(l) && /\{/.test(l));
        for (const r of rules) expect(r, r).toContain('[data-a11y-density="compact"]');
    });
    it('the gap above a new sender is the variable, defaulting to 12px', () => {
        expect(css).toMatch(/\.cl-msg-row--head\{margin-top:var\(--cl-msg-group-gap,12px\)\}/);
    });
    it('fonts: bundled woff2 files exist, no remote url, code and per-message fonts are not re-pointed', () => {
        for (const f of ['lexend-latin-400-normal', 'lexend-latin-700-normal', 'opendyslexic-latin-400-normal', 'opendyslexic-latin-700-normal']) {
            expect(css).toContain(`../assets/fonts/${f}.woff2`);
            expect(fs.existsSync(path.join(root, 'src/assets/fonts', `${f}.woff2`)), f).toBe(true);
        }
        expect(code).not.toMatch(/https?:\/\//);
        expect(code).not.toMatch(/--cl-font-mono|\.font-mono|data-msg-font/);
    });
    it('font licences ship with the app and are OFL 1.1', () => {
        for (const f of ['Lexend-OFL.license', 'OpenDyslexic-OFL.license']) {
            const t = read(`public/licenses/fonts/${f}`);
            expect(t).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
        }
        const lic = read('LICENSES.md');
        expect(lic).toMatch(/\*\*Lexend\*\*/);
        expect(lic).toMatch(/\*\*OpenDyslexic\*\*/);
    });
    it('Relaxed line spacing scales the long-message collapse with it', () => {
        expect(css).toMatch(/data-a11y-leading="relaxed"\]\{--cl-msg-leading:1\.7;--cl-msg-leading-mult:1\.25\}/);
        expect(read('src/styles/long-message.css')).toContain('var(--cl-msg-leading-mult, 1)');
    });
    it('the message body and the composer share ONE line-height source (WYSIWYG)', () => {
        const size = read('src/utils/formatting/messageSize.ts');
        expect(size).toContain("MESSAGE_BODY_LINE_HEIGHT = 'var(--cl-msg-leading, normal)'");
        expect(read('src/utils/cardStyle/cardStyleReact.ts')).toContain('lineHeight: MESSAGE_BODY_LINE_HEIGHT');
        expect(read('src/components/ChatPane.tsx')).toContain('MESSAGE_BODY_LINE_HEIGHT');
    });
    it('always-on focus covers mouse focus (:focus, not :focus-visible) with a 2px ring', () => {
        expect(code).toMatch(/data-a11y-focus="on"\] :is\([\s\S]*?\):focus\{\s*outline:2px solid/);
        expect(code).not.toMatch(/data-a11y-focus="on"[^{]*focus-visible/);
    });
});

describe('ChatPane rows carry the density hooks', () => {
    const chat = read('src/components/ChatPane.tsx');
    it('row, header, avatar and the grouped gutter have their classes; the gap is the variable, not mt-3', () => {
        expect(chat).toContain("cl-msg-row group relative flex");
        expect(chat).toContain("'cl-msg-row--head'");
        expect(chat).toContain('cl-msg-av w-10 h-10');
        expect(chat).toContain('cl-msg-gutter w-10 shrink-0');
        expect(chat).toContain('cl-msg-head flex items-baseline');
        expect(chat).not.toMatch(/showHeader \? 'mt-3' : ''/);
    });
    it('the gutter time is a data attribute painted by CSS (never copied) and aria-hidden', () => {
        expect(chat).toMatch(/cl-msg-gutter[^\n]*data-t=\{[^}]*formatClockShort[^\n]*aria-hidden="true"/);
    });
});
