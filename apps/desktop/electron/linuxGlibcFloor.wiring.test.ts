import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The Linux native binaries (audio_capture.node + cl-wayland-overlay) must load on older distros. A binary
 * links the glibc of the machine that BUILT it; the release runner is Ubuntu 24.04 (glibc 2.39), whose build
 * needed GLIBC_2.38 and silently failed to dlopen on Ubuntu 22.04 / Debian 12 ("Native audio capture addon NOT
 * loaded"). This pins the things that bring that back without anyone noticing: the container build, the
 * fatal glibc guard, and the guard's own behaviour (driven with a fake objdump so no ELF is needed). The real
 * proof - binaries built, objdump'd and dlopen()ed on ubuntu 20.04/22.04/24.04 and debian 11/12 - is the
 * `npm run rebuild-native:linux-compat` + harness/linux-share-audio run, not this file.
 */
const root = path.resolve(__dirname, '..');
const read = (...p: string[]) => fs.readFileSync(path.resolve(root, ...p), 'utf8');
const WORKFLOW_PATH = path.resolve(root, '..', '..', '.github', 'workflows', 'release-desktop.yml');
const hasWorkflow = fs.existsSync(WORKFLOW_PATH);
const WORKFLOW = hasWorkflow ? fs.readFileSync(WORKFLOW_PATH, 'utf8') : '';
const BUILD_SH = read('scripts', 'rebuild-native-linux-compat.sh');
const GUARD_SH = read('scripts', 'check-glibc-floor.sh');
const DOCKERFILE = read('scripts', 'linux-compat', 'Dockerfile');
const PKG = JSON.parse(read('package.json'));

const floorOf = (sh: string) => /GLIBC_FLOOR="\$\{GLIBC_FLOOR:-([0-9.]+)\}"/.exec(sh)?.[1];

/** The release-linux job's step blocks, split on "- name:" so each can be inspected on its own. */
function linuxSteps(): Map<string, string> {
    const job = WORKFLOW.slice(WORKFLOW.indexOf('  release-linux:'));
    const parts = job.split(/^ {6}- name: /m).slice(1);
    return new Map(parts.map(p => [p.split('\n')[0].trim(), p]));
}

describe('rebuild-native:linux-compat: the container build', () => {
    it('is an npm script, and uses the same Electron target as rebuild-native', () => {
        expect(PKG.scripts['rebuild-native:linux-compat']).toBe('bash scripts/rebuild-native-linux-compat.sh');
        const v = /-v ([0-9.]+)$/.exec(PKG.scripts['rebuild-native'])![1];
        expect(BUILD_SH).toContain(`ELECTRON_VERSION="\${ELECTRON_VERSION:-${v}}"`);
        expect(BUILD_SH).toContain("--target='\"$ELECTRON_VERSION\"'");
    });

    it('compiles in a digest-pinned Ubuntu 20.04 (glibc 2.31) image, and the floor matches that image', () => {
        expect(DOCKERFILE).toMatch(/^FROM ubuntu:20\.04@sha256:[0-9a-f]{64}$/m);
        expect(floorOf(BUILD_SH)).toBe('2.31');
        // Electron 43's V8 headers need -std=gnu++20; focal's default gcc 9 rejects it, so gcc 10 is installed AND selected.
        expect(DOCKERFILE).toMatch(/gcc-10 g\+\+-10/);
        expect(DOCKERFILE).toContain('ENV CC=gcc-10 CXX=g++-10');
    });

    it('builds into build/Release like rebuild-native, starting from an empty dir so a stale host-built binary cannot survive a failed build', () => {
        expect(BUILD_SH).toContain('OUT="$DESKTOP/build/Release"');
        expect(BUILD_SH).toMatch(/rm -rf "\$OUT"/);
        expect(BUILD_SH).toContain('cp build/Release/audio_capture.node /out/');
        expect(BUILD_SH).toContain('cp build/Release/cl-wayland-overlay /out/');
    });

    it('never falls back to a host (newer-glibc) build, and checks the floor itself unless the caller defers it', () => {
        expect(BUILD_SH).not.toMatch(/node-gyp[^\n]*\n[^\n]*\|\|\s*(npm|npx)/);
        expect(BUILD_SH).not.toContain('electron-rebuild');
        expect(BUILD_SH).toContain('SKIP_GLIBC_GUARD');
        expect(BUILD_SH).toContain('check-glibc-floor.sh" "$GLIBC_FLOOR"');
    });

    it('does not touch the source lists (binding.gyp still builds the addon + the helper from the same files)', () => {
        const gyp = read('binding.gyp');
        expect(gyp).toContain('"sources": [ "src-native/audio_capture.cc", "src-native/window_geometry.cc", "src-native/share_power.cc", "src-native/hdr_capture.cc" ]');
        expect(gyp).toContain('"sources": [ "src-native/audio_capture_linux.cc" ]');
        expect(gyp).toContain('"sources": [ "src-native/wayland_overlay/cl_wayland_overlay.c" ]');
    });
});

describe.skipIf(!hasWorkflow)('release-desktop.yml: the Linux job', () => {
    const steps = () => linuxSteps();
    const names = () => [...steps().keys()];

    it('builds the native binaries with rebuild-native:linux-compat (non-fatal for a genuine build failure), not the host toolchain', () => {
        const build = steps().get('Build native audio addon (Linux, PipeWire)')!;
        expect(build).toMatch(/id: addon\s+continue-on-error: true/);
        expect(build).toContain('npm run rebuild-native:linux-compat');
        expect(build).toMatch(/SKIP_GLIBC_GUARD: '1'/);
        // the old host build is what produced GLIBC_2.38
        expect(build).not.toMatch(/npm run rebuild-native\s*\n/);
        expect(build).not.toContain('build-essential');
    });

    it('has a FATAL glibc guard between the build and the packaging, on the same floor as the build script', () => {
        const order = names();
        const build = order.indexOf('Build native audio addon (Linux, PipeWire)');
        const guard = order.findIndex(n => n.startsWith('Guard Linux native binaries'));
        const pkg = order.indexOf('Package Linux (AppImage + deb)');
        expect(build).toBeGreaterThan(-1);
        expect(guard).toBeGreaterThan(build);
        expect(guard).toBeLessThan(pkg);

        const step = steps().get(order[guard])!;
        // continue-on-error here would let a floor violation ship exactly like the bug it guards against
        expect(step).not.toContain('continue-on-error');
        expect(step).not.toMatch(/\|\|\s*true/);
        expect(step).toContain("if: steps.addon.outcome == 'success'");
        expect(step).toContain('scripts/check-glibc-floor.sh');
        expect(step).toContain('build/Release/audio_capture.node');
        expect(step).toContain('build/Release/cl-wayland-overlay');
        expect(step).toContain(`check-glibc-floor.sh ${floorOf(BUILD_SH)} `);
        expect(order[guard]).toContain(floorOf(BUILD_SH)!);
    });

    it('documents the floor choice in the workflow', () => {
        const job = WORKFLOW.slice(WORKFLOW.indexOf('  release-linux:'));
        expect(job).toContain('GLIBC FLOOR = 2.31');
        expect(job).toContain('ubuntu:20.04');
        expect(job).toMatch(/Electron 43[^\n]*\n?[^\n]*GLIBC_2\.25/);
    });
});

describe('check-glibc-floor.sh', () => {
    const run = (objdumpOut: string | null, floor: string, files: string[] = ['bin'], env: Record<string, string> = {}) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glibc-floor-'));
        try {
            fs.writeFileSync(path.join(dir, 'bin'), 'not really an ELF');
            const fake = path.join(dir, 'fake-objdump');
            fs.writeFileSync(fake, objdumpOut === null
                ? '#!/bin/sh\necho "objdump: file format not recognized" >&2\nexit 1\n'
                : `#!/bin/sh\ncat <<'EOF'\n${objdumpOut}\nEOF\n`, { mode: 0o755 });
            return spawnSync('bash', [path.resolve(root, 'scripts', 'check-glibc-floor.sh'), floor, ...files.map(f => path.join(dir, f))],
                { encoding: 'utf8', env: { ...process.env, OBJDUMP: fake, ...env } });
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };
    const sym = (ver: string, name: string) => `0000000000000000      DF *UND*\t0000000000000000 (${ver}) ${name}`;
    const HEADER = 'bin:     file format elf64-x86-64\n\nDYNAMIC SYMBOL TABLE:';
    const defined = '0000000000001000 g    DF .text\t0000000000000010  Base        napi_register_module_v1';

    it('passes when every needed version is at or under the floor (exact floor included)', () => {
        const r = run([HEADER, sym('GLIBC_2.2.5', 'memcpy'), sym('GLIBC_2.30', 'pthread_cond_clockwait'), sym('GLIBC_2.31', 'x'), sym('GLIBCXX_3.4.26', '_ZSt4cout'), defined].join('\n'), '2.31');
        expect(r.status).toBe(0);
        expect(r.stdout).toContain('glibc floor OK');
    });

    it('fails, naming the offending symbols, when a version is above the floor (the real 2.38 culprits)', () => {
        const r = run([HEADER, sym('GLIBC_2.2.5', 'memcpy'), sym('GLIBC_2.34', 'dlopen'), sym('GLIBC_2.38', '__isoc23_strtol')].join('\n'), '2.31');
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('needs GLIBC_2.38');
        expect(r.stdout).toContain('__isoc23_strtol');
        expect(r.stdout).toContain('dlopen');
        expect(r.stdout).not.toContain('memcpy');
    });

    it('compares versions numerically, not as strings (2.4 is below 2.31; 2.100 is above it)', () => {
        expect(run([HEADER, sym('GLIBC_2.4', 'a'), sym('GLIBC_2.9', 'b')].join('\n'), '2.31').status).toBe(0);
        expect(run([HEADER, sym('GLIBC_2.100', 'a')].join('\n'), '2.31').status).toBe(1);
    });

    it('ignores versions the binary DEFINES (only undefined = needed symbols count)', () => {
        const r = run([HEADER, sym('GLIBC_2.17', 'a'), '0000000000001000 g    DF .text\t0000000000000010  GLIBC_2.99  provided_by_us'].join('\n'), '2.31');
        expect(r.status).toBe(0);
    });

    it('fails on a libstdc++ version above the ceiling, and honours GLIBCXX_FLOOR', () => {
        const out = [HEADER, sym('GLIBC_2.17', 'a'), sym('GLIBCXX_3.4.29', '_ZNSt6thread6_StateD2Ev')].join('\n');
        expect(run(out, '2.31').status).toBe(1);
        expect(run(out, '2.31', ['bin'], { GLIBCXX_FLOOR: '3.4.30' }).status).toBe(0);
    });

    it('fails (never passes quietly) when objdump errors, a file is missing, or no files are given', () => {
        expect(run(null, '2.31').status).toBe(1);
        expect(run(HEADER, '2.31', ['does-not-exist']).status).toBe(1);
        expect(run(HEADER, '2.31', []).status).toBe(2);
        expect(run(HEADER, 'not-a-version').status).toBe(2);
    });

    it('fails if ANY of several binaries is over the floor', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glibc-floor-multi-'));
        try {
            fs.writeFileSync(path.join(dir, 'ok'), 'x');
            fs.writeFileSync(path.join(dir, 'bad'), 'x');
            const fake = path.join(dir, 'fake-objdump');
            // answer by the file name objdump is given
            fs.writeFileSync(fake, `#!/bin/sh\ncase "$2" in\n *bad) echo "(GLIBC_2.38) __isoc23_strtol *UND*";;\n *) echo "(GLIBC_2.17) memcpy *UND*";;\nesac\n`, { mode: 0o755 });
            const r = spawnSync('bash', [path.resolve(root, 'scripts', 'check-glibc-floor.sh'), '2.31', path.join(dir, 'ok'), path.join(dir, 'bad')],
                { encoding: 'utf8', env: { ...process.env, OBJDUMP: fake } });
            expect(r.status).toBe(1);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
