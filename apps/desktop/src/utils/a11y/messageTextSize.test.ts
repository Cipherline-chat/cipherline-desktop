import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    MESSAGE_TEXT_STEPS, MESSAGE_TEXT_DEFAULT, MESSAGE_TEXT_STORE_KEY, MSG_TEXT_PX_VAR, MSG_TEXT_SCALE_VAR,
    isMessageTextStep, parseMessageTextSize, messageTextVars, applyMessageTextSize,
    messageBodyFontSize, msgTextPx, msgTextEm,
} from './messageTextSize';
import { MESSAGE_BODY_PX } from '../formatting/messageSize';
import { classifyKvKey } from '../../services/backupRegistry';

const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('steps and storage', () => {
    it('default is the existing 15px body size and a step', () => {
        expect(MESSAGE_TEXT_DEFAULT).toBe(15);
        expect(MESSAGE_TEXT_DEFAULT).toBe(MESSAGE_BODY_PX);
        expect([...MESSAGE_TEXT_STEPS]).toEqual([12, 13, 14, 15, 16, 18, 20, 24]);
    });
    it.each([[null, 15], ['', 15], ['18', 18], ['24', 24], ['12', 12], ['17', 15], ['180', 15], ['1e1', 15], ['18px', 15]])(
        'parse %j -> %d', (raw, want) => { expect(parseMessageTextSize(raw as string | null)).toBe(want); });
    it('isMessageTextStep', () => {
        expect(isMessageTextStep(20)).toBe(true);
        expect(isMessageTextStep(19)).toBe(false);
        expect(isMessageTextStep('20')).toBe(false);
    });
    it('the key is classified for backups (included)', () => {
        expect(classifyKvKey(MESSAGE_TEXT_STORE_KEY, 'u1')).toBe('include');
    });
});

describe('CSS var derivation', () => {
    it('default derives exactly 15px / 1 (no change for anyone who never touches it)', () => {
        expect(messageTextVars(15)).toEqual({ [MSG_TEXT_PX_VAR]: '15px', [MSG_TEXT_SCALE_VAR]: '1' });
    });
    it.each([[12, '0.8'], [18, '1.2'], [20, '1.3333'], [24, '1.6']])('%dpx -> scale %s', (px, scale) => {
        expect(messageTextVars(px)).toEqual({ [MSG_TEXT_PX_VAR]: `${px}px`, [MSG_TEXT_SCALE_VAR]: scale });
    });
    it('junk falls back to the default', () => {
        expect(messageTextVars(17)).toEqual(messageTextVars(15));
    });
    it('applyMessageTextSize sets both vars on the element', () => {
        const props = new Map<string, string>();
        const el = { style: { setProperty: (k: string, v: string) => props.set(k, v) } } as unknown as HTMLElement;
        applyMessageTextSize(20, el);
        expect(props.get(MSG_TEXT_PX_VAR)).toBe('20px');
        expect(props.get(MSG_TEXT_SCALE_VAR)).toBe('1.3333');
    });
    it('consumer expressions fall back to today\'s values when the var is unset', () => {
        expect(messageBodyFontSize()).toBe('var(--cl-msg-text-px, 15px)');
        expect(messageBodyFontSize(1.5)).toBe('calc(var(--cl-msg-text-px, 15px) * 1.5)');
        expect(messageBodyFontSize(0.875)).toBe('calc(var(--cl-msg-text-px, 15px) * 0.875)');
        expect(msgTextPx(12)).toBe('calc(12px * var(--cl-msg-text-scale, 1))');
        expect(msgTextEm(3)).toBe('calc(3em * var(--cl-msg-text-scale, 1))');
    });
});

describe('wiring: every message surface reads the vars', () => {
    it('chat row body + jumbo emoji + reply quote (ChatPane)', () => {
        const cp = src('components/ChatPane.tsx');
        expect(cp).toContain('let fontSize = messageBodyFontSize(sizeScaleFor(msgSize));');
        expect(cp).toContain("fontSize = msgTextEm(3)");
        expect(cp).toMatch(/data-testid="reply-quote"[\s\S]{0,200}style=\{\{ fontSize: msgTextPx\(12\) \}\}/);
        expect((cp.match(/cl-sys-text/g) ?? []).length).toBeGreaterThanOrEqual(5);
        // negative control: the old fixed-px body is gone
        expect(cp).not.toContain('scaledPx(MESSAGE_BODY_PX');
    });
    it('composer card preview (WYSIWYG) uses the SAME expression as the row body', () => {
        expect(src('utils/cardStyle/cardStyleReact.ts')).toContain('fontSize: messageBodyFontSize(),');
    });
    it('composer box and code blocks multiply by --cl-msg-text-scale', () => {
        const rc = src('styles/rich-composer.css');
        expect(rc).toContain('font-size:calc(14.5px * var(--cl-msg-text-scale, 1) * var(--cl-msg-scale, 1))');
        expect(rc).toContain('calc(12.5px * var(--cl-msg-text-scale, 1) * var(--cl-msg-scale, 1))');
        const fm = src('styles/formatting.css');
        expect(fm).toContain('calc(12.5px * var(--cl-msg-text-scale, 1) * var(--cl-msg-scale, 1))');
        expect(fm).toContain('.cl-sys-text{font-size:calc(11px * var(--cl-msg-text-scale, 1))}');
        expect(fm).not.toMatch(/calc\(12\.5px \* var\(--cl-msg-scale, 1\)\)/);
    });
    it('the runtime applier is mounted in App', () => {
        expect(src('App.tsx')).toContain('<A11yRuntime />');
    });
});
