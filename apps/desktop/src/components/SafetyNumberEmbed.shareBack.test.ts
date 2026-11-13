// @vitest-environment jsdom
/**
 * "Share mine back" on a received safety-code card. The claims that matter:
 * it only ever sends on a click, it never marks anyone verified, and it is not
 * offered where it does not belong.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
    dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const b64 = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
const ME = 'me-id';
const ALICE = 'alice-id';
const ALICE_KEYS = [{ device_id: 'a1', identity_key_pub_b64: b64(1) }];

let directory = ALICE_KEYS;
vi.mock('axios', () => ({ default: { get: vi.fn(async () => ({ data: directory })) } }));

const markVerified = vi.fn();
vi.mock('../utils/keyVerification', () => ({
    markVerified: (...a: unknown[]) => markVerified(...a),
    getKnownDevices: () => ({}),
}));

const LABEL = 'Share mine back';
let SafetyNumberEmbed: React.FC<Record<string, unknown>>;
let code: string;
let computeContactCode: typeof import('../utils/verificationCode').computeContactCode;
let root: Root | null = null;
let host: HTMLDivElement;

beforeAll(async () => {
    ({ SafetyNumberEmbed } = await import('./SafetyNumberEmbed') as unknown as { SafetyNumberEmbed: React.FC<Record<string, unknown>> });
    ({ computeContactCode } = await import('../utils/verificationCode'));
    code = await computeContactCode(ALICE, [b64(1)]);
}, 60000);

beforeEach(() => {
    markVerified.mockClear();
    directory = ALICE_KEYS;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host.remove();
});

function render(props: Record<string, unknown> = {}) {
    act(() => {
        root!.render(React.createElement(SafetyNumberEmbed, {
            code, claimedUserId: ALICE, deviceCount: 1, senderUserId: ALICE,
            myUserId: ME, senderName: 'Alice', token: 't',
            ...props,
        }));
    });
}
async function settle() {
    for (let i = 0; i < 40; i++) await act(async () => { await new Promise(r => setTimeout(r, 5)); });
}
const button = (label: string) => Array.from(host.querySelectorAll('button')).find(b => (b.textContent ?? '').includes(label));
const click = (label: string) => {
    const b = button(label);
    if (!b) throw new Error(`no button "${label}"`);
    act(() => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};
const text = () => host.textContent ?? '';

describe('sends only on an explicit click', () => {
    it('rendering and settling send nothing, in any state a card can mount in', async () => {
        const send = vi.fn(async () => 'sent' as const);
        render({ onShareBack: send });
        await settle();
        render({ onShareBack: send, alreadySharedBack: true });
        await settle();
        render({ onShareBack: send, alreadySharedBack: false });
        await settle();
        expect(send).not.toHaveBeenCalled();
    });

    it('one click sends once, and a second click while busy does not send again', async () => {
        let finish: (v: 'sent') => void = () => {};
        const send = vi.fn(() => new Promise<'sent'>(r => { finish = r; }));
        render({ onShareBack: send });
        await settle();
        click(LABEL);
        expect(send).toHaveBeenCalledTimes(1);
        const busy = host.querySelector('.cl-sn-share button') as HTMLButtonElement;
        expect(busy.disabled).toBe(true);
        act(() => { busy.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        expect(send).toHaveBeenCalledTimes(1);
        await act(async () => { finish('sent'); });
    });

    it('the only caller of onShareBack is the click handler (source)', () => {
        const src = readFileSync(join(__dirname, 'SafetyNumberEmbed.tsx'), 'utf8');
        expect(src.match(/onShareBack\(\)/g)).toHaveLength(1);
        expect(src.match(/handleShareBack/g)).toHaveLength(2); // its definition and onClick={...}
        expect(src).toContain('onClick={handleShareBack}');
    });
});

describe('the states of the button', () => {
    it('sent: the button goes, a quiet line replaces it', async () => {
        render({ onShareBack: async () => 'sent' });
        await settle();
        expect(button(LABEL)).toBeTruthy();
        click(LABEL);
        await settle();
        expect(button(LABEL)).toBeUndefined();
        expect(host.querySelector('.cl-sn-shared')?.textContent).toContain('You shared yours, so Alice can check it too');
        // A plain line, not a result row: it must not read as a verdict on the keys.
        expect(host.querySelector('.cl-sn-shared')?.closest('.cl-sn-result')).toBeNull();
    });

    it('a reopen with the share already in the conversation mounts directly in the quiet state', async () => {
        const send = vi.fn(async () => 'sent' as const);
        render({ onShareBack: send, alreadySharedBack: true });
        await settle();
        expect(button(LABEL)).toBeUndefined();
        expect(host.querySelector('.cl-sn-shared')).not.toBeNull();
        expect(text()).not.toContain('then share yours');
    });

    it('failed: says so and the same button retries', async () => {
        const send = vi.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce('sent');
        render({ onShareBack: send });
        await settle();
        click(LABEL);
        await settle();
        expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not send');
        expect(host.querySelector('.cl-sn-shared')).toBeNull();
        click(LABEL);
        await settle();
        expect(send).toHaveBeenCalledTimes(2);
        expect(host.querySelector('[role="alert"]')).toBeNull();
        expect(host.querySelector('.cl-sn-shared')).not.toBeNull();
    });

    it('withheld for review: never claims it was shared, and offers the button again', async () => {
        render({ onShareBack: async () => 'needs_review' });
        await settle();
        click(LABEL);
        await settle();
        expect(host.querySelector('.cl-sn-shared')).toBeNull();
        expect(host.querySelector('[role="alert"]')).toBeNull();
        expect(button(LABEL)).toBeTruthy();
    });

    it('keyboard focus lands on the quiet line when the focused button is replaced', async () => {
        render({ onShareBack: async () => 'sent' });
        await settle();
        act(() => { button(LABEL)!.focus(); });
        click(LABEL);
        await settle();
        expect(document.activeElement).toBe(host.querySelector('.cl-sn-shared'));
    });

    it('a mouse click from elsewhere does not pull focus onto the card', async () => {
        const outside = document.createElement('input');
        document.body.appendChild(outside);
        outside.focus();
        render({ onShareBack: async () => 'sent' });
        await settle();
        click(LABEL);
        await settle();
        expect(document.activeElement).toBe(outside);
        outside.remove();
    });
});

describe('where it is offered', () => {
    const offered = () => !!button(LABEL);

    it('control: a received card with a send path offers it, and invites comparing', async () => {
        render({ onShareBack: async () => 'sent' });
        await settle();
        expect(offered()).toBe(true);
        expect(text()).toContain('Compare safety codes');
        expect(text()).toContain('shared their safety code so you can compare');
        expect(text()).toContain('then share yours');
    });

    it('not on your own sent card', async () => {
        render({ onShareBack: async () => 'sent', senderUserId: ME, claimedUserId: ME, senderName: 'You' });
        await settle();
        expect(offered()).toBe(false);
        expect(host.querySelector('.cl-sn-share')).toBeNull();
        expect(text()).toContain('You shared your safety code');
    });

    it('not outside a 1:1 DM (no send path passed)', async () => {
        render({});
        await settle();
        expect(offered()).toBe(false);
        expect(text()).not.toContain('then share yours');
    });

    it('not when the envelope names no sender: it could be your own card', async () => {
        render({ onShareBack: async () => 'sent', senderUserId: null });
        await settle();
        expect(offered()).toBe(false);
    });

    it('not on a card with an unusable code', async () => {
        render({ onShareBack: async () => 'sent', code: 42 });
        await settle();
        expect(offered()).toBe(false);
    });

    it('not beside a key-change warning', async () => {
        render({ onShareBack: async () => 'sent', contactVerdict: 'key_changed' });
        await settle();
        expect(offered()).toBe(false);
    });

    it('stays after a match, and goes on a mismatch', async () => {
        render({ onShareBack: async () => 'sent' });
        await settle();
        click('Check this code');
        await settle();
        expect(text()).toContain('This code matches');
        expect(offered()).toBe(true);

        act(() => { root?.unmount(); });
        root = createRoot(host);
        directory = [{ device_id: 'a1', identity_key_pub_b64: b64(9) }];
        render({ onShareBack: async () => 'sent' });
        await settle();
        click('Check this code');
        await settle();
        expect(text()).toContain('does not match');
        expect(offered()).toBe(false);
    });
});

describe('what it does not do', () => {
    it('sending never marks anyone verified, before or after a matching check', async () => {
        render({ onShareBack: async () => 'sent' });
        await settle();
        click('Check this code');
        await settle();
        click(LABEL);
        await settle();
        expect(host.querySelector('.cl-sn-shared')).not.toBeNull();
        expect(markVerified).not.toHaveBeenCalled();
        expect(text()).not.toContain('Marked verified');
        // The real step is still there, untouched by having shared.
        expect(button('I compared this elsewhere')).toBeTruthy();
    });

    it('never logs the code', async () => {
        const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m));
        const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('sent');
        render({ onShareBack: send });
        await settle();
        click(LABEL);
        await settle();
        click(LABEL);
        await settle();
        for (const spy of spies) {
            expect(JSON.stringify(spy.mock.calls)).not.toContain(code);
            spy.mockRestore();
        }
    });
});

describe('ChatPane wiring', () => {
    const src = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');

    it('shares through the same send function as the modal', () => {
        expect(src).toContain('send: handleSendSafetyNumber');
        expect(src).toContain("onSendCode={activeChat.type === 'dm' ? handleSendSafetyNumber : undefined}");
        expect(src).toContain("onShareBack={activeChat.type === 'dm' ? shareSafetyCodeBack : undefined}");
    });

    it('a settled card re-renders: its flag is in the memoised row deps', () => {
        const deps = src.slice(src.indexOf('const rowDeps = ['), src.indexOf('<MemoRow key={rowKey}'));
        expect(deps).toContain('settledSafetyCards.has(msg.id)');
    });
});
