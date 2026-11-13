/* Pacer: output rate for a range of source rates against a 90 fps target (plus jittered delivery). Part of `make test`. */
#include <stdio.h>
#include <stdlib.h>
#include "pacer.h"
static double run(double in_hz, int target, double jitter_ms) {
    ClPacer p = {0}; uint64_t period = 1000000 / (uint64_t)target; int acc = 0; double secs = 20; double t0 = 1e6;
    srand(7); double step = 1e6 / in_hz;
    for (double x = t0; x < t0 + secs * 1e6; x += step) {
        double j = jitter_ms > 0 ? ((rand() % 2001) - 1000) / 1000.0 * jitter_ms * 1000.0 : 0;
        if (cl_pacer_accept(&p, (uint64_t)(x + j), period)) acc++;
    }
    return acc / secs;
}
int main(void) {
    struct { double in; int target; double lo, hi; } c[] = { {144, 90, 88.5, 91.5}, {120, 90, 88.5, 91.5}, {165, 90, 88.5, 91.5}, {240, 90, 88.5, 91.5}, {90, 90, 88.5, 91.5},
                                                           {60, 90, 59.5, 60.5}, {60, 60, 59.0, 61.0}, {144, 60, 58.5, 61.5}, {30, 90, 29.5, 30.5} };
    int bad = 0;
    for (unsigned i = 0; i < sizeof c / sizeof c[0]; i++) {
        double o = run(c[i].in, c[i].target, 0); int ok = o >= c[i].lo && o <= c[i].hi; if (!ok) bad++;
        printf("%s  in %.0f Hz -> target %d: %.2f fps (want %.1f..%.1f)\n", ok ? "ok  " : "FAIL", c[i].in, c[i].target, o, c[i].lo, c[i].hi);
        o = run(c[i].in, c[i].target, 1.5); ok = o >= c[i].lo - 1.5 && o <= c[i].hi + 1.5; if (!ok) bad++;
        printf("%s  in %.0f Hz (+-1.5 ms jitter) -> target %d: %.2f fps\n", ok ? "ok  " : "FAIL", c[i].in, c[i].target, o);
    }
    /* NEGATIVE CONTROL: the old rule (drop if sooner than 0.9 period after the last accepted frame) really does halve 144 -> 90. */
    {
        uint64_t period = 11111, last = 0; int acc = 0;
        for (double x = 1e6; x < 21e6; x += 1e6 / 144) { uint64_t t = (uint64_t)x; if (last && t < last + period * 9 / 10) continue; last = t; acc++; }
        double o = acc / 20.0; int ok = o > 70 && o < 74; if (!ok) bad++;
        printf("%s  old pacer at 144 Hz -> 90 target: %.1f fps (control: must be ~72)\n", ok ? "ok  " : "FAIL", o);
    }
    printf("pacer_test: %d failures\n", bad);
    return bad != 0;
}
