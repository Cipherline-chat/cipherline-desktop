/**
 * Wiring: the call controls' mic / deafen / camera toggles are ONE icon each
 * with a drawn slash (components/icons/SlashableIcon), in both the live
 * ControlBar and the JoiningControlBar.
 *
 * Both bars are rendered for real (react-dom/server, node env). Each state
 * is checked against its opposite so a toggle stuck on one state fails.
 */
import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('../../contexts/SubscriptionContext', () => ({
    useSubscription: () => ({ canPublishVideo: true, promptUpgrade: () => {} }),
}));

const w = globalThis as unknown as { window?: { matchMedia?: unknown; screen?: unknown } };
if (w.window && typeof w.window.matchMedia !== 'function') {
    w.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
}
if (w.window && !w.window.screen) w.window.screen = { width: 2560, height: 1440 };
const { ControlBar } = await import('./ControlBar');
const { JoiningControlBar } = await import('./JoiningControlBar');

const noop = () => {};

function renderBar(o: { mic: boolean; cam: boolean; deaf: boolean }): string {
    return renderToStaticMarkup(React.createElement(ControlBar, {
        localParticipant: {
            isMicrophoneEnabled: o.mic, isCameraEnabled: o.cam, isScreenShareEnabled: false,
            getTrackPublication: () => undefined,
        },
        isLocalDeafened: o.deaf,
        onToggleMic: noop, onToggleDeafen: noop, onToggleCamera: noop,
        onToggleScreenshare: noop, onOpenScreenSharePicker: noop,
        onAdjustScreenShareQuality: noop, onLeave: noop,
    }));
}

/** The first <button>…</button> whose title matches (controls don't nest buttons). */
function buttonByTitle(html: string, title: string): string {
    const m = new RegExp(`<button[^>]*title="${title}"[^>]*>[\\s\\S]*?</button>`).exec(html);
    if (!m) throw new Error(`no button titled ${title}`);
    return m[0];
}
const slashable = (btn: string) => /<svg[^>]*class="cl-slashable([^"]*)"/.exec(btn)?.[1] ?? null;
const isMuted = (btn: string) => (slashable(btn) ?? '').split(/\s+/).includes('is-muted');

describe('ControlBar toggles use the drawn-slash icon', () => {
    it('mic: on → slashable, not muted; off → muted (slash drawn)', () => {
        const on = buttonByTitle(renderBar({ mic: true, cam: false, deaf: false }), 'Mute');
        const off = buttonByTitle(renderBar({ mic: false, cam: false, deaf: false }), 'Unmute');
        expect(slashable(on)).not.toBeNull();
        expect(isMuted(on)).toBe(false);
        expect(isMuted(off)).toBe(true);
    });
    it('deafen: on → muted slash; off → none', () => {
        const idle = buttonByTitle(renderBar({ mic: true, cam: false, deaf: false }), 'Deafen');
        const deaf = buttonByTitle(renderBar({ mic: true, cam: false, deaf: true }), 'Undeafen');
        expect(slashable(idle)).not.toBeNull();
        expect(isMuted(idle)).toBe(false);
        expect(isMuted(deaf)).toBe(true);
    });
    it('camera: off → muted slash; on → none', () => {
        const off = buttonByTitle(renderBar({ mic: true, cam: false, deaf: false }), 'Turn camera on');
        const on = buttonByTitle(renderBar({ mic: true, cam: true, deaf: false }), 'Turn camera off');
        expect(slashable(off)).not.toBeNull();
        expect(isMuted(off)).toBe(true);
        expect(isMuted(on)).toBe(false);
    });
    it('each toggle holds exactly ONE svg (no on/off glyph pair cross-fading)', () => {
        const html = renderBar({ mic: false, cam: false, deaf: true });
        for (const t of ['Unmute', 'Undeafen', 'Turn camera on']) {
            expect(buttonByTitle(html, t).match(/<svg/g)?.length, t).toBe(1);
        }
        expect(html).not.toContain('ico-off');
        expect(html).not.toContain('ico-on');
        expect(html).not.toContain('cl-ico--tog');
    });
    it('the .cl-ico wrapper stays (press eggs / dizzy target it) and colour tone stays', () => {
        const off = buttonByTitle(renderBar({ mic: false, cam: false, deaf: false }), 'Unmute');
        expect(off).toContain('class="cl-ico"');
        expect(off).toContain('data-tone="off"');
        expect(off).toContain('data-pulse="off"');
        const on = buttonByTitle(renderBar({ mic: true, cam: false, deaf: false }), 'Mute');
        expect(on).toContain('data-tone="neutral"');
    });
});

function renderJoining(o: { muted: boolean; deafened: boolean; canSpeak?: boolean }): string {
    return renderToStaticMarkup(React.createElement(JoiningControlBar, {
        phase: 'joining' as never,
        muted: o.muted, deafened: o.deafened, canSpeak: o.canSpeak ?? true,
        onToggleMute: noop, onToggleDeafen: noop, onLeave: noop,
    }));
}
const joinBtn = (html: string, label: string) => {
    const m = new RegExp(`<button[^>]*aria-label="${label}"[^>]*>[\\s\\S]*?</button>`).exec(html);
    if (!m) throw new Error(`no button ${label}`);
    return m[0];
};

describe('JoiningControlBar toggles use the drawn-slash icon', () => {
    it('mic: muted → slash drawn + aria-pressed; unmuted → not', () => {
        const off = joinBtn(renderJoining({ muted: true, deafened: false }), 'Unmute');
        const on = joinBtn(renderJoining({ muted: false, deafened: false }), 'Mute');
        expect(isMuted(off)).toBe(true);
        expect(off).toContain('aria-pressed="true"');
        expect(isMuted(on)).toBe(false);
        expect(on).toContain('aria-pressed="false"');
    });
    it('mic also reads as off when deafened or listen-only (same rule as before)', () => {
        expect(isMuted(joinBtn(renderJoining({ muted: false, deafened: true }), 'Unmute'))).toBe(true);
        const noSpeak = renderJoining({ muted: false, deafened: false, canSpeak: false });
        expect(isMuted(joinBtn(noSpeak, 'You don&#x27;t have permission to speak here'))).toBe(true);
    });
    it('deafen: deafened → slash drawn; otherwise not', () => {
        expect(isMuted(joinBtn(renderJoining({ muted: false, deafened: true }), 'Undeafen'))).toBe(true);
        expect(isMuted(joinBtn(renderJoining({ muted: false, deafened: false }), 'Deafen'))).toBe(false);
    });
    it('one svg per toggle, no leftover glyph pair', () => {
        const html = renderJoining({ muted: true, deafened: true });
        expect(joinBtn(html, 'Unmute').match(/<svg/g)?.length).toBe(1);
        expect(joinBtn(html, 'Undeafen').match(/<svg/g)?.length).toBe(1);
        expect(html).not.toContain('ico-off');
    });
});

describe('source wiring', () => {
    const read = (f: string) => readFileSync(resolve(__dirname, f), 'utf8');
    it('ControlBar / JoiningControlBar import the shared icons and no longer import the lucide on/off pairs', () => {
        for (const f of ['ControlBar.tsx', 'JoiningControlBar.tsx']) {
            const src = read(f);
            expect(src, f).toMatch(/from '\.\.\/icons\/SlashableIcon'/);
            const lucide = /import \{([^}]*)\} from 'lucide-react'/.exec(src)?.[1] ?? '';
            for (const n of ['Mic', 'MicOff', 'Video', 'VideoOff', 'Headphones', 'HeadphoneOff']) {
                expect(lucide.split(',').map(s => s.trim()), `${f} still imports ${n}`).not.toContain(n);
            }
        }
        const bar = read('ControlBar.tsx');
        for (const c of ['MicIcon', 'CamIcon', 'HeadphonesIcon']) expect(bar).toContain(`<${c} off=`);
    });
    it('control: the matcher would see a stale lucide import', () => {
        const stale = "import { Mic, MicOff, PhoneCall } from 'lucide-react';";
        const names = (/import \{([^}]*)\} from 'lucide-react'/.exec(stale)?.[1] ?? '').split(',').map(s => s.trim());
        expect(names).toContain('MicOff');
    });
});
