import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

/**
 * Source scan: no fire-and-forget NETWORK promise in electron/** without a
 * rejection handler.
 *
 * The class of bug behind the 1.0.20 crash (user 1998a718,
 * `net::ERR_HTTP2_PROTOCOL_ERROR` as an unhandledRejection): a promise from
 * something that talks to the network — Electron's `net`, `loadURL`,
 * electron-updater, the update scheduler — is started as a bare statement
 * (`foo();` / `void foo();` / `foo().then(ok);`), so when the network fails
 * nothing owns the rejection and the crash reporter records a crash.
 *
 * Precise rather than regex: it walks the TypeScript AST and flags an
 * EXPRESSION STATEMENT (so `await x()`, `return x()`, `const p = x()` and
 * arguments such as `loadHandled('…', win.loadURL(u))` are not statements and
 * are never flagged) whose call chain starts at a known network entry point
 * and contains neither `.catch(…)` nor `.then(ok, fail)`. It also flags an
 * `async` callback handed straight to a timer or an event emitter, whose
 * rejection nothing can ever observe, unless its whole body is one try/catch.
 *
 * When you add a new network entry point, add its name to NETWORK_CALLS and
 * fix the call sites this test then lists — do not allowlist them.
 */

/** Last property / identifier name of a call that reaches the network or is a promise-returning updater entry point. */
const NETWORK_CALLS: ReadonlySet<string> = new Set([
    'fetch',              // net.fetch / session.fetch / global fetch
    'loadURL', 'loadFile', // webContents / BrowserWindow loads: reject with ERR_* net-stack errors
    'checkForUpdates', 'downloadUpdate', // electron-updater
    'runUpdateRetry', 'startUpdateSchedule', // main.ts async updater entry points
    'checkForUpdatesHandled',
]);
/** `x.check(…)` only counts on the update scheduler. */
const SCHEDULER_RECEIVERS: ReadonlySet<string> = new Set(['updateScheduler', 'scheduler']);
const CALLBACK_HOSTS: ReadonlySet<string> = new Set(['setTimeout', 'setInterval', 'setImmediate', 'on', 'once', 'addListener']);

export interface Finding { file: string; line: number; text: string; why: string }

function unwrap(e: ts.Expression): ts.Expression {
    let cur = e;
    for (;;) {
        if (ts.isParenthesizedExpression(cur) || ts.isVoidExpression(cur) || ts.isNonNullExpression(cur) || ts.isAsExpression(cur)) cur = cur.expression;
        else return cur;
    }
}

/** Walk down a `.then().catch().finally()` chain; returns whether a rejection is handled and the innermost call. */
function analyseChain(call: ts.CallExpression): { handled: boolean; root: ts.CallExpression } {
    let handled = false;
    let cur: ts.CallExpression = call;
    for (;;) {
        const callee = cur.expression;
        if (ts.isPropertyAccessExpression(callee)) {
            const name = callee.name.text;
            const inner = unwrap(callee.expression);
            if ((name === 'catch') || (name === 'then' && cur.arguments.length >= 2)) handled = true;
            if ((name === 'catch' || name === 'then' || name === 'finally') && ts.isCallExpression(inner)) { cur = inner; continue; }
        }
        return { handled, root: cur };
    }
}

function isNetworkCall(call: ts.CallExpression): boolean {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) return NETWORK_CALLS.has(callee.text);
    if (ts.isPropertyAccessExpression(callee)) {
        if (NETWORK_CALLS.has(callee.name.text)) return true;
        if (callee.name.text === 'check') {
            const recv = unwrap(callee.expression);
            const recvName = ts.isIdentifier(recv) ? recv.text : ts.isPropertyAccessExpression(recv) ? recv.name.text : '';
            return SCHEDULER_RECEIVERS.has(recvName);
        }
    }
    return false;
}

function calleeName(call: ts.CallExpression): string {
    const c = call.expression;
    return ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : '';
}

/** The whole body is a single try { … } catch { … } (an async callback that cannot reject on its own). */
function bodyIsTryCatch(fn: ts.ArrowFunction | ts.FunctionExpression): boolean {
    const b = fn.body;
    if (!ts.isBlock(b) || b.statements.length !== 1) return false;
    const s = b.statements[0];
    return ts.isTryStatement(s) && !!s.catchClause;
}

export function findFloatingNetworkPromises(source: string, file = 'fixture.ts'): Finding[] {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const out: Finding[] = [];
    const add = (n: ts.Node, why: string) => {
        const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
        out.push({ file, line: line + 1, text: n.getText(sf).split('\n')[0].slice(0, 140), why });
    };
    const visit = (n: ts.Node): void => {
        if (ts.isExpressionStatement(n)) {
            const e = unwrap(n.expression);
            if (ts.isCallExpression(e)) {
                const { handled, root } = analyseChain(e);
                if (!handled && isNetworkCall(root)) add(n, `floating ${calleeName(root)}() with no .catch / .then(ok, fail)`);
            }
        }
        if (ts.isCallExpression(n) && CALLBACK_HOSTS.has(calleeName(n))) {
            for (const a of n.arguments) {
                if ((ts.isArrowFunction(a) || ts.isFunctionExpression(a)) && a.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) && !bodyIsTryCatch(a)) {
                    add(a, `async callback passed to ${calleeName(n)}() can reject unobserved (wrap the body in try/catch)`);
                }
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
}

describe('the scanner itself (fixtures: it flags what it should and nothing else)', () => {
    const flagged = (src: string) => findFloatingNetworkPromises(src).map((f) => f.why);

    it('flags bare / void / then-only network promises', () => {
        expect(flagged('mainWindow.loadURL(u);')).toHaveLength(1);
        expect(flagged('void mainWindow.loadURL(u);')).toHaveLength(1);
        expect(flagged('void autoUpdater.checkForUpdates();')).toHaveLength(1);
        expect(flagged('autoUpdater.checkForUpdates().then((r) => use(r));')).toHaveLength(1);
        expect(flagged("autoUpdater.checkForUpdates().then(ok).finally(done);")).toHaveLength(1);
        expect(flagged('net.fetch(u);')).toHaveLength(1);
        expect(flagged('void session.defaultSession.fetch(u);')).toHaveLength(1);
        expect(flagged("void runUpdateRetry('auto');")).toHaveLength(1);
        expect(flagged('void startUpdateSchedule();')).toHaveLength(1);
        expect(flagged("void updateScheduler.check('channel');")).toHaveLength(1);
        expect(flagged("void this.scheduler.check('x');")).toHaveLength(1);
        expect(flagged('(void checkForUpdatesHandled());')).toHaveLength(1);
    });

    it('flags an async timer / event callback that is not one try/catch', () => {
        expect(flagged('setTimeout(async () => { await net.fetch(u); }, 5);')).toHaveLength(1);
        expect(flagged("app.on('x', async () => { step(); });")).toHaveLength(1);
        expect(flagged('setInterval(async function () { await go(); }, 5);')).toHaveLength(1);
    });

    it('NEGATIVE: handled, awaited, returned, assigned and passed-on promises are not flagged', () => {
        for (const src of [
            'mainWindow.loadURL(u).catch(log);',
            'void mainWindow.loadURL(u).catch(log);',
            "autoUpdater.checkForUpdates().then(ok, fail);",
            "autoUpdater.checkForUpdates().then(ok).catch(fail);",
            "autoUpdater.checkForUpdates().catch(fail).finally(done);",
            'async function f() { await autoUpdater.checkForUpdates(); }',
            'async function f() { return net.fetch(u); }',
            'const p = net.fetch(u);',
            "loadHandled('x', mainWindow.loadURL(u));",
            "runUpdateRetry('auto').catch(log);",
            "await updateScheduler.check('manual');",
            // other `.check(` / `.fetch`-free calls are not network entry points
            "somethingElse.check('x');",
            'void cache.get(k);',
            // a try/catch-wrapped async callback cannot reject
            'setTimeout(async () => { try { await net.fetch(u); } catch (e) { log(e); } }, 5);',
            // a sync callback
            "app.on('x', () => { step(); });",
        ]) {
            expect(flagged(src), src).toEqual([]);
        }
    });
});

function electronSources(dir: string): string[] {
    const out: string[] = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { if (ent.name !== 'node_modules') out.push(...electronSources(p)); }
        else if (/\.ts$/.test(ent.name) && !/\.test\.ts$/.test(ent.name) && !/\.d\.ts$/.test(ent.name) && !ent.name.startsWith('test-')) out.push(p);
    }
    return out;
}

describe('electron/** has no fire-and-forget network promise without a handler', () => {
    const files = electronSources(__dirname);

    it('scans the real tree (guards against the scan silently covering nothing)', () => {
        expect(files.length).toBeGreaterThan(40);
        expect(files.some((f) => f.endsWith('main.ts'))).toBe(true);
    });

    it('finds none', () => {
        const findings: Finding[] = [];
        for (const f of files) findings.push(...findFloatingNetworkPromises(fs.readFileSync(f, 'utf8'), path.relative(__dirname, f)));
        expect(findings.map((x) => `${x.file}:${x.line}  ${x.why}\n    ${x.text}`)).toEqual([]);
    });

    it('POSITIVE CONTROL: the 1.0.20 updater code (checked in as a fixture string) IS flagged', () => {
        // Verbatim shape of v1.0.20 main.ts: the check's promise is caught, but the
        // fire-and-forget sites around it were bare.
        const old1020 = `
            autoUpdater.checkForUpdates().catch(() => { /* logged by the 'error' listener */ });
            setTimeout(() => { autoUpdater.checkForUpdates().then((r) => console.log(r)); }, 30000);
            mainWindow.loadURL(url);
        `;
        expect(findFloatingNetworkPromises(old1020).map((f) => f.line)).toEqual([3, 4]);
    });
});
