/**
 * share_power.cc - Win32 power / timer / foreground probes for the screen-share
 * boost ("Prioritize calls and screen share while gaming",
 * electron/share-boost.ts), linked into the audio_capture addon so there is
 * still exactly one native module to build.
 *
 * Raw N-API, like audio_capture.cc. Everything Win32 sits behind
 * `#ifdef _WIN32`; on every other platform each export is a harmless no-op
 * (returns null / false / { ok: false }) and the JS side never calls them.
 *
 * Exports (registered by RegisterSharePower, called from the addon's Init):
 *
 *   setProcessPowerThrottling(pid: number, enabled: boolean)
 *       -> { ok: boolean, error: number, mask: number }
 *     Windows 11 puts a process whose windows are not foreground/visible into
 *     "execution speed throttling" (EcoQoS: slow cores, low clocks) and
 *     coalesces its timers ("timer resolution" throttling). Chromium's own
 *     feature flag (UseEcoQoSForBackgroundProcess) only covers what CHROMIUM
 *     applies; this is the OS-side switch:
 *       enabled === false  OPT OUT: SetProcessInformation(ProcessPowerThrottling,
 *                          ControlMask = EXECUTION_SPEED | IGNORE_TIMER_RESOLUTION,
 *                          StateMask = 0) - "I take control, and the answer is
 *                          do not throttle".
 *       enabled === true   hand it back to the OS: ControlMask = 0, StateMask = 0
 *                          (system managed - the default every process starts
 *                          in), which is how an opt-out is undone.
 *     `mask` is the ControlMask that was applied (0 on a restore). Older
 *     Windows builds reject the IGNORE_TIMER_RESOLUTION bit with
 *     ERROR_INVALID_PARAMETER; the opt-out then retries with EXECUTION_SPEED
 *     alone (mask 1) so the part that exists there still lands.
 *     `error` is GetLastError() (0 when ok). Two codes are ours: 0x20000001 =
 *     the pid is not this process or one of its direct children (the call
 *     refuses to touch anyone else's process), 120 (ERROR_CALL_NOT_IMPLEMENTED)
 *     = SetProcessInformation does not exist on this Windows. SetProcessInformation
 *     is resolved at run time, so the addon still loads on a Windows (or an
 *     SDK) that predates it.
 *
 *   getForegroundInfo()
 *       -> { notificationState, fgExe, fgCoversMonitor, fgIsCipherline,
 *            fgMonitor: {x,y,width,height} | null } | null
 *     What owns the screen right now, for the "is a fullscreen game bypassing
 *     DWM composition" question. notificationState is
 *     SHQueryUserNotificationState() as the enum's name (QUNS_RUNNING_D3D_FULL_SCREEN,
 *     QUNS_BUSY, QUNS_PRESENTATION_MODE, QUNS_ACCEPTS_NOTIFICATIONS, ...).
 *     fgExe is the BASENAME of the foreground window's process image (never a
 *     path). fgCoversMonitor is "the foreground window's rectangle EQUALS the
 *     rectangle of the monitor it is on" (the desktop / shell windows are
 *     excluded). fgIsCipherline is "that window belongs to this process".
 *     NO window titles, no handles: nothing here can say what a person is
 *     doing inside a window, only which program has the screen.
 *
 *   getWindowExe(hwnd: string) -> string | null
 *     The same basename for one window (a decimal HWND string, as it appears
 *     in `window:<hwnd>:0`), used to pre-select a game's window in the picker.
 *
 *   setTimerResolution(ms: number, on: boolean) -> boolean
 *     timeBeginPeriod(ms) / timeEndPeriod(ms), 1..16 ms. Reference-counted
 *     here, so an "off" without a matching "on" is refused (returns false)
 *     instead of unbalancing the system-wide timer resolution. Only ever
 *     called from the main process; Windows also releases a process's
 *     requests when it exits.
 *
 *   setGpuSchedulingPriority(pid: number, level: number)
 *       -> { ok: boolean, status: number, error: number } | null
 *   getGpuSchedulingPriority(pid: number)
 *       -> { ok: boolean, status: number, error: number, level: number } | null
 *     The GPU (WDDM) scheduler's per-process priority CLASS, the thing OBS
 *     raises so its capture is not queued behind a game's GPU work:
 *     D3DKMTSetProcessSchedulingPriorityClass / D3DKMTGetProcessSchedulingPriorityClass
 *     from gdi32.dll, resolved at run time (so the addon still loads where the
 *     export is missing). level is D3DKMT_SCHEDULINGPRIORITYCLASS: IDLE 0,
 *     BELOW_NORMAL 1, NORMAL 2, ABOVE_NORMAL 3, HIGH 4, REALTIME 5. Windows
 *     gives the FOREGROUND process's GPU work a boost over background
 *     processes; a game in front of Cipherline therefore starves the browser
 *     process's desktop-duplication copy. REALTIME needs
 *     SeIncreaseBasePriorityPrivilege (an elevated process); without it the
 *     call answers STATUS_PRIVILEGE_NOT_HELD (0xC0000061) and the JS side falls
 *     back to HIGH.
 *     `status` is the NTSTATUS the call returned as a signed int32 (0 =
 *     success; read it as hex via `>>> 0`); `ok` = NT_SUCCESS(status). When the
 *     call was never made `status` is 0 and `error` says why: GetLastError()
 *     from OpenProcess, 87 (ERROR_INVALID_PARAMETER) for a bad argument,
 *     0x20000001 = the pid is not this process or one of its direct children
 *     (refused, like setProcessPowerThrottling), 120 (ERROR_CALL_NOT_IMPLEMENTED)
 *     = the gdi32 export does not exist. `level` is -1 unless the read worked.
 *     Elsewhere both return null. Same open-the-process access mask as the
 *     power opt-out plus query: PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION.
 *
 * Nothing here injects into, hooks, or reads the memory of another process.
 */

#include <node_api.h>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <mmsystem.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <stdint.h>
#include <string>
#endif

namespace {

napi_value Null(napi_env env) {
    napi_value v;
    napi_get_null(env, &v);
    return v;
}

napi_value Bool(napi_env env, bool b) {
    napi_value v;
    napi_get_boolean(env, b, &v);
    return v;
}

#ifdef _WIN32

void SetBool(napi_env env, napi_value obj, const char* name, bool value) {
    napi_set_named_property(env, obj, name, Bool(env, value));
}

void SetInt(napi_env env, napi_value obj, const char* name, int32_t value) {
    napi_value v;
    napi_create_int32(env, value, &v);
    napi_set_named_property(env, obj, name, v);
}

void SetString(napi_env env, napi_value obj, const char* name, const std::string& value) {
    napi_value v;
    napi_create_string_utf8(env, value.c_str(), value.size(), &v);
    napi_set_named_property(env, obj, name, v);
}

napi_value MakeRect(napi_env env, int32_t x, int32_t y, int32_t w, int32_t h) {
    napi_value obj;
    napi_create_object(env, &obj);
    SetInt(env, obj, "x", x);
    SetInt(env, obj, "y", y);
    SetInt(env, obj, "width", w);
    SetInt(env, obj, "height", h);
    return obj;
}

// ── ProcessPowerThrottling, declared locally ────────────────────────────────
// Older SDKs lack the struct, the constants and the information class, so
// they are spelled out here (values from processthreadsapi.h) rather than
// depending on the SDK the build machine happens to have.
struct ClPowerThrottlingState {
    ULONG Version;
    ULONG ControlMask;
    ULONG StateMask;
};
constexpr int kProcessPowerThrottlingClass = 4;            // PROCESS_INFORMATION_CLASS::ProcessPowerThrottling
constexpr ULONG kThrottlingCurrentVersion = 1;             // PROCESS_POWER_THROTTLING_CURRENT_VERSION
constexpr ULONG kThrottlingExecutionSpeed = 0x1;           // PROCESS_POWER_THROTTLING_EXECUTION_SPEED
constexpr ULONG kThrottlingIgnoreTimerResolution = 0x4;    // PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION
constexpr int32_t kErrNotOurProcess = 0x20000001;

typedef BOOL (WINAPI *SetProcessInformationFn)(HANDLE, int, LPVOID, DWORD);

SetProcessInformationFn ResolveSetProcessInformation() {
    static SetProcessInformationFn fn = []() -> SetProcessInformationFn {
        HMODULE kernel = GetModuleHandleW(L"kernel32.dll");
        if (!kernel) return nullptr;
        FARPROC p = GetProcAddress(kernel, "SetProcessInformation");
        return p ? reinterpret_cast<SetProcessInformationFn>(reinterpret_cast<void*>(p)) : nullptr;
    }();
    return fn;
}

// ── GPU scheduling priority class (gdi32 D3DKMT thunks) ──────────────────────
// D3DKMT_SCHEDULINGPRIORITYCLASS values (d3dkmthk.h), spelled out so the build
// does not depend on the WDK header. NTSTATUS is spelled LONG for the same reason.
constexpr int kGpuSchedMin = 0;        // D3DKMT_SCHEDULINGPRIORITYCLASS_IDLE
constexpr int kGpuSchedMax = 5;        // D3DKMT_SCHEDULINGPRIORITYCLASS_REALTIME

typedef LONG (APIENTRY *D3dkmtSetPriorityClassFn)(HANDLE, int);
typedef LONG (APIENTRY *D3dkmtGetPriorityClassFn)(HANDLE, int*);

HMODULE Gdi32() {
    static HMODULE mod = []() -> HMODULE {
        HMODULE m = GetModuleHandleW(L"gdi32.dll");     // always loaded in a GUI process
        if (!m) m = LoadLibraryExW(L"gdi32.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
        return m;
    }();
    return mod;
}

D3dkmtSetPriorityClassFn ResolveD3dkmtSetPriorityClass() {
    static D3dkmtSetPriorityClassFn fn = []() -> D3dkmtSetPriorityClassFn {
        HMODULE gdi = Gdi32();
        if (!gdi) return nullptr;
        FARPROC p = GetProcAddress(gdi, "D3DKMTSetProcessSchedulingPriorityClass");
        return p ? reinterpret_cast<D3dkmtSetPriorityClassFn>(reinterpret_cast<void*>(p)) : nullptr;
    }();
    return fn;
}

D3dkmtGetPriorityClassFn ResolveD3dkmtGetPriorityClass() {
    static D3dkmtGetPriorityClassFn fn = []() -> D3dkmtGetPriorityClassFn {
        HMODULE gdi = Gdi32();
        if (!gdi) return nullptr;
        FARPROC p = GetProcAddress(gdi, "D3DKMTGetProcessSchedulingPriorityClass");
        return p ? reinterpret_cast<D3dkmtGetPriorityClassFn>(reinterpret_cast<void*>(p)) : nullptr;
    }();
    return fn;
}

/** This process, or a DIRECT child of it (Chromium's GPU / renderer / utility processes). */
bool IsOurProcess(DWORD pid) {
    const DWORD self = GetCurrentProcessId();
    if (pid == self) return true;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return false;
    PROCESSENTRY32W entry;
    ZeroMemory(&entry, sizeof(entry));
    entry.dwSize = sizeof(entry);
    bool ours = false;
    if (Process32FirstW(snap, &entry)) {
        do {
            if (entry.th32ProcessID == pid) {
                ours = entry.th32ParentProcessID == self;
                break;
            }
        } while (Process32NextW(snap, &entry));
    }
    CloseHandle(snap);
    return ours;
}

bool ParsePid(napi_env env, napi_value value, DWORD* out) {
    napi_valuetype type;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) return false;
    double d = 0;
    if (napi_get_value_double(env, value, &d) != napi_ok) return false;
    if (!(d >= 1 && d <= 2147483647.0)) return false;        // rejects NaN/Infinity too
    if (d != static_cast<double>(static_cast<uint32_t>(d))) return false;
    *out = static_cast<DWORD>(d);
    return true;
}

bool ParseBool(napi_env env, napi_value value, bool* out) {
    napi_valuetype type;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_boolean) return false;
    return napi_get_value_bool(env, value, out) == napi_ok;
}

/** An integer GPU scheduling class, IDLE (0) .. REALTIME (5). Anything else is rejected, never clamped. */
bool ParseGpuLevel(napi_env env, napi_value value, int* out) {
    napi_valuetype type;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) return false;
    double d = 0;
    if (napi_get_value_double(env, value, &d) != napi_ok) return false;
    if (!(d >= kGpuSchedMin && d <= kGpuSchedMax) || d != static_cast<double>(static_cast<int>(d))) return false;
    *out = static_cast<int>(d);
    return true;
}

napi_value MakeGpuResult(napi_env env, bool ok, LONG status, int32_t error, bool withLevel, int level) {
    napi_value obj;
    napi_create_object(env, &obj);
    SetBool(env, obj, "ok", ok);
    SetInt(env, obj, "status", static_cast<int32_t>(status));
    SetInt(env, obj, "error", error);
    if (withLevel) SetInt(env, obj, "level", level);
    return obj;
}

/** A decimal HWND string ("12345"), as it appears in `window:<hwnd>:0`. */
bool ParseHwnd(napi_env env, napi_value value, HWND* out) {
    napi_valuetype type;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
    char buf[32] = {};
    size_t len = 0;
    if (napi_get_value_string_utf8(env, value, buf, sizeof(buf), &len) != napi_ok) return false;
    if (len == 0 || len > 20) return false;
    unsigned long long v = 0;
    for (size_t i = 0; i < len; ++i) {
        const char c = buf[i];
        if (c < '0' || c > '9') return false;
        const unsigned long long d = static_cast<unsigned long long>(c - '0');
        if (v > (~0ULL - d) / 10ULL) return false;   // overflow
        v = v * 10ULL + d;
    }
    if (v == 0) return false;
    *out = reinterpret_cast<HWND>(static_cast<uintptr_t>(v));
    return true;
}

std::string WideToUtf8(const wchar_t* w, int wlen) {
    if (!w || wlen <= 0) return std::string();
    const int n = WideCharToMultiByte(CP_UTF8, 0, w, wlen, nullptr, 0, nullptr, nullptr);
    if (n <= 0) return std::string();
    std::string out(static_cast<size_t>(n), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w, wlen, &out[0], n, nullptr, nullptr);
    return out;
}

/** The image's BASENAME ("game.exe") for a pid; empty when it cannot be read. Never a path. */
std::string ExeBasenameForPid(DWORD pid) {
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return std::string();
    wchar_t buf[1024];
    DWORD len = static_cast<DWORD>(sizeof(buf) / sizeof(buf[0]));
    std::string out;
    if (QueryFullProcessImageNameW(h, 0, buf, &len) && len > 0) {
        const wchar_t* base = buf;
        for (DWORD i = 0; i < len; ++i) {
            if (buf[i] == L'\\' || buf[i] == L'/') base = buf + i + 1;
        }
        const int baseLen = static_cast<int>((buf + len) - base);
        out = WideToUtf8(base, baseLen);
        if (out.size() > 128) out.resize(128);
    }
    CloseHandle(h);
    return out;
}

/** The desktop / shell windows, which are always "monitor sized" and never a game. */
bool IsShellWindow(HWND hwnd) {
    if (hwnd == GetDesktopWindow() || hwnd == GetShellWindow()) return true;
    wchar_t cls[64] = {};
    if (GetClassNameW(hwnd, cls, 64) <= 0) return false;
    return wcscmp(cls, L"Progman") == 0 || wcscmp(cls, L"WorkerW") == 0
        || wcscmp(cls, L"Shell_TrayWnd") == 0 || wcscmp(cls, L"Shell_SecondaryTrayWnd") == 0;
}

const char* NotificationStateName(QUERY_USER_NOTIFICATION_STATE s) {
    switch (s) {
        case QUNS_NOT_PRESENT: return "QUNS_NOT_PRESENT";
        case QUNS_BUSY: return "QUNS_BUSY";
        case QUNS_RUNNING_D3D_FULL_SCREEN: return "QUNS_RUNNING_D3D_FULL_SCREEN";
        case QUNS_PRESENTATION_MODE: return "QUNS_PRESENTATION_MODE";
        case QUNS_ACCEPTS_NOTIFICATIONS: return "QUNS_ACCEPTS_NOTIFICATIONS";
        case QUNS_QUIET_TIME: return "QUNS_QUIET_TIME";
        case QUNS_APP: return "QUNS_APP";
        default: return "QUNS_UNKNOWN";
    }
}

// timeBeginPeriod holds per resolution, 1..16 ms.
int g_timerHolds[17] = {};

#endif  // _WIN32

napi_value SetProcessPowerThrottling(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_value result;
    napi_create_object(env, &result);
    napi_set_named_property(env, result, "ok", Bool(env, false));
    napi_value zero;
    napi_create_int32(env, 0, &zero);
    napi_set_named_property(env, result, "error", zero);
    napi_set_named_property(env, result, "mask", zero);
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc < 2) return result;
#ifdef _WIN32
    DWORD pid = 0;
    bool enabled = false;
    if (!ParsePid(env, args[0], &pid) || !ParseBool(env, args[1], &enabled)) {
        SetInt(env, result, "error", ERROR_INVALID_PARAMETER);
        return result;
    }
    // Only ever this process or its own children.
    if (!IsOurProcess(pid)) {
        SetInt(env, result, "error", kErrNotOurProcess);
        return result;
    }
    SetProcessInformationFn setInfo = ResolveSetProcessInformation();
    if (!setInfo) {
        SetInt(env, result, "error", ERROR_CALL_NOT_IMPLEMENTED);
        return result;
    }
    HANDLE h = OpenProcess(PROCESS_SET_INFORMATION, FALSE, pid);
    if (!h) {
        SetInt(env, result, "error", static_cast<int32_t>(GetLastError()));
        return result;
    }
    ClPowerThrottlingState state;
    state.Version = kThrottlingCurrentVersion;
    state.StateMask = 0;
    // enabled: ControlMask 0 = the OS manages it again. disabled: we take
    // control of both bits and leave the state bits clear = never throttle.
    state.ControlMask = enabled ? 0 : (kThrottlingExecutionSpeed | kThrottlingIgnoreTimerResolution);
    BOOL ok = setInfo(h, kProcessPowerThrottlingClass, &state, sizeof(state));
    DWORD err = ok ? 0 : GetLastError();
    if (!ok && !enabled && err == ERROR_INVALID_PARAMETER) {
        // A Windows build that predates the timer-resolution bit.
        state.ControlMask = kThrottlingExecutionSpeed;
        ok = setInfo(h, kProcessPowerThrottlingClass, &state, sizeof(state));
        err = ok ? 0 : GetLastError();
    }
    CloseHandle(h);
    napi_set_named_property(env, result, "ok", Bool(env, ok != FALSE));
    SetInt(env, result, "error", static_cast<int32_t>(err));
    SetInt(env, result, "mask", ok ? static_cast<int32_t>(state.ControlMask) : 0);
    return result;
#else
    return result;
#endif
}

napi_value SetGpuSchedulingPriority(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc < 2) return Null(env);
#ifdef _WIN32
    DWORD pid = 0;
    int level = 0;
    if (!ParsePid(env, args[0], &pid) || !ParseGpuLevel(env, args[1], &level)) {
        return MakeGpuResult(env, false, 0, ERROR_INVALID_PARAMETER, false, -1);
    }
    // Only ever this process or its own children.
    if (!IsOurProcess(pid)) return MakeGpuResult(env, false, 0, kErrNotOurProcess, false, -1);
    D3dkmtSetPriorityClassFn setClass = ResolveD3dkmtSetPriorityClass();
    if (!setClass) return MakeGpuResult(env, false, 0, ERROR_CALL_NOT_IMPLEMENTED, false, -1);
    HANDLE h = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return MakeGpuResult(env, false, 0, static_cast<int32_t>(GetLastError()), false, -1);
    const LONG status = setClass(h, level);
    CloseHandle(h);
    return MakeGpuResult(env, status >= 0, status, 0, false, -1);   // NT_SUCCESS
#else
    return Null(env);
#endif
}

napi_value GetGpuSchedulingPriority(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc < 1) return Null(env);
#ifdef _WIN32
    DWORD pid = 0;
    if (!ParsePid(env, args[0], &pid)) return MakeGpuResult(env, false, 0, ERROR_INVALID_PARAMETER, true, -1);
    if (!IsOurProcess(pid)) return MakeGpuResult(env, false, 0, kErrNotOurProcess, true, -1);
    D3dkmtGetPriorityClassFn getClass = ResolveD3dkmtGetPriorityClass();
    if (!getClass) return MakeGpuResult(env, false, 0, ERROR_CALL_NOT_IMPLEMENTED, true, -1);
    HANDLE h = OpenProcess(PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return MakeGpuResult(env, false, 0, static_cast<int32_t>(GetLastError()), true, -1);
    int level = -1;
    const LONG status = getClass(h, &level);
    CloseHandle(h);
    const bool ok = status >= 0 && level >= kGpuSchedMin && level <= kGpuSchedMax;
    return MakeGpuResult(env, ok, status, 0, true, ok ? level : -1);
#else
    return Null(env);
#endif
}

napi_value GetForegroundInfo(napi_env env, napi_callback_info info) {
    (void)info;
#ifdef _WIN32
    napi_value obj;
    napi_create_object(env, &obj);

    QUERY_USER_NOTIFICATION_STATE qns = QUNS_NOT_PRESENT;
    const HRESULT hr = SHQueryUserNotificationState(&qns);
    SetString(env, obj, "notificationState", SUCCEEDED(hr) ? NotificationStateName(qns) : "QUNS_UNKNOWN");

    std::string exe;
    bool covers = false;
    bool isCipherline = false;
    bool haveMonitor = false;
    RECT monitor;
    ZeroMemory(&monitor, sizeof(monitor));

    HWND fg = GetForegroundWindow();
    if (fg) {
        DWORD pid = 0;
        GetWindowThreadProcessId(fg, &pid);
        isCipherline = pid == GetCurrentProcessId();
        if (pid != 0) exe = ExeBasenameForPid(pid);
        HMONITOR mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
        MONITORINFO mi;
        ZeroMemory(&mi, sizeof(mi));
        mi.cbSize = sizeof(mi);
        if (mon && GetMonitorInfoW(mon, &mi)) {
            monitor = mi.rcMonitor;
            haveMonitor = true;
            RECT wr;
            ZeroMemory(&wr, sizeof(wr));
            if (!IsShellWindow(fg) && GetWindowRect(fg, &wr)
                && wr.left == monitor.left && wr.top == monitor.top
                && wr.right == monitor.right && wr.bottom == monitor.bottom) {
                covers = true;
            }
        }
    }
    SetString(env, obj, "fgExe", exe);
    SetBool(env, obj, "fgCoversMonitor", covers);
    SetBool(env, obj, "fgIsCipherline", isCipherline);
    if (haveMonitor && monitor.right > monitor.left && monitor.bottom > monitor.top) {
        napi_set_named_property(env, obj, "fgMonitor",
            MakeRect(env, monitor.left, monitor.top, monitor.right - monitor.left, monitor.bottom - monitor.top));
    } else {
        napi_set_named_property(env, obj, "fgMonitor", Null(env));
    }
    return obj;
#else
    return Null(env);
#endif
}

napi_value GetWindowExe(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc < 1) return Null(env);
#ifdef _WIN32
    HWND hwnd = NULL;
    if (!ParseHwnd(env, args[0], &hwnd) || !IsWindow(hwnd)) return Null(env);
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == 0) return Null(env);
    const std::string exe = ExeBasenameForPid(pid);
    if (exe.empty()) return Null(env);
    napi_value v;
    napi_create_string_utf8(env, exe.c_str(), exe.size(), &v);
    return v;
#else
    return Null(env);
#endif
}

napi_value SetTimerResolution(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc < 2) return Bool(env, false);
#ifdef _WIN32
    napi_valuetype type;
    if (napi_typeof(env, args[0], &type) != napi_ok || type != napi_number) return Bool(env, false);
    double d = 0;
    if (napi_get_value_double(env, args[0], &d) != napi_ok) return Bool(env, false);
    if (!(d >= 1 && d <= 16) || d != static_cast<double>(static_cast<int>(d))) return Bool(env, false);
    const UINT ms = static_cast<UINT>(d);
    bool on = false;
    if (!ParseBool(env, args[1], &on)) return Bool(env, false);
    if (on) {
        if (timeBeginPeriod(ms) != TIMERR_NOERROR) return Bool(env, false);
        g_timerHolds[ms]++;
        return Bool(env, true);
    }
    // Never end a period this module did not begin.
    if (g_timerHolds[ms] <= 0) return Bool(env, false);
    if (timeEndPeriod(ms) != TIMERR_NOERROR) return Bool(env, false);
    g_timerHolds[ms]--;
    return Bool(env, true);
#else
    return Bool(env, false);
#endif
}

void Export(napi_env env, napi_value exports, const char* name, napi_callback cb) {
    napi_value fn;
    if (napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, nullptr, &fn) == napi_ok) {
        napi_set_named_property(env, exports, name, fn);
    }
}

}  // namespace

void RegisterSharePower(napi_env env, napi_value exports) {
    Export(env, exports, "setProcessPowerThrottling", SetProcessPowerThrottling);
    Export(env, exports, "getForegroundInfo", GetForegroundInfo);
    Export(env, exports, "getWindowExe", GetWindowExe);
    Export(env, exports, "setTimerResolution", SetTimerResolution);
    Export(env, exports, "setGpuSchedulingPriority", SetGpuSchedulingPriority);
    Export(env, exports, "getGpuSchedulingPriority", GetGpuSchedulingPriority);
}
