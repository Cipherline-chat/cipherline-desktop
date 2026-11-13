import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SC = fs.readFileSync(path.resolve(__dirname, 'SidebarConference.tsx'), 'utf8');

describe('wiring: the encoder-overload suggestion never changes the share by itself', () => {
    it('the sampler feeds the watch from the SAME stats it already fetches', () => {
        expect(SC).toContain('onStats: onStatsForOverload,');
    });
    it('the only call into the quality path from the overload code is the Switch action\'s click handler', () => {
        const a = SC.indexOf('const onOverload = (v: OverloadVerdict)');
        const b = SC.indexOf('const onStatsForOverload');
        const block = SC.slice(a, b);
        const calls = block.match(/adjustScreenShareQualityRef\.current\?\./g) ?? [];
        expect(calls).toHaveLength(1);
        const run = block.slice(block.indexOf('onSwitch: () =>'), block.indexOf('onDismiss:'));
        expect(run).toContain("overloadEventDetail('accepted'");
        expect(run).toContain('adjustScreenShareQualityRef.current?.(');
        expect(block).not.toContain('republishShareRef');
        expect(block).not.toContain('handleScreenShareSelect');
    });
    it('a dismissal is remembered for the setting and logged; a stale suggestion is cleared when the sampling effect is torn down', () => {
        const block = SC.slice(SC.indexOf('const onOverload = (v: OverloadVerdict)'), SC.indexOf('const onStatsForOverload'));
        expect(block).toContain('overload.dismiss(v.key)');
        expect(block).toContain("overloadEventDetail('dismissed'");
        expect(block).toContain('closeOverloadOffer();');
    });
    it('it waits behind a start/swap in flight, a pending codec-drift republish and any other notice or software guard', () => {
        const block = SC.slice(SC.indexOf('const onStatsForOverload'), SC.indexOf('const onEncoderSample'));
        expect(block).toContain('pendingScreenShareRef.current !== null');
        expect(block).toContain('shareDriftRef.current');
        expect(block).toContain('screenShareNoticeRef.current !== null');
        expect(block).toContain('callOfferSlotHolder() !== null');
        expect(block).toContain('swGuard?.hasActed');
        expect(block).toContain('captureBoundSaid');
    });
    it('the suggestion is the offer card, not a note on the 6 s auto-dismiss timer', () => {
        const block = SC.slice(SC.indexOf('const onOverload = (v: OverloadVerdict)'), SC.indexOf('const onStatsForOverload'));
        expect(block).toContain('setOverloadOffer({');
        expect(block).not.toContain('setScreenShareNotice');
        expect(block).toContain('acquireCallOfferSlot(OVERLOAD_OFFER_SLOT)');
    });
    it('a game in front is told to the watch (its collapsed capture is the game-starve card\'s), and a starved verdict is fitted from the target', () => {
        const stats = SC.slice(SC.indexOf('const onStatsForOverload'), SC.indexOf('const onEncoderSample'));
        expect(stats).toContain('gameInFront: gameInFront(fg ?? null, focused)');
        // focus is read BEFORE the overload watch observes, then reused by the game-starve watch
        expect(stats.indexOf('document.hasFocus()')).toBeLessThan(stats.indexOf('overload.observe('));
        const offer = SC.slice(SC.indexOf('const onOverload = (v: OverloadVerdict)'), SC.indexOf('const onStatsForOverload'));
        expect(offer).toContain('suggestionInputs(v.evidence)');
        expect(offer).not.toContain('v.evidence.srcFps');
    });
});
