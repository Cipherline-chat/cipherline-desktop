import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    APP_BACKUP_FOLDER,
    createAppFolder,
    ensureAppFolder,
    escapeDriveQuery,
    findAppFolder,
    isFolderAccessible,
    resolveDriveFolder,
} from './driveFolders';

// Cipherline only holds the Drive `drive.file` scope (plus `email`): it can see
// and modify the files and folders IT created, nothing else. So there is no
// folder browser — backups live in one app-created folder, "Cipherline
// Backups", found again by its stored id and, failing that, by a name search
// that `drive.file` itself limits to app-created folders.

const TOKEN = 'ya29.test-access-token';

function okResponse(body: unknown) {
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function errResponse(status: number) {
    return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

const urlOf = (call: unknown[]) => decodeURIComponent(String(call[0]));

describe('findAppFolder', () => {
    it('searches by folder mime type + exact name + not-trashed — anywhere in Drive', async () => {
        fetchMock.mockResolvedValue(okResponse({ files: [] }));
        await findAppFolder(TOKEN);
        const url = urlOf(fetchMock.mock.calls[0]);
        expect(url).toContain("mimeType='application/vnd.google-apps.folder'");
        expect(url).toContain("name='Cipherline Backups'");
        expect(url).toContain('trashed=false');
        // No parent clause: the folder may have been moved, and listing 'root'
        // or any other folder is exactly what drive.file cannot be trusted with.
        expect(url).not.toContain('in parents');
    });

    it('picks the OLDEST match so every device converges on the folder that already holds backups', async () => {
        fetchMock.mockResolvedValue(okResponse({ files: [{ id: 'old' }, { id: 'newer' }] }));
        expect(await findAppFolder(TOKEN)).toBe('old');
        expect(urlOf(fetchMock.mock.calls[0])).toContain('orderBy=createdTime');
    });

    it('returns null when nothing matches', async () => {
        fetchMock.mockResolvedValue(okResponse({ files: [] }));
        expect(await findAppFolder(TOKEN)).toBeNull();
        fetchMock.mockResolvedValue(okResponse({}));
        expect(await findAppFolder(TOKEN)).toBeNull();
    });

    it('authorises with the bearer token and only reads', async () => {
        fetchMock.mockResolvedValue(okResponse({ files: [] }));
        await findAppFolder(TOKEN);
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
        expect(init.method ?? 'GET').toBe('GET');
    });

    it('surfaces a failed search instead of treating it as "no folder" (which would create a duplicate)', async () => {
        fetchMock.mockResolvedValue(errResponse(500));
        await expect(findAppFolder(TOKEN)).rejects.toThrow('500');
    });

    it("escapes a quote in the name so the query can't be broken out of", async () => {
        fetchMock.mockResolvedValue(okResponse({ files: [] }));
        await findAppFolder(TOKEN, "Bob's");
        expect(urlOf(fetchMock.mock.calls[0])).toContain("name='Bob\\'s'");
        expect(escapeDriveQuery("a'b\\c")).toBe("a\\'b\\\\c");
    });
});

describe('createAppFolder', () => {
    it('creates a folder with the app name and OMITS parents (the My Drive root is not addressable under drive.file)', async () => {
        fetchMock.mockResolvedValue(okResponse({ id: 'new-folder' }));
        expect(await createAppFolder(TOKEN)).toBe('new-folder');
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://www.googleapis.com/drive/v3/files');
        expect(init.method).toBe('POST');
        const body = JSON.parse(String(init.body));
        expect(body).toEqual({ name: APP_BACKUP_FOLDER, mimeType: 'application/vnd.google-apps.folder' });
        expect(body).not.toHaveProperty('parents');
    });

    it('explains a 401 as an expired Drive session', async () => {
        fetchMock.mockResolvedValue(errResponse(401));
        await expect(createAppFolder(TOKEN)).rejects.toThrow(/session expired/i);
    });

    it('surfaces the status for other failures', async () => {
        fetchMock.mockResolvedValue(errResponse(500));
        await expect(createAppFolder(TOKEN)).rejects.toThrow('500');
    });
});

describe('ensureAppFolder', () => {
    it('reuses the existing app folder without creating another', async () => {
        fetchMock.mockResolvedValue(okResponse({ files: [{ id: 'existing' }] }));
        expect(await ensureAppFolder(TOKEN)).toBe('existing');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('creates the folder on first use', async () => {
        fetchMock
            .mockResolvedValueOnce(okResponse({ files: [] }))
            .mockResolvedValueOnce(okResponse({ id: 'created' }));
        expect(await ensureAppFolder(TOKEN)).toBe('created');
        expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('POST');
    });
});

describe('isFolderAccessible', () => {
    it('is true for a reachable, live folder', async () => {
        fetchMock.mockResolvedValue(okResponse({ id: 'f', trashed: false }));
        expect(await isFolderAccessible(TOKEN, 'f')).toBe(true);
    });
    it('is false for a trashed folder', async () => {
        fetchMock.mockResolvedValue(okResponse({ id: 'f', trashed: true }));
        expect(await isFolderAccessible(TOKEN, 'f')).toBe(false);
    });
    it.each([403, 404])('is false on a %i (gone, or outside what the narrow grant can see)', async (status) => {
        fetchMock.mockResolvedValue(errResponse(status));
        expect(await isFolderAccessible(TOKEN, 'f')).toBe(false);
    });
    it.each([401, 500])('rethrows a %i — an auth-wide or server failure is not a stale folder', async (status) => {
        fetchMock.mockResolvedValue(errResponse(status));
        await expect(isFolderAccessible(TOKEN, 'f')).rejects.toThrow(String(status));
    });
});

describe('resolveDriveFolder — app folder create/reuse', () => {
    /** Routes the three calls resolveDriveFolder can make. */
    function route(opts: { accessible?: Set<string>; found?: string | null; createdId?: string }) {
        const { accessible = new Set<string>(), found = null, createdId = 'created-id' } = opts;
        fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
            const idMatch = /\/files\/([^/?]+)\?fields=id,trashed$/.exec(url);
            if (idMatch) return accessible.has(idMatch[1]) ? okResponse({ id: idMatch[1], trashed: false }) : errResponse(404);
            if (init?.method === 'POST') return okResponse({ id: createdId });
            return okResponse({ files: found ? [{ id: found }] : [] });
        });
    }
    const searched = () => fetchMock.mock.calls.some(c => urlOf(c).includes('mimeType='));
    const created = () => fetchMock.mock.calls.some(c => (c[1] as RequestInit | undefined)?.method === 'POST');

    it('creates the app folder on the first backup (nothing stored, nothing found)', async () => {
        route({ found: null });
        expect(await resolveDriveFolder(TOKEN, null, APP_BACKUP_FOLDER, { create: true }))
            .toEqual({ folderId: 'created-id', recovered: false });
        expect(created()).toBe(true);
    });

    it('with nothing stored, finds an existing app folder by search rather than creating a second (new device)', async () => {
        route({ found: 'device-a-folder' });
        expect(await resolveDriveFolder(TOKEN, null, APP_BACKUP_FOLDER, { create: true }))
            .toEqual({ folderId: 'device-a-folder', recovered: false });
        expect(created()).toBe(false);
    });

    it('with create:false and nothing found, reports no folder and creates nothing', async () => {
        route({ found: null });
        expect(await resolveDriveFolder(TOKEN, null, APP_BACKUP_FOLDER, { create: false }))
            .toEqual({ folderId: null, recovered: false });
        expect(created()).toBe(false);
    });

    it('reuses the stored id when it is still accessible — without searching at all', async () => {
        route({ accessible: new Set(['stored']), found: 'someone-else' });
        expect(await resolveDriveFolder(TOKEN, 'stored', APP_BACKUP_FOLDER, { create: true }))
            .toEqual({ folderId: 'stored', recovered: false });
        expect(searched()).toBe(false);
        expect(created()).toBe(false);
    });

    it('a folder the user MOVED or RENAMED in Drive is still found by its id', async () => {
        // The metadata GET answers for the id no matter what the folder is now
        // called or where it now sits; the resolver never inspects either.
        fetchMock.mockResolvedValue(okResponse({ id: 'stored', name: 'My renamed backups', parents: ['some-other-folder'], trashed: false }));
        expect(await resolveDriveFolder(TOKEN, 'stored', APP_BACKUP_FOLDER, { create: true }))
            .toEqual({ folderId: 'stored', recovered: false });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a stored id that 404s falls back to the app folder found by name, and says it recovered', async () => {
        route({ accessible: new Set(), found: 'app-folder' });
        expect(await resolveDriveFolder(TOKEN, 'dead', APP_BACKUP_FOLDER, { create: true }))
            .toEqual({ folderId: 'app-folder', recovered: true });
        expect(created()).toBe(false);
    });

    it('a stored id that 404s with no app folder yet creates one', async () => {
        route({ accessible: new Set(), found: null });
        expect(await resolveDriveFolder(TOKEN, 'dead', APP_BACKUP_FOLDER, { create: true }))
            .toEqual({ folderId: 'created-id', recovered: true });
    });
});

// ── Source guards ─────────────────────────────────────────────────────────────
// `drive.metadata.readonly` is a RESTRICTED Drive scope: requesting it without
// Google's verification gives every user an "unverified app" warning. It was
// added only for the in-app folder browser (added fdc955e9, dropped f86626d9,
// restored c4aa16e3, dropped 8db34c2f, restored 2026-09-05, removed for good
// with this change). These read the source directly so the decision can't be
// quietly undone — anyone who does change it has to change a test saying why.

const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** Read a source file with comments stripped, so these guards match real code
 *  and not the prose explaining the decision (which quotes the very strings
 *  being asserted on). */
const read = (rel: string) =>
    readFileSync(join(DESKTOP_ROOT, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('Drive OAuth scopes', () => {
    const auth = read('electron/googleDriveAuth.ts');
    const scopeLine = /const SCOPE\s*=\s*'([^']*)'/.exec(auth)?.[1] ?? '';
    const requested = scopeLine.split(/\s+/).filter(Boolean);

    it('requests drive.file — the backup read/write itself depends on it', () => {
        expect(requested).toContain('https://www.googleapis.com/auth/drive.file');
    });

    it('requests email — the connected account shown in Settings is read from userinfo', () => {
        expect(requested).toContain('email');
        expect(auth).toContain('userInfo.email');
    });

    it('requests ONLY email + drive.file', () => {
        expect([...requested].sort()).toEqual(['email', 'https://www.googleapis.com/auth/drive.file']);
    });

    it('does NOT request drive.metadata.readonly (restricted scope => Google verification + unverified-app warning)', () => {
        expect(scopeLine).not.toContain('drive.metadata');
    });

    it.each([
        'drive.readonly',
        'drive.appdata',
        'drive.scripts',
        'drive.metadata',
    ])('does NOT request %s', (scope) => {
        expect(scopeLine).not.toContain(scope);
    });

    it('does not request full-Drive access', () => {
        // Guard `auth/drive` on its own while allowing auth/drive.file.
        expect(scopeLine).not.toMatch(/auth\/drive(?![.\w])/);
    });

    it('never inspects the granted-scope list, so a token holding the old broader grant keeps working', () => {
        expect(auth).not.toMatch(/tokenResp\.scope|resp\.scope|\.scope\b.*split|include_granted_scopes/);
    });
});

describe('there is no Drive folder browser', () => {
    it('the folder-picker component is gone', () => {
        expect(existsSync(join(DESKTOP_ROOT, 'src/components/DriveFolderPicker.tsx'))).toBe(false);
    });

    it('nothing in the renderer or main process lists the user\'s Drive folders', () => {
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(join(DESKTOP_ROOT, dir))) {
                const rel = `${dir}/${name}`;
                if (statSync(join(DESKTOP_ROOT, rel)).isDirectory()) { walk(rel); continue; }
                if (!/\.(ts|tsx)$/.test(name) || /\.test\.(ts|tsx)$/.test(name)) continue;
                const src = read(rel);
                if (/listDriveFolders|DriveFolderPicker|googlePicker|pickDriveFolder/.test(src)
                    || /'root'\s+in\s+parents/.test(src)) offenders.push(rel);
            }
        };
        walk('src');
        walk('electron');
        expect(offenders).toEqual([]);
    });

    it('Settings tells the user where backups go instead of offering a chooser', () => {
        const raw = readFileSync(join(DESKTOP_ROOT, 'src/components/BackupSection.tsx'), 'utf8');
        expect(raw).toContain('Backups are saved to the');
        expect(raw).toContain('You can move or rename it in Drive; Cipherline will keep finding it.');
        expect(raw).not.toContain('onPickDriveFolder');
        expect(raw).not.toContain('Browse your Drive');
    });
});
