/**
 * An in-memory stand-in for the slice of the Google Drive v3 REST API that
 * drive-api.ts uses, shaped as a `DriveHttp`. TEST SUPPORT ONLY: excluded from
 * the electron build (tsconfig.electron.json excludes electron/test-*.ts; this
 * file is imported only by *.test.ts, and is not referenced from main.ts).
 *
 * It understands exactly the `q` clauses the app emits:
 *   mimeType='X' | mimeType!='X' | name='N' | name contains 'N' |
 *   'P' in parents | trashed=false
 */

import type { DriveHttp } from './driveTransfer';

export const FOLDER = 'application/vnd.google-apps.folder';

export interface FakeNode {
    id: string;
    name: string;
    mimeType: string;
    trashed?: boolean;
    parents?: string[];
    size?: string;
    createdTime?: string;
    modifiedTime?: string;
    canEdit?: boolean;
}

export interface FakeCall { method: string; url: string; auth: string | undefined; body?: unknown }

export function createFakeDrive(seed: FakeNode[] = []) {
    const nodes = new Map<string, FakeNode>(seed.map(n => [n.id, n]));
    const calls: FakeCall[] = [];
    /** id -> forced HTTP status for metadata GET/DELETE by id (e.g. 403, 401). */
    const forced = new Map<string, number>();
    let failAll: Error | null = null;
    let created = 0;

    const unq = (s: string) => s.replace(/\\(.)/g, '$1');
    function matches(n: FakeNode, q: string): boolean {
        const clauses = q.split(/ and /);
        // Re-join pieces split inside a quoted literal (a name containing " and ").
        const joined: string[] = [];
        for (const c of clauses) {
            const open = joined.length ? (joined[joined.length - 1].match(/(?<!\\)'/g) || []).length % 2 === 1 : false;
            if (open) joined[joined.length - 1] += ' and ' + c; else joined.push(c);
        }
        for (const c of joined) {
            let m: RegExpExecArray | null;
            if ((m = /^mimeType='(.*)'$/.exec(c))) { if (n.mimeType !== unq(m[1])) return false; }
            else if ((m = /^mimeType!='(.*)'$/.exec(c))) { if (n.mimeType === unq(m[1])) return false; }
            else if ((m = /^name='(.*)'$/.exec(c))) { if (n.name !== unq(m[1])) return false; }
            else if ((m = /^name contains '(.*)'$/.exec(c))) { if (!n.name.includes(unq(m[1]))) return false; }
            else if ((m = /^'(.*)' in parents$/.exec(c))) { if (!(n.parents || []).includes(unq(m[1]))) return false; }
            else if (c === 'trashed=false') { if (n.trashed) return false; }
            else throw new Error(`fake drive: unsupported q clause: ${c}`);
        }
        return true;
    }
    const pick = (n: FakeNode, fields: string) => {
        const out: Record<string, unknown> = {};
        for (const f of fields.split(',')) {
            const k = f.trim();
            if (k === 'capabilities/canEdit') { out.capabilities = { canEdit: n.canEdit ?? true }; continue; }
            if (k in n) out[k] = (n as unknown as Record<string, unknown>)[k];
        }
        return out;
    };
    const reply = (status: number, body: unknown = {}) => ({
        status, headers: {} as Record<string, string>, body: Buffer.from(JSON.stringify(body)),
    });

    const http: DriveHttp = async (rawUrl, opts) => {
        const url = new URL(rawUrl);
        const auth = (opts.headers as Record<string, string> | undefined)?.Authorization;
        const body = opts.body ? JSON.parse(opts.body.toString('utf8')) : undefined;
        calls.push({ method: opts.method, url: decodeURIComponent(rawUrl), auth, body });
        if (failAll) throw failAll;
        if (url.hostname !== 'www.googleapis.com' || !url.pathname.startsWith('/drive/v3/files')) {
            throw new Error(`fake drive: unexpected endpoint ${rawUrl}`);
        }
        const rest = url.pathname.slice('/drive/v3/files'.length).replace(/^\//, '');
        if (!rest) {
            if (opts.method === 'GET') {
                const q = url.searchParams.get('q') || '';
                const fields = (url.searchParams.get('fields') || 'files(id)').replace(/^files\(|\)$/g, '');
                let files = [...nodes.values()].filter(n => matches(n, q));
                const order = url.searchParams.get('orderBy');
                if (order === 'createdTime') files.sort((a, b) => (a.createdTime || '').localeCompare(b.createdTime || ''));
                if (order === 'modifiedTime desc') files.sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''));
                files = files.slice(0, Number(url.searchParams.get('pageSize') || 100));
                return reply(200, { files: files.map(n => pick(n, fields)) });
            }
            if (opts.method === 'POST') {
                const id = `created-folder-${++created}`;
                nodes.set(id, { id, name: body.name, mimeType: body.mimeType, createdTime: '2026-10-20T00:00:00Z' });
                return reply(200, { id, name: body.name });
            }
        }
        const status = forced.get(rest);
        if (status) return reply(status);
        const n = nodes.get(rest);
        if (!n) return reply(404);
        if (opts.method === 'GET') return reply(200, pick(n, url.searchParams.get('fields') || 'id'));
        if (opts.method === 'DELETE') { nodes.delete(rest); return reply(204); }
        throw new Error(`fake drive: unsupported ${opts.method} ${rawUrl}`);
    };

    return {
        http, nodes, calls,
        force: (id: string, status: number) => { forced.set(id, status); },
        failEverythingWith: (err: Error) => { failAll = err; },
        add: (n: FakeNode) => { nodes.set(n.id, n); },
        callsMatching: (re: RegExp) => calls.filter(c => re.test(`${c.method} ${c.url}`)),
    };
}
