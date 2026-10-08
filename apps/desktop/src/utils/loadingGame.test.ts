import { describe, it, expect } from 'vitest';
import { newGame, startRun, act, quit, step, keysX, formation, formedAt, FAIR_AHEAD, RULES } from './loadingGame';

const HALF_W = 1.6; // a 16:10 window

describe('Firewall rules', () => {
    it('starts on the first act, with that act as the first pulse', () => {
        const g = newGame(0, 7);
        expect(act(g, HALF_W, 0.16)).toBe('start');
        expect(g.mode).toBe('playing');
        // the stroke eases in over a few frames rather than snapping
        expect(g.thrust).toBe(RULES.thrust);
        step(g, 1 / 60, HALF_W);
        expect(g.vy).toBeGreaterThan(0);
        expect(g.vy).toBeLessThan(RULES.flap);
        for (let i = 0; i < 5; i++) step(g, 1 / 60, HALF_W);
        expect(g.vy).toBeGreaterThan(RULES.flap * 0.9);
        expect(g.walls.filter(w => w.live).length).toBeGreaterThan(2);
        // walls start off-screen to the right
        for (const w of g.walls.filter(x => x.live)) expect(w.x).toBeGreaterThan(HALF_W);
    });

    it('a pulse lifts Keys, and without one he sinks to the floor and crashes', () => {
        const g = newGame(0, 7);
        startRun(g, HALF_W, 0);
        for (let i = 0; i < 12; i++) step(g, 1 / 120, HALF_W);
        expect(g.y).toBeGreaterThan(0);
        let died = false;
        for (let i = 0; i < 400 && !died; i++) died = step(g, 1 / 120, HALF_W).died;
        expect(died).toBe(true);
        expect(g.mode).toBe('over');
        expect(g.y - RULES.radius).toBeLessThan(-1 + 0.05);
    });

    it('never flies off the top: the ceiling clamps instead of killing', () => {
        const g = newGame(0, 7);
        startRun(g, HALF_W, 0.8);
        for (let i = 0; i < 60; i++) { act(g, HALF_W, 0); step(g, 1 / 60, HALF_W); }
        expect(g.mode).toBe('playing');
        expect(g.y + RULES.radius).toBeLessThanOrEqual(RULES.top + 1e-9); // the score strip above stays clear
    });

    it('scores a wall once Keys is past it, and crashes into a wall outside its gap', () => {
        const g = newGame(0, 3);
        startRun(g, HALF_W, 0);
        const kx = keysX(HALF_W);
        // Park the first wall just past Keys with its gap on him: one point.
        const w = g.walls[0];
        w.gap = 0; w.gapH = 0.8; w.x = kx - RULES.wallW / 2 - RULES.radius + 0.001;
        g.vy = 0; g.thrust = 0;
        const r = step(g, 1 / 60, HALF_W);
        expect(r.scored).toBe(true);
        expect(g.score).toBe(1);
        expect(r.died).toBe(false);

        // Now a wall right on top of him with the gap far above: crash.
        const g2 = newGame(0, 3);
        startRun(g2, HALF_W, -0.5);
        const w2 = g2.walls[0];
        w2.gap = 0.6; w2.gapH = 0.5; w2.x = kx;
        g2.vy = 0; g2.thrust = 0;
        expect(step(g2, 1 / 120, HALF_W).died).toBe(true);
        expect(g2.best).toBe(0);
    });

    it('keeps the best score, waits a beat before a retry, and Esc leaves the game', () => {
        const g = newGame(5, 9);
        startRun(g, HALF_W, 0);
        g.score = 8;
        g.y = -2; // through the floor
        step(g, 1 / 120, HALF_W);
        expect(g.mode).toBe('over');
        expect(g.best).toBe(8);
        expect(act(g, HALF_W, 0)).toBe('wait');
        step(g, RULES.retryAfter, HALF_W);
        expect(act(g, HALF_W, 0)).toBe('start');
        expect(g.score).toBe(0);
        quit(g);
        expect(g.mode).toBe('idle');
        expect(g.walls.some(w => w.live)).toBe(false);
    });

    it('keeps every gap reachable: inside the playfield, and never too far from the last one', () => {
        const g = newGame(0, 12345);
        startRun(g, HALF_W, 0);
        g.vy = 0;
        const gaps: number[] = [];
        // run walls through with Keys held safely in no wall's way: count only placement
        for (let i = 0; i < 4000; i++) {
            g.y = 0; g.vy = 0; g.thrust = 0;
            const r = step(g, 1 / 60, HALF_W);
            if (g.mode !== 'playing') { g.mode = 'playing'; }
            r.respawned.forEach(s => gaps.push(g.walls[s].gap));
            for (const s of r.respawned) {
                const w = g.walls[s];
                expect(w.gap + w.gapH / 2).toBeLessThanOrEqual(RULES.top - RULES.margin + 1e-9);
                expect(w.gap - w.gapH / 2).toBeGreaterThanOrEqual(-1 + RULES.margin - 1e-9);
                expect(w.gapH).toBe(RULES.gap0);
            }
        }
        expect(gaps.length).toBeGreaterThan(20);
        for (let i = 1; i < gaps.length; i++) expect(Math.abs(gaps[i] - gaps[i - 1])).toBeLessThanOrEqual(RULES.maxStep + 1e-9);
    });
});

describe('pillars building out of the field', () => {
    const widths = [800 / 600, 1440 / 900, 1920 / 1080, 2560 / 1080].map(a => a); // halfW = width / height

    it('enter loose on the right and are solid by the time they are 40% of the window ahead of Keys', () => {
        for (const halfW of widths) {
            for (const score of [0, 5, 10, 20, 50]) {
                expect(formation(halfW + RULES.wallW, halfW, score)).toBe(0);
                const fairX = keysX(halfW) + FAIR_AHEAD * 2 * halfW;
                expect(formation(fairX, halfW, score)).toBe(1);
                // ...and everywhere nearer Keys than that, including where he can touch it
                for (let x = fairX; x > keysX(halfW) - RULES.wallW; x -= 0.05) expect(formation(x, halfW, score)).toBe(1);
            }
        }
    });

    it('only ever firms up as a pillar approaches (never loosens again)', () => {
        for (const halfW of widths) {
            let last = -1;
            for (let x = halfW + 0.2; x > keysX(halfW); x -= 0.01) {
                const f = formation(x, halfW, 7);
                expect(f).toBeGreaterThanOrEqual(last - 1e-12);
                last = f;
            }
        }
    });

    it('settles later as the score climbs, but never past the fairness bound', () => {
        const halfW = 1.6;
        const early = formedAt(halfW, 0), late = formedAt(halfW, 20), later = formedAt(halfW, 200);
        expect(early).toBeGreaterThan(late);
        expect(late).toBeCloseTo(later, 9);
        expect(late - keysX(halfW)).toBeCloseTo(FAIR_AHEAD * 2 * halfW, 9);
        // mostly formed by mid-screen, even late in a run
        expect(formation(0, halfW, 200)).toBe(1);
        expect(formation(0.8, halfW, 0)).toBe(1);
    });
});

describe('difficulty curve', () => {
    it('the gaps never narrow, however high the score', () => {
        const g = newGame(0, 777);
        startRun(g, HALF_W, 0);
        g.score = 400; // far past anything the old curve floored out at
        for (let i = 0; i < 3000; i++) {
            g.y = 0; g.vy = 0; g.thrust = 0;
            const r = step(g, 1 / 60, HALF_W);
            if (g.mode !== 'playing') g.mode = 'playing';
            for (const s of r.respawned) expect(g.walls[s].gapH).toBe(RULES.gap0);
        }
    });

    it('speed keeps climbing with every point, with no ceiling', () => {
        const g = newGame(0, 5);
        startRun(g, HALF_W, 0);
        const seen: number[] = [];
        for (const score of [0, 10, 40, 100, 300]) {
            g.score = score - 1; // the next wall passed scores `score`
            for (const w of g.walls) if (w.live) { w.x = keysX(HALF_W) - 1; w.passed = false; break; }
            g.y = 0; g.vy = 0; g.thrust = 0;
            step(g, 1 / 60, HALF_W);
            seen.push(g.speed);
        }
        expect(seen[0]).toBeCloseTo(RULES.speed0, 5);
        for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
        expect(seen[seen.length - 1]).toBeCloseTo(RULES.speed0 + 300 * RULES.speedPerPoint, 5);
    });
});
