/**
 * The loading screen's scene and its easter-egg game, drawn from a dedicated
 * worker into an OffscreenCanvas (see AppLoadingScreen.tsx for why).
 *
 * The screen appears exactly while the renderer's main thread is at its
 * busiest (the Dashboard mounting behind it; multi-second stalls have been
 * seen on real machines). Everything that moves lives here instead: the
 * frame loop, the camera, Keys' swim, the game's physics, the GL calls. The
 * main thread only posts sizes and raw input (keys, and the pointer at most
 * once a frame); this thread answers with state CHANGES. A blocked main
 * thread cannot stall the animation or the game.
 *
 * KEYS is the real mark, drawn exactly: the fragment shader evaluates the
 * logo's own geometry (apps/website/public/logo.svg — four stadium legs, the
 * half-disc dome, the band, two W brows cut in #0B0F1E) as a signed distance
 * field, antialiased to the pixel. That is what lets him swim without ever
 * looking like anything but Keys, always upright: a jellyfish stroke — a
 * quick 0.35 s contraction (the bell narrows, the legs draw together and
 * push down, each a few frames behind the last, tips behind roots) that
 * lifts him a little, then a slow 1.4 s relax in which the legs spread and
 * trail and he glides down. He turns a few degrees to face the pointer
 * (a real perspective tilt, never a roll). In the game, every Space is one
 * stroke, and between strokes his legs drift up and spread as he sinks.
 *
 * THE FIELD is the ambient dot field from behind the onboarding privacy
 * step's globe (ob6 js/scenes.js `stitch` → js/shapes.js `fillAmbient`,
 * drawn by js/dots.js with enterPrivacyDots' params): faint teal/ice dots
 * scattered through a 3D volume (z 0.6…-1.6 in shape units), brightness
 * 0.16×(0.3…1), size 0.6–1.7, px 15, bright 1.25, depth fog, a per-dot
 * twinkle, and the dots parting slightly around the pointer (repel 0.6), all
 * at the scale place() gives the globe's column (~0.64 at 1440×900), at the
 * same density (~58 dots per shape unit²), widened to fill the window. A
 * gentle current streams it past Keys (one world speed for every dot, so
 * near dots pass faster than far ones), and the camera orbits a pivot
 * behind the field toward the pointer, so near dots swing more than far
 * ones. The game's pillars condense out of these same dots: as one scrolls
 * in, a few hundred of them fly together, and where they land its solid body
 * swells up out of a grid of dots until they touch (pillar() in the shader).
 *
 * Rendering: raw WebGL 1, ONE draw call per frame (in the game: two more, the
 * field and the rest being separate, then one per live pillar's body and one
 * for its dots while it forms). Every dot and Keys himself are POINTS in one
 * buffer (Keys is one big point sprite whose fragments evaluate the SDF); the
 * vertex shader places each by group. The buffers are uploaded once.
 * Blending is premultiplied "over": a dot writes alpha = its brightest
 * channel (a valid premultiplied colour, so every compositor draws it the
 * same); Keys writes alpha 1, so he is solid. The canvas is transparent and
 * the page's CSS backdrop shows through, so there is no background pass.
 *
 * 60 fps while something moves fast (the game, transitions, the exit, the
 * pointer easing); 30 fps for the resting swim and current; nothing while
 * the window is hidden (rAF stops). Reduced motion: one still frame,
 * redrawn only on resize — no current, no swim, no pointer, no game.
 *
 * THE FRAME LOOP ALLOCATES NOTHING. Everything frame() and what it calls hold
 * on to between frames is kept here at module level and written in place; no
 * closures, iterators, result objects or typed arrays per frame, and no
 * obj[key] loops over the eased values (a megamorphic keyed load boxes every
 * double it reads, even in optimised code). It used to make ~4 KB of garbage a
 * frame (~8 KB before V8 tiers it up), which filled this worker's ~800 KB young
 * generation every ~3.3 s: a 3-5 ms stop-the-thread scavenge about every OTHER
 * pillar, which is the rhythm players felt. Measured from the MinorGC events'
 * heap sizes in a Chromium trace; loadingScreen.worker.alloc.test.ts holds the line.
 */
import { RunRateCounter, resolvePower, type PowerPreference } from '../utils/firewallRate';
import { newGame, act, quit, step, formation, RULES, keysX, type Game, type StepResult } from '../utils/loadingGame';
import { BOX, SWIM, tiltHomography, tiltToward } from '../utils/keysPose';
import type { ToWorker, FromWorker } from './loadingScreenProtocol';

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

/* ── The dots ─────────────────────────────────────────────────────────────── */

/** Field volume, shape units: wide enough for a 21:9 window plus the camera's orbit. */
const SPAN_X = 6.5, SPAN_Y = 3.6;
const N_FIELD = Math.round(58 * (2 * SPAN_X) * (2 * SPAN_Y)); // ≈ 5,400
const WALL_DOTS = 360;
const N_BURST = 320;
const N_BAR = 120;
const OFF_WALLS = N_FIELD;
const OFF_BURST = OFF_WALLS + RULES.slots * WALL_DOTS;
const OFF_KEYS = OFF_BURST + N_BURST;
const OFF_BAR = OFF_KEYS + 1;
const N = OFF_BAR + N_BAR;
/**
 * Each pillar has a SOLID body: two quads (below and above the gap, 6 vertices each),
 * shared by every pillar and drawn as TRIANGLES from the tail of the same buffers.
 * The pillars used to be dots alone, so on a compositor or display that renders fine
 * dots poorly (macOS reports: "no pillars") the obstacles were invisible while still
 * deadly. The body is a valid premultiplied colour (rgb <= alpha) like everything
 * else, and is what makes a pillar a wall: the dots only carry it in from the field.
 */
const SLAB_V = 12;
const OFF_SLAB = N;
const NV = N + SLAB_V; // vertices in the buffers (N of them are points)
/** How far a pillar's soft glow reaches past its rectangle, in half-widths of the wall. It is light, not wall: the hard edge is the rule's. */
const PILLAR_GLOW = 0.6;

// Per vertex: A = (x, y, z, size), C = (r, g, b, group), S = four seeds.
// Groups: 0 field, 1 crash burst, 2 pillar dots, 10 pillar bodies, 11 Keys, 12 loading bar. (The score is HTML.)
// Written once, here at load, and uploaded once: where a pillar is and where its gap is are plain
// per-draw uniforms (uWallS, uWallG), so a new pillar touches no buffer. Each respawn (every ~1.7 s)
// used to re-send both whole vertex buffers (~285 KB each) over ones in-flight draws were using.
const A = new Float32Array(NV * 4);
const C = new Float32Array(NV * 4);
const S = new Float32Array(NV * 4);

const TEAL = [0.145, 0.878, 0.784];
const ICE = [0.5, 0.78, 1.0];

let rs = 99; // fillAmbient's seed
const rnd = () => ((rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0) / 4294967296);

function setDot(i: number, x: number, y: number, z: number, size: number, c: number[], k: number, g: number) {
    A[i * 4] = x; A[i * 4 + 1] = y; A[i * 4 + 2] = z; A[i * 4 + 3] = size;
    C[i * 4] = c[0] * k; C[i * 4 + 1] = c[1] * k; C[i * 4 + 2] = c[2] * k; C[i * 4 + 3] = g;
}
// The field, as fillAmbient builds it, at the scale place() gave it behind
// the globe, spread wider to fill the whole window.
const SCALE = 0.64;
/**
 * The camera's orbit pivot (world z), a little behind the farthest dot
 * (-1.02): every dot swings the same way, the near ones (z 0.38) ~5x as far
 * on screen as the far ones (3.4x in the world, x1.5 for perspective).
 */
const PIVOT = -1.6;
/** How far the camera orbits toward the pointer (radians at the window edge): ~4 and ~3 degrees. */
const YAW = 0.07, PITCH = 0.05;
/** The resting current (world units/s): the field streams left and a little down. */
const CURRENT_X = 0.1, CURRENT_Y = 0.028;
for (let i = 0; i < N_FIELD; i++) {
    const x = (rnd() * 2 - 1) * SPAN_X, y = (rnd() * 2 - 1) * SPAN_Y, z = -rnd() * 2.2 + 0.6;
    const c = rnd() < 0.5 ? TEAL : ICE;
    setDot(i, x * SCALE, y * SCALE, z * SCALE, 0.6 + rnd() * 1.1, c, 0.16 * (0.3 + rnd() * 0.7), 0);
}
for (let i = 0; i < N; i++) { S[i * 4] = rnd(); S[i * 4 + 1] = rnd(); S[i * 4 + 2] = rnd(); S[i * 4 + 3] = rnd(); }
for (let i = OFF_BURST; i < OFF_KEYS; i++) setDot(i, 0, 0, 0, 0, rnd() < 0.7 ? TEAL : ICE, 0.7 + rnd() * 0.5, 1);
setDot(OFF_KEYS, 0, 0, 0, 0, TEAL, 1, 11);
// A pillar's dots, in normalised space: x -1..1 across the wall, y 0..1 along its two slabs'
// combined length. The vertex shader places them from the plain per-draw uniforms: see uWallG.
for (let i = OFF_WALLS; i < OFF_BURST; i++) {
    const s0 = S[i * 4], s1 = S[i * 4 + 1], s2 = S[i * 4 + 2], s3 = S[i * 4 + 3];
    setDot(i, s0 * 2 - 1, s1, 0, 0.6 + s3 * 0.8, s2 < 0.55 ? TEAL : ICE, 0.42 + s3 * 0.4, 2);
}
// A pillar's body: [below the gap] and [above it], two triangles each, shared by every pillar.
// x -1..1 across the wall, y 0 at the window's edge .. 1 at the gap, z -1 below the gap, +1 above.
for (let q = 0, v = OFF_SLAB; q < 2; q++) {
    for (let j = 0; j < 6; j++, v++) setDot(v, [-1, 1, 1, -1, 1, -1][j], [0, 0, 1, 0, 1, 1][j], q ? 1 : -1, 0, TEAL, 1, 10);
}
for (let i = OFF_BAR; i < N; i++) setDot(i, (i - OFF_BAR) / (N_BAR - 1), 0, 0, 0, TEAL, 1, 12);

/* ── Layout (CSS px; origin at the centre, y up) ──────────────────────────── */

let W = 1, H = 1, dpr = 1, reduced = false;
const U = () => H / 2;
/** Keys' height while waiting: the DOM mark's --lo-k, clamp(72px, 11vh, 132px). */
const idleKeysPx = () => Math.max(72, Math.min(132, H * 0.11));
/** He sits 42% from the top while waiting (CSS: .lo-keys). */
const idleY = () => H * 0.08;
/** Keys' height in the game, in U (his hitbox, RULES.radius, sits inside it). */
const GAME_KEYS_U = 0.2;
/** The field's dot size: the onboarding's px 15, a touch larger (x1.35) here. */
const fieldPx = () => 15 * 1.35 * SCALE * Math.min(W, H) / 900;

/* ── GL ───────────────────────────────────────────────────────────────────── */

const VS = `
attribute vec4 aA; attribute vec4 aC; attribute vec4 aS;
uniform vec2 uRes; uniform float uDpr; uniform float uT;
uniform vec4 uCam;    // yaw, pitch, camera distance, pointer strength
uniform vec3 uMouse;  // pointer in NDC (x, y), repel
uniform vec4 uField;  // twinkle on/off, current x, current y, px
uniform float uBright;
uniform vec4 uKeys;   // centre x, y (px), px per logo unit, alpha
uniform vec4 uBurst;  // centre x, y (px), progress 0..1, alpha
uniform vec3 uWallS;  // the pillar being drawn: x (px), alpha, how formed (0 loose .. 1 solid)
uniform vec3 uWallG;  // ...and its shape: the gap's lo and hi edges (px), half its width (px)
uniform vec4 uBar;    // centre x, y (px), width (px), progress 0..1
uniform vec2 uBarA;   // alpha, shimmer on/off
varying vec3 vC;
varying float vKind;  // 0 a soft dot, 1 Keys, 2 a pillar's body
varying vec2 vP;      // a pillar's body: this fragment, px from the pillar's axis and the window's centre
vec2 dir(float s){ float a = s*6.2831853; return vec2(cos(a), sin(a)); }
void main(){
  float g = aC.w;
  vKind = 0.0;
  vP = vec2(0.0);
  if (g < 0.5) {
    vec3 q = aA.xyz;
    /* the current: one world speed for every dot, so near ones pass faster */
    vec2 span = vec2(${(SPAN_X * 2 * SCALE).toFixed(3)}, ${(SPAN_Y * 2 * SCALE).toFixed(3)});
    q.xy = mod(q.xy - uField.yz + span*0.5, span) - span*0.5;
    q += vec3(sin(uT*0.9 + aS.z*40.0), cos(uT*0.7 + aS.z*23.0), sin(uT*0.6 + aS.z*11.0))*${(0.006 * SCALE).toFixed(4)}*uField.x;
    /* the camera orbits a pivot BEHIND the whole field, so every dot swings
       the same way and the nearer it is, the further it swings: parallax */
    q.z -= ${PIVOT.toFixed(2)};
    float cy = cos(uCam.x), sy = sin(uCam.x);
    q = vec3(cy*q.x + sy*q.z, q.y, -sy*q.x + cy*q.z);
    float cp = cos(uCam.y), sp = sin(uCam.y);
    q = vec3(q.x, cp*q.y - sp*q.z, sp*q.y + cp*q.z);
    q.z += ${PIVOT.toFixed(2)};
    float z = uCam.z - q.z;
    float asp = uRes.x/uRes.y;
    vec2 ndc = vec2(q.x*2.2/asp, q.y*2.2)/max(z, 0.05);
    vec2 dm = (ndc - uMouse.xy)*vec2(asp, 1.0);
    float dl = length(dm);
    ndc += dm/max(dl, 0.001)*vec2(1.0/asp, 1.0)*uCam.w*uMouse.z*0.07*(1.0 - smoothstep(0.0, 0.3, dl));
    float fog = clamp(1.55 - z*0.2, 0.25, 1.0);
    float tw = 0.85 + 0.15*sin(uT*2.0 + aS.z*60.0)*uField.x;
    float a = smoothstep(0.15, 0.7, z); // passing the camera in the exit's dolly
    gl_Position = a < 0.003 ? vec4(2.0, 2.0, 0.0, 1.0) : vec4(ndc, 0.0, 1.0);
    gl_PointSize = max(1.0, min(uField.w*aA.w/max(z, 0.05), 48.0)*uDpr);
    vC = aC.rgb*fog*tw*uBright*a;
    return;
  }
  vec2 p; float size; float a; vec3 c = aC.rgb;
  if (g > 10.5 && g < 11.5) {
    /* Keys: one big sprite; the fragment shader draws him */
    p = uKeys.xy; size = ${BOX.toFixed(1)}*uKeys.z; a = uKeys.w; vKind = 1.0;
  } else if (g < 1.5) {
    /* the crash: Keys bursts into the field's dots */
    float k = uBurst.z;
    p = uBurst.xy + dir(aS.x)*(1.0 - pow(1.0 - k, 3.0))*(25.0 + aS.y*120.0)*uKeys.z/1.6;
    size = 2.4 + aS.z*2.4; a = uBurst.w*(1.0 - k);
  } else if (g < 9.5) {
    vec2 w = uWallS.xy;
    /* where this dot settles: the wall's two slabs, each running off its edge of
       the window (exactly the rectangles the rules collide with, utils/loadingGame.ts
       hitsWall: a slab is open-ended), a little past the window's edges */
    float edge1 = uRes.y*0.52, hLo = uWallG.x + edge1, hHi = edge1 - uWallG.y, y;
    float pick = aA.y*(hLo + hHi);
    y = pick < hLo ? pick - edge1 : uWallG.y + pick - hLo;
    /* the pillar builds out of the field as it scrolls: each dot flies in
       from somewhere around it, on its own schedule, and settles */
    float l = clamp((uWallS.z - aS.w*0.45)/0.55, 0.0, 1.0);
    l = l*l*(3.0 - 2.0*l);
    vec2 loose = dir(aS.x)*(0.25 + aS.y*0.75)*uRes.y*0.32 + vec2(sin(uT*0.8 + aS.z*30.0), cos(uT*0.6 + aS.z*17.0))*6.0;
    p = vec2(aA.x*uWallG.z + w.x, y) + loose*(1.0 - l);
    size = aA.w*uField.w/3.2*(0.75 + 0.25*l); // a field dot at mid depth
    /* field-dim while loose, brighter as it flies in, absorbed by the body as it lands */
    a = w.y*mix(0.3, 1.0, l)*(1.0 - smoothstep(0.72, 1.0, l))*(0.85 + 0.15*sin(uT*2.0 + aS.z*60.0));
  } else if (g > 9.5 && g < 10.5) {
    /* a pillar's body: the rectangle the rules collide with, plus a margin for
       its glow; the fragment shader lights it (nothing at all until it starts forming) */
    float m = uWallG.z*${PILLAR_GLOW.toFixed(2)};
    vP = vec2(aA.x*(uWallG.z + m), mix(aA.z*uRes.y*0.52, (aA.z > 0.0 ? uWallG.y : uWallG.x) - aA.z*m, aA.y));
    p = vec2(vP.x + uWallS.x, vP.y);
    a = uWallS.y*step(0.001, uWallS.z);
    size = 0.0; vKind = 2.0;
  } else if (g > 11.5) {
    /* the loading bar: a line of fine dots; the filled part glows, with a
       soft shimmer running along it */
    float f = aA.x;
    p = vec2(uBar.x + (f - 0.5)*uBar.z, uBar.y);
    float lit = smoothstep(uBar.w + 0.004, uBar.w - 0.004, f);
    float sh = uBarA.y*exp(-pow((f - fract(uT/1.8)*1.3 + 0.15)*9.0, 2.0));
    float head = exp(-pow((f - uBar.w)*60.0, 2.0))*step(0.002, uBar.w);
    a = uBarA.x*(0.3 + lit*(0.75 + 0.6*sh) + head*0.6);
    size = 3.4 + lit*0.8 + head*2.6;
    c = mix(vec3(0.5, 0.78, 1.0), vec3(0.145, 0.878, 0.784), 0.4 + 0.6*lit);
  } else {
    p = vec2(0.0); size = 0.0; a = 0.0;
  }
  gl_Position = a < 0.003 ? vec4(2.0, 2.0, 0.0, 1.0) : vec4(p/(uRes*0.5), 0.0, 1.0);
  gl_PointSize = max(1.0, size*uDpr);
  vC = c*a;
}`;

const FS = `
precision highp float;
varying vec3 vC;
varying float vKind;
varying vec2 vP;
uniform vec3 uWallS;  // the pillar being drawn: x (px), alpha, how formed (0 loose .. 1 solid)
uniform vec3 uWallG;  // ...and its shape: the gap's lo and hi edges (px), half its width (px)
uniform vec4 uKeys;   // .z = px per logo unit, .w = alpha
uniform vec4 uSwim;   // seconds into the stroke, fall pose 0..1
uniform mat3 uTilt;   // sprite offset -> his own plane (keysPose.tiltHomography)
uniform float uDpr;
uniform float uT;
float sdCapsule(vec2 p, vec2 a, vec2 b, float r){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba)/dot(ba, ba), 0.0, 1.0); return length(pa - ba*h) - r; }
float sdBox(vec2 p, vec2 c, vec2 h){ vec2 d = abs(p - c) - h; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float brow(vec2 p, float bx){
  float d = sdCapsule(p, vec2(bx, 40.0), vec2(bx + 3.75, 35.0), 1.75);
  d = min(d, sdCapsule(p, vec2(bx + 3.75, 35.0), vec2(bx + 7.5, 40.0), 1.75));
  d = min(d, sdCapsule(p, vec2(bx + 7.5, 40.0), vec2(bx + 11.25, 35.0), 1.75));
  return min(d, sdCapsule(p, vec2(bx + 11.25, 35.0), vec2(bx + 15.0, 40.0), 1.75));
}
/* The stroke's envelope at t seconds: a quick 0.35 s contraction (fast in,
   eased at the top), then a slow 1.4 s relax. 0 = relaxed, 1 = contracted. */
float stroke(float t){
  if (t <= 0.0) return 0.0;
  if (t < 0.35) { float x = t/0.35; return 1.0 - (1.0 - x)*(1.0 - x); }
  float x = clamp((t - 0.35)/1.4, 0.0, 1.0);
  return 1.0 - x*x*(3.0 - 2.0*x);
}
float leg(vec2 p, float lx, float i, float sx){
  float cx = 55.0 + (lx - 55.0)*sx;
  float v = clamp((p.y - 48.0)/30.0, 0.0, 1.0);
  /* each leg a few frames behind the one before it, and each tip behind its root */
  float c = stroke(uSwim.x - i*0.045 - v*0.09);
  float side = (lx - 55.0)/26.0;            // -1 (left) .. 1 (right)
  float fall = uSwim.y;
  /* relaxed: a gentle spread; contracted: drawn together; sinking: splayed */
  float spread = side*(${SWIM.relaxSpread.toFixed(3)}*(1.0 - c) - ${SWIM.contractIn.toFixed(3)}*c + ${SWIM.fallSpread.toFixed(3)}*fall);
  float wave = sin(uT*2.1 - i*0.9 - v*2.2)*${SWIM.wave.toFixed(3)}*(1.0 - c);
  float shift = (spread + wave)*v*v;
  /* contracted: they push down (longer); sinking: the tips drift up (shorter) */
  float len = 1.0 + ${SWIM.push.toFixed(3)}*c - ${SWIM.relaxShort.toFixed(3)}*(1.0 - c) - ${SWIM.fallShort.toFixed(3)}*fall;
  vec2 q = vec2(p.x - shift, 48.0 + (p.y - 48.0)/len);
  return sdCapsule(q, vec2(cx, 50.5), vec2(cx, 71.5), 6.5);
}
float cellHash(vec2 c){ vec3 q = fract(c.xyx*0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y)*q.z); }
/* A pillar's body. In px: dx is how far inside its long edges, along how far
   past its gap edge (negative in the gap), both exactly the rules' rectangle.
   While it forms it condenses: a grid of dots that swell until they touch,
   from the gap outward, so the opening reads first. Once formed it is a force
   field: a dark body with its light in its edges, two rails and a blazing cap at
   the gap with light pooling behind it, all inside that rectangle; only the glow
   leaves it. */
vec4 pillar(){
  vec2 p = vP;
  float hw = uWallG.z;
  float along = abs(p.y - (uWallG.x + uWallG.y)*0.5) - (uWallG.y - uWallG.x)*0.5;
  float dx = hw - abs(p.x);
  float cover = clamp(min(dx, along)*uDpr + 0.5, 0.0, 1.0);
  float z = uWallS.z;
  float g = exp(-max(along, 0.0)/(hw*5.5)); // brightest at the gap, falling off along the pillar
  /* the glow: light outside the rectangle (and under its antialiased edge), never wall */
  float halo = 0.0;
  if (cover < 1.0 || z < 1.0) {
    halo = max(1.0 - length(max(vec2(-dx, -along), 0.0))/(hw*${PILLAR_GLOW.toFixed(2)}), 0.0);
    halo = halo*halo*(0.06 + 0.30*g)*smoothstep(0.55, 1.0, z);
  }
  if (cover <= 0.0) return vec4(vec3(0.145, 0.878, 0.784)*halo, 0.878*halo)*uWallS.y; // half this quad is only glow: keep it cheap
  float grid = 1.0; // how much of this fragment the forming dots cover (1 once formed)
  if (z < 1.0) {
    float pitch = hw*0.2;
    vec2 cell = floor(p/pitch);
    float start = 0.18 + cellHash(cell)*0.3 + 0.32*min(1.0, along/(hw*12.0));
    grid = clamp((clamp((z - start)/(1.0 - start), 0.0, 1.0)*0.85 - length(p/pitch - cell - 0.5))*pitch*uDpr + 0.5, 0.0, 1.0);
  }
  float rail = exp(-dx/(hw*0.06));
  float bloom = exp(-dx/(hw*0.36));
  float tip = exp(-max(along - hw*0.03, 0.0)/(hw*0.075));
  float pool = exp(-max(along, 0.0)/(hw*1.7));
  vec3 teal = vec3(0.145, 0.878, 0.784);
  vec3 col = vec3(0.024, 0.098, 0.140) + teal*(0.045 + 0.20*bloom*(0.30 + 0.70*g) + 0.44*pool);
  col = mix(col, teal, rail*(0.42 + 0.58*g));
  col = mix(col, vec3(0.74, 0.95, 1.00), tip);
  float op = max(0.80, max(rail, tip));
  float ca = cover*grid*op;
  /* The glow never lights the wall itself. Under the antialiased edge it shows
     through whatever the edge leaves uncovered; inside the rectangle it only
     shows BETWEEN the forming dots and is gone exactly where (and when) they
     cover it, so it reaches 0 inside by z = 1, matching the formed body (which
     works out no glow inside at all, above). It used to show through the body's
     20% translucency as well: the whole pillar then stepped ~13% darker on the
     frame it finished forming. */
  halo *= cover < 1.0 ? 1.0 - ca : 1.0 - grid;
  /* premultiplied, rgb <= alpha: col is at most 1, and teal's brightest channel is its green */
  return vec4(min(col, vec3(1.0))*ca + vec3(0.145, 0.878, 0.784)*halo, ca + 0.878*halo)*uWallS.y;
}
void main(){
  if (vKind > 1.5) { gl_FragColor = pillar(); return; }
  vec2 pc = gl_PointCoord*2.0 - 1.0;
  if (vKind < 0.5) {
    float r2 = dot(pc, pc);
    if (r2 > 1.0) discard;
    float a = exp(-r2*3.2)*0.55 + exp(-r2*16.0)*0.9;
    /* A VALID premultiplied colour (rgb <= alpha). These dots used to write alpha 0
       with rgb > 0 ("adds light"), which premultipliedAlpha:true leaves undefined:
       Windows' compositor happened to add it; macOS' drops it, so every dot (the
       pillars, the field) vanished and only the solid Keys showed. Alpha = the
       brightest channel makes it a plain "over" that looks the same on this
       dark backdrop (it differs from adding by alpha*backdrop, a few percent). */
    vec3 rgb = min(vC*a, vec3(1.0));
    gl_FragColor = vec4(rgb, max(rgb.r, max(rgb.g, rgb.b)));
    return;
  }
  /* Keys, in the logo's own units (SVG space: y down; gl_PointCoord's
     origin is the top-left), always upright. The perspective tilt toward
     the pointer is a homography computed and tested in utils/keysPose.ts:
     which point of him is under this pixel. */
  vec3 h = uTilt*vec3(pc*${(BOX / 2).toFixed(1)}, 1.0);
  vec2 p = h.xy/h.z + vec2(55.0, 46.0);
  /* the bell narrows on the contraction */
  float cb = stroke(uSwim.x);
  float sx = 1.0 - ${SWIM.bellX.toFixed(3)}*cb, sy = 1.0 + ${SWIM.bellY.toFixed(3)}*cb;
  vec2 pd = vec2(55.0, 48.0) + (p - vec2(55.0, 48.0))/vec2(sx, sy);
  /* dome (y <= 48) and band (48..53) overlap by a hair: two SDFs that only
     touch along a line would leave a half-covered seam there */
  float dome = max(length(pd - vec2(55.0, 48.0)) - 34.0, pd.y - 48.6);
  float band = sdBox(pd, vec2(55.0, 50.2), vec2(34.0, 2.8));
  float body = min(dome, band);
  body = min(body, leg(p, 29.0, 0.0, sx));
  body = min(body, leg(p, 46.3, 1.0, sx));
  body = min(body, leg(p, 63.6, 2.0, sx));
  body = min(body, leg(p, 80.9, 3.0, sx));
  float brows = min(brow(pd, 33.5), brow(pd, 61.5));
  /* one device pixel, in logo units: coverage ramps across exactly one pixel
     (a narrower ramp leaves most edge pixels all-or-nothing: stair steps) */
  float aa = 1.0/(uKeys.z*uDpr);
  float cover = clamp(0.5 - body/aa, 0.0, 1.0);
  if (cover <= 0.0) discard;
  float dark = clamp(0.5 - brows/aa, 0.0, 1.0);
  vec3 col = mix(vec3(0.1451, 0.8784, 0.7843), vec3(0.0431, 0.0588, 0.1176), dark);
  float a = cover*uKeys.w;
  gl_FragColor = vec4(col*a, a); // premultiplied, solid
}`;

interface Gl {
    gl: WebGLRenderingContext;
    canvas: OffscreenCanvas;
    u: Record<string, WebGLUniformLocation | null>;
    maxPoint: number;
}
let G: Gl | null = null;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
    return s;
}

function setupGl(canvas: OffscreenCanvas, power: PowerPreference): Gl | null {
    const gl = canvas.getContext('webgl', {
        alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
        preserveDrawingBuffer: false, powerPreference: power,
    }) as WebGLRenderingContext | null;
    if (!gl) return null;
    try {
        const prog = gl.createProgram()!;
        gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
        gl.useProgram(prog);
        const u: Gl['u'] = {};
        for (const n of ['uRes', 'uDpr', 'uT', 'uCam', 'uMouse', 'uField', 'uBright', 'uKeys', 'uBurst', 'uSwim', 'uTilt', 'uWallS', 'uWallG', 'uBar', 'uBarA']) u[n] = gl.getUniformLocation(prog, n);
        // Uploaded once, here, and never touched again: a mid-game bufferSubData on a buffer
        // the GPU may still be reading is exactly what a frame cannot afford (see uWallG).
        const buffer = (name: string, data: Float32Array) => {
            const loc = gl.getAttribLocation(prog, name);
            gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
            gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 0, 0);
        };
        buffer('aA', A);
        buffer('aC', C);
        buffer('aS', S);
        gl.enable(gl.BLEND);
        // Premultiplied "over": every dot carries alpha = its brightest channel (see the fragment shader); Keys (alpha 1) covers.
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);
        gl.clearColor(0, 0, 0, 0);
        const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null;
        // A real loss of the CURRENT context means no WebGL: fall back. But we
        // also lose contexts on purpose (the handoff's 'init' on a new canvas,
        // 'detach'), and that event arrives later, after G has moved on — so
        // only a loss on the canvas we are drawing to right now counts.
        canvas.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
            if (!G || G.canvas !== canvas) return;
            G = null;
            post({ type: 'nogl' });
        });
        return { gl, canvas, u, maxPoint: range ? range[1] : 64 };
    } catch {
        return null;
    }
}

let renderDpr = 1;
function sizeCanvas() {
    if (!G) return;
    // Draw at the display's own resolution (up to DPR 2), so Keys' edges are
    // as crisp as the DOM's; only a huge window (> ~6.5 MP of backing store)
    // drops below that, and then only as far as it must.
    let d = Math.min(2, dpr);
    const cap = 6_500_000;
    if (W * H * d * d > cap) d = Math.sqrt(cap / (W * H));
    G.canvas.width = Math.max(1, Math.round(W * d));
    G.canvas.height = Math.max(1, Math.round(H * d));
    G.gl.viewport(0, 0, G.canvas.width, G.canvas.height);
    renderDpr = d;
}

/* ── State ────────────────────────────────────────────────────────────────── */

const game: Game = newGame(0, (Date.now() & 0xffff) || 1);
let t = 0; // scene clock (s)
let exiting = false;
let exitK = 0;
/** Keys is drawn unless the host asked for the field alone ('keys' message, or lock mode). */
let keysVisible = true;
/** 'lock': the dot field alone (lock screen backdrop) — no Keys, no bar, no game. Set at init. */
let lockMode = false;
let lastTs = 0, lastDraw = 0, raf = 0, sentOk = false;
/** Everything that eases. */
const eased = () => ({ cx: 0, cy: 0, k: 1, walls: 0, game: 0, burst: 0, mx: 0, my: 0, mz: 0, vx: CURRENT_X, vy: CURRENT_Y, tx: 0, ty: 0 });
const smooth = eased();
const pointer = { x: 0, y: 0, on: 0 };
let scrollX = 0, scrollY = 0;
/** Keys' swim: seconds into the current stroke. Resting: a stroke every STROKE_S (0.35 s in, 1.4 s out, a beat of glide). */
const STROKE_S = 2.2;
let strokeT = 0;
/** His vertical speed in the game, smoothed: the pose blends from it, never snaps. */
let vySmooth = 0;
/** The loading bar: where (from the DOM slot), what is known, and what it shows. */
const bar = { x: 0, y: 0, w: 0, floor: 0, ceil: 0.18, done: false, since: 0, shown: 0 };
const burstAt = { x: 0, y: 0 };
/** frame()'s reused results: see "THE FRAME LOOP ALLOCATES NOTHING". */
const stepResult: StepResult = { scored: false, died: false, respawned: [] };
const tiltNow = { ax: 0, ay: 0 };
const tiltMatrix = new Float32Array(9);
const stats = { frames: 0, busyMs: 0, since: performance.now() };
/**
 * For components/firewallHitchProbe.ts: during a run, report each late frame and
 * each pillar's entry onto the screen, so a hitch can be laid against what the
 * main thread was doing at that moment. Off unless the overlay asks for it at
 * init, which it does only in dev and staging builds (hitchProbeEnabled). Off,
 * it costs one boolean test a frame; on, it never posts on an on-time frame.
 */
let probeOn = false;
let probeLast = 0, probeBusy = 0, probeIv = 1000 / 60, probeK = 0, probeRun = false;
/** The run's own draw rate (utils/firewallRate.ts): the late-frame test cannot see a steady low rate. */
const probeRate = new RunRateCounter();
function glRenderer(): string {
    if (!G) return '';
    try {
        const ext = G.gl.getExtension('WEBGL_debug_renderer_info');
        const r = ext ? String(G.gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(G.gl.getParameter(G.gl.RENDERER));
        const pp = (G.gl.getContextAttributes() as { powerPreference?: string } | null)?.powerPreference ?? '?';
        return `${r} (powerPreference ${pp})`;
    } catch { return ''; }
}
const probePrevX = new Float64Array(RULES.slots);
function probeFrame(ts: number) {
    const playing = game.mode === 'playing';
    if (playing && !probeRun) { probeK = 0; probePrevX.fill(-1e9); probeRate.reset(); }
    if (!playing && probeRun) {
        const r = probeRate.result();
        if (r) post({ type: 'probe', kind: 'rate', frames: r.frames, ms: r.ms, fps: r.fps, busyAvgMs: r.busyAvgMs, maxGapMs: r.maxGapMs, gl: glRenderer() });
        probeRate.reset();
    }
    if (playing) probeRate.frame(ts, probeBusy);
    probeRun = playing;
    if (playing && probeLast) {
        const gap = ts - probeLast;
        if (gap > Math.max(probeIv * 1.6, probeIv + 6)) {
            post({ type: 'probe', kind: 'gap', at: performance.timeOrigin + ts, gap, js: probeBusy, score: game.score, k: probeK });
        } else probeIv += (gap - probeIv) * 0.05; // the display's own interval, learned from on-time frames
    }
    probeLast = playing ? ts : 0;
}
function probeWalls(ts: number) {
    if (!probeRun) return;
    const edge = W / H + RULES.wallW / 2, walls = game.walls;
    for (let i = 0; i < walls.length; i++) {
        const w = walls[i], prev = probePrevX[i];
        probePrevX[i] = w.live ? w.x : -1e9;
        if (w.live && prev > edge && w.x <= edge) {
            post({ type: 'probe', kind: 'pillar', at: performance.timeOrigin + ts, k: ++probeK, slot: i, score: game.score });
        }
    }
}
const CAM = 3.2;

/** Where everything is easing to this frame. One object, rewritten by targets(): it runs every frame. */
const tgNow = eased();
function targets() {
    const u = U();
    const inGame = game.mode !== 'idle';
    const tg = tgNow;
    tg.cx = inGame ? keysX(W / H) * u : 0;
    tg.cy = inGame ? game.y * u : idleY();
    tg.k = (inGame ? GAME_KEYS_U * u : idleKeysPx()) / 64;
    tg.walls = inGame ? 1 : 0;
    tg.game = inGame ? 1 : 0;
    tg.burst = game.mode === 'over' ? 1 : 0;
    tg.mx = pointer.x; tg.my = pointer.y; tg.mz = pointer.on;
    // Keys turns to face the pointer (only while waiting): tx follows its y, ty its x
    tg.tx = inGame ? 0 : pointer.on * pointer.y;
    tg.ty = inGame ? 0 : pointer.on * pointer.x;
    // the current speeds up into the playfield, and stalls on a crash
    tg.vx = game.mode === 'playing' ? 0.35 + 0.5 * game.speed : game.mode === 'over' ? 0.02 : CURRENT_X;
    tg.vy = game.mode === 'idle' ? CURRENT_Y : 0;
    return tg;
}
type Key = keyof typeof smooth;
const RATES: Record<Key, number> = {
    cx: 5, cy: 5, k: 5, walls: 5, game: 4, burst: 2.2, mx: 3.2, my: 3.2, mz: 3, vx: 2.2, vy: 2.2, tx: 4, ty: 4,
};
const EPS: Record<Key, number> = {
    cx: 0.3, cy: 0.3, k: 0.002, walls: 0.01, game: 0.005, burst: 0.005, mx: 0.002, my: 0.002, mz: 0.005, vx: 0.002, vy: 0.002, tx: 0.002, ty: 0.002,
};
const KEYS_ = Object.keys(smooth) as Key[];

const ease = (v: number, target: number, rate: number, eps: number, dt: number) => {
    const d = target - v;
    return Math.abs(d) < eps ? target : v + d * (1 - Math.exp(-dt * rate));
};
/** Field by field, in this order, on purpose: see "THE FRAME LOOP ALLOCATES NOTHING". */
function approach(dt: number, tg: ReturnType<typeof targets>, s = smooth) {
    const R = RATES, E = EPS;
    s.cx = ease(s.cx, tg.cx, R.cx, E.cx, dt);
    s.cy = game.mode === 'playing' && s.game > 0.98 ? tg.cy : ease(s.cy, tg.cy, R.cy, E.cy, dt);
    s.k = ease(s.k, tg.k, R.k, E.k, dt);
    s.walls = ease(s.walls, tg.walls, R.walls, E.walls, dt);
    s.game = ease(s.game, tg.game, R.game, E.game, dt);
    s.burst = game.mode !== 'over' ? 0 : ease(s.burst, tg.burst, R.burst, E.burst, dt);
    s.mx = ease(s.mx, tg.mx, R.mx, E.mx, dt);
    s.my = ease(s.my, tg.my, R.my, E.my, dt);
    s.mz = ease(s.mz, tg.mz, R.mz, E.mz, dt);
    s.vx = ease(s.vx, tg.vx, R.vx, E.vx, dt);
    s.vy = ease(s.vy, tg.vy, R.vy, E.vy, dt);
    s.tx = ease(s.tx, tg.tx, R.tx, E.tx, dt);
    s.ty = ease(s.ty, tg.ty, R.ty, E.ty, dt);
}
const settling = (tg: ReturnType<typeof targets>) => KEYS_.some(k => Math.abs(tg[k] - smooth[k]) > EPS[k]);

function sendGame() { post({ type: 'game', mode: game.mode, score: game.score, best: game.best, runMs: Math.round(game.runT * 1000) }); }


const easeOut = (x: number) => 1 - (1 - x) ** 3;
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
/** The lift over one resting stroke: up with the thrust (0.45 s), then a slow glide down. */
function lift(t: number) {
    return t < 0.45 ? easeOut(t / 0.45) : 1 - easeInOut(Math.min(1, (t - 0.45) / (STROKE_S - 0.45)));
}
/** The bar's honest creep: from floor toward ceil, slowing, never arriving. */
function barGoal(now: number) {
    if (bar.done) return 1;
    const k = 1 - Math.exp(-(now - bar.since) / 3.5);
    return bar.floor + (bar.ceil - bar.floor) * 0.97 * k;
}

function frame(ts: number) {
    raf = 0;
    if (!G) return;
    const t0 = performance.now();
    const dt = lastTs ? Math.min(1 / 20, (ts - lastTs) / 1000) : 1 / 60;
    const tg = targets();
    const fast = !reduced && (game.mode === 'playing' || exiting || (game.mode === 'over' && game.t < 1.2) || settling(tg) || (bar.done && bar.shown < 0.999));
    // 30 fps for the resting swim and current.
    if (!fast && sentOk && !reduced && ts - lastDraw < 30) { schedule(); return; }
    if (probeOn) probeFrame(ts);
    lastTs = ts; lastDraw = ts;
    if (!reduced) t += dt;

    if (game.mode !== 'idle') {
        // Fixed sub-steps so a fast wall can't tunnel through Keys.
        let left = dt;
        while (left > 1e-6) {
            const h = Math.min(left, 1 / 120);
            const r = step(game, h, W / H, stepResult);
            if (r.scored) sendGame();
            if (r.died) { sendGame(); burstAt.x = smooth.cx; burstAt.y = game.y * U(); }
            left -= h;
        }
    }
    if (probeOn) probeWalls(ts);
    if (reduced) Object.assign(smooth, tg, { mx: 0, my: 0, mz: 0, vx: 0, vy: 0 });
    else approach(dt, tg);
    scrollX += smooth.vx * dt;
    scrollY += smooth.vy * dt;
    if (exiting) exitK = Math.min(1, exitK + dt / 0.56);
    // Resting, he strokes every STROKE_S; in the game, only when told to.
    if (!reduced) {
        strokeT += dt;
        if (game.mode === 'idle' && strokeT >= STROKE_S) strokeT -= STROKE_S;
    }
    vySmooth += ((game.mode === 'playing' ? game.vy : 0) - vySmooth) * (1 - Math.exp(-dt * 8));
    // The bar: monotonic, eased; only `done` reaches the end.
    const goal = barGoal(t);
    bar.shown = reduced ? Math.max(bar.shown, goal) : Math.max(bar.shown, bar.shown + (goal - bar.shown) * (1 - Math.exp(-dt * (bar.done ? 14 : 3))));

    const { gl, u } = G;
    const follow = 1 - smooth.game; // the camera straightens up for the game
    const dolly = exitK * exitK * 2.9; // ease-in: rushes forward through the field
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(u.uRes, W, H);
    gl.uniform1f(u.uDpr, renderDpr);
    gl.uniform1f(u.uT, t);
    gl.uniform4f(u.uCam, smooth.mx * YAW * follow, -smooth.my * PITCH * follow, CAM - dolly, smooth.mz * follow);
    gl.uniform3f(u.uMouse, smooth.mx, smooth.my, 0.6);
    gl.uniform4f(u.uField, reduced ? 0 : 1, scrollX, scrollY, fieldPx());
    gl.uniform1f(u.uBright, 1.25 * (1 + exitK));

    // Keys: the swim (bob + stroke), the tilt, the crash, the exit swell.
    const keysPx = smooth.k * 64;
    const bob = reduced ? 0 : (lift(Math.min(strokeT, STROKE_S)) - 0.5) * keysPx * 0.08 * (1 - smooth.game);
    // a small parallax against the field: he sits nearer than any dot
    const parX = smooth.mx * smooth.mz * 7 * (1 - smooth.game), parY = smooth.my * smooth.mz * 5 * (1 - smooth.game);
    let ppu = smooth.k * (1 + 0.22 * easeInOut(Math.min(1, exitK / 0.86)));
    if (BOX * ppu * renderDpr > G.maxPoint) ppu = G.maxPoint / (BOX * renderDpr); // a tiny GL point limit: shrink, never clip
    const keysA = keysVisible ? (1 - smooth.burst) * (1 - easeInOut(Math.min(1, exitK / 0.86))) : 0;
    gl.uniform4f(u.uKeys, smooth.cx + parX, smooth.cy + bob + parY, ppu, keysA);
    // Sinking in the game: the legs drift up and spread, in step with his speed.
    const fall = Math.max(0, Math.min(1, -vySmooth / 1.2)) * smooth.game;
    gl.uniform4f(u.uSwim, reduced ? 9 : strokeT, fall, 0, 0);
    // Facing the pointer (eased; upright in the game, in reduced motion, and when the pointer leaves).
    const tilt = tiltToward(smooth.ty, smooth.tx, reduced ? 0 : 1 - smooth.game, tiltNow);
    gl.uniformMatrix3fv(u.uTilt, false, tiltHomography(tilt.ax, tilt.ay, tiltMatrix));
    gl.uniform4f(u.uBar, bar.x, bar.y, bar.w, bar.shown);
    gl.uniform2f(u.uBarA, bar.w > 0 && !lockMode ? (1 - smooth.game) : 0, reduced ? 0 : 1);
    gl.uniform4f(u.uBurst, burstAt.x, burstAt.y, smooth.burst, game.mode === 'over' ? 1 : 0);

    // The pillars: one draw per live pillar, each with its own plain uniform
    // (see uWallS in the shader). Never a uniform ARRAY indexed by a per-vertex
    // value: on macOS (ANGLE over Metal) that drew no pillars at all. Its gap comes
    // the same way (uWallG), so a pillar respawning costs the GPU nothing extra.
    const walls = game.walls;
    let anyLive = false;
    for (let i = 0; i < walls.length && !anyLive; i++) anyLive = walls[i].live;
    if (anyLive) {
        const unit = U(), halfW = W / H, wallA = smooth.walls * (1 - exitK);
        gl.drawArrays(gl.POINTS, 0, OFF_WALLS);
        for (let i = 0; i < walls.length; i++) {
            const w = walls[i];
            if (!w.live) continue;
            const formed = reduced ? 1 : formation(w.x, halfW, game.score);
            gl.uniform3f(u.uWallS, w.x * unit, wallA, formed);
            gl.uniform3f(u.uWallG, (w.gap - w.gapH / 2) * unit, (w.gap + w.gapH / 2) * unit, (RULES.wallW / 2) * unit);
            gl.drawArrays(gl.TRIANGLES, OFF_SLAB, SLAB_V); // the body, under its dots
            if (formed < 1) gl.drawArrays(gl.POINTS, OFF_WALLS + i * WALL_DOTS, WALL_DOTS); // all landed: none left to draw
        }
        gl.drawArrays(gl.POINTS, OFF_BURST, N - OFF_BURST);
    } else {
        gl.uniform3f(u.uWallS, 0, 0, 0); // no pillars: their dots all cull (alpha 0)
        gl.drawArrays(gl.POINTS, 0, N);
    }

    stats.frames++;
    stats.busyMs += performance.now() - t0;
    if (probeOn) probeBusy = performance.now() - t0;
    if (!sentOk) { sentOk = true; post({ type: 'ok' }); }
    if (reduced) return; // one still frame; redrawn on resize only
    if (exiting && exitK >= 1) return; // the last frame of the exit: stop.
    schedule();
}

/**
 * Each open of the game is a NEW worker, so its first ~10 s run in the interpreter,
 * where every double is a heap allocation (~8 KB a frame, and a scavenge every other
 * pillar again) until V8 tiers the code up. Tier the hot rules up before the first
 * frame instead: they run here on a throwaway game for a few ms of this thread, off
 * any frame, and never touch the real game's state.
 */
let warmed = false;
function warmUp() {
    if (warmed) return;
    warmed = true;
    const g = newGame(0, 1), r: StepResult = { scored: false, died: false, respawned: [] }, tilt = { ax: 0, ay: 0 }, m = new Float32Array(9);
    const s = eased(), tg = eased();
    const halfW = W / H;
    let sink = 0;
    for (let i = 0; i < 4000; i++) {
        if (g.mode !== 'playing') act(g, halfW, 0);
        g.y = 0.5 * Math.sin(i * 0.02); g.vy = 0; // alive and moving, whatever the gaps do
        g.walls[i % RULES.slots].gap = g.y;
        step(g, 1 / 120, halfW, r);
        sink += formation(g.walls[i % RULES.slots].x, halfW, i % 30) + easeOut((i % 10) / 10) + easeInOut((i % 10) / 10) + lift((i % 20) / 10) + barGoal(i);
        tiltToward(i % 3, 0.5, 1, tilt);
        tiltHomography(tilt.ax, tilt.ay, m);
        tg.cx = tg.cy = tg.game = tg.vx = (i % 7) * 40;
        approach(1 / 60, tg, s);
    }
    return sink;
}

const hasRaf = typeof requestAnimationFrame === 'function';
function schedule() {
    if (raf || !G) return;
    raf = hasRaf ? requestAnimationFrame(frame) : (setTimeout(() => frame(performance.now()), 16) as unknown as number);
}
function unschedule() {
    if (!raf) return;
    if (hasRaf) cancelAnimationFrame(raf); else clearTimeout(raf);
    raf = 0;
}

let placed = false;

self.onmessage = (e: MessageEvent<ToWorker>) => {
    const m = e.data;
    switch (m.type) {
        case 'init': {
            unschedule();
            // A new canvas (the handoff remount): let go of the old context.
            if (G) { G.gl.getExtension('WEBGL_lose_context')?.loseContext(); G = null; }
            W = m.w; H = m.h; dpr = m.dpr; reduced = m.reduced;
            probeOn = !!m.probe;
            lockMode = m.mode === 'lock';
            keysVisible = !lockMode; // a boot init starts with Keys on, whatever this worker did before
            if (lockMode) {
                // The field alone, from the very first frame: no Keys, no bar
                // (bar.w = 0 is what hides it), whatever this worker did before.
                bar.x = 0; bar.y = 0; bar.w = 0; bar.shown = 0; bar.done = false;
            }
            if (game.best < m.best) game.best = m.best;
            G = setupGl(m.canvas, resolvePower(m.power));
            if (!G) { post({ type: 'nogl' }); return; }
            sizeCanvas();
            if (!placed) { placed = true; Object.assign(smooth, targets()); }
            if (!lockMode && !reduced) warmUp();
            sentOk = false;
            lastTs = 0;
            schedule();
            break;
        }
        case 'resize': {
            W = m.w; H = m.h; dpr = m.dpr;
            sizeCanvas();
            schedule();
            break;
        }
        case 'pointer': {
            if (reduced) return;
            pointer.x = Math.max(-1, Math.min(1, m.x));
            pointer.y = Math.max(-1, Math.min(1, m.y));
            pointer.on = m.on ? 1 : 0;
            schedule();
            break;
        }
        case 'bar': {
            if (lockMode) return;
            bar.x = m.x; bar.y = m.y; bar.w = m.w;
            schedule();
            break;
        }
        case 'progress': {
            if (lockMode) return;
            // Never backwards: a lower floor or ceiling than we have is ignored.
            const floor = Math.max(bar.floor, m.floor);
            const ceil = Math.max(bar.ceil, m.ceil, floor);
            if (floor !== bar.floor || ceil !== bar.ceil) { bar.floor = Math.max(floor, bar.shown); bar.ceil = ceil; bar.since = t; }
            if (m.done) bar.done = true;
            schedule();
            break;
        }
        case 'act': {
            if (lockMode || exiting || reduced) return;
            const r = act(game, W / H, game.mode === 'over' ? 0.1 : smooth.cy / U());
            if (r !== 'wait') strokeT = 0; // every swim is one stroke
            if (r === 'start') sendGame();
            schedule();
            break;
        }
        case 'keys': {
            if (lockMode) return;
            keysVisible = m.visible;
            schedule();
            break;
        }
        case 'quit': {
            if (lockMode || game.mode === 'idle') return;
            quit(game);
            sendGame();
            schedule();
            break;
        }
        case 'exit': {
            if (lockMode) return;
            exiting = true;
            schedule();
            break;
        }
        case 'pause': {
            unschedule();
            break;
        }
        case 'resume': {
            lastTs = 0;
            sentOk = false; // a new listener: tell it once the next frame lands
            schedule();
            break;
        }
        case 'detach': {
            unschedule();
            if (G) {
                G.gl.getExtension('WEBGL_lose_context')?.loseContext();
                G = null;
            }
            break;
        }
        case 'stats': {
            const now = performance.now();
            post({ type: 'stats', frames: stats.frames, busyMs: stats.busyMs, wallMs: now - stats.since });
            stats.frames = 0; stats.busyMs = 0; stats.since = now;
            break;
        }
    }
};
