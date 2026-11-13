/*
 * dbus_mini: a minimal, hand-rolled D-Bus client (own code, Apache-2.0 like the repo). Exists because the usual choices are
 * licence-incompatible with this project (libdbus AFL/GPL dual, sd-bus and GIO LGPL). It implements exactly what the
 * xdg-desktop-portal ScreenCast flow needs: SASL EXTERNAL with unix-fd negotiation, Hello, method calls, signal match rules,
 * marshalling of basic types / a{sv} / variants, a generic bounds-checked parser, and SCM_RIGHTS fd receipt.
 * Little-endian peers only (every bus daemon on a little-endian host sends native endianness).
 */
#ifndef CL_DBUS_MINI_H
#define CL_DBUS_MINI_H
#include <stddef.h>
#include <stdint.h>

/* marshalling buffer */
typedef struct { uint8_t *p; size_t len, cap; } DBuf;
void db_buf_free(DBuf *b);
void db_b_align(DBuf *b, size_t n);
void db_b_u8(DBuf *b, uint8_t v);
void db_b_u32(DBuf *b, uint32_t v);
void db_b_str(DBuf *b, const char *s);               /* 's' and 'o': u32 len, bytes, NUL */
void db_b_sig(DBuf *b, const char *s);               /* 'g': u8 len, bytes, NUL */
size_t db_b_array_begin(DBuf *b, size_t elem_align); /* returns a cookie for _end */
void db_b_array_end(DBuf *b, size_t cookie);
/* a{sv} entries: call inside an array begun with db_b_array_begin(b, 8) */
void db_b_dict_str(DBuf *b, const char *key, const char *val);
void db_b_dict_u32(DBuf *b, const char *key, uint32_t val);
void db_b_dict_bool(DBuf *b, const char *key, int val);

/* parsed values */
typedef struct DVal {
    char t;                    /* y b n q i u x t d s o g h v a ( { */
    uint64_t u; int64_t i; double d;
    char *s;                   /* s o g */
    struct DVal *kids; int nkids;  /* a: elements; ( and {: members; v: one kid holding the contained value */
} DVal;
void dval_free(DVal *v);
/* dict is an 'a' of '{' with string keys; returns the INNER value of the variant, or NULL */
const DVal *dval_dict_get(const DVal *dict, const char *key);

typedef struct DMsg {
    int type;                  /* 1 call 2 return 3 error 4 signal */
    uint32_t serial, reply_serial;
    char *path, *iface, *member, *error_name, *sender, *sig;
    DVal body;                 /* t == '(' : one kid per complete type of sig */
    int fds[8]; int nfds;      /* received; dmsg_free closes any that are still >= 0 (set to -1 after taking one) */
} DMsg;
void dmsg_free(DMsg *m);

/* Parse `sig` (a sequence of complete types) from buf[*pos..len); alignment is relative to buf (the whole message). 0 ok, -1 malformed. */
int dbus_parse_values(const uint8_t *buf, size_t len, size_t *pos, const char *sig, DVal *out_struct);
/* Parse one complete message (header+body) already assembled in buf. 0 ok, -1 malformed. */
int dbus_parse_message(const uint8_t *buf, size_t len, DMsg *out);
/* Build a method call message into out (fresh buffer). 0 ok. */
int dbus_build_call(DBuf *out, uint32_t serial, const char *dest, const char *path, const char *iface, const char *member, const char *sig, const DBuf *body);

/* connection */
typedef struct DBus {
    int fd; uint32_t serial; char unique[64];
    uint8_t *rb; size_t rlen, rcap;
    int fdq[16]; int nfdq;
    DMsg *pend; int npend, cappend;    /* signals read while waiting for something else */
} DBus;
int dbus_connect(DBus *d, char *err, size_t errlen);   /* session bus, SASL EXTERNAL, Hello */
void dbus_close(DBus *d);
/* Blocking call. 0 and the reply (type 2); -1 with err (a D-Bus error reply is reported as "name: message"). */
int dbus_call(DBus *d, const char *dest, const char *path, const char *iface, const char *member, const char *sig, const DBuf *body, DMsg *reply, int timeout_ms, char *err, size_t errlen);
int dbus_add_match(DBus *d, const char *rule, char *err, size_t errlen);
/* Wait for a signal with this path (NULL = any) + interface + member. 0 got it, 1 timeout, -1 error. */
int dbus_wait_signal(DBus *d, const char *path, const char *iface, const char *member, DMsg *out, int timeout_ms, char *err, size_t errlen);
/* Non-blocking: read what is available, pop one queued signal. 1 got one, 0 none, -1 connection closed. */
int dbus_poll_signal(DBus *d, DMsg *out);
#endif
