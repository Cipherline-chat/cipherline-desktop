/**
 * The rating card is an explicit user action: it must not depend on the
 * "Share beta diagnostics" toggle, and with the toggle OFF nothing automatic
 * (the call summary) may be queued.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = new Map<string, string>();
vi.mock('../secureLocalStore', () => {
    const api = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    return { default: api, secureLocalStore: api };
});

const cs = await import('./callSession');
const { betaReporter } = await import('./reporter');
const { RATING_EVERY_N_CALLS } = await import('./settings');

const MIN = 60_000;
const T0 = 1_760_000_000_000;

function oneCall(i: number) {
    const t = cs.beginBetaCall({ callType: 'voice' as never, e2ee: true }, T0 + i * 60 * MIN);
    cs.endBetaCall(t, T0 + i * 60 * MIN + 120_000);
}

describe('rating card vs the beta toggle', () => {
    beforeEach(() => {
        store.clear();
        cs.__resetBetaCallForTests();
        betaReporter.setSignedIn(false);
        betaReporter.setServerEnabled(false);
        betaReporter.setLocalEnabled(false);
        cs.setBetaCallUser('u1');
    });

    it('toggle OFF: the 25th call still shows the card, with no call summary id and nothing queued', () => {
        const spy = vi.spyOn(betaReporter, 'sendCallSummary');
        for (let i = 1; i < RATING_EVERY_N_CALLS; i++) { oneCall(i); expect(cs.getRatingCard()).toBeNull(); }
        oneCall(RATING_EVERY_N_CALLS);
        expect(cs.getRatingCard()).toMatchObject({ callSummaryId: null });
        expect(cs.getRatingCard()?.heldSummary).toBeTruthy();
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it('toggle ON: same call count, and the card carries the queued summary id', () => {
        betaReporter.setServerEnabled(true); betaReporter.setLocalEnabled(true); betaReporter.setSignedIn(true);
        for (let i = 1; i <= RATING_EVERY_N_CALLS; i++) oneCall(i);
        const c = cs.getRatingCard();
        expect(typeof c?.callSummaryId).toBe('string');
        betaReporter.setSignedIn(false);
    });

    it('signed out: no card', () => {
        cs.setBetaCallUser(null);
        for (let i = 1; i <= RATING_EVERY_N_CALLS; i++) oneCall(i);
        expect(cs.getRatingCard()).toBeNull();
    });
});

describe('rating always uploads with the call summary', () => {
    const sent: Array<{ route: string; body: Record<string, unknown> }> = [];
    beforeEach(() => {
        store.clear(); sent.length = 0;
        cs.__resetBetaCallForTests();
        betaReporter.configure({ transport: async (route, body) => { sent.push({ route, body: JSON.parse(JSON.stringify(body)) }); return { ok: true }; } });
        betaReporter.setServerEnabled(true); betaReporter.setLocalEnabled(false); betaReporter.setSignedIn(true);
        cs.setBetaCallUser('u1');
    });
    const cardAt25 = () => { for (let i = 1; i <= RATING_EVERY_N_CALLS; i++) oneCall(i); return cs.getRatingCard()!; };

    it('toggle OFF + rate: exactly one upload, summary + rating', async () => {
        const c = cardAt25();
        expect(sent).toHaveLength(0);
        cs.submitCallRating(c, 2, ['echo']);
        await Promise.resolve(); await Promise.resolve();
        expect(sent).toHaveLength(1);
        expect(sent[0].route).toBe('call-summary');
        expect(sent[0].body).toMatchObject({ rating: 2, call_type: 'voice' });
        expect(sent[0].body.rating_tags).toEqual(['echo']);
    });

    it('toggle OFF + dismiss: zero uploads, and no other beta traffic', async () => {
        const c = cardAt25();
        expect(c.heldSummary).toBeTruthy();
        cs.dismissRatingCard();
        betaReporter.report('unhandled_error' as never, { detail: { a: 'b' } });
        await betaReporter.flush();
        expect(sent).toHaveLength(0);
        expect(betaReporter.peekQueue()).toHaveLength(0);
    });

    it('server gate OFF: rating sends nothing', async () => {
        const c = cardAt25();
        betaReporter.setServerEnabled(false);
        cs.submitCallRating(c, 5);
        await Promise.resolve(); await Promise.resolve();
        expect(sent).toHaveLength(0);
    });

    it('toggle ON unchanged: summary queued at call end, rating rides it', async () => {
        betaReporter.setLocalEnabled(true);
        const c = cardAt25();
        expect(c.heldSummary).toBeUndefined();
        cs.submitCallRating(c, 4);
        await betaReporter.flush();
        const bodies = sent.filter(s => s.route === 'call-summary');
        expect(bodies.length).toBeGreaterThanOrEqual(1);
        expect(bodies.some(b => b.body.rating === 4)).toBe(true);
        betaReporter.setSignedIn(false);
    });
});
