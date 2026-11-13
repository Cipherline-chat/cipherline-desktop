/* dbus_mini: see dbus_mini.h. Hand-rolled D-Bus client for the portal ScreenCast flow. */
#define _GNU_SOURCE
#include "dbus_mini.h"
#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#define MAX_MSG (64u * 1024 * 1024)
#define MAX_DEPTH 32
#define MAX_ELEMS 100000

/* ── marshalling ── */
static void need(DBuf *b, size_t n) {
    if (b->len + n <= b->cap) return;
    size_t c = b->cap ? b->cap * 2 : 256;
    while (c < b->len + n) c *= 2;
    b->p = realloc(b->p, c); b->cap = c;
}
void db_buf_free(DBuf *b) { free(b->p); b->p = NULL; b->len = b->cap = 0; }
void db_b_align(DBuf *b, size_t n) { size_t pad = (n - (b->len % n)) % n; if (!pad) return; need(b, pad); memset(b->p + b->len, 0, pad); b->len += pad; }
void db_b_u8(DBuf *b, uint8_t v) { need(b, 1); b->p[b->len++] = v; }
void db_b_u32(DBuf *b, uint32_t v) { db_b_align(b, 4); need(b, 4); memcpy(b->p + b->len, &v, 4); b->len += 4; }
void db_b_str(DBuf *b, const char *s) { size_t n = strlen(s); db_b_u32(b, (uint32_t)n); need(b, n + 1); memcpy(b->p + b->len, s, n + 1); b->len += n + 1; }
void db_b_sig(DBuf *b, const char *s) { size_t n = strlen(s); db_b_u8(b, (uint8_t)n); need(b, n + 1); memcpy(b->p + b->len, s, n + 1); b->len += n + 1; }
/* cookie = (position of the u32 length) * 16 + element alignment. Data starts at align_up(pos + 4, elem_align). */
size_t db_b_array_begin(DBuf *b, size_t elem_align) {
    db_b_align(b, 4); size_t at = b->len; db_b_u32(b, 0); db_b_align(b, elem_align);
    return at * 16 + elem_align;
}
void db_b_array_end(DBuf *b, size_t cookie) {
    size_t at = cookie / 16, al = cookie % 16, start = at + 4;
    start = (start + al - 1) / al * al;
    uint32_t n = (uint32_t)(b->len - start);
    memcpy(b->p + at, &n, 4);
}
static void dict_key(DBuf *b, const char *key, const char *vsig) { db_b_align(b, 8); db_b_str(b, key); db_b_sig(b, vsig); }
void db_b_dict_str(DBuf *b, const char *key, const char *val) { dict_key(b, key, "s"); db_b_str(b, val); }
void db_b_dict_u32(DBuf *b, const char *key, uint32_t val) { dict_key(b, key, "u"); db_b_u32(b, val); }
void db_b_dict_bool(DBuf *b, const char *key, int val) { dict_key(b, key, "b"); db_b_u32(b, val ? 1 : 0); }

/* ── parser ── */
void dval_free(DVal *v) {
    if (!v) return;
    for (int i = 0; i < v->nkids; i++) dval_free(&v->kids[i]);
    free(v->kids); free(v->s); v->kids = NULL; v->s = NULL; v->nkids = 0;
}
static size_t type_align(char t) {
    switch (t) { case 'y': case 'g': case 'v': return 1; case 'n': case 'q': return 2; case 'i': case 'u': case 'b': case 'h': case 's': case 'o': case 'a': return 4; default: return 8; }
}
/* pointer just past one complete type, or NULL if malformed */
static const char *sig_skip(const char *s, int depth) {
    if (depth > MAX_DEPTH || !*s) return NULL;
    if (*s == 'a') return sig_skip(s + 1, depth + 1);
    if (*s == '(' || *s == '{') {
        char close = *s == '(' ? ')' : '}'; s++;
        while (*s && *s != close) { s = sig_skip(s, depth + 1); if (!s) return NULL; }
        return *s == close ? s + 1 : NULL;
    }
    return strchr("ybnqiuxtdsogvh", *s) ? s + 1 : NULL;
}
static int rd_align(size_t *pos, size_t len, size_t a) { size_t p = (*pos + a - 1) / a * a; if (p > len) return -1; *pos = p; return 0; }
static int rd_u32(const uint8_t *b, size_t len, size_t *pos, uint32_t *out) {
    if (rd_align(pos, len, 4) || *pos + 4 > len) return -1; memcpy(out, b + *pos, 4); *pos += 4; return 0;
}
static int parse_one(const uint8_t *b, size_t len, size_t *pos, const char *sig, DVal *out, int depth) {
    if (depth > MAX_DEPTH) return -1;
    memset(out, 0, sizeof *out); out->t = *sig;
    switch (*sig) {
    case 'y': if (*pos + 1 > len) return -1; out->u = b[(*pos)++]; return 0;
    case 'n': case 'q': { if (rd_align(pos, len, 2) || *pos + 2 > len) return -1; uint16_t v; memcpy(&v, b + *pos, 2); *pos += 2; out->u = v; out->i = (int16_t)v; return 0; }
    case 'b': case 'i': case 'u': case 'h': { uint32_t v; if (rd_u32(b, len, pos, &v)) return -1; out->u = v; out->i = (int32_t)v; if (*sig == 'b' && v > 1) return -1; return 0; }
    case 'x': case 't': { if (rd_align(pos, len, 8) || *pos + 8 > len) return -1; uint64_t v; memcpy(&v, b + *pos, 8); *pos += 8; out->u = v; out->i = (int64_t)v; return 0; }
    case 'd': { if (rd_align(pos, len, 8) || *pos + 8 > len) return -1; memcpy(&out->d, b + *pos, 8); *pos += 8; return 0; }
    case 's': case 'o': {
        uint32_t n; if (rd_u32(b, len, pos, &n) || n > MAX_MSG || *pos + n + 1 > len || b[*pos + n] != 0) return -1;
        out->s = malloc(n + 1); memcpy(out->s, b + *pos, n); out->s[n] = 0; *pos += n + 1; return 0;
    }
    case 'g': {
        if (*pos + 1 > len) return -1; uint8_t n = b[(*pos)++]; if (*pos + n + 1 > len || b[*pos + n] != 0) return -1;
        out->s = malloc((size_t)n + 1); memcpy(out->s, b + *pos, n); out->s[n] = 0; *pos += (size_t)n + 1; return 0;
    }
    case 'v': {
        char vs[256]; if (*pos + 1 > len) return -1; uint8_t n = b[(*pos)++]; if (*pos + n + 1 > len || b[*pos + n] != 0) return -1;
        memcpy(vs, b + *pos, n); vs[n] = 0; *pos += (size_t)n + 1;
        const char *e = sig_skip(vs, 0); if (!e || *e) return -1;       /* exactly one complete type */
        out->kids = calloc(1, sizeof(DVal)); out->nkids = 1;
        return parse_one(b, len, pos, vs, &out->kids[0], depth + 1);
    }
    case 'a': {
        uint32_t n; if (rd_u32(b, len, pos, &n) || n > MAX_MSG) return -1;
        const char *el = sig + 1; const char *ee = sig_skip(el, 0); if (!ee) return -1;
        size_t elen = (size_t)(ee - el); char esig[256]; if (elen >= sizeof esig) return -1; memcpy(esig, el, elen); esig[elen] = 0;
        if (rd_align(pos, len, type_align(*el))) return -1;
        if (*pos + n > len) return -1;
        size_t end = *pos + n; int cap = 0;
        while (*pos < end) {
            if (out->nkids >= MAX_ELEMS) return -1;
            if (out->nkids == cap) { cap = cap ? cap * 2 : 4; out->kids = realloc(out->kids, (size_t)cap * sizeof(DVal)); }
            out->nkids++;
            if (parse_one(b, end, pos, esig, &out->kids[out->nkids - 1], depth + 1)) return -1;
        }
        return *pos == end ? 0 : -1;
    }
    case '(': case '{': {
        if (rd_align(pos, len, 8)) return -1;
        const char *s = sig + 1; char close = *sig == '(' ? ')' : '}'; int cap = 0;
        while (*s != close) {
            const char *e = sig_skip(s, 0); if (!e) return -1;
            size_t l = (size_t)(e - s); char ms[256]; if (l >= sizeof ms) return -1; memcpy(ms, s, l); ms[l] = 0;
            if (out->nkids == cap) { cap = cap ? cap * 2 : 4; out->kids = realloc(out->kids, (size_t)cap * sizeof(DVal)); }
            out->nkids++;
            if (parse_one(b, len, pos, ms, &out->kids[out->nkids - 1], depth + 1)) return -1;
            s = e;
        }
        return 0;
    }
    default: return -1;
    }
}
int dbus_parse_values(const uint8_t *buf, size_t len, size_t *pos, const char *sig, DVal *out) {
    memset(out, 0, sizeof *out); out->t = '(';
    int cap = 0;
    while (*sig) {
        const char *e = sig_skip(sig, 0); if (!e) { dval_free(out); return -1; }
        size_t l = (size_t)(e - sig); char one[256]; if (l >= sizeof one) { dval_free(out); return -1; } memcpy(one, sig, l); one[l] = 0;
        if (out->nkids == cap) { cap = cap ? cap * 2 : 4; out->kids = realloc(out->kids, (size_t)cap * sizeof(DVal)); }
        out->nkids++;
        if (parse_one(buf, len, pos, one, &out->kids[out->nkids - 1], 0)) { dval_free(out); return -1; }
        sig = e;
    }
    return 0;
}
const DVal *dval_dict_get(const DVal *dict, const char *key) {
    if (!dict || dict->t != 'a') return NULL;
    for (int i = 0; i < dict->nkids; i++) {
        const DVal *e = &dict->kids[i];
        if (e->t == '{' && e->nkids == 2 && e->kids[0].s && !strcmp(e->kids[0].s, key) && e->kids[1].t == 'v' && e->kids[1].nkids == 1) return &e->kids[1].kids[0];
    }
    return NULL;
}
void dmsg_free(DMsg *m) {
    free(m->path); free(m->iface); free(m->member); free(m->error_name); free(m->sender); free(m->sig); dval_free(&m->body);
    for (int i = 0; i < m->nfds; i++) if (m->fds[i] >= 0) close(m->fds[i]);
    memset(m, 0, sizeof *m);
}
int dbus_parse_message(const uint8_t *b, size_t len, DMsg *m) {
    memset(m, 0, sizeof *m);
    for (int i = 0; i < 8; i++) m->fds[i] = -1;
    if (len < 16 || b[0] != 'l' || b[3] != 1) return -1;
    m->type = b[1];
    uint32_t blen, ser; memcpy(&blen, b + 4, 4); memcpy(&ser, b + 8, 4); m->serial = ser;
    size_t pos = 12; DVal f;
    if (dbus_parse_values(b, len, &pos, "a(yv)", &f)) return -1;
    uint32_t nfd = 0; int bad = 0;
    for (int i = 0; i < f.kids[0].nkids; i++) {
        DVal *e = &f.kids[0].kids[i]; if (e->nkids != 2 || e->kids[1].nkids != 1) { bad = 1; break; }
        DVal *v = &e->kids[1].kids[0]; int code = (int)e->kids[0].u;
        char **dst = NULL;
        switch (code) { case 1: dst = &m->path; break; case 2: dst = &m->iface; break; case 3: dst = &m->member; break; case 4: dst = &m->error_name; break; case 7: dst = &m->sender; break; case 8: dst = &m->sig; break; default: break; }
        if (dst && v->s && !*dst) { *dst = v->s; v->s = NULL; }
        else if (code == 5 && v->t == 'u') m->reply_serial = (uint32_t)v->u;
        else if (code == 9 && v->t == 'u') nfd = (uint32_t)v->u;
    }
    dval_free(&f);
    if (bad) { dmsg_free(m); return -1; }
    pos = (pos + 7) / 8 * 8;
    if (pos + blen != len) { dmsg_free(m); return -1; }
    if (blen && !m->sig) { dmsg_free(m); return -1; }
    if (dbus_parse_values(b, len, &pos, m->sig ? m->sig : "", &m->body) || pos != len) { dmsg_free(m); return -1; }
    (void)nfd; m->nfds = 0;
    return 0;
}

int dbus_build_call(DBuf *out, uint32_t serial, const char *dest, const char *path, const char *iface, const char *member, const char *sig, const DBuf *body) {
    DBuf h = {0};
    db_b_u8(&h, 'l'); db_b_u8(&h, 1); db_b_u8(&h, 0); db_b_u8(&h, 1);
    db_b_u32(&h, (uint32_t)(body ? body->len : 0)); db_b_u32(&h, serial);
    size_t ck = db_b_array_begin(&h, 8);
    #define FIELD_S(code, vs, str, fn) do { db_b_align(&h, 8); db_b_u8(&h, code); db_b_sig(&h, vs); fn(&h, str); } while (0)
    FIELD_S(1, "o", path, db_b_str);
    if (iface) FIELD_S(2, "s", iface, db_b_str);
    FIELD_S(3, "s", member, db_b_str);
    if (dest) FIELD_S(6, "s", dest, db_b_str);
    if (sig && *sig) FIELD_S(8, "g", sig, db_b_sig);
    db_b_array_end(&h, ck);
    db_b_align(&h, 8);
    *out = h;
    if (body && body->len) { need(out, body->len); memcpy(out->p + out->len, body->p, body->len); out->len += body->len; }
    return 0;
}

/* ── connection ── */
static int rd_some(DBus *d, int timeout_ms) {
    struct pollfd pf = { d->fd, POLLIN, 0 };
    int r = poll(&pf, 1, timeout_ms); if (r < 0) return errno == EINTR ? 0 : -1; if (r == 0) return 0;
    if (d->rlen + 65536 > d->rcap) { d->rcap = d->rcap ? d->rcap * 2 : 65536; if (d->rcap < d->rlen + 65536) d->rcap = d->rlen + 65536; d->rb = realloc(d->rb, d->rcap); }
    char cbuf[CMSG_SPACE(sizeof(int) * 16)];
    struct iovec iov = { d->rb + d->rlen, 65536 };
    struct msghdr mh; memset(&mh, 0, sizeof mh); mh.msg_iov = &iov; mh.msg_iovlen = 1; mh.msg_control = cbuf; mh.msg_controllen = sizeof cbuf;
    ssize_t n = recvmsg(d->fd, &mh, MSG_CMSG_CLOEXEC);
    if (n < 0) return errno == EAGAIN || errno == EINTR ? 0 : -1;
    for (struct cmsghdr *c = CMSG_FIRSTHDR(&mh); c; c = CMSG_NXTHDR(&mh, c))
        if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS) {
            int cnt = (int)((c->cmsg_len - CMSG_LEN(0)) / sizeof(int)); int *fds = (int *)CMSG_DATA(c);
            for (int i = 0; i < cnt; i++) { if (d->nfdq < 16) d->fdq[d->nfdq++] = fds[i]; else close(fds[i]); }
        }
    if (n == 0) return -1;
    d->rlen += (size_t)n; return 1;
}
/* 1 = extracted one complete message, 0 = need more, -1 = protocol error */
static int try_extract(DBus *d, DMsg *m) {
    if (d->rlen < 16) return 0;
    uint32_t blen, flen; memcpy(&blen, d->rb + 4, 4); memcpy(&flen, d->rb + 12, 4);
    if (d->rb[0] != 'l' || blen > MAX_MSG || flen > MAX_MSG) return -1;
    size_t hdr = (16 + (size_t)flen + 7) / 8 * 8, total = hdr + blen;
    if (total > MAX_MSG) return -1;
    if (d->rlen < total) return 0;
    int rc = dbus_parse_message(d->rb, total, m);
    /* unix fds: take them from the front of the queue, count from the UNIX_FDS header (re-read cheaply) */
    if (rc == 0) {
        DVal f; size_t pos = 12;
        if (dbus_parse_values(d->rb, total, &pos, "a(yv)", &f) == 0) {
            for (int i = 0; i < f.kids[0].nkids; i++) { const DVal *e = &f.kids[0].kids[i]; if (e->kids[0].u == 9 && e->kids[1].nkids == 1) {
                uint32_t n = (uint32_t)e->kids[1].kids[0].u; for (uint32_t k = 0; k < n && k < 8 && d->nfdq > 0; k++) { m->fds[m->nfds++] = d->fdq[0]; memmove(d->fdq, d->fdq + 1, sizeof(int) * (size_t)(--d->nfdq)); } } }
            dval_free(&f);
        }
    }
    memmove(d->rb, d->rb + total, d->rlen - total); d->rlen -= total;
    return rc == 0 ? 1 : -1;
}
static uint64_t mono_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (uint64_t)t.tv_sec * 1000 + (uint64_t)t.tv_nsec / 1000000; }
/* 1 got a message, 0 timeout, -1 error/closed */
static int read_msg(DBus *d, DMsg *m, int timeout_ms) {
    uint64_t end = mono_ms() + (uint64_t)(timeout_ms < 0 ? 0 : timeout_ms);
    for (;;) {
        int r = try_extract(d, m); if (r) return r;
        int left = timeout_ms < 0 ? -1 : (int)(end > mono_ms() ? end - mono_ms() : 0);
        int g = rd_some(d, left); if (g < 0) return -1;
        if (g == 0 && timeout_ms >= 0 && mono_ms() >= end) return 0;
    }
}
static void push_pending(DBus *d, DMsg *m) {
    if (d->npend >= 64) { dmsg_free(m); return; }
    if (d->npend == d->cappend) { d->cappend = d->cappend ? d->cappend * 2 : 8; d->pend = realloc(d->pend, (size_t)d->cappend * sizeof(DMsg)); }
    d->pend[d->npend++] = *m; memset(m, 0, sizeof *m);
}
static int send_all(int fd, const uint8_t *p, size_t n) {
    while (n) { ssize_t w = send(fd, p, n, MSG_NOSIGNAL); if (w < 0) { if (errno == EINTR) continue; return -1; } p += w; n -= (size_t)w; }
    return 0;
}
static int auth_line(int fd, char *line, size_t cap) {
    size_t n = 0; while (n + 1 < cap) { char c; ssize_t r = read(fd, &c, 1); if (r <= 0) return -1; line[n++] = c; if (n >= 2 && line[n - 2] == '\r' && c == '\n') break; }
    line[n] = 0; return 0;
}
int dbus_connect(DBus *d, char *err, size_t errlen) {
    memset(d, 0, sizeof *d); d->fd = -1; d->serial = 1;
    const char *addr = getenv("DBUS_SESSION_BUS_ADDRESS"); char def[128];
    if (!addr || !*addr) { snprintf(def, sizeof def, "unix:path=/run/user/%u/bus", (unsigned)getuid()); addr = def; }
    struct sockaddr_un sa; memset(&sa, 0, sizeof sa); sa.sun_family = AF_UNIX; socklen_t sl = 0;
    const char *p = strstr(addr, "unix:");
    if (!p) { snprintf(err, errlen, "no unix D-Bus session address (DBUS_SESSION_BUS_ADDRESS=%.80s)", addr); return -1; }
    p += 5;
    const char *path = strstr(p, "path="), *abst = strstr(p, "abstract=");
    char val[sizeof sa.sun_path]; const char *v = path ? path + 5 : abst ? abst + 9 : NULL;
    if (!v) { snprintf(err, errlen, "unsupported D-Bus address %.80s", addr); return -1; }
    size_t vl = strcspn(v, ",;"); if (vl == 0 || vl >= sizeof val - 1) { snprintf(err, errlen, "bad D-Bus address"); return -1; }
    memcpy(val, v, vl); val[vl] = 0;
    if (path && (!abst || path < abst)) { memcpy(sa.sun_path, val, vl + 1); sl = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + vl + 1); }
    else { sa.sun_path[0] = 0; memcpy(sa.sun_path + 1, val, vl); sl = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + vl); }
    d->fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (d->fd < 0 || connect(d->fd, (struct sockaddr *)&sa, sl) != 0) { snprintf(err, errlen, "cannot connect to the D-Bus session bus: %s", strerror(errno)); dbus_close(d); return -1; }
    char uid[32], hex[80], line[256]; int n = snprintf(uid, sizeof uid, "%u", (unsigned)getuid());
    for (int i = 0; i < n; i++) snprintf(hex + i * 2, 3, "%02x", (unsigned char)uid[i]);
    char first[160]; int fl = snprintf(first, sizeof first, "%cAUTH EXTERNAL %s\r\n", 0, hex);
    if (send_all(d->fd, (uint8_t *)first, (size_t)fl) || auth_line(d->fd, line, sizeof line) || strncmp(line, "OK", 2)) { snprintf(err, errlen, "D-Bus authentication rejected"); dbus_close(d); return -1; }
    const char *neg = "NEGOTIATE_UNIX_FD\r\n";
    if (send_all(d->fd, (const uint8_t *)neg, strlen(neg)) || auth_line(d->fd, line, sizeof line) || strncmp(line, "AGREE_UNIX_FD", 13)) { snprintf(err, errlen, "D-Bus daemon does not support unix fd passing"); dbus_close(d); return -1; }
    const char *begin = "BEGIN\r\n"; if (send_all(d->fd, (const uint8_t *)begin, strlen(begin))) { dbus_close(d); return -1; }
    DMsg r;
    if (dbus_call(d, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "Hello", NULL, NULL, &r, 5000, err, errlen)) { dbus_close(d); return -1; }
    if (r.body.nkids < 1 || !r.body.kids[0].s) { snprintf(err, errlen, "bad Hello reply"); dmsg_free(&r); dbus_close(d); return -1; }
    snprintf(d->unique, sizeof d->unique, "%s", r.body.kids[0].s); dmsg_free(&r);
    return 0;
}
void dbus_close(DBus *d) {
    if (d->fd >= 0) close(d->fd);
    for (int i = 0; i < d->npend; i++) dmsg_free(&d->pend[i]);
    for (int i = 0; i < d->nfdq; i++) close(d->fdq[i]);
    free(d->pend); free(d->rb); memset(d, 0, sizeof *d); d->fd = -1;
}
int dbus_call(DBus *d, const char *dest, const char *path, const char *iface, const char *member, const char *sig, const DBuf *body, DMsg *reply, int timeout_ms, char *err, size_t errlen) {
    uint32_t serial = d->serial++; DBuf m = {0};
    dbus_build_call(&m, serial, dest, path, iface, member, sig, body);
    int sr = send_all(d->fd, m.p, m.len); db_buf_free(&m);
    if (sr) { snprintf(err, errlen, "D-Bus send failed: %s", strerror(errno)); return -1; }
    uint64_t end = mono_ms() + (uint64_t)timeout_ms;
    for (;;) {
        DMsg in; int left = (int)(end > mono_ms() ? end - mono_ms() : 0);
        int r = read_msg(d, &in, left);
        if (r < 0) { snprintf(err, errlen, "D-Bus connection lost"); return -1; }
        if (r == 0) { snprintf(err, errlen, "D-Bus call %s timed out", member); return -1; }
        if ((in.type == 2 || in.type == 3) && in.reply_serial == serial) {
            if (in.type == 3) { snprintf(err, errlen, "%s: %s", in.error_name ? in.error_name : "error", in.body.nkids > 0 && in.body.kids[0].s ? in.body.kids[0].s : ""); dmsg_free(&in); return -1; }
            *reply = in; return 0;
        }
        if (in.type == 4) push_pending(d, &in); else dmsg_free(&in);
    }
}
int dbus_add_match(DBus *d, const char *rule, char *err, size_t errlen) {
    DBuf b = {0}; db_b_str(&b, rule); DMsg r;
    int rc = dbus_call(d, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "AddMatch", "s", &b, &r, 5000, err, errlen);
    db_buf_free(&b); if (rc == 0) dmsg_free(&r); return rc;
}
static int sig_matches(const DMsg *m, const char *path, const char *iface, const char *member) {
    return m->type == 4 && (!path || (m->path && !strcmp(m->path, path))) && (!iface || (m->iface && !strcmp(m->iface, iface))) && (!member || (m->member && !strcmp(m->member, member)));
}
int dbus_wait_signal(DBus *d, const char *path, const char *iface, const char *member, DMsg *out, int timeout_ms, char *err, size_t errlen) {
    for (int i = 0; i < d->npend; i++) if (sig_matches(&d->pend[i], path, iface, member)) {
        *out = d->pend[i]; memmove(d->pend + i, d->pend + i + 1, sizeof(DMsg) * (size_t)(d->npend - i - 1)); d->npend--; return 0;
    }
    uint64_t end = mono_ms() + (uint64_t)timeout_ms;
    for (;;) {
        DMsg in; int left = (int)(end > mono_ms() ? end - mono_ms() : 0);
        int r = read_msg(d, &in, left);
        if (r < 0) { snprintf(err, errlen, "D-Bus connection lost"); return -1; }
        if (r == 0) return 1;
        if (sig_matches(&in, path, iface, member)) { *out = in; return 0; }
        if (in.type == 4) push_pending(d, &in); else dmsg_free(&in);
    }
}
int dbus_poll_signal(DBus *d, DMsg *out) {
    if (d->npend > 0) { *out = d->pend[0]; memmove(d->pend, d->pend + 1, sizeof(DMsg) * (size_t)(d->npend - 1)); d->npend--; return 1; }
    for (;;) {
        DMsg in; int r = read_msg(d, &in, 0);
        if (r < 0) return -1;
        if (r == 0) return 0;
        if (in.type == 4) { *out = in; return 1; }
        dmsg_free(&in);
    }
}
