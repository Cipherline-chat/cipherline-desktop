import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { UNGUARDED_IPC_CHANNELS } from './ipc-guard';

/**
 * Source-level pins for the screen-share power / foreground work. main.ts and
 * share_power.cc cannot run under vitest (Electron; Win32), so this reads them:
 * the decisions are tested in share-power.test.ts / share-foreground.test.ts,
 * this proves the wiring makes them and that the native file keeps every Win32
 * call behind `#ifdef _WIN32`.
 */
const read = (...p: string[]) => fs.readFileSync(path.resolve(__dirname, '..', ...p), 'utf8');
const NATIVE = read('src-native', 'share_power.cc');
const MAIN = read('electron', 'main.ts');
const PRELOAD = read('electron', 'preload.ts');
const SHARE_BOOST = read('electron', 'share-boost.ts');
const GYP = read('binding.gyp');
const ADDON_WIN = read('src-native', 'audio_capture.cc');
const ADDON_MAC = read('src-native', 'audio_capture_mac.mm');

// ── The _WIN32 guard checker ───────────────────────────────────────────────

/** Source with comments and string literals blanked, line structure kept. */
function stripCommentsAndStrings(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, '')
        .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
        .replace(/L'(?:\\.|[^'\\\n])*'/g, "''");
}

/** Win32-only identifiers: none may appear outside an `#ifdef _WIN32` region. */
const WIN32_ONLY = [
    'OpenProcess', 'CloseHandle', 'SetProcessInformation', 'GetProcAddress', 'GetModuleHandleW',
    'timeBeginPeriod', 'timeEndPeriod', 'SHQueryUserNotificationState', 'GetForegroundWindow',
    'QueryFullProcessImageNameW', 'CreateToolhelp32Snapshot', 'Process32FirstW', 'MonitorFromWindow',
    'GetMonitorInfoW', 'GetClassNameW', 'GetWindowRect', 'GetWindowThreadProcessId', 'GetCurrentProcessId',
    'GetLastError', 'WideCharToMultiByte', 'IsWindow', 'GetDesktopWindow', 'GetShellWindow', 'GetAncestor', 'GA_ROOT',
    'DWORD', 'HWND', 'HANDLE', 'HMONITOR', 'HRESULT', 'QUERY_USER_NOTIFICATION_STATE', 'ERROR_INVALID_PARAMETER',
    // The D3DKMT GPU scheduling class (gdi32 thunks, resolved at run time).
    'LoadLibraryExW', 'LOAD_LIBRARY_SEARCH_SYSTEM32', 'PROCESS_SET_INFORMATION', 'ERROR_CALL_NOT_IMPLEMENTED', 'APIENTRY',
];

/** Every Win32-only identifier use that is NOT inside `#ifdef _WIN32` (line numbers, 1-based). */
function unguardedWin32Uses(src: string): string[] {
    const lines = stripCommentsAndStrings(src).split('\n');
    const stack: Array<'win' | 'nonwin' | 'other'> = [];
    const bad: string[] = [];
    lines.forEach((line, i) => {
        const t = line.trim();
        if (/^#\s*ifdef\s+_WIN32\b/.test(t)) stack.push('win');
        else if (/^#\s*if(n?def)?\b/.test(t)) stack.push('other');
        else if (/^#\s*else\b/.test(t)) {
            const top = stack.pop();
            stack.push(top === 'win' ? 'nonwin' : top ?? 'other');
        } else if (/^#\s*endif\b/.test(t)) stack.pop();
        else if (/^#\s*include\s*<(windows|mmsystem|shellapi|tlhelp32)\.h>/.test(t) && !stack.includes('win')) {
            bad.push(`${i + 1}: ${t}`);
        }
        if (stack.includes('win')) return;
        for (const id of WIN32_ONLY) {
            if (new RegExp(`\\b${id}\\b`).test(line)) bad.push(`${i + 1}: ${id}`);
        }
    });
    return bad;
}

describe('share_power.cc keeps every Win32 call behind #ifdef _WIN32', () => {
    it('no Win32-only identifier or Windows header outside a _WIN32 region', () => {
        expect(unguardedWin32Uses(NATIVE)).toEqual([]);
    });

    it('positive control: the checker catches a call that was moved out of the guard', () => {
        const broken = NATIVE.replace('napi_value SetTimerResolution(', 'static void Leak() { timeBeginPeriod(1); }\nnapi_value SetTimerResolution(');
        expect(unguardedWin32Uses(broken).some(x => x.includes('timeBeginPeriod'))).toBe(true);
        const brokenInclude = NATIVE.replace('#include <node_api.h>', '#include <node_api.h>\n#include <windows.h>');
        expect(unguardedWin32Uses(brokenInclude).some(x => x.includes('windows.h'))).toBe(true);
        // ...and the #else half of a function body counts as unguarded:
        const brokenElse = NATIVE.replace(/#else\n {4}return result;/,'#else\n    OpenProcess(0, 0, 0);\n    return result;');
        expect(unguardedWin32Uses(brokenElse).some(x => x.includes('OpenProcess'))).toBe(true);
    });

    it('every export has a non-Windows branch that returns a harmless value', () => {
        for (const fn of ['SetProcessPowerThrottling', 'GetForegroundInfo', 'GetWindowExe', 'SetTimerResolution', 'SetGpuSchedulingPriority', 'GetGpuSchedulingPriority']) {
            const start = NATIVE.indexOf(`napi_value ${fn}(`);
            expect(start, fn).toBeGreaterThan(-1);
            const end = NATIVE.indexOf('\n}\n', start);
            const body = NATIVE.slice(start, end);
            expect(body, fn).toMatch(/#ifdef _WIN32/);
            expect(body, fn).toMatch(/#else\n\s*return (result|Null\(env\)|Bool\(env, false\));\n#endif/);
        }
    });

    it('registers exactly the six exports, and both addons call the registration from Init', () => {
        for (const name of ['setProcessPowerThrottling', 'getForegroundInfo', 'getWindowExe', 'setTimerResolution', 'setGpuSchedulingPriority', 'getGpuSchedulingPriority']) {
            expect(NATIVE).toContain(`Export(env, exports, "${name}"`);
        }
        expect(NATIVE.match(/Export\(env, exports, "/g)?.length).toBe(6);
        expect(ADDON_WIN).toMatch(/RegisterWindowGeometry\(env, exports\);\s*RegisterSharePower\(env, exports\);/);
        expect(ADDON_MAC).toMatch(/RegisterWindowGeometry\(env, exports\);\s*RegisterSharePower\(env, exports\);/);
    });

    it('opts OUT of both throttles (state bits clear), opens with PROCESS_SET_INFORMATION, resolves SetProcessInformation at run time', () => {
        expect(NATIVE).toContain('OpenProcess(PROCESS_SET_INFORMATION, FALSE, pid)');
        expect(NATIVE).toContain('state.StateMask = 0;');
        expect(NATIVE).toMatch(/enabled \? 0 : \(kThrottlingExecutionSpeed \| kThrottlingIgnoreTimerResolution\)/);
        expect(NATIVE).toContain('GetProcAddress(kernel, "SetProcessInformation")');
        expect(NATIVE).toContain('constexpr int kProcessPowerThrottlingClass = 4;');
        expect(NATIVE).toContain('constexpr ULONG kThrottlingCurrentVersion = 1;');
        expect(NATIVE).toContain('constexpr ULONG kThrottlingExecutionSpeed = 0x1;');
        expect(NATIVE).toContain('constexpr ULONG kThrottlingIgnoreTimerResolution = 0x4;');
    });

    it('only ever touches this process or its direct children, and never ends a timer period it did not begin', () => {
        expect(NATIVE).toMatch(/if \(!IsOurProcess\(pid\)\)/);
        expect(NATIVE).toContain('ours = entry.th32ParentProcessID == self;');
        expect(NATIVE).toMatch(/if \(g_timerHolds\[ms\] <= 0\) return Bool\(env, false\);/);
    });

    it('the foreground probe returns a program BASENAME, booleans and rectangles - no title or handle API', () => {
        expect(NATIVE).not.toMatch(/GetWindowText|InternalGetWindowText|SendMessage|SetWindowsHookEx|ReadProcessMemory|WriteProcessMemory|CreateRemoteThread/);
        expect(NATIVE).toContain('QueryFullProcessImageNameW');
        expect(NATIVE).toMatch(/if \(buf\[i\] == L'\\\\' \|\| buf\[i\] == L'\/'\) base = buf \+ i \+ 1;/);
        for (const key of ['notificationState', 'fgExe', 'fgCoversMonitor', 'fgIsCipherline', 'fgMonitor']) {
            expect(NATIVE).toContain(`"${key}"`);
        }
    });

    it('the build links what the new calls need, on Windows only', () => {
        const gyp = JSON.parse(GYP.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')).targets[0];
        const win = gyp.conditions.find((c: [string, unknown]) => c[0] === "OS=='win'")[1];
        expect(win.libraries).toEqual(expect.arrayContaining(['-lwinmm.lib', '-lshell32.lib']));
        expect(JSON.stringify(gyp.sources)).toContain('src-native/share_power.cc');
        const others = gyp.conditions.filter((c: [string, unknown]) => c[0] !== "OS=='win'");
        expect(JSON.stringify(others)).not.toMatch(/winmm|shell32/);
    });
});

describe('main.ts wiring', () => {
    function handlerSource(channel: string): string {
        const start = MAIN.indexOf(`ipcMain.handle('${channel}'`);
        expect(start, `no ipcMain.handle registration for '${channel}'`).toBeGreaterThan(-1);
        const open = MAIN.indexOf('(', start);
        let depth = 0;
        for (let i = open; i < MAIN.length; i++) {
            if (MAIN[i] === '(') depth++;
            else if (MAIN[i] === ')' && --depth === 0) return MAIN.slice(open, i + 1);
        }
        throw new Error(`unbalanced parentheses in '${channel}'`);
    }

    it('the opt-out is built into the ONE share controller, from the live addon, for this process', () => {
        expect(MAIN).toContain('new PowerThrottleOptOut({');
        expect(MAIN).toContain('native: () => audioCaptureAddon,');
        expect(MAIN).toContain('selfPid: process.pid,');
        expect(MAIN).toContain("listProcesses: () => app.getAppMetrics().map(m => ({ pid: m.pid, type: m.type })),\n  selfPid");
        expect(MAIN.match(/new PowerThrottleOptOut\(/g)?.length).toBe(1);
    });

    it('results go to the renderer (the call event log lives there) on share:power', () => {
        expect(MAIN).toContain("mainWindow.webContents.send('share:power', r)");
        expect(PRELOAD).toContain("ipcRenderer.on('share:power', listener)");
        expect(PRELOAD.match(/share:power/g)?.length).toBe(2);   // on + removeListener
    });

    it('a short re-apply timer runs only while the opt-out is held, and is cleared with it', () => {
        expect(MAIN).toContain('if (sharePriority.throttleActive && !shareThrottleTimer) {');
        expect(MAIN).toContain('setInterval(() => sharePriority.tickThrottle(), SHARE_THROTTLE_REAPPLY_MS)');
        expect(MAIN).toContain('} else if (!sharePriority.throttleActive && shareThrottleTimer) {');
        expect(MAIN).toContain('clearInterval(shareThrottleTimer);');
    });

    it('restore rides the same paths as the priority boost: navigation, renderer crash, quit', () => {
        // Each of these already calls syncCallPriority({ inCall:false, sharing:false }) (share-boost.wiring.test.ts);
        // that reaches ShareBoostController.setSharing(false) -> PowerThrottleOptOut.setActive(false).
        expect(SHARE_BOOST).toContain('this.throttle?.setActive(this.active);');
        expect(MAIN).toMatch(/app\.on\('before-quit', \(\) => \{\n {2}\/\/ Gaming-video priority boost: restore before the processes start exiting\.\n {2}syncCallPriority\(\{ inCall: false, sharing: false \}\);/);
    });

    it('share:get-foreground-info validates first, is Windows-only, and is a guarded handler', () => {
        const body = handlerSource('share:get-foreground-info');
        expect(body.indexOf('validateForegroundRequest(sourceId)')).toBeGreaterThan(-1);
        expect(body.indexOf("process.platform !== 'win32'")).toBeGreaterThan(body.indexOf('validateForegroundRequest'));
        expect(body).toContain('describeForeground({');
        expect(UNGUARDED_IPC_CHANNELS.has('share:get-foreground-info')).toBe(false);
        expect(MAIN.indexOf("ipcMain.handle('share:get-foreground-info'")).toBeGreaterThan(MAIN.indexOf('installIpcSenderGuard();'));
    });

    it('share:find-window-source validates first, is Windows-only, and is a guarded handler', () => {
        const body = handlerSource('share:find-window-source');
        expect(body.indexOf('validateFindWindowRequest(exe, ids)')).toBeGreaterThan(-1);
        expect(body).toContain("process.platform !== 'win32'");
        expect(body).toContain('pickWindowByExe(candidates, req.exe)');
        expect(UNGUARDED_IPC_CHANNELS.has('share:find-window-source')).toBe(false);
        expect(MAIN.indexOf("ipcMain.handle('share:find-window-source'")).toBeGreaterThan(MAIN.indexOf('installIpcSenderGuard();'));
    });

    it('the preload bridge is three narrow channels and nothing is opened or executed from them', () => {
        expect(PRELOAD).toContain("ipcRenderer.invoke('share:get-foreground-info', sourceId)");
        expect(PRELOAD).toContain("ipcRenderer.invoke('share:find-window-source', exe, windowSourceIds)");
        for (const body of [handlerSource('share:get-foreground-info'), handlerSource('share:find-window-source')]) {
            expect(body).not.toMatch(/shell\.openExternal|execFile|spawn\(|exec\(/);
        }
    });

    it('Electron security posture is untouched', () => {
        expect(MAIN).not.toMatch(/sandbox:\s*false/);
        expect(MAIN).not.toMatch(/nodeIntegration:\s*true/);
        expect(MAIN).not.toMatch(/contextIsolation:\s*false/);
    });

    it('electron/ imports nothing from src/ (the rootDir trap)', () => {
        for (const f of ['share-boost.ts', 'share-foreground.ts']) {
            const src = read('electron', f);
            expect(src, f).not.toMatch(/from '\.\.\/src\//);
        }
    });
});

describe('share_power.cc: the GPU scheduling priority class (D3DKMT)', () => {
    it('resolves both gdi32 thunks at run time (the addon still loads where they are missing)', () => {
        expect(NATIVE).toContain('GetProcAddress(gdi, "D3DKMTSetProcessSchedulingPriorityClass")');
        expect(NATIVE).toContain('GetProcAddress(gdi, "D3DKMTGetProcessSchedulingPriorityClass")');
        expect(NATIVE).toContain('GetModuleHandleW(L"gdi32.dll")');
        // A fallback load must come from System32 only (no DLL search-path planting).
        expect(NATIVE).toContain('LoadLibraryExW(L"gdi32.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32)');
        // ...and the SDK never has to provide them: no import library, no d3dkmthk.h.
        expect(NATIVE).not.toMatch(/#include\s*<d3dkmthk\.h>|gdi32\.lib/);
        const gyp = JSON.parse(GYP.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')).targets[0];
        expect(JSON.stringify(gyp)).not.toMatch(/gdi32/i);
    });

    it('the signatures and the class range match D3DKMT (IDLE 0 .. REALTIME 5)', () => {
        expect(NATIVE).toContain('typedef LONG (APIENTRY *D3dkmtSetPriorityClassFn)(HANDLE, int);');
        expect(NATIVE).toContain('typedef LONG (APIENTRY *D3dkmtGetPriorityClassFn)(HANDLE, int*);');
        expect(NATIVE).toContain('constexpr int kGpuSchedMin = 0;');
        expect(NATIVE).toContain('constexpr int kGpuSchedMax = 5;');
    });

    it('opens the process with SET_INFORMATION | QUERY_LIMITED_INFORMATION and keeps the own-process-or-direct-child guard', () => {
        const set = NATIVE.slice(NATIVE.indexOf('napi_value SetGpuSchedulingPriority('), NATIVE.indexOf('napi_value GetGpuSchedulingPriority('));
        const get = NATIVE.slice(NATIVE.indexOf('napi_value GetGpuSchedulingPriority('), NATIVE.indexOf('napi_value GetForegroundInfo('));
        for (const body of [set, get]) {
            expect(body).toContain('OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid)');
            expect(body).toContain('if (!IsOurProcess(pid))');
            // The guard runs BEFORE the process is opened.
            expect(body.indexOf('IsOurProcess(pid)')).toBeLessThan(body.indexOf('OpenProcess('));
            expect(body).toContain('CloseHandle(h)');
        }
        expect(set).toContain('ParseGpuLevel(env, args[1], &level)');
        expect(set).toContain('status >= 0');   // NT_SUCCESS
    });

    it('rejects a level outside IDLE..REALTIME or a non-integer instead of clamping it', () => {
        const fn = NATIVE.slice(NATIVE.indexOf('bool ParseGpuLevel('), NATIVE.indexOf('napi_value MakeGpuResult('));
        expect(fn).toContain('!(d >= kGpuSchedMin && d <= kGpuSchedMax)');
        expect(fn).toContain('d != static_cast<double>(static_cast<int>(d))');
    });

    it('answers { ok, status, error } (+ level for the read) and null off Windows', () => {
        for (const key of ['"ok"', '"status"', '"error"', '"level"']) expect(NATIVE).toContain(key);
        for (const fn of ['SetGpuSchedulingPriority', 'GetGpuSchedulingPriority']) {
            const start = NATIVE.indexOf(`napi_value ${fn}(`);
            const body = NATIVE.slice(start, NATIVE.indexOf('\n}\n', start));
            expect(body).toMatch(/#else\n\s*return Null\(env\);\n#endif/);
        }
    });

    it('positive control: a D3DKMT call moved out of the guard is caught', () => {
        const broken = NATIVE.replace('napi_value SetGpuSchedulingPriority(', 'static void Leak() { LoadLibraryExW(L"x", nullptr, 0); }\nnapi_value SetGpuSchedulingPriority(');
        expect(unguardedWin32Uses(broken).some(x => x.includes('LoadLibraryExW'))).toBe(true);
    });
});

describe('main.ts wiring: the GPU scheduling class', () => {
    it('is built into the ONE share controller, from the live addon, for this process, and reports on share:gpu-sched', () => {
        expect(MAIN).toContain('new GpuSchedulingBoost({');
        expect(MAIN.match(/new GpuSchedulingBoost\(/g)?.length).toBe(1);
        const at = MAIN.indexOf('new GpuSchedulingBoost({');
        const body = MAIN.slice(at, MAIN.indexOf('}));', at));
        expect(body).toContain('native: () => audioCaptureAddon,');
        expect(body).toContain('selfPid: process.pid,');
        expect(body).toContain('report: (r) => sendShareGpuSched(r),');
        expect(MAIN).toContain("mainWindow.webContents.send('share:gpu-sched', r)");
        expect(PRELOAD).toContain("ipcRenderer.on('share:gpu-sched', listener)");
        expect(PRELOAD.match(/share:gpu-sched/g)?.length).toBe(2);   // on + removeListener
    });

    it('the addon type declares both exports, and the raise/restore ride the existing setSharing(false) paths', () => {
        expect(MAIN).toContain('setGpuSchedulingPriority?(pid: number, level: number): unknown;');
        expect(MAIN).toContain('getGpuSchedulingPriority?(pid: number): unknown;');
        expect(SHARE_BOOST).toContain('this.gpuSched?.setActive(this.active);');
        // Same timer as the power opt-out re-apply: a GPU restart is picked up within seconds.
        expect(SHARE_BOOST).toContain('this.throttle?.tick();\n        this.gpuSched?.tick();');
        expect(SHARE_BOOST).toContain('this.throttle?.active === true || this.gpuSched?.active === true');
    });

    it('REALTIME first, HIGH as the fallback, NORMAL on restore, read back each time', () => {
        expect(SHARE_BOOST).toContain('const rt = this.set(pid, GPU_SCHED_REALTIME);');
        expect(SHARE_BOOST).toContain('if (!rt.ok) last = this.set(pid, GPU_SCHED_HIGH);');
        expect(SHARE_BOOST).toContain('const r = this.set(pid, GPU_SCHED_NORMAL);');
        expect(SHARE_BOOST.match(/this\.get\(pid\)/g)?.length).toBe(2);
    });

    it('the renderer logs it as share_gpu_sched, a kind the event log knows', () => {
        const guard = read('src', 'components', 'call', 'ShareBoostGuard.tsx');
        expect(guard).toContain("logCallEvent('share_gpu_sched', shareGpuSchedEventDetail(r));");
        expect(read('src', 'utils', 'callEventLog.ts')).toContain("'share_gpu_sched',");
    });
});
