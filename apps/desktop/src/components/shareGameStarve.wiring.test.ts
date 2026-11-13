import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SC = fs.readFileSync(path.resolve(__dirname, 'SidebarConference.tsx'), 'utf8');
const HEALTH = fs.readFileSync(path.resolve(__dirname, '../utils/shareHealth.ts'), 'utf8');

const starveBlock = () => SC.slice(SC.indexOf('const onStarved = (v: StarveVerdict)'), SC.indexOf('const onOverload = (v: OverloadVerdict)'));
const statsBlock = () => SC.slice(SC.indexOf('const onStatsForOverload'), SC.indexOf('const onEncoderSample'));

describe('wiring: a game starving the share is offered, never acted on without a click', () => {
    it('the sampler hands the watch the foreground answer of the SAME sample, and the watch is fed the same stats report', () => {
        expect(HEALTH).toContain('onStats?(stats: StatsLike, at: number, fg?: ForegroundDiag | null): void;');
        expect(HEALTH).toContain('this.deps.onStats?.(stats, at, fg)');
        expect(SC).toContain('onStats: onStatsForOverload,');
        expect(statsBlock()).toContain('(stats: ShareStatsLike, at: number, fg?: ForegroundDiag | null)');
        expect(statsBlock()).toContain('starve.observe(at, stats,');
        expect(statsBlock()).toContain('fg: fg ?? null');
    });

    it('the encoder-overload card goes first and keeps every window it calls overload: its verdict returns before the starve watch runs', () => {
        const b = statsBlock();
        expect(b.indexOf('overload.observe(')).toBeGreaterThan(-1);
        expect(b.indexOf('if (verdict) { onOverload(verdict); return; }')).toBeGreaterThan(b.indexOf('overload.observe('));
        expect(b.indexOf('starve.observe(')).toBeGreaterThan(b.indexOf('if (verdict) { onOverload(verdict); return; }'));
    });

    it('it waits behind exactly what the encoder-overload card waits behind (one definition, both watches)', () => {
        const b = statsBlock();
        for (const needle of ['pendingScreenShareRef.current !== null', 'shareDriftRef.current', 'screenShareNoticeRef.current !== null',
            'callOfferSlotHolder() !== null', 'swGuard?.hasActed', 'captureBoundSaid']) expect(b).toContain(needle);
        expect(b).toMatch(/starve\.observe\(at, stats, \{[^}]*blocked, suppressed \}\)/);
        expect(b).toMatch(/overload\.observe\(at, stats, \{[^}]*blocked, suppressed(, gameInFront: gameInFront\(fg \?\? null, focused\))? \}\)/);
    });

    it('one watch per share, restarted with the sampling effect like the overload watch', () => {
        expect(SC).toContain('new GameStarveWatch()');
        expect(SC).toContain('starveRef.current.sourceId !== share.sourceId');
        expect(SC).toContain('starve.restart(performance.now());');
    });

    it('it is the same offer card and slot: at most one up at a time, closed when the share or its setting changes', () => {
        const b = starveBlock();
        expect(b).toContain('acquireCallOfferSlot(OVERLOAD_OFFER_SLOT)');
        expect(b).toContain('setOverloadOffer({');
        expect(b).not.toContain('setScreenShareNotice({ tone: \'warn\', text: \'Your');
        expect(SC).toContain('React.useEffect(() => () => { closeOverloadOffer(); }, [ssTrackSid, currentShare]);');
    });

    it('the only things a click can do: turn the boost on (the user\'s own setting) or take the existing quality path; a tip has no accept at all', () => {
        const b = starveBlock();
        expect(b.match(/adjustScreenShareQualityRef\.current\?\./g) ?? []).toHaveLength(1);
        expect(b.match(/setGamingVideoMode\(true\)/g) ?? []).toHaveLength(1);
        const accept = b.slice(b.indexOf('onSwitch: () =>'), b.indexOf('onDismiss: () =>'));
        expect(accept).toContain("starveEventDetail('accepted'");
        expect(accept).toContain("plan.action === 'lower' && sug");
        // the click handlers are the only callers; nothing runs on show
        const beforeAccept = b.slice(0, b.indexOf('onSwitch: () =>'));
        expect(beforeAccept).not.toContain('adjustScreenShareQualityRef');
        expect(beforeAccept).not.toContain('setGamingVideoMode');
        expect(b).toContain("plan.action === 'tip' ? {} :");
        expect(b).not.toContain('republishShareRef');
        expect(b).not.toContain('handleScreenShareSelect');
    });

    it('a dismissal is remembered for that cause + setting and logged; "Not now" on the boost shares the gaming offer\'s snooze, "Turn on" clears it', () => {
        const b = starveBlock();
        const dismiss = b.slice(b.indexOf('onDismiss: () =>'));
        expect(dismiss).toContain('starve.dismiss(v.key)');
        expect(dismiss).toContain("starveEventDetail('dismissed'");
        expect(dismiss).toContain("answerGamingBoostOffer(readGamingBoostOffer(), 'not-now'");
        expect(b).toContain("answerGamingBoostOffer(readGamingBoostOffer(), 'turn-on'");
    });

    it('the boost is only offered when it is available, off, and the user has not said "never" / "not now" to the same offer', () => {
        const b = starveBlock();
        expect(b).toContain('!snap.available ? \'na\' : snap.enabled ? \'on\'');
        expect(b).toContain('canOfferGamingBoost({ state: readGamingBoostOffer()');
    });

    it('every event it logs is the content-free share_game_starve (no program names, no titles)', () => {
        const b = starveBlock();
        const logs = b.match(/logCallEvent\('[a-z_]+'/g) ?? [];
        expect(logs.length).toBeGreaterThanOrEqual(3);
        for (const l of logs) expect(l).toBe("logCallEvent('share_game_starve'");
        expect(b).not.toMatch(/fg\.exe|fg_exe|\.exe\b/);
    });
});
