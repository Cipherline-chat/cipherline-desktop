/*
 * xdg-desktop-portal ScreenCast session over dbus_mini (CreateSession, SelectSources, Start, OpenPipeWireRemote).
 * Failures are explicit: portal_start returns a PortalResult code the caller maps to a fallback reason.
 */
#ifndef CL_PORTAL_H
#define CL_PORTAL_H
#include "dbus_mini.h"

typedef enum {
    PORTAL_OK = 0,
    PORTAL_E_NO_BUS = 1,        /* no session bus / auth failed */
    PORTAL_E_NO_PORTAL = 2,     /* ScreenCast interface not offered */
    PORTAL_E_DENIED = 3,        /* user cancelled / compositor refused (Response 1 or 2) */
    PORTAL_E_PROTOCOL = 4,      /* malformed or unexpected reply, timeout */
} PortalResult;

typedef struct PortalOpts {
    unsigned source_types;      /* bit 1 monitor, bit 2 window; 0 = monitor|window */
    const char *restore_token;  /* NULL/"" = show the chooser */
    int persist;                /* ask for persist_mode 2 (until revoked) when the portal supports it */
    int start_timeout_ms;       /* the chooser waits on a human; default 120000 */
} PortalOpts;

typedef struct Portal {
    DBus bus;
    char session[256];
    uint32_t node_id; int width, height;    /* from the stream properties (0 if the portal did not say) */
    int pw_fd;                              /* PipeWire remote, owned until the capture takes it */
    char restore_token[512];                /* new token from Start, "" if none */
    unsigned cursor_mode;                   /* 2 embedded, 1 hidden */
    unsigned source_type;                   /* 1 monitor, 2 window, 0 unknown */
    int has_pos, pos_x, pos_y;              /* the stream's compositor position (ScreenCast `position` (ii)); has_pos 0 = the portal did not say */
    int start_ms;                           /* how long Start took: a restored grant answers at once, a chooser waits on a person */
    uint32_t version;
} Portal;

PortalResult portal_start(Portal *p, const PortalOpts *o, char *err, size_t errlen);
/* Non-blocking: 1 once the portal/compositor closed the session (Session.Closed), 0 not yet, -1 bus gone. */
int portal_poll_closed(Portal *p);
void portal_close(Portal *p);
#endif
