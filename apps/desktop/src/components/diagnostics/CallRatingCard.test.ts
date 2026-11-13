import { describe, it, expect, vi } from 'vitest';

// The live wrapper's providers/collectors are irrelevant to the view; keep the import graph light.
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({}) }));
vi.mock('../../contexts/SubscriptionContext', () => ({ useSubscription: () => ({}) }));
vi.mock('../../contexts/NotificationContext', () => ({ useNotificationPrefsSafe: () => null }));
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ push() {} }) }));
vi.mock('../../utils/diagnostics/collect', () => ({ prepareReportInputs: async () => ({}), buildFromPrepared: () => ({}) }));
vi.mock('../../utils/diagnostics/send', () => ({ sendDiagnosticReport: async () => ({ ok: true }) }));
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The design-system primitives read window.matchMedia at import time; this suite runs in node.
(globalThis as { window?: unknown }).window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
const { CallRatingCardView } = await import('./CallRatingCard');

const html = (props: Partial<Record<string, unknown>> = {}) =>
    renderToStaticMarkup(createElement(CallRatingCardView as never, { onSubmit: () => {}, onDismiss: () => {}, ...props }));

describe('CallRatingCardView copy and steps', () => {
    it('no longer reads as a beta pop-up', () => {
        const h = html();
        expect(h).toContain('How was that call?');
        expect(h).not.toMatch(/beta/i);
    });
    it('the low-rating offer says what it contains and offers Send / Not now', () => {
        const h = html({ initialStep: 'offer', initialRating: 2, onSendReports: async () => ({ sent: 3, total: 3 }) });
        expect(h).toContain('Send a call quality report?');
        expect(h).toContain('never message content');
        expect(h).toContain('Send report');
        expect(h).toContain('Not now');
        expect(h).not.toMatch(/beta/i);
    });
    it('sending and partial-result states are announced as status', () => {
        expect(html({ initialStep: 'sending' })).toContain('role="status"');
        expect(html({ initialStep: 'sending' })).toContain('Sending');
    });
});
