import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createNudgeCoalescer, NUDGE_DEBOUNCE_MS } from './useOwnSlotNudge';

/** A manual scheduler so "a burst is one run" is deterministic. */
function sched() {
    const q: Array<{ fn: () => void; ms: number; live: boolean }> = [];
    return {
        schedule: (fn: () => void, ms: number) => { const t = { fn, ms, live: true }; q.push(t); return t; },
        cancel: (h: unknown) => { (h as { live: boolean }).live = false; },
        fire: () => { for (const t of q.splice(0)) if (t.live) t.fn(); },
        q,
    };
}
const ev = (slot: unknown) => ({ detail: { slot } });

describe('own_slot:changed nudge coalescer', () => {
    it('a burst of nudges for the slot is ONE pull, after the debounce', () => {
        const s = sched(); let pulls = 0;
        const c = createNudgeCoalescer('themes', () => { pulls++; }, s.schedule, s.cancel);
        for (let i = 0; i < 6; i++) c.onEvent(ev('themes'));
        expect(s.q).toHaveLength(1);
        expect(s.q[0].ms).toBe(NUDGE_DEBOUNCE_MS);
        expect(pulls).toBe(0);
        s.fire();
        expect(pulls).toBe(1);
        c.onEvent(ev('themes')); s.fire();
        expect(pulls).toBe(2);
    });
    it('ignores other slots, unknown names, history and junk quietly', () => {
        const s = sched(); let pulls = 0;
        const c = createNudgeCoalescer('themes', () => { pulls++; }, s.schedule, s.cancel);
        for (const slot of ['card_styles', 'history', '../x', 7, undefined, null]) c.onEvent(ev(slot));
        c.onEvent({} as Event);
        s.fire();
        expect(pulls).toBe(0);
    });
    it('cancel (unmount / sign-out) drops a pending pull', () => {
        const s = sched(); let pulls = 0;
        const c = createNudgeCoalescer('server_rail', () => { pulls++; }, s.schedule, s.cancel);
        c.onEvent(ev('server_rail')); c.cancel(); s.fire();
        expect(pulls).toBe(0);
    });
});

describe('every own-device slot the desktop syncs subscribes to the nudge (never history)', () => {
    const src = (p: string) => readFileSync(join(__dirname, p), 'utf8');
    const wired: Array<[string, string, string]> = [
        ['mutes', 'useMuteSync.ts', 'OWN_SLOT_CHANGED_EVENT'],
        ['themes', 'useCustomThemeSync.ts', "useOwnSlotNudge('themes'"],
        ['card_styles', 'useCardStyleSync.ts', "useOwnSlotNudge('card_styles'"],
        ['server_rail', 'useServerRailSync.ts', "useOwnSlotNudge('server_rail'"],
        ['personal_saves', 'usePersonalSavesSync.ts', "useOwnSlotNudge('personal_saves'"],
        // My Emojis and My stickers share one hook body (createLibrarySync): each
        // config names its slot, and the body subscribes with useOwnSlotNudge(cfg.slot, ...).
        ['personal_emojis', 'usePersonalEmojiSync.ts', 'slot: EMOJI_LIBRARY_SLOT'],
        ['personal_stickers', 'usePersonalEmojiSync.ts', 'slot: STICKER_LIBRARY_SLOT'],
        ['personal_emojis/personal_stickers (shared body)', 'usePersonalEmojiSync.ts', 'useOwnSlotNudge(cfg.slot'],
        ['gif_library', 'useGifLibrarySync.ts', "useOwnSlotNudge('gif_library'"],
        ['achievements', 'useAchievementsSync.ts', "useOwnSlotNudge('achievements'"],
        ['profile_notes', '../components/ProfileNotesHost.tsx', "createNudgeCoalescer('profile_notes'"],
    ];
    for (const [slot, file, needle] of wired) it(`${slot} (${file})`, () => { expect(src(file)).toContain(needle); });
    it('nothing subscribes to history', () => {
        for (const [, file] of wired) expect(src(file)).not.toMatch(/useOwnSlotNudge\('history'|createNudgeCoalescer\('history'/);
    });
    it('the realtime hook validates the slot name before dispatching', () => {
        expect(src('useRealtime.ts')).toContain('[a-z_]{1,32}');
    });
});
