/**
 * window_geometry.cc — Win32 display/window geometry for the desktop
 * annotation overlay (electron/annotation-overlay.ts), linked into the
 * audio_capture addon so there is still exactly one native module to build.
 *
 * Raw N-API, like audio_capture.cc. Windows only; on other platforms every
 * export returns null / false.
 *
 * Exports (registered by RegisterWindowGeometry, called from audio_capture's
 * Init):
 *
 *   getScreenRectFromDeviceIndex(index: number)
 *       -> { x, y, width, height } | null
 *     The PHYSICAL desktop rectangle of the monitor a `screen:<index>:0`
 *     capture source captures, when Chromium's screen capturer is GDI or WGC
 *     (i.e. whenever Electron leaves `display_id` empty on Windows). It is a
 *     line-for-line mirror of webrtc's GetScreenRect
 *     (modules/desktop_capture/win/screen_capture_utils.cc): the source id is
 *     the EnumDisplayDevicesW adapter index (GetScreenList pushes
 *     `device_index` for every ACTIVE device), and the rectangle is that
 *     device's ENUM_CURRENT_SETTINGS dmPosition / dmPelsWidth / dmPelsHeight
 *     — exactly what WgcScreenSource feeds MonitorFromRect to pick the
 *     monitor it captures (GetHmonitorFromDeviceIndex). Matching that
 *     rectangle against Electron's displays is what tells us WHICH display is
 *     being shared; getAllDisplays() order (EnumDisplayMonitors) has no fixed
 *     relation to the adapter index.
 *
 *   getWindowInfo(hwnd: string)
 *       -> { exists, visible, minimized, cloaked, frame: {x,y,width,height}|null } | null
 *     For a `window:<hwnd>:0` capture source. `frame` is
 *     DWMWA_EXTENDED_FRAME_BOUNDS (the window's visible bounds without the
 *     invisible resize border — what Windows.Graphics.Capture delivers for a
 *     window, and what webrtc's cropping window capturer approximates), with
 *     GetWindowRect as the fallback. Physical pixels: the Electron main
 *     process is per-monitor-DPI-aware v2.
 *
 *   placeOverlayAbove(overlayHwnd: string, targetHwnd: string,
 *                     x: number, y: number, width: number, height: number)
 *       -> boolean
 *     Moves/sizes the OVERLAY to the given physical rectangle and stacks it
 *     directly above the target in z-order (so windows covering the shared
 *     window also cover the strokes), without activating anything. Refuses
 *     unless the overlay window belongs to THIS process — it can only ever
 *     move our own window, never someone else's. Calls SetWindowPos only
 *     when the position, size or stacking actually differs.
 *
 * Nothing here writes to any window but our own overlay, injects anything,
 * or hooks another process.
 */

#include <node_api.h>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <dwmapi.h>
#include <stdint.h>
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

void SetInt(napi_env env, napi_value obj, const char* name, int32_t value) {
    napi_value v;
    napi_create_int32(env, value, &v);
    napi_set_named_property(env, obj, name, v);
}

void SetBool(napi_env env, napi_value obj, const char* name, bool value) {
    napi_set_named_property(env, obj, name, Bool(env, value));
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

bool GetInt32Arg(napi_env env, napi_value value, int32_t* out) {
    napi_valuetype type;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) return false;
    double d = 0;
    if (napi_get_value_double(env, value, &d) != napi_ok) return false;
    if (!(d >= -1e7 && d <= 1e7)) return false;      // rejects NaN/Infinity too
    if (d != static_cast<double>(static_cast<int32_t>(d))) return false;
    *out = static_cast<int32_t>(d);
    return true;
}

bool IsTopmost(HWND hwnd) {
    return (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
}

#endif  // _WIN32

napi_value GetScreenRectFromDeviceIndex(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc < 1) return Null(env);
#ifdef _WIN32
    int32_t index = -1;
    if (!GetInt32Arg(env, args[0], &index) || index < 0 || index > 1024) return Null(env);

    DISPLAY_DEVICEW device;
    ZeroMemory(&device, sizeof(device));
    device.cb = sizeof(device);
    if (!EnumDisplayDevicesW(NULL, static_cast<DWORD>(index), &device, 0)) return Null(env);
    // GetScreenList only ever hands out ACTIVE devices; an inactive one at
    // this index means the topology changed under the share.
    if (!(device.StateFlags & DISPLAY_DEVICE_ACTIVE)) return Null(env);

    DEVMODEW mode;
    ZeroMemory(&mode, sizeof(mode));
    mode.dmSize = sizeof(mode);
    mode.dmDriverExtra = 0;
    if (!EnumDisplaySettingsExW(device.DeviceName, ENUM_CURRENT_SETTINGS, &mode, 0)) return Null(env);
    if (mode.dmPelsWidth == 0 || mode.dmPelsHeight == 0) return Null(env);

    return MakeRect(env, mode.dmPosition.x, mode.dmPosition.y,
                    static_cast<int32_t>(mode.dmPelsWidth), static_cast<int32_t>(mode.dmPelsHeight));
#else
    return Null(env);
#endif
}

napi_value GetWindowInfo(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc < 1) return Null(env);
#ifdef _WIN32
    HWND hwnd = NULL;
    if (!ParseHwnd(env, args[0], &hwnd)) return Null(env);

    napi_value obj;
    napi_create_object(env, &obj);
    if (!IsWindow(hwnd)) {
        SetBool(env, obj, "exists", false);
        return obj;
    }
    SetBool(env, obj, "exists", true);
    SetBool(env, obj, "visible", IsWindowVisible(hwnd) != FALSE);
    SetBool(env, obj, "minimized", IsIconic(hwnd) != FALSE);

    DWORD cloaked = 0;
    const bool isCloaked =
        SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked != 0;
    SetBool(env, obj, "cloaked", isCloaked);

    RECT r;
    ZeroMemory(&r, sizeof(r));
    bool haveRect =
        SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &r, sizeof(r)));
    if (!haveRect) haveRect = GetWindowRect(hwnd, &r) != FALSE;
    if (haveRect && r.right > r.left && r.bottom > r.top) {
        napi_set_named_property(env, obj, "frame",
            MakeRect(env, r.left, r.top, r.right - r.left, r.bottom - r.top));
    } else {
        napi_set_named_property(env, obj, "frame", Null(env));
    }
    return obj;
#else
    return Null(env);
#endif
}

napi_value PlaceOverlayAbove(napi_env env, napi_callback_info info) {
    size_t argc = 6;
    napi_value args[6];
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc < 6) return Bool(env, false);
#ifdef _WIN32
    HWND overlay = NULL, target = NULL;
    if (!ParseHwnd(env, args[0], &overlay) || !ParseHwnd(env, args[1], &target)) return Bool(env, false);
    int32_t x = 0, y = 0, w = 0, h = 0;
    if (!GetInt32Arg(env, args[2], &x) || !GetInt32Arg(env, args[3], &y)
        || !GetInt32Arg(env, args[4], &w) || !GetInt32Arg(env, args[5], &h)) return Bool(env, false);
    if (w <= 0 || h <= 0 || w > 65535 || h > 65535) return Bool(env, false);
    if (overlay == target || !IsWindow(overlay) || !IsWindow(target)) return Bool(env, false);

    // Only ever our own window.
    DWORD pid = 0;
    GetWindowThreadProcessId(overlay, &pid);
    if (pid != GetCurrentProcessId()) return Bool(env, false);

    const UINT base = SWP_NOACTIVATE | SWP_NOOWNERZORDER;
    const bool targetTop = IsTopmost(target);
    // Same band as the target: topmost over a topmost window, normal over a
    // normal one (a topmost overlay would float over windows that cover the
    // shared window).
    if (IsTopmost(overlay) != targetTop) {
        SetWindowPos(overlay, targetTop ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0,
                     base | SWP_NOMOVE | SWP_NOSIZE);
    }

    // Directly above the target = directly below whatever is above it now.
    const HWND prev = GetWindow(target, GW_HWNDPREV);
    bool zOk = false;
    HWND after = HWND_TOP;
    if (prev == overlay) {
        zOk = true;
    } else if (prev != NULL && IsTopmost(prev) == targetTop) {
        after = prev;
    }
    // else: the target is the top of its band -> HWND_TOP of that band.

    RECT cur;
    ZeroMemory(&cur, sizeof(cur));
    const bool sameRect = GetWindowRect(overlay, &cur) != FALSE
        && cur.left == x && cur.top == y && cur.right - cur.left == w && cur.bottom - cur.top == h;
    if (zOk && sameRect) return Bool(env, true);

    UINT flags = base;
    if (zOk) flags |= SWP_NOZORDER;
    if (sameRect) flags |= SWP_NOMOVE | SWP_NOSIZE;
    return Bool(env, SetWindowPos(overlay, zOk ? NULL : after, x, y, w, h, flags) != FALSE);
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

void RegisterWindowGeometry(napi_env env, napi_value exports) {
    Export(env, exports, "getScreenRectFromDeviceIndex", GetScreenRectFromDeviceIndex);
    Export(env, exports, "getWindowInfo", GetWindowInfo);
    Export(env, exports, "placeOverlayAbove", PlaceOverlayAbove);
}
