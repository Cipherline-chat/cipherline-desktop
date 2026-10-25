import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Cipherline only holds the Drive `drive.file` scope (plus `email`): it can see
// and modify the files and folders IT created, nothing else. So there is no
// folder browser — backups live in one app-created folder, "Cipherline
// Backups". The folder logic itself (find/create/validate, stale-id recovery)
// runs in the main process and is tested in electron/drive-api.test.ts.

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

    // The invariant is "a token holding the OLD, broader grant keeps working". The
    // granted list is therefore read in exactly one place - once, at connect time,
    // to catch the user pressing Continue with the Drive box UNTICKED - and only
    // to require drive.file to be present (a broader grant contains it). The
    // refresh / access-token path never looks at scopes at all.
    it('reads the granted-scope list only at connect time, and only to require drive.file', () => {
        expect(auth).not.toMatch(/include_granted_scopes/);
        expect(auth.match(/tokenResp\.scope/g)).toHaveLength(1);
        expect(auth).toMatch(/driveAccessWasGranted\(tokenResp\.scope\)/);
        const refreshPath = auth.slice(auth.indexOf('export async function getAccessToken'));
        expect(refreshPath).not.toMatch(/\.scope\b|driveAccessWasGranted/);
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
