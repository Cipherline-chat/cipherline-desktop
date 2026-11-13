/**
 * Wiring for the server-dialogs restyle: Create a Server, the Discord template
 * import, Join a Server, the invite preview and Invite People all go through the
 * house dialog pattern (components/dialog/DialogFrame + DialogExtras), and the
 * hand-rolled headers / full-width button rows / ClField forms are gone.
 * Source-level; behaviour is in serverDialogs.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...p: string[]) => readFileSync(join(__dirname, ...p), 'utf8');

const DIALOGS: [name: string, file: string][] = [
    ['CreateServerModal', 'CreateServerModal.tsx'],
    ['DiscordTemplateImport', 'DiscordTemplateImport.tsx'],
    ['JoinServerModal', 'JoinServerModal.tsx'],
    ['ServerInviteModal', 'ServerInviteModal.tsx'],
];

describe.each(DIALOGS)('%s', (_name, file) => {
    const src = read(file);

    it('renders the dialog frame: DialogHeader + DialogFooter', () => {
        expect(src).toContain('<DialogHeader');
        expect(src).toContain('<DialogFooter');
        expect(src).toContain("from '../dialog/DialogFrame'");
    });

    it('has no hand-rolled header (icon tile / Fredoka h2 / header close button) left', () => {
        expect(src).not.toContain('font-display font-semibold');
        expect(src).not.toContain('tooltip="Close"');
        expect(src).not.toContain('cardStyle={{ padding');
        expect(src).not.toMatch(/<ClField\b/);
    });

    it('does not use the kit\'s `loading` (three dots) on a footer button', () => {
        expect(src).not.toMatch(/<ClButton[^>]*\bloading=/);
    });
});

describe('the modals that own a ClModal use a dlg-card', () => {
    it.each([
        ['CreateServerModal.tsx', 1],
        ['JoinServerModal.tsx', 2],   // Join a Server + the invite preview
        ['ServerInviteModal.tsx', 1],
    ])('%s: every <ClModal> carries cardClassName="dlg-card dlg-card--srv"', (file, count) => {
        const src = read(file);
        expect(src.match(/<ClModal\b/g)?.length).toBe(count);
        expect(src.match(/cardClassName="dlg-card dlg-card--srv"/g)?.length).toBe(count);
    });

    it('the import flow renders inside the Create card (it is not a second ClModal)', () => {
        expect(read('DiscordTemplateImport.tsx')).not.toContain('<ClModal');
        expect(read('CreateServerModal.tsx')).toContain('<DiscordTemplateImport');
    });
});

describe('forms: Enter goes through a DialogForm, and the primary is the submit button', () => {
    it.each([
        ['CreateServerModal.tsx', 1],
        ['DiscordTemplateImport.tsx', 2],     // link step + preview step
        ['JoinServerModal.tsx', 2],           // Join a Server + the invite preview
    ])('%s has %i <DialogForm>', (file, count) => {
        expect(read(file).match(/<DialogForm\b/g)?.length).toBe(count);
    });

    it('every guarded handler ignores a second submit while its request is in flight', () => {
        expect(read('CreateServerModal.tsx')).toMatch(/if \(loading \|\| !name\.trim\(\)\) return;/);
        expect(read('JoinServerModal.tsx')).toMatch(/const handleSubmit = async \(\) => \{\s*if \(loading\) return;/);
        expect(read('JoinServerModal.tsx')).toMatch(/if \(!token \|\| !preview \|\| joining\) return;/);
        const imp = read('DiscordTemplateImport.tsx');
        expect(imp).toMatch(/if \(phase === 'loading' \|\| !link\.trim\(\)\) return;/);
        expect(imp).toMatch(/if \(!preview \|\| phase === 'creating'\) return;/);
    });

    it('a busy primary uses BusyLabel (label kept + spinner), not the kit\'s dots', () => {
        // Invite People's own primary (Copy link) no longer has a busy-label state; its busy button is each friend row's Invite.
        for (const f of ['CreateServerModal.tsx', 'DiscordTemplateImport.tsx', 'JoinServerModal.tsx', 'InviteFriendsList.tsx']) {
            expect(read(f)).toContain('<BusyLabel');
        }
    });
});

describe('dialog styles', () => {
    const css = read('..', '..', 'styles', 'dialog-server.css');

    it('every file that uses the server-dialog classes imports their stylesheet', () => {
        for (const f of ['CreateServerModal.tsx', 'DiscordTemplateImport.tsx', 'JoinServerModal.tsx', 'ServerInviteModal.tsx']) {
            expect(read(f)).toContain("import '../../styles/dialog-server.css'");
        }
        expect(read('..', 'dialog', 'BusyLabel.tsx')).toContain("import '../../styles/dialog-server.css'");
    });

    it('defines every class the dialogs rely on', () => {
        for (const cls of ['dlg-card--srv', 'dlg-choice', 'dlg-srv', 'dlg-srv-name', 'dlg-srv-desc', 'dlg-linkbox-url', 'dlg-chips', 'dlg-pair', 'dlg-skel', 'dlg-busy-label', 'dlg-spin']) {
            expect(css, cls).toContain(`.${cls}`);
        }
    });

    it('a long name truncates (one-line subtitle, ellipsised server name) and a long description clamps', () => {
        expect(css).toMatch(/\.dlg-card--srv \.dlg-subtitle\{[^}]*text-overflow:ellipsis/);
        expect(css).toMatch(/\.dlg-srv-name\{[^}]*text-overflow:ellipsis/);
        expect(css).toMatch(/\.dlg-srv-desc\{[^}]*-webkit-line-clamp:3/);
    });

    it('Invite People no longer needs mcard--scroll: the dlg-card caps its height and its body scrolls (header + Copy link stay on screen)', () => {
        expect(read('ServerInviteModal.tsx')).not.toContain('mcard--scroll');
        const frameCss = read('..', '..', 'styles', 'dialog-frame.css');
        expect(frameCss).toMatch(/\.mcard\.dlg-card\{[^}]*max-height:min\(680px, calc\(100vh - 48px\)\)[^}]*overflow:hidden/);
        expect(frameCss).toMatch(/\.dlg-body\{[^}]*overflow-y:auto/);
    });

    it('a disabled secondary in a server dialog is a readable flat pill, not the kit\'s sea-glass', () => {
        expect(css).toMatch(/\.dlg-card--srv \.clb--ghost\.dis \.cap\{[^}]*color:#8E9BBF/);
    });

    it('the spinner and skeleton stop animating under prefers-reduced-motion', () => {
        expect(css).toMatch(/prefers-reduced-motion:reduce\)\{\.dlg-spin\{animation:none\}\}/);
        expect(css).toMatch(/prefers-reduced-motion:reduce\)\{\.dlg-skel\{animation:none\}\}/);
    });
});

describe('call sites are unchanged', () => {
    const dash = read('..', 'Dashboard.tsx');
    it('Dashboard still mounts the same four components with the same props', () => {
        expect(dash).toContain("import { CreateServerModal } from './server/CreateServerModal'");
        expect(dash).toContain("import { JoinServerModal } from './server/JoinServerModal'");
        expect(dash).toContain("import { InvitePreviewModal } from './server/JoinServerModal'");
        expect(dash).toContain("import { ServerInviteModal } from './server/ServerInviteModal'");
        expect(dash).toMatch(/<CreateServerModal\s/);
        expect(dash).toMatch(/<JoinServerModal\s/);
        expect(dash).toMatch(/<InvitePreviewModal\s/);
    });
});
