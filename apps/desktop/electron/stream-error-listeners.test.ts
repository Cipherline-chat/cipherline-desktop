import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

/**
 * Source scan: every `fs.createReadStream` / `fs.createWriteStream` in the
 * main process has an 'error' listener.
 *
 * A stream's 'error' event with no listener is thrown as an
 * uncaughtException. For a failed open it is created by libuv, so it carries
 * NO JavaScript stack — exactly the shape of a crash report that cannot be
 * traced back to its call site (macOS, 2026-10-16: `main_exception` /
 * `uncaught-exception`, "ENOENT: no such file or directory, open '…'", stack
 * = the message line alone). Two such streams existed (the production static
 * server and the chunk-encrypt temp file); this keeps a third from appearing.
 *
 * Accepted: a listener chained on the call itself
 * (`fs.createReadStream(p).on('error', …)`), or — for a stream assigned to a
 * variable or property — `<name>.on('error'` / `.once('error'` anywhere in
 * the enclosing function.
 */

const ELECTRON_DIR = __dirname;
const STREAM_CALLS = new Set(['createReadStream', 'createWriteStream']);

interface Finding { file: string; line: number; text: string }

function enclosingFunctionText(node: ts.Node, sf: ts.SourceFile): string {
    let n: ts.Node | undefined = node.parent;
    while (n && !ts.isFunctionLike(n) && !ts.isSourceFile(n)) n = n.parent;
    return (n ?? sf).getText(sf);
}

function hasErrorListenerOn(name: string, scopeText: string): boolean {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`${esc}\\s*\\.\\s*(?:on|once|addListener)\\(\\s*['"]error['"]`).test(scopeText);
}

export function scanSource(file: string, source: string): Finding[] {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const out: Finding[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
            && STREAM_CALLS.has(node.expression.name.text)) {
            let ok = false;
            // 1. Chained: walk up through `.x(...)` links looking for .on/.once('error').
            let cur: ts.Node = node;
            while (ts.isPropertyAccessExpression(cur.parent) && ts.isCallExpression(cur.parent.parent)) {
                const call = cur.parent.parent;
                const method = cur.parent.name.text;
                const first = call.arguments[0];
                if ((method === 'on' || method === 'once' || method === 'addListener')
                    && first && ts.isStringLiteralLike(first) && first.text === 'error') { ok = true; break; }
                cur = call;
            }
            // 2. Assigned: `const x = fs.createX(...)` / `this.x = …` / `obj.x = …`.
            if (!ok) {
                const p = node.parent;
                let name: string | null = null;
                if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) name = p.name.text;
                else if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) name = p.left.getText(sf);
                if (name) ok = hasErrorListenerOn(name, enclosingFunctionText(node, sf));
            }
            if (!ok) {
                const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
                out.push({ file: path.basename(file), line: line + 1, text: node.parent.getText(sf).slice(0, 120) });
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

describe('main-process streams always have an error listener', () => {
    it('positive control: the scanner flags a bare stream and accepts the handled shapes', () => {
        const bad = scanSource('x.ts', `
            function a(res) { fs.createReadStream(p).pipe(res); }
            function b() { const w = fs.createWriteStream(p); w.write('x'); }
        `);
        expect(bad.map(f => f.line)).toEqual([2, 3]);
        const good = scanSource('y.ts', `
            function a(res) { const r = fs.createReadStream(p); r.on('error', () => res.destroy()); r.pipe(res); }
            function b() { fs.createReadStream(p).on('data', d).on('error', e); }
            function c() { const w = fs.createWriteStream(p); w.once('error', e); }
        `);
        expect(good).toEqual([]);
    });

    it('no electron/*.ts stream lacks one', () => {
        const files = fs.readdirSync(ELECTRON_DIR)
            .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'));
        expect(files).toContain('main.ts');
        const findings = files.flatMap(f => scanSource(f, fs.readFileSync(path.join(ELECTRON_DIR, f), 'utf8')));
        expect(findings).toEqual([]);
    });
});
