/* Unit tests for dbus_mini (marshalling + parser). Built with ASan/UBSan: `make test`. Needs no bus. */
#include "dbus_mini.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>

static int fails, checks;
#define CHECK(c) do { checks++; if (!(c)) { fails++; fprintf(stderr, "FAIL %s:%d  %s\n", __FILE__, __LINE__, #c); } } while (0)

static void test_golden_dict(void) {
    /* spec layout of a{sv} {"k": u32 5}: len=16, 4 pad (dict entries align 8), key, variant sig "u", pad, value */
    DBuf b = {0}; size_t ck = db_b_array_begin(&b, 8); db_b_dict_u32(&b, "k", 5); db_b_array_end(&b, ck);
    static const uint8_t want[] = { 0x10,0,0,0, 0,0,0,0, 1,0,0,0,'k',0, 1,'u',0, 0,0,0, 5,0,0,0 };
    CHECK(b.len == sizeof want); CHECK(b.len == sizeof want && memcmp(b.p, want, sizeof want) == 0);
    db_buf_free(&b);
}
static void test_empty_array_8_aligned(void) {
    DBuf b = {0}; db_b_u8(&b, 1);                       /* force misalignment */
    size_t ck = db_b_array_begin(&b, 8); db_b_array_end(&b, ck);
    CHECK(b.len == 8 && b.p[4] == 0 && b.p[1] == 0);    /* u8, 3 pad, len 0 -> total 8 (data would start at 8) */
    uint32_t n; memcpy(&n, b.p + 4, 4); CHECK(n == 0);
    db_buf_free(&b);
}
static void test_roundtrip_call(void) {
    DBuf body = {0}; db_b_str(&body, "/org/freedesktop/portal/desktop/session/1_42/cl7");
    size_t ck = db_b_array_begin(&body, 8);
    db_b_dict_str(&body, "handle_token", "cl1_2_3"); db_b_dict_u32(&body, "types", 3); db_b_dict_bool(&body, "multiple", 0); db_b_dict_str(&body, "restore_token", "tok-é");
    db_b_array_end(&body, ck);
    DBuf msg = {0}; dbus_build_call(&msg, 9, "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", "org.freedesktop.portal.ScreenCast", "SelectSources", "oa{sv}", &body);
    CHECK(msg.len % 8 == (body.len % 8));               /* header is padded to 8, so total mod 8 == body mod 8 */
    DMsg m; int rc = dbus_parse_message(msg.p, msg.len, &m);
    CHECK(rc == 0);
    if (rc == 0) {
        CHECK(m.type == 1 && m.serial == 9);
        CHECK(m.path && !strcmp(m.path, "/org/freedesktop/portal/desktop"));
        CHECK(m.iface && !strcmp(m.iface, "org.freedesktop.portal.ScreenCast"));
        CHECK(m.member && !strcmp(m.member, "SelectSources"));
        CHECK(m.sig && !strcmp(m.sig, "oa{sv}"));
        CHECK(m.body.nkids == 2 && m.body.kids[0].t == 'o' && !strcmp(m.body.kids[0].s, "/org/freedesktop/portal/desktop/session/1_42/cl7"));
        const DVal *d = &m.body.kids[1];
        const DVal *t = dval_dict_get(d, "types"), *mu = dval_dict_get(d, "multiple"), *h = dval_dict_get(d, "handle_token"), *r = dval_dict_get(d, "restore_token");
        CHECK(t && t->t == 'u' && t->u == 3); CHECK(mu && mu->t == 'b' && mu->u == 0);
        CHECK(h && h->s && !strcmp(h->s, "cl1_2_3")); CHECK(r && r->s && !strcmp(r->s, "tok-é"));
        CHECK(dval_dict_get(d, "absent") == NULL);
        dmsg_free(&m);
    }
    db_buf_free(&msg); db_buf_free(&body);
}
static void test_handvector_return(void) {
    /* METHOD_RETURN, reply_serial 7, sig "s", body ":1.42" -- laid out by hand from the spec, independent of our builder */
    static const uint8_t v[] = {
        'l', 2, 0, 1,  10,0,0,0,  3,0,0,0,  15,0,0,0,
        5, 1,'u',0,  7,0,0,0,            /* REPLY_SERIAL */
        8, 1,'g',0,  1,'s',0,            /* SIGNATURE "s" */
        0,                               /* pad header to 32 */
        5,0,0,0, ':','1','.','4','2',0 };
    DMsg m; int rc = dbus_parse_message(v, sizeof v, &m);
    CHECK(rc == 0);
    if (rc == 0) { CHECK(m.type == 2 && m.reply_serial == 7 && m.serial == 3); CHECK(m.body.nkids == 1 && !strcmp(m.body.kids[0].s, ":1.42")); dmsg_free(&m); }
}
static void test_struct_array_variant_alignment(void) {
    /* a(yv) as used by the header fields: parse a struct holding a byte then a variant u32 (struct aligns to 8, u32 to 4) */
    static const uint8_t v[] = { 8,0,0,0, 0,0,0,0, 9, 1,'u',0, 3,0,0,0 };   /* array len 8, pad to 8, y=9, v sig "u", u32 3 */
    DVal out; size_t pos = 0;
    CHECK(dbus_parse_values(v, sizeof v, &pos, "a(yv)", &out) == 0);
    CHECK(pos == sizeof v && out.nkids == 1 && out.kids[0].nkids == 1 && out.kids[0].kids[0].nkids == 2);
    CHECK(out.kids[0].kids[0].kids[0].u == 9 && out.kids[0].kids[0].kids[1].kids[0].u == 3);
    dval_free(&out);
}
static void expect_bad(const uint8_t *p, size_t n, const char *what) {
    DMsg m; int rc = dbus_parse_message(p, n, &m); checks++;
    if (rc == 0) { fails++; fprintf(stderr, "FAIL accepted malformed message: %s\n", what); dmsg_free(&m); }
}
static void test_malformed(void) {
    DBuf body = {0}; db_b_str(&body, "hello");
    DBuf msg = {0}; dbus_build_call(&msg, 1, "d", "/p", "i.f", "M", "s", &body);
    expect_bad(msg.p, msg.len - 1, "truncated by one byte");
    expect_bad(msg.p, 10, "shorter than the fixed header");
    uint8_t *c = malloc(msg.len + 8); memcpy(c, msg.p, msg.len);
    c[0] = 'B'; expect_bad(c, msg.len, "big-endian marker (unsupported)");
    memcpy(c, msg.p, msg.len); c[3] = 2; expect_bad(c, msg.len, "protocol version 2");
    memcpy(c, msg.p, msg.len); c[msg.len - 1] = 7; expect_bad(c, msg.len, "string not NUL terminated");
    memcpy(c, msg.p, msg.len); uint32_t big = 0x7fffffff; memcpy(c + 12, &big, 4); expect_bad(c, msg.len, "header-field array length past the end");
    memcpy(c, msg.p, msg.len); uint32_t bl = 99; memcpy(c + 4, &bl, 4); expect_bad(c, msg.len, "body length disagrees with the message size");
    free(c); db_buf_free(&body); db_buf_free(&msg);
    /* a string claiming 4 GiB */
    static const uint8_t s[] = { 0xff,0xff,0xff,0xff, 'x', 0 }; DVal out; size_t pos = 0; checks++;
    if (dbus_parse_values(s, sizeof s, &pos, "s", &out) == 0) { fails++; fprintf(stderr, "FAIL accepted a 4 GiB string\n"); dval_free(&out); }
    /* deep variant nesting (v of v of v ...) must stop, not recurse forever */
    uint8_t deep[400]; size_t n = 0; for (int i = 0; i < 60; i++) { deep[n++] = 1; deep[n++] = 'v'; deep[n++] = 0; } deep[n++] = 'y'; pos = 0; checks++;
    deep[n - 1] = 1; deep[n] = 0; n += 0;
    { DVal o2; size_t p2 = 0; if (dbus_parse_values(deep, n, &p2, "v", &o2) == 0) { fails++; fprintf(stderr, "FAIL accepted 60-deep variant nesting\n"); dval_free(&o2); } }
    /* a bool that is neither 0 nor 1 */
    static const uint8_t bb[] = { 2,0,0,0 }; pos = 0; checks++;
    if (dbus_parse_values(bb, sizeof bb, &pos, "b", &out) == 0) { fails++; fprintf(stderr, "FAIL accepted bool == 2\n"); dval_free(&out); }
}
static void test_mutation_fuzz(void) {
    DBuf body = {0}; db_b_str(&body, "/a/b"); size_t ck = db_b_array_begin(&body, 8); db_b_dict_str(&body, "k", "v"); db_b_dict_u32(&body, "n", 4); db_b_array_end(&body, ck);
    DBuf msg = {0}; dbus_build_call(&msg, 5, "dest", "/path", "if.ace", "Member", "oa{sv}", &body);
    unsigned seed = 12345; int accepted = 0;
    for (int i = 0; i < 20000; i++) {
        uint8_t *c = malloc(msg.len); memcpy(c, msg.p, msg.len);
        for (int k = 0; k < 1 + (int)(seed % 4); k++) { seed = seed * 1103515245u + 12345u; c[(seed >> 8) % msg.len] = (uint8_t)(seed >> 16); }
        seed = seed * 1103515245u + 12345u;
        DMsg m; if (dbus_parse_message(c, msg.len, &m) == 0) { accepted++; dmsg_free(&m); }
        free(c);
    }
    checks++; printf("mutation fuzz: 20000 mutated messages, %d still parsed (rest rejected), no ASan/UBSan fault\n", accepted);
    db_buf_free(&body); db_buf_free(&msg);
}

/* OpenPipeWireRemote returns the PipeWire socket as a unix fd (SCM_RIGHTS; body type 'h' = index into the message's fds). Prove we
   receive it and that it is a working descriptor. */
static void test_scm_rights_reply(void) {
    int sv[2], pp[2]; CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, sv) == 0); CHECK(pipe(pp) == 0);
    DBuf h = {0}; db_b_u8(&h, 'l'); db_b_u8(&h, 2); db_b_u8(&h, 0); db_b_u8(&h, 1); db_b_u32(&h, 4); db_b_u32(&h, 77);
    size_t ck = db_b_array_begin(&h, 8);
    db_b_align(&h, 8); db_b_u8(&h, 5); db_b_sig(&h, "u"); db_b_u32(&h, 1);          /* REPLY_SERIAL = 1 (our first call) */
    db_b_align(&h, 8); db_b_u8(&h, 8); db_b_sig(&h, "g"); db_b_sig(&h, "h");        /* SIGNATURE = "h" */
    db_b_align(&h, 8); db_b_u8(&h, 9); db_b_sig(&h, "u"); db_b_u32(&h, 1);          /* UNIX_FDS = 1 */
    db_b_array_end(&h, ck); db_b_align(&h, 8); db_b_u32(&h, 0);                    /* body: fd index 0 */
    char cbuf[CMSG_SPACE(sizeof(int))]; memset(cbuf, 0, sizeof cbuf);
    struct iovec iov = { h.p, h.len }; struct msghdr mh; memset(&mh, 0, sizeof mh); mh.msg_iov = &iov; mh.msg_iovlen = 1; mh.msg_control = cbuf; mh.msg_controllen = sizeof cbuf;
    struct cmsghdr *c = CMSG_FIRSTHDR(&mh); c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(sizeof(int)); memcpy(CMSG_DATA(c), &pp[0], sizeof(int));
    CHECK(sendmsg(sv[1], &mh, 0) == (ssize_t)h.len);
    DBus d; memset(&d, 0, sizeof d); d.fd = sv[0]; d.serial = 1; DMsg r; char err[200];
    int rc = dbus_call(&d, "x.y", "/p", "i.f", "OpenPipeWireRemote", NULL, NULL, &r, 2000, err, sizeof err);
    CHECK(rc == 0);
    if (rc == 0) {
        CHECK(r.type == 2 && r.body.nkids == 1 && r.body.kids[0].t == 'h' && r.body.kids[0].u == 0 && r.nfds == 1 && r.fds[0] >= 0);
        if (r.nfds == 1 && r.fds[0] >= 0) { char ch = 0; CHECK(write(pp[1], "Z", 1) == 1); CHECK(read(r.fds[0], &ch, 1) == 1 && ch == 'Z'); }
        dmsg_free(&r);
    }
    dbus_close(&d); close(sv[1]); close(pp[0]); close(pp[1]); db_buf_free(&h);
}

int main(void) {
    test_golden_dict(); test_empty_array_8_aligned(); test_roundtrip_call(); test_handvector_return(); test_struct_array_variant_alignment(); test_malformed(); test_mutation_fuzz(); test_scm_rights_reply();
    printf("dbus_mini_test: %d checks, %d failures\n", checks, fails);
    return fails ? 1 : 0;
}
