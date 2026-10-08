/**
 * window_geometry_mac.mm — macOS window geometry for the desktop annotation
 * overlay (electron/annotation-overlay.ts), linked into the audio_capture
 * addon (audio_capture_mac.mm calls RegisterWindowGeometry from its Init) so
 * there is still exactly one native module. The macOS counterpart of
 * window_geometry.cc.
 *
 * Raw N-API, like the rest of the addon.
 *
 * Exports:
 *
 *   getWindowInfo(windowId: string)
 *       -> { exists, visible, minimized, cloaked, frame: {x,y,width,height}|null } | null
 *     For a `window:<CGWindowID>:0` capture source (Chromium's macOS window
 *     source id IS the CGWindowID — the same number audio_capture_mac.mm's
 *     getPidFromSourceId already resolves). One CGWindowListCopyWindowInfo
 *     query for exactly that window:
 *       - exists   : the window server still knows the window.
 *       - visible  : kCGWindowIsOnscreen — false while it is minimized, on
 *                    another Space, or hidden with its app (Cmd-H). The
 *                    window server does not say WHICH, and the overlay does
 *                    the same thing for all three (hide, keep tracking), so
 *                    `minimized` / `cloaked` are always false here.
 *                    A fully transparent window (kCGWindowAlpha 0) counts as
 *                    not visible.
 *       - frame    : kCGWindowBounds — GLOBAL display coordinates in POINTS,
 *                    origin at the top-left of the primary display, y down.
 *                    That is exactly Electron's DIP screen space on macOS
 *                    (Display.bounds, BrowserWindow.setBounds), so it needs
 *                    NO conversion — no Retina factor, no bottom-left flip.
 *                    Excludes the window shadow, matching what
 *                    ScreenCaptureKit captures for a single window.
 *     Reading bounds needs no Screen Recording permission (only window
 *     NAMES do, and this never reads one).
 *
 *   orderOverlayAbove(overlayHandle: string, targetWindowId: string) -> boolean
 *     Stacks OUR overlay window directly above the shared window, so a window
 *     that covers the shared one also covers the strokes. `overlayHandle` is
 *     BrowserWindow.getNativeWindowHandle() (an NSView*) as a decimal string;
 *     it is only ever compared against the views of this process's own
 *     NSWindows — never dereferenced — so a wrong or hostile value can at
 *     most fail to match. Sets the overlay's window level to the target's
 *     layer (a normal window at the normal level, a floating panel at its
 *     level) and calls orderWindow:NSWindowAbove relativeTo: only when the
 *     window directly above the target is not already the overlay. Never
 *     activates anything and never touches any window but our own.
 *
 * Positioning is NOT done here: the main process sets the overlay's bounds
 * with BrowserWindow.setBounds(frame) — frame is already in Electron's
 * coordinate space (above), and Electron owns the Cocoa bottom-left flip.
 *
 * Everything runs on the main thread (Electron's Node main thread is the
 * Cocoa main thread); a call from any other thread returns null / false.
 */

#include <node_api.h>

#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

#include <cstdint>
#include <cstring>

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

void SetBool(napi_env env, napi_value obj, const char* name, bool value) {
    napi_set_named_property(env, obj, name, Bool(env, value));
}

void SetNumber(napi_env env, napi_value obj, const char* name, double value) {
    napi_value v;
    napi_create_double(env, value, &v);
    napi_set_named_property(env, obj, name, v);
}

/** A decimal unsigned string ("12345") of at most 20 digits, > 0. */
bool ParseDecimal(napi_env env, napi_value value, uint64_t max, uint64_t* out) {
    napi_valuetype type;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
    char buf[32] = {};
    size_t len = 0;
    if (napi_get_value_string_utf8(env, value, buf, sizeof(buf), &len) != napi_ok) return false;
    if (len == 0 || len > 20) return false;
    uint64_t v = 0;
    for (size_t i = 0; i < len; ++i) {
        const char c = buf[i];
        if (c < '0' || c > '9') return false;
        const uint64_t d = static_cast<uint64_t>(c - '0');
        if (v > (UINT64_MAX - d) / 10ULL) return false;   // overflow
        v = v * 10ULL + d;
    }
    if (v == 0 || v > max) return false;
    *out = v;
    return true;
}

bool DictInt(CFDictionaryRef d, CFStringRef key, long long* out) {
    CFNumberRef n = (CFNumberRef)CFDictionaryGetValue(d, key);
    if (!n || CFGetTypeID(n) != CFNumberGetTypeID()) return false;
    return CFNumberGetValue(n, kCFNumberLongLongType, out);
}

bool DictDouble(CFDictionaryRef d, CFStringRef key, double* out) {
    CFNumberRef n = (CFNumberRef)CFDictionaryGetValue(d, key);
    if (!n || CFGetTypeID(n) != CFNumberGetTypeID()) return false;
    return CFNumberGetValue(n, kCFNumberDoubleType, out);
}

bool DictBool(CFDictionaryRef d, CFStringRef key) {
    CFTypeRef v = CFDictionaryGetValue(d, key);
    if (!v) return false;
    if (CFGetTypeID(v) == CFBooleanGetTypeID()) return CFBooleanGetValue((CFBooleanRef)v);
    if (CFGetTypeID(v) == CFNumberGetTypeID()) {
        int i = 0;
        return CFNumberGetValue((CFNumberRef)v, kCFNumberIntType, &i) && i != 0;
    }
    return false;
}

CFDictionaryRef FindWindowDict(CFArrayRef list, CGWindowID wid) {
    if (!list) return NULL;
    CFDictionaryRef found = NULL;
    for (CFIndex i = 0; i < CFArrayGetCount(list); ++i) {
        CFDictionaryRef d = (CFDictionaryRef)CFArrayGetValueAtIndex(list, i);
        long long n = 0;
        if (DictInt(d, kCGWindowNumber, &n) && n == (long long)wid) {
            found = (CFDictionaryRef)CFRetain(d);
            break;
        }
    }
    CFRelease(list);
    return found;
}

/**
 * The window server's description of exactly one window (retained copy), or
 * NULL once the window is gone. The single-window query is the fast path, but
 * it returns NOTHING for a minimized window (measured on macOS 27), so a miss
 * falls back to the full list — which still has minimized / other-Space /
 * hidden-app windows, just not on screen. Only a window missing from BOTH is
 * gone. (The fallback only runs while the shared window is not on screen.)
 */
CFDictionaryRef CopyWindowDict(CGWindowID wid) {
    CFDictionaryRef d = FindWindowDict(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, wid), wid);
    if (d) return d;
    return FindWindowDict(CGWindowListCopyWindowInfo(kCGWindowListOptionAll, kCGNullWindowID), wid);
}

napi_value GetWindowInfo(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc < 1) return Null(env);
    if (![NSThread isMainThread]) return Null(env);
    uint64_t wid = 0;
    if (!ParseDecimal(env, args[0], 0xFFFFFFFFull, &wid)) return Null(env);

    napi_value obj;
    napi_create_object(env, &obj);
    CFDictionaryRef d = CopyWindowDict((CGWindowID)wid);
    if (!d) {
        SetBool(env, obj, "exists", false);
        return obj;
    }
    SetBool(env, obj, "exists", true);

    double alpha = 1.0;
    DictDouble(d, kCGWindowAlpha, &alpha);
    SetBool(env, obj, "visible", DictBool(d, kCGWindowIsOnscreen) && alpha > 0.0);
    SetBool(env, obj, "minimized", false);
    SetBool(env, obj, "cloaked", false);

    CGRect r = CGRectZero;
    CFDictionaryRef b = (CFDictionaryRef)CFDictionaryGetValue(d, kCGWindowBounds);
    const bool haveRect = b && CFGetTypeID(b) == CFDictionaryGetTypeID()
        && CGRectMakeWithDictionaryRepresentation(b, &r)
        && r.size.width > 0 && r.size.height > 0;
    if (haveRect) {
        napi_value rect;
        napi_create_object(env, &rect);
        SetNumber(env, rect, "x", r.origin.x);
        SetNumber(env, rect, "y", r.origin.y);
        SetNumber(env, rect, "width", r.size.width);
        SetNumber(env, rect, "height", r.size.height);
        napi_set_named_property(env, obj, "frame", rect);
    } else {
        napi_set_named_property(env, obj, "frame", Null(env));
    }
    CFRelease(d);
    return obj;
}

/** OUR window whose view is `handle` (getNativeWindowHandle), or nil. Never dereferences `handle`. */
NSWindow* OwnWindowForHandle(uint64_t handle) {
    for (NSWindow* w in [NSApp windows]) {
        NSView* content = [w contentView];
        if (!content) continue;
        if ((uint64_t)(uintptr_t)(__bridge void*)content == handle) return w;
        NSView* frameView = [content superview];
        if (frameView && (uint64_t)(uintptr_t)(__bridge void*)frameView == handle) return w;
    }
    return nil;
}

/** The on-screen window directly above `wid` in the global order, or 0 (none / unknown). */
CGWindowID WindowDirectlyAbove(CGWindowID wid) {
    // Front-to-back list of the on-screen windows ABOVE `wid`: the last entry
    // is the one immediately above it.
    CFArrayRef above = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenAboveWindow, wid);
    if (!above) return 0;
    CGWindowID result = 0;
    const CFIndex count = CFArrayGetCount(above);
    if (count > 0) {
        long long n = 0;
        if (DictInt((CFDictionaryRef)CFArrayGetValueAtIndex(above, count - 1), kCGWindowNumber, &n) && n > 0) {
            result = (CGWindowID)n;
        }
    }
    CFRelease(above);
    return result;
}

napi_value OrderOverlayAbove(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    if (napi_get_cb_info(env, info, &argc, args, nullptr, nullptr) != napi_ok || argc < 2) return Bool(env, false);
    if (![NSThread isMainThread]) return Bool(env, false);
    uint64_t handle = 0, wid = 0;
    if (!ParseDecimal(env, args[0], UINT64_MAX, &handle) || !ParseDecimal(env, args[1], 0xFFFFFFFFull, &wid)) {
        return Bool(env, false);
    }

    // Only ever our own window.
    NSWindow* overlay = OwnWindowForHandle(handle);
    if (!overlay) return Bool(env, false);
    if ((uint64_t)[overlay windowNumber] == wid) return Bool(env, false);

    CFDictionaryRef d = CopyWindowDict((CGWindowID)wid);
    if (!d) return Bool(env, false);
    long long layer = 0;
    const bool haveLayer = DictInt(d, kCGWindowLayer, &layer);
    const bool onscreen = DictBool(d, kCGWindowIsOnscreen);
    CFRelease(d);
    if (!haveLayer || !onscreen) return Bool(env, false);
    // Same band as the target: a normal window -> normal level, a floating
    // panel -> its level. Anything at or above the screen-saver level (menu
    // bar, Dock, system overlays) is not a share target we stack against.
    if (layer < (long long)kCGNormalWindowLevel || layer >= (long long)kCGScreenSaverWindowLevel) return Bool(env, false);
    if ((long long)[overlay level] != layer) [overlay setLevel:(NSWindowLevel)layer];

    if (WindowDirectlyAbove((CGWindowID)wid) == (CGWindowID)[overlay windowNumber]) return Bool(env, true);
    // The window server applies this when the main run loop next turns, so
    // the CG list read back right here would still show the old order: true
    // means "ordered (or already in place)", not "verified".
    [overlay orderWindow:NSWindowAbove relativeTo:(NSInteger)wid];
    return Bool(env, true);
}

void Export(napi_env env, napi_value exports, const char* name, napi_callback cb) {
    napi_value fn;
    if (napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, nullptr, &fn) == napi_ok) {
        napi_set_named_property(env, exports, name, fn);
    }
}

}  // namespace

void RegisterWindowGeometry(napi_env env, napi_value exports) {
    Export(env, exports, "getWindowInfo", GetWindowInfo);
    Export(env, exports, "orderOverlayAbove", OrderOverlayAbove);
}
