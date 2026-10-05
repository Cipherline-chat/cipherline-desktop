import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    DRIVE_ROOT_ID,
    DriveScopeMissingError,
    createDriveFolder,
    listDriveFolders,
} from './driveFolders';

// The two halves of the "Select backup folder" dialog need different things
// from Google:
//
//   createDriveFolder never needed a broad OAuth scope: `drive.file` always
//   lets an app create new items and keep access to what it created. The one
//   real trap is the parent — under `drive.file` the My Drive root is not an
//   item we're allowed to address, so naming it explicitly ("parents:
//   ['root']", which an older dialog did) asks Google for something outside the
//   grant. Omitting `parents` lets Drive default to My Drive root, which is
//   always permitted.
//
//   listDriveFolders is the in-app folder browser, and it DOES need the
//   `drive.metadata.readonly` sensitive scope (names/ids/parents, never file
//   content). A grant made before that scope was re-added answers 403, which
//   must surface as "reconnect Drive", not a raw HTTP error.

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

/** The JSON body of the single fetch call the helper made. */
function sentBody(): any {
    return JSON.parse(fetchMock.mock.calls[0][1].body);
}

describe('createDriveFolder', () => {
    describe('parent handling — the drive.file trap', () => {
        it('OMITS parents entirely when no parent folder was chosen', async () => {
            fetchMock.mockResolvedValue(okResponse({ id: 'f1', name: 'Backups' }));

            await createDriveFolder(TOKEN, 'Backups');

            const body = sentBody();
            expect(body).not.toHaveProperty('parents');
            expect(body.mimeType).toBe('application/vnd.google-apps.folder');
        });

        it("never sends the literal 'root' as a parent", async () => {
            fetchMock.mockResolvedValue(okResponse({ id: 'f1', name: 'Backups' }));

            await createDriveFolder(TOKEN, 'Backups', null);

            expect(JSON.stringify(sentBody())).not.toContain('root');
        });

        it("drops 'root' even when the browser hands it down as the current folder", async () => {
            // The folder browser's breadcrumb starts at My Drive, whose id IS
            // the string 'root'. Creating while standing there must still omit
            // parents rather than forward it.
            fetchMock.mockResolvedValue(okResponse({ id: 'f1', name: 'Backups' }));

            await createDriveFolder(TOKEN, 'Backups', DRIVE_ROOT_ID);

            expect(sentBody()).not.toHaveProperty('parents');
        });

        it('sends parents when the user picked a folder to nest inside', async () => {
            fetchMock.mockResolvedValue(okResponse({ id: 'f2', name: 'Nested' }));

            await createDriveFolder(TOKEN, 'Nested', 'parent-abc');

            expect(sentBody().parents).toEqual(['parent-abc']);
        });
    });

    describe('request shape', () => {
        it('authorises with the bearer token and posts JSON', async () => {
            fetchMock.mockResolvedValue(okResponse({ id: 'f1', name: 'Backups' }));

            await createDriveFolder(TOKEN, 'Backups');

            const [url, init] = fetchMock.mock.calls[0];
            expect(url).toContain('https://www.googleapis.com/drive/v3/files');
            expect(init.method).toBe('POST');
            expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
            expect(init.headers['Content-Type']).toBe('application/json');
        });

        it('trims the folder name before sending it', async () => {
            fetchMock.mockResolvedValue(okResponse({ id: 'f1', name: 'Backups' }));

            await createDriveFolder(TOKEN, '   Backups   ');

            expect(sentBody().name).toBe('Backups');
        });
    });

    describe('results and failures', () => {
        it('returns the id and name Drive assigned', async () => {
            fetchMock.mockResolvedValue(okResponse({ id: 'abc123', name: 'Cipherline Backups' }));

            await expect(createDriveFolder(TOKEN, 'Cipherline Backups'))
                .resolves.toEqual({ id: 'abc123', name: 'Cipherline Backups' });
        });

        it('falls back to the requested name when Drive omits one', async () => {
            fetchMock.mockResolvedValue(okResponse({ id: 'abc123' }));

            const folder = await createDriveFolder(TOKEN, 'Backups');
            expect(folder.name).toBe('Backups');
        });

        it('rejects an empty name without hitting the network', async () => {
            await expect(createDriveFolder(TOKEN, '   ')).rejects.toThrow(/folder name/i);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('explains a 401 as an expired Drive session', async () => {
            fetchMock.mockResolvedValue(errResponse(401));

            await expect(createDriveFolder(TOKEN, 'Backups')).rejects.toThrow(/expired/i);
        });

        it('surfaces the status for other failures', async () => {
            fetchMock.mockResolvedValue(errResponse(500));

            await expect(createDriveFolder(TOKEN, 'Backups')).rejects.toThrow(/500/);
        });
    });
});

describe('listDriveFolders', () => {
    /** The parsed query string of the nth fetch the helper made. */
    function sentQuery(n = 0): URLSearchParams {
        return new URL(fetchMock.mock.calls[n][0] as string).searchParams;
    }

    describe('request shape', () => {
        beforeEach(() => {
            fetchMock.mockResolvedValue(okResponse({ files: [] }));
        });

        it('asks only for non-trashed folders inside the given parent', async () => {
            await listDriveFolders(TOKEN, 'parent-abc');

            const q = sentQuery().get('q') ?? '';
            expect(q).toContain("'parent-abc' in parents");
            expect(q).toContain("mimeType='application/vnd.google-apps.folder'");
            expect(q).toContain('trashed=false');
        });

        it("browses My Drive through the 'root' alias, which listing may address", async () => {
            await listDriveFolders(TOKEN, DRIVE_ROOT_ID);

            expect(sentQuery().get('q')).toContain("'root' in parents");
        });

        it('requests only metadata fields — never file content', async () => {
            await listDriveFolders(TOKEN, 'parent-abc');

            expect(sentQuery().get('fields')).toBe('nextPageToken,files(id,name)');
            expect(fetchMock.mock.calls[0][0]).not.toContain('alt=media');
        });

        it('authorises with the bearer token and does not write', async () => {
            await listDriveFolders(TOKEN, 'parent-abc');

            const [, init] = fetchMock.mock.calls[0];
            expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
            expect(init.method).toBeUndefined();
        });

        it("escapes a quote in the parent id so the query can't be broken out of", async () => {
            await listDriveFolders(TOKEN, "abc'def");

            expect(sentQuery().get('q')).toContain("'abc\\'def' in parents");
        });
    });

    describe('results', () => {
        it('returns the folders Drive reported', async () => {
            fetchMock.mockResolvedValue(okResponse({ files: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }] }));

            await expect(listDriveFolders(TOKEN, DRIVE_ROOT_ID))
                .resolves.toEqual([{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]);
        });

        it('labels a folder Drive returned without a name', async () => {
            fetchMock.mockResolvedValue(okResponse({ files: [{ id: 'a' }] }));

            const [folder] = await listDriveFolders(TOKEN, DRIVE_ROOT_ID);
            expect(folder.name).toBe('Untitled folder');
        });

        it('is empty, not broken, when Drive returns no files array at all', async () => {
            fetchMock.mockResolvedValue(okResponse({}));

            await expect(listDriveFolders(TOKEN, DRIVE_ROOT_ID)).resolves.toEqual([]);
        });

        it('follows nextPageToken so a folder past the first page is not lost', async () => {
            fetchMock
                .mockResolvedValueOnce(okResponse({ files: [{ id: 'a', name: 'Alpha' }], nextPageToken: 'page-2' }))
                .mockResolvedValueOnce(okResponse({ files: [{ id: 'z', name: 'Zeta' }] }));

            const folders = await listDriveFolders(TOKEN, DRIVE_ROOT_ID);

            expect(folders.map(f => f.id)).toEqual(['a', 'z']);
            expect(sentQuery(1).get('pageToken')).toBe('page-2');
        });

        it('stops paging rather than looping forever on a token that never clears', async () => {
            fetchMock.mockResolvedValue(okResponse({ files: [{ id: 'a', name: 'Alpha' }], nextPageToken: 'same' }));

            await listDriveFolders(TOKEN, DRIVE_ROOT_ID);

            expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(10);
        });
    });

    describe('failures', () => {
        it.each([401, 403])('turns a %i into the "reconnect Drive" signal', async (status) => {
            fetchMock.mockResolvedValue(errResponse(status));

            await expect(listDriveFolders(TOKEN, DRIVE_ROOT_ID)).rejects.toBeInstanceOf(DriveScopeMissingError);
        });

        it('surfaces the status for other failures', async () => {
            fetchMock.mockResolvedValue(errResponse(500));

            await expect(listDriveFolders(TOKEN, DRIVE_ROOT_ID)).rejects.toThrow(/500/);
        });
    });
});

// ── Source guards ─────────────────────────────────────────────────────────────
// The scope and the browse mechanism have flip-flopped four times now (added
// fdc955e9, dropped f86626d9, restored c4aa16e3, dropped again 8db34c2f,
// restored 2026-09-05). These read the source directly, in the spirit of
// backupRegistry.test.ts, so the current decision can't be quietly undone —
// and so anyone who DOES change it has to change a test that says why.

const DESKTOP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Read a source file with comments stripped, so these guards match real code
 * and not the prose explaining the decision (which naturally quotes the very
 * strings being asserted on).
 */
const read = (rel: string) =>
    readFileSync(join(DESKTOP_ROOT, rel), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('Drive OAuth scopes', () => {
    const auth = read('electron/googleDriveAuth.ts');
    const scopeLine = /const SCOPE\s*=\s*'([^']*)'/.exec(auth)?.[1] ?? '';

    it('requests drive.file — the backup read/write itself depends on it', () => {
        expect(scopeLine).toContain('https://www.googleapis.com/auth/drive.file');
    });

    it('requests drive.metadata.readonly — without it the folder browser cannot list', () => {
        // ⚠️ This scope is Google-"sensitive": the app must pass Google OAuth
        // app verification or only registered test users can connect Drive.
        expect(scopeLine).toContain('https://www.googleapis.com/auth/drive.metadata.readonly');
    });

    it.each([
        'drive.readonly',
        'drive.appdata',
        'drive.scripts',
    ])('does NOT request %s', (scope) => {
        expect(scopeLine).not.toContain(scope);
    });

    it('does not request full-Drive access', () => {
        // Guard `auth/drive` on its own, while allowing auth/drive.file and
        // auth/drive.metadata.readonly. Full `drive` is read/write over
        // everything the user owns — never acceptable for a backup folder.
        expect(scopeLine).not.toMatch(/auth\/drive(?![.\w])/);
    });
});

describe('the folder browser is ours, in-app', () => {
    const component = read('src/components/DriveFolderPicker.tsx');

    it('browses through our own Drive helper', () => {
        expect(component).toContain('listDriveFolders');
    });

    it('does not fall back to the Google Picker widget', () => {
        // googlePicker.ts was deleted with this restore; an import of it would
        // not even resolve, but a re-added one should fail loudly here first.
        expect(component).not.toContain('googlePicker');
        expect(component).not.toContain('pickDriveFolder');
    });

    it('keeps the Drive REST calls out of the component', () => {
        expect(component).not.toContain('googleapis.com');
    });
});
