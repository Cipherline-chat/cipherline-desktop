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
 * ones. The game's pillars are the same fine dots, packed densely.
 *
 * Rendering: raw WebGL 1, ONE draw call per frame. Every dot and Keys
 * himself are POINTS in one buffer (Keys is one big point sprite whose
 * fragments evaluate the SDF); the vertex shader places each by group.
 * Blending is premultiplied "over": the dots write alpha 0, so they add
 * light; Keys writes alpha 1, so he is solid. The canvas is transparent and
 * the page's CSS backdrop shows through, so there is no background pass.
 *
 * 60 fps while something moves fast (the game, transitions, the exit, the
 * pointer easing); 30 fps for the resting swim and current; nothing while
 * the window is hidden (rAF stops). Reduced motion: one still frame,
 * redrawn only on resize — no current, no swim, no pointer, no game.
 */
import { newGame, act, quit, step, formation, RULES, keysX, type Game } from '../utils/loadingGame';
import { BOX, SWIM, tiltHomography, tiltToward } from '../utils/keysPose';
import type { ToWorker, FromWorker } from './loadingScreenProtocol';

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

/* ── The dots ─────────────────────────────────────────────────────────────── */

/** Field volume, shape units: wide enough for a 21:9 window plus the camera's orbit. */
const SPAN_X = 6.5, SPAN_Y = 3.6;
const N_FIELD = Math.round(58 * (2 * SPAN_X) * (2 * SPAN_Y)); // ≈ 5,400
const WALL_DOTS = 1500;
const N_BURST = 320;
const N_BAR = 120;
const OFF_WALLS = N_FIELD;
const OFF_BURST = OFF_WALLS + RULES.slots * WALL_DOTS;
const OFF_KEYS = OFF_BURST + N_BURST;
const OFF_BAR = OFF_KEYS + 1;
const N = OFF_BAR + N_BAR;

// Per vertex: A = (x, y, z, size), C = (r, g, b, group), S = four seeds.
// Groups: 0 field, 1 crash burst, 2..9 wall slots, 11 Keys, 12 loading bar. (The score is HTML.)
const A = new Float32Array(N * 4);
const C = new Float32Array(N * 4);
const S = new Float32Array(N * 4);

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
for (let i = OFF_WALLS; i < OFF_BURST; i++) setDot(i, 0, 0, 0, 0, TEAL, 0, 2 + Math.floor((i - OFF_WALLS) / WALL_DOTS));
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

/**
 * The fine dots of a pillar: the field's own dots, packed into the wall's two
 * slabs, each running off its edge of the window (below the floor up to the
 * gap; the gap up past the top) — exactly the rectangles the rules collide
 * with (utils/loadingGame.ts hitsWall: a slab is open-ended). These
 * are where the dots SETTLE; the shader flies each one in from the field
 * around it as the pillar scrolls (see formation() in utils/loadingGame.ts).
 */
function writeWall(slot: number) {
    const w = game.walls[slot];
    const u = U();
    const edge0 = -1.04 * u, edge1 = 1.04 * u; // a little past the window's edges
    const half = (RULES.wallW / 2) * u;
    const lo = (w.gap - w.gapH / 2) * u, hi = (w.gap + w.gapH / 2) * u;
    const hLo = lo - edge0, hHi = edge1 - hi; // heights of the lower and upper slabs
    const base = fieldPx() / 3.2; // a field dot at mid depth
    const i0 = OFF_WALLS + slot * WALL_DOTS;
    for (let k = 0; k < WALL_DOTS; k++) {
        const i = i0 + k;
        const s0 = S[i * 4], s1 = S[i * 4 + 1], s2 = S[i * 4 + 2], s3 = S[i * 4 + 3];
        const x = (s0 * 2 - 1) * half;
        let y: number;
        const edge = k % 7 === 0; // one in seven traces the gap's edges, so the opening reads clearly
        if (edge) {
            y = s1 < 0.5 ? hi + s2 * 0.02 * u : lo - s2 * 0.02 * u;
        } else {
            const pick = s1 * (hLo + hHi);
            y = pick < hLo ? edge0 + pick : hi + (pick - hLo);
        }
        setDot(i, x, y, 0, base * (0.6 + s3 * 0.8), s2 < 0.55 ? TEAL : ICE, edge ? 0.95 : 0.42 + s3 * 0.4, 2 + slot);
    }
    dirty.walls = true;
}

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
uniform vec2 uWall[8];// x (px), alpha
uniform float uWallF[8]; // how formed each pillar is, 0 (loose) .. 1 (solid)
uniform vec4 uBar;    // centre x, y (px), width (px), progress 0..1
uniform vec2 uBarA;   // alpha, shimmer on/off
varying vec3 vC;
varying float vKind;  // 0 a soft dot, 1 Keys
vec2 dir(float s){ float a = s*6.2831853; return vec2(cos(a), sin(a)); }
void main(){
  float g = aC.w;
  vKind = 0.0;
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
    int slot = int(g - 1.5);
    vec2 w = uWall[slot];
    /* the pillar builds out of the field as it scrolls: each dot flies in
       from somewhere around it, on its own schedule, and settles */
    float l = clamp((uWallF[slot] - aS.w*0.45)/0.55, 0.0, 1.0);
    l = l*l*(3.0 - 2.0*l);
    vec2 loose = dir(aS.x)*(0.25 + aS.y*0.75)*uRes.y*0.32 + vec2(sin(uT*0.8 + aS.z*30.0), cos(uT*0.6 + aS.z*17.0))*6.0;
    p = vec2(aA.x + w.x, aA.y) + loose*(1.0 - l);
    size = aA.w*(0.75 + 0.25*l);
    a = w.y*mix(0.3, 1.0, l)*(0.85 + 0.15*sin(uT*2.0 + aS.z*60.0));
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
void main(){
  vec2 pc = gl_PointCoord*2.0 - 1.0;
  if (vKind < 0.5) {
    float r2 = dot(pc, pc);
    if (r2 > 1.0) discard;
    float a = exp(-r2*3.2)*0.55 + exp(-r2*16.0)*0.9;
    gl_FragColor = vec4(vC*a, 0.0); // alpha 0: adds light
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
    bufA: WebGLBuffer; bufC: WebGLBuffer;
    maxPoint: number;
}
let G: Gl | null = null;
const dirty = { walls: false, all: true };

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
    return s;
}

function setupGl(canvas: OffscreenCanvas): Gl | null {
    const gl = canvas.getContext('webgl', {
        alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
        preserveDrawingBuffer: false, powerPreference: 'low-power',
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
        for (const n of ['uRes', 'uDpr', 'uT', 'uCam', 'uMouse', 'uField', 'uBright', 'uKeys', 'uBurst', 'uSwim', 'uTilt', 'uWall', 'uWallF', 'uBar', 'uBarA']) u[n] = gl.getUniformLocation(prog, n);
        const buffer = (name: string, data: Float32Array) => {
            const b = gl.createBuffer()!;
            const loc = gl.getAttribLocation(prog, name);
            gl.bindBuffer(gl.ARRAY_BUFFER, b);
            gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 0, 0);
            return b;
        };
        const bufA = buffer('aA', A);
        const bufC = buffer('aC', C);
        buffer('aS', S);
        gl.enable(gl.BLEND);
        // Premultiplied "over": a dot (alpha 0) adds light; Keys (alpha 1) covers.
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
        return { gl, canvas, u, bufA, bufC, maxPoint: range ? range[1] : 64 };
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
/** Keys is drawn unless the host asked for the field alone ('keys' message). */
let keysVisible = true;
let lastTs = 0, lastDraw = 0, raf = 0, sentOk = false;
/** Everything that eases. */
const smooth = { cx: 0, cy: 0, k: 1, walls: 0, game: 0, burst: 0, mx: 0, my: 0, mz: 0, vx: CURRENT_X, vy: CURRENT_Y, tx: 0, ty: 0 };
const pointer = { x: 0, y: 0, on: 0 };
let scrollX = 0, scrollY = 0;
/** Keys' swim: seconds into the current stroke. Resting: a stroke every STROKE_S (0.35 s in, 1.4 s out, a beat of glide). */
const STROKE_S = 2.2;
let strokeT = 0;
/** His vertical speed in the game, smoothed: the pose blends from it, never snaps. */
let vySmooth = 0;
/** The loading bar: where (from the DOM slot), what is known, and what it shows. */
const bar = { x: 0, y: 0, w: 0, floor: 0, ceil: 0.18, done: false, since: 0, shown: 0 };
let burstAt = { x: 0, y: 0 };
const stats = { frames: 0, busyMs: 0, since: performance.now() };
const wall = new Float32Array(RULES.slots * 2);
const wallF = new Float32Array(RULES.slots);
const CAM = 3.2;

function targets() {
    const u = U();
    const inGame = game.mode !== 'idle';
    return {
        cx: inGame ? keysX(W / H) * u : 0,
        cy: inGame ? game.y * u : idleY(),
        k: (inGame ? GAME_KEYS_U * u : idleKeysPx()) / 64,
        walls: inGame ? 1 : 0,
        game: inGame ? 1 : 0,
        burst: game.mode === 'over' ? 1 : 0,
        mx: pointer.x, my: pointer.y, mz: pointer.on,
        // Keys turns to face the pointer (only while waiting): tx follows its y, ty its x
        tx: inGame ? 0 : pointer.on * pointer.y, ty: inGame ? 0 : pointer.on * pointer.x,
        // the current speeds up into the playfield, and stalls on a crash
        vx: game.mode === 'playing' ? 0.35 + 0.5 * game.speed : game.mode === 'over' ? 0.02 : CURRENT_X,
        vy: game.mode === 'idle' ? CURRENT_Y : 0,
    };
}
type Key = keyof typeof smooth;
const RATES: Record<Key, number> = {
    cx: 5, cy: 5, k: 5, walls: 5, game: 4, burst: 2.2, mx: 3.2, my: 3.2, mz: 3, vx: 2.2, vy: 2.2, tx: 4, ty: 4,
};
const EPS: Record<Key, number> = {
    cx: 0.3, cy: 0.3, k: 0.002, walls: 0.01, game: 0.005, burst: 0.005, mx: 0.002, my: 0.002, mz: 0.005, vx: 0.002, vy: 0.002, tx: 0.002, ty: 0.002,
};
const KEYS_ = Object.keys(smooth) as Key[];

function approach(dt: number, tg: ReturnType<typeof targets>) {
    for (const key of KEYS_) {
        if (key === 'cy' && game.mode === 'playing' && smooth.game > 0.98) { smooth.cy = tg.cy; continue; }
        if (key === 'burst' && game.mode !== 'over') { smooth.burst = 0; continue; }
        const d = tg[key] - smooth[key];
        if (Math.abs(d) < EPS[key]) { smooth[key] = tg[key]; continue; }
        smooth[key] += d * (1 - Math.exp(-dt * RATES[key]));
    }
}
const settling = (tg: ReturnType<typeof targets>) => KEYS_.some(k => Math.abs(tg[k] - smooth[k]) > EPS[k]);

function upload() {
    if (!G) return;
    const { gl } = G;
    if (dirty.all) {
        gl.bindBuffer(gl.ARRAY_BUFFER, G.bufA); gl.bufferSubData(gl.ARRAY_BUFFER, 0, A);
        gl.bindBuffer(gl.ARRAY_BUFFER, G.bufC); gl.bufferSubData(gl.ARRAY_BUFFER, 0, C);
        dirty.all = dirty.walls = false;
        return;
    }
    const part = (from: number, to: number) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, G!.bufA); gl.bufferSubData(gl.ARRAY_BUFFER, from * 16, A.subarray(from * 4, to * 4));
        gl.bindBuffer(gl.ARRAY_BUFFER, G!.bufC); gl.bufferSubData(gl.ARRAY_BUFFER, from * 16, C.subarray(from * 4, to * 4));
    };
    if (dirty.walls) { part(OFF_WALLS, OFF_BURST); dirty.walls = false; }
}

function sendGame() { post({ type: 'game', mode: game.mode, score: game.score, best: game.best }); }


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
    lastTs = ts; lastDraw = ts;
    if (!reduced) t += dt;

    if (game.mode !== 'idle') {
        // Fixed sub-steps so a fast wall can't tunnel through Keys.
        let left = dt;
        while (left > 1e-6) {
            const h = Math.min(left, 1 / 120);
            const r = step(game, h, W / H);
            r.respawned.forEach(writeWall);
            if (r.scored) sendGame();
            if (r.died) { sendGame(); burstAt = { x: smooth.cx, y: game.y * U() }; }
            left -= h;
        }
    }
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
    upload();

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
    const tilt = tiltToward(smooth.ty, smooth.tx, reduced ? 0 : 1 - smooth.game);
    gl.uniformMatrix3fv(u.uTilt, false, tiltHomography(tilt.ax, tilt.ay));
    gl.uniform4f(u.uBar, bar.x, bar.y, bar.w, bar.shown);
    gl.uniform2f(u.uBarA, bar.w > 0 ? (1 - smooth.game) : 0, reduced ? 0 : 1);
    gl.uniform4f(u.uBurst, burstAt.x, burstAt.y, smooth.burst, game.mode === 'over' ? 1 : 0);

    game.walls.forEach((w, i) => { wall[i * 2] = w.x * U(); wall[i * 2 + 1] = w.live ? smooth.walls * (1 - exitK) : 0; });
    gl.uniform2fv(u.uWall, wall);
    game.walls.forEach((w, i) => { wallF[i] = reduced ? 1 : formation(w.x, W / H, game.score); });
    gl.uniform1fv(u.uWallF, wallF);
    gl.drawArrays(gl.POINTS, 0, N);

    stats.frames++;
    stats.busyMs += performance.now() - t0;
    if (!sentOk) { sentOk = true; post({ type: 'ok' }); }
    if (reduced) return; // one still frame; redrawn on resize only
    if (exiting && exitK >= 1) return; // the last frame of the exit: stop.
    schedule();
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
            if (game.best < m.best) game.best = m.best;
            G = setupGl(m.canvas);
            if (!G) { post({ type: 'nogl' }); return; }
            sizeCanvas();
            if (!placed) { placed = true; Object.assign(smooth, targets()); }
            game.walls.forEach((w, i) => { if (w.live) writeWall(i); });
            dirty.all = true;
            sentOk = false;
            lastTs = 0;
            schedule();
            break;
        }
        case 'resize': {
            W = m.w; H = m.h; dpr = m.dpr;
            sizeCanvas();
            game.walls.forEach((w, i) => { if (w.live) writeWall(i); });
            dirty.all = true;
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
            bar.x = m.x; bar.y = m.y; bar.w = m.w;
            schedule();
            break;
        }
        case 'progress': {
            // Never backwards: a lower floor or ceiling than we have is ignored.
            const floor = Math.max(bar.floor, m.floor);
            const ceil = Math.max(bar.ceil, m.ceil, floor);
            if (floor !== bar.floor || ceil !== bar.ceil) { bar.floor = Math.max(floor, bar.shown); bar.ceil = ceil; bar.since = t; }
            if (m.done) bar.done = true;
            schedule();
            break;
        }
        case 'act': {
            if (exiting || reduced) return;
            const r = act(game, W / H, game.mode === 'over' ? 0.1 : smooth.cy / U());
            if (r !== 'wait') strokeT = 0; // every swim is one stroke
            if (r === 'start') { game.walls.forEach((w, i) => { if (w.live) writeWall(i); }); sendGame(); }
            schedule();
            break;
        }
        case 'keys': {
            keysVisible = m.visible;
            dirty.all = true;
            schedule();
            break;
        }
        case 'quit': {
            if (game.mode === 'idle') return;
            quit(game);
            sendGame();
            schedule();
            break;
        }
        case 'exit': {
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
