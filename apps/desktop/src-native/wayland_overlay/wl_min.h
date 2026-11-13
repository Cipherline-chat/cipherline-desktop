/*
 * Minimal declarations of the libwayland-client ABI that cl-wayland-overlay uses.
 *
 * The helper never links libwayland-client: it dlopen()s "libwayland-client.so.0" at run
 * time, exactly as src-native/audio_capture_linux.cc does for libpipewire, so the build needs
 * no system dev packages and the helper degrades to "unsupported" (instead of failing to
 * start) on a machine without it. That means no <wayland-client.h> and no wayland-scanner
 * output — these are the few plain structs and function-pointer types the wire ABI is made
 * of (libwayland's wayland-util.h / wayland-client-core.h, MIT licensed; the layout has been
 * frozen since 1.0). The protocol tables themselves are in cl_wayland_overlay.c and are
 * cross-checked against wayland-scanner's output by
 * harness/wayland-annotation/check-protocol-tables.sh.
 */
#ifndef CL_WL_MIN_H
#define CL_WL_MIN_H

#include <stdint.h>

struct wl_interface;
struct wl_proxy;
struct wl_display;

struct wl_message {
    const char *name;
    const char *signature;
    const struct wl_interface **types;
};

struct wl_interface {
    const char *name;
    int version;
    int method_count;
    const struct wl_message *methods;
    int event_count;
    const struct wl_message *events;
};

union wl_argument {
    int32_t i;
    uint32_t u;
    int32_t f;
    const char *s;
    void *o;
    uint32_t n;
    void *a;
    int32_t h;
};

typedef struct wl_display *(*pfn_display_connect)(const char *name);
typedef void (*pfn_display_disconnect)(struct wl_display *);
typedef int (*pfn_display_get_fd)(struct wl_display *);
typedef int (*pfn_display_dispatch_pending)(struct wl_display *);
typedef int (*pfn_display_flush)(struct wl_display *);
typedef int (*pfn_display_roundtrip)(struct wl_display *);
typedef int (*pfn_display_prepare_read)(struct wl_display *);
typedef int (*pfn_display_read_events)(struct wl_display *);
typedef void (*pfn_display_cancel_read)(struct wl_display *);
typedef int (*pfn_display_get_error)(struct wl_display *);
typedef struct wl_proxy *(*pfn_marshal_array_constructor_versioned)(
    struct wl_proxy *proxy, uint32_t opcode, union wl_argument *args,
    const struct wl_interface *interface, uint32_t version);
typedef void (*pfn_marshal_array)(struct wl_proxy *proxy, uint32_t opcode, union wl_argument *args);
typedef int (*pfn_proxy_add_listener)(struct wl_proxy *proxy, void (**implementation)(void), void *data);
typedef void (*pfn_proxy_destroy)(struct wl_proxy *proxy);

#endif
