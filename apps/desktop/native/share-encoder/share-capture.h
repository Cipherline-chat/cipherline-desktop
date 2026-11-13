#ifndef CL_SHARE_CAPTURE_H
#define CL_SHARE_CAPTURE_H
#include "encoder.h"
typedef struct CapOpts {
    int fps, max_w, max_h;      /* max_w/max_h: encode at the source size, scaled DOWN (nearest neighbour) if the source is larger */
    unsigned source_types;      /* 1 monitor, 2 window, 0 both */
    int persist;                /* ask the portal for a persistent grant (restore token) */
    int restore_stdin;          /* read "TOKEN <t>" from stdin before starting */
    int pw_node;                /* DEV/TEST ONLY: skip the portal and capture this PipeWire node from the default socket */
    int idle_ms;                /* re-encode the last frame after this long without a new one (default 250) */
} CapOpts;
int run_capture(const ClEncoderOps *ops, ClEncCfg cfg, const CapOpts *o);
#endif
