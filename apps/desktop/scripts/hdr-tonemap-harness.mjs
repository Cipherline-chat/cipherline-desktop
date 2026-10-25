#!/usr/bin/env node
/**
 * HDR share tone map - GPU verification harness (dev box, no HDR monitor needed).
 *
 *   node scripts/hdr-tonemap-harness.mjs <out-dir> [--swiftshader]
 *
 * 1. Extracts the TONEMAP-CORE block from src-native/hdr_capture.cc VERBATIM
 *    (the exact text the native capture compiles as HLSL) and compiles it as
 *    GLSL ES 3.0 in headless Chromium/WebGL2 (`float3` etc. #defined).
 * 2. Uploads a synthetic HDR desktop frame (scRGB, FP16 texture, 2560x1440):
 *    SDR UI composed at an SDR white of 240 nits, a 0-1600 nit grey ramp, and
 *    saturated HDR highlights up to 2000 nits.
 * 3. Renders it through the shader and compares EVERY pixel with
 *    src/utils/hdrTonemap.ts (the unit-tested reference): max |diff| in 8-bit codes.
 * 4. Times the pass (and a plain copy pass, the floor) at 1440p and 2160p.
 * 5. Writes before.png (what Chromium's capturers deliver today: scRGB clipped
 *    at 1.0, the OS's 8-bit conversion), after.png (the shader's output) and
 *    compare.png (side by side, labelled) to <out-dir>, plus results.json.
 *
 * GPU: the dev box's Intel UHD 630 via ANGLE/GL-EGL (memory: devbox_intel_gpu);
 * --swiftshader forces the CPU rasteriser (slower; correctness only).
 */
import { chromium } from 'playwright-core';
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(process.argv[2] ?? join(root, 'hdr-harness-out'));
const swiftshader = process.argv.includes('--swiftshader');
mkdirSync(outDir, { recursive: true });

const native = readFileSync(join(root, 'src-native/hdr_capture.cc'), 'utf8');
const m = /\/\/ TONEMAP-CORE-BEGIN\n([\s\S]*?)\/\/ TONEMAP-CORE-END/.exec(native);
if (!m) throw new Error('TONEMAP-CORE block not found in hdr_capture.cc');
const core = m[1];

const bundle = await esbuild.build({
    entryPoints: [join(root, 'src/utils/hdrTonemap.ts')],
    bundle: true, format: 'iife', globalName: 'HdrTonemap', write: false, platform: 'browser',
});
const tonemapJs = bundle.outputFiles[0].text;

const args = swiftshader
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : ['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
// The playwright-core this repo resolves may expect a different browser build
// than the one installed: fall back to the newest cached headless shell
// (or HDR_HARNESS_CHROME).
const cachedShell = () => {
    const base = join(homedir(), '.cache/ms-playwright');
    if (!existsSync(base)) return undefined;
    const dirs = readdirSync(base).filter(d => /^chromium_headless_shell-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
        const exe = join(base, d, 'chrome-headless-shell-linux64/chrome-headless-shell');
        if (existsSync(exe)) return exe;
    }
    return undefined;
};
let browser;
try {
    browser = await chromium.launch({ headless: true, args, executablePath: process.env.HDR_HARNESS_CHROME || undefined });
} catch (e) {
    const exe = cachedShell();
    if (!exe) throw e;
    browser = await chromium.launch({ headless: true, args, executablePath: exe });
}
try {
    const page = await browser.newPage();
    page.on('console', msg => console.log('[page]', msg.text()));
    await page.setContent('<!doctype html><body></body>');
    await page.addScriptTag({ content: tonemapJs });
    const result = await page.evaluate(async ({ core }) => {
        const T = globalThis.HdrTonemap;
        const W = 2560, H = 1440, SDR_WHITE = 240, PEAK = 1000;
        const params = T.resolveToneParams({ sdrWhiteNits: SDR_WHITE, maxLuminance: PEAK });
        const tone = T.shaderToneVector(params);

        // ── the synthetic HDR desktop (scRGB, linear, 1.0 = 80 nits) ──
        const px = new Float32Array(W * H * 4);
        const sdr = (code) => T.sdrCodeToScRgb(code, SDR_WHITE);
        const set = (x, y, r, g, b) => { const i = (y * W + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 1; };
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                let r, g, b;
                if (y < 480) {
                    // SDR app window: white page, a grey ramp "text" band, sRGB buttons, a dark sidebar
                    if (x < 360) { r = sdr(32); g = sdr(34); b = sdr(40); }
                    else if (y > 60 && y < 140) { const c = Math.round(((x - 360) / (W - 360)) * 255); r = g = b = sdr(c); }
                    else if (y > 200 && y < 300 && x > 420 && x < 2500) {
                        const k = Math.floor((x - 420) / 260);
                        const cols = [[229, 57, 53], [67, 160, 71], [30, 136, 229], [253, 216, 53], [142, 36, 170], [0, 172, 193], [255, 112, 67], [120, 144, 156]][k % 8];
                        r = sdr(cols[0]); g = sdr(cols[1]); b = sdr(cols[2]);
                    } else { r = g = b = sdr(255); }
                } else if (y < 760) {
                    // HDR grey ramp 0..1600 nits, with a tick every 200 nits
                    const nits = (x / (W - 1)) * 1600;
                    const tick = y > 740 && Math.abs((nits % 200)) < 4;
                    r = g = b = tick ? 0 : nits / 80;
                } else {
                    // HDR scene: a sunset sky (saturated, 50-400 nits) with a sun disk to 2000 nits
                    const u = x / W, v = (y - 760) / (H - 760);
                    const sky = 50 + 350 * (1 - v);
                    r = (sky * (0.9 + 0.1 * u)) / 80; g = (sky * (0.45 + 0.2 * v)) / 80; b = (sky * (0.15 + 0.5 * v)) / 80;
                    const dx = x - 1800, dy = y - 980, d = Math.sqrt(dx * dx + dy * dy);
                    if (d < 220) { const k = Math.pow(1 - d / 220, 1.5); r += (2000 * k) / 80; g += (1700 * k) / 80; b += (1100 * k) / 80; }
                }
                set(x, y, r, g, b);
            }
        }

        // ── WebGL2: FP16 texture -> shader -> RGBA8 ──
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
        if (!gl) return { error: 'no webgl2' };
        const renderer = (() => { const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })();
        const vsSrc = `#version 300 es
            out vec2 vUv;
            void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUv = vec2(p.x, p.y); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
        const prefix = `#version 300 es
            precision highp float;
            #define float2 vec2
            #define float3 vec3
            #define float4 vec4
            `;
        const fsTone = prefix + core + `
            uniform sampler2D src; uniform vec4 uTone; in vec2 vUv; out vec4 o;
            void main() { vec4 s = texture(src, vUv); o = vec4(clSrgbEncode(clTonemap(s.rgb, uTone)), 1.0); }`;
        const fsCopy = prefix + `
            uniform sampler2D src; uniform vec4 uTone; in vec2 vUv; out vec4 o;
            void main() { o = vec4(texture(src, vUv).rgb, 1.0); }`;
        const compile = (type, src) => {
            const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
            return s;
        };
        const program = (fs) => {
            const p = gl.createProgram();
            gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc));
            gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
            gl.linkProgram(p);
            if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
            return p;
        };
        const progTone = program(fsTone), progCopy = program(fsCopy);
        const mkSrc = (w, h, data) => {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.FLOAT, data);
            return t;
        };
        const mkTarget = (w, h) => {
            const t = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
            const fb = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
            return fb;
        };
        const draw = (prog, srcTex, fb, w, h) => {
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.viewport(0, 0, w, h);
            gl.useProgram(prog);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, srcTex);
            gl.uniform1i(gl.getUniformLocation(prog, 'src'), 0);
            const loc = gl.getUniformLocation(prog, 'uTone');
            if (loc) gl.uniform4f(loc, tone[0], tone[1], tone[2], tone[3]);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        };

        const src = mkSrc(W, H, px);
        const fb = mkTarget(W, H);
        draw(progTone, src, fb, W, H);
        const out = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out);
        // readPixels row 0 = bottom of the framebuffer = vUv.y 0 = texture row 0 = our y 0: same orientation.

        // ── compare with the reference, every pixel ──
        // The texture holds FP16, so the reference is fed the same FP16-rounded inputs.
        const f16 = (v) => { const a = new Float32Array([v]); const u = new Uint32Array(a.buffer)[0];
            // round-to-nearest-even to 10 mantissa bits (normal range is all we use)
            const exp = (u >>> 23) & 0xff; if (exp === 0) return 0;
            const shift = 13; const mant = u & 0x7fffff; const half = 1 << (shift - 1);
            let rounded = (u & ~((1 << shift) - 1)) >>> 0;
            const rem = mant & ((1 << shift) - 1);
            if (rem > half || (rem === half && ((mant >>> shift) & 1))) rounded = (rounded + (1 << shift)) >>> 0;
            return new Float32Array(new Uint32Array([rounded]).buffer)[0]; };
        let maxDiff = 0, over1 = 0;
        const before = new Uint8ClampedArray(W * H * 4), after = new Uint8ClampedArray(W * H * 4);
        for (let i = 0; i < W * H; i++) {
            const rgb = [f16(px[i * 4]), f16(px[i * 4 + 1]), f16(px[i * 4 + 2])];
            const ref = T.tonemapToCodes(rgb, tone);
            const leg = T.legacyClipToCodes(rgb);
            for (let c = 0; c < 3; c++) {
                const d = Math.abs(out[i * 4 + c] - ref[c]);
                if (d > maxDiff) maxDiff = d;
                if (d > 1) over1++;
                after[i * 4 + c] = out[i * 4 + c];
                before[i * 4 + c] = leg[c];
            }
            after[i * 4 + 3] = before[i * 4 + 3] = 255;
        }

        // ── timing: tone map vs a plain copy, 1440p and 2160p ──
        const time = (prog, w, h, n) => {
            const s = w === W ? src : mkSrc(w, h, new Float32Array(w * h * 4).fill(3));
            const t = mkTarget(w, h);
            const tmp = new Uint8Array(4);
            for (let i = 0; i < 20; i++) draw(prog, s, t, w, h);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, tmp);
            const t0 = performance.now();
            for (let i = 0; i < n; i++) draw(prog, s, t, w, h);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, tmp); // waits for the GPU
            return (performance.now() - t0) / n;
        };
        const timing = {
            tone1440: time(progTone, W, H, 300), copy1440: time(progCopy, W, H, 300),
            tone2160: time(progTone, 3840, 2160, 200), copy2160: time(progCopy, 3840, 2160, 200),
        };

        // ── images ──
        const toPng = (data, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0); return c; };
        const cb = toPng(before, W, H), ca = toPng(after, W, H);
        const cmp = document.createElement('canvas');
        const sw = 1280, sh = 720;
        cmp.width = sw * 2 + 30; cmp.height = sh + 70;
        const g2 = cmp.getContext('2d');
        g2.fillStyle = '#202024'; g2.fillRect(0, 0, cmp.width, cmp.height);
        g2.drawImage(cb, 10, 60, sw, sh); g2.drawImage(ca, sw + 20, 60, sw, sh);
        g2.fillStyle = '#fff'; g2.font = '22px sans-serif';
        g2.fillText('BEFORE: Chromium capture today (scRGB clipped at 80 nits)', 14, 30);
        g2.fillText(`AFTER: tone-mapped (SDR white ${SDR_WHITE} nits, peak ${PEAK}, knee ${params.knee})`, sw + 24, 30);
        g2.font = '16px sans-serif';
        g2.fillText('rows: SDR app window @240-nit white | 0-1600 nit grey ramp (ticks every 200) | HDR sunset, sun to 2000 nits', 14, 52);
        const samples = {
            sdrWhite: { before: T.legacyClipToCodes([sdr(255), sdr(255), sdr(255)])[0], after: T.tonemapToCodes([sdr(255), sdr(255), sdr(255)], tone)[0] },
            sdrMid180: { before: T.legacyClipToCodes([sdr(180), sdr(180), sdr(180)])[0], after: T.tonemapToCodes([sdr(180), sdr(180), sdr(180)], tone)[0] },
            nits: [100, 240, 400, 600, 800, 1000, 1600].map(n => ({ nits: n, before: T.legacyClipToCodes([n / 80, n / 80, n / 80])[0], after: T.tonemapToCodes([n / 80, n / 80, n / 80], tone)[0] })),
        };
        return {
            renderer, params, tone, maxDiff, over1, pixels: W * H * 3, timing, samples,
            before: cb.toDataURL('image/png'), after: ca.toDataURL('image/png'), compare: cmp.toDataURL('image/png'),
        };
    }, { core });
    if (result.error) throw new Error(result.error);
    for (const k of ['before', 'after', 'compare']) {
        writeFileSync(join(outDir, `${k}.png`), Buffer.from(result[k].split(',')[1], 'base64'));
        delete result[k];
    }
    writeFileSync(join(outDir, 'results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    console.log(`\nimages + results.json in ${outDir}`);
    const ok = result.maxDiff <= 1;
    console.log(ok ? 'PASS: shader matches the reference within 1 code on every pixel' : 'FAIL: shader deviates from the reference');
    process.exitCode = ok ? 0 : 1;
} finally {
    await browser.close();
}
