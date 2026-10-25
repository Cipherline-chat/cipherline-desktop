import { describe, it, expect } from 'vitest';
import { stripBidiControls, safeDisplayFilename, isExecutableFilename, effectiveExtension } from './fileSafety';
import { parseMentionToken, mentionsToDisplayText } from './mentionTokens';
import { labelSelfConversations } from './selfConversation';

describe('stripBidiControls', () => {
    it('removes overrides, isolates, marks, zero-width and control characters', () => {
        const rlo = '\u202E';
        expect(stripBidiControls(`invoice${rlo}txt.exe`)).toBe('invoicetxt.exe');
        for (const ch of ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069', '\u200E', '\u200F', '\u061C', '\u200B', '\u2060', '\uFEFF', '\u0000', '\n', '\u0085']) {
            expect(stripBidiControls(`a${ch}b`)).toBe('ab');
        }
    });

    it('keeps ordinary text in every script, emoji included', () => {
        // Joiners stay: an emoji ZWJ sequence and Persian ZWNJ need them.
        for (const s of ['report.pdf', 'تقرير.pdf', 'דוח.docx', '報告書.xlsx', 'Café menu 🍰.png', 'a b-c_d (1).txt',
            '👩\u200D👩\u200D👧 family.jpg', 'می\u200Cخواهم.txt']) {
            expect(stripBidiControls(s)).toBe(s);
        }
    });

    it('is total on non-strings', () => {
        expect(stripBidiControls(42)).toBe('');
        expect(safeDisplayFilename(undefined)).toBe('file');
        expect(safeDisplayFilename('\u202E\u202E  ')).toBe('file');
    });
});

describe('isExecutableFilename', () => {
    it.each(['setup.exe', 'a.SCR', 'run.bat', 'x.cmd', 'i.msi', 'l.lnk', 'p.js', 'p.jar', 'p.ps1', 'Mac.app', 'img.dmg', 'go.sh', 'v.vbs', 'c.com',
        'invoice\u202Etxt.exe', 'trailing.exe.', 'trailing.exe  ', 'double.pdf.exe'])('%s is executable', name => {
        expect(isExecutableFilename(name)).toBe(true);
    });
    it.each(['photo.jpg', 'report.pdf', 'notes.txt', 'exe', 'archive.zip', 'data.json', 'file.exe.txt', '', 42])('%s is not', name => {
        expect(isExecutableFilename(name)).toBe(false);
    });
    it('reads the extension the OS would act on', () => {
        expect(effectiveExtension('a\u202Egpj.exe')).toBe('exe');
        expect(effectiveExtension('noext')).toBe('');
    });
});

describe('sender-chosen display names are stripped where they are drawn', () => {
    it('mention labels', () => {
        expect(parseMentionToken('<@u:id1:ali\u202Ececil>')?.label).toBe('alicecil');
        expect(mentionsToDisplayText('hi <@r:r1:Mo\u2066ds> <:pa\u200Ert:e1>')).toBe('hi @Mods :part:');
    });

    it('group titles in the conversation list', () => {
        const rows = [
            { conversation_id: 'g', type: 'group', title: 'Team \u202Eevil' },
            { conversation_id: 'h', type: 'group', title: 'Plain' },
        ];
        const out = labelSelfConversations(rows, 'me');
        expect(out[0].title).toBe('Team evil');
        expect(out[1]).toBe(rows[1]);
    });
});
