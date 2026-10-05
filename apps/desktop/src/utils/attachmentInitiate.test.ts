import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAttachmentInitiateBody } from './attachmentInitiate';

// POST /attachments/initiate is plaintext to the server. The file name must
// never be in it — it belongs in the E2EE envelope only.

describe('buildAttachmentInitiateBody', () => {
    it('DM attachment: size, mime and conversation — no file name', () => {
        const body = buildAttachmentInitiateBody({
            conversationId: 'conv-1', sizeBytes: 1234, mimeType: 'application/pdf',
        });
        expect(body).toEqual({ size_bytes: 1234, mime_type: 'application/pdf', conversation_id: 'conv-1' });
        expect(body).not.toHaveProperty('file_name');
    });

    it('channel attachment: channel_id instead of conversation_id', () => {
        const body = buildAttachmentInitiateBody({ channelId: 'ch-9', sizeBytes: 10, mimeType: 'image/png' });
        expect(body).toEqual({ size_bytes: 10, mime_type: 'image/png', channel_id: 'ch-9' });
        expect(body).not.toHaveProperty('file_name');
    });

    it('avatar / emoji / group icon shapes carry only their routing fields', () => {
        expect(buildAttachmentInitiateBody({ sizeBytes: 5, mimeType: 'image/jpeg' }))
            .toEqual({ size_bytes: 5, mime_type: 'image/jpeg' });
        expect(buildAttachmentInitiateBody({ sizeBytes: 5, mimeType: 'image/png', serverId: 's-1' }))
            .toEqual({ size_bytes: 5, mime_type: 'image/png', server_id: 's-1' });
        expect(buildAttachmentInitiateBody({
            sizeBytes: 5, mimeType: 'image/jpeg', conversationId: 'c-2', purpose: 'group_icon',
        })).toEqual({ size_bytes: 5, mime_type: 'image/jpeg', conversation_id: 'c-2', purpose: 'group_icon' });
    });

    it('drops extra properties a caller sneaks in (e.g. a name) instead of forwarding them', () => {
        const smuggled = { sizeBytes: 1, mimeType: 'text/plain', file_name: 'secret-plans.txt', fileName: 'x' };
        const body = buildAttachmentInitiateBody(smuggled as Parameters<typeof buildAttachmentInitiateBody>[0]);
        expect(Object.keys(body).sort()).toEqual(['mime_type', 'size_bytes']);
    });
});

// Source pin: every call site must build its body through the helper, and no
// desktop source may put a file_name into a request again. Scans the real
// files so a new initiate call site added by hand is caught too.
describe('attachments/initiate call sites', () => {
    const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files: string[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (statSync(p).isDirectory()) walk(p);
            else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
        }
    };
    walk(SRC);
    // Comments may mention the old field; only code counts.
    const code = (p: string) => readFileSync(p, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

    it('found the desktop sources (guards against a vacuous scan)', () => {
        expect(files.some(f => f.endsWith('ChatPane.tsx'))).toBe(true);
        expect(files.some(f => f.endsWith('useAttachments.ts'))).toBe(true);
    });

    it('no desktop source sends a file_name key', () => {
        const offenders = files.filter(f => /\bfile_name\s*:/.test(code(f)));
        expect(offenders).toEqual([]);
    });

    it('every initiate POST builds its body with buildAttachmentInitiateBody', () => {
        const sites: string[] = [];
        for (const f of files) {
            const src = code(f);
            const re = /attachments\/initiate`\s*,\s*([A-Za-z_]\w*)/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(src))) sites.push(`${f.slice(SRC.length)} → ${m[1]}`);
            const any = src.match(/attachments\/initiate`/g)?.length ?? 0;
            const counted = sites.filter(s => s.startsWith(f.slice(SRC.length))).length;
            expect(counted, `${f}: an initiate POST whose body isn't a named value`).toBe(any);
        }
        // ChatPane (DM + channel) and useAttachments.
        expect(sites.length).toBeGreaterThanOrEqual(3);
        for (const s of sites) {
            expect(s, s).toMatch(/→ (buildAttachmentInitiateBody|payload)$/);
        }
        // useAttachments assigns the builder's result to `payload`.
        const hook = code(join(SRC, 'hooks', 'useAttachments.ts'));
        expect(hook).toMatch(/const payload = buildAttachmentInitiateBody\(/);
    });
});
