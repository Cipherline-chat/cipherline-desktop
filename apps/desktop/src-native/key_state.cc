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
 *   Windows  GetAsyncKeyState(virtual key)
 *   X11      XQueryKeymap on the thread's own display connection (libX11 is
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
 *     is "any of these codes" (Alt = left OR right Alt), codes being Win32 virtual
 *     keys on Windows and X11 keysyms on Linux. `callback(true)` when every group
 *     has a key down, `callback(false)` when that stops being true, on the JS main
 *     thread. Returns false for bad arguments or when the OS cannot be watched.
 *   stopWatchingKeys(slot?: number): void
 *     Stops one slot (or all when omitted). No callback is delivered afterwards.
 */

#include <node_api.h>

#if defined(_WIN32) || defined(__linux__)

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
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
// Windows: a code is a virtual key.
struct Probe {
    bool Open() { return true; }
    void Close() {}
    int Resolve(int code) { return code; }
    bool Sample() { return true; }
    bool Down(int resolved) { return (GetAsyncKeyState(resolved) & 0x8000) != 0; }
};
#else
// X11: a code is a keysym; libX11 is loaded at run time (no headers needed: Display* is opaque).
struct X11Api {
    void* lib = nullptr;
    void* (*XOpenDisplay)(const char*) = nullptr;
    int (*XCloseDisplay)(void*) = nullptr;
    int (*XQueryKeymap)(void*, char[32]) = nullptr;
    unsigned char (*XKeysymToKeycode)(void*, unsigned long) = nullptr;
    bool ok = false;
};
X11Api* LoadX11() {
    static X11Api api;
    static bool tried = false;
    if (tried) return &api;
    tried = true;
    api.lib = dlopen("libX11.so.6", RTLD_LAZY | RTLD_LOCAL);
    if (!api.lib) return &api;
    api.XOpenDisplay = reinterpret_cast<void* (*)(const char*)>(dlsym(api.lib, "XOpenDisplay"));
    api.XCloseDisplay = reinterpret_cast<int (*)(void*)>(dlsym(api.lib, "XCloseDisplay"));
    api.XQueryKeymap = reinterpret_cast<int (*)(void*, char[32])>(dlsym(api.lib, "XQueryKeymap"));
    api.XKeysymToKeycode = reinterpret_cast<unsigned char (*)(void*, unsigned long)>(dlsym(api.lib, "XKeysymToKeycode"));
    api.ok = api.XOpenDisplay && api.XCloseDisplay && api.XQueryKeymap && api.XKeysymToKeycode;
    return &api;
}
struct Probe {
    X11Api* api = nullptr;
    void* dpy = nullptr;
    char map[32] = {0};
    bool Open() {
        api = LoadX11();
        if (!api->ok) return false;
        dpy = api->XOpenDisplay(nullptr);
        return dpy != nullptr;
    }
    void Close() { if (dpy && api) api->XCloseDisplay(dpy); dpy = nullptr; }
    int Resolve(int code) { return dpy ? api->XKeysymToKeycode(dpy, static_cast<unsigned long>(code)) : 0; }
    bool Sample() { return dpy && api->XQueryKeymap(dpy, map) != 0; }
    bool Down(int keycode) { return keycode > 0 && (map[keycode >> 3] & (1 << (keycode & 7))) != 0; }
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

}  // namespace

void RegisterKeyState(napi_env env, napi_value exports) {
    napi_value fn;
    napi_create_function(env, nullptr, 0, WatchKeys, nullptr, &fn);
    napi_set_named_property(env, exports, "watchKeys", fn);
    napi_create_function(env, nullptr, 0, StopWatching, nullptr, &fn);
    napi_set_named_property(env, exports, "stopWatchingKeys", fn);
    napi_add_env_cleanup_hook(env, CleanupHook, nullptr);
}

#else

// macOS / other: nothing to register (and those Inits never call this).
void RegisterKeyState(napi_env /*env*/, napi_value /*exports*/) {}

#endif
