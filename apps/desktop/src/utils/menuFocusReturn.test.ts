// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { shouldReturnFocusToRow } from './menuFocusReturn';

afterEach(() => { document.body.innerHTML = ''; });

describe('shouldReturnFocusToRow', () => {
    it('returns focus to the row when focus fell to <body>', () => {
        const row = document.createElement('div'); document.body.appendChild(row);
        expect(shouldReturnFocusToRow(document.body, row)).toBe(true);
        expect(shouldReturnFocusToRow(null, row)).toBe(true);
    });

    it('does NOT steal focus the menu action moved to the composer', () => {
        const row = document.createElement('div');
        const ta = document.createElement('textarea');
        document.body.append(row, ta);
        ta.focus();
        expect(document.activeElement).toBe(ta);
        expect(shouldReturnFocusToRow(document.activeElement, row)).toBe(false);
    });

    it('still returns focus when it is stuck inside the closing menu', () => {
        const row = document.createElement('div');
        const menu = document.createElement('div'); menu.className = 'ctxm';
        const btn = document.createElement('button'); menu.appendChild(btn);
        document.body.append(row, menu);
        btn.focus();
        expect(shouldReturnFocusToRow(document.activeElement, row)).toBe(true);
    });

    it('does nothing without a row', () => {
        expect(shouldReturnFocusToRow(document.body, null)).toBe(false);
    });
});
