import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    computeNvidiaVaapiStatus, installViaPackageKit, installNvidiaVaapiDriver, pickInstallablePackageId, isNvidiaVaapiStatus,
    NVIDIA_MODESET_NOTE, type PackageKitBus, type PkSignal, type NvidiaVaapiStatus,
} from './nvidia-vaapi-install';
import { nvidiaVaapiPackage, type LinuxGpuProbe, type NvidiaDecodeState } from './linux-video-decode';

const probe = (over: Partial<LinuxGpuProbe> & { gpus?: LinuxGpuProbe['gpus'] } = {}): LinuxGpuProbe => ({
    gpus: [{ vendor: 'nvidia', driver: 'nvidia' }], nvidiaVaapiDriver: false, nvidiaDrmModeset: true,
    distro: { id: 'arch', like: [] }, ...over,
});
const status = (p: LinuxGpuProbe | null, launchNvidia: NvidiaDecodeState, decodeEnabledAtLaunch = true, platform = 'linux') =>
    computeNvidiaVaapiStatus({ platform, probe: p, decodeEnabledAtLaunch, launchNvidia });

describe('computeNvidiaVaapiStatus: detection -> prompt decision', () => {
    it('NVIDIA + driver missing -> install, with the distro package and command', () => {
        const s = status(probe(), 'missing_driver');
        expect(s).toMatchObject({ state: 'install', pkg: 'libva-nvidia-driver', canInstall: true, modesetNote: null });
        expect(s.command).toContain('pacman');
    });
    it('NVIDIA + driver missing + modeset off -> install AND the modeset note', () => {
        const s = status(probe({ nvidiaDrmModeset: false }), 'missing_driver');
        expect(s.state).toBe('install');
        expect(s.modesetNote).toBe(NVIDIA_MODESET_NOTE);
        expect(NVIDIA_MODESET_NOTE).toContain('nvidia_drm.modeset=1');
    });
    it('driver present, modeset off -> modeset (no install button)', () => {
        const s = status(probe({ nvidiaVaapiDriver: true, nvidiaDrmModeset: false }), 'no_modeset');
        expect(s).toMatchObject({ state: 'modeset', canInstall: false });
        expect(s.modesetNote).toBe(NVIDIA_MODESET_NOTE);
    });
    it('driver installed since launch, modeset fine -> restart', () => {
        expect(status(probe({ nvidiaVaapiDriver: true }), 'missing_driver')).toMatchObject({ state: 'restart', canInstall: false, modesetNote: null });
    });
    it('AMD / Intel / hybrid / nouveau never prompt', () => {
        for (const gpus of [
            [{ vendor: 'amd', driver: 'amdgpu' }], [{ vendor: 'intel', driver: 'i915' }],
            [{ vendor: 'intel', driver: 'i915' }, { vendor: 'nvidia', driver: 'nvidia' }],
            [{ vendor: 'nvidia', driver: 'nouveau' }],
        ] as LinuxGpuProbe['gpus'][]) {
            // Even if a launch state somehow said missing_driver, the machine facts veto it.
            expect(status(probe({ gpus }), 'missing_driver').state).toBe('none');
        }
        expect(status(probe({ gpus: [{ vendor: 'amd', driver: 'amdgpu' }] }), 'not_applicable').state).toBe('none');
    });
    it('driver already working (ready) / forced / hybrid launch states never prompt', () => {
        for (const st of ['ready', 'forced', 'hybrid', 'nouveau', 'not_applicable'] as NvidiaDecodeState[]) {
            expect(status(probe({ nvidiaVaapiDriver: true }), st).state).toBe('none');
        }
    });
    it('hardware decode switched off, non-Linux or no probe -> none', () => {
        expect(status(probe(), 'missing_driver', false).state).toBe('none');
        expect(status(probe(), 'missing_driver', true, 'win32').state).toBe('none');
        expect(status(null, 'missing_driver').state).toBe('none');
    });
    it('wire shape guard', () => {
        expect(isNvidiaVaapiStatus(status(probe(), 'missing_driver'))).toBe(true);
        expect(isNvidiaVaapiStatus({ state: 'install' })).toBe(false);
    });
});

describe('distro -> package / command mapping', () => {
    const cases: Array<[string, string[], string, string]> = [
        ['ubuntu', ['debian'], 'nvidia-vaapi-driver', 'apt'],
        ['linuxmint', ['ubuntu', 'debian'], 'nvidia-vaapi-driver', 'apt'],
        ['debian', [], 'nvidia-vaapi-driver', 'apt'],
        ['arch', [], 'libva-nvidia-driver', 'pacman'],
        ['cachyos', ['arch'], 'libva-nvidia-driver', 'pacman'],
        ['fedora', [], 'nvidia-vaapi-driver', 'dnf'],
    ];
    it.each(cases)('%s', (id, like, pkg, tool) => {
        const p = nvidiaVaapiPackage({ id, like });
        expect(p.pkg).toBe(pkg);
        expect(p.install).toContain(tool);
    });
    it('an unknown distro still gets a literal package name, never anything from outside the table', () => {
        expect(nvidiaVaapiPackage({ id: 'weird; rm -rf /', like: [] }).pkg).toBe('nvidia-vaapi-driver');
    });
});

// A scripted PackageKit: each CreateTransaction hands out a path; the call then replays signals.
function fakeBus(script: { resolve?: Array<[number, string]>; install?: { exit?: number; error?: [string, string] }; createError?: string; callError?: Record<string, string> }) {
    const log: Array<{ member: string; body: unknown[] }> = [];
    const handlers = new Map<string, (s: PkSignal) => void>();
    let n = 0; let closed = false;
    const bus: PackageKitBus = {
        createTransaction: async () => { if (script.createError) throw new Error(script.createError); return `/tx/${++n}`; },
        callTransaction: async (p, member, _sig, body) => {
            log.push({ member, body });
            if (script.callError?.[member]) throw new Error(script.callError[member]);
            const h = handlers.get(p)!;
            setTimeout(() => {
                if (member === 'Resolve') { for (const [info, id] of script.resolve ?? []) h({ member: 'Package', body: [info, id, 'summary'] }); h({ member: 'Finished', body: [1, 0] }); }
                else {
                    if (script.install?.error) h({ member: 'ErrorCode', body: script.install.error });
                    h({ member: 'Finished', body: [script.install?.exit ?? 1, 0] });
                }
            }, 0);
        },
        onSignal: (p, h) => { handlers.set(p, h); return () => handlers.delete(p); },
        close: () => { closed = true; },
    };
    return { bus, log, isClosed: () => closed };
}

describe('installViaPackageKit', () => {
    it('Resolve then InstallPackages with the resolved id and the ONLY_TRUSTED flag', async () => {
        const f = fakeBus({ resolve: [[2, 'nvidia-vaapi-driver;0.0.13-1;amd64;ubuntu']] });
        expect(await installViaPackageKit(f.bus, 'nvidia-vaapi-driver')).toBe('installed');
        expect(f.log.map(l => l.member)).toEqual(['Resolve', 'InstallPackages']);
        expect(f.log[0].body[1]).toEqual(['nvidia-vaapi-driver']);
        expect(f.log[1].body).toEqual([2, ['nvidia-vaapi-driver;0.0.13-1;amd64;ubuntu']]);
        expect(f.isClosed()).toBe(true);
    });
    it('Resolve finds nothing -> not_found and InstallPackages is never called (command fallback)', async () => {
        const f = fakeBus({ resolve: [] });
        expect(await installViaPackageKit(f.bus, 'nvidia-vaapi-driver')).toBe('not_found');
        expect(f.log.map(l => l.member)).toEqual(['Resolve']);
    });
    it('only an exact name match is installable; installed ones are skipped', () => {
        expect(pickInstallablePackageId([{ info: 2, id: 'nvidia-vaapi-driver-extra;1;x;y' }], 'nvidia-vaapi-driver')).toBeNull();
        expect(pickInstallablePackageId([{ info: 1, id: 'nvidia-vaapi-driver;1;x;installed' }], 'nvidia-vaapi-driver')).toBeNull();
        expect(pickInstallablePackageId([{ info: 2, id: 'nvidia-vaapi-driver;1;x;y' }], 'nvidia-vaapi-driver')).toBe('nvidia-vaapi-driver;1;x;y');
    });
    it('already installed -> installed without a second transaction', async () => {
        const f = fakeBus({ resolve: [[1, 'nvidia-vaapi-driver;1;x;installed']] });
        expect(await installViaPackageKit(f.bus, 'nvidia-vaapi-driver')).toBe('installed');
        expect(f.log).toHaveLength(1);
    });
    it('polkit refusal / cancel -> denied', async () => {
        expect(await installViaPackageKit(fakeBus({ resolve: [[2, 'p;1;x;y']], install: { exit: 4, error: ['not-authorized', 'nope'] } }).bus, 'p')).toBe('denied');
        expect(await installViaPackageKit(fakeBus({ resolve: [[2, 'p;1;x;y']], install: { exit: 3 } }).bus, 'p')).toBe('denied');
        expect(await installViaPackageKit(fakeBus({ resolve: [[2, 'p;1;x;y']], callError: { InstallPackages: 'org.freedesktop.DBus.Error.AccessDenied: no' } }).bus, 'p')).toBe('denied');
    });
    it('PackageKit unavailable -> unavailable (fallback to the command)', async () => {
        const f = fakeBus({ createError: 'org.freedesktop.DBus.Error.ServiceUnknown' });
        expect(await installViaPackageKit(f.bus, 'p')).toBe('unavailable');
        expect(f.isClosed()).toBe(true);
    });
    it('another PackageKit failure -> failed', async () => {
        expect(await installViaPackageKit(fakeBus({ resolve: [[2, 'p;1;x;y']], install: { exit: 2, error: ['dep-resolution-failed', 'x'] } }).bus, 'p')).toBe('failed');
    });
});

describe('installNvidiaVaapiDriver (the IPC body)', () => {
    const inst: NvidiaVaapiStatus = { state: 'install', pkg: 'libva-nvidia-driver', command: 'sudo pacman -S libva-nvidia-driver', modesetNote: null, canInstall: true };
    it('takes no renderer input: declared arity 1 (deps only); extra arguments are ignored and the package is the status one', async () => {
        expect(installNvidiaVaapiDriver.length).toBe(1);
        const f = fakeBus({ resolve: [[2, 'libva-nvidia-driver;1;x;y']] });
        let calls = 0;
        const evil = installNvidiaVaapiDriver as unknown as (d: unknown, pkg: string) => ReturnType<typeof installNvidiaVaapiDriver>;
        const r = await evil({ status: () => (calls++ === 0 ? inst : { ...inst, state: 'restart', canInstall: false }), busFactory: () => f.bus }, 'rm -rf /; evil-package');
        expect(r.outcome).toBe('installed');
        expect(f.log[0].body[1]).toEqual(['libva-nvidia-driver']);
        expect(JSON.stringify(f.log)).not.toContain('evil');
        expect(r.status.state).toBe('restart');
    });
    it('nothing to offer -> unsupported, no bus opened', async () => {
        let opened = false;
        const r = await installNvidiaVaapiDriver({ status: () => ({ ...inst, state: 'none', pkg: '', canInstall: false }), busFactory: () => { opened = true; return null; } });
        expect(r.outcome).toBe('unsupported');
        expect(opened).toBe(false);
    });
    it('no system bus -> unavailable', async () => {
        expect((await installNvidiaVaapiDriver({ status: () => inst, busFactory: () => null })).outcome).toBe('unavailable');
    });
    it('a second install while one runs -> busy', async () => {
        const slow: PackageKitBus = { createTransaction: () => new Promise(() => { /* never */ }), callTransaction: async () => { /* */ }, onSignal: () => () => { /* */ }, close: () => { /* */ } };
        void installNvidiaVaapiDriver({ status: () => inst, busFactory: () => slow });
        await new Promise(r => setTimeout(r, 5));
        expect((await installNvidiaVaapiDriver({ status: () => inst, busFactory: () => slow })).outcome).toBe('busy');
    });
});

describe('wiring: nothing the renderer says reaches the package choice', () => {
    const read = (p: string) => fs.readFileSync(path.join(__dirname, p), 'utf8');
    it('main.ts handlers ignore their arguments', () => {
        const main = read('main.ts');
        expect(main).toMatch(/ipcMain\.handle\('linux:nvidia-vaapi-install', \(\) => installNvidiaVaapiDriver\(\{ status: nvidiaVaapiStatus \}\)\)/);
        expect(main).toMatch(/ipcMain\.handle\('linux:nvidia-vaapi-status', \(\) => nvidiaVaapiStatus\(\)\)/);
    });
    it('preload forwards no argument', () => {
        const pre = read('preload.ts');
        expect(pre).toContain("installNvidiaVaapiDriver: (): Promise<unknown> => ipcRenderer.invoke('linux:nvidia-vaapi-install')");
    });
    it('the module never spawns a process or a package manager', () => {
        const src = read('nvidia-vaapi-install.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        expect(src).not.toMatch(/child_process|execFile|spawn\(|pkexec|sudo /);
    });
    it('the .deb Recommends (never Depends) the driver', () => {
        const pkg = JSON.parse(read('../package.json')) as { build: { deb: { recommends?: string[]; depends?: string[] } } };
        expect(pkg.build.deb.recommends).toContain('nvidia-vaapi-driver');
        expect(pkg.build.deb.depends ?? []).not.toContain('nvidia-vaapi-driver');
    });
});
