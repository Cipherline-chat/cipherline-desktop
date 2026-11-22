/**
 * key_state.cc - system-wide "is this key combination held down" watcher for the
 * hold-style keybinds (push-to-talk, push-to-mute), linked into the audio_capture
 * addon (one native module to build). Windows and Linux X11.
 *
 * WHY THIS EXISTS. These keys are HOLDS: the mic is open (or muted) exactly while
 * the key is down. Electron's `globalShortcut` (RegisterHotKey / XGrabKey) only
 * reports a PRESS - never the release - swallows the key from every other app, and
 * cannot register a bare modifier such as Alt. The renderer's own keydown/keyup
 * listeners only see keys while Cipherline is the focused window.
 *
 * HOW. A small thread per watch samples the physical keyboard state every ~8 ms
 * and reports every change of "every watched key group is down":
 *   Windows  GetAsyncKeyState(virtual key) - mouse buttons included
 *   X11      XQueryKeymap (+ the pointer's button state, only when a mouse button
 *            is watched) on the thread's own display connection (libX11 is
 *            dlopen()ed, so the addon loads on a machine without it)
 * It is deliberately a POLL, not a hook / grab: it never sits in the input path,
 * so it cannot swallow, delay or reorder a key for another application, needs no
 * elevation, and a bare modifier is just another key. It reads ONLY the keys it
 * was asked to watch, as a yes/no: nothing is recorded.
 * It does NOT work on Wayland (a Wayland client cannot read the keyboard of other
 * windows by design): there the app uses the GlobalShortcuts portal instead
 * (electron/wayland-global-shortcuts.ts). watchKeys returns false when no X
 * display can be opened, so the JS side can fall back.
 *
 * Exports (RegisterKeyState, called from the Windows and Linux addons' Init):
 *
 *   watchKeys(slot: number, groups: number[][], callback: (down: boolean) => void): boolean
 *     Replaces any previous watch in `slot` (0..3). `groups` = 1..4 groups; a group
 *     is "any of these codes" (Alt = left OR right Alt). `callback(true)` when every
 *     group has a key down, `callback(false)` when that stops being true, on the JS
 *     main thread. Returns false for bad arguments or when the OS cannot be watched.
 *     A code is (electron/global-ptt.ts builds them from KeyboardEvent.code):
 *       Windows  a virtual key (1..0xFF; VK_MBUTTON / VK_XBUTTON1 / VK_XBUTTON2 are
 *                the middle / back / forward mouse buttons, GetAsyncKeyState reads
 *                them like keys), or kWinScanCode | scan code (0xE0xx = extended):
 *                a PHYSICAL key, turned into this keyboard layout's virtual key with
 *                MapVirtualKeyEx when the watch starts (letters, digits and the OEM
 *                punctuation keys, whose virtual key depends on the layout).
 *       X11      a keysym (resolved with XKeysymToKeycode, as before), or
 *                kX11KeyCode | X keycode: a PHYSICAL key (Chromium's
 *                KeyboardEvent.code comes from that same keycode, evdev + 8), or
 *                kX11Button | pointer button (2 = middle, 8 = back, 9 = forward).
 *                Buttons 1-5 come from XQueryPointer; 6+ need XInput 2
 *                (XIQueryPointer on the client's master pointer, libXi dlopen()ed);
 *                without it a watch of such a button returns false.
 *     Mouse buttons are read the same way as keys: a poll of the state, never a
 *     hook, so the click still reaches whatever window is under the pointer.
 *   stopWatchingKeys(slot?: number): void
 *     Stops one slot (or all when omitted). No callback is delivered afterwards.
 *   getForegroundElevation() -> { foreground, selfIntegrity, selfElevated }   (Windows only)
 *     Whether the window that has focus belongs to a process at a HIGHER integrity
 *     level than ours (a game started "as administrator" while Cipherline was not).
 *     Windows' UIPI then hides the key state from us: GetAsyncKeyState reads nothing
 *     while that window is focused, which no poll can work around - the only fix is
 *     running Cipherline elevated too. `foreground` is one of
 *       'none'    no foreground window
 *       'self'    one of our windows
 *       'higher'  its token's integrity level is above ours
 *       'same'    at or below ours
 *       'denied'  the process opened (PROCESS_QUERY_LIMITED_INFORMATION) but its
 *                 token did not (ERROR_ACCESS_DENIED). Could be elevated, could be
 *                 anti-cheat hiding it: the JS side treats it as UNKNOWN (never as
 *                 admin) and only reports it in diagnostics
 *       'unknown' anything else (a protected process, a race with the window closing)
 *     Nothing about the window (no title, no executable) is returned.
 */

#include <node_api.h>

#if defined(_WIN32) || defined(__linux__)

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
// OpenProcessToken / GetTokenInformation / IsValidSid / GetSidSubAuthority* (also listed in binding.gyp).
#pragma comment(lib, "advapi32.lib")
#ifndef MAPVK_VSC_TO_VK_EX
#define MAPVK_VSC_TO_VK_EX 3   // winuser.h; guarded only in case an old SDK hides it behind WINVER
#endif
#else
#include <dlfcn.h>
#include <unistd.h>
#endif

#include <atomic>
#include <chrono>
#include <cstdint>
#include <thread>
#include <vector>

namespace {

constexpr uint32_t kMaxGroups = 4;
constexpr uint32_t kMaxSlots = 4;
constexpr uint32_t kMaxAlternatives = 4;
constexpr int kPollMs = 8;

#ifdef _WIN32
// Windows: a code is a virtual key, or a scan code to turn into one under this keyboard layout.
constexpr int kWinScanCode = 0x10000;
struct Probe {
    HKL layout = nullptr;
    bool Open() { layout = GetKeyboardLayout(0); return true; }
    void Close() {}
    int Resolve(int code) {
        if (code & kWinScanCode) {
            // 0 = no such key on this layout: never down.
            return static_cast<int>(MapVirtualKeyExW(static_cast<UINT>(code & 0xFFFF), MAPVK_VSC_TO_VK_EX, layout));
        }
        return code;
    }
    bool Sample() { return true; }
    bool Down(int resolved) { return resolved > 0 && (GetAsyncKeyState(resolved) & 0x8000) != 0; }
};
#else
// X11: a code is a keysym, a raw keycode or a pointer button. libX11 (and libXi, only for
// buttons 6+) are loaded at run time: no headers needed (Display* is opaque), and the addon
// loads on a machine without them.
constexpr int kX11KeyCode = 0x40000000;
constexpr int kX11Button = 0x20000000;
struct XIButtonStateLite { int mask_len; unsigned char* mask; };
struct XIModifierStateLite { int base; int latched; int locked; int effective; };
struct X11Api {
    void* lib = nullptr;
    void* (*XOpenDisplay)(const char*) = nullptr;
    int (*XCloseDisplay)(void*) = nullptr;
    int (*XQueryKeymap)(void*, char[32]) = nullptr;
    unsigned char (*XKeysymToKeycode)(void*, unsigned long) = nullptr;
    unsigned long (*XDefaultRootWindow)(void*) = nullptr;
    int (*XQueryPointer)(void*, unsigned long, unsigned long*, unsigned long*, int*, int*, int*, int*, unsigned int*) = nullptr;
    int (*XQueryExtension)(void*, const char*, int*, int*, int*) = nullptr;
    int (*XFree)(void*) = nullptr;
    bool ok = false;
    // libXi (XInput 2): only to read pointer buttons above 5 (back / forward).
    void* xi = nullptr;
    int (*XIQueryVersion)(void*, int*, int*) = nullptr;
    int (*XIGetClientPointer)(void*, unsigned long, int*) = nullptr;
    int (*XIQueryPointer)(void*, int, unsigned long, unsigned long*, unsigned long*, double*, double*, double*, double*,
                          XIButtonStateLite*, XIModifierStateLite*, XIModifierStateLite*) = nullptr;
    bool xiOk = false;
};
template <typename T> void Sym(void* lib, T& fn, const char* name) { fn = reinterpret_cast<T>(dlsym(lib, name)); }
X11Api* LoadX11() {
    static X11Api api;
    static bool tried = false;
    if (tried) return &api;
    tried = true;
    api.lib = dlopen("libX11.so.6", RTLD_LAZY | RTLD_LOCAL);
    if (!api.lib) return &api;
    Sym(api.lib, api.XOpenDisplay, "XOpenDisplay");
    Sym(api.lib, api.XCloseDisplay, "XCloseDisplay");
    Sym(api.lib, api.XQueryKeymap, "XQueryKeymap");
    Sym(api.lib, api.XKeysymToKeycode, "XKeysymToKeycode");
    Sym(api.lib, api.XDefaultRootWindow, "XDefaultRootWindow");
    Sym(api.lib, api.XQueryPointer, "XQueryPointer");
    Sym(api.lib, api.XQueryExtension, "XQueryExtension");
    Sym(api.lib, api.XFree, "XFree");
    api.ok = api.XOpenDisplay && api.XCloseDisplay && api.XQueryKeymap && api.XKeysymToKeycode;
    api.xi = dlopen("libXi.so.6", RTLD_LAZY | RTLD_LOCAL);
    if (api.xi) {
        Sym(api.xi, api.XIQueryVersion, "XIQueryVersion");
        Sym(api.xi, api.XIGetClientPointer, "XIGetClientPointer");
        Sym(api.xi, api.XIQueryPointer, "XIQueryPointer");
        api.xiOk = api.XIQueryVersion && api.XIGetClientPointer && api.XIQueryPointer && api.XFree && api.XQueryExtension;
    }
    return &api;
}
struct Probe {
    bool needButtons = false;   // set before Open(): the watch includes a pointer button
    bool needXi = false;        // ... and one of them is above 5 (back / forward)
    X11Api* api = nullptr;
    void* dpy = nullptr;
    unsigned long root = 0;
    int xiDevice = -1;
    char map[32] = {0};
    uint32_t buttons = 0;       // bit b = pointer button b is down
    bool Open() {
        api = LoadX11();
        if (!api->ok) return false;
        dpy = api->XOpenDisplay(nullptr);
        if (!dpy) return false;
        if (needButtons) {
            if (!api->XDefaultRootWindow || !api->XQueryPointer) { Close(); return false; }
            root = api->XDefaultRootWindow(dpy);
        }
        if (needXi) {
            // Guarded so no XInput request is ever sent to a server without the extension
            // (an X error would go to the process-wide error handler).
            int op = 0, ev = 0, err = 0;
            int major = 2, minor = 0;
            int dev = -1;
            if (!api->xiOk || !api->XQueryExtension(dpy, "XInputExtension", &op, &ev, &err)
                || api->XIQueryVersion(dpy, &major, &minor) != 0 || major < 2) {
                Close();
                return false;
            }
            // Its return value only says whether a client pointer was set EXPLICITLY; the id is
            // filled in either way (the server's pick). 2 is the Virtual core pointer otherwise.
            api->XIGetClientPointer(dpy, 0, &dev);
            xiDevice = dev > 0 ? dev : 2;
        }
        return true;
    }
    void Close() { if (dpy && api) api->XCloseDisplay(dpy); dpy = nullptr; }
    int Resolve(int code) {
        if (!dpy) return 0;
        if (code & kX11Button) return code;
        if (code & kX11KeyCode) return code & 0xFF;
        return api->XKeysymToKeycode(dpy, static_cast<unsigned long>(code));
    }
    bool SampleButtons() {
        buttons = 0;
        if (xiDevice >= 0) {
            unsigned long r = 0, c = 0;
            double rx = 0, ry = 0, wx = 0, wy = 0;
            XIButtonStateLite bs = {0, nullptr};
            XIModifierStateLite mods = {0, 0, 0, 0}, group = {0, 0, 0, 0};
            int ok = api->XIQueryPointer(dpy, xiDevice, root, &r, &c, &rx, &ry, &wx, &wy, &bs, &mods, &group);
            if (ok && bs.mask) {
                for (int b = 1; b < 32 && (b >> 3) < bs.mask_len; b++) {
                    if (bs.mask[b >> 3] & (1 << (b & 7))) buttons |= (1u << b);
                }
            }
            if (bs.mask) api->XFree(bs.mask);
            return ok != 0;
        }
        unsigned long r = 0, c = 0;
        int rx = 0, ry = 0, wx = 0, wy = 0;
        unsigned int mask = 0;
        // Returns False only when the pointer is on another screen; the button mask is valid either way.
        api->XQueryPointer(dpy, root, &r, &c, &rx, &ry, &wx, &wy, &mask);
        for (int b = 1; b <= 5; b++) if (mask & (1u << (7 + b))) buttons |= (1u << b);   // Button1Mask = 1 << 8
        return true;
    }
    bool Sample() {
        if (!dpy || api->XQueryKeymap(dpy, map) == 0) return false;
        return needButtons ? SampleButtons() : true;
    }
    bool Down(int resolved) {
        if (resolved & kX11Button) {
            int b = resolved & 0xFF;
            return b > 0 && b < 32 && (buttons & (1u << b)) != 0;
        }
        return resolved > 0 && resolved < 256 && (map[resolved >> 3] & (1 << (resolved & 7))) != 0;
    }
};
#endif

struct KeyWatch {
    std::vector<std::vector<int>> groups;   // codes as given by JS
    napi_threadsafe_function tsfn = nullptr;
    std::atomic<bool> stop{false};
    std::thread thread;
};

// Touched only from the JS main thread (watchKeys / stopWatchingKeys / env cleanup).
KeyWatch* g_watch[kMaxSlots] = {nullptr, nullptr, nullptr, nullptr};

void CallJs(napi_env env, napi_value jsCallback, void* /*context*/, void* data) {
    if (env == nullptr || jsCallback == nullptr) return;
    napi_value arg;
    napi_value undefined;
    napi_get_boolean(env, reinterpret_cast<intptr_t>(data) != 0, &arg);
    napi_get_undefined(env, &undefined);
    napi_call_function(env, undefined, jsCallback, 1, &arg, nullptr);
}

void Poll(KeyWatch* w, Probe* probe, std::vector<std::vector<int>> resolved) {
    bool last = false;
    while (!w->stop.load(std::memory_order_acquire)) {
        bool now = probe->Sample();
        if (now) {
            for (const auto& g : resolved) {
                bool any = false;
                for (int c : g) { if (probe->Down(c)) { any = true; break; } }
                if (!any) { now = false; break; }
            }
        }
        if (now != last) {
            last = now;
            napi_call_threadsafe_function(w->tsfn, reinterpret_cast<void*>(static_cast<intptr_t>(now ? 1 : 0)), napi_tsfn_nonblocking);
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(kPollMs));
    }
    probe->Close();
    delete probe;
}

void StopSlot(uint32_t slot) {
    KeyWatch* w = g_watch[slot];
    if (w == nullptr) return;
    g_watch[slot] = nullptr;
    w->stop.store(true, std::memory_order_release);
    if (w->thread.joinable()) w->thread.join();
    napi_release_threadsafe_function(w->tsfn, napi_tsfn_abort);
    delete w;
}

void StopAll() { for (uint32_t i = 0; i < kMaxSlots; i++) StopSlot(i); }

void CleanupHook(void* /*arg*/) { StopAll(); }

napi_value WatchKeys(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

    napi_value result;
    napi_get_boolean(env, false, &result);
    if (argc < 3) return result;

    int32_t slot = -1;
    if (napi_get_value_int32(env, argv[0], &slot) != napi_ok || slot < 0 || slot >= static_cast<int32_t>(kMaxSlots)) return result;

    bool isArray = false;
    napi_is_array(env, argv[1], &isArray);
    if (!isArray) return result;
    uint32_t glen = 0;
    napi_get_array_length(env, argv[1], &glen);
    if (glen < 1 || glen > kMaxGroups) return result;

    napi_valuetype cbType;
    napi_typeof(env, argv[2], &cbType);
    if (cbType != napi_function) return result;

    std::vector<std::vector<int>> groups;
    for (uint32_t i = 0; i < glen; i++) {
        napi_value ge;
        napi_get_element(env, argv[1], i, &ge);
        bool gIsArray = false;
        napi_is_array(env, ge, &gIsArray);
        if (!gIsArray) return result;
        uint32_t alen = 0;
        napi_get_array_length(env, ge, &alen);
        if (alen < 1 || alen > kMaxAlternatives) return result;
        std::vector<int> codes;
        for (uint32_t j = 0; j < alen; j++) {
            napi_value el;
            napi_get_element(env, ge, j, &el);
            napi_valuetype t;
            napi_typeof(env, el, &t);
            if (t != napi_number) return result;
            int32_t code = 0;
            napi_get_value_int32(env, el, &code);
            if (code < 1) return result;
            codes.push_back(code);
        }
        groups.push_back(codes);
    }

    StopSlot(static_cast<uint32_t>(slot));

    // Open the OS handle first so an unwatchable session (Wayland: no X display) reports false.
    Probe* probe = new Probe();
#ifndef _WIN32
    for (const auto& g : groups) {
        for (int c : g) {
            if (c & kX11Button) {
                probe->needButtons = true;
                if ((c & 0xFF) > 5) probe->needXi = true;
            }
        }
    }
#endif
    if (!probe->Open()) { delete probe; return result; }
    std::vector<std::vector<int>> resolved;
    for (const auto& g : groups) {
        std::vector<int> rg;
        for (int c : g) rg.push_back(probe->Resolve(c));
        resolved.push_back(rg);
    }

    KeyWatch* w = new KeyWatch();
    w->groups = groups;
    napi_value name;
    napi_create_string_utf8(env, "cipherline-key-state", NAPI_AUTO_LENGTH, &name);
    if (napi_create_threadsafe_function(env, argv[2], nullptr, name, 0, 1, nullptr, nullptr, nullptr, CallJs, &w->tsfn) != napi_ok) {
        probe->Close();
        delete probe;
        delete w;
        return result;
    }
    // A pending watch must never keep Node's event loop (and so the app) alive.
    napi_unref_threadsafe_function(env, w->tsfn);
    g_watch[slot] = w;
    // X11 connections are per-thread-safe only when used from one thread: the probe is handed to the poll thread.
    w->thread = std::thread(Poll, w, probe, resolved);

    napi_get_boolean(env, true, &result);
    return result;
}

napi_value StopWatching(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    int32_t slot = -1;
    if (argc >= 1 && napi_get_value_int32(env, argv[0], &slot) == napi_ok && slot >= 0 && slot < static_cast<int32_t>(kMaxSlots)) {
        StopSlot(static_cast<uint32_t>(slot));
    } else {
        StopAll();
    }
    napi_value undefined;
    napi_get_undefined(env, &undefined);
    return undefined;
}

#ifdef _WIN32
// The integrity-level RID of a token (SECURITY_MANDATORY_MEDIUM_RID 0x2000, HIGH 0x3000), -1 when unreadable.
long TokenIntegrity(HANDLE token) {
    DWORD len = 0;
    GetTokenInformation(token, TokenIntegrityLevel, nullptr, 0, &len);
    // Pointer-aligned storage: TOKEN_MANDATORY_LABEL starts with a PSID.
    DWORD_PTR buf[32];
    if (len == 0 || len > sizeof(buf)) return -1;
    if (!GetTokenInformation(token, TokenIntegrityLevel, buf, len, &len)) return -1;
    PSID sid = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(buf)->Label.Sid;
    if (!sid || !IsValidSid(sid)) return -1;
    UCHAR n = *GetSidSubAuthorityCount(sid);
    if (n == 0) return -1;
    return static_cast<long>(*GetSidSubAuthority(sid, static_cast<DWORD>(n - 1)));
}

napi_value GetForegroundElevation(napi_env env, napi_callback_info /*info*/) {
    long selfIl = -1;
    bool selfElevated = false;
    HANDLE selfToken = nullptr;
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &selfToken)) {
        selfIl = TokenIntegrity(selfToken);
        TOKEN_ELEVATION e = {0};
        DWORD len = 0;
        if (GetTokenInformation(selfToken, TokenElevation, &e, sizeof(e), &len)) selfElevated = e.TokenIsElevated != 0;
        CloseHandle(selfToken);
    }

    const char* fg = "unknown";
    HWND hwnd = GetForegroundWindow();
    DWORD pid = 0;
    if (!hwnd) {
        fg = "none";
    } else if (GetWindowThreadProcessId(hwnd, &pid) == 0 || pid == 0) {
        fg = "unknown";
    } else if (pid == GetCurrentProcessId()) {
        fg = "self";
    } else {
        HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (proc) {
            HANDLE tok = nullptr;
            if (OpenProcessToken(proc, TOKEN_QUERY, &tok)) {
                long il = TokenIntegrity(tok);
                CloseHandle(tok);
                if (il >= 0 && selfIl >= 0) fg = il > selfIl ? "higher" : "same";
            } else if (GetLastError() == ERROR_ACCESS_DENIED) {
                fg = "denied";
            }
            CloseHandle(proc);
        }
    }

    napi_value out, v;
    napi_create_object(env, &out);
    napi_create_string_utf8(env, fg, NAPI_AUTO_LENGTH, &v);
    napi_set_named_property(env, out, "foreground", v);
    napi_create_int32(env, static_cast<int32_t>(selfIl), &v);
    napi_set_named_property(env, out, "selfIntegrity", v);
    napi_get_boolean(env, selfElevated, &v);
    napi_set_named_property(env, out, "selfElevated", v);
    return out;
}
#endif

}  // namespace

void RegisterKeyState(napi_env env, napi_value exports) {
    napi_value fn;
    napi_create_function(env, nullptr, 0, WatchKeys, nullptr, &fn);
    napi_set_named_property(env, exports, "watchKeys", fn);
    napi_create_function(env, nullptr, 0, StopWatching, nullptr, &fn);
    napi_set_named_property(env, exports, "stopWatchingKeys", fn);
#ifdef _WIN32
    napi_create_function(env, nullptr, 0, GetForegroundElevation, nullptr, &fn);
    napi_set_named_property(env, exports, "getForegroundElevation", fn);
#endif
    napi_add_env_cleanup_hook(env, CleanupHook, nullptr);
}

#else

// macOS / other: nothing to register (and those Inits never call this).
void RegisterKeyState(napi_env /*env*/, napi_value /*exports*/) {}

#endif
