import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    computeVideoEncodeDriverStatus, detectEncodeGap, installVideoEncodeDriver, isIntelPreGen11, isVideoEncodeDriverStatus, parseListVa,
    videoEncodeFix, NONE_ENCODE_STATUS, type EncodeGap, type VaNodeReport, type VideoEncodeDriverStatus,
} from './video-encode-driver';
import { computeNvidiaVaapiStatus, type NvidiaVaapiStatus, type PackageKitBus, type PkSignal } from './nvidia-vaapi-install';

const IHD = 'Intel iHD driver for Intel(R) Gen Graphics - 24.1.0 ()';
const MESA = 'Mesa Gallium driver 24.0 for AMD Radeon RX 6600';
const GEN9 = 0x3e92;      // Coffee Lake UHD 630
const GEN12 = 0x9a49;     // Tiger Lake
const node = (o: Partial<VaNodeReport>): VaNodeReport => ({ vendorId: 0x8086, deviceId: GEN9, kernelDriver: 'i915', vendorString: IHD, encodeEntrypoints: [], ...o });
const intelLpOnly = node({ encodeEntrypoints: ['EncSliceLP'] });
const intelFull = node({ encodeEntrypoints: ['EncSlice', 'EncSliceLP'] });
const intelDecodeOnly = node({});
const amdDecodeOnly = node({ vendorId: 0x1002, deviceId: 0x73ff, kernelDriver: 'amdgpu', vendorString: MESA });
const amdEncodes = { ...amdDecodeOnly, encodeEntrypoints: ['EncSlice'] };
const nvidiaNode = node({ vendorId: 0x10de, kernelDriver: 'nvidia', vendorString: '' });

const NV_NONE: NvidiaVaapiStatus = { state: 'none', pkg: '', command: '', modesetNote: null, canInstall: false };
const NV_INSTALL: NvidiaVaapiStatus = { state: 'install', pkg: 'nvidia-vaapi-driver', command: 'x', modesetNote: null, canInstall: true };
const ubuntu = { id: 'ubuntu', like: ['debian'] };
const debian = { id: 'debian', like: [] };
const fedora = { id: 'fedora', like: [] };
const arch = { id: 'arch', like: [] };
const cachy = { id: 'cachyos', like: ['arch'] };
const tumbleweed = { id: 'opensuse-tumbleweed', like: ['opensuse', 'suse'] };

/** First probe = the baseline; "now" can differ (after an install). */
function status(distro: { id: string; like: string[] }, launch: VaNodeReport[] | null, now: VaNodeReport[] | null = launch, o: { nvidia?: NvidiaVaapiStatus; enabled?: boolean; platform?: string } = {}): VideoEncodeDriverStatus {
    return computeVideoEncodeDriverStatus({
        platform: o.platform ?? 'linux', distro, nodesNow: now, launchGap: detectEncodeGap(launch),
        encodeEnabledAtLaunch: o.enabled ?? true, nvidia: o.nvidia ?? NV_NONE,
    });
}

describe('detection matrix', () => {
    it('Ubuntu + Intel Gen9 (LP only) -> install intel-media-va-driver-non-free, multiverse hint', () => {
        const s = status(ubuntu, [intelLpOnly]);
        expect(s).toMatchObject({ state: 'install', vendor: 'intel', pkg: 'intel-media-va-driver-non-free', canInstall: false });
        expect(s.command).toBe('sudo apt install intel-media-va-driver-non-free');
        expect(s.repoHint).toContain('multiverse');
    });
    it('Debian + Intel Gen9 -> same package, non-free hint', () => {
        const s = status(debian, [intelLpOnly]);
        expect(s).toMatchObject({ state: 'install', pkg: 'intel-media-va-driver-non-free', canInstall: false });
        expect(s.repoHint).toContain('non-free');
    });
    it('Fedora + AMD decode-only -> mesa-va-drivers-freeworld + RPM Fusion hint, no one-click (it is a swap)', () => {
        const s = status(fedora, [amdDecodeOnly]);
        expect(s).toMatchObject({ state: 'install', vendor: 'amd', pkg: 'mesa-va-drivers-freeworld', canInstall: false });
        expect(s.command).toContain('mesa-va-drivers-freeworld');
        expect(s.repoHint).toContain('RPM Fusion');
    });
    it('Fedora + Intel decode-only -> intel-media-driver + RPM Fusion hint', () => {
        const s = status(fedora, [intelDecodeOnly]);
        expect(s).toMatchObject({ state: 'install', vendor: 'intel', pkg: 'intel-media-driver', canInstall: false });
        expect(s.repoHint).toContain('RPM Fusion');
    });
    it('Fedora + Intel Gen12 decode-only is still a gap (the stock build has no encode at all)', () => {
        expect(status(fedora, [node({ deviceId: GEN12 })]).state).toBe('install');
    });
    it('Arch / CachyOS / Tumbleweed already encode -> none', () => {
        for (const d of [arch, cachy, tumbleweed]) {
            expect(status(d, [intelFull]).state).toBe('none');
            expect(status(d, [amdEncodes]).state).toBe('none');
        }
        // ...and even a (hypothetical) decode-only node on a distro with no known fix gets no prompt.
        for (const d of [arch, cachy, tumbleweed]) expect(status(d, [intelDecodeOnly]).state).toBe('none');
    });
    it('encode already present -> none', () => {
        expect(status(ubuntu, [intelFull]).state).toBe('none');
        expect(status(fedora, [amdEncodes]).state).toBe('none');
    });
    it('Intel Gen11+ with only LP (every distro) is not a gap on Ubuntu/Debian', () => {
        expect(status(ubuntu, [node({ deviceId: GEN12, encodeEntrypoints: ['EncSliceLP'] })]).state).toBe('none');
        expect(isIntelPreGen11(GEN9)).toBe(true);
        expect(isIntelPreGen11(GEN12)).toBe(false);
    });
    it('AMD on Ubuntu/Debian has no known package -> none', () => {
        expect(status(ubuntu, [amdDecodeOnly]).state).toBe('none');
        expect(status(debian, [amdDecodeOnly]).state).toBe('none');
    });
    it('NVIDIA-only machine: this card never shows, the NVIDIA one does', () => {
        expect(status(ubuntu, [nvidiaNode]).state).toBe('none');
        const nv = computeNvidiaVaapiStatus({
            platform: 'linux', decodeEnabledAtLaunch: true, launchNvidia: 'missing_driver',
            probe: { gpus: [{ vendor: 'nvidia', driver: 'nvidia' }], nvidiaVaapiDriver: false, nvidiaDrmModeset: true, distro: ubuntu },
        });
        expect(nv.state).toBe('install');
    });
    it('SINGLE-CARD RULE: while the NVIDIA card has something to say, this one is silent', () => {
        expect(status(ubuntu, [intelLpOnly], [intelLpOnly], { nvidia: NV_INSTALL })).toEqual(NONE_ENCODE_STATUS);
        expect(status(ubuntu, [intelLpOnly], [intelLpOnly], { nvidia: { ...NV_INSTALL, state: 'restart' } })).toEqual(NONE_ENCODE_STATUS);
        expect(status(ubuntu, [intelLpOnly], [intelLpOnly], { nvidia: NV_NONE }).state).toBe('install');
    });
    it('hybrid Intel + NVIDIA: the Intel gap is reported (the NVIDIA card is none there by its own rules)', () => {
        expect(status(ubuntu, [intelLpOnly, nvidiaNode]).state).toBe('install');
    });
    it('i965 (no iHD) is never steered to a package', () => {
        expect(status(ubuntu, [node({ vendorString: 'Intel i965 driver for Intel(R) Skylake - 2.4.1' })]).state).toBe('none');
    });
    it('no VA driver at all (vaInitialize failed) is not a decode-works case', () => {
        expect(status(fedora, [node({ vendorString: '' })]).state).toBe('none');
    });
    it('a node that encodes anywhere wins over a decode-only one', () => {
        expect(status(ubuntu, [intelLpOnly, amdEncodes]).state).toBe('none');
    });
    it('not Linux, helper cannot tell, encode switched off, unknown os-release -> none', () => {
        expect(status(ubuntu, [intelLpOnly], [intelLpOnly], { platform: 'win32' }).state).toBe('none');
        expect(status(ubuntu, null).state).toBe('none');
        expect(status(ubuntu, [intelLpOnly], [intelLpOnly], { enabled: false }).state).toBe('none');
        expect(computeVideoEncodeDriverStatus({ platform: 'linux', distro: null, nodesNow: [intelLpOnly], launchGap: { vendor: 'intel' }, encodeEnabledAtLaunch: true, nvidia: NV_NONE }).state).toBe('none');
    });
    it('installed since launch -> restart; a failed probe afterwards is not evidence', () => {
        expect(status(ubuntu, [intelLpOnly], [intelFull])).toMatchObject({ state: 'restart', canInstall: false, pkg: 'intel-media-va-driver-non-free' });
        expect(status(ubuntu, [intelLpOnly], null).state).toBe('none');
    });
    it('a machine that was fine at launch stays none', () => {
        expect(status(ubuntu, [intelFull], [intelLpOnly]).state).toBe('none');
    });
});

describe('the package is chosen in main, never by the renderer', () => {
    it('the table is a fixed set of literals; unknown distros get nothing', () => {
        const all = new Set<string>();
        for (const d of [ubuntu, debian, fedora, { id: 'nobara', like: ['fedora'] }, { id: 'linuxmint', like: ['ubuntu', 'debian'] }]) {
            for (const v of ['intel', 'amd'] as const) { const f = videoEncodeFix(d, v); if (f) all.add(f.pkg); }
        }
        expect([...all].sort()).toEqual(['intel-media-driver', 'intel-media-va-driver-non-free', 'mesa-va-drivers-freeworld']);
        expect(videoEncodeFix({ id: 'gentoo', like: [] }, 'intel')).toBeNull();
        expect(videoEncodeFix(arch, 'intel')).toBeNull();
    });
    it('the IPC bodies take no argument and the bridge exposes none (NEGATIVE)', () => {
        const preload = fs.readFileSync(path.join(__dirname, 'preload.ts'), 'utf8');
        expect(preload).toMatch(/getVideoEncodeDriverStatus: \(\): Promise<unknown>/);
        expect(preload).toMatch(/installVideoEncodeDriver: \(\): Promise<unknown>/);
        const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
        expect(main).toMatch(/ipcMain\.handle\('linux:video-encode-driver-install', \(\) =>/);
        expect(main).toMatch(/ipcMain\.handle\('linux:video-encode-driver-status', \(\) =>/);
        // no handler parameter is ever read for this channel
        const i = main.indexOf("'linux:video-encode-driver-install'");
        expect(main.slice(i, i + 140)).not.toMatch(/\(_?e(vent)?\b|raw|payload/);
    });
    // Every encode fix is command-only (2026-11-11): Fedora needs a swap, and on Ubuntu/Debian the non-free driver
    // REPLACES the installed free one, which a trusted-only PackageKit install may refuse or half-do.
    it('no distro is ever installed through PackageKit for the encode driver (NEGATIVE), whatever a caller passes', async () => {
        const seen: string[] = [];
        for (const st of [status(ubuntu, [intelLpOnly]), status(fedora, [intelDecodeOnly]), NONE_ENCODE_STATUS]) {
            const r = await installVideoEncodeDriver({
                status: async () => st,
                busFactory: () => fakeBus(seen),
                // @ts-expect-error extra input is not part of the contract
                pkg: 'evil',
            });
            expect(r.outcome).toBe('unsupported');
        }
        expect(seen).toEqual([]);
    });
});

describe('helper report parsing', () => {
    const good = JSON.stringify([{ node: '/dev/dri/renderD128', vendor_id: '0x8086', device_id: '0x3e92', kernel_driver: 'i915', vendor_string: IHD, va: '1.20', usable: 1, note: '',
        candidates: [{ profile: 'Main', entrypoint: 'EncSliceLP' }, { profile: 'Main', entrypoint: 'weird' }] }]);
    it('parses the --list-va shape', () => {
        expect(parseListVa(good)).toEqual([{ vendorId: 0x8086, deviceId: 0x3e92, kernelDriver: 'i915', vendorString: IHD, encodeEntrypoints: ['EncSliceLP'] }]);
    });
    it('malformed or hostile output means "cannot tell"', () => {
        for (const bad of ['', 'nope', '{"error":"x"}', '[1]', JSON.stringify(new Array(40).fill({}))]) expect(parseListVa(bad)).toBeNull();
    });
    it('wire shape guard', () => {
        expect(isVideoEncodeDriverStatus(status(ubuntu, [intelLpOnly]))).toBe(true);
        expect(isVideoEncodeDriverStatus({ state: 'install' })).toBe(false);
    });
    it('the gap type is just a vendor', () => { const g: EncodeGap | null = detectEncodeGap([intelLpOnly]); expect(g).toEqual({ vendor: 'intel' }); });
});

/** A PackageKit fake: Resolve answers with `pkg` (or nothing), InstallPackages succeeds. Records installed names. */
function fakeBus(installed: string[], o: { resolveFinds?: boolean } = {}): PackageKitBus {
    const handlers = new Map<string, (s: PkSignal) => void>();
    let n = 0;
    return {
        createTransaction: async () => `/tx${++n}`,
        callTransaction: async (p, member, _sig, body) => {
            const h = handlers.get(p)!;
            queueMicrotask(() => {
                if (member === 'Resolve') {
                    const name = (body[1] as string[])[0];
                    if (o.resolveFinds !== false) h({ member: 'Package', body: [2, `${name};1.0;amd64;repo`, ''] });
                    h({ member: 'Finished', body: [1, 0] });
                } else {
                    const id = (body[1] as string[])[0];
                    installed.push(id.split(';')[0]);
                    h({ member: 'Finished', body: [1, 0] });
                }
            });
        },
        onSignal: (p, h) => { handlers.set(p, h); return () => handlers.delete(p); },
        close: () => { /* nothing */ },
    };
}
