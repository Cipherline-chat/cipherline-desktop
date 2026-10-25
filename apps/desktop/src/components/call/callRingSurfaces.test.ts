import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Wiring: every speaking indicator draws its ring through the personalization
 * resolver (utils/callPersonalizationStyle.ts) - none still paints the stock
 * green by hand. This is the test that catches a NEW speaking indicator
 * someone adds with `ring-green-500`, and a consumer of the speaking state that
 * forgets the resolver.
 *
 * The surfaces, as of this feature (each is asserted below):
 *   ParticipantCard.tsx   ParticipantRowShell (voice-channel / call list row), ParticipantTileShell (avatar tile)
 *   VideoTile.tsx         border overlay, camera-off centre avatar, name-pill avatar
 *   ScreenShareGate.tsx   the "click to watch" card border
 *   FloatingHuddleCard.tsx  the floating call card's rows
 *   SpeakingRing.tsx      used by ServerContextPanel's two voice/Calls rosters
 */
const COMPONENTS = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) out.push(p);
    }
    return out;
}
const files = walk(COMPONENTS);
const read = (rel: string) => readFileSync(join(COMPONENTS, rel), 'utf8');

describe('speaking indicators use the ring-colour resolver', () => {
    it('no component paints the stock speaking green by hand', () => {
        const offenders = files.filter(f => /ring-green-500|border-green-500|rgb\(34, 197, 94\)/.test(readFileSync(f, 'utf8')));
        expect(offenders.map(f => relative(COMPONENTS, f))).toEqual([]);
    });

    it('every file that consumes the speaking state also uses the resolver (or SpeakingRing)', () => {
        const consumers = files.filter(f => /useFastIsSpeaking\(|useIsCallParticipantSpeaking\(|<SpeakingRing\b/.test(readFileSync(f, 'utf8')));
        // Sanity: the scan actually finds the known surfaces.
        const names = consumers.map(f => relative(COMPONENTS, f));
        for (const known of ['call/ParticipantCard.tsx', 'call/VideoTile.tsx', 'call/ScreenShareGate.tsx', 'call/FloatingHuddleCard.tsx', 'server/ServerContextPanel.tsx']) {
            expect(names).toContain(known);
        }
        const missing = consumers.filter(f => {
            const src = readFileSync(f, 'utf8');
            return !/speakingShadow\(|speakingBorderColor\(/.test(src) && !/<SpeakingRing\b/.test(src);
        });
        expect(missing.map(f => relative(COMPONENTS, f))).toEqual([]);
    });

    it('SpeakingRing resolves THEIR colour from the personalization store', () => {
        const src = read('call/SpeakingRing.tsx');
        expect(src).toMatch(/useCallPersonalization\(uid\)/);
        expect(src).toMatch(/speakingShadow\(ring_color/);
    });

    it('both server rosters go through SpeakingRing with a glow, not a class', () => {
        const src = read('server/ServerContextPanel.tsx');
        expect((src.match(/<SpeakingRing\b/g) ?? []).length).toBe(2);
        expect(src).not.toMatch(/speakingClassName/);
    });

    it('ParticipantCard: row and tile shells both take the colour from the store', () => {
        const src = read('call/ParticipantCard.tsx');
        expect((src.match(/useCallPersonalization\(userId\)/g) ?? []).length).toBe(2);
        expect((src.match(/speakingShadow\(ring_color/g) ?? []).length).toBe(2);
    });

    it('VideoTile: border overlay, centre avatar and name-pill avatar all use the colour', () => {
        const src = read('call/VideoTile.tsx');
        expect(src).toMatch(/useCallPersonalization\(p\.identity\)/);
        expect((src.match(/speakingShadow\(ringColor/g) ?? []).length).toBe(3);
    });

    it('ScreenShareGate and FloatingHuddleCard use the colour', () => {
        const gate = read('call/ScreenShareGate.tsx');
        expect(gate).toMatch(/useCallPersonalization\(p\.identity\)/);
        expect(gate).toMatch(/speakingBorderColor\(ringColor\)/);
        const card = read('call/FloatingHuddleCard.tsx');
        expect(card).toMatch(/speakingShadow\(ring_color/);
    });

    it('no profile-theme tint on any call surface (owner removed it from call lists and DM calls, 2026-10-25)', () => {
        for (const rel of ['call/ParticipantCard.tsx', 'call/FloatingHuddleCard.tsx', 'call/VideoTile.tsx', 'server/ServerContextPanel.tsx']) {
            expect(read(rel)).not.toMatch(/theme(Row|Tile)Background|VoiceRowTint/);
        }
    });
});

/**
 * SWEEP. The tests above pin the surfaces we KNOW about. These close the door
 * on the ones we do not: they read every component/context/hook source and
 * every stylesheet, find everything that touches the speaking state, and fail
 * unless each file is either a ring drawer that goes through the resolver or is
 * listed below WITH A REASON it never paints a speaking colour. A new
 * indicator in a new file (or a new hand-painted branch in an old one) cannot
 * land silently: the author has to classify it here, which is the moment
 * someone checks it resolves THE SPEAKER'S colour.
 *
 * Behaviour (not just text) is covered by callRingRender.test.ts.
 */
const SRC = join(__dirname, '..', '..');
function walkAll(dir: string, exts: RegExp, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== 'node_modules') walkAll(p, exts, out); }
        else if (exts.test(name) && !/\.test\./.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
    }
    return out;
}
const rel = (f: string) => relative(SRC, f).split('\\').join('/');
/** Source with comments removed (prose mentioning "speaking" is not a consumer). */
function code(file: string): string {
    return readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}
const logicFiles = ['components', 'contexts', 'hooks'].flatMap(d => walkAll(join(SRC, d), /\.tsx?$/));
const cssFiles = walkAll(SRC, /\.css$/);
const SPEAKING = /speaking/i;
const mentioningSpeaking = logicFiles.filter(f => SPEAKING.test(code(f)));

/** Files that PAINT a speaking indicator themselves: must call the resolver. */
const RING_DRAWERS = [
    'components/call/ParticipantCard.tsx',
    'components/call/VideoTile.tsx',
    'components/call/ScreenShareGate.tsx',
    'components/call/FloatingHuddleCard.tsx',
    'components/call/SpeakingRing.tsx',
];
/** Files that mention speaking but paint nothing in the speaker's colour. Each needs a reason. */
const NO_RING_PAINT: Record<string, string> = {
    'components/server/ServerContextPanel.tsx': 'draws its rosters only through <SpeakingRing> (asserted above: exactly 2)',
    'components/CallPane.tsx': 'CallSpeakingReporter only feeds the isSpeaking map up to the host; no pixels',
    'hooks/useSpeakerPromotion.ts': 'reads who is speaking only to ORDER tiles (promote/demote with hysteresis) in the grid and the focused-view strip; paints nothing',
    'components/SidebarConference.tsx': 'pushes speaking into callSpeakingStore / tray / call-media presence / active-speaker ordering; every visible ring is drawn by the tiles and cards it renders',
    'components/call/JoiningCallView.tsx': 'passes speaking={false} to the shells (nobody is "speaking" while joining)',
    'components/settings/panes/CallPersonalizeCard.tsx': 'the colour PICKER (its preview ring is the resolver output)',
    'components/VoiceVideoSettings.tsx': 'mic test copy ("speaking" in user-facing text)',
};
const NO_RING_PAINT_PREFIXES: Record<string, string> = {
    'components/mascot/': 'Keys mascot mirror (data-speaking drives a mic/eq animation, never the participant ring)',
};
const classified = (r: string) => RING_DRAWERS.includes(r) || r in NO_RING_PAINT || Object.keys(NO_RING_PAINT_PREFIXES).some(p => r.startsWith(p));

/** Colours the stock ring / brand accents are drawn in. */
const STOCK_RING_COLOUR = new RegExp([
    String.raw`\b(?:ring|border|shadow|outline|bg|from|to|via|text|fill|stroke)-(?:green|emerald|teal|lime|cl-ok|cl-lume)\b`,
    String.raw`#(?:22c55e|4ade80|25e0c8|3bead6)\b`,
    String.raw`rgba?\(\s*(?:34,\s*197,\s*94|74,\s*222,\s*128|37,\s*224,\s*200)\b`,
    String.raw`var\(--cl-(?:ok|lume)\b`,
].join('|'), 'i');

/** Hard-coded colour lines near a speaking branch that are NOT the speaking ring. */
const NOT_THE_SPEAKING_RING: Array<{ file: string; snippet: string; why: string }> = [
    {
        file: 'components/call/VideoTile.tsx',
        snippet: "boxShadow: 'inset 0 0 0 2px rgba(37, 224, 200, 0.6)'",
        why: 'the FOCUS outline (`isFocused && !isFocusedView && !showBorderSpeaking`): brand lume, drawn only when the tile is NOT speaking',
    },
    {
        file: 'components/call/ScreenShareGate.tsx',
        snippet: "'border border-cl-lume/20'",
        why: 'the IDLE (not speaking) border of the click-to-watch card; the speaking border is the inline speakingBorderColor() beside it',
    },
    {
        file: 'components/settings/panes/CallPersonalizeCard.tsx',
        snippet: "setCustomMsg('Use a color like #25e0c8.')",
        why: 'example text in the custom-ring-color validation message, not a painted colour (the preview ring goes through speakingShadow(mine.ring_color))',
    },
];

describe('speaking sweep: nothing paints a speaking colour behind the resolver\'s back', () => {
    it('the scan sees the known surfaces (guards the sweep itself against rotting)', () => {
        const seen = mentioningSpeaking.map(rel);
        for (const f of [...RING_DRAWERS, 'components/server/ServerContextPanel.tsx', 'components/SidebarConference.tsx', 'components/CallPane.tsx']) expect(seen).toContain(f);
        expect(logicFiles.length).toBeGreaterThan(200);
        expect(cssFiles.length).toBeGreaterThan(5);
    });

    it('every file that touches the speaking state is classified (ring drawer, or listed with a reason)', () => {
        const unclassified = mentioningSpeaking.map(rel).filter(r => !classified(r));
        // New speaking consumer: route its ring through speakingShadow() /
        // speakingBorderColor() with the SPEAKER's colour (useCallPersonalization(id)),
        // then add it to RING_DRAWERS; or list it in NO_RING_PAINT with the reason it paints nothing.
        expect(unclassified).toEqual([]);
    });

    it('no allowlist entry is stale (file gone, or no longer mentions speaking)', () => {
        const seen = new Set(mentioningSpeaking.map(rel));
        for (const f of [...RING_DRAWERS, ...Object.keys(NO_RING_PAINT)]) expect(seen.has(f), f).toBe(true);
    });

    it('every ring drawer calls the resolver and reads the colour from the personalization store', () => {
        for (const r of RING_DRAWERS) {
            const src = code(join(SRC, r));
            expect(src, r).toMatch(/speakingShadow\(|speakingBorderColor\(/);
            expect(src, r).toMatch(/useCallPersonalization\(/);
        }
    });

    it('every resolver call is fed a store-derived colour, never a literal / null / undefined', () => {
        let calls = 0;
        for (const f of logicFiles) {
            const src = code(f);
            for (const m of src.matchAll(/(speakingShadow|speakingBorderColor)\(\s*([^,)\s]*)/g)) {
                calls++;
                expect(m[2], `${rel(f)} passes ${m[2]} to ${m[1]}`).toMatch(/^(ring_color|ringColor|mine\.ring_color)$/);
            }
        }
        expect(calls).toBeGreaterThanOrEqual(8);
    });

    it('no hard-coded stock/brand colour within a few lines of a speaking branch (allowlist: documented non-speaking uses)', () => {
        const offenders: string[] = [];
        for (const f of mentioningSpeaking) {
            const lines = code(f).split('\n');
            const flagged = new Set<number>();
            lines.forEach((l, i) => {
                if (!SPEAKING.test(l)) return;
                for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 5); j++) {
                    if (STOCK_RING_COLOUR.test(lines[j])) flagged.add(j);
                }
            });
            for (const j of flagged) {
                const l = lines[j];
                if (NOT_THE_SPEAKING_RING.some(a => a.file === rel(f) && l.includes(a.snippet))) continue;
                offenders.push(`${rel(f)}:${j + 1}: ${l.trim().slice(0, 140)}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('no inline boxShadow next to a speaking branch bypasses the resolver', () => {
        const offenders: string[] = [];
        for (const f of mentioningSpeaking) {
            const lines = code(f).split('\n');
            lines.forEach((l, i) => {
                if (!/boxShadow\s*:/.test(l) || /speakingShadow\(|resolveRingColor\(/.test(l)) return;
                const near = lines.slice(Math.max(0, i - 6), i + 2).join('\n');
                if (!SPEAKING.test(near)) return;
                if (NOT_THE_SPEAKING_RING.some(a => a.file === rel(f) && l.includes(a.snippet))) return;
                offenders.push(`${rel(f)}:${i + 1}: ${l.trim().slice(0, 140)}`);
            });
        }
        expect(offenders).toEqual([]);
    });

    it('a `speaking` prop is only ever false (joining), fed by the real state inside ParticipantCard, or the Keys mascot data attribute', () => {
        const offenders: string[] = [];
        for (const f of logicFiles) {
            const src = code(f);
            for (const m of src.matchAll(/\bspeaking=\{([^}]*)\}/g)) {
                const ok = m[1].trim() === 'false' || rel(f) === 'components/call/ParticipantCard.tsx' || rel(f).startsWith('components/mascot/');
                if (!ok) offenders.push(`${rel(f)}: speaking={${m[1].trim()}}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('no stylesheet styles a speaking state (the ring is inline, from the resolver); the Keys mascot is the one exception and paints no ring', () => {
        const withSpeaking = cssFiles.filter(f => SPEAKING.test(readFileSync(f, 'utf8'))).map(rel);
        expect(withSpeaking).toEqual(['styles/home-keys-mirror.css']);
        const css = readFileSync(join(SRC, 'styles/home-keys-mirror.css'), 'utf8');
        for (const rule of css.split('}').filter(r => /speaking/.test(r))) {
            expect(rule).not.toMatch(/box-shadow|border-color|outline|ring/);
        }
    });
});

describe('entrance sounds wiring', () => {
    it('CallAudioEffects plays them through useEntranceSounds, minus yourself', () => {
        const src = readFileSync(join(COMPONENTS, 'CallPane.tsx'), 'utf8');
        expect(src).toMatch(/useEntranceSounds\(\s*participants\.filter\(p => !p\.isLocal\)/);
    });

    it('the hook gates through the listener rules and reads the joiner\'s current sound', () => {
        const src = read('call/useEntranceSounds.ts');
        expect(src).toMatch(/createEntranceGate/);
        expect(src).toMatch(/freshCallPersonalization/);
        expect(src).toMatch(/prefs\.muted\.includes\(id\)/);
    });

    it('both participant menus carry the per-user mute', () => {
        expect(read('call/PopoverMenu.tsx')).toMatch(/Mute Entrance Sound/);
        expect(read('server/ServerContextPanel.tsx')).toMatch(/Mute Entrance Sound/);
    });

    it('playback goes through the app sound utility, not a raw Audio element', () => {
        const src = readFileSync(join(COMPONENTS, '..', 'utils', 'entrancePlayback.ts'), 'utf8');
        expect(src).toMatch(/playGeneratedSound/);
        expect(src).toMatch(/previewSound/);
        expect(src).not.toMatch(/new Audio\(/);
    });
});
