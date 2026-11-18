/**
 * packages/shared/card-style.ts must stay PURE: no DOM, no React, no Node or
 * browser APIs, no imports at all — so the mobile app and a future TypeScript
 * bot SDK can import the same validator and parser.
 *
 * Proven two ways:
 *  1. statically: the source imports nothing and names no host global;
 *  2. dynamically: the module is transpiled and EXECUTED inside a fresh
 *     `vm` context that has only the JavaScript built-ins (no window,
 *     document, navigator, TextEncoder, process, require...). Parsing,
 *     normalising and resolving all run there; any reach for a host global
 *     would throw a ReferenceError.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import ts from 'typescript';
import * as shared from '@cipherline/shared';

const SRC = path.resolve(__dirname, '../../../../../packages/shared/card-style.ts');
const source = fs.readFileSync(SRC, 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('card-style.ts is pure', () => {
    it('imports nothing and names no host global', () => {
        expect(code).not.toMatch(/^\s*import\s/m);
        expect(code).not.toMatch(/\brequire\s*\(/);
        for (const g of ['window', 'document', 'navigator', 'globalThis', 'self', 'process', 'Buffer', 'TextEncoder', 'TextDecoder', 'localStorage', 'sessionStorage', 'indexedDB', 'fetch', 'XMLHttpRequest', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'getComputedStyle', 'React', 'eval', 'Function']) {
            expect(code, g).not.toMatch(new RegExp(`(^|[^.\\w$'"])${g}\\b`));
        }
    });

    it('runs in a context with only JavaScript built-ins', () => {
        const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
        const sandbox: Record<string, unknown> = { exports: {}, module: { exports: {} } };
        (sandbox.module as { exports: unknown }).exports = sandbox.exports;
        const ctx = vm.createContext(sandbox);
        vm.runInContext(js, ctx, { filename: 'card-style.js' });
        // The sandbox has none of the host's globals.
        expect(vm.runInContext('typeof window + typeof document + typeof navigator + typeof TextEncoder + typeof process + typeof require', ctx))
            .toBe('undefined'.repeat(6));
        const m = sandbox.exports as typeof shared;
        const css = m.parseCardStyleCss('background: linear-gradient(135deg, #25e0c8, hsl(231 44% 56% / 0.8)); border: 1px solid #25e0c8; box-shadow: 0 0 40px #fff; color: #0b0f1e; animation: drift 5s; position: fixed');
        expect(css.style).not.toBeNull();
        const json = m.normalizeCardStyle(JSON.parse(JSON.stringify(css.style)));
        const resolved = m.resolveCardStyle(json, 'full', m.CARD_THEMES.light);
        expect(resolved).not.toBeNull();
        expect(m.cardStyleToCss(json)).toContain('linear-gradient');
        expect(m.effectiveCardRenderMode({ user: 'all', server: 'no_animation' })).toBe('static');
        // Same answers as the module the app imports.
        expect(JSON.parse(JSON.stringify(css.style))).toEqual(shared.parseCardStyleCss('background: linear-gradient(135deg, #25e0c8, hsl(231 44% 56% / 0.8)); border: 1px solid #25e0c8; box-shadow: 0 0 40px #fff; color: #0b0f1e; animation: drift 5s; position: fixed').style);
    });
});
