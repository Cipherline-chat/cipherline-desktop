/*
 * Frame pacer for the capture path: an accumulated time budget (next due time), NOT "drop anything sooner than one period after the last
 * accepted frame". The latter turns a 144 Hz source into 72 fps for a 90 fps target (every other frame), measured on real hardware.
 * Here a frame is accepted when it is no more than half a period EARLY relative to the schedule; the schedule advances by exactly one
 * period per accepted frame, so the long-run output rate equals the target whenever the source is at least as fast (144 -> 90, 120 -> 90,
 * 165 -> 90, 240 -> 90) and equals the source rate when it is slower (60 -> 60). After a gap (idle screen, stall) the schedule resyncs
 * instead of bursting to catch up.
 */
#ifndef CL_PACER_H
#define CL_PACER_H
#include <stdint.h>
typedef struct { uint64_t next; int init; } ClPacer;
static inline int cl_pacer_accept(ClPacer *p, uint64_t t_us, uint64_t period_us) {
    if (!p->init) { p->init = 1; p->next = t_us + period_us; return 1; }
    if (t_us + period_us / 2 < p->next) return 0;
    p->next += period_us;
    if (t_us > p->next + period_us) p->next = t_us + period_us;   /* behind by more than a period: resync, never burst */
    return 1;
}
#endif
