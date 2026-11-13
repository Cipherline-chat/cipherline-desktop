#define _GNU_SOURCE
#include "portal.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define PORTAL_DEST "org.freedesktop.portal.Desktop"
#define PORTAL_PATH "/org/freedesktop/portal/desktop"
#define SC_IFACE "org.freedesktop.portal.ScreenCast"

static unsigned tok_counter;
static void make_token(char *out, size_t n) { snprintf(out, n, "cl%u_%u_%u", (unsigned)getpid(), ++tok_counter, (unsigned)time(NULL) & 0xffff); }

/* org.freedesktop.portal.Request path for our handle_token: /.../request/<unique name without ':' and with '.' -> '_'>/<token> */
static void request_path(const Portal *p, const char *token, char *out, size_t n) {
    char s[64]; snprintf(s, sizeof s, "%s", p->bus.unique[0] == ':' ? p->bus.unique + 1 : p->bus.unique);
    for (char *c = s; *c; c++) if (*c == '.') *c = '_';
    snprintf(out, n, "/org/freedesktop/portal/desktop/request/%s/%s", s, token);
}

/* One portal request: subscribe BEFORE calling (the Response can race the method reply), call, wait for Response. */
static PortalResult request(Portal *p, const char *iface, const char *member, const char *sig, DBuf *body, const char *token, int timeout_ms, DMsg *resp, char *err, size_t errlen) {
    char rp[320], rule[512]; request_path(p, token, rp, sizeof rp);
    snprintf(rule, sizeof rule, "type='signal',interface='org.freedesktop.portal.Request',member='Response',path='%s'", rp);
    if (dbus_add_match(&p->bus, rule, err, errlen)) return PORTAL_E_PROTOCOL;
    DMsg r;
    if (dbus_call(&p->bus, PORTAL_DEST, PORTAL_PATH, iface, member, sig, body, &r, 10000, err, errlen)) return PORTAL_E_PROTOCOL;
    dmsg_free(&r);
    int w = dbus_wait_signal(&p->bus, rp, "org.freedesktop.portal.Request", "Response", resp, timeout_ms, err, errlen);
    if (w == 1) { snprintf(err, errlen, "portal %s: no response within %d s", member, timeout_ms / 1000); return PORTAL_E_PROTOCOL; }
    if (w < 0) return PORTAL_E_PROTOCOL;
    if (resp->body.nkids != 2 || resp->body.kids[0].t != 'u' || resp->body.kids[1].t != 'a') { snprintf(err, errlen, "portal %s: malformed Response", member); dmsg_free(resp); return PORTAL_E_PROTOCOL; }
    unsigned code = (unsigned)resp->body.kids[0].u;
    if (code != 0) { snprintf(err, errlen, code == 1 ? "portal %s: cancelled by the user" : "portal %s: refused by the compositor (code %u)", member, code); dmsg_free(resp); return PORTAL_E_DENIED; }
    return PORTAL_OK;
}

static int get_prop_u32(Portal *p, const char *prop, uint32_t *out) {
    DBuf b = {0}; db_b_str(&b, SC_IFACE); db_b_str(&b, prop); DMsg r; char e[160];
    int rc = dbus_call(&p->bus, PORTAL_DEST, PORTAL_PATH, "org.freedesktop.DBus.Properties", "Get", "ss", &b, &r, 5000, e, sizeof e);
    db_buf_free(&b);
    if (rc) return -1;
    int ok = r.body.nkids == 1 && r.body.kids[0].t == 'v' && r.body.kids[0].nkids == 1 && r.body.kids[0].kids[0].t == 'u';
    if (ok) *out = (uint32_t)r.body.kids[0].kids[0].u;
    dmsg_free(&r); return ok ? 0 : -1;
}

PortalResult portal_start(Portal *p, const PortalOpts *o, char *err, size_t errlen) {
    memset(p, 0, sizeof *p); p->pw_fd = -1;
    if (dbus_connect(&p->bus, err, errlen)) return PORTAL_E_NO_BUS;
    uint32_t avail = 0, ver = 0;
    if (get_prop_u32(p, "version", &ver)) { snprintf(err, errlen, "xdg-desktop-portal ScreenCast is not available on this session"); return PORTAL_E_NO_PORTAL; }
    p->version = ver;
    if (get_prop_u32(p, "AvailableCursorModes", &avail)) avail = 0;
    p->cursor_mode = (avail & 2) ? 2 : 1;                      /* embedded when offered: the cursor is part of the frame */

    char tok[64], stok[64]; DMsg resp; PortalResult rc;
    /* 1. CreateSession */
    DBuf b = {0}; make_token(tok, sizeof tok); make_token(stok, sizeof stok);
    size_t ck = db_b_array_begin(&b, 8); db_b_dict_str(&b, "handle_token", tok); db_b_dict_str(&b, "session_handle_token", stok); db_b_array_end(&b, ck);
    rc = request(p, SC_IFACE, "CreateSession", "a{sv}", &b, tok, 10000, &resp, err, errlen); db_buf_free(&b);
    if (rc) return rc;
    const DVal *sh = dval_dict_get(&resp.body.kids[1], "session_handle");
    if (!sh || !sh->s || strlen(sh->s) >= sizeof p->session) { snprintf(err, errlen, "portal CreateSession: no session_handle"); dmsg_free(&resp); return PORTAL_E_PROTOCOL; }
    snprintf(p->session, sizeof p->session, "%s", sh->s); dmsg_free(&resp);
    char rule[400]; snprintf(rule, sizeof rule, "type='signal',interface='org.freedesktop.portal.Session',member='Closed',path='%s'", p->session);
    dbus_add_match(&p->bus, rule, err, errlen);

    /* 2. SelectSources */
    make_token(tok, sizeof tok);
    db_b_str(&b, p->session);
    ck = db_b_array_begin(&b, 8);
    db_b_dict_str(&b, "handle_token", tok);
    db_b_dict_u32(&b, "types", o->source_types ? o->source_types : 3);
    db_b_dict_bool(&b, "multiple", 0);
    db_b_dict_u32(&b, "cursor_mode", p->cursor_mode);
    if (ver >= 4 && o->persist) db_b_dict_u32(&b, "persist_mode", 2);
    if (ver >= 4 && o->restore_token && *o->restore_token) db_b_dict_str(&b, "restore_token", o->restore_token);
    db_b_array_end(&b, ck);
    rc = request(p, SC_IFACE, "SelectSources", "oa{sv}", &b, tok, 15000, &resp, err, errlen); db_buf_free(&b);
    if (rc) { portal_close(p); return rc; }
    dmsg_free(&resp);

    /* 3. Start: the chooser (or the restored grant) */
    make_token(tok, sizeof tok);
    db_b_str(&b, p->session); db_b_str(&b, "");
    ck = db_b_array_begin(&b, 8); db_b_dict_str(&b, "handle_token", tok); db_b_array_end(&b, ck);
    struct timespec t0s, t1s; clock_gettime(CLOCK_MONOTONIC, &t0s);
    rc = request(p, SC_IFACE, "Start", "osa{sv}", &b, tok, o->start_timeout_ms > 0 ? o->start_timeout_ms : 120000, &resp, err, errlen); db_buf_free(&b);
    clock_gettime(CLOCK_MONOTONIC, &t1s);
    { long long ms = (long long)(t1s.tv_sec - t0s.tv_sec) * 1000 + (t1s.tv_nsec - t0s.tv_nsec) / 1000000; p->start_ms = ms < 0 ? 0 : ms > 600000 ? 600000 : (int)ms; }
    if (rc) { portal_close(p); return rc; }
    const DVal *streams = dval_dict_get(&resp.body.kids[1], "streams");
    if (!streams || streams->t != 'a' || streams->nkids < 1 || streams->kids[0].nkids != 2) { snprintf(err, errlen, "portal Start: no streams granted"); dmsg_free(&resp); portal_close(p); return PORTAL_E_DENIED; }
    const DVal *st = &streams->kids[0];
    p->node_id = (uint32_t)st->kids[0].u;
    const DVal *sz = dval_dict_get(&st->kids[1], "size");
    if (sz && sz->t == '(' && sz->nkids == 2) { p->width = (int)sz->kids[0].i; p->height = (int)sz->kids[1].i; }
    /* `position` is optional (GNOME and KDE fill it for monitor streams, others do not). Only a well-formed (ii) with sane values counts. */
    const DVal *ps = dval_dict_get(&st->kids[1], "position");
    if (ps && ps->t == '(' && ps->nkids == 2 && ps->kids[0].t == 'i' && ps->kids[1].t == 'i') {
        int64_t px = ps->kids[0].i, py = ps->kids[1].i;
        if (px >= -100000 && px <= 100000 && py >= -100000 && py <= 100000) { p->has_pos = 1; p->pos_x = (int)px; p->pos_y = (int)py; }
    }
    const DVal *stype = dval_dict_get(&st->kids[1], "source_type");
    if (stype && stype->t == 'u') p->source_type = (unsigned)stype->u;
    const DVal *rt = dval_dict_get(&resp.body.kids[1], "restore_token");
    if (rt && rt->s && strlen(rt->s) < sizeof p->restore_token) snprintf(p->restore_token, sizeof p->restore_token, "%s", rt->s);
    dmsg_free(&resp);

    /* 4. OpenPipeWireRemote: the reply carries an fd (SCM_RIGHTS), the body holds its index */
    make_token(tok, sizeof tok);
    db_b_str(&b, p->session); ck = db_b_array_begin(&b, 8); db_b_array_end(&b, ck);
    DMsg r;
    int cr = dbus_call(&p->bus, PORTAL_DEST, PORTAL_PATH, SC_IFACE, "OpenPipeWireRemote", "oa{sv}", &b, &r, 10000, err, errlen); db_buf_free(&b);
    if (cr) { portal_close(p); return PORTAL_E_PROTOCOL; }
    if (r.body.nkids != 1 || r.body.kids[0].t != 'h' || r.body.kids[0].u >= (uint64_t)r.nfds || r.fds[r.body.kids[0].u] < 0) {
        snprintf(err, errlen, "portal OpenPipeWireRemote: no fd in the reply"); dmsg_free(&r); portal_close(p); return PORTAL_E_PROTOCOL;
    }
    p->pw_fd = r.fds[r.body.kids[0].u]; r.fds[r.body.kids[0].u] = -1; dmsg_free(&r);
    return PORTAL_OK;
}

int portal_poll_closed(Portal *p) {
    DMsg m; int r;
    while ((r = dbus_poll_signal(&p->bus, &m)) == 1) {
        int closed = m.path && m.member && !strcmp(m.member, "Closed") && !strcmp(m.path, p->session);
        dmsg_free(&m); if (closed) return 1;
    }
    return r < 0 ? -1 : 0;
}

void portal_close(Portal *p) {
    if (p->bus.fd >= 0 && p->session[0]) {
        DMsg r; char e[96]; DBuf b = {0};
        if (dbus_call(&p->bus, PORTAL_DEST, p->session, "org.freedesktop.portal.Session", "Close", NULL, &b, &r, 2000, e, sizeof e) == 0) dmsg_free(&r);
        p->session[0] = 0;
    }
    if (p->pw_fd >= 0) { close(p->pw_fd); p->pw_fd = -1; }
    dbus_close(&p->bus);
}
