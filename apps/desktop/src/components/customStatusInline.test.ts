// @vitest-environment jsdom
/**
 * The custom-status editor now lives inside the status picker popover
 * (CustomStatusDialog is gone). Real CustomStatusInline / StatusPicker, real
 * clicks and keys; only the portaled emoji picker and the animated ClSelect
 * are swapped for plain stand-ins. Covers: save (Enter and the Save button),
 * clear, "Clear after" -> expiry mapping, the personal-emoji payload, validation
 * and Escape (closes the popover and drops the unsaved draft).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
    };
    return { default: api, secureLocalStore: api };
});
vi.mock('../hooks/useUserStatus', () => ({
    STATUS_CONFIG: {
        online: { label: 'Online', color: '#4ADE80' },
        away: { label: 'Away', color: '#FFC94D' },
        dnd: { label: 'Do Not Disturb', color: '#FF6B5E' },
        offline: { label: 'Offline', color: '#5E6B8F' },
    },
}));
vi.mock('./EncryptedAvatar', () => ({ EncryptedAvatar: () => null }));
vi.mock('./StatusIcon', () => ({ StatusDot: () => null, StatusIcon: () => null }));
vi.mock('./StatusLine', () => ({ StatusEmoji: ({ value }: { value: string }) => React.createElement('span', { 'data-testid': 'emoji' }, value) }));
vi.mock('./personalStatusEmoji', () => ({ personalStatusEmoji: () => () => null }));
vi.mock('../utils/personalEmoji/service', () => ({
    personalEmojis: () => ({ store: { meta: () => ({ m: 'image/webp' }) } }),
}));
// Stand-in picker: one unicode pick, one My Emojis pick.
const PERSONAL_ID = `p_${'a'.repeat(32)}`;
vi.mock('./emojiPickerLazy', () => ({
    default: ({ onEmojiSelect }: { onEmojiSelect: (s: { native?: string; id?: string }) => void }) =>
        React.createElement('div', { 'data-testid': 'picker' },
            React.createElement('button', { onClick: () => onEmojiSelect({ native: '🍕' }) }, 'pick-unicode'),
            React.createElement('button', { onClick: () => onEmojiSelect({ id: PERSONAL_ID }) }, 'pick-personal')),
}));
vi.mock('./cl', () => ({
    ClButton: ({ children, onClick, disabled, tooltip }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; tooltip?: string }) =>
        React.createElement('button', { type: 'button', onClick, disabled, 'data-tooltip': tooltip }, children),
    ClInput: React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { error?: boolean }>(
        ({ error: _error, ...rest }, ref) => React.createElement('input', { ref, ...rest })),
    ClSelect: ({ options, value, onChange, ariaLabel }: {
        options: { value: string; label: string }[]; value: string; onChange: (v: string) => void; ariaLabel?: string;
    }) => React.createElement('select', { 'aria-label': ariaLabel, value, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value) },
        options.map(o => React.createElement('option', { key: o.value, value: o.value }, o.label))),
}));
vi.mock('./cl/useClTooltip', () => ({
    useClTooltip: () => ({ anchorProps: { ref: () => {} }, tooltip: null }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { StatusPicker } = await import('./StatusPicker');
type Payload = { text: string; emoji: string; expiresAt: string | null };

const NOW = new Date('2026-10-23T12:00:00');
let root: Root;
let host: HTMLDivElement;
const saved = vi.fn<(p: Payload) => void>();

interface HostProps { text?: string; emoji?: string; expiresAt?: string | null }
const Host: React.FC<HostProps> = ({ text = '', emoji = '', expiresAt = null }) => {
    const [s] = useState<'online'>('online');
    return React.createElement(StatusPicker, {
        myStatus: s, username: 'me', onSetStatus: () => {},
        customText: text, customEmoji: emoji, customExpiresAt: expiresAt,
        onSetCustomStatus: (p: Payload) => saved(p),
    });
};
const mount = (props: HostProps = {}) => {
    act(() => root.render(React.createElement(Host, props)));
};

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    store.clear();
    saved.mockReset();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
});

const trigger = () => host.querySelector('button[title^="Status:"]') as HTMLButtonElement;
const openPopover = () => act(() => trigger().click());
const input = () => host.querySelector('input[aria-label="Status text"]') as HTMLInputElement;
const select = () => host.querySelector('select[aria-label="Clear after"]') as HTMLSelectElement;
const btn = (text: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const popover = () => host.querySelector('[inert], .absolute.left-full') as HTMLElement;
const type = (value: string) => act(() => {
    const el = input();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
});
const choose = (value: string) => act(() => {
    const el = select();
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
});
const key = (k: string, target: EventTarget = input()) => act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
});
const isOpen = () => !popover().hasAttribute('inert');

describe('inline custom status editor', () => {
    it('lives in the popover: no separate dialog row, no modal', () => {
        mount();
        openPopover();
        expect(host.querySelector('[data-testid="set-custom-status"]')).toBeNull();
        expect(host.querySelector('[role="dialog"]')).toBeNull();
        expect(input()).not.toBeNull();
        expect(input().placeholder).toBe("What's happening?");
    });

    it('Enter saves the text (no expiry by default) and closes the popover', () => {
        mount();
        openPopover();
        type('heads down');
        key('Enter');
        expect(saved).toHaveBeenCalledTimes(1);
        expect(saved).toHaveBeenCalledWith({ text: 'heads down', emoji: '', expiresAt: null });
        expect(isOpen()).toBe(false);
    });

    it('the Save button only appears once the draft differs, and saves the same payload', () => {
        mount();
        openPopover();
        expect(btn('Save')).toBeUndefined();
        type('brb');
        act(() => btn('Save')!.click());
        expect(saved).toHaveBeenCalledWith({ text: 'brb', emoji: '', expiresAt: null });
    });

    it('an empty draft on an empty status cannot be saved', () => {
        mount();
        openPopover();
        key('Enter');
        expect(saved).not.toHaveBeenCalled();
    });

    it.each([
        ['never', null],
        ['30m', new Date(NOW.getTime() + 30 * 60_000).toISOString()],
        ['1h', new Date(NOW.getTime() + 60 * 60_000).toISOString()],
        ['4h', new Date(NOW.getTime() + 240 * 60_000).toISOString()],
        ['today', (() => { const d = new Date(NOW); d.setHours(23, 59, 59, 999); return d.toISOString(); })()],
    ])('"Clear after" %s maps to the right expiry', (choice, expiresAt) => {
        mount();
        openPopover();
        type('lunch');
        choose(choice);
        key('Enter');
        expect(saved).toHaveBeenCalledWith({ text: 'lunch', emoji: '', expiresAt });
    });

    it('a unicode emoji pick is saved as-is', () => {
        mount();
        openPopover();
        act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Add a status emoji"]')!.click());
        act(() => btn('pick-unicode')!.click());
        expect(host.querySelector('[data-testid="picker"]')).toBeNull();
        key('Enter');
        expect(saved).toHaveBeenCalledWith({ text: '', emoji: '🍕', expiresAt: null });
    });

    it('a My Emojis pick is saved as its cl:p_ reference (the bytes ride on the PATCH, not here)', () => {
        mount();
        openPopover();
        act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Add a status emoji"]')!.click());
        act(() => btn('pick-personal')!.click());
        type('mine');
        key('Enter');
        expect(saved).toHaveBeenCalledWith({ text: 'mine', emoji: `cl:${PERSONAL_ID}`, expiresAt: null });
    });

    it('shows the current status, and the picker row is not a stale "Set custom status" button', () => {
        mount({ text: 'in a meeting', emoji: '📅' });
        openPopover();
        expect(input().value).toBe('in a meeting');
        expect(host.querySelector('[data-testid="emoji"]')!.textContent).toBe('📅');
    });

    it('editing a status with an expiry keeps it ("Keep") unless changed', () => {
        const at = new Date(NOW.getTime() + 2 * 3600_000).toISOString();
        mount({ text: 'focus', expiresAt: at });
        openPopover();
        expect(select().value).toBe('keep');
        type('focus mode');
        key('Enter');
        expect(saved).toHaveBeenCalledWith({ text: 'focus mode', emoji: '', expiresAt: at });
    });

    it('x clears an existing status at once and leaves the popover open', () => {
        mount({ text: 'away for a bit', emoji: '🌴' });
        openPopover();
        act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Clear status"]')!.click());
        expect(saved).toHaveBeenCalledWith({ text: '', emoji: '', expiresAt: null });
        expect(input().value).toBe('');
        expect(isOpen()).toBe(true);
    });

    it('x on an unsaved draft only clears the draft (nothing to tell the server)', () => {
        mount();
        openPopover();
        type('oops');
        act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Clear status"]')!.click());
        expect(saved).not.toHaveBeenCalled();
        expect(input().value).toBe('');
    });

    it('rejects whitespace-only text with an inline alert and does not save', () => {
        mount();
        openPopover();
        type('   ');
        expect(host.querySelector('[role="alert"]')!.textContent).toBe('A status cannot be only spaces.');
        key('Enter');
        expect(saved).not.toHaveBeenCalled();
    });

    it('Escape closes the popover and drops the unsaved draft', () => {
        mount({ text: 'saved text' });
        openPopover();
        type('half typed');
        expect(isOpen()).toBe(true);
        act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        expect(isOpen()).toBe(false);
        expect(saved).not.toHaveBeenCalled();
        openPopover();
        expect(input().value).toBe('saved text');
    });

    it('while closed the editor is inert, so Tab cannot land in the invisible popover', () => {
        mount();
        expect(popover().hasAttribute('inert')).toBe(true);
        openPopover();
        expect(popover().hasAttribute('inert')).toBe(false);
    });
});
