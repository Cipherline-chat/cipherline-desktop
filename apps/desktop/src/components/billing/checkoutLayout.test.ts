// @vitest-environment jsdom
/**
 * The in-app checkout's LAYOUT contract.
 *
 * The owner's report: in a ~1080x935 window the checkout was a 440px column with
 * no scrolling, clipped top and bottom, and it offered a "Bank" tab the server
 * refuses on desktop. jsdom has no layout engine, so this pins the two halves
 * separately:
 *
 *   - the DOM STRUCTURE (summary | scrolling form + sticky footer, one vs two
 *     columns, dialog semantics, Esc) by rendering the real InAppCheckout, and
 *   - the CSS that turns that structure into "nothing is ever clipped" by
 *     reading the stylesheet's rules.
 *
 * The pixel-level proof (1280x800, 1080x935, 900x560, Link's box expanded) is
 * harness/checkout-layout-shots.mjs, which renders the same real component and
 * the same stylesheet in headless Chromium.
 *
 * Stripe and axios are mocked: nothing here reaches Stripe (live keys).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ── mocks ─────────────────────────────────────────────────────────────── */

const stripeFake = { createConfirmationToken: vi.fn(), confirmPayment: vi.fn() };
const elementsFake = { submit: vi.fn() };
let elementsOptions: Record<string, unknown> | null = null;
let paymentElementProps: Record<string, unknown> | null = null;
const elementFocus = vi.fn();

vi.mock('@stripe/stripe-js/pure', () => ({ loadStripe: vi.fn(async () => ({})) }));
vi.mock('@stripe/react-stripe-js', () => ({
    Elements: (p: { options: Record<string, unknown>; children: React.ReactNode }) => {
        elementsOptions = p.options;
        return React.createElement('div', { 'data-testid': 'elements' }, p.children);
    },
    PaymentElement: (p: Record<string, unknown> & { onReady?: (el: unknown) => void; onChange?: (e: { complete: boolean }) => void }) => {
        paymentElementProps = p;
        React.useEffect(() => { p.onReady?.({ focus: elementFocus }); p.onChange?.({ complete: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
        return React.createElement('div', { 'data-testid': 'payment-element' });
    },
    useStripe: () => stripeFake,
    useElements: () => elementsFake,
}));
vi.mock('framer-motion', () => {
    const el = (tag: string) => ({ children, ...rest }: Record<string, unknown>) => {
        const clean: Record<string, unknown> = {};
        for (const k of ['className', 'style', 'role', 'data-testid', 'aria-hidden']) if (k in rest) clean[k] = rest[k];
        return React.createElement(tag, clean, children as React.ReactNode);
    };
    return {
        motion: { div: el('div'), p: el('p') },
        AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
        useReducedMotion: () => true,
    };
});
vi.mock('../mascot/Keys', () => ({ Keys: () => null }));
vi.mock('../ClButton', () => ({
    ClButton: (p: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; loading?: boolean }) =>
        React.createElement('button', { onClick: p.onClick, disabled: p.disabled || p.loading }, p.children),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ token: 'jwt' }) }));
vi.mock('../../constants', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../constants')>()),
    API_BASE: 'http://api/v1',
}));

type Handler = (url: string) => unknown;
const routes: { get: Handler; post: Handler } = { get: () => ({ data: {} }), post: () => ({ data: {} }) };
vi.mock('axios', () => {
    const get = vi.fn(async (url: string) => routes.get(url));
    const post = vi.fn(async (url: string) => routes.post(url));
    return { default: { get, post, isAxiosError: () => false } };
});

import { InAppCheckout } from './InAppCheckout';
import { desktopPaymentMethodTypes, DESKTOP_PAYMENT_ELEMENT_OPTIONS } from './checkoutPaymentMethods';
import { CHECKOUT_WIDE_MIN_PX, CHECKOUT_WIDE_QUERY } from './useCheckoutLayout';
import { __resetEscapeStackForTests } from '../../utils/escapeStack';

/* ── harness ───────────────────────────────────────────────────────────── */

let root: Root | null = null;
let host: HTMLElement;
const flush = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };
const $ = (sel: string) => document.body.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => Array.from(document.body.querySelectorAll<HTMLElement>(sel));
const button = (label: RegExp) => $$('button').find((b) => label.test((b.textContent ?? '').trim()));
const click = async (label: RegExp) => {
    const b = button(label);
    if (!b) throw new Error(`no button matching ${label}`);
    await act(async () => { b.click(); });
    await flush();
};
const pressEscape = async () => {
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
};

/** A controllable window.matchMedia: `width` decides CHECKOUT_WIDE_QUERY. */
function installMatchMedia(initialWidth: number) {
    let width = initialWidth;
    const listeners = new Set<() => void>();
    const matches = () => width >= CHECKOUT_WIDE_MIN_PX;
    window.matchMedia = ((q: string) => {
        expect(q).toBe(CHECKOUT_WIDE_QUERY);
        return {
            get matches() { return matches(); },
            media: q,
            addEventListener: (_: string, l: () => void) => { listeners.add(l); },
            removeEventListener: (_: string, l: () => void) => { listeners.delete(l); },
        } as unknown as MediaQueryList;
    }) as typeof window.matchMedia;
    return { resize: (w: number) => { width = w; listeners.forEach((l) => l()); } };
}

const CONFIG = { publishable_key: 'pk_test_x', amount: 250, currency: 'usd', automatic_tax: true, payment_method_types: ['card', 'link'] };
const quote = (over: Record<string, unknown> = {}) => ({
    client_secret: 'pi_secret_1', subscription_id: 'sub_1',
    amount_subtotal: 250, amount_tax: 18, amount_total: 268, currency: 'usd', ...over,
});
const onSuccess = vi.fn();
const onClose = vi.fn();
const mount = async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(React.createElement(InAppCheckout, { context: 'upgrade', onSuccess, onClose })); });
    await flush();
};

beforeEach(() => {
    elementsOptions = null; paymentElementProps = null;
    onSuccess.mockReset(); onClose.mockReset(); elementFocus.mockReset();
    __resetEscapeStackForTests();
    stripeFake.createConfirmationToken.mockReset().mockResolvedValue({ confirmationToken: { id: 'ctoken_1' } });
    stripeFake.confirmPayment.mockReset().mockResolvedValue({ paymentIntent: { status: 'succeeded' } });
    elementsFake.submit.mockReset().mockResolvedValue({});
    routes.get = (url) => (url.endsWith('/billing/checkout-config') ? { data: CONFIG } : { data: { subscription_status: 'active' } });
    routes.post = (url) => (url.endsWith('/billing/subscribe') ? { data: quote() } : { data: { subscription_status: 'active' } });
    (window as unknown as { electronAPI?: unknown }).electronAPI = { openExternal: vi.fn(async () => undefined) };
    installMatchMedia(1080);
});
afterEach(() => {
    act(() => { root?.unmount(); }); root = null; host?.remove();
    __resetEscapeStackForTests();
    delete (window as unknown as { matchMedia?: unknown }).matchMedia;
});

/* ── 1. structure: two columns wide, one column narrow ─────────────────── */

describe('checkout layout: wide window = summary | payment', () => {
    it('renders the summary column beside the payment panel', async () => {
        await mount();
        const layout = $('[data-testid="checkout-layout"]')!;
        expect(layout.dataset.layout).toBe('wide');
        expect(Array.from(layout.children).map((c) => c.tagName + '.' + c.className)).toEqual(['ASIDE.ckt-summary', 'SECTION.ckt-pay']);
    });

    it('the summary carries the Pro title, the price, the real entitlements, the reassurance and the unlock line', async () => {
        await mount();
        const summary = $('[data-testid="checkout-summary"]')!;
        expect(summary.textContent).toContain('Cipherline Pro');
        expect($('[data-testid="checkout-price"]')!.textContent).toBe('$2.50/mo + tax');
        const features = $('[data-testid="checkout-features"]')!.textContent!;
        // the same entitlements UpgradePromptModal / ProWelcome / getEntitlements name
        expect(features).toMatch(/video/i);
        expect(features).toMatch(/screen sharing/i);
        expect(features).toContain('2 GB');
        expect(features).toContain('100 MB');
        expect(features).toMatch(/saved storage/i);
        expect($('[data-testid="checkout-reassure"]')!.textContent).toMatch(/Cancel anytime/);
        // exactly once, as a fixed line (it is no longer a rotating bubble)
        expect(document.body.textContent!.split('Everything unlocks the moment this goes through.').length - 1).toBe(1);
        expect(summary.contains($('[data-testid="checkout-unlock"]'))).toBe(true);
    });

    it('the Payment Element is inside the SCROLL container, the Pay button and fine print in the sticky FOOTER beside it', async () => {
        await mount();
        const scroll = $('[data-testid="checkout-scroll"]')!;
        const footer = $('[data-testid="checkout-footer"]')!;
        expect(scroll.contains($('[data-testid="payment-element"]'))).toBe(true);
        expect(footer.contains($('[data-testid="payment-element"]'))).toBe(false);
        // sibling, AFTER the scroller: a footer inside it would scroll away with the form
        expect(scroll.parentElement).toBe(footer.parentElement);
        expect(scroll.nextElementSibling).toBe(footer);
        const pay = button(/^Pay /)!;
        expect(footer.contains(pay)).toBe(true);
        expect(scroll.contains(pay)).toBe(false);
        expect(footer.textContent).toContain('Recurring subscription');
        // Terms §7.7: the immediate-performance acknowledgment stays adjacent to Pay
        expect(footer.textContent).toContain('ask for access to begin immediately');
        expect(footer.textContent).toContain('Secured by Stripe');
    });

    it('the form column is width-capped (.ckt-form) so inputs never stretch', async () => {
        await mount();
        expect($$('.ckt-form').length).toBe(2); // one in the scroller, one in the footer
    });
});

describe('checkout layout: narrow window = one column, compact summary on top', () => {
    beforeEach(() => { installMatchMedia(700); });

    it('goes one column and drops the long feature list but keeps price + unlock line + the sticky footer', async () => {
        await mount();
        const layout = $('[data-testid="checkout-layout"]')!;
        expect(layout.dataset.layout).toBe('narrow');
        // summary is still the first child (on top), the payment panel follows
        expect(layout.firstElementChild!.className).toBe('ckt-summary');
        expect($('[data-testid="checkout-features"]')).toBeNull();
        expect($('[data-testid="checkout-reassure"]')).toBeNull();
        expect($('[data-testid="checkout-price"]')!.textContent).toBe('$2.50/mo + tax');
        expect($('[data-testid="checkout-unlock"]')).not.toBeNull();
        expect($('[data-testid="checkout-footer"]')!.contains(button(/^Pay /)!)).toBe(true);
    });

    it('re-flows live when the window is resized across the breakpoint', async () => {
        const mm = installMatchMedia(700);
        await mount();
        expect($('[data-testid="checkout-layout"]')!.dataset.layout).toBe('narrow');
        await act(async () => { mm.resize(1200); });
        expect($('[data-testid="checkout-layout"]')!.dataset.layout).toBe('wide');
        expect($('[data-testid="checkout-features"]')).not.toBeNull();
        await act(async () => { mm.resize(600); });
        expect($('[data-testid="checkout-layout"]')!.dataset.layout).toBe('narrow');
        // the same form instance survived both re-flows (nothing re-mounted/lost)
        expect($('[data-testid="payment-element"]')).not.toBeNull();
    });
});

describe('checkout layout: the tax-confirm step stays in the pinned footer', () => {
    it('shows the exact total + Confirm in the footer, and the exact total in the summary', async () => {
        await mount();
        await click(/^Pay /);
        const footer = $('[data-testid="checkout-footer"]')!;
        expect(footer.contains($('[data-testid="tax-confirm"]'))).toBe(true);
        expect(footer.contains(button(/Confirm \$2\.68\/mo/)!)).toBe(true);
        expect($('[data-testid="checkout-price"]')!.textContent).toBe('$2.68/mo');
        // the payment panel is still mounted (Back restores exactly what was typed)
        expect($('[data-testid="checkout-scroll"]')!.contains($('[data-testid="payment-element"]'))).toBe(true);
        expect(stripeFake.confirmPayment).not.toHaveBeenCalled();
    });
});

/* ── 2. the CSS that makes "nothing is ever clipped" true ─────────────── */

const CSS = readFileSync(resolve(__dirname, '..', '..', 'styles', 'checkout.css'), 'utf8');
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
/** Declarations of every rule whose selector list contains exactly `selector`, merged in source order. */
function decls(css: string, selector: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of strip(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const sels = m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' '));
        if (!sels.includes(selector)) continue;
        for (const d of m[2].split(';')) {
            const i = d.indexOf(':');
            if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
        }
    }
    return out;
}
const WIDE = ".ckt[data-layout='wide']";

describe('decls() helper (positive + negative control)', () => {
    it('reads a rule, merges repeats, ignores comments', () => {
        const css = '/* .a { x: 1 } */ .a { color: red; } .b, .a { overflow-y: auto; }';
        expect(decls(css, '.a')).toEqual({ color: 'red', 'overflow-y': 'auto' });
        expect(decls(css, '.zzz')).toEqual({});
    });
});

describe('checkout.css: the modal fits the viewport and exactly one region scrolls', () => {
    it('the card is capped to the dynamic viewport and clips nothing it owns', () => {
        const card = decls(CSS, '.mcard.ckt-card');
        expect(card['max-height']).toMatch(/calc\(100dvh - \d+px\)/);
        expect(card.display).toBe('flex');
        expect(card['flex-direction']).toBe('column');
        expect(card.overflow).toBe('hidden'); // children own their scrolling
        expect(card.padding).toBe('0');
    });

    it('also carries the vh fallback (engines that drop the dvh declaration)', () => {
        expect(strip(CSS)).toMatch(/max-height:\s*calc\(100vh - \d+px\);\s*max-height:\s*calc\(100dvh - \d+px\)/);
    });

    it('narrow: .ckt is the one scroller (overflow-y:auto, min-height:0, contained overscroll)', () => {
        const d = decls(CSS, '.ckt');
        expect(d['overflow-y']).toBe('auto');
        expect(d['min-height']).toBe('0');
        expect(d['overscroll-behavior']).toBe('contain');
    });

    it('narrow: the footer is sticky at the bottom of that scroller', () => {
        const d = decls(CSS, '.ckt-footer');
        expect(d.position).toBe('sticky');
        expect(d.bottom).toBe('0');
        expect(d.background).toBeTruthy(); // opaque: content must not show through it
    });

    it('narrow: the payment panel dissolves so the footer can stick to .ckt', () => {
        expect(decls(CSS, '.ckt-pay').display).toBe('contents');
    });

    it('wide: two columns, the grid row is bounded (minmax(0,1fr)) so children may shrink and scroll', () => {
        const d = decls(CSS, WIDE);
        expect(d.display).toBe('grid');
        expect(d['grid-template-columns']).toMatch(/^minmax\(\d+px, \d+px\) minmax\(0, 1fr\)$/);
        expect(d['grid-template-rows']).toBe('minmax(0, 1fr)');
        expect(d.overflow).toBe('hidden');
    });

    it('wide: ONLY the form body scrolls (overflow-y:auto; min-height:0; overscroll contain)', () => {
        const d = decls(CSS, `${WIDE} .ckt-scroll`);
        expect(d['overflow-y']).toBe('auto');
        expect(d['min-height']).toBe('0');
        expect(d['overscroll-behavior']).toBe('contain');
        expect(d.flex).toBe('1 1 auto');
    });

    it('wide: the footer is a fixed row under the scroller (never scrolls away, never shrinks)', () => {
        const d = decls(CSS, `${WIDE} .ckt-footer`);
        expect(d.position).toBe('static');
        expect(d.flex).toBe('none');
        expect(decls(CSS, `${WIDE} .ckt-pay`)).toMatchObject({ display: 'flex', 'flex-direction': 'column', 'min-height': '0' });
    });

    it('wide: the summary column scrolls on its own if the window is very short', () => {
        expect(decls(CSS, `${WIDE} .ckt-summary`)['overflow-y']).toBe('auto');
    });

    it('the form is capped at 440px and centred inside its column', () => {
        const d = decls(CSS, '.ckt-form');
        expect(d['max-width']).toBe('440px');
        expect(d['margin-inline']).toBe('auto');
    });

    it('beats the kit: card rules are two-class, and <p> rules are .ckt-prefixed (the kit has `.mcard p`)', () => {
        expect(strip(CSS)).toContain('.mcard.ckt-card');
        expect(strip(CSS)).toMatch(/\.ckt \.ckt-fine\s*\{/);
        expect(strip(CSS)).toMatch(/\.ckt \.ckt-unlock\s*\{/);
    });

    it('the stylesheet is actually imported by the layout component', () => {
        const tsx = readFileSync(resolve(__dirname, 'CheckoutLayout.tsx'), 'utf8');
        expect(tsx).toContain("import '../../styles/checkout.css'");
    });
});

/* ── 3. card + Link only (the "Bank" bug) ─────────────────────────────── */

describe('desktop offers card + Link only', () => {
    it.each([
        ['null', null], ['undefined', undefined], ['empty', []],
        ['bank only', ['us_bank_account']], ['unknown only', ['klarna', 'amazon_pay']],
    ])('desktopPaymentMethodTypes(%s) → card + link', (_l, input) => {
        expect(desktopPaymentMethodTypes(input as string[] | null | undefined)).toEqual(['card', 'link']);
    });
    it('drops anything outside the desktop set and de-duplicates', () => {
        expect(desktopPaymentMethodTypes(['card', 'us_bank_account', 'link', 'card', 'sepa_debit'])).toEqual(['card', 'link']);
    });
    it('lets the server NARROW but never widen', () => {
        expect(desktopPaymentMethodTypes(['card'])).toEqual(['card']);
        expect(desktopPaymentMethodTypes(['link'])).toEqual(['link']);
    });
    it('Elements are mounted with explicit paymentMethodTypes: ["card","link"] even when the server omits them', async () => {
        routes.get = () => ({ data: { ...CONFIG, payment_method_types: null } });
        await mount();
        expect(elementsOptions).toHaveProperty('paymentMethodTypes', ['card', 'link']);
        expect(elementsOptions!.paymentMethodTypes).not.toContain('us_bank_account');
    });
    it('the Payment Element pins Apple Pay / Google Pay off (no browser payment sheet in Electron)', async () => {
        await mount();
        expect(paymentElementProps!.options).toBe(DESKTOP_PAYMENT_ELEMENT_OPTIONS);
        expect(DESKTOP_PAYMENT_ELEMENT_OPTIONS).toMatchObject({ layout: 'tabs', wallets: { applePay: 'never', googlePay: 'never' } });
    });
});

/* ── 4. accessibility: dialog, focus, Escape ──────────────────────────── */

describe('checkout accessibility', () => {
    it('is a labelled modal dialog', async () => {
        await mount();
        const dlg = $('[role="dialog"]')!;
        expect(dlg.getAttribute('aria-modal')).toBe('true');
        expect(dlg.getAttribute('aria-label')).toBe('Upgrade to Cipherline Pro');
        expect(dlg.classList.contains('ckt-card')).toBe(true);
    });

    it('Close is the first focusable (conventional order) and has an accessible name', async () => {
        await mount();
        const first = $('[role="dialog"]')!.querySelector<HTMLElement>('button, [href], input, [tabindex]');
        expect(first!.getAttribute('aria-label')).toBe('Close');
        expect(first!.className).toContain('ckt-close');
    });

    it('focuses the Payment Element when Stripe reports ready and focus is still on nothing useful', async () => {
        await mount();
        expect(elementFocus).toHaveBeenCalledTimes(1);
    });

    it('does NOT steal focus if the customer already focused something real', async () => {
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();
        await mount();
        expect(elementFocus).not.toHaveBeenCalled();
        input.remove();
    });

    it('Esc closes the checkout through the shared escape stack (useEscape)', async () => {
        await mount();
        await pressEscape();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("Stripe's own Escape event (the iframe swallows keydown) closes it too", async () => {
        await mount();
        await act(async () => { (paymentElementProps!.onEscape as () => void)(); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('a stray Esc cannot abandon a charge that is already in flight', async () => {
        let release!: (v: unknown) => void;
        stripeFake.confirmPayment.mockReturnValue(new Promise((r) => { release = r; }));
        routes.post = (url) => (url.endsWith('/billing/subscribe') ? { data: quote({ amount_tax: 0, amount_total: 250 }) } : { data: { subscription_status: 'active' } });
        await mount();
        await click(/^Pay /);
        expect(stripeFake.confirmPayment).toHaveBeenCalledTimes(1);
        await pressEscape();
        await act(async () => { (paymentElementProps!.onEscape as () => void)(); });
        expect(onClose).not.toHaveBeenCalled();
        // …but the explicit Close button is never disabled (a hung 3-D Secure frame must not trap anyone)
        await act(async () => { $('.ckt-close')!.click(); });
        expect(onClose).toHaveBeenCalledTimes(1);
        await act(async () => { release({ paymentIntent: { status: 'succeeded' } }); });
        await flush();
    });

    it('the overlay does not close on a stray click (a half-typed card must not vanish)', async () => {
        await mount();
        await act(async () => { $('.mod')!.click(); });
        expect(onClose).not.toHaveBeenCalled();
    });

    it('the error is announced once: role=alert in the footer, the speech bubble is hidden from AT', async () => {
        stripeFake.createConfirmationToken.mockResolvedValue({ error: { message: 'Your card number is incomplete.' } });
        await mount();
        await click(/^Pay /);
        const alert = $('[data-testid="checkout-footer"] [role="alert"]');
        expect(alert?.textContent).toContain('incomplete');
        expect($('.ckt-bubble')!.getAttribute('aria-hidden')).toBe('true');
        expect($('.ckt-bubble')!.getAttribute('role')).toBeNull();
    });
});
