# Build image for the Linux native binaries (audio_capture.node + cl-wayland-overlay).
#
# Ubuntu 20.04 "focal" = glibc 2.31 - the oldest glibc we ship against (see GLIBC_FLOOR in
# scripts/rebuild-native-linux-compat.sh). A binary links the glibc it is BUILT against, so building here
# is what makes it load on Ubuntu 20.04+, Debian 11+, RHEL 9. Pinned by digest so the floor cannot drift
# when the tag is re-pushed.
#
# Only the compiler toolchain is installed. Node itself is mounted from the host (the official
# nodejs.org build needs glibc 2.28, so it runs here), which keeps the build on the exact Node/npm/node-gyp
# the rest of the pipeline uses. PipeWire / Wayland / X11 are dlopen()ed at run time and their headers are
# vendored, so no -dev packages are needed.
FROM ubuntu:20.04@sha256:8feb4d8ca5354def3d8fce243717141ce31e2c428701f6682bd2fafe15388214
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends gcc-10 g++-10 make python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Electron 43's V8 headers are built with -std=gnu++20, which focal's default gcc 9 rejects (it only knows gnu++2a);
# gcc 10 is focal's newer compiler and its libstdc++ still tops out at GLIBCXX_3.4.28.
ENV CC=gcc-10 CXX=g++-10
